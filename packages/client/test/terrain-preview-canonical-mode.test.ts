import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkManager } from '../src/render/chunks.js';
import { partitionChunkMeshes } from '../src/render/surfacenets.js';

class WorkerStub {
  onmessage: any = null; onerror: any = null; onmessageerror: any = null;
  messages: any[] = []; terminated = false;
  postMessage(message: unknown) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
(globalThis as any).Worker = WorkerStub;
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });

// Real partitioned contours: canonical terrain is a finite slab while the
// preview contains only its single height surface. No seam verdict is mocked.
function geometry(st: any, preview: boolean) {
  const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16, size = 32 * step;
  const x = st.cx * size, z = st.cz * size, p: number[] = [], n: number[] = [];
  for (const [y, sign] of preview ? [[21.14, 1]] : [[21.2, 1], [20.08, -1]]) {
    const corners = [[x, y, z], [x, y, z + size], [x + size, y, z + size], [x + size, y, z]];
    for (const i of sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
      p.push(...corners[i]); n.push(0, sign, 0);
    }
  }
  const chunks = [{ cy: 0, positions: new Float32Array(p), normals: new Float32Array(n), colors: new Uint8Array(p.length).fill(120) }];
  return st.lod === 0 ? chunks : partitionChunkMeshes(chunks, x, z, size, step);
}

function fixture(t: TestContext, px = 600, pz = 160) {
  let now = 1000, serial = 50;
  t.mock.method(performance, 'now', () => now);
  const manager = new ChunkManager(1337, 1), s = manager as any;
  t.after(() => manager.dispose());
  t.mock.method(s.terrainWorld, 'column', () => { throw new Error('canonical-request scheduling must not query the World'); });
  s.lastPx = px; s.lastPz = pz; s.flight = false; s.groundTravel = false;
  const add = (lod: number, cx: number, cz: number) => {
    s.ensureColumn(lod, cx, cz, false);
    const key = `${lod}:${cx},${cz}`; s.desired.add(key); return s.columns.get(key);
  };
  const message = (st: any, preview: boolean, reqId: number) => {
    const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16;
    return { type: 'meshed', reqId, cx: st.cx, cz: st.cz, step, preview,
      caveDetail: st.caveDetail, chunks: geometry(st, preview),
      portals: { positions: new Float32Array(), ...(step === 4 ? { partGrid: 4, partOffsets: new Uint32Array(17) } : {}) } };
  };
  const publish = (st: any, preview = false) => {
    s.queue = s.queue.filter((q: any) => q !== st);
    st.status = 'meshing'; st.requestId = null;
    const msg = message(st, preview, ++serial); s.publishMesh(st, msg); return msg;
  };
  const finishJob = () => {
    const slot = s.workers[0], job = slot.job; assert.ok(job, 'a real queued request was dispatched');
    const st = s.columns.get(job.key); assert.ok(st);
    const msg = message(st, job.preview, job.requestId);
    s.onMeshed(slot, msg); return { st, job, msg };
  };
  const afterFiner = () => {
    const fine = add(1, 3, 1); publish(fine); assert.equal(fine.installed, true);
    const parent = add(2, 1, 0); assert.equal(parent.canonicalRequest, null);
    const msg = publish(parent, true);
    assert.equal(parent.installed, false); assert.equal(parent.previewInstalled, false);
    assert.equal(parent.status, 'queued'); assert.equal(s.seamDeferred.has(parent.key), false);
    assert.deepEqual(parent.canonicalRequest, { previewReqId: msg.reqId, caveDetail: msg.caveDetail });
    return { fine, parent, msg };
  };
  return { manager, s, add, publish, message, finishJob, afterFiner, at: (time: number) => { now = time; } };
}

test('preview-before-finer retains existing dependency priority and ordinary rest without explicit request mode', t => {
  const f = fixture(t, 160), parent = f.add(2, 0, 0); f.publish(parent, true);
  const middle = f.add(1, 1, 1), oldMask = parent.partVisible; f.publish(middle);
  assert.equal(parent.installed, true); assert.equal(parent.previewInstalled, true);
  assert.equal(parent.canonicalRequest, null); assert.equal(middle.installed, false);
  assert.ok(f.s.seamPreviewDependencyStates().get(parent.key)?.has(middle));
  const slot = f.s.workers[0]; slot.readyAt = 2000; slot.coverageReadyAt = 1000;
  f.s.pump(160, 160); assert.equal(slot.job, null); assert.equal(parent.partVisible, oldMask);
  f.at(2000); f.s.pump(160, 160);
  assert.equal(slot.job.key, parent.key); assert.equal(slot.job.preview, false);
  assert.ok(parent.priority < -11_000_000); assert.equal(slot.worker.messages.at(-1).urgentCoverage, false);
});

test('preview-after-finer queues real canonical work, preserves masks, survives worker retry and fences stale replies', t => {
  const f = fixture(t), { fine, parent } = f.afterFiner(), mask = fine.partVisible, mesh = fine.meshes[0];
  const mode = parent.canonicalRequest;
  f.s.pump(600, 160);
  const slot = f.s.workers[0], oldJob = slot.job, oldWorker = slot.worker;
  assert.equal(oldJob.key, parent.key); assert.equal(oldJob.preview, false);
  assert.equal(parent.installed, false); assert.equal(parent.partVisible, null);
  assert.equal(fine.partVisible, mask); assert.equal(fine.meshes[0], mesh);
  f.s.onWorkerError(slot, oldWorker);
  assert.equal(oldWorker.terminated, true); assert.equal(parent.canonicalRequest, mode);
  assert.equal(slot.job.key, parent.key); assert.equal(slot.job.preview, false);
  assert.notEqual(slot.job.requestId, oldJob.requestId);
  const currentJob = slot.job;
  f.s.onMeshed(slot, f.message(parent, false, oldJob.requestId));
  assert.equal(slot.job, currentJob); assert.equal(parent.canonicalRequest, mode);
  f.finishJob();
  assert.equal(parent.installed, true); assert.equal(parent.previewInstalled, false); assert.equal(parent.canonicalRequest, null);
  assert.equal(fine.installed, true); assert.equal(fine.meshes[0], mesh);
  assert.equal(f.s.seamDeferred.size, 0);
});

test('actual canonical replies finish a3x3 finite-slab neighborhood without preview retention or mask gaps', t => {
  const f = fixture(t), left = f.add(2, 0, 0); f.publish(left);
  for (let z = 0; z < 3; z++) f.publish(f.add(1, 3, z));
  assert.equal(f.manager.groundNeighborhood.ready, 3);
  const leftMask = Array.from(left.partVisible as Uint8Array), parent = f.add(2, 1, 0);
  for (let z = 0; z < 3; z++) for (let x = 4; x <= 5; x++) f.add(1, x, z);
  f.publish(parent, true);
  assert.ok(parent.canonicalRequest); assert.equal(parent.installed, false);
  assert.equal(f.s.seamDeferred.size, 0, 'the incompatible preview is not another retained mesh');
  assert.deepEqual(Array.from(left.partVisible as Uint8Array), leftMask);
  f.s.pump(600, 160);
  assert.equal(f.s.workers[0].job.key, parent.key); assert.equal(f.s.workers[0].job.preview, false);
  let completed = 0, maxRetained = 0;
  while (!f.manager.groundNeighborhood.covered && completed < 16) {
    const { job } = f.finishJob(); completed++;
    assert.equal(job.preview, false, 'every completion in this dependency sequence is actual canonical geometry');
    maxRetained = Math.max(maxRetained, f.s.seamDeferred.size); assert.ok(maxRetained <= 8);
    for (let i = 0; i < 30 && f.s.seamDeferred.size; i++) f.s.retryDeferredSeam();
    f.s.pump(600, 160);
    assert.deepEqual(Array.from(left.partVisible as Uint8Array), leftMask, 'already-published left coverage never gains a mask gap');
  }
  assert.ok(completed > 1); assert.equal(f.manager.groundNeighborhood.ready, 9);
  assert.equal(f.manager.groundNeighborhood.covered, true); assert.equal(f.s.seamDeferred.size, 0);
  assert.equal(parent.canonicalRequest, null); assert.equal(parent.previewInstalled, false);
  for (let z = 0; z < 12; z++) for (let x = 0; x < 8; x++)
    assert.equal(parent.partVisible[z * 16 + x], 0, 'coarse leaves hide only after their canonical middle owner is installed');
});

test('cave-version changes restart ordinary admission; retirement/replacement cannot transfer the request mode', t => {
  const f = fixture(t), { parent } = f.afterFiner(); parent.caveDetail = true;
  f.s.pump(600, 160);
  assert.equal(parent.canonicalRequest, null); assert.equal(f.s.workers[0].job.preview, true);
  assert.equal(f.s.workers[0].job.caveDetail, true);
  const oldJob = f.s.workers[0].job;
  parent.retiring = true; f.s.desired.delete(parent.key); f.s.removeState(parent);
  f.s.compactQueue(); f.s.cancelObsoleteJobs();
  assert.equal(f.s.workers[0].job, null);
  const replacement = f.add(2, 1, 0);
  assert.notEqual(replacement, parent); assert.equal(replacement.canonicalRequest, null);
  f.s.pump(600, 160); const newJob = f.s.workers[0].job;
  assert.equal(newJob.preview, true);
  const stale = { ...f.message(parent, true, oldJob.requestId), caveDetail: oldJob.caveDetail };
  f.s.onMeshed(f.s.workers[0], stale);
  assert.equal(f.s.workers[0].job, newJob); assert.equal(replacement.installed, false);
  assert.equal(replacement.canonicalRequest, null);
});
