import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkManager } from '../src/render/chunks.js';
import { partitionChunkMeshes } from '../src/render/surfacenets.js';

class WorkerStub {
  onmessage: any = null; onerror: any = null; onmessageerror: any = null;
  messages: any[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  terminate() {}
}
(globalThis as any).Worker = WorkerStub;
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });

function geometry(st: any, slab: boolean) {
  const scale = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16, size = 32 * scale;
  const x = st.cx * size, z = st.cz * size, p: number[] = [], n: number[] = [];
  for (const [y, sign] of slab ? [[21.2, 1], [20.08, -1]] : [[21.14, 1]]) {
    const corners = [[x, y, z], [x, y, z + size], [x + size, y, z + size], [x + size, y, z]];
    for (const i of sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
      p.push(...corners[i]); n.push(0, sign, 0);
    }
  }
  const chunks = [{ cy: 0, positions: new Float32Array(p), normals: new Float32Array(n), colors: new Uint8Array(p.length).fill(120) }];
  return st.lod === 0 ? chunks : partitionChunkMeshes(chunks, x, z, size, scale);
}

function fixture(t: TestContext) {
  let now = 1000, serial = 10;
  t.mock.method(performance, 'now', () => now);
  const manager = new ChunkManager(1337, 1), s = manager as any;
  t.after(() => manager.dispose());
  t.mock.method(s.terrainWorld, 'column', () => { throw new Error('dependency scheduling must not query the World'); });
  s.lastPx = 160; s.lastPz = 160; s.flight = false; s.groundTravel = false;
  const add = (lod: number, cx: number, cz: number) => {
    s.ensureColumn(lod, cx, cz, false);
    const key = `${lod}:${cx},${cz}`; s.desired.add(key); return s.columns.get(key);
  };
  const publish = (st: any, preview = false, slab = !preview) => {
    s.queue = s.queue.filter((candidate: any) => candidate !== st);
    st.status = 'meshing'; st.requestId = null;
    const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16;
    const msg = { type: 'meshed', reqId: ++serial, cx: st.cx, cz: st.cz, step, preview,
      caveDetail: st.caveDetail, chunks: geometry(st, slab),
      portals: { positions: new Float32Array(), ...(step > 1 ? { partGrid: step, partOffsets: new Uint32Array(step * step + 1) } : {}) } };
    s.publishMesh(st, msg); return msg;
  };
  const parent = add(2, 0, 0); publish(parent, true);
  const middle = add(1, 1, 1); publish(middle);
  assert.equal(middle.installed, false, 'the real finite slab cannot publish over a one-contour preview');
  assert.equal(s.seamDeferred.size, 1);
  const dependencies = () => s.seamPreviewDependencyStates() as Map<string, Set<any>>;
  return { manager, s, parent, middle, add, publish, dependencies, at: (time: number) => { now = time; } };
}

test('actual rejected slab promotes its existing canonical parent ahead of blocked refinement, with unchanged ordinary rest', t => {
  const f = fixture(t), slot = f.s.workers[0];
  const oldMesh = f.parent.meshes[0], oldMask = f.parent.partVisible;
  assert.ok(f.dependencies().get(f.parent.key)?.has(f.middle));
  slot.readyAt = 2000; slot.coverageReadyAt = 1000;
  f.s.pump(160, 160);
  assert.equal(slot.job, null, 'dependency cannot consume the shorter current-ground deadline');
  assert.equal(f.parent.meshes[0], oldMesh); assert.equal(f.parent.partVisible, oldMask);
  f.at(2000); f.s.pump(160, 160);
  assert.equal(slot.job.key, f.parent.key);
  assert.equal(slot.job.preview, false, 'replace the already-installed preview canonically');
  assert.ok(f.parent.priority < -11_000_000, 'parent inherits current middle priority ahead of fine refinement');
  assert.equal(slot.worker.messages.at(-1).urgentCoverage, false, 'native worker keeps its ordinary pacing ratio');
});

test('running canonical dependency survives waiting fine urgency; stale request replies cannot release it', t => {
  const f = fixture(t), slot = f.s.workers[0];
  f.add(0, 5, 5); f.s.pump(160, 160);
  const job = slot.job, worker = slot.worker;
  assert.equal(job.key, f.parent.key);
  f.s.pump(160, 160);
  assert.equal(slot.job, job, 'do not cancel necessary parent work for its own blocked fine child');
  f.s.onMeshed(slot, { type: 'meshed', reqId: job.requestId - 1 });
  assert.equal(slot.job, job, 'old request cannot free the active dependency');
  assert.equal(slot.worker, worker);
  assert.ok(!worker.messages.some((m: any) => m.type === 'cancel'));
  f.middle.caveDetail = true;
  f.s.pump(160, 160);
  assert.notEqual(slot.job, job, 'cave-version change removes the obsolete dependency protection');
  assert.ok(worker.messages.some((m: any) => m.type === 'cancel'));
});

test('preview replacement remains blocked; only compatible canonical replacement releases local publication and masks', t => {
  const f = fixture(t), oldMask = f.parent.partVisible;
  f.publish(f.parent, true);
  f.s.retryDeferredSeam();
  assert.equal(f.middle.installed, false);
  assert.equal(f.parent.previewInstalled, true);
  assert.equal(f.parent.partVisible, oldMask, 'refreshing a preview cannot uncover the incompatible child');
  assert.ok(f.dependencies().has(f.parent.key), 'new preview version is rediscovered by the failed edge');
  f.publish(f.parent, false);
  assert.equal(f.parent.previewInstalled, false);
  assert.equal(f.dependencies().size, 0, 'canonical publication immediately clears borrowed priority');
  for (let i = 0; i < 30 && !f.middle.installed; i++) f.s.retryDeferredSeam();
  assert.equal(f.middle.installed, true);
  assert.equal(f.s.seamDeferred.size, 0);
  for (let z = 4; z < 8; z++) for (let x = 4; x < 8; x++) assert.equal(f.parent.partVisible[z * 16 + x], 0);
});

test('known canonical message overrides its candidate inherited preview flag without inventing compatibility', t => {
  const f = fixture(t);
  let canonicalCandidate: any;
  const original = f.s.seamCandidate.bind(f.s);
  t.mock.method(f.s, 'seamCandidate', (st: any, ...args: any[]) => {
    const candidate = original(st, ...args);
    if (st === f.parent) canonicalCandidate = candidate;
    return candidate;
  });
  // Deliberately incompatible canonical one-contour geometry tests metadata,
  // not a fake successful join. The inherited flag is still true at creation.
  f.publish(f.parent, false, false);
  assert.equal(canonicalCandidate.previewInstalled, true);
  assert.equal(f.s.seamCandidateMessages.get(canonicalCandidate).preview, false);
  f.s.retryDeferredSeam();
  assert.equal(f.middle.installed, false, 'canonical metadata never bypasses the topology gate');
  assert.equal(f.dependencies().size, 0, 'a canonical one-contour owner is not mislabeled as a missing preview replacement');
});

test('deselection, retirement, cave/request changes and replaced owner generations invalidate only stale dependency evidence', t => {
  const changes = [
    (f: any) => f.s.desired.delete(f.middle.key),
    (f: any) => { f.middle.retiring = true; },
    (f: any) => { f.middle.caveDetail = true; },
    (f: any) => { f.middle.requestId = 999; },
    (f: any) => f.s.columns.set(f.middle.key, { ...f.middle }),
    (f: any) => f.s.desired.delete(f.parent.key),
    (f: any) => { f.parent.retiring = true; },
    (f: any) => { f.parent.seamVersion++; },
    (f: any) => f.s.columns.set(f.parent.key, { ...f.parent }),
  ];
  for (const change of changes) {
    const f = fixture(t); assert.equal(f.dependencies().size, 1);
    change(f); assert.equal(f.dependencies().size, 0);
  }
});

test('eight-result cap eviction permits rediscovery then parent dispatch, instead of repeating the nine-tile cycle', t => {
  const f = fixture(t);
  for (let z = 0; z < 3; z++) for (let x = 0; x < 3; x++) {
    if (x === 1 && z === 1) continue;
    f.publish(f.add(1, x, z));
  }
  assert.equal(f.s.seamDeferred.size, 8);
  assert.equal(f.s.seamDeferred.has(f.middle.key), false, 'the first current result was evicted under the unchanged cap');
  assert.equal(f.middle.status, 'queued');
  // A regenerated current response records the actual blocker again even if
  // no earlier witness survived. This must immediately choose the parent.
  for (const pending of f.s.seamDeferred.values()) f.s.seamCandidateMessages.get(pending.candidate).dependencies.clear();
  f.publish(f.middle);
  assert.equal(f.s.seamDeferred.size, 8);
  f.s.pump(160, 160);
  assert.equal(f.s.workers[0].job.key, f.parent.key);
  assert.equal(f.s.workers[0].job.preview, false);
  assert.equal(f.s.seamDeferred.size, 8, 'priority requires no additional retained meshes');
});

test('clear/dispose releases dependency metadata while shared geometry is still owned by normal terrain cleanup', t => {
  const f = fixture(t), metadata = f.s.seamCandidateMessages;
  assert.equal(f.dependencies().size, 1);
  f.manager.dispose();
  assert.equal(f.dependencies().size, 0);
  assert.equal(f.s.seamDeferred.size, 0);
  assert.notEqual(f.s.seamCandidateMessages, metadata);
  f.manager.dispose();
});
