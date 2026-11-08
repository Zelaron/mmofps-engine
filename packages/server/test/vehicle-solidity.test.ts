import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, ByteReader, TICK_RATE, VEHICLE, createMoveState, decodeSnapshot, vehicleDefinition,
  capsuleClearance, type InputCmd } from '@shared/index';
import { withVehicleColliders } from '@shared/vehicle-collision';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';
import { Prediction } from '../../client/src/prediction.js';
import { vehicleCollisionWorld } from '../../shared/test/vehicle-collision-fixture.js';

function command(seq: number, buttons: number = BTN.FORWARD, yaw = 0): InputCmd {
  return { seq, buttons, yaw, pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 };
}
function fixture(type: ServerVehicle['type'] = VEHICLE.JEEP) {
  const game = new Game(1337); vehicleCollisionWorld(game.world);
  const player = new ServerPlayer(10001, 'Walker', null, false, { x: 0, y: .006, z: 7 });
  player.faction = 1; player.state.grounded = true; game.players.set(player.id, player);
  const hull: ServerVehicle = { id: 10002, type, x: 0, y: 0, z: 0, heading: 0,
    occupant: -1, health: vehicleDefinition(type)!.maxHealth, respawnAtTick: -1 };
  game.vehicles.set(hull.id, hull);
  const step = (buttons: number = BTN.FORWARD, yaw = 0) => {
    const cmd = command(player.lastQueuedSeq + 1, buttons, yaw);
    game.queueInput(player, cmd); game.step(); return cmd;
  };
  const snapshot = () => {
    const bytes = (game as unknown as { buildSnapshotFor(p: ServerPlayer): Uint8Array }).buildSnapshotFor(player);
    const reader = new ByteReader(bytes); reader.u8(); return decodeSnapshot(reader);
  };
  const clearance = () => withVehicleColliders(game.world, player.state, 0,
    () => capsuleClearance(game.world, player.state.px, player.state.py, player.state.pz));
  return { game, player, hull, step, snapshot, clearance };
}

test('real snapshots give parked hulls the same solid boundary in authority and prediction', () => {
  for (const type of [VEHICLE.JEEP, VEHICLE.TANK] as const) {
    const f = fixture(type), prediction = new Prediction(vehicleCollisionWorld());
    f.step(0); prediction.onSnapshot(f.snapshot());
    for (let i = 0; i < 105; i++) {
      const cmd = command(f.player.lastQueuedSeq + 1);
      prediction.applyLocal(cmd); f.game.queueInput(f.player, cmd); f.game.step();
      assert.ok(Math.hypot(prediction.state.px - f.player.state.px, prediction.state.py - f.player.state.py,
        prediction.state.pz - f.player.state.pz) < .04, 'prediction stops at the same hull without a server correction');
      if (i % 3 === 2) prediction.onSnapshot(f.snapshot());
    }
    assert.ok(f.player.state.pz > 2 && f.player.state.pz < 3, `type ${type}: walking must stop on the approach side`);
    assert.ok(f.clearance() > -.025, 'the capsule remains outside the real solid');
    assert.equal(f.game.world.pedestrianCollisions, undefined, 'the movement field cannot leak into weapons or terrain queries');
    assert.ok(f.game.world.sdf(0, 1, 0) > 0, 'general world traces retain their separate explicit hull hit handling');
  }
});

test('occupied hulls also block pedestrians and crew cannot duplicate the body', () => {
  const f = fixture(VEHICLE.TANK), driver = new ServerPlayer(10003, 'Driver', null, false, { x: 0, y: 0, z: 0 });
  driver.vehicleId = f.hull.id;
  Object.assign(driver.state, { vehicle: f.hull.type, vehicleId: f.hull.id, grounded: true });
  f.hull.occupant = driver.id; f.game.players.set(driver.id, driver);
  const crew = new ServerPlayer(10004, 'Gunner', null, false, { x: 0, y: 0, z: 0 });
  crew.vehicleId = f.hull.id; Object.assign(crew.state, driver.state, { seat: 1 });
  f.hull.gunner = crew.id; f.game.players.set(crew.id, crew);
  f.step(0);
  const prediction = new Prediction(vehicleCollisionWorld()); prediction.onSnapshot(f.snapshot());
  assert.equal(prediction['world'].vehicleCollisions?.size, 1);
  for (let i = 0; i < 100; i++) { prediction.applyLocal(command(i + 2)); f.step(); }
  assert.ok(f.player.state.pz > 2 && prediction.state.pz > 2);
});

test('boarding bypasses the pedestrian hull, and exits avoid other parked vehicles', () => {
  const f = fixture(); for (let i = 0; i < 65; i++) f.step();
  f.step(BTN.USE); assert.equal(f.player.state.vehicle, VEHICLE.JEEP);
  const start = f.player.state.pz;
  f.step(0); for (let i = 0; i < 45; i++) f.step();
  assert.ok(f.player.state.pz < start - 1, 'the driver can move the hull without colliding against itself');
  assert.equal(f.hull.health, vehicleDefinition(VEHICLE.JEEP)!.maxHealth);
  f.step(0);
  const neighbor = { ...f.hull, id: 10005, x: f.hull.x + 2.75, occupant: -1, motionState: undefined };
  f.game.vehicles.set(neighbor.id, neighbor);
  f.step(BTN.USE); assert.equal(f.player.state.vehicle, VEHICLE.NONE);
  assert.ok(f.clearance() > -.025, 'exit chooses a capsule-clear side of both hulls');
});

test('a driven jeep stops at a parked tank in authority and prediction alike', () => {
  const f = fixture(); for (let i = 0; i < 65; i++) f.step();
  f.step(BTN.USE); assert.equal(f.player.state.vehicle, VEHICLE.JEEP);
  const tank: ServerVehicle = { id: 10006, type: VEHICLE.TANK, x: 0, y: 0, z: -30, heading: 0,
    occupant: -1, health: vehicleDefinition(VEHICLE.TANK)!.maxHealth, respawnAtTick: -1 };
  f.game.vehicles.set(tank.id, tank);
  f.step(0);
  const prediction = new Prediction(vehicleCollisionWorld()); prediction.onSnapshot(f.snapshot());
  for (let i = 0; i < 300; i++) {
    const cmd = command(f.player.lastQueuedSeq + 1);
    prediction.applyLocal(cmd); f.game.queueInput(f.player, cmd); f.game.step();
    if (i % 3 === 2) prediction.onSnapshot(f.snapshot());
  }
  const rear = tank.z + 2.33;
  assert.ok(f.player.state.pz > rear && f.player.state.pz < rear + 2, `authority stops at the tank: ${f.player.state.pz}`);
  assert.ok(Math.abs(prediction.state.pz - f.player.state.pz) < .5, `prediction agrees: ${prediction.state.pz} vs ${f.player.state.pz}`);
  assert.ok(f.hull.health < vehicleDefinition(VEHICLE.JEEP)!.maxHealth, 'ramming at speed is a crash for the rammer');
  assert.equal(tank.x, 0, 'the parked hull is an obstacle, not pushed');
});

test('a destroyed hull waits for a parked hull to clear its pad, but not forever', () => {
  const f = fixture(), internal = f.game as unknown as { vehicleSites: unknown[]; updateVehicles(): void };
  internal.vehicleSites.push({ type: VEHICLE.JEEP, x: 0, z: 0, heading: 0 });
  f.hull.campaignHome = { x: 0, y: 0, z: 0, heading: 0 };
  const parked: ServerVehicle = { ...f.hull, id: 10007, x: 1.5, campaignHome: undefined };
  f.game.vehicles.set(parked.id, parked);
  f.hull.health = 0; f.hull.respawnAtTick = f.game.tick + 1;
  const advance = (seconds: number) => { for (let i = 0; i < seconds * TICK_RATE; i++) { f.game.tick++; internal.updateVehicles(); } };
  advance(25);
  assert.ok(f.hull.respawnAtTick >= 0, 'the replacement waits while another hull sits on its pad');
  advance(10);
  assert.equal(f.hull.respawnAtTick, -1, 'an abandoned hull cannot hold the pad forever');
  assert.equal(f.hull.health, vehicleDefinition(VEHICLE.JEEP)!.maxHealth);
});

test('destroyed and removed hulls disappear from authority and client collision immediately', () => {
  const f = fixture(); for (let i = 0; i < 65; i++) f.step();
  const prediction = new Prediction(vehicleCollisionWorld()); prediction.onSnapshot(f.snapshot());
  assert.equal(prediction['world'].vehicleCollisions?.size, 1);
  f.player.lastCmd = command(f.player.lastProcessedSeq, BTN.HYPER);
  f.game.damageVehicle(f.hull, 100_000, null, 255);
  assert.equal(f.game.world.vehicleCollisions?.size, 0);
  prediction.onSnapshot(f.snapshot()); assert.equal(prediction['world'].vehicleCollisions?.size, 0);
  assert.ok(f.player.state.alive);
  // Start a fresh ordinary walk so the explosion's physical impulse does not
  // determine whether the now-empty footprint can be crossed.
  Object.assign(f.player.state, createMoveState(0, .006, 7), { grounded: true });
  for (let i = 0; i < 100; i++) f.step();
  assert.ok(f.player.state.pz < -4, 'the destroyed hull leaves a traversable footprint');
  f.hull.health = 1200; f.hull.respawnAtTick = -1; f.hull.z = f.player.state.pz - 4;
  f.step(0); assert.equal(f.game.world.vehicleCollisions?.size, 1);
  f.game.vehicles.delete(f.hull.id); f.step(0);
  assert.equal(f.game.world.vehicleCollisions?.size, 0, 'full authority replacement drops removed records');
  prediction.onSnapshot(f.snapshot()); assert.equal(prediction['world'].vehicleCollisions?.size, 0);
  prediction.hardResync(); assert.equal(prediction['world'].vehicleCollisions?.size, 0);
});
