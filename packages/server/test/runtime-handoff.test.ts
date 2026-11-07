import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerPlayer } from '../src/game.js';
import { captureActors, checkedHandoff, type RuntimeHandoff } from '../src/runtime-handoff.js';
import { BTN, VEHICLE, createMoveState, rotationFromEuler, vehicleDefinition } from '@shared/index';
import { namespaceRange } from '@shared/entity-id';

function game(namespace = 0): Game {
  const g = new Game(1337, { entityNamespace: namespace });
  (g as unknown as { pickSpawn: () => { x: number; y: number; z: number } }).pickSpawn = () => ({ x: 0, y: 600, z: 0 });
  g.tick = 1200; g.world.motionTime = g.tick / 60;
  return g;
}
function command(p: ServerPlayer, buttons = 0) {
  return { seq: p.lastQueuedSeq + 1, buttons, weapon: p.weapon, yaw: .3, pitch: .1, renderTick: 1199, renderFrac: .5 };
}
function copy<T>(record: T): T { return JSON.parse(JSON.stringify(record)) as T; }
function sinks(record: RuntimeHandoff) { return new Map(record.players.map(p => [p.id, null])); }

test('JSON handoff retains jumping, reloads, queued inputs, explosives and lag history with identical next-tick simulation', () => {
  const source = game(), p = source.addPlayer('Explorer', null, false, 100_000);
  Object.assign(p.state, { vx: 9.5, vy: 8.6, vz: -2, jumpHeld: true, jumpAscent: true, dodgeCd: .43, simulationTick: 1200 });
  Object.assign(p, { health: 77, weapon: 1, fireCd: .2, reloadWeapon: 1, reloadCd: .7,
    reloadHeld: true, regenBlockUntil: 1500, faction: 1, factionChangeAt: 1800,
    fallCreditAttackerId: 100_001, fallCreditUntilTick: 1250, salvage: 137, spree: 3,
    lastDeath: { x: 350, y: 27, z: -900 } });
  p.ammo[1].magazine = 0; p.discoveries.add('1337:city-2'); p.fullPickupContacts.add(0x80000009);
  source.queueInput(p, command(p, BTN.FORWARD | BTN.JUMP)); source.step();
  source.queueInput(p, command(p, BTN.FORWARD));
  const projectile = { id: namespaceRange(0).first, owner: p.id, weapon: 4, x: 12, y: 620, z: 20,
    vx: 10, vy: 4, vz: -20, distLeft: 200, fuseLeft: 2, ageSeconds: .3, sleeping: false, homingTarget: 100_001, hullDamageScale: .8 };
  source.projectiles.set(projectile.id, projectile);
  source.projectiles.set(projectile.id + 1, { ...projectile, id: projectile.id + 1, weapon: 3, fuseLeft: Infinity });
  const before = captureActors(source, [p.id]).record;
  const control = game(2); control.tick = source.tick; control.acceptHandoff(before, sinks(before));
  const detached = source.takeHandoff([p.id]), wire = copy(detached.record), destination = game(1);
  assert.equal(source.players.has(p.id), false); assert.equal(source.projectiles.size, 0);
  assert.ok(wire.history.some(f => f.players.some(q => q.id === p.id)));
  assert.ok(!JSON.stringify(wire).includes('sink'));
  assert.equal(wire.projectiles.find(r => r.weapon === 3)!.fuseLeft, null);
  destination.tick = wire.tick;
  const [arrived] = destination.acceptHandoff(wire, sinks(wire));
  assert.equal(destination.projectiles.get(projectile.id + 1)!.fuseLeft, Infinity, 'impact-only rockets do not gain an immediate fuse');
  assert.equal(arrived.state.vy, p.state.vy); assert.equal(arrived.state.dodgeCd, p.state.dodgeCd);
  assert.deepEqual(arrived.inputQueue, p.inputQueue); assert.equal(arrived.lastProcessedSeq, p.lastProcessedSeq);
  assert.equal(arrived.reloadCd, p.reloadCd); assert.deepEqual(arrived.ammo, p.ammo);
  assert.deepEqual(arrived.discoveries, p.discoveries); assert.deepEqual(arrived.fullPickupContacts, p.fullPickupContacts);
  assert.deepEqual(arrived.lastDeath, p.lastDeath, 'regional handoff keeps the last-death map marker');
  arrived.ammo[0].magazine--; assert.notEqual(arrived.ammo[0].magazine, wire.players[0].ammo[0].magazine);
  arrived.ammo[0].magazine++;
  destination.step(); control.step();
  assert.deepEqual(captureActors(destination, [p.id]).record, captureActors(control, [p.id]).record);
  assert.throws(() => destination.acceptHandoff(wire, sinks(wire)), /occupied/);
});

test('a passenger handoff includes pilot, aircraft pose, both weapons and projectiles as one unit', () => {
  const source = game(), pilot = source.addPlayer('Pilot', null, false, 100_000), gunner = source.addPlayer('Gunner', null, false, 100_001);
  const hullId = namespaceRange(0).first;
  const hull = { id: hullId, type: VEHICLE.JET, variant: 0, x: 0, y: 600, z: 0, heading: .4,
    health: vehicleDefinition(VEHICLE.JET)!.maxHealth - 37, occupant: pilot.id, gunner: gunner.id, respawnAtTick: -1 };
  source.vehicles.set(hullId, hull);
  for (const [p, seat] of [[pilot, 0], [gunner, 1]] as const) {
    p.vehicleId = hullId; p.vehFireCd = .4 + seat; p.vehAltCd = 2 + seat; p.useHeld = true;
    Object.assign(p.state, { vehicle: VEHICLE.JET, vehicleId: hullId, seat, heading: .4, vx: 35, vy: 3, vz: -45,
      vehicleRotation: rotationFromEuler(.4, .2, -.3), vehiclePitch: .2, vehicleRoll: -.3, boostFuel: .61 });
    source.queueInput(p, command(p));
  }
  source.projectiles.set(hullId, { id: hullId, owner: gunner.id, weapon: 215, x: 1, y: 580, z: 3,
    vx: 1, vy: -50, vz: 3, ageSeconds: .2, fuseLeft: 3, distLeft: 500, sleeping: false });
  const detached = source.takeHandoff([gunner.id]);
  assert.deepEqual(new Set(detached.record.players.map(p => p.id)), new Set([pilot.id, gunner.id]));
  assert.equal(source.players.size, 0); assert.equal(source.vehicles.size, 0); assert.equal(source.projectiles.size, 0);
  const destination = game(1); destination.acceptHandoff(copy(detached.record), sinks(detached.record));
  assert.deepEqual(destination.vehicles.get(hullId), hull);
  assert.deepEqual(destination.players.get(pilot.id)!.state.vehicleRotation, pilot.state.vehicleRotation);
  assert.equal(destination.players.get(gunner.id)!.vehFireCd, 1.4);
  destination.step();
  const arrivedPilot = destination.players.get(pilot.id)!, arrivedGunner = destination.players.get(gunner.id)!;
  assert.equal(arrivedPilot.vehicleId, hullId); assert.equal(arrivedGunner.vehicleId, hullId);
  assert.equal(arrivedGunner.state.px, arrivedPilot.state.px); assert.equal(arrivedGunner.state.py, arrivedPilot.state.py);
  assert.ok(destination.projectiles.has(hullId));
});

test('refused handoffs leave both authorities unchanged and local rollback retains the connection and timers', () => {
  const source = game(), p = source.addPlayer('Explorer', null, false, 100_000);
  Object.assign(p, { recallSince: 1140, regenBlockUntil: 1300, respawnAtTick: -1, lastInputAtTick: 1198,
    spawnProtectedUntil: 1380, preferredSpawnId: 'base-city-2' });
  Object.assign(p.state, { vx: 14, vy: 4.2, dodgeCd: .7, simulationTick: 1200 });
  const detached = source.takeHandoff([p.id]), destination = game(1);
  destination.addPlayer('Already present', null, false, p.id);
  assert.throws(() => destination.acceptHandoff(detached.record, sinks(detached.record)), /occupied/);
  assert.equal(source.players.size, 0); assert.equal(destination.players.size, 1);
  source.tick += 12;
  const [restored] = source.restoreHandoff(detached);
  assert.equal(restored, p); assert.equal(p.state.vx, 14); assert.equal(p.state.vy, 4.2); assert.equal(p.state.dodgeCd, .7);
  assert.equal(p.regenBlockUntil, 1312); assert.equal(p.recallSince, 1152); assert.equal(p.lastInputAtTick, 1210);
  assert.equal(p.spawnProtectedUntil, 1392, 'spawn protection preserves remaining time across a worker handoff');
  assert.equal(p.preferredSpawnId, 'base-city-2', 'the selected respawn base travels with the actor');
  assert.equal(p.state.simulationTick, 1200, 'platform carry retains the old world time');
  assert.equal(p.respawnAtTick, -1, 'sentinels never become active timers');
  assert.throws(() => source.restoreHandoff(detached), /occupied/);
  const empty = game(2);
  for (const invalid of [
    { ...copy(detached.record), seed: 7331 },
    { ...copy(detached.record), tick: 1201 },
    { ...copy(detached.record), tick: 800 },
    { ...copy(detached.record), players: [...detached.record.players, ...detached.record.players] },
    { ...copy(detached.record), projectiles: [{ id: 1, owner: 123 }] },
  ]) {
    assert.throws(() => empty.acceptHandoff(invalid as RuntimeHandoff, sinks(detached.record)));
    assert.equal(empty.players.size, 0); assert.equal(empty.projectiles.size, 0); assert.equal(empty.vehicles.size, 0);
  }
  assert.throws(() => empty.acceptHandoff(detached.record, new Map()), /connection/);
});

test('checked wire order remains stable while installed optional movement fields regain the factory layout', () => {
  const source = game(), p = source.addPlayer('Transit', null, false, 100_000);
  Object.assign(p.state, { simulationTick: 1200, jumpAscent: false, airSeconds: 7.25, swimming: false, submerged: false,
    airlift: { source: 1, destination: 2, startTick: 1200, durationTicks: 300 } });
  const wire = captureActors(source, [p.id]).record;
  // Existing peers can send another key order and ordinary extra data. The
  // durable receipt hashes that exact wire order, so validation must retain it.
  wire.players[0].state = Object.fromEntries(Object.entries(wire.players[0].state).reverse()) as typeof p.state;
  Object.defineProperty(wire.players[0].state, '__proto__', {
    value: { retainedExtra: 'data' }, enumerable: true, configurable: true, writable: true,
  });
  const serialized = JSON.stringify(wire);
  assert.equal(JSON.stringify(checkedHandoff(wire)), serialized);
  const destination = game(1);
  const [arrived] = destination.acceptHandoff(wire, sinks(wire));
  const keys = Object.keys(createMoveState(0, 0, 0));
  assert.deepEqual(Object.keys(arrived.state).slice(0, keys.length), keys);
  assert.equal(arrived.state.simulationTick, 1200);
  assert.equal(arrived.state.airSeconds, 7.25);
  assert.deepEqual(arrived.state.airlift, p.state.airlift);
  assert.notEqual(arrived.state.airlift, wire.players[0].state.airlift);
  assert.equal(Object.getPrototypeOf(arrived.state), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(arrived.state, '__proto__'), {
    value: { retainedExtra: 'data' }, enumerable: true, configurable: true, writable: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(arrived.state)), JSON.parse(JSON.stringify(wire.players[0].state)));
  assert.equal(JSON.stringify(wire), serialized, 'installation cannot reorder or mutate the receipt payload');
});

test('handoffs staged before human weapon time was tracked arrive without banked ticks', () => {
  const source = game(), p = source.addPlayer('Staged', null, false, 100_000);
  p.weaponTicks = 12;
  const wire = captureActors(source, [p.id]).record;
  assert.equal(wire.players[0].weaponTicks, 12, 'current payloads carry the weapon time');
  delete (wire.players[0] as Partial<typeof wire.players[0]>).weaponTicks;
  const wrong = copy(wire) as unknown as { players: Record<string, unknown>[] };
  wrong.players[0].weaponTicks = 'wrong type';
  assert.throws(() => checkedHandoff(wrong as unknown as RuntimeHandoff), /Incomplete handoff player/);
  const destination = game(1), [arrived] = destination.acceptHandoff(wire, sinks(wire));
  assert.equal(arrived.weaponTicks, 0);
});

test('legacy handoffs may omit optional movement fields but still require all original field types', () => {
  const source = game(), p = source.addPlayer('Legacy', null, false, 100_000);
  const wire = captureActors(source, [p.id]).record;
  const required = ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'grounded', 'jumpHeld', 'dodgeCd', 'alive',
    'vehicle', 'vehicleVariant', 'heading', 'boostFuel', 'vehiclePitch', 'vehicleRoll', 'boosting'];
  const state = wire.players[0].state as unknown as Record<string, unknown>;
  for (const key of Object.keys(state)) if (!required.includes(key)) delete state[key];
  assert.doesNotThrow(() => checkedHandoff(wire));
  const destination = game(1), [arrived] = destination.acceptHandoff(wire, sinks(wire));
  assert.deepEqual(Object.keys(arrived.state), Object.keys(createMoveState(0, 0, 0)));
  assert.equal(arrived.state.simulationTick, undefined); assert.equal(arrived.state.airlift, undefined);
  for (const key of required) {
    const missing = copy(wire), wrong = copy(wire);
    delete (missing.players[0].state as unknown as Record<string, unknown>)[key];
    (wrong.players[0].state as unknown as Record<string, unknown>)[key] = 'wrong type';
    assert.throws(() => checkedHandoff(missing), /Incomplete handoff movement/, key);
    assert.throws(() => checkedHandoff(wrong), /Incomplete handoff movement/, key);
  }
});
