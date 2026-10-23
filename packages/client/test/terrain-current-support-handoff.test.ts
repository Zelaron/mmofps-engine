import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkManager } from '../src/render/chunks.js';
import { partitionChunkMeshes } from '../src/render/surfacenets.js';

// New artifact expectations; execution requires a separate root handoff.
class WorkerStub {
  onmessage: any = null; onerror: any = null; onmessageerror: any = null;
  messages: any[] = []; terminated = false;
  postMessage(message: unknown) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
(globalThis as any).Worker = WorkerStub;
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });
const target = { x: 480, z: 180, hx: 3, hz: 3 };
function geometry(st: any) {
  const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16, size = 32 * step;
  const x = st.cx * size, z = st.cz * size;
  const positions = new Float32Array([x, 0, z, x, 0, z + size, x + size, 0, z + size,
    x, 0, z, x + size, 0, z + size, x + size, 0, z]);
  const normals = new Float32Array(18); for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  const chunks = [{ cy: 0, positions, normals, colors: new Uint8Array(18).fill(120) }];
  return st.lod === 0 ? chunks : partitionChunkMeshes(chunks, x, z, size, step);
}
function fixture(t: TestContext, rock = target, supportX = 3) {
  let now = 1000, serial = 8000;
  t.mock.method(performance, 'now', () => now);
  const manager = new ChunkManager(1337, 1), s = manager as any;
  t.after(() => manager.dispose());
  t.mock.method(s.terrainWorld, 'column', () => { throw new Error('handoff must not query World'); });
  Object.assign(s, { lastPx: 480, lastPz: 64, groundTravel: true, flight: false,
    lastUnderground: false, groundForecastSeconds: 4,
    groundMotionVx: 81, groundMotionVz: 0, groundMotionAt: now, lookX: 324, lookZ: 0 });
  const add = (lod: number, cx: number, cz: number, cave = false) => {
    s.ensureColumn(lod, cx, cz, cave); const key = `${lod}:${cx},${cz}`;
    s.desired.add(key); return s.columns.get(key);
  };
  const message = (st: any, reqId: number) => {
    const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16;
    return { type: 'meshed', reqId, cx: st.cx, cz: st.cz, step, preview: false,
      caveDetail: st.caveDetail, chunks: geometry(st),
      portals: { positions: new Float32Array(), ...(step > 1
        ? { partGrid: step, partOffsets: new Uint32Array(step * step + 1) } : {}) } };
  };
  const publish = (st: any) => {
    s.queue = s.queue.filter((q: any) => q !== st);
    st.status = 'meshing'; st.requestId = null; s.publishMesh(st, message(st, ++serial));
  };
  const parent = add(2, 0, 0); publish(parent);
  const current = add(1, 3, 0); publish(current);
  const adjacent = add(1, 4, 0); publish(adjacent);
  assert.ok(s.coveredAt(545, 64) && s.coveredAt(609, 64));
  const support = add(1, supportX, 1), route = new Map<string, number>();
  t.mock.method(s, 'groundCoverageKeys', () => route);
  const eta = (st: any, seconds: number) => route.set(st.key, seconds / 4);
  const hint = (rocks = [rock], future: typeof target[] = [], cellX = Math.floor(s.lastPx / 64)) =>
    s.setSceneryGroundSupport(cellX, Math.floor(s.lastPz / 64), rocks, future);
  const slot = s.workers[0];
  return { manager, s, rock, add, message, publish, parent, current, adjacent, support, route, eta, hint, slot,
    at: (time: number) => { now = time; }, pump: (px = s.lastPx, pz = s.lastPz) => s.pump(px, pz),
    requests: () => slot.worker.messages.filter((m: any) => m.type === 'mesh'),
    cancels: () => slot.worker.messages.filter((m: any) => m.type === 'cancel') };
}
function start(t: TestContext, rock = target, supportX = 3) {
  const f = fixture(t, rock, supportX); f.hint(); f.pump();
  assert.equal(f.slot.job.key, f.support.key);
  const job = f.slot.job, far = f.add(1, 5, 0); f.eta(far, 3);
  return { ...f, job, far };
}

test('accepted current request crosses adjacent cells coherently and publishes real canonical support with ordinary rest', t => {
  const f = fixture(t); f.hint(); f.slot.readyAt = 2000; f.slot.coverageReadyAt = 1000;
  f.at(1999); f.pump(); assert.equal(f.slot.job, null, 'no urgent support deadline');
  const far = f.add(1, 5, 0); f.eta(far, 3);
  f.at(2000); f.pump(); const job = f.slot.job, worker = f.slot.worker, selected = [...f.s.desired];
  assert.equal(job.key, f.support.key); assert.equal(f.requests().at(-1).urgentCoverage, false);
  f.at(2050); f.pump(545, 64);
  assert.equal(f.s.scenerySupport.size, 0, 'old-cell queued hints still clear');
  assert.equal(f.s.lastPx, 480, 'actual pump coordinates, not stale stored camera, control revalidation');
  assert.equal(f.slot.job, job); assert.equal(f.cancels().length, 0);
  f.s.lastPx = 545; f.hint(); f.pump(545, 64);
  f.at(2100); f.pump(609, 64); assert.equal(f.slot.job, job, 'fresh acceptance permits the next adjacent crossing');
  assert.equal(f.slot.worker, worker); assert.equal(f.cancels().length, 0);
  assert.equal(f.slot.readyAt, 2000); assert.equal(f.slot.coverageReadyAt, 1000);
  assert.deepEqual([...f.s.desired], selected);
  const reply = f.message(f.support, job.requestId);
  const before = reply.chunks.map(c => ({ positions: new Float32Array(c.positions), normals: new Float32Array(c.normals), colors: new Uint8Array(c.colors) }));
  f.s.lastPx = 609; f.s.onMeshed(f.slot, reply);
  assert.equal(f.support.installed, true); assert.equal(f.support.previewInstalled, false);
  assert.equal(f.manager.sceneryGroundReady(target.x, target.z, target.hx, target.hz), true);
  reply.chunks.forEach((c, i) => {
    assert.deepEqual(c.positions, before[i]!.positions); assert.deepEqual(c.normals, before[i]!.normals);
    assert.deepEqual(c.colors, before[i]!.colors);
  });
  assert.equal(f.slot.job.key, far.key, 'normal queued work resumes after completion');
});

test('request-local handoff rejects a second unrefreshed cell, loss of protected distance and loss of selected local neighborhood', t => {
  const twice = start(t); twice.pump(545, 64); assert.equal(twice.slot.job, twice.job);
  twice.pump(609, 64); assert.notEqual(twice.slot.job, twice.job);
  assert.ok(twice.cancels().some((m: any) => m.reqId === twice.job.requestId));
  const distance = start(t, { x: 385, z: 180, hx: 1, hz: 1 });
  assert.equal(Math.abs(distance.support.cx - Math.floor(545 / 128)), 1, 'local neighborhood remains valid');
  distance.pump(545, 64); assert.notEqual(distance.slot.job, distance.job, 'footprint leaves existing128m protection');
  assert.ok(distance.cancels().length > 0);
  const neighborhood = start(t, { x: 383, z: 180, hx: 80, hz: 3 }, 2);
  const dx = Math.max(512 - neighborhood.rock.x - neighborhood.rock.hx, 0), dz = 49;
  assert.ok(dx * dx + dz * dz < 128 ** 2, 'protected distance alone would allow it');
  neighborhood.pump(545, 64); assert.notEqual(neighborhood.slot.job, neighborhood.job);
  assert.ok(neighborhood.cancels().length > 0, 'selected local middle neighborhood is independently required');
});

test('fresh empty, future-only or invalid publication revokes the old request; stale queued hints cannot borrow it', t => {
  for (const mode of ['empty', 'future', 'invalid']) {
    const f = start(t); f.pump(545, 64); assert.equal(f.slot.job, f.job);
    f.s.lastPx = 545;
    if (mode === 'empty') f.hint([]);
    if (mode === 'future') f.hint([], [f.rock]);
    if (mode === 'invalid') f.hint([f.rock], [], 7);
    f.pump(545, 64); assert.notEqual(f.slot.job, f.job, mode);
    assert.ok(f.cancels().some((m: any) => m.reqId === f.job.requestId), mode);
  }
  const queued = fixture(t); queued.hint(); queued.slot.readyAt = 2000; queued.slot.coverageReadyAt = 2000;
  const far = queued.add(1, 5, 0); queued.eta(far, 3);
  queued.pump(); assert.equal(queued.slot.job, null);
  queued.at(2000); queued.pump(545, 64); assert.equal(queued.slot.job.key, far.key,
    'an old current hint never dispatched cannot receive continuation or queue priority');
  const future = fixture(t), futureTile = future.add(1, 5, 1);
  future.hint([], [{ x: 650, z: 180, hx: 3, hz: 3 }]); future.pump();
  const job = future.slot.job; assert.equal(job.key, futureTile.key);
  const route = future.add(1, 5, 0); future.eta(route, 3); future.pump(545, 64);
  assert.notEqual(future.slot.job, job, 'future-only dispatch never mints a current-support token');
});

test('near/current/cave, lifecycle and camera guards retain precedence while publication handoff is active', t => {
  for (const mode of ['near', 'current', 'cave', 'generation', 'uncovered', 'deselected', 'retired', 'identity', 'request', 'job', 'alternate-owner']) {
    const f = start(t);
    if (mode === 'near') f.eta(f.far, 1.25);
    if (mode === 'current' || mode === 'cave') {
      f.adjacent.installed = false; f.adjacent.status = 'queued'; f.s.queue.push(f.adjacent); f.eta(f.adjacent, 0);
    }
    if (mode === 'cave') { f.s.lastUnderground = true; f.adjacent.caveDetail = true; }
    if (mode === 'generation') f.support.caveDetail = true;
    if (mode === 'uncovered') {
      f.adjacent.installed = false; f.adjacent.status = 'queued'; f.s.queue.push(f.adjacent);
    }
    if (mode === 'deselected') f.s.desired.delete(f.support.key);
    if (mode === 'retired') f.support.retiring = true;
    if (mode === 'identity') f.s.columns.set(f.support.key, { ...f.support });
    if (mode === 'request') { f.job.requestId += 1000; f.support.requestId = f.job.requestId; }
    if (mode === 'job') f.slot.job = { ...f.job };
    if (mode === 'alternate-owner') {
      for (const x of [14, 15]) f.publish(f.add(0, x, 5));
      assert.equal(f.manager.sceneryGroundReady(target.x, target.z, target.hx, target.hz), true,
        'two actual fine owners now cover the accepted footprint without the pending middle job');
    }
    const live = f.slot.job; f.pump(545, 64);
    assert.notEqual(f.slot.job, live, mode);
    assert.ok(f.cancels().some((m: any) => m.reqId === live.requestId), mode);
  }
  // Flight normally skips the pedestrian cancellation loop; assert that it
  // still rejects the new retention predicate rather than inventing a cancel.
  const flight = start(t); flight.s.flight = true;
  assert.equal(flight.s.retainedCurrentSupportJob(flight.support, flight.job, 545, 64), false);
});

test('pending uploads keep their existing lifetime and a completed token cannot protect a later request', t => {
  const f = start(t); f.pump(545, 64); assert.equal(f.slot.job, f.job);
  const reply = f.message(f.support, f.job.requestId);
  const pending = { slot: f.slot, worker: f.slot.worker, msg: reply };
  f.s.pendingMeshes.push(pending); f.s.lastPx = 545; f.hint([]); f.eta(f.far, 0);
  f.s.yieldGroundWorker(new Set([f.far.key]), f.route, undefined, 545, 64, new Map());
  assert.equal(f.slot.job, f.job, 'completed queued upload keeps the original unconditional protection');
  assert.equal(f.s.pendingMeshes[0], pending); f.s.pendingMeshes.length = 0;
  f.s.onMeshed(f.slot, reply); assert.equal(f.support.installed, true);
  const next = f.slot.job; assert.equal(next.key, f.far.key);
  assert.equal(f.s.retainedCurrentSupportJob(f.far, next, 545, 64), false,
    'finished request evidence is not transferable to the new job');
});
