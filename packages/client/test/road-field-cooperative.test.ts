import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { Landscape, type RoadSegment } from '@shared/landscape';
import { RoadField, rasterRoadSegment, type RoadGrid } from '../src/render/road-field.js';

function drain<T>(iterator: Generator<void, T, void>): { value: T; yields: number } {
  let yields = 0;
  for (;;) { const next = iterator.next(); if (next.done) return { value: next.value, yields }; yields++; }
}
const source = (world: World) => (world as unknown as { landscape: Landscape }).landscape;
function cacheOrder(world: World): unknown {
  const landscape = source(world) as unknown as Record<string, Map<unknown, unknown>>;
  return Object.fromEntries(['mountains', 'nodes', 'edges', 'trails', 'tiles'].map(key => [key, [...landscape[key].keys()]]));
}
function replace(object: object, key: string, value: unknown, run: () => void): void {
  const old = Object.getOwnPropertyDescriptor(object, key);
  Object.defineProperty(object, key, { configurable: true, writable: true, value });
  try { run(); } finally { if (old) Object.defineProperty(object, key, old); else Reflect.deleteProperty(object, key); }
}
const roads: RoadSegment[] = [
  { id: 'first', a: { x: -20, y: 21, z: 0 }, b: { x: 30, y: 21, z: 0 }, width: 6, trail: true },
  { id: 'second', a: { x: -20, y: 34, z: 0 }, b: { x: 30, y: 34, z: 0 }, width: 6, trail: false },
];

test('full cooperative roads retain native trails, exact order and canonical cache insertion', () => {
  const ordinary = new World(1337), stepped = new World(1337);
  let hasTrail = false;
  for (const bounds of [[-1024, 1024, 7680, 9728], [-6144, 6144, 1536, 13824]] as const) {
    const expected = ordinary.collectRoadSegments(bounds[0], bounds[1], bounds[2], bounds[3]);
    const actual = drain(stepped.collectRoadSegmentSteps(bounds[0], bounds[1], bounds[2], bounds[3]));
    assert(actual.yields > 20);
    assert.deepEqual(actual.value, expected);
    assert.deepEqual(cacheOrder(stepped), cacheOrder(ordinary));
    hasTrail ||= expected.some(road => road.trail);
  }
  assert(hasTrail, 'the actual texture areas contain summit trails');
});

test('full cooperative roads preserve instance and prototype provider fallbacks', () => {
  for (const prototype of [false, true]) for (const kind of ['world', 'landscape', 'edge', 'trail', 'urbanRoads']) {
    const run = (stepped: boolean) => {
      const world = new World(1337), landscape = source(world);
      const target = kind === 'world' ? prototype ? World.prototype : world : prototype ? Landscape.prototype : landscape;
      const key = kind === 'world' ? 'collectRoadSegments' : kind === 'landscape' ? 'collectRoads' : kind;
      let calls = 0, result: { value: RoadSegment[]; yields: number } | undefined;
      replace(landscape, 'cities', () => [], () => replace(target, key, () => { calls++; return roads; }, () => {
        result = stepped ? drain(world.collectRoadSegmentSteps(0, 0, 0, 0))
          : { value: world.collectRoadSegments(0, 0, 0, 0), yields: 0 };
      }));
      return { ...result!, calls };
    };
    const expected = run(false), actual = run(true);
    assert.deepEqual(actual.value, expected.value);
    assert.equal(actual.yields, 0, `${prototype}/${kind}: custom collection stays synchronous`);
    assert.equal(actual.calls, expected.calls, 'both providers start with cold caches');
    assert(actual.value.includes(roads[0]), 'injected segment identity survives collection');
  }
});

test('road maps share collection/raster budgets, finish old requests, and close suspended work', () => {
  let clock = 0, nextCalls = 0, closed = 0;
  const requests: number[][] = [];
  const world = {
    collectRoadSegments: () => { throw new Error('stepped provider must be used'); },
    *collectRoadSegmentSteps(...bounds: number[]): Generator<void, RoadSegment[], void> {
      requests.push(bounds);
      try { for (let i = 0; i < 3; i++) { nextCalls++; clock += 2; yield; } return roads; }
      finally { closed++; }
    },
  };
  const field = new RoadField(world);
  replace(performance, 'now', () => clock, () => {
    try {
      const initial = [field.uniforms.roadNearMap.value, field.uniforms.roadFarMap.value];
      field.update(0, 0);
      assert.equal(nextCalls, 2, 'one over-budget indivisible collection step per layer');
      assert.equal(field.uniforms.roadNearMap.value, initial[0]);
      assert.equal(field.uniforms.roadFarMap.value, initial[1]);
      for (let i = 0; i < 3; i++) field.update(6000, 6000);
      assert.equal(requests.length, 2, 'movement does not restart unfinished collection');
      assert.equal(field.uniforms.roadNearBounds.value.x, -1024);
      assert.equal(field.uniforms.roadFarBounds.value.x, -6144);
      const ready = [field.uniforms.roadNearMap.value, field.uniforms.roadFarMap.value];
      field.update(6000, 6000);
      assert.equal(requests.length, 4);
      assert.equal(field.uniforms.roadNearMap.value, ready[0]);
      assert.equal(field.uniforms.roadFarMap.value, ready[1]);
      field.dispose();
      assert.equal(closed, 4, 'both completed and suspended generators reach their finally block');
      const callsAtDispose = nextCalls;
      field.update(0, 0);
      assert.equal(nextCalls, callsAtDispose);
    } finally { field.dispose(); }
  });
});

test('legacy road providers keep exact raster tie order and trail channel values', () => {
  let calls = 0;
  const field = new RoadField({ collectRoadSegments: () => { calls++; return roads; } });
  replace(performance, 'now', () => 0, () => {
    try {
      field.update(0, 0);
      assert.equal(calls, 2);
      for (const [prefix, grid] of [
        ['roadNear', { x: -1024, z: -1024, size: 1024, step: 2 }],
        ['roadFar', { x: -6144, z: -6144, size: 2048, step: 6 }],
      ] as const) {
        const expected = new Uint8Array(grid.size * grid.size * 4); expected.fill(255);
        for (const road of roads) rasterRoadSegment(expected, grid as RoadGrid, road);
        const actual = field.uniforms[`${prefix}Map`].value.image.data;
        assert.equal(Buffer.compare(Buffer.from(actual as Uint8Array), Buffer.from(expected)), 0);
        assert(expected.some((byte, index) => index % 4 === 3 && byte === 255));
      }
    } finally { field.dispose(); }
  });
});
