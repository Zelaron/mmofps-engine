import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { ScenerySamples } from '../src/render/scenery-samples.js';

function workerHarness(t: TestContext) {
  let now = 0, id = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const messages: any[] = [];
  const scope = { onmessage: null as ((event: MessageEvent<any>) => void) | null,
    postMessage: (message: unknown) => { messages.push(message); } };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'self');
  Object.defineProperty(globalThis, 'self', { configurable: true, value: scope });
  t.after(() => {
    tasks.clear();
    if (previous) Object.defineProperty(globalThis, 'self', previous);
    else Reflect.deleteProperty(globalThis, 'self');
  });
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay = 0) => {
    const handle = ++id; tasks.set(handle, { at: now + delay, callback }); return handle;
  }) as unknown as typeof setTimeout);
  t.mock.method(globalThis, 'clearTimeout', ((handle: number) => { tasks.delete(handle); }) as unknown as typeof clearTimeout);
  const next = () => {
    const task = [...tasks].sort((a, b) => a[1].at - b[1].at)[0]; assert(task);
    tasks.delete(task[0]); now = Math.max(now, task[1].at); task[1].callback();
  };
  return { messages, tasks, send: (data: unknown) => scope.onmessage!({ data } as MessageEvent),
    work: (ms: number) => { now += ms; }, now: () => now, next,
    drain: () => { for (let i = 0; tasks.size; i++) { assert(i < 1000); next(); } } };
}

test('local mesher cancellation retains World and owed rest, while reseeding suppresses stale buffers', async t => {
  const h = workerHarness(t), worlds: World[] = [];
  t.mock.method(World.prototype, 'column', function(this: World) {
    worlds.push(this); h.work(1); return { h: 0 } as ReturnType<World['column']>;
  });
  t.mock.method(World.prototype, 'material', () => 0);
  t.mock.method(World.prototype, 'vertexColor', (...args: Parameters<World['vertexColor']>) => {
    const target = args[5];
    target[0] = .2; target[1] = .3; target[2] = .4;
  });
  await import('../src/render/mesher.worker.js');
  const mesh = (reqId: number) => ({ type: 'mesh', reqId, cx: 0, cz: 0, step: 16, caveDetail: false, preview: true });
  h.send({ type: 'init', seed: 1337, cooperative: true }); h.send(mesh(1)); h.next();
  assert.equal(worlds.length, 4); const firstWorld = worlds[0], owedUntil = [...h.tasks.values()][0].at;
  h.send({ type: 'cancel', reqId: 1 }); h.send({ ...mesh(2), urgentCoverage: true });
  assert.equal([...h.tasks.values()][0].at, owedUntil, 'replacement keeps the old slice rest');
  h.send({ type: 'cancel', reqId: 1 }); h.next();
  assert.equal(worlds.at(-1), firstWorld, 'late cancellation cannot cancel the newer job or replace its warm World');
  h.send({ type: 'init', seed: 2468, cooperative: true }); h.send(mesh(3)); h.drain();
  assert.deepEqual(h.messages.map(msg => msg.reqId), [3]);
  assert.notEqual(worlds.at(-1), firstWorld); assert.equal(worlds.at(-1)!.seed, 2468);
  assert.equal(h.messages[0].paced, true); assert(h.messages[0].maxSliceMs >= 4);
  const paced = h.messages[0];
  h.send({ type: 'init', seed: 2468 }); h.send(mesh(4));
  assert.equal(h.tasks.size, 0, 'remote generation stays synchronous');
  assert.equal(h.messages.at(-1).paced, undefined);
  assert.deepEqual(h.messages.at(-1).chunks, paced.chunks); assert.deepEqual(h.messages.at(-1).portals, paced.portals);
});

test('scenery reseeding cancels paused generation and final rest before publishing atomic results', async t => {
  const h = workerHarness(t); let closed = 0, started = 0;
  t.mock.method(ScenerySamples.prototype, 'collectSteps', function* () {
    started++;
    try { h.work(5); yield; return []; } finally { closed++; }
  });
  t.mock.method(ScenerySamples.prototype, 'collect', () => []);
  await import('../src/render/scenery.worker.js');
  const query = (id: number) => ({ type: 'query', id, kind: 'rocks', bounds: { minX: 0, maxX: 1, minZ: 0, maxZ: 1 } });
  h.send({ type: 'init', seed: 1337, cooperative: true }); h.send(query(1)); h.next();
  const owedUntil = [...h.tasks.values()][0].at;
  h.send({ type: 'init', seed: 2468, cooperative: true }); h.send(query(2));
  assert.equal(closed, 1); assert.equal([...h.tasks.values()][0].at, owedUntil);
  h.drain(); assert.deepEqual(h.messages.map(msg => msg.id), [2]); assert.equal(started, 2);
  assert.deepEqual(h.messages[0].data, []); assert.equal(h.messages[0].paced, true);
  h.send(query(3)); h.next(); h.next();
  assert.equal(h.messages.length, 1, 'finished data remains atomic during the final rest');
  h.send({ type: 'init', seed: 1337 }); h.send(query(4)); h.drain();
  assert.deepEqual(h.messages.map(msg => msg.id), [2, 4]); assert.equal(h.messages[1].paced, undefined);
});

test('local map replacement retains measured rest and publishes only the complete current seed', async t => {
  const h = workerHarness(t), worlds: World[] = [];
  const plan = { routes: [] } as unknown as ReturnType<World['collectTransportPlan']>;
  const roads = [{ id: 'road', a: { x: 0, y: 0, z: 0 }, b: { x: 100, y: 0, z: 60 }, width: 8, trail: false }];
  t.mock.method(World.prototype, 'collectTransportPlan', function(this: World) { worlds.push(this); h.work(7); return plan; });
  t.mock.method(World.prototype, 'collectCities', () => []);
  t.mock.method(World.prototype, 'collectMajorRoadSegments', () => roads);
  t.mock.method(World.prototype, 'collectMajorRoadSegmentSteps', function* () {
    for (let i = 0; i < 2; i++) { h.work(5); yield; }
    h.work(2); return roads;
  });
  await import('../src/map.worker.js');
  const request = (seed: number) => ({ type: 'map', seed, cooperative: true });
  h.send(request(1337));
  assert.equal(worlds.length, 0, 'first slice starts from the scheduled turn');
  h.next(); assert.equal(h.now(), 7);
  const owedUntil = [...h.tasks.values()][0].at;
  assert.equal(owedUntil, 28, 'cold plan restoration owes three times its measured work');
  h.send(request(7331)); assert.equal([...h.tasks.values()][0].at, owedUntil);
  h.send({ type: 'map', seed: NaN }); assert.equal([...h.tasks.values()][0].at, owedUntil, 'invalid requests do not disturb the current job');
  h.drain(); assert.deepEqual(h.messages.map(msg => msg.seed), [7331]);
  assert.deepEqual(worlds.map(world => world.seed), [1337, 7331]);
  assert.equal(h.messages[0].paced, true); assert.equal(h.messages[0].workMs, 19);
  assert.equal(h.messages[0].maxSliceMs, 7); assert.equal(h.messages[0].slices, 4);
  assert(h.messages[0].elapsedMs >= 19 * 4, 'the final slice also rests before publication');
  const svg = h.messages[0].svg;
  h.send(request(20077));
  for (let i = 0; i < 4; i++) h.next();
  assert.equal(h.messages.length, 1, 'completed artwork remains unpublished during its final rest');
  h.send({ type: 'map', seed: 7331 }); h.drain();
  assert.deepEqual(h.messages.map(msg => msg.seed), [7331, 7331]);
  assert.equal(h.messages[1].paced, undefined, 'remote requests retain immediate synchronous generation');
  assert.equal(h.messages[1].svg, svg, 'scheduling cannot alter the SVG');
});
