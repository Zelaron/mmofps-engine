import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONDOR_CARPET, VEHICLE, VEHICLE_VARIANT, createMoveState, jetBombBay, vehicleLocalOffset } from '@shared/index';
import { bombImpactPoint } from '../src/bomb-sight.js';

const flying = (height: number) => Object.assign(createMoveState(100, height, -40), {
  vehicle: VEHICLE.JET, vehicleVariant: VEHICLE_VARIANT.CONDOR, heading: .6, vehiclePitch: .05, vehicleRoll: 0, vx: -40, vy: 3, vz: -60, grounded: false });

test('the bomb marker lands where a falling carpet bomb does', () => {
  for (const height of [120, 400, 900]) {
    const s = flying(height), mark = { x: 0, y: 0, z: 0 }, ground = 12;
    assert.equal(bombImpactPoint({ groundY: () => ground }, s, { set(x, y, z) { Object.assign(mark, { x, y, z }); } }), true);
    // The server's own fall: launched like the carpet and stepped at the tick rate.
    const bay = jetBombBay(s.vehicleVariant), release = vehicleLocalOffset(s, bay.x, bay.y, bay.z), eject = vehicleLocalOffset(s, 0, -4, 0);
    let x = s.px + release.x, y = s.py + release.y, z = s.pz + release.z, vy = Math.min(0, s.vy) + eject.y;
    const vx = s.vx * .85 + eject.x, vz = s.vz * .85 + eject.z, dt = 1 / 60;
    while (y > ground) { vy -= CONDOR_CARPET.gravity! * dt; x += vx * dt; y += vy * dt; z += vz * dt; }
    assert.ok(Math.hypot(x - mark.x, z - mark.z) < 4, `within a bomb's blast of the marker at ${height} m (${Math.hypot(x - mark.x, z - mark.z).toFixed(1)} m off)`);
    assert.equal(mark.y, ground);
  }
});

test('the bomb marker follows the ground it lands on and gives up at ground level', () => {
  const s = flying(300), marks: number[] = [];
  bombImpactPoint({ groundY: (_x, z) => z < -200 ? 120 : 0 }, s, { set(_x, y) { marks.push(y); } });
  assert.deepEqual(marks, [120], 'settles on the higher ground it actually reaches');
  assert.equal(bombImpactPoint({ groundY: () => 900 }, s, { set() {} }), false);
});
