import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { Landscape, type RoadSegment } from '@shared/landscape';
import type { TransportPlan } from '@shared/transport';
import { worldMapSvg, roadMapPaths } from '../src/world-map.js';

const fullBounds = [-9000, 9000, -9000, 9000] as const;
const bounds: readonly (readonly [number, number, number, number])[] = [fullBounds, [-1024, 0, -2048, -1024], [0, 1024, 0, 1024],
  [-.0000001, .0000001, -1024.0000001, -1023.9999999], [-9000, -8750, 8700, 9000]] as const;
const landscape = (world: World) => (world as unknown as { landscape: Landscape }).landscape;

test('major-road collection preserves complete planet maps, road order and ordinary terrain trails', () => {
  for (const seed of [1337, 7331, 20077]) {
    const ordinary = new World(seed), optimized = new World(seed);
    // Exercise the pre-optimization map path independently, including its
    // cold generation order and full public road/trail collector.
    Object.defineProperty(ordinary, 'collectMajorRoadSegments', { value: undefined });
    const before = worldMapSvg(ordinary, ordinary.collectTransportPlan());
    const after = worldMapSvg(optimized, optimized.collectTransportPlan());
    assert.equal(after, before, `${seed}: every SVG byte remains identical`);
    for (const box of bounds) {
      const expected = ordinary.collectRoadSegments(...box).filter(road => !road.trail);
      const actual = optimized.collectMajorRoadSegments(...box);
      assert.deepEqual(actual, expected, `${seed}: full segment data and canonical ordering`);
      for (const tolerance of [6, 65]) assert.deepEqual(roadMapPaths(actual, tolerance), roadMapPaths(expected, tolerance));
    }
    const ordinaryRoads = ordinary.collectRoadSegments(...fullBounds);
    const subsequentRoads = optimized.collectRoadSegments(...fullBounds);
    assert.ok(ordinaryRoads.some(road => road.trail), 'the fixture includes summit trails');
    assert.deepEqual(subsequentRoads, ordinaryRoads, 'map generation must not change later all-road terrain queries');
    for (const [x, z] of [[-1775, 3709], [-1280, 2078], [-2830, 2093], [5335, 850], [0, 0]])
      assert.deepEqual(optimized.column(x, z), ordinary.column(x, z), 'later terrain columns remain exact');
  }
});

const point = (x: number, z: number) => ({ x, y: 20, z });
const custom: RoadSegment[] = [
  { id: 'custom-major', a: point(0, 0), b: point(20, 30), width: 8, trail: false },
  { id: 'custom-trail', a: point(20, 30), b: point(50, 70), width: 2, trail: true },
];
function replacing(object: object, key: string, value: unknown, run: () => void): void {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, writable: true, value });
  try { run(); }
  finally { if (descriptor) Object.defineProperty(object, key, descriptor); else Reflect.deleteProperty(object, key); }
}

test('major-road collection respects instance and prototype road collector overrides', () => {
  for (const kind of ['world-instance', 'world-prototype', 'landscape-instance', 'landscape-prototype']) {
    const world = new World(1337); let calls = 0;
    const object = kind === 'world-instance' ? world : kind === 'world-prototype' ? World.prototype :
      kind === 'landscape-instance' ? landscape(world) : Landscape.prototype;
    replacing(object, kind.startsWith('world-') ? 'collectRoadSegments' : 'collectRoads', (...box: number[]) => {
      calls++; assert.deepEqual(box, [1, 2, 3, 4]); return custom;
    }, () => {
      const result = world.collectMajorRoadSegments(1, 2, 3, 4);
      assert.deepEqual(result, [custom[0]], kind);
      assert.equal(result[0], custom[0], 'fallback retains the provider objects');
      assert.equal(calls, 1, 'fallback calls the replaced collector once');
    });
  }
});

test('custom nested trail collectors may contribute major roads and retain the canonical fallback', () => {
  for (const prototype of [false, true]) {
    const world = new World(1337); let calls = 0;
    replacing(prototype ? Landscape.prototype : landscape(world), 'trail', () => { calls++; return custom; }, () => {
      const expected = world.collectRoadSegments(0, 0, 0, 0).filter(road => !road.trail), before = calls;
      assert.deepEqual(world.collectMajorRoadSegments(0, 0, 0, 0), expected);
      assert.ok(expected.some(road => road.id === custom[0].id), 'the overridden trail provider contributes visible road data');
      assert.ok(calls > before, 'custom trail generation is not bypassed');
    });
  }
});

test('nested edge and urban-road providers cannot reintroduce trails or split major-road map chains', () => {
  const world = new World(1337), source = landscape(world);
  const pieces: RoadSegment[] = [
    { id: 'continuous', a: point(0, 0), b: point(20, 30), width: 8, trail: false },
    { id: 'injected-trail', a: point(20, 30), b: point(50, 70), width: 2, trail: true },
    { id: 'continuous', a: point(20, 30), b: point(60, 0), width: 8, trail: false },
  ];
  replacing(source, 'cities', () => [], () => {
    for (const provider of ['edge', 'urbanRoads']) replacing(source, provider, () => pieces, () => {
      const expected = world.collectRoadSegments(0, 0, 0, 0).filter(road => !road.trail);
      const actual = world.collectMajorRoadSegments(0, 0, 0, 0);
      assert.ok(expected.some(road => road.id === 'continuous'), `${provider}: overridden geometry is present`);
      assert.deepEqual(actual, expected, `${provider}: filtering retains exact major-road order and data`);
      assert.deepEqual(roadMapPaths(actual, 65), roadMapPaths(expected, 65),
        `${provider}: discarded trails cannot break a continuous map chain`);
    });
  });
});

test('legacy map worlds without a major-road API retain the exact filtered public collector', () => {
  const legacy = { seed: 1337, collectCities: () => [], collectRoadSegments: () => custom };
  const plan = { routes: [] } as unknown as TransportPlan;
  const specialized = { ...legacy, collectMajorRoadSegments: () => [custom[0]] };
  assert.equal(worldMapSvg(legacy as unknown as World, plan), worldMapSvg(specialized as unknown as World, plan));
});
