import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/worldgen.js';
import { cavePathPoint } from '../src/caves.js';
import { transportPose } from '../src/transport.js';
import { transitWorld } from '../src/transit-motion.js';

function countColumns(world: World) {
  let calls = 0;
  const column = world.column.bind(world);
  world.column = (x, z) => { calls++; return column(x, z); };
  return () => calls;
}

test('vertical collision probes reuse exact columns without changing public column ownership', () => {
  const world = new World(1337), x = 24.123456789, z = 17.987654321;
  const fresh = world.column(x, z);
  world.regionAt(x, z); // Exclude one-time vegetation/structure generation.
  const calls = countColumns(world);
  for (let y = fresh.h - 4; y < fresh.h + 8; y += .12) world.sdf(x, y, z);
  assert.equal(calls(), 1, 'a vertical contact sweep only needs one terrain column');

  // Values below any practical quantization step must remain distinct keys.
  world.sdf(x + 1e-10, fresh.h + .2, z);
  world.sdf(x, fresh.h + .2, z + 1e-10);
  assert.equal(calls(), 3);

  const publicColumn = world.column(x, z);
  assert.notEqual(publicColumn, fresh);
  publicColumn.h += 500;
  const expected = world.sdfCol(x, fresh.h + .3, z, fresh, world.regionAt(x, z));
  assert.equal(world.sdf(x, fresh.h + .3, z), expected, 'callers cannot mutate a cached collision column');
  assert.equal(world.column(x, z).h, fresh.h, 'public column calls remain fresh');
});

test('the 512-entry FIFO evicts one column without dropping the other hot columns', () => {
  const world = new World(1337);
  world.regionAt(.125, 23.75); world.regionAt(999.125, 23.75);
  const calls = countColumns(world);
  for (let i = 0; i < 512; i++) world.sdf(i * .01 + .125, 200, 23.75);
  assert.equal(calls(), 512);
  world.sdf(.125, 201, 23.75); // Hits do not change FIFO insertion order.
  world.sdf(999.125, 201, 23.75);
  assert.equal(calls(), 513);
  for (let i = 1; i < 512; i++) world.sdf(i * .01 + .125, 202, 23.75);
  assert.equal(calls(), 513, 'capacity pressure must not clear the whole cache');
  world.sdf(.125, 203, 23.75);
  assert.equal(calls(), 514, 'only the oldest coordinate should have been evicted');
});

test('cached columns preserve the exact canonical field across cave, coast and capital heights', () => {
  for (const seed of [1, 1337]) {
    const world = new World(seed);
    const points = [{ x: 0, z: 0 }, { x: 450, z: 1250 }, { x: 9800, z: 700 }];
    for (const city of world.collectCities()) {
      points.push({ x: city.x, z: city.z }, { x: city.x + city.radius * .98, z: city.z });
    }
    const cave = world.collectCaveSites(-512, 512, -512, 512)[0];
    assert.ok(cave);
    points.push(cavePathPoint(cave, 0), cavePathPoint(cave, cave.mouthLength + 20));
    for (const { x, z } of points) {
      const column = world.column(x, z), region = world.regionAt(x, z);
      for (const y of [-125, -50, column.h - 3, column.h + .02, column.h + 1, column.h + 100]) {
        const expected = world.sdfCol(x, y, z, column, region);
        assert.equal(world.sdf(x, y, z), expected, `${seed}: ${x},${y},${z}`);
      }
    }
  }
});

test('cached static columns still evaluate moving transport solids at the current time', () => {
  const world = new World(1337), route = world.collectTransportPlan().routes.find(r => r.kind === 'ferry')!;
  const leg = route.legs[0];
  const i = leg.distances.findIndex((distance, j) => j > 0 && distance - leg.distances[j - 1] > 800);
  assert.ok(i > 0);
  const seconds = route.dwell + 1.5 + (leg.distances[i - 1] + 300) / route.speed;
  const pose = transportPose(route, seconds), p = transitWorld(pose, 0, 1.5, 0);
  const column = world.column(p.x, p.z), region = world.regionAt(p.x, p.z), calls = countColumns(world);
  const staticDistance = world.sdf(p.x, p.y, p.z);
  assert.ok(staticDistance > 3);
  for (const time of [seconds, seconds + 30, undefined, seconds]) {
    world.motionTime = time;
    assert.equal(world.sdf(p.x, p.y, p.z), world.sdfCol(p.x, p.y, p.z, column, region));
    if (time === seconds) assert.ok(world.sdf(p.x, p.y, p.z) < 0, 'the ferry must appear at its live pose');
    if (time === undefined) assert.equal(world.sdf(p.x, p.y, p.z), staticDistance);
  }
  assert.equal(calls(), 1, 'moving solids must not force static column regeneration');
});

test('engineered city floors skip terrain generation while deep probes keep the canonical column', () => {
  for (const seed of [1337, 7331, 20077]) {
    const world = new World(seed);
    for (const city of world.collectCities().filter(c => c.theme !== 'vesper')) {
      const x = city.x + .12345, z = city.z + .54321;
      const column = world.column(x, z), region = world.regionAt(x, z);
      assert.equal(column.h, city.y, 'the fully graded surface has exactly the authored height');
      const calls = countColumns(world);
      for (const offset of [-4.8, -.4, 0, .42, 1.8, 200]) {
        const y = city.y + offset;
        assert.equal(world.sdf(x, y, z), world.sdfCol(x, y, z, column, region));
      }
      assert.equal(calls(), 0, 'near-surface collision needs no natural terrain columns');
      const deep = city.y - 12;
      assert.equal(world.sdf(x, deep, z), world.sdfCol(x, deep, z, column, region));
      assert.equal(calls(), 1, 'deep rock must retain its caves and bedrock data');
    }
  }
});

test('city field shortcut matches canonical terrain at borders, stations, caves and abyss floors', () => {
  for (const seed of [1337, 7331, 20077]) {
    const world = new World(seed), points: { x: number; z: number }[] = [];
    for (const city of world.collectCities()) {
      points.push(city);
      for (let i = 0; i < 24; i++) {
        const angle = i * 2.399963229728653, radius = city.radius * [.35, .85, .98, 1.03, 1.08][i % 5];
        points.push({ x: city.x + Math.cos(angle) * radius, z: city.z + Math.sin(angle) * radius });
      }
    }
    for (const station of world.collectTransportPlan().stations) {
      for (const dx of [0, 80, 160, 192]) points.push({ x: station.x + dx, z: station.z + 80 });
    }
    const cave = world.collectCaveSites(-512, 512, -512, 512)[0];
    assert.ok(cave);
    points.push(cavePathPoint(cave, -20), cavePathPoint(cave, 0), cavePathPoint(cave, cave.mouthLength + 20));
    for (const { x, z } of points) {
      const column = world.column(x, z), region = world.regionAt(x, z);
      // Query in both directions so a surface shortcut cannot poison the
      // next underground probe, or reuse the wrong height at an arrival hall.
      const heights = [column.h - 12, column.h - 4.8, column.h - .02, column.h + .42, column.h + 1, column.h + 100];
      for (const y of [...heights, ...heights.slice().reverse()]) {
        assert.equal(world.sdf(x, y, z), world.sdfCol(x, y, z, column, region), `${seed}: ${x},${y},${z}`);
      }
    }
  }
});

test('city field shortcut immediately reflects added and removed camp collision', () => {
  const world = new World(7331), city = world.collectCities()[0];
  const x = city.x + 17, z = city.z + 21, y = city.y + 200;
  const column = world.column(x, z), region = world.regionAt(x, z);
  const empty = world.sdf(x, y, z);
  assert.ok(empty > 3);
  world.outposts.add({ id: 1, owner: 1, faction: 0, type: 0, x, y, z, facing: 0 });
  assert.ok(world.sdf(x, y, z) < 0, 'the new floor must be solid on the next query');
  assert.equal(world.sdf(x, y, z), world.sdfCol(x, y, z, column, region));
  world.outposts.remove(1);
  assert.equal(world.sdf(x, y, z), empty, 'removal must not leave stale collision');
});
