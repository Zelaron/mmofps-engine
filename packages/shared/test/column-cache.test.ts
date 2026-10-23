import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, type ColumnData } from '../src/worldgen.js';
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

const analyticColumn = (x: number, z: number): ColumnData => ({ h: x * 1.125 + z * 2.375,
  temp: .5, moist: .5, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 });

// Probe the cache directly: public simulation helpers deliberately bypass it
// for these injected generators because custom terrain can change in place.
function cachedHeight(world: World, x: number, z: number): number {
  return (world as unknown as { cachedColumn(x: number, z: number): ColumnData }).cachedColumn(x, z).h;
}

function cacheConflicts(): { a: number; b: number; c: number; other: number; z: number } {
  const world = new World(1337), z = 23.75;
  const slots = (world as unknown as { sdfColumns: (ColumnData | undefined)[] }).sdfColumns;
  assert.equal(slots.length, 32768);
  let generated: ColumnData;
  world.column = (x, z) => generated = analyticColumn(x, z);
  const buckets = new Map<number, number[]>();
  // Discover actual conflicts through stored object identity, rather than
  // duplicating the hash under test or relying on lucky natural samples.
  for (let i = 0; i <= slots.length; i++) {
    const x = i * .25 + .125;
    cachedHeight(world, x, z);
    const slot = slots.findIndex(entry => entry === generated!);
    assert.ok(slot >= 0);
    const bucket = slot >> 1, points = buckets.get(bucket) ?? [];
    points.push(x); buckets.set(bucket, points);
    if (points.length === 3 && buckets.size > 1) {
      const other = [...buckets].find(([key]) => key !== bucket)![1][0];
      return { a: points[0], b: points[1], c: points[2], other, z };
    }
  }
  throw new Error('Fixture did not find three competing coordinates');
}

test('two-way column buckets evict only a competing coordinate and preserve exact recomputed values', () => {
  const { a, b, c, other, z } = cacheConflicts(), world = new World(1337);
  let calls = 0;
  world.column = (x, z) => { calls++; return analyticColumn(x, z); };
  const check = (x: number) => assert.equal(cachedHeight(world, x, z), analyticColumn(x, z).h);
  check(a); check(b); check(other);
  assert.equal(calls, 3);
  check(a); check(b); check(other);
  assert.equal(calls, 3, 'both ways and unrelated buckets are reusable');
  check(c);
  assert.equal(calls, 4);
  check(b); check(other);
  assert.equal(calls, 4, 'one conflict cannot flush the other way or another bucket');
  check(a);
  assert.equal(calls, 5, 'the displaced coordinate is regenerated with identical values');
  check(c); check(other);
  assert.equal(calls, 5);
});

test('column storage remains bounded after more distinct queries than its full capacity',()=>{
  const world=new World(1337),slots=(world as unknown as {sdfColumns:(ColumnData|undefined)[]}).sdfColumns;
  let calls=0;world.column=(x,z)=>{calls++;return analyticColumn(x,z);};
  const count=slots.length+257;
  for(let pass=0;pass<2;pass++)for(let i=0;i<count;i++){
    const x=i*.123+.125,z=-i*.457-.375;
    assert.equal(cachedHeight(world,x,z),analyticColumn(x,z).h);
  }
  assert.ok(calls>count,'overflow must evict and recompute some exact coordinates');
  assert.equal(slots.length,32768);assert.ok(slots.filter(Boolean).length<=32768);
});

test('nested column generation cannot overwrite the outer hash key or another cached coordinate', () => {
  const { a, b, c, other, z } = cacheConflicts(), world = new World(1337);
  let calls = 0;
  world.column = (x, z) => {
    calls++;
    if (x === a) for (const nested of [b, c, other]) {
      assert.equal(cachedHeight(world, nested, z), analyticColumn(nested, z).h);
    }
    return analyticColumn(x, z);
  };
  assert.equal(cachedHeight(world, a, z), analyticColumn(a, z).h);
  assert.equal(calls, 4);
  for (const x of [a, c, other]) assert.equal(cachedHeight(world, x, z), analyticColumn(x, z).h);
  assert.equal(calls, 4, 'outer and surviving nested records remain in their own slots');
  assert.equal(cachedHeight(world, b, z), analyticColumn(b, z).h);
  assert.equal(calls, 5, 'outer insertion replaced only one conflicting nested record');
});

test('exact column keys retain distinct fractional coordinates, signed-zero aliases and invalid-query isolation', () => {
  const world = new World(1337);
  let calls = 0;
  world.column = (x, z) => { calls++; return { ...analyticColumn(x, z), h: x }; };
  assert.equal(cachedHeight(world, -0, 0), -0);
  assert.equal(cachedHeight(world, 0, -0), -0, 'zero aliases retain the first generated value, like numeric Map keys');
  assert.equal(calls, 1);
  for (const [x, z] of [[Number.MIN_VALUE, 0], [-Number.MIN_VALUE, 0], [Number.EPSILON, 0],
    [1.25, 2.5], [1.25 + Number.EPSILON, 2.5], [1.25, 2.5 + Number.EPSILON * 2],
    [2 ** 53, 0], [2 ** 53 + 2, 0], [NaN, 0], [Infinity, 0], [-Infinity, 0]]) {
    assert.equal(cachedHeight(world, x, z), x);
    assert.equal(cachedHeight(world, .375, -.625), .375, 'invalid or colliding keys cannot poison a finite sample');
  }
});

test('reusing a cache slot never mutates a previously returned column', () => {
  const { a, b, c, z } = cacheConflicts(), world = new World(1337);
  world.column = analyticColumn;
  const query = (x: number) => (world as unknown as { cachedColumn(x: number, z: number): ColumnData }).cachedColumn(x, z);
  const first = query(a), other = query(b), saved = structuredClone(first);
  query(c); // Reuses the first way's private storage.
  assert.deepEqual(first, saved);
  assert.equal(query(b), other);
  const regenerated = query(a);
  assert.notEqual(regenerated, first);
  assert.deepEqual(regenerated, first);
  query(c);
  assert.deepEqual(first, saved);
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
