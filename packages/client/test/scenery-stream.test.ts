import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VEGETATION_KIND, type World, type RBox } from '@shared/index';
import { SceneryStream, type SceneryEndpoint, type SceneryQuery, type SceneryRequest,
  type SceneryResponse, type ScenerySource, type SceneryData, type SceneryKind } from '../src/render/scenery-stream.js';
import { ScenerySamples } from '../src/render/scenery-samples.js';
import { VegetationRenderer } from '../src/render/vegetation.js';
import { StructureRenderer } from '../src/render/structures.js';
import { RockRenderer } from '../src/render/rocks.js';

class Endpoint implements SceneryEndpoint {
  onmessage: SceneryEndpoint['onmessage'] = null;
  onerror: SceneryEndpoint['onerror'] = null;
  onmessageerror: SceneryEndpoint['onmessageerror'] = null;
  messages: SceneryRequest[] = [];
  terminated = false;
  postMessage(message: SceneryRequest) { this.messages.push(message); }
  terminate() { this.terminated = true; }
  get last() { return this.messages.at(-1) as SceneryQuery; }
  reply(query = this.last, workMs?: number, paced?: boolean) {
    this.onmessage?.(new MessageEvent<SceneryResponse>('message', {
      data: { type: 'result', id: query.id, kind: query.kind, data: [], workMs, paced },
    }));
  }
}
const bounds = (x: number) => ({ minX: x, maxX: x + 64, minZ: 0, maxZ: 64 });

test('deferred scenery retains latest queries until terrain releases startup, then completes all pools', () => {
  let creations = 0;
  const endpoint = new Endpoint(), stream = new SceneryStream(1337, () => { creations++; return endpoint; }, true);
  try {
    stream.read('vegetation', bounds(0)); stream.read('vegetation', bounds(640));
    stream.read('structures', bounds(640)); stream.read('rocks', bounds(640));
    assert.equal(creations, 0, 'even worker compilation waits for terrain');
    assert.equal(stream.failed, false, 'deferred work must never trigger foreground fallback');
    assert.equal(stream.stats.pending, 3);
    assert.equal(stream.initialReady, false);
    stream.start(); stream.start();
    assert.equal(creations, 1);
    assert.deepEqual(endpoint.last.bounds, bounds(640));
    endpoint.reply(); endpoint.reply();
    assert.equal(stream.initialReady, false);
    endpoint.reply();
    assert.equal(stream.initialReady, true);
    assert.equal(stream.stats.ready, 3);
  } finally { stream.dispose(); }
  const discarded = new SceneryStream(1337, () => { throw new Error('must not start disposed stream'); }, true);
  discarded.dispose(); discarded.start();
  assert.equal(discarded.failed, false);
});

test('local scenery rest gates reads and callbacks, dispatches latest travel, and cancels on disposal', (t) => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });
  t.after(() => {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const endpoint = new Endpoint(), stream = new SceneryStream(1337, () => endpoint);
  try {
    stream.read('rocks', bounds(0));
    stream.read('vegetation', bounds(0));
    now = 1100; endpoint.reply(endpoint.last, 100);
    assert.equal(endpoint.messages.length, 2, 'completion cannot bypass the rest');
    for (let x = 64; x <= 640; x += 64) stream.read('vegetation', bounds(x));
    assert.equal(endpoint.messages.length, 2, 'frame reads cannot bypass the rest');
    now = 1399; t.mock.timers.tick(299);
    assert.equal(endpoint.messages.length, 2);
    now = 1400; t.mock.timers.tick(1);
    assert.equal(endpoint.messages.length, 3);
    assert.deepEqual(endpoint.last.bounds, bounds(640), 'the latest request is selected after waiting');
    stream.read('structures', bounds(0));
    endpoint.reply(endpoint.last, 1000);
    now = 2149; t.mock.timers.tick(749);
    assert.equal(endpoint.messages.length, 3);
    now = 2150; t.mock.timers.tick(1);
    assert.equal(endpoint.messages.length, 4, 'even a cold expensive job rests at most750ms');
    stream.read('rocks', bounds(64)); endpoint.reply(endpoint.last, 100);
    stream.dispose(); now = 3000; t.mock.timers.tick(850);
    assert.equal(endpoint.messages.length, 4, 'disposing cancels a pending wake');
    assert.ok(endpoint.terminated);
  } finally { stream.dispose(); }
});

test('scenery coalesces travel, ignores stale replies and services other pools fairly', () => {
  const endpoint = new Endpoint(), stream = new SceneryStream(1337, () => endpoint);
  try {
    assert.deepEqual(endpoint.messages, [{ type: 'init', seed: 1337 }]);
    stream.read('vegetation', bounds(0)); const obsolete = endpoint.last;
    stream.read('structures', bounds(0)); stream.read('rocks', bounds(0));
    for (let x = 64; x <= 6400; x += 64) stream.read('vegetation', bounds(x));
    assert.equal(endpoint.messages.length, 2, 'only one expensive query is in flight');
    assert.equal(stream.stats.pending, 3, 'travel retains only the latest request per pool');
    endpoint.reply(obsolete);
    assert.equal(endpoint.last.kind, 'structures', 'a changing vegetation request cannot starve structures');
    endpoint.reply(); assert.equal(endpoint.last.kind, 'rocks');
    endpoint.reply(); assert.equal(endpoint.last.kind, 'vegetation');
    assert.deepEqual(endpoint.last.bounds, bounds(6400));
    endpoint.reply(obsolete); assert.equal(stream.stats.pending, 1, 'a duplicate reply cannot free a newer query');
    endpoint.reply();
    assert.deepEqual(stream.read('vegetation', bounds(6400)), []);
    assert.deepEqual(stream.stats, { worker: true, failed: false, pending: 0, ready: 3 });
  } finally { stream.dispose(); }
  assert.ok(endpoint.terminated);
  endpoint.reply(); assert.equal(stream.read('vegetation', bounds(6400)), null);
});

test('local scenery enables cooperative work and accepts already-paced completion without a second rest', (t) => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });
  t.after(() => {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  });
  const endpoint = new Endpoint(), stream = new SceneryStream(1337, () => endpoint);
  try {
    assert.deepEqual(endpoint.messages[0], { type: 'init', seed: 1337, cooperative: true });
    stream.read('vegetation', bounds(0)); const old = endpoint.last;
    stream.read('vegetation', bounds(640)); stream.read('rocks', bounds(640));
    endpoint.reply(old, 100, true);
    assert.equal(endpoint.messages.length, 3, 'a worker-paid rest must not be repeated by the queue');
    assert.equal(endpoint.last.kind, 'vegetation'); assert.deepEqual(endpoint.last.bounds, bounds(640));
    endpoint.reply(old, 100, true);
    assert.equal(endpoint.messages.length, 3, 'old paced results still cannot release a newer request');
    endpoint.reply(endpoint.last, 100, true);
    assert.equal(endpoint.last.kind, 'rocks');
  } finally { stream.dispose(); }
});

test('returning to a loaded footprint cancels its pending replacement', () => {
  const endpoint = new Endpoint(), stream = new SceneryStream(1337, () => endpoint);
  try {
    stream.read('rocks', bounds(0)); endpoint.reply();
    stream.read('rocks', bounds(64));
    assert.deepEqual(stream.read('rocks', bounds(0)), []);
    endpoint.reply();
    assert.deepEqual(stream.read('rocks', bounds(0)), [], 'late travel data cannot replace the returned footprint');
    assert.equal(stream.stats.pending, 0);
  } finally { stream.dispose(); }
});

test('unavailable or failed scenery workers release their pending work for the fallback', () => {
  const unavailable = new SceneryStream(1, () => { throw new Error('disabled worker'); });
  assert.ok(unavailable.failed); unavailable.dispose();
  const endpoint = new Endpoint(), stream = new SceneryStream(1, () => endpoint);
  stream.read('rocks', bounds(0)); endpoint.onerror?.({} as ErrorEvent);
  assert.deepEqual(stream.stats, { worker: false, failed: true, pending: 0, ready: 0 });
  assert.ok(endpoint.terminated); stream.dispose();
});

function instances(group: THREE.Group) {
  const result: unknown[] = [];
  group.traverse(object => {
    if (!(object instanceof THREE.InstancedMesh) || !object.count) return;
    const custom: Record<string, number[]> = {};
    for (const [name, attribute] of Object.entries(object.geometry.attributes))
      if (attribute instanceof THREE.InstancedBufferAttribute)
        custom[name] = Array.from(attribute.array.slice(0, object.count * attribute.itemSize));
    result.push({ name: object.name, count: object.count,
      matrices: Array.from(object.instanceMatrix.array.slice(0, object.count * 16)),
      colors: object.instanceColor && Array.from(object.instanceColor.array.slice(0, object.count * 3)), custom });
  });
  return result;
}

test('worker samples produce identical scenery and pending replacements preserve existing cover', () => {
  const rock: RBox = { x: 3, y: 2, z: 5, hx: 1.3, hy: 2, hz: 1.4, r: .3 };
  const building = { x: 16, y: 4, z: 20, hx: 4, hy: 4, hz: 3 };
  const foundation = { ...building, y: -.5, hy: .5 };
  const stub = {
    collectVegetation: () => [{ x: 10, y: 0, z: 8, radius: .4, height: 6, canopyRadius: 2, kind: VEGETATION_KIND.BROADLEAF, yaw: .3 }],
    collectStructures: () => ({ sites: [], solids: [building, foundation], pads: [], cuts: [], foundations: [foundation] }),
    collectBoulders: () => [rock], column: () => ({ desert: .8 }),
  } as unknown as World;
  const samples = new ScenerySamples(stub);
  let ready = false;
  const source: ScenerySource = { failed: false,
    read<K extends SceneryKind>(kind: K, b: ReturnType<typeof bounds>): SceneryData[K] | null {
      return ready ? samples.collect(kind, b) as SceneryData[K] : null;
    } };
  const noQueries = new Proxy(stub, { get() { return () => { throw new Error('main-thread scenery query'); }; } });
  const pairs = [
    [new VegetationRenderer(stub), new VegetationRenderer(noQueries, {}, source)],
    [new StructureRenderer(stub), new StructureRenderer(noQueries, {}, source)],
    [new RockRenderer(stub), new RockRenderer(noQueries, source)],
  ];
  try {
    for (const [sync, background] of pairs) {
      ready = false; sync.update(0, 0);
      assert.equal(background.update(0, 0), false);
      assert.deepEqual(instances(background.group), []);
      ready = true; assert.equal(background.update(0, 0), true);
      const expected = instances(sync.group);
      assert.ok(expected.length > 0);
      assert.deepEqual(instances(background.group), expected, 'same transforms, colors and custom instance attributes');
      ready = false; assert.equal(background.update(512, 512), false);
      assert.deepEqual(instances(background.group), expected, 'pending travel must not remove visible gameplay cover');
    }
  } finally { for (const pair of pairs) for (const renderer of pair) renderer.dispose(); }
});
