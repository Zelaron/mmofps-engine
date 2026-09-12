import { TICK_RATE, NET } from '@shared/constants';
import { isEntityId } from '@shared/entity-id';
import { ServerPlayer, type Game, type PlayerSink, type ServerVehicle, type Projectile } from './game.js';

/** Full simulation state. SavedPlayer is deliberately smaller and is only for
 * login/crash recovery; using it for a live handoff would reset movement and
 * discard reloads, queued inputs, vehicle crews and explosives. */
export type HandoffPlayer = Omit<ServerPlayer, 'sink' | 'discoveries' | 'fullPickupContacts'> & {
  discoveries: string[]; fullPickupContacts: number[];
};
export interface HandoffHistory {
  tick: number;
  players: { id: number; x: number; y: number; z: number; alive: boolean }[];
}
export interface RuntimeHandoff {
  version: 1; seed: number; tick: number;
  players: HandoffPlayer[]; vehicles: ServerVehicle[]; projectiles: HandoffProjectile[];
  history: HandoffHistory[];
}
/** JSON has no Infinity; null means a range/impact-limited projectile with no fuse. */
export type HandoffProjectile = Omit<Projectile, 'fuseLeft'> & { fuseLeft: number | null };
export interface DetachedHandoff {
  record: RuntimeHandoff;
  /** Local rollback retains connection objects; these never enter the wire record. */
  players: ReadonlyMap<number, ServerPlayer>;
}
const MAX_HANDOFF_BYTES = 1_000_000;
const MAX_HANDOFF_AGE = 5 * TICK_RATE;
let playerFields: Set<string> | undefined;
let template: ServerPlayer | undefined;

function cloneRecord<T>(value: T): T {
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('Non-finite handoff state');
    if (item && typeof item === 'object' && !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) throw new Error('Handoff state must contain plain records');
    return item;
  });
  if (Buffer.byteLength(json, 'utf8') > MAX_HANDOFF_BYTES) throw new Error('Handoff is too large');
  return JSON.parse(json) as T;
}

/** Independent validation for durable staging before a destination mutates
 * its simulation. The returned record owns all of its nested data. */
export function checkedHandoff(incoming: RuntimeHandoff): RuntimeHandoff {
  const record = cloneRecord(incoming); validateRecord(record); return record;
}

/** Capture the complete connected crew, even when a passenger initiates it.
 * Capture and detachment must happen synchronously between simulation ticks. */
export function captureActors(game: Game, ids: readonly number[]): DetachedHandoff {
  const players = new Map<number, ServerPlayer>(), vehicles = new Map<number, ServerVehicle>();
  const queue = [...ids];
  while (queue.length) {
    const id = queue.pop()!; if (players.has(id)) continue;
    const p = game.players.get(id); if (!p) throw new Error('Handoff player is absent');
    players.set(id, p);
    if (players.size > 64) throw new Error('Handoff crew is too large');
    if (p.vehicleId < 0) continue;
    const v = game.vehicles.get(p.vehicleId); if (!v) throw new Error('Handoff vehicle is absent');
    vehicles.set(v.id, v);
    if (v.occupant >= 0) queue.push(v.occupant);
    if ((v.gunner ?? -1) >= 0) queue.push(v.gunner!);
  }
  const record = cloneRecord<RuntimeHandoff>({
    version: 1, seed: game.seed, tick: game.tick,
    players: [...players.values()].map(p => {
      const { sink: _sink, discoveries, fullPickupContacts, ...state } = p;
      return { ...state, discoveries: [...discoveries], fullPickupContacts: [...fullPickupContacts] };
    }),
    vehicles: [...vehicles.values()],
    projectiles: [...game.projectiles.values()].filter(p => players.has(p.owner))
      .map(p => ({ ...p, fuseLeft: p.fuseLeft === Infinity ? null : p.fuseLeft })),
    history: [],
  });
  validateRecord(record);
  return { record, players };
}

function uniqueIds(items: { id: number }[], label: string): Set<number> {
  const ids = new Set<number>();
  for (const item of items) {
    if (!isEntityId(item.id) || ids.has(item.id)) throw new Error(`Invalid or duplicate ${label} ID`);
    ids.add(item.id);
  }
  return ids;
}

function validateRecord(record: RuntimeHandoff): void {
  template ??= new ServerPlayer(1, '', null, false, { x: 0, y: 0, z: 0 });
  playerFields ??= new Set(Object.keys(template).filter(k => k !== 'sink'));
  if (record.version !== 1 || !Number.isSafeInteger(record.tick) || record.tick < 0 ||
      !record.players.length || record.players.length > 64 || record.vehicles.length > 64 ||
      record.projectiles.length > 2048 || record.history.length > NET.LAG_HISTORY_TICKS) throw new Error('Invalid handoff envelope');
  const players = uniqueIds(record.players, 'player'), vehicles = uniqueIds(record.vehicles, 'vehicle');
  uniqueIds(record.projectiles, 'projectile');
  const byPlayer = new Map(record.players.map(p => [p.id, p])), byVehicle = new Map(record.vehicles.map(v => [v.id, v]));
  for (const p of record.players) {
    if (Object.keys(p).some(k => !playerFields!.has(k)) || typeof p.name !== 'string' || typeof p.isBot !== 'boolean' ||
        !p.state || !Array.isArray(p.ammo) || !Array.isArray(p.inputQueue) || p.inputQueue.length > 120 ||
        !Array.isArray(p.discoveries) || !Array.isArray(p.fullPickupContacts)) throw new Error('Invalid handoff player');
    for (const [key, value] of Object.entries(template)) {
      if (['number', 'boolean', 'string'].includes(typeof value) && typeof (p as unknown as Record<string, unknown>)[key] !== typeof value) throw new Error('Incomplete handoff player');
    }
    for (const [key, value] of Object.entries(template.state)) {
      if (typeof (p.state as unknown as Record<string, unknown>)[key] !== typeof value) throw new Error('Incomplete handoff movement');
    }
    if (p.ammo.length !== template.ammo.length || p.ammo.some(a => typeof a.magazine !== 'number' || typeof a.reserve !== 'number') ||
        p.discoveries.some(d => typeof d !== 'string') || p.fullPickupContacts.some(id => !isEntityId(id))) throw new Error('Invalid handoff inventory');
    if (p.vehicleId < 0) {
      if (p.state.vehicle) throw new Error('Handoff occupant has no hull');
      continue;
    }
    const v = byVehicle.get(p.vehicleId);
    if (!v || p.state.vehicle !== v.type || p.state.vehicleId !== v.id ||
        (p.state.seat === 1 ? v.gunner !== p.id : v.occupant !== p.id)) throw new Error('Inconsistent handoff crew');
  }
  for (const v of record.vehicles) {
    if (!players.has(v.occupant) || byPlayer.get(v.occupant)!.vehicleId !== v.id ||
        ((v.gunner ?? -1) >= 0 && (!players.has(v.gunner!) || byPlayer.get(v.gunner!)!.vehicleId !== v.id || v.gunner === v.occupant))) throw new Error('Incomplete handoff crew');
  }
  for (const p of record.projectiles) {
    if (!players.has(p.owner)) throw new Error('Handoff projectile has no owner');
    for (const key of ['weapon', 'x', 'y', 'z', 'vx', 'vy', 'vz', 'distLeft', 'ageSeconds'] as const) {
      if (typeof p[key] !== 'number') throw new Error('Incomplete handoff projectile');
    }
    if (typeof p.sleeping !== 'boolean' || (p.fuseLeft !== null && typeof p.fuseLeft !== 'number')) throw new Error('Invalid handoff projectile fuse');
  }
  const historyTicks = new Set<number>();
  for (const frame of record.history) {
    if (!Number.isSafeInteger(frame.tick) || historyTicks.has(frame.tick) || frame.tick > record.tick || frame.tick <= record.tick - NET.LAG_HISTORY_TICKS || frame.players.length > players.size) throw new Error('Invalid handoff history');
    historyTicks.add(frame.tick);
    for (const id of uniqueIds(frame.players, 'history')) if (!players.has(id)) throw new Error('History contains an unrelated actor');
  }
  if (vehicles.size !== record.vehicles.length) throw new Error('Duplicate hull');
}

export function validateHandoff(record: RuntimeHandoff): void { validateRecord(cloneRecord(record)); }

/** Use a common planetary tick domain. Timers pause while the actor is in
 * transit; platform motion keeps its original tick so moving trains/lifts
 * carry arrivals to their current world position on the next physics step. */
function rebasePlayer(p: HandoffPlayer, delta: number): void {
  p.lastInputAtTick += delta;
  for (const key of ['regenBlockUntil', 'respawnAtTick', 'factionChangeAt', 'fallCreditUntilTick',
    'ranOverUntilTick', 'teleportCdUntil', 'recallSince', 'trapCooldownUntil', 'transitDamageUntil'] as const) {
    if (p[key] >= 0) p[key] += delta;
  }
  if (p.airlift) p.airlift.start += delta;
  if (p.state.airlift) p.state.airlift.startTick += delta;
}

/** All validation precedes mutations. The caller must prove destination
 * ownership before accepting; this codec does not grant authority itself. */
export function prepareArrival(game: Game, incoming: RuntimeHandoff, sinks: ReadonlyMap<number, PlayerSink | null>, originals?: ReadonlyMap<number, ServerPlayer>) {
  const record = cloneRecord(incoming); validateRecord(record);
  const delta = game.tick - record.tick;
  if (record.seed !== game.seed || delta < 0 || delta > MAX_HANDOFF_AGE) throw new Error('Handoff requires the same planet and a current shared clock');
  for (const p of record.players) {
    if (game.players.has(p.id) || (!p.isBot && !sinks.has(p.id))) throw new Error('Handoff player is occupied or has no connection');
    if (originals && (!originals.has(p.id) || originals.get(p.id)!.name !== p.name)) throw new Error('Invalid local rollback');
  }
  for (const v of record.vehicles) if (game.vehicles.has(v.id)) throw new Error('Handoff vehicle is occupied');
  for (const p of record.projectiles) if (game.projectiles.has(p.id)) throw new Error('Handoff projectile is occupied');
  const players = record.players.map(p => {
    rebasePlayer(p, delta);
    const player = originals?.get(p.id) ?? new ServerPlayer(p.id, p.name, sinks.get(p.id) ?? null, p.isBot, { x: p.state.px, y: p.state.py, z: p.state.pz });
    const { id: _id, name: _name, isBot: _bot, discoveries, fullPickupContacts, ...runtime } = p;
    Object.assign(player, runtime, { discoveries: new Set(discoveries), fullPickupContacts: new Set(fullPickupContacts) });
    return player;
  });
  for (const v of record.vehicles) if (v.respawnAtTick >= 0) v.respawnAtTick += delta;
  const projectiles: Projectile[] = record.projectiles.map(p => ({ ...p, fuseLeft: p.fuseLeft === null ? Infinity : p.fuseLeft }));
  return { record, players, projectiles };
}
