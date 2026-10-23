import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, cavePathPoint } from '@shared/worldgen';
import { WORLD } from '@shared/constants';
import { capitalBoundary, CAPITAL_SKY_HEIGHT } from '@shared/capital-geometry';
import { transportPose } from '@shared/transport';
import { transitWorld } from '@shared/transit-motion';

test('height-only traces exactly retain city, cave, road and moving-transport ground heights on every native planet', () => {
  for (const seed of [1337, 7331, 20077]) {
    const world = new World(seed), cities = world.collectCities();
    const points = cities.flatMap(city => [{ x: city.x, z: city.z },
      { x: city.x + city.radius + .375, z: city.z + .125 }]);
    const cave = world.collectCaveSites(-640, 640, -640, 640)[0];
    assert.ok(cave);
    points.push(cavePathPoint(cave, 0), cavePathPoint(cave, cave.mouthLength + 5));
    const road = world.collectRoadSegments(-128, 128, -128, 128).find(r => !r.trail);
    assert.ok(road);
    points.push({ x: (road.a.x + road.b.x) / 2, z: (road.a.z + road.b.z) / 2 });
    const ferry = world.collectTransportPlan().routes.find(r => r.kind === 'ferry');
    assert.ok(ferry);
    const time = ferry.dwell + 20;
    points.push(transitWorld(transportPose(ferry, time), 0, 1.5, 0));
    world.motionTime = time;
    for (const { x, z } of points) {
      const city = cities.find(c => capitalBoundary(c, x, z) <= 0);
      const top = city?.theme ? CAPITAL_SKY_HEIGHT : WORLD.MAX_HEIGHT - 1;
      const full = world.trace(x, top, z, 0, -1, 0, top - WORLD.KILL_Y + 10);
      const heightOnly = world.trace(x, top, z, 0, -1, 0, top - WORLD.KILL_Y + 10, false);
      const { nx: _nx, ny: _ny, nz: _nz, ...expected } = full;
      const { nx: _x, ny: _y, nz: _z, ...actual } = heightOnly;
      assert.deepEqual(actual, expected, `seed ${seed}: hit changed at ${x},${z}`);
      assert.equal(world.groundY(x, z), full.hit ? full.y : 0);
    }
  }
});

test('groundY omits gradients while default traces retain normals, including solid-start hits', () => {
  const world = new World(7331), x = 28.123, z = 41.75;
  const y = world.groundY(x, z); // Warm geometry before observing only query work.
  const gradient = world.gradient.bind(world);
  let gradients = 0;
  world.gradient = (x, y, z, out) => { gradients++; gradient(x, y, z, out); };
  assert.equal(world.groundY(x, z), y);
  assert.equal(gradients, 0);
  const full = world.trace(x, y + 8, z, 0, -1, 0, 16);
  assert.equal(full.hit, true);
  assert.equal(gradients, 1);
  assert.ok(Math.abs(Math.hypot(full.nx, full.ny, full.nz) - 1) < 1e-12);
  gradients = 0;
  const inside = world.trace(x, y - .1, z, 0, -1, 0, 5);
  assert.equal(inside.hit, true); assert.equal(inside.dist, 0);
  assert.equal(gradients, 1);
  gradients = 0;
  const quiet = world.trace(x, y - .1, z, 0, -1, 0, 5, false);
  assert.equal(quiet.hit, true); assert.equal(quiet.dist, 0);
  assert.equal(quiet.y, inside.y); assert.equal(gradients, 0);
});

test('groundY still invokes public trace overrides with unchanged ray bounds and miss handling', () => {
  const world = new World(1337), x = 13.25, z = -24.5;
  let calls = 0;
  world.trace = (ox, oy, oz, dx, dy, dz, maxDist, computeNormal) => {
    calls++;
    assert.deepEqual([ox, oy, oz, dx, dy, dz, maxDist, computeNormal],
      [x, WORLD.MAX_HEIGHT - 1, z, 0, -1, 0, WORLD.MAX_HEIGHT - 1 - WORLD.KILL_Y + 10, false]);
    return { hit: calls === 1, x, y: 123.456789, z, dist: 1, nx: 0, ny: 1, nz: 0 };
  };
  assert.equal(world.groundY(x, z), 123.456789);
  assert.equal(world.groundY(x, z), 0);
  assert.equal(calls, 2);
});
