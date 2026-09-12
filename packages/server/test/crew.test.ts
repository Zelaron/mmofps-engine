import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerPlayer, type ServerVehicle } from '../src/game.js';
import { BTN, VEHICLE, vehicleDefinition, rotationFromEuler, vehicleQuaternion, rotateVector,
  ENT_PLAYER, ByteReader, decodeSnapshot, CREW_CONE_HALF_ANGLE } from '@shared/index';

const cmd = (p: ServerPlayer, buttons = 0, yaw = 0, pitch = 0) => ({ seq: p.lastQueuedSeq + 1, buttons, yaw, pitch, weapon: 0, renderTick: 0, renderFrac: 0 });
function fixture(type = VEHICLE.JEEP as number) {
  const game = new Game(1337), a = game.addPlayer('pilot', null), b = game.addPlayer('gunner', null);
  const v: ServerVehicle = { id: 901, type: type as 1, x: 0, y: 600, z: 0, heading: 0,
    health: vehicleDefinition(type)!.maxHealth, occupant: -1, respawnAtTick: -1 };
  game.vehicles.set(v.id, v);
  const enter = (p: ServerPlayer) => {
    Object.assign(p.state, { px: v.x + 2.5, py: v.y, pz: v.z, vx: 0, vy: 0, vz: 0 });
    game.queueInput(p, cmd(p, BTN.USE)); game.step(); game.queueInput(p, cmd(p)); game.step();
  };
  enter(a); enter(b); return { game, a, b, v };
}
test('two seats share a hull while only the driver controls its motion', () => {
  const { game, a, b, v } = fixture();
  assert.equal(v.occupant, a.id); assert.equal(v.gunner, b.id); assert.equal(b.state.seat, 1);
  const heading = a.state.heading;
  for (let i = 0; i < 30; i++) { game.queueInput(a, cmd(a)); game.queueInput(b, cmd(b, BTN.FORWARD | BTN.LEFT)); game.step(); }
  assert.equal(a.state.heading, heading); assert.equal(b.state.heading, heading);
  assert.equal(a.state.px, b.state.px); assert.equal(a.state.py, b.state.py); assert.equal(a.state.pz, b.state.pz);
  const snapBytes = (game as unknown as { buildSnapshotFor(p: ServerPlayer): Uint8Array }).buildSnapshotFor(b), r = new ByteReader(snapBytes); r.u8();
  const snap = decodeSnapshot(r);
  assert.equal(snap.you.seat, 1); assert.equal(snap.you.vehicleId, v.id);
  assert.equal(snap.ents.find(e => e.id === a.id)?.kind, ENT_PLAYER);
});
test('exiting or disconnecting vacates one seat and promotes the surviving crew', () => {
  const { game, a, b, v } = fixture(VEHICLE.JET);
  game.removePlayer(a.id);
  assert.equal(v.occupant, b.id); assert.equal(v.gunner, -1); assert.equal(b.state.seat, 0);
  assert.equal(v.respawnAtTick, -1); assert.equal(b.state.vehicle, VEHICLE.JET);
  game.damageVehicle(v, 1e6, null, 3);
  assert.equal(b.state.alive, false); assert.equal(b.vehicleId, -1);
});
test('wrecking an occupied hull clears and kills both seats', () => {
  const { game, a, b, v } = fixture(); game.damageVehicle(v, 1e6, null, 3);
  for (const p of [a, b]) { assert.equal(p.state.alive, false); assert.equal(p.state.vehicle, 0); assert.equal(p.vehicleId, -1); }
  assert.equal(v.occupant, -1); assert.equal(v.gunner, -1);
});
test('passenger weapons are independent and aircraft rockets cannot leave their underside cone', () => {
  const { game, a, b } = fixture(VEHICLE.JET);
  a.state.vehicleRotation = rotationFromEuler(.7, .5, .8);
  b.vehFireCd = 0;
  game.queueInput(a, cmd(a)); game.queueInput(b, cmd(b, BTN.FIRE, -2, 1.3)); game.step();
  const rocket = [...game.projectiles.values()].find(r => r.owner === b.id)!;
  assert.ok(rocket); assert.equal(rocket.weapon, 215);
  const down = rotateVector(vehicleQuaternion(a.state), 0, -1, 0), len = Math.hypot(rocket.vx, rocket.vy, rocket.vz);
  const dot = (rocket.vx * down.x + rocket.vy * down.y + rocket.vz * down.z) / len;
  assert.ok(Math.acos(Math.min(1, dot)) < CREW_CONE_HALF_ANGLE + .01);
  assert.equal([...game.projectiles.values()].filter(r => r.owner === a.id).length, 0);
});
