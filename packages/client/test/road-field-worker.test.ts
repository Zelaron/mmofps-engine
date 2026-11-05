import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { World, type RoadSegment } from '@shared/worldgen';
import { RoadField, type RoadFieldWorker } from '../src/render/road-field.js';
import { rasterRoadSteps, type RoadFieldRequest, type RoadFieldResponse, type RoadGrid } from '../src/render/road-raster.js';

class FakeRoadWorker implements RoadFieldWorker {
  onmessage: ((event: MessageEvent<RoadFieldResponse>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly messages: RoadFieldRequest[] = [];
  terminated = false;
  postMessage(message: RoadFieldRequest): void { this.messages.push(message); }
  terminate(): void { this.terminated = true; }
  requests() { return this.messages.filter((m): m is Extract<RoadFieldRequest, { type: 'raster' }> => m.type === 'raster'); }
  reply(request: Extract<RoadFieldRequest, { type: 'raster' }>, fill = 7): void {
    const data = new Uint8Array(request.grid.size * request.grid.size * 4).fill(fill);
    this.onmessage!({ data: { type: 'raster', id: request.id, layer: request.layer, grid: request.grid, data, workMs: 1 } } as MessageEvent<RoadFieldResponse>);
  }
}

const roads: RoadSegment[] = [{ id: 'road', a: { x: -20, y: 21, z: 0 }, b: { x: 30, y: 21, z: 0 }, width: 6, trail: false }];
function localWorld() {
  let collections = 0;
  return { get collections() { return collections; }, world: {
    collectRoadSegments: () => { collections++; return roads; },
  } };
}

test('a road worker builds both maps off the main thread and finishes each request before the next', () => {
  const worker = new FakeRoadWorker(), local = localWorld();
  const field = new RoadField(local.world, { create: () => worker, seed: 4242, cooperative: true });
  try {
    assert.deepEqual(worker.messages[0], { type: 'init', seed: 4242, transportSnapshot: undefined, cooperative: true, network: false });
    assert.equal(field.remote, true);
    field.update(0, 0);
    const [near, far] = worker.requests();
    assert.deepEqual([near.layer, far.layer], [0, 1]);
    assert.equal(local.collections, 0, 'no route search runs on the main thread');
    // Crossing recenter cells while both maps are in flight sends nothing new.
    for (let i = 0; i < 20; i++) field.update(i % 2 ? 2000 : 0, 0);
    assert.equal(worker.requests().length, 2, 'work in progress is finished, never restarted');
    worker.reply({ ...far, id: far.id + 100 });
    assert.equal(field.uniforms.roadFarBounds.value.z, 1, 'unknown replies are ignored');
    worker.reply(far);
    assert.equal(field.uniforms.roadFarBounds.value.z, far.grid.size * far.grid.step);
    assert.equal(field.uniforms.roadFarMap.value.image.data[0], 7);
    assert.equal(field.uniforms.roadNearBounds.value.z, 1, 'the near map is still pending');
    worker.reply(near);
    assert.equal(field.uniforms.roadNearBounds.value.x, near.grid.x);
    field.update(6000, 6000);
    assert.deepEqual(worker.requests().slice(2).map(r => r.layer), [0, 1], 'moving on requests the next maps');
  } finally { field.dispose(); }
  assert.equal(worker.terminated, true);
});

test('the routed island network is handed to the owner once, never after a failure', () => {
  const worker = new FakeRoadWorker(), received: unknown[] = [];
  const field = new RoadField(localWorld().world, { create: () => worker, seed: 9, onNetwork: snapshot => received.push(snapshot) });
  try {
    assert.equal((worker.messages[0] as Extract<RoadFieldRequest, { type: 'init' }>).network, true);
    const snapshot = { version: 1 as const, seed: 9, keys: [], offsets: new Uint32Array(1), points: new Float64Array(), flags: new Uint8Array() };
    worker.onmessage!({ data: { type: 'network', snapshot, workMs: 1 } } as unknown as MessageEvent<RoadFieldResponse>);
    assert.deepEqual(received, [snapshot]);
    worker.onerror!(new Event('error'));
    worker.onmessage!({ data: { type: 'network', snapshot, workMs: 1 } } as unknown as MessageEvent<RoadFieldResponse>);
    assert.equal(received.length, 1, 'a disconnected worker cannot deliver');
  } finally { field.dispose(); }
});

test('a failing road worker falls back to local slices and restarts its requests there', () => {
  const worker = new FakeRoadWorker(), local = localWorld();
  const field = new RoadField(local.world, { create: () => worker, seed: 1 });
  try {
    field.update(0, 0);
    worker.onerror!(new Event('error'));
    assert.equal(field.remote, false);
    assert.equal(worker.terminated, true);
    for (let i = 0; i < 400 && field.uniforms.roadFarBounds.value.z === 1; i++) field.update(0, 0);
    assert.equal(local.collections, 2, 'both maps are collected locally');
    assert.ok(field.uniforms.roadFarBounds.value.z > 10000 && field.uniforms.roadNearBounds.value.z > 1000);
    const late = worker.requests()[0];
    worker.reply(late);
    assert.notEqual(field.uniforms.roadNearMap.value.image.data[0], 7, 'a disconnected worker cannot publish');
  } finally { field.dispose(); }
  const throwing = new RoadField(localWorld().world, { create: () => { throw new Error('no workers here'); }, seed: 1 });
  assert.equal(throwing.remote, false); throwing.dispose();
});

function workerScope(t: TestContext) {
  const tasks: (() => void)[] = [], messages: RoadFieldResponse[] = [];
  const scope = { onmessage: null as ((event: MessageEvent<RoadFieldRequest>) => void) | null,
    postMessage: (message: RoadFieldResponse) => { messages.push(message); } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: scope });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'self', previous); else Reflect.deleteProperty(globalThis, 'self'); });
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => { tasks.push(callback); return tasks.length; }) as unknown as typeof setTimeout);
  return { messages, send: (data: RoadFieldRequest) => scope.onmessage!({ data } as MessageEvent<RoadFieldRequest>),
    drain: () => { for (let i = 0; tasks.length; i++) { assert(i < 100_000); tasks.shift()!(); } } };
}

test('the road worker serves maps nearest first, matches the main thread exactly, then routes the island once', async t => {
  const h = workerScope(t);
  await import('../src/render/road-field.worker.js');
  const road = new World(1337).collectRoadSegments(-3072, 3072, -3072, 3072).find(r => !r.id.startsWith('city:'))!;
  assert.ok(road, 'a rural road exists near the origin');
  const near: RoadGrid = { x: Math.round(road.a.x) - 128, z: Math.round(road.a.z) - 128, size: 128, step: 2 };
  const far: RoadGrid = { x: Math.round(road.a.x) - 1280, z: Math.round(road.a.z) - 1280, size: 160, step: 16 };
  h.send({ type: 'init', seed: 1337, network: true });
  h.send({ type: 'raster', id: 1, layer: 1, grid: far });
  h.send({ type: 'raster', id: 2, layer: 0, grid: near });
  h.drain();
  const maps = h.messages.filter((m): m is Extract<RoadFieldResponse, { type: 'raster' }> => m.type === 'raster');
  assert.deepEqual(h.messages.map(m => m.type), ['raster', 'network', 'raster', 'network', 'network'],
    'each first map shares the links it routed at once; the whole island follows after the waiting maps');
  const networks = h.messages.filter((m): m is Extract<RoadFieldResponse, { type: 'network' }> => m.type === 'network');
  assert.ok(networks[0].snapshot.keys.length < networks[1].snapshot.keys.length && networks[1].snapshot.keys.length < networks[2].snapshot.keys.length,
    'each snapshot covers more of the island');
  assert.deepEqual(maps.map(m => m.id), [2, 1], 'a near request is served before an earlier far request');
  for (const [message, grid] of [[maps[0], near], [maps[1], far]] as const) {
    const steps = rasterRoadSteps(new World(1337), grid);
    let next = steps.next(); while (!next.done) next = steps.next();
    assert.deepEqual(message.data, next.value);
    assert.ok(message.data.some(v => v < 255), 'the area contains roads');
  }
  const network = networks[2];
  assert.ok(network.snapshot.keys.length > 1000, 'every island link and trail');
  const cold = new World(1337), adopted = new World(1337);
  assert.equal(adopted.adoptRoadNetwork(network.snapshot), true);
  assert.equal(new World(7).adoptRoadNetwork(network.snapshot), false, 'another seed ignores the snapshot');
  for (const [x, z] of [[8502, 819], [-5000, 3000], [road.a.x, road.a.z]]) assert.deepEqual(adopted.column(x, z), cold.column(x, z));
  assert.deepEqual(adopted.collectRoadSegments(-4096, 4096, -4096, 4096), cold.collectRoadSegments(-4096, 4096, -4096, 4096),
    'adopted links are bit-identical to routing them here');
});
