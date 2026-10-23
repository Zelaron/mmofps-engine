// Ground-vehicle crew cooperation. Canonical ray acquisition is supplied by
// Bot; this module owns only crew lifecycle, deadlines and copied observations.
import { VEHICLE, World } from '@shared/index';
import type { Game, ServerPlayer, ServerVehicle } from './game.js';

export interface EnemySensingState {
  enemyId: number; losCheckAt: number; losOk: boolean; losCursor: number;
  losStarted: boolean; remotePerception: boolean;
  losObstructions: Map<number, { fraction: number; x: number; y: number; z: number; tick: number }>;
}
export interface CrewScanPolicy { interval: number; maxChecks: number }
export interface CrewAim {
  readonly id: number;
  readonly state: Readonly<{ px: number; py: number; pz: number }>;
}
export interface CrewObservation extends CrewAim { readonly observedTick: number }
interface TargetStamp {
  player: ServerPlayer; hull: ServerVehicle | undefined; faction: number;
  hullId: number; vehicle: number; grounded: boolean; airlift: unknown; stateAirlift: unknown;
  state: ServerPlayer['state']; seat: number; variant: number; observedSpeed2: number;
}
export interface CrewBoard {
  readonly hull: ServerVehicle; readonly driver: ServerPlayer; readonly gunner: ServerPlayer;
  readonly driverState: ServerPlayer['state']; readonly gunnerState: ServerPlayer['state'];
  readonly world: World; readonly faction: number; readonly type: number; readonly variant: number;
  sensing: EnemySensingState; observation: CrewObservation | null; target: TargetStamp | null;
  nextScanAt: number; lastScanTick: number; lastTick: number; revision: number; remote: boolean;
  driverHealth: number; gunnerHealth: number; hullHealth: number;
  driverRegen: number; gunnerRegen: number; hurtUntil: number;
  x: number; y: number; z: number;
}
export type CrewScanner = (game: Game, spotter: ServerPlayer, sensing: EnemySensingState,
  policy: CrewScanPolicy) => ServerPlayer | null;

const nativeTrace = World.prototype.trace;
// The tick budget survives board replacement and temporary ineligibility.
// Both levels remain weak; removed worlds/hulls cannot accumulate a roster map.
interface HullSlot { board: CrewBoard | undefined; lastScanTick: number }
const boards = new WeakMap<Game, WeakMap<ServerVehicle, HullSlot>>();

function member(game: Game, hull: ServerVehicle, p: ServerPlayer | undefined, seat: number): p is ServerPlayer {
  if (!p || game.players.get(p.id) !== p || !p.isBot || p.sink || !p.state.alive ||
      p.vehicleId !== hull.id || p.state.vehicleId !== hull.id || (p.state.seat ?? 0) !== seat ||
      p.state.vehicle !== hull.type || (p.state.vehicleVariant ?? 0) !== (hull.variant ?? 0) ||
      !p.state.grounded || p.state.swimming || p.state.submerged || p.airlift || p.state.airlift) return false;
  const s = p.state;
  return Number.isFinite(s.px + s.py + s.pz + s.vx + s.vy + s.vz + p.health + p.regenBlockUntil);
}
function sensing(): EnemySensingState {
  return { enemyId: -1, losCheckAt: 0, losOk: false, losCursor: 0, losStarted: false,
    remotePerception: false, losObstructions: new Map() };
}
function clearTarget(board: CrewBoard): void {
  board.observation = null; board.target = null;
  board.sensing.enemyId = -1; board.sensing.losOk = false;
}
function targetValid(game: Game, b: CrewBoard, range: number): boolean {
  const t = b.target, o = b.observation;
  if (!t || !o) return t === null && o === null;
  const q = game.players.get(t.player.id), s = q?.state;
  // Deliberately do not read the target's current coordinates or velocity.
  if (q !== t.player || s !== t.state || !s?.alive || !game.areEnemies(b.gunner, q) || q.faction !== t.faction ||
      q.vehicleId !== t.hullId || game.vehicles.get(q.vehicleId) !== t.hull ||
      (s.seat ?? 0) !== t.seat || (s.vehicleVariant ?? 0) !== t.variant ||
      s.vehicle !== t.vehicle || s.grounded !== t.grounded || q.airlift !== t.airlift ||
      s.airlift !== t.stateAirlift || q.vehicleId === b.hull.id) return false;
  const p = b.gunner.state;
  return (o.state.px - p.px) ** 2 + (o.state.py - p.py) ** 2 + (o.state.pz - p.pz) ** 2 < range ** 2;
}
function remote(game: Game, b: CrewBoard, range: number): boolean {
  if (game.tick < b.hurtUntil || !game.remoteGroundPerception(b.driver, range) ||
      !game.remoteGroundPerception(b.gunner, range)) return false;
  const t = b.target, o = b.observation;
  if (!t || !o) return true;
  const s = t.player.state, p = b.gunner.state;
  return t.player.isBot && !t.player.airlift && !s.airlift &&
    s.vehicle !== VEHICLE.JET && s.vehicle !== VEHICLE.GUNBOAT &&
    Number.isFinite(t.observedSpeed2) && t.observedSpeed2 <= 100 ** 2 &&
    (o.state.px - p.px) ** 2 + (o.state.pz - p.pz) ** 2 >= 20 ** 2;
}

/** Every ordinary think may service its nominated gunner's sensing deadline.
 * No recursive Bot.think, per-tick roster scan, or follower-order dependency. */
export function readCrewBoard(game: Game, p: ServerPlayer, range: number, scan: CrewScanner): CrewBoard | undefined {
  const hull = game.vehicles.get(p.vehicleId);
  let worldBoards = boards.get(game);
  let slot = hull ? worldBoards?.get(hull) : undefined;
  const fallback = () => { if (slot) slot.board = undefined; return undefined; };
  if (!hull || (hull.type !== VEHICLE.JEEP && hull.type !== VEHICLE.TANK) || hull.transportRoute !== undefined ||
      !(hull.health > 0) || !Number.isFinite(hull.health) || hull.respawnAtTick >= 0 ||
      game.world.trace !== nativeTrace || !Number.isSafeInteger(game.tick)) return fallback();
  const driver = game.players.get(hull.occupant), gunner = game.players.get(hull.gunner ?? -1);
  if (!member(game, hull, driver, 0) || !member(game, hull, gunner, 1) || driver === gunner ||
      (p !== driver && p !== gunner) || driver.faction <= 0 || driver.faction !== gunner.faction) return fallback();
  if (!worldBoards) { worldBoards = new WeakMap(); boards.set(game, worldBoards); }
  if (!slot) { slot = { board: undefined, lastScanTick: -Infinity }; worldBoards.set(hull, slot); }
  let b = slot.board;
  const s = gunner.state;
  const moved = b ? Math.hypot(s.px - b.x, s.py - b.y, s.pz - b.z) : 0;
  const elapsed = b ? game.tick - b.lastTick : 0;
  // Ordinary high-speed travel remains valid; teleports and skipped calls
  // drop old observations instead of extending a report across a new scene.
  const discontinuity = !!b && (elapsed < 0 || elapsed > 24 || moved > Math.max(4, elapsed * 256 / 60));
  if (!b || b.driver !== driver || b.gunner !== gunner || b.world !== game.world ||
      b.driverState !== driver.state || b.gunnerState !== gunner.state ||
      b.faction !== driver.faction || b.type !== hull.type || b.variant !== (hull.variant ?? 0) || discontinuity) {
    b = { hull, driver, gunner, driverState: driver.state, gunnerState: gunner.state,
      world: game.world, faction: driver.faction, type: hull.type, variant: hull.variant ?? 0,
      sensing: sensing(), observation: null, target: null, nextScanAt: game.tick, lastScanTick: slot.lastScanTick,
      lastTick: game.tick, revision: 0, remote: false, driverHealth: driver.health, gunnerHealth: gunner.health,
      hullHealth: hull.health, driverRegen: driver.regenBlockUntil, gunnerRegen: gunner.regenBlockUntil,
      hurtUntil: -Infinity, x: s.px, y: s.py, z: s.pz };
    slot.board = b;
  }
  b.lastTick = game.tick; b.x = s.px; b.y = s.py; b.z = s.pz;
  const hurt = driver.health < b.driverHealth || gunner.health < b.gunnerHealth || hull.health < b.hullHealth ||
    driver.regenBlockUntil > b.driverRegen || gunner.regenBlockUntil > b.gunnerRegen;
  b.driverHealth = driver.health; b.gunnerHealth = gunner.health; b.hullHealth = hull.health;
  b.driverRegen = driver.regenBlockUntil; b.gunnerRegen = gunner.regenBlockUntil;
  if (hurt) {
    // The first hit after quiet refreshes immediately. Further hits wake
    // the controller (e.g. abandon a wreck), but retain the ordinary scan
    // deadline while extending the same sixty-tick quiet window.
    const firstHit = game.tick >= b.hurtUntil;
    b.hurtUntil = game.tick + 60; if (firstHit) b.nextScanAt = game.tick; b.revision++;
  }
  if (!targetValid(game, b, range)) {
    clearTarget(b); b.sensing.losObstructions.clear(); b.nextScanAt = game.tick; b.revision++;
  }
  const isRemote = remote(game, b, range);
  if (b.remote && !isRemote) { b.nextScanAt = game.tick; b.revision++; }
  b.remote = isRemote;
  if (game.tick >= b.nextScanAt) {
    if (slot.lastScanTick === game.tick) {
      // A later same-tick lifecycle mutation may revoke a report, but never
      // grants a second hull scan. Stop firing until next tick's fresh scan.
      clearTarget(b); b.nextScanAt = game.tick + 1; b.revision++;
      return b;
    }
    const old = b.observation;
    slot.lastScanTick = b.lastScanTick = game.tick; b.sensing.losCheckAt = game.tick;
    const q = scan(game, gunner, b.sensing, { interval: isRemote ? 24 : 9, maxChecks: isRemote ? 4 : 2 });
    if (q) {
      const qs = q.state;
      if (!Number.isFinite(qs.px + qs.py + qs.pz)) clearTarget(b);
      else {
        b.observation = Object.freeze({ id: q.id, observedTick: game.tick,
          state: Object.freeze({ px: qs.px, py: qs.py, pz: qs.pz }) });
        b.target = { player: q, hull: game.vehicles.get(q.vehicleId), faction: q.faction, hullId: q.vehicleId,
          vehicle: qs.vehicle, grounded: qs.grounded, airlift: q.airlift, stateAirlift: qs.airlift,
          state: qs, seat: qs.seat ?? 0, variant: qs.vehicleVariant ?? 0,
          observedSpeed2: qs.vx ** 2 + qs.vy ** 2 + qs.vz ** 2 };
      }
    } else { clearTarget(b); }
    const current = b.observation;
    if (old?.id !== current?.id || old?.state.px !== current?.state.px || old?.state.py !== current?.state.py ||
        old?.state.pz !== current?.state.pz) b.revision++;
    b.remote = remote(game, b, range);
    b.nextScanAt = game.tick + (b.remote ? 24 : 9);
    b.sensing.losCheckAt = b.nextScanAt;
  }
  return b;
}
