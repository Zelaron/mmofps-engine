import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { World } from '@shared/worldgen';
import type { TransportPlan } from '@shared/transport';
import { worldMapOverviewSvg } from '../src/world-map.js';
import { WorldMapStream, type WorldMapRequest, type WorldMapResult, type WorldMapWorker } from '../src/world-map-stream.js';

class FakeWorker implements WorldMapWorker {
  onmessage: WorldMapWorker['onmessage'] = null;
  onerror: WorldMapWorker['onerror'] = null;
  onmessageerror: WorldMapWorker['onmessageerror'] = null;
  requests: WorldMapRequest[] = [];
  stopped = false;
  postMessage(message: WorldMapRequest): void { this.requests.push(message); }
  terminate(): void { this.stopped = true; }
  receive(seed: number, svg: string): void { this.onmessage?.({ data: { type: 'map', seed, svg } } as MessageEvent<WorldMapResult>); }
}

test('immediate map overview includes geography without terrain columns or world roads', () => {
  const world = { seed: 1337, collectCities: () => [{ x: 0, z: 0, radius: 100, theme: 'aurelia' }],
    column: () => { throw new Error('main thread must not sample terrain'); },
    collectRoadSegments: () => { throw new Error('main thread must not generate world roads'); } } as unknown as World;
  const svg = worldMapOverviewSvg(world, { routes: [{ kind: 'train', legs: [{ points: [{ x: 0, z: 0 }, { x: 100, z: 100 }] }] }] } as TransportPlan);
  assert.match(svg, /Tactical map: coast, cities and transport routes/);
  assert.match(svg, /607b80/); assert.match(svg, /a89b73/); assert.match(svg, /53666a/);
  assert.doesNotMatch(svg, /class="terrain-contours"/);
  assert.doesNotMatch(svg, /<filter|feGaussianBlur/);
});

test('one deferred map worker publishes identical detail to atlas and minimap, then stops', () => {
  const worker = new FakeWorker(), atlas: string[] = [], minimap: string[] = [];
  let constructions = 0;
  const stream = new WorldMapStream(1337, '<svg>overview</svg>', () => { constructions++; return worker; });
  stream.subscribe(svg => atlas.push(svg)); stream.subscribe(svg => minimap.push(svg));
  assert.equal(constructions, 0); assert.equal(stream.stats.started, false);
  stream.start(); stream.start();
  assert.equal(constructions, 1); assert.deepEqual(worker.requests, [{ type: 'map', seed: 1337 }]);
  worker.receive(7331, '<svg>wrong planet</svg>'); assert.equal(stream.stats.ready, false);
  worker.receive(1337, '<svg>terrain detail</svg>');
  assert.deepEqual(atlas, ['<svg>overview</svg>', '<svg>terrain detail</svg>']); assert.deepEqual(minimap, atlas);
  assert.equal(stream.stats.ready, true); assert.equal(worker.stopped, true);
  let late = ''; stream.subscribe(svg => { late = svg; }); assert.equal(late, '<svg>terrain detail</svg>');
  stream.dispose();
});

test('reconnect disposal rejects a stale map result and unsubscription stops updates', () => {
  const worker = new FakeWorker(), received: string[] = [];
  const stream = new WorldMapStream(1, 'overview', () => worker);
  const unsubscribe = stream.subscribe(svg => received.push(svg)); stream.start();
  const stale = worker.onmessage!; unsubscribe(); stream.dispose();
  stale({ data: { type: 'map', seed: 1, svg: 'stale' } } as MessageEvent<WorldMapResult>);
  assert.deepEqual(received, ['overview']); assert.equal(worker.stopped, true); assert.equal(stream.stats.ready, false);
});

test('unavailable or failed map workers retain the usable overview without synchronous generation', () => {
  const absent = new WorldMapStream(1, 'coast and routes', () => { throw new Error('unavailable'); });
  absent.start(); assert.equal(absent.stats.failed, true);
  let retained = ''; absent.subscribe(svg => { retained = svg; }); assert.equal(retained, 'coast and routes'); absent.dispose();
  const worker = new FakeWorker(), failed = new WorldMapStream(1, 'coast and routes', () => worker);
  failed.start(); worker.onmessageerror?.({} as MessageEvent<unknown>);
  assert.equal(failed.stats.failed, true); assert.equal(worker.stopped, true); assert.equal(failed.stats.ready, false);
  failed.dispose();
});

test('only local map streams request pacing, and a paced timeout retains the overview and stale fence', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'location');
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'location', previous); else Reflect.deleteProperty(globalThis, 'location');
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const hostname of ['localhost', '127.0.0.1', '[::1]', 'game.example']) {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname } });
    const worker = new FakeWorker(), updates: string[] = [];
    const stream = new WorldMapStream(1337, 'overview', () => worker);
    stream.subscribe(svg => updates.push(svg)); stream.start();
    assert.equal(worker.requests[0].cooperative, hostname === 'game.example' ? undefined : true);
    const stale = worker.onmessage!;
    t.mock.timers.tick(45_000);
    assert.equal(worker.stopped, true); assert.equal(stream.stats.failed, true); assert.equal(stream.stats.ready, false);
    stale({ data: { type: 'map', seed: 1337, svg: 'late detail', paced: true } } as MessageEvent<WorldMapResult>);
    assert.deepEqual(updates, ['overview']); stream.dispose();
  }
});
