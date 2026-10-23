import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerPlayer } from '../src/game.js';
import { EncounterField, type EncounterRegion, World, TICK_DT, TICK_RATE, BTN, PICKUP_AMMO } from '@shared/index';

type Pending = { key: string; iterator: Generator<void, EncounterRegion> };
interface FieldInternals { cache: Map<string, EncounterRegion>; pending: Pending | null }
interface Internals {
  encounterField: EncounterField | null; encounterRevision: number;
  regionalTeleporters: boolean; regionalVehicles: boolean; activeLootRegions: Set<string>;
  vehicleRegionJob: { key: string; iterator: Generator<void> } | null;
  caveLoot: { kind: typeof PICKUP_AMMO; weapon: number; x: number; y: number; z: number; activeId: number; respawnAtTick: number }[];
  updateEncounters(backlog?: number): void;
}
const internals = (game: Game) => game as unknown as Internals;
const fieldInternals = (field: EncounterField) => field as unknown as FieldInternals;
const region = (key: string): EncounterRegion => ({ key, pads: [], loot: [], pois: [] });

test('zero generation steps still change active selection, discard obsolete work and apply cached revisions', () => {
  const game = new Game(1337), field = new EncounterField(game.world), state = internals(game);
  state.encounterField = field; state.regionalTeleporters = true;
  const old = region('0,0'), next = region('4,4');
  old.pads = [{ x: 10, y: 0, z: 10, cave: false, partner: 0 }];
  next.pads = [{ x: 4500, y: 0, z: 4500, cave: false, partner: 0 }];
  fieldInternals(field).cache.set(old.key, old); fieldInternals(field).cache.set(next.key, next);
  game.tick = 1; state.updateEncounters(5);
  assert.deepEqual(game.teleporterPads, old.pads); assert.deepEqual([...state.activeLootRegions], ['0,0']);
  let advanced = 0;
  function* obsolete(): Generator<void, EncounterRegion> { advanced++; yield; return region('1,0'); }
  fieldInternals(field).pending = { key: '1,0', iterator: obsolete() };
  game.players.set(1, { isBot: false, state: { alive: true, px: 4500, pz: 4500 } } as ServerPlayer);
  state.updateEncounters(5);
  assert.equal(advanced, 0); assert.equal(field.stats.pending, null);
  assert.deepEqual([...state.activeLootRegions], ['4,4']); assert.deepEqual(game.teleporterPads, next.pads);
  assert.equal(state.encounterRevision, field.revision, 'existing discoveries update on the same overloaded tick');
});

test('backlog allows one encounter advance every six ticks, leaves vehicle work live and restores the normal budget', t => {
  t.mock.method(performance, 'now', () => 0);
  const game = new Game(1337), field = new EncounterField(game.world), state = internals(game);
  state.encounterField = field; field.update([{ x: 0, z: 0 }], 0, 0);
  let advances = 0, vehicleAdvances = 0;
  function* pending(): Generator<void, EncounterRegion> { for (let i = 0; i < 40; i++) { advances++; yield; } return region('0,0'); }
  function* vehicles(): Generator<void> { for (;;) { vehicleAdvances++; yield; } }
  fieldInternals(field).pending = { key: '0,0', iterator: pending() };
  state.regionalVehicles = true; state.vehicleRegionJob = { key: '0,0', iterator: vehicles() };
  for (let tick = 1; tick <= 12; tick++) {
    game.step(2); assert.equal(advances, Math.floor(tick / 6)); assert.equal(vehicleAdvances, tick);
    assert.equal(game.tick, tick); assert.equal(game.world.motionTime, tick / TICK_RATE);
  }
  game.step(1); assert.equal(advances, 10, 'recovered clock immediately restores the existing eight-step allowance');
  game.step(); assert.equal(advances, 18, 'ordinary callers keep the default budget');
});

/** A static layered signed field deliberately has no motionTime-dependent
 * bodies. Changing scheduling against live transit can change discovery tests. */
function layeredWorld(): World {
  return {
    seed: 1337, collectCaveSites: () => [],
    column: () => ({ h: 24, entr: 0, volc: 0, lavaY: -1000 }), groundY: () => 24,
    roofedAbove: (_x: number, y: number) => y < 24,
    sdf: (_x: number, y: number) => Math.max(y - 24, Math.min(y + 23, -16 - y), Math.min(y + 37, -30 - y)),
    trace(x: number, y: number, z: number, dx: number, dy: number, dz: number, distance: number) {
      if (!dy) return { hit: false, x: x + dx * distance, y, z: z + dz * distance, nx: 0, ny: 0, nz: 0, dist: distance };
      const floor = [24, -23, -37].find(height => height < y && y - height <= distance);
      return { hit: floor !== undefined, x, y: floor ?? y - distance, z, nx: 0, ny: 1, nz: 0, dist: floor === undefined ? distance : y - floor };
    },
  } as unknown as World;
}

test('eventual static encounter geometry and links are identical after bounded slow discovery', () => {
  const finish = (backlog: number) => {
    const game = new Game(1337), field = new EncounterField(layeredWorld());
    internals(game).encounterField = field;
    for (let tick = 1; tick <= 100_000; tick++) {
      game.tick = tick; internals(game).updateEncounters(backlog);
      if (field.regions.length === field.stats.wanted && field.stats.pending === null)
        return { field, ticks: tick };
    }
    assert.fail('bounded generation starved');
  };
  const normal = finish(0), behind = finish(8);
  assert(behind.ticks > normal.ticks * 5);
  assert.equal(behind.field.regions.length, 9);
  assert(behind.field.pois.length > 100, 'comparison includes populated discoveries and props');
  assert.deepEqual(behind.field.regions, normal.field.regions);
  assert.deepEqual(behind.field.pads, normal.field.pads);
  assert.deepEqual(behind.field.pois, normal.field.pois);
});

test('encounter backpressure preserves movement, fire, teleport, fuse, loot, regen, respawn and capture milestones', () => {
  const fixture = () => {
    const game = new Game(1337, { frontier: true }), state = internals(game);
    const field = new EncounterField(game.world); field.update = () => false; state.encounterField = field;
    const mover = game.addPlayer('Mover', null), traveler = game.addPlayer('Traveler', null),
      dead = game.addPlayer('Returning', null), capturer = game.addPlayer('Capturer', null);
    const site = game.frontier!.territories.find(t => t.owner === 0)!;
    capturer.faction = 1;
    Object.assign(capturer.state, { px: site.x, py: site.y + .1, pz: site.z, alive: true, vehicle: 0 });
    Object.assign(mover.state, { px: 0, py: 1500, pz: 0, vx: 0, vy: 0, vz: 0, alive: true, vehicle: 0 });
    mover.health = 90; mover.regenBlockUntil = 4; mover.weapon = 0; mover.fireCd = 0;
    Object.assign(traveler.state, { px: 1000, py: 1000, pz: 1000, alive: true, vehicle: 0 });
    traveler.teleportArmed = true; traveler.teleportCdUntil = 0;
    game.teleporterPads = [{ x: 1000, y: 1000, z: 1000, cave: false, partner: 1 },
      { x: 1100, y: 1000, z: 1000, cave: false, partner: 0 }];
    dead.state.alive = false; dead.respawnAtTick = 5;
    const loot = { kind: PICKUP_AMMO, weapon: 1, x: 6000, y: 1000, z: 6000, activeId: 0, respawnAtTick: 4 } as const;
    state.caveLoot = [{ ...loot }];
    game.projectiles.set(777, { id: 777, owner: mover.id, weapon: 4, x: 5000, y: 1000, z: 5000,
      vx: 0, vy: 0, vz: 0, distLeft: 500, fuseLeft: 2.5 * TICK_DT, ageSeconds: 0, sleeping: true });
    return { game, state, mover, traveler, dead, site };
  };
  const normal = fixture(), behind = fixture();
  for (let tick = 1; tick <= 12; tick++) {
    for (const f of [normal, behind]) {
      f.game.queueInput(f.mover, { seq: tick, weapon: 0, buttons: BTN.FORWARD | BTN.FIRE, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 });
      f.game.step(f === behind ? 20 : 0);
    }
    const snapshot = (f: typeof normal) => ({ tick: f.game.tick, motionTime: f.game.world.motionTime,
      players: [...f.game.players.values()].map(p => ({ state: p.state, health: p.health, ammo: p.ammo,
        fireCd: p.fireCd, teleportCdUntil: p.teleportCdUntil, respawnAtTick: p.respawnAtTick })),
      projectiles: [...f.game.projectiles.values()], pickups: [...f.game.pickups.values()],
      influence: f.site.influence, captureProgress: f.site.captureProgress, stats: f.game.stats });
    assert.deepEqual(snapshot(behind), snapshot(normal), `runtime tick ${tick}`);
    assert.equal(behind.game.projectiles.has(777), tick < 3);
    assert.equal(behind.state.caveLoot[0].activeId > 0, tick >= 4);
    assert.equal(behind.dead.state.alive, tick >= 5);
    assert.equal(behind.mover.health > 90, tick >= 4);
  }
  assert.equal(behind.traveler.state.px, 1100); assert(behind.mover.state.pz < 0);
  assert(behind.game.stats.shotsFired > 0); assert(behind.site.captureProgress! > 0);
});
