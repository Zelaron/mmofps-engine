import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, vehicleDefinition, VEHICLE, VEHICLE_VARIANT } from '@shared/index';
import { cityParcelKind } from '@shared/cities';
import { vehicleCourseBlocked } from '../src/bot-vehicle-clearance.js';

test('bots distinguish a tank-sized arcade from a too-low passage for a siege hull', () => {
  const world = new World(1337), city = world.collectCities().find(c => !c.theme)!;
  let roof: { x: number; z: number } | undefined;
  for (let bx = -4; bx < 4 && !roof; bx++) for (let bz = -4; bz < 4 && !roof; bz++)
    if (cityParcelKind(city, bx, bz) === 'roof') roof = { x: city.x + (bx + .5) * 64, z: city.z + (bz + .5) * 64 };
  assert.ok(roof);
  const x = roof.x, y = city.y + .1, z = roof.z - 28;
  const tank = vehicleDefinition(VEHICLE.TANK)!, siege = vehicleDefinition(VEHICLE.TANK, VEHICLE_VARIANT.BASTION)!;
  assert.equal(world.trace(x, y + siege.radius, z, 0, 0, 1, 23).hit, false, 'the old centre ray sees an open arcade');
  assert.equal(vehicleCourseBlocked(world, x, y, z, Math.PI, tank.radius, 23), false,
    'standard tanks fit beneath the raised roof');
  assert.equal(vehicleCourseBlocked(world, x, y, z, Math.PI, siege.radius, 23), true,
    'oversized siege hulls must turn before their shoulders collide with the roof');
});

test('vehicle course probes see shoulder obstacles without rejecting ordinary uphill ground', () => {
  const world = new World(1337);
  let slope = false, traces = 0;
  world.trace = (x, y, z, dx, dy, dz, distance) => {
    traces++;
    const hit = slope || x > 1.5 && y > 1.5 && y < 3;
    return { hit, x: x + dx * 4, y, z: z + dz * 4, nx: 0, ny: slope ? .82 : 0, nz: -1, dist: hit ? 4 : distance };
  };
  assert.equal(vehicleCourseBlocked(world, 0, 0, 0, Math.PI, 1.9, 12), true,
    'a pier beside the pilot ray can still strike the hull shoulder');
  slope = true; traces = 0;
  assert.equal(vehicleCourseBlocked(world, 0, 0, 0, Math.PI, 1.9, 12), false);
  assert.equal(traces, 8, 'planning has a fixed trace budget regardless of look distance');
});

test('grazing navigation feelers remain bounded and detect a thin solid wall', () => {
  const world = new World(1337);
  let samples = 0, wall = false;
  // Positive near-zero CSG values are air, not a collision or a reason to
  // spend hundreds of samples on each short steering ray.
  world.sdf = x => { samples++; return wall ? Math.min(.02,Math.abs(x-8)-.08) : .02; };
  assert.equal(vehicleCourseBlocked(world,0,0,0,-Math.PI/2,1.9,12),false);
  assert.ok(samples<800,'eight clear grazing feelers have bounded work');
  wall=true;samples=0;
  assert.equal(vehicleCourseBlocked(world,0,0,0,-Math.PI/2,1.9,12),true);
  assert.ok(samples<100,'the sixteen-centimetre wall is found before the horizon');
});
