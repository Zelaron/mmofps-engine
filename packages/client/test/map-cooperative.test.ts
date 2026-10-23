import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { Landscape, type RoadSegment } from '@shared/landscape';
import type { TransportPlan } from '@shared/transport';
import { worldMapSvg, worldMapSvgSteps, roadMapPaths, roadMapPathSteps } from '../src/world-map.js';

const bounds = [-9000, 9000, -9000, 9000] as const;
function drain<T>(steps: Generator<void, T, void>): { value: T; checkpoints: number } {
  let checkpoints = 0;
  for (;;) { const next = steps.next(); if (next.done) return { value: next.value, checkpoints }; checkpoints++; }
}
const landscape = (world: World) => (world as unknown as { landscape: Landscape }).landscape;
function cacheOrder(world: World): unknown {
  const source = landscape(world) as unknown as Record<string, Map<unknown, unknown>>;
  return Object.fromEntries(['mountains', 'nodes', 'edges', 'trails', 'tiles'].map(key => [key, [...source[key].keys()]]));
}
function replacing(object: object, key: string, value: unknown, run: () => void): void {
  const previous = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, writable: true, value });
  try { run(); } finally { if (previous) Object.defineProperty(object, key, previous); else Reflect.deleteProperty(object, key); }
}

test('cooperative planet maps preserve every SVG byte, ordered roads and subsequent terrain caches', () => {
  for (const seed of [1337, 7331, 20077]) {
    const source = new World(seed); source.collectTransportPlan(); const snapshot = source.transportSnapshot();
    assert(snapshot);
    const ordinary = new World(seed, snapshot), stepped = new World(seed, snapshot);
    const expected = worldMapSvg(ordinary, ordinary.collectTransportPlan());
    const actual = drain(worldMapSvgSteps(stepped, stepped.collectTransportPlan()));
    assert.equal(actual.value, expected, `${seed}: complete SVG equality`);
    assert(actual.checkpoints > 100, 'cold world-road generation has individual edge checkpoints');
    assert.deepEqual(cacheOrder(stepped), cacheOrder(ordinary), 'yielding retains canonical cache insertion order');
    const roads = drain(stepped.collectMajorRoadSegmentSteps(...bounds));
    assert.deepEqual(roads.value, ordinary.collectMajorRoadSegments(...bounds));
    for (const tolerance of [6, 65])
      assert.deepEqual(drain(roadMapPathSteps(roads.value, tolerance)).value, roadMapPaths(roads.value, tolerance));
    for (const [x, z] of [[-1775, 3709], [-1280, 2078], [-2830, 2093], [5335, 850], [0, 0]])
      assert.deepEqual(stepped.column(x, z), ordinary.column(x, z));
  }
});

const custom: RoadSegment[] = [
  { id: 'continuous', a: { x: 0, y: 20, z: 0 }, b: { x: 20, y: 20, z: 30 }, width: 8, trail: false },
  { id: 'trail', a: { x: 20, y: 20, z: 30 }, b: { x: 50, y: 20, z: 70 }, width: 2, trail: true },
  { id: 'continuous', a: { x: 20, y: 20, z: 30 }, b: { x: 60, y: 20, z: 0 }, width: 8, trail: false },
];
test('cooperative collectors retain injected providers, ordering and single synchronous fallback', () => {
  for (const prototype of [false, true]) for (const kind of ['world-major', 'world-all', 'landscape-major', 'landscape-all', 'trail', 'edge', 'urban']) {
    const world = new World(1337), source = landscape(world); let calls = 0;
    const worldProvider = kind.startsWith('world-');
    const object = worldProvider ? prototype ? World.prototype : world : prototype ? Landscape.prototype : source;
    const key = kind === 'world-major' ? 'collectMajorRoadSegments' : kind === 'world-all' ? 'collectRoadSegments' :
      kind === 'landscape-major' ? 'collectMajorRoads' : kind === 'landscape-all' ? 'collectRoads' : kind === 'urban' ? 'urbanRoads' : kind;
    replacing(source, 'cities', () => [], () => replacing(object, key, () => { calls++; return custom; }, () => {
      const expected = world.collectMajorRoadSegments(0, 0, 0, 0), expectedCalls = calls; calls = 0;
      const actual = drain(world.collectMajorRoadSegmentSteps(0, 0, 0, 0));
      assert.deepEqual(actual.value, expected, `${prototype}/${kind}`);
      assert.equal(calls, expectedCalls, 'fallback neither repeats nor bypasses provider calls');
      assert.equal(actual.checkpoints, 0, 'injected providers retain their synchronous behavior');
      assert.equal(actual.value[0], expected[0], 'provider segment identities are retained');
    }));
  }
});

test('cancelled maps never publish partial artwork and legacy worlds retain the public collector', () => {
  const plan = { routes: [] } as unknown as TransportPlan;
  let roads = custom, calls = 0;
  const legacy = { seed: 1337, collectCities: () => [], collectRoadSegments: () => { calls++; return roads; } } as unknown as World;
  const incomplete = worldMapSvgSteps(legacy, plan);
  for (let i = 0; i < 12; i++) assert.equal(incomplete.next().done, false);
  assert.equal(calls, 1, 'cancellation occurs after road collection, before SVG publication');
  incomplete.return('cancelled'); roads = [custom[2]];
  const actual = drain(worldMapSvgSteps(legacy, plan));
  const fresh = { seed: 1337, collectCities: () => [], collectRoadSegments: () => roads } as unknown as World;
  assert.equal(actual.value, worldMapSvg(fresh, plan)); assert.equal(calls, 2);
  assert.equal(drain(worldMapSvgSteps(legacy, plan)).checkpoints, 0, 'only completed artwork is memoized');
  const world = new World(1337);
  replacing(world, 'collectMajorRoadSegments', undefined, () => replacing(world, 'collectRoadSegments', () => custom, () =>
    assert.deepEqual(drain(world.collectMajorRoadSegmentSteps(...bounds)).value, custom.filter(road => !road.trail))));
});
