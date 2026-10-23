import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkManager } from '../src/render/chunks.js';

class WorkerStub {
  onmessage: any = null; onerror: any = null; onmessageerror: any = null;
  messages: any[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  terminate() {}
}
(globalThis as any).Worker = WorkerStub;
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });

function fixture(t: TestContext, mockRoute = true) {
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const manager = new ChunkManager(1337, 1), s = manager as any;
  t.after(() => manager.dispose());
  t.mock.method(s.terrainWorld, 'column', () => { throw new Error('queue scheduling must not generate World columns'); });
  Object.assign(s, { lastPx: 480, lastPz: 64, groundTravel: true, flight: false,
    groundForecastSeconds: 4, groundMotionVx: 81, groundMotionVz: 0, lookX: 324, lookZ: 0 });
  const add = (lod: number, cx: number, cz: number, cave = false) => {
    s.ensureColumn(lod, cx, cz, cave);
    const key = `${lod}:${cx},${cz}`; s.desired.add(key); return s.columns.get(key);
  };
  const current = add(1, 3, 0, true), parent = add(2, 0, 0);
  for (const st of [current, parent]) { st.installed = true; st.status = 'ready'; }
  current.installedCaveDetail = true; parent.previewInstalled = true;
  const route = new Map<string, number>();
  if (mockRoute) t.mock.method(s, 'groundCoverageKeys', () => route);
  const eta = (st: any, seconds: number) => route.set(st.key, seconds / 4);
  const coarse = add(2, 1, 0);
  return { manager, s, current, parent, coarse, route, add, eta,
    slot: s.workers[0], at: (value: number) => { now = value; },
    pump: () => s.pump(s.lastPx, s.lastPz) };
}

test('current and complete biased steering guard precede coarse; farther route stays above unrelated refinement', t => {
  for (const seconds of [0, 1, 1.25, 1.2501, 3.5]) {
    const f = fixture(t), route = f.add(1, 5, 0, true);
    f.eta(route, seconds); f.add(1, 4, 1); f.add(0, 15, 2);
    const selected = [...f.s.desired]; f.pump();
    assert.equal(f.slot.job.key, seconds <= 1.25 ? route.key : f.coarse.key);
    assert.deepEqual([...f.s.desired], selected, 'priority creates no selected columns');
    if (seconds > 1.25) {
      f.slot.job = null; f.coarse.requestId = null; f.coarse.installed = true; f.coarse.status = 'ready';
      f.pump(); assert.equal(f.slot.job.key, route.key, 'far route resumes before ordinary neighborhood/fine detail');
    }
  }
  const cold = fixture(t), route = cold.add(1, 4, 0, true);
  cold.current.installed = false; cold.parent.installed = false;
  cold.parent.status = 'queued'; cold.eta(cold.current, 0); cold.eta(route, .5);
  cold.pump(); assert.equal(cold.slot.job.key, cold.parent.key, 'initial current coarse keeps its original first priority');
});

test('actual turning forecast retains the last straight steering-release tile despite its .25 second bias', t => {
  const f = fixture(t, false);
  f.s.lastPx = 432; f.s.groundGuardX = 81; f.s.groundGuardZ = 0;
  f.s.groundPath = [{ x: 0, z: 0, seconds: 0 }, { x: 0, z: 324, seconds: 4 }];
  f.s.lookX = 0; f.s.lookZ = 324;
  const guard = f.add(1, 4, 0, true);
  for (let z = 1; z <= 3; z++) f.add(1, 3, z, true);
  const route = f.s.groundCoverageKeys(432, 64), encoded = route.get(guard.key) * 4;
  assert.ok(encoded > 1 && encoded <= 1.25, 'the production guard carries the existing priority bias');
  // Already-covered curved entries leave the actual guard as the near demand.
  for (let z = 1; z <= 3; z++) {
    const st = f.s.columns.get(`1:3,${z}`); st.installed = true; st.installedCaveDetail = true; st.status = 'ready';
  }
  f.pump(); assert.equal(f.slot.job.key, guard.key);
});

test('near coarse preview and canonical replacements keep ordinary rest and continue only beyond the near guard', t => {
  for (const canonical of [false, true]) {
    const f = fixture(t);
    if (canonical) f.coarse.canonicalRequest = { previewReqId: 7, caveDetail: false };
    f.slot.readyAt = 2000; f.slot.coverageReadyAt = 1000;
    f.at(1999); f.pump(); assert.equal(f.slot.job, null, 'ordinary worker deadline remains owed');
    const far = f.add(1, 5, 0, true); f.eta(far, 2);
    f.at(2000); f.pump();
    const job = f.slot.job, worker = f.slot.worker;
    assert.equal(job.key, f.coarse.key); assert.equal(job.preview, !canonical);
    assert.equal(worker.messages.at(-1).urgentCoverage, false);
    for (let i = 0; i < 20; i++) { f.at(2000 + i * 50); f.pump(); assert.equal(f.slot.job, job); }
    assert.equal(f.slot.readyAt, 2000); assert.equal(f.slot.coverageReadyAt, 1000);
    f.eta(far, 1.25);
    f.s.yieldGroundWorker(new Set([far.key]), f.route, undefined, 480, 64);
    assert.equal(f.slot.job, null, 'the complete encoded near guard still preempts coarse');
    assert.deepEqual(worker.messages.at(-1), { type: 'cancel', reqId: job.requestId });
    assert.equal(f.slot.readyAt, 2000); assert.equal(f.slot.coverageReadyAt, 1000);
    assert.equal(f.slot.worker, worker);
  }
});

test('current canonical deficit, cave change and lost coarse eligibility remove continuation protection', t => {
  for (const mode of ['current', 'underground', 'generation', 'stopped', 'deselected', 'distant']) {
    const f = fixture(t); f.pump(); const job = f.slot.job;
    const far = f.add(1, 5, 0, true); f.eta(far, 2);
    if (mode === 'current') { f.current.installed = false; f.current.status = 'queued'; f.eta(f.current, 0); }
    if (mode === 'underground') f.s.lastUnderground = true;
    if (mode === 'generation') f.coarse.caveDetail = true;
    if (mode === 'stopped') f.s.groundTravel = false;
    if (mode === 'deselected') f.s.desired.delete(f.coarse.key);
    const px = mode === 'distant' ? -300 : 480;
    f.s.yieldGroundWorker(new Set(f.route.keys()), f.route, undefined, px, 64);
    assert.equal(f.slot.job, null, mode);
    assert.ok(f.slot.worker.messages.some((m: any) => m.type === 'cancel' && m.reqId === job.requestId), mode);
  }
  const flight = fixture(t); flight.s.flight = true;
  assert.equal(flight.s.nearbyCoarseCoverage(flight.coarse, 480, 64), false, 'flight retains its separate scheduling policy');
});

test('ready uploads and canonical preview dependencies keep their existing protection', t => {
  const pending = fixture(t); pending.pump(); const job = pending.slot.job;
  const near = pending.add(1, 4, 0, true); pending.eta(near, .5);
  pending.s.pendingMeshes.push({ slot: pending.slot });
  pending.s.yieldGroundWorker(new Set([near.key]), pending.route, undefined, 480, 64);
  assert.equal(pending.slot.job, job, 'ready payload is not cancelled before admission');
  pending.s.pendingMeshes.length = 0;
  const dependency = fixture(t); dependency.coarse.canonicalRequest = { previewReqId: 7, caveDetail: false };
  dependency.pump(); const parentJob = dependency.slot.job;
  dependency.coarse.installed = true; dependency.coarse.previewInstalled = true;
  const blocked = dependency.add(1, 4, 0, true); dependency.eta(blocked, 0);
  dependency.s.yieldGroundWorker(new Set([blocked.key]), dependency.route,
    new Map([[dependency.coarse.key, new Set([blocked])]]), 480, 64);
  assert.equal(dependency.slot.job, parentJob, 'r3 actual dependency survives current urgency');
});

test('new nearby coarse demand does not repeatedly cancel an already useful far-route job', t => {
  const f = fixture(t), far = f.add(1, 5, 0, true);
  f.coarse.installed = true; f.coarse.status = 'ready'; f.eta(far, 3);
  f.pump(); const job = f.slot.job;
  assert.equal(job.key, far.key);
  f.coarse.installed = false; f.coarse.status = 'queued'; f.s.queue.push(f.coarse);
  for (let i = 0; i < 20; i++) { f.at(1000 + i * 50); f.pump(); assert.equal(f.slot.job, job); }
  assert.equal(f.slot.worker.messages.some((m: any) => m.type === 'cancel'), false);
});
