import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerPlayer } from '../src/game.js';
import {
  BTN, VEHICLE, JET_MG, JET_BOMB, JET_GUN_MUZZLE, JET_BOMB_BAY, CARPET_BOMB_COUNT,
  ByteReader, Msg, decodeFire, rotationFromEuler, rotateVector, viewDir, type InputCmd,
} from '@shared/index';

test('jet guns and bomb releases stay on the physical airframe through loops, inversion and free look', () => {
  const game = new Game(1337), pilot = game.addPlayer('Loop pilot', null);
  const internal = game as unknown as {
    fireVehicleWeapons(p: ServerPlayer, cmd: InputCmd): void;
    events: { bytes: Uint8Array }[];
  };
  // Keep all rounds in air: this test is about authoritative attachment and
  // direction correctness, not particular world geometry along the orbit.
  game.world.trace = (x, y, z, dx, dy, dz, max) => ({
    hit: false, x: x + dx * max, y: y + dy * max, z: z + dz * max,
    nx: 0, ny: 0, nz: 0, dist: max,
  });
  for (const pitch of [-Math.PI, -Math.PI / 2, Math.PI / 2, Math.PI, Math.PI * 2.7]) {
    const rotation = rotationFromEuler(.8, pitch, 1.2);
    Object.assign(pilot.state, { vehicle: VEHICLE.JET, px: 15, py: 3000, pz: -40,
      vx: 50, vy: -20, vz: 35, heading: 0, vehiclePitch: 0, vehicleRoll: 0, vehicleRotation: rotation });
    pilot.vehFireCd = pilot.vehAltCd = 0;
    game.projectiles.clear(); internal.events.length = 0;
    internal.fireVehicleWeapons(pilot, { seq: 1, buttons: BTN.FIRE | BTN.ALTFIRE, weapon: 0,
      yaw: -2.5, pitch: -.9, renderTick: 0, renderFrac: 0 });
    const events = internal.events.filter(e => e.bytes[0] === Msg.SFire).map(e => {
      const reader = new ByteReader(e.bytes); reader.u8(); return decodeFire(reader);
    });
    const gun = events.find(e => e.weapon === JET_MG.id)!;
    assert.ok(gun);
    const muzzle = rotateVector(rotation, JET_GUN_MUZZLE.x, JET_GUN_MUZZLE.y, JET_GUN_MUZZLE.z);
    assert.ok(Math.hypot(gun.ox - pilot.state.px - muzzle.x, gun.oy - pilot.state.py - muzzle.y,
      gun.oz - pilot.state.pz - muzzle.z) < .001, 'server tracer starts at the rotated gun barrel');
    const end = gun.ends[0], length = Math.hypot(end.x - gun.ox, end.y - gun.oy, end.z - gun.oz);
    const direction = { x: (end.x - gun.ox) / length, y: (end.y - gun.oy) / length, z: (end.z - gun.oz) / length };
    const nose = rotateVector(rotation, 0, 0, -1), look = viewDir(-2.5, -.9);
    assert.ok(direction.x * nose.x + direction.y * nose.y + direction.z * nose.z > .9999,
      'gun dispersion stays centered on the true nose even when legacy angles and pilot look differ');
    assert.ok(Math.hypot(direction.x - look.x, direction.y - look.y, direction.z - look.z) > .4);
    const bombs = [...game.projectiles.values()], bay = rotateVector(rotation, JET_BOMB_BAY.x, JET_BOMB_BAY.y, JET_BOMB_BAY.z);
    const trail = rotateVector(rotation, 0, 0, 4), eject = rotateVector(rotation, 0, -4, 0);
    assert.equal(bombs.length, CARPET_BOMB_COUNT);
    for (const [i, bomb] of bombs.entries()) {
      assert.equal(bomb.weapon, JET_BOMB.id);
      assert.ok(Math.hypot(bomb.x - pilot.state.px - bay.x - trail.x * i,
        bomb.y - pilot.state.py - bay.y - trail.y * i, bomb.z - pilot.state.pz - bay.z - trail.z * i) < 1e-9);
      assert.equal(bomb.vx, pilot.state.vx * .85 + eject.x);
      assert.equal(bomb.vy, pilot.state.vy + eject.y);
      assert.equal(bomb.vz, pilot.state.vz * .85 + eject.z);
    }
  }
});
