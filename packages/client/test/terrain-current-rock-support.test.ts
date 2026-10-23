import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkManager } from '../src/render/chunks.js';
import { partitionChunkMeshes } from '../src/render/surfacenets.js';

// SOURCE-ONLY expectations for a separately approved overlay AFTER frozen r6.
// This file is not included in the existing r5/r6 qualifiers and has not run.
class WorkerStub {
  onmessage: any = null; onerror: any = null; onmessageerror: any = null;
  messages: any[] = []; terminated = false;
  postMessage(message: unknown) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
(globalThis as any).Worker = WorkerStub;
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });

const rock = { x: 480, z: 180, hx: 3, hz: 3 };
const futureRock = { x: 650, z: 180, hx: 3, hz: 3 };
function geometry(st: any, heights: readonly number[] = [0]) {
  const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16, size = 32 * step;
  const x = st.cx * size, z = st.cz * size, p: number[] = [], n: number[] = [];
  heights.forEach((y, layer) => {
    const sign = layer % 2 === 0 ? 1 : -1;
    const corners = [[x, y, z], [x, y, z + size], [x + size, y, z + size], [x + size, y, z]];
    for (const i of sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
      p.push(...corners[i]!); n.push(0, sign, 0);
    }
  });
  const chunks = [{ cy: 0, positions: new Float32Array(p), normals: new Float32Array(n),
    colors: new Uint8Array(p.length).fill(120) }];
  return st.lod === 0 ? chunks : partitionChunkMeshes(chunks, x, z, size, step);
}

function fixture(t: TestContext) {
  let now = 1000, serial = 8000;
  t.mock.method(performance, 'now', () => now);
  const manager = new ChunkManager(1337, 1), s = manager as any;
  t.after(() => manager.dispose());
  t.mock.method(s.terrainWorld, 'column', () => { throw new Error('support scheduling must not query World'); });
  Object.assign(s, { lastPx: 480, lastPz: 64, groundTravel: true, flight: false,
    lastUnderground: false, groundForecastSeconds: 4,
    groundMotionVx: 81, groundMotionVz: 0, groundMotionAt: now, lookX: 324, lookZ: 0 });
  const add = (lod: number, cx: number, cz: number, cave = false) => {
    s.ensureColumn(lod, cx, cz, cave);
    const key = `${lod}:${cx},${cz}`; s.desired.add(key); return s.columns.get(key);
  };
  const message = (st: any, reqId: number, preview = false, heights: readonly number[] = [0]) => {
    const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16;
    return { type: 'meshed', reqId, cx: st.cx, cz: st.cz, step, preview,
      caveDetail: st.caveDetail, chunks: geometry(st, heights),
      portals: { positions: new Float32Array(), ...(step > 1
        ? { partGrid: step, partOffsets: new Uint32Array(step * step + 1) } : {}) } };
  };
  const publish = (st: any, preview = false, heights: readonly number[] = [0]) => {
    s.queue = s.queue.filter((q: any) => q !== st);
    st.status = 'meshing'; st.requestId = null;
    s.publishMesh(st, message(st, ++serial, preview, heights));
  };
  const parent = add(2, 0, 0); publish(parent);
  const current = add(1, 3, 0); publish(current);
  assert.ok(parent.installed && current.installed, 'real flat canonical camera coverage');
  const support = add(1, 3, 1), route = new Map<string, number>();
  t.mock.method(s, 'groundCoverageKeys', () => route);
  const eta = (st: any, seconds: number) => route.set(st.key, seconds / 4);
  const hint = (currentRocks = [rock], futureRocks: typeof rock[] = []) => {
    s.setSceneryGroundSupport(Math.floor(s.lastPx / 64), Math.floor(s.lastPz / 64), currentRocks, futureRocks);
  };
  const keys = () => s.scenerySupportKeys(s.lastPx, s.lastPz) as Map<string, { distance: number; future: boolean }>;
  const slot = s.workers[0];
  return { manager, s, add, message, publish, parent, current, support, route, eta, hint, keys, slot,
    at: (time: number) => { now = time; },
    pump: (px = s.lastPx, pz = s.lastPz) => s.pump(px, pz),
    meshRequests: () => slot.worker.messages.filter((m: any) => m.type === 'mesh'),
    cancels: () => slot.worker.messages.filter((m: any) => m.type === 'cancel') };
}

test('current support keeps ordinary rest, survives continuing far-route demand, and publishes real canonical footprint geometry', t => {
  const f = fixture(t); f.hint();
  assert.equal(f.keys().get(f.support.key)?.future, false);
  assert.equal(f.manager.sceneryGroundReady(rock.x, rock.z, rock.hx, rock.hz), false,
    'canonical coarse camera coverage is not middle scenery support');
  f.slot.readyAt = 2000; f.slot.coverageReadyAt = 1000;
  f.at(1999); f.pump(); assert.equal(f.slot.job, null, 'no new urgent allowance');
  const far = f.add(1, 5, 0); f.eta(far, 3);
  const desired = [...f.s.desired];
  f.at(2000); f.pump(); const job = f.slot.job, worker = f.slot.worker;
  assert.equal(job.key, f.support.key);
  assert.equal(f.meshRequests().at(-1).urgentCoverage, false);
  assert.deepEqual([...f.s.desired], desired, 'priority cannot expand terrain selection');
  for (let i = 1; i <= 20; i++) {
    f.at(2000 + i * 50); f.pump(); assert.equal(f.slot.job, job);
    assert.equal(far.status, 'queued', 'the far competitor remains present');
  }
  assert.equal(f.cancels().length, 0); assert.equal(f.slot.worker, worker);
  assert.equal(f.slot.readyAt, 2000); assert.equal(f.slot.coverageReadyAt, 1000);
  const reply = f.message(f.support, job.requestId), before = reply.chunks.map((c: any) => ({
    positions: new Float32Array(c.positions), normals: new Float32Array(c.normals), colors: new Uint8Array(c.colors) }));
  f.s.onMeshed(f.slot, reply);
  assert.equal(f.support.installed, true); assert.equal(f.support.previewInstalled, false);
  assert.equal(f.manager.sceneryGroundReady(rock.x, rock.z, rock.hx, rock.hz), true);
  assert.equal(f.keys().has(f.support.key), false);
  reply.chunks.forEach((c: any, i: number) => {
    assert.deepEqual(c.positions, before[i]!.positions); assert.deepEqual(c.normals, before[i]!.normals);
    assert.deepEqual(c.colors, before[i]!.colors);
  });
  assert.equal(f.slot.job.key, far.key, 'the existing route immediately resumes after completion');
});

test('the complete near guard and missing coarse precede support; current support also promotes its own far-route key', t => {
  for (const seconds of [0, 1, 1.25, 1.2501, 3]) {
    const f = fixture(t), route = f.add(1, 5, 0); f.eta(route, seconds); f.hint(); f.pump();
    assert.equal(f.slot.job.key, seconds <= 1.25 ? route.key : f.support.key, `${seconds}s encoded ETA`);
  }
  const overlap = fixture(t), earlier = overlap.add(1, 5, 0);
  overlap.eta(earlier, 2); overlap.eta(overlap.support, 3); overlap.hint(); overlap.pump();
  assert.equal(overlap.slot.job.key, overlap.support.key, 'far route membership does not hide current support priority');
  assert.equal(overlap.meshRequests().at(-1).urgentCoverage, true,
    'independently existing route urgency is preserved');
  const coarse = fixture(t), missing = coarse.add(2, 1, 0);
  coarse.hint(); coarse.pump(); assert.equal(coarse.slot.job.key, missing.key, 'near coarse stays above support');
  const cold = fixture(t); cold.hint();
  for (const st of [cold.current, cold.parent]) {
    st.installed = false; st.status = 'queued'; cold.s.queue.push(st);
  }
  cold.pump(); assert.equal(cold.slot.job.key, cold.parent.key, 'uncovered current camera gets coarse first');
});

test('current, near, cave, camera loss and cave-generation change still preempt an active support request', t => {
  for (const mode of ['near', 'current', 'cave', 'uncovered', 'generation']) {
    const f = fixture(t); f.hint(); f.pump(); const job = f.slot.job;
    assert.equal(job.key, f.support.key);
    const far = f.add(1, 5, 0); f.eta(far, mode === 'near' ? 1.25 : 3);
    if (mode === 'current' || mode === 'cave') {
      f.current.installed = false; f.current.status = 'queued'; f.s.queue.push(f.current); f.eta(f.current, 0);
    }
    if (mode === 'cave') { f.s.lastUnderground = true; f.current.caveDetail = true; }
    if (mode === 'uncovered') for (const st of [f.current, f.parent]) {
      st.installed = false; st.status = 'queued'; f.s.queue.push(st);
    }
    if (mode === 'generation') f.support.caveDetail = true;
    f.pump();
    assert.notEqual(f.slot.job, job, mode);
    assert.ok(f.cancels().some((m: any) => m.reqId === job.requestId), mode);
    if (mode === 'near') assert.equal(f.slot.job.key, far.key);
    if (mode === 'current' || mode === 'cave') assert.equal(f.slot.job.key, f.current.key);
    if (mode === 'uncovered') assert.equal(f.slot.job.key, f.parent.key);
  }
});

test('future-only, deselected, retired and old-cell hints receive no current-support continuation exception', t => {
  const future = fixture(t), tile = future.add(1, 5, 1);
  future.hint([], [futureRock]); assert.equal(future.keys().get(tile.key)?.future, true);
  future.pump(); const futureJob = future.slot.job;
  assert.equal(futureJob.key, tile.key, 'ordinary future support can still use a free slot');
  const far = future.add(1, 5, 0); future.eta(far, 3); future.pump();
  assert.equal(future.slot.job.key, far.key);
  assert.ok(future.cancels().some((m: any) => m.reqId === futureJob.requestId));
  const queuedFuture = fixture(t), futureTile = queuedFuture.add(1, 5, 1), route = queuedFuture.add(1, 5, 0);
  queuedFuture.hint([], [futureRock]); queuedFuture.eta(route, 3); queuedFuture.pump();
  assert.equal(queuedFuture.slot.job.key, route.key, 'future demand is not promoted ahead of far route');
  assert.equal(queuedFuture.keys().get(futureTile.key)?.future, true);

  for (const mode of ['deselected', 'retired', 'cell']) {
    const f = fixture(t); f.hint(); f.pump(); const job = f.slot.job;
    const next = f.add(1, 5, 0); f.eta(next, 3);
    if (mode === 'deselected') f.s.desired.delete(f.support.key);
    if (mode === 'retired') f.support.retiring = true;
    if (mode === 'cell') {
      const covered = f.add(1, 4, 0); f.publish(covered);
      assert.equal(f.s.coveredAt(609, 64), true, 'camera coverage does not mask the stale-cell test');
      assert.equal(f.s.lastPx, 480, 'stored previous-frame coordinate deliberately remains old');
    }
    f.pump(mode === 'cell' ? 609 : 480, 64);
    assert.ok(f.cancels().some((m: any) => m.reqId === job.requestId), mode);
    assert.notEqual(f.slot.job, job, mode);
    if (mode === 'cell') assert.equal(f.s.scenerySupport.size, 0, 'actual pump coordinates invalidate the hint');
  }
});

test('support keeps the existing nine-key bound, ready uploads, and useful far-route job lifetime', t => {
  const cap = fixture(t);
  for (let z = -1; z <= 1; z++) for (let x = 2; x <= 4; x++) cap.add(1, x, z);
  cap.current.installed = false; cap.current.status = 'queued'; cap.s.queue.push(cap.current);
  const desired = [...cap.s.desired];
  cap.hint([{ x: 480, z: 64, hx: 10000, hz: 10000 }], [futureRock]);
  assert.equal(cap.s.scenerySupport.size, 9);
  assert.ok([...cap.keys().values()].every(value => !value.future));
  assert.deepEqual([...cap.s.desired], desired);

  const pending = fixture(t); pending.hint(); pending.pump(); const pendingJob = pending.slot.job;
  const near = pending.add(1, 5, 0); pending.eta(near, .5);
  pending.s.pendingMeshes.push({ slot: pending.slot, worker: pending.slot.worker, msg: {} });
  pending.pump(); assert.equal(pending.slot.job, pendingJob, 'ready upload retains existing protection');
  assert.equal(pending.cancels().length, 0);
  pending.s.pendingMeshes.length = 0;

  const active = fixture(t), far = active.add(1, 5, 0); active.eta(far, 3);
  active.pump(); const farJob = active.slot.job; assert.equal(farJob.key, far.key);
  active.hint();
  for (let i = 0; i < 20; i++) { active.pump(); assert.equal(active.slot.job, farJob); }
  assert.equal(active.cancels().length, 0, 'new support waits for the next free slot instead of causing oscillation');
});

test('real preview dependencies inherit current support priority and preserve their canonical running job', t => {
  const f = fixture(t); f.publish(f.parent, true);
  assert.equal(f.parent.previewInstalled, true);
  f.publish(f.support, false, [0, -1]);
  assert.equal(f.support.installed, false, 'finite slab is actually incompatible with the one-contour preview');
  const dependencies = f.s.seamPreviewDependencyStates() as Map<string, Set<any>>;
  assert.ok(dependencies.get(f.parent.key)?.has(f.support));
  f.hint(); const far = f.add(1, 5, 0); f.eta(far, 3); f.pump();
  const parentJob = f.slot.job;
  assert.equal(parentJob.key, f.parent.key); assert.equal(parentJob.preview, false);
  assert.equal(f.meshRequests().at(-1).urgentCoverage, false, 'inherited priority does not invent urgency');
  f.eta(far, .5); f.pump();
  assert.equal(f.slot.job, parentJob, 'the existing canonical dependency exception still precedes route cancellation');
  assert.equal(f.cancels().length, 0);
});
