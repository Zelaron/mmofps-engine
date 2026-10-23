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

function fixture(t: TestContext) {
  let now = 1000, serial = 10;
  t.mock.method(performance, 'now', () => now);
  const manager = new ChunkManager(1337, 1), s = manager as any;
  t.after(() => manager.dispose());
  t.mock.method(s, 'pump', () => {});
  t.mock.method(s.terrainWorld, 'column', () => { throw new Error('eviction must not query the World'); });
  const add = (lod: number, cx: number, cz: number) => {
    s.ensureColumn(lod, cx, cz, false);
    const key = `${lod}:${cx},${cz}`; s.desired.add(key); return s.columns.get(key);
  };
  const message = (st: any, preview = false, empty = false) => {
    const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16, size = 32 * step;
    const x = st.cx * size, z = st.cz * size;
    const positions = new Float32Array([x, 0, z, x, 0, z + size, x + size, 0, z + size,
      x, 0, z, x + size, 0, z + size, x + size, 0, z]);
    const normals = new Float32Array(positions.length);
    for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
    const raw = [{ cy: 0, positions, normals, colors: new Uint8Array(positions.length).fill(120) }];
    return { type: 'meshed', reqId: ++serial, cx: st.cx, cz: st.cz, step, preview,
      caveDetail: false, chunks: empty ? [] : step === 1 ? raw : partitionChunkMeshes(raw, x, z, size, step),
      portals: { positions: new Float32Array(), ...(step > 1 ?
        { partGrid: step, partOffsets: new Uint32Array(step * step + 1) } : {}) } };
  };
  const retain = (st: any) => {
    const msg = message(st), candidate = s.seamCandidate(st, msg.chunks, msg.portals);
    st.status = 'ready';
    s.seamDeferred.set(st.key, { state: st, candidate, msg, keys: s.seamKeys(st), dirty: true });
    return s.seamDeferred.get(st.key);
  };
  const original = s.prepareSeam.bind(s);
  t.mock.method(s, 'prepareSeam', (key: string, replacements: Map<string, unknown>) => {
    if (replacements) now++;
    return original(key, replacements);
  });
  const step = () => { s.flushMeshes(); assert.ok(s.installMs <= 3, 'original soft preparation budget'); };
  const finish = (st: any) => {
    for (let i = 0; i < 230 && !st.installed; i++) step();
    assert.equal(st.installed, true, 'finite staged work eventually publishes');
  };
  return { manager, s, add, message, retain, step, finish };
}

test('repeated unpublished fine eviction preserves staged coarse work and eventual real geometry publication', t => {
  const f = fixture(t), coarse = f.add(2, 0, 0);
  f.retain(coarse); f.step();
  const transaction = f.s.seamTransaction;
  assert.ok(transaction.edgeIndex > 0 && transaction.edgeIndex < transaction.keys.length);
  for (let frame = 0; frame < 210 && !coarse.installed; frame++) {
    const neverPublished = f.add(0, 1 + frame % 14, 1);
    f.s.desired.delete(neverPublished.key);
    f.s.removeState(neverPublished);
    assert.equal(f.s.seamDeferred.get(coarse.key).dirty, false);
    const priorEdge = transaction.edgeIndex;
    f.step();
    if (!coarse.installed) {
      assert.equal(f.s.seamTransaction, transaction, 'selection churn cannot restart unchanged ownership');
      assert.ok(transaction.edgeIndex >= priorEdge);
    }
  }
  assert.equal(coarse.installed, true);
  assert.ok(coarse.meshes[0].geometry.getAttribute('position').count > 0);
  assert.equal(f.s.seamDeferred.size, 0);
});

test('installed canonical, preview and empty geometry removals retain seam and parent-mask invalidation', t => {
  for (const mode of ['canonical', 'preview', 'empty']) {
    const f = fixture(t), st = f.add(mode === 'preview' ? 2 : 0, 0, 0);
    const msg = f.message(st, mode === 'preview', mode === 'empty');
    f.s.publishMesh(st, msg);
    assert.equal(st.installed, true);
    f.s.seamDirty.clear(); f.s.seamMaskDirty.clear();
    let wakes = 0;
    const wake = f.s.wakeDeferredSeams.bind(f.s);
    t.mock.method(f.s, 'wakeDeferredSeams', (keys: Set<string>) => { wakes++; wake(keys); });
    f.s.removeState(st);
    assert.ok(wakes > 0 && f.s.seamDirty.size > 0, `${mode} ownership removal remains observable`);
    if (st.lod === 0) assert.ok(f.s.seamMaskDirty.has('1:0,0') && f.s.seamMaskDirty.has('2:0,0'));
    assert.equal(f.s.columns.has(st.key), false);
  }
});

test('removing an unpublished deferred member invalidates its actual prospective transaction', t => {
  const f = fixture(t), coarse = f.add(2, 0, 0), middle = f.add(1, 1, 1);
  const retained = f.retain(coarse); f.retain(middle); f.step();
  const old = f.s.seamTransaction;
  assert.equal(old.members.length, 2);
  f.s.desired.delete(middle.key); f.s.removeState(middle);
  assert.equal(retained.dirty, true, 'unpublished retained geometry is still a real dependency');
  f.step();
  assert.notEqual(f.s.seamTransaction, old);
  assert.equal(f.s.seamTransaction.members.length, 1);
  assert.equal(f.s.seamTransaction.replacements.has(middle.key), false);
  f.finish(coarse);
  assert.equal(middle.installed, false); assert.equal(f.s.columns.has(middle.key), false);
  assert.equal(f.s.seamDeferred.size, 0);
});

test('removed in-flight unpublished state cannot return through a stale reply or erase worker rest', t => {
  const f = fixture(t), coarse = f.add(2, 0, 0), removed = f.add(0, 2, 2);
  f.retain(coarse); f.step();
  const transaction = f.s.seamTransaction, msg = f.message(removed), slot = f.s.workers[0];
  removed.requestId = msg.reqId; removed.status = 'meshing';
  slot.job = { key: removed.key, requestId: msg.reqId, cx: removed.cx, cz: removed.cz,
    step: 1, caveDetail: false, preview: false };
  slot.readyAt = 1900; slot.coverageReadyAt = 1500;
  f.s.desired.delete(removed.key); f.s.removeState(removed); f.s.cancelObsoleteJobs();
  const replacement = f.add(0, 2, 2);
  f.s.onMeshed(slot, msg);
  assert.equal(replacement.installed, false); assert.equal(replacement.requestId, null);
  assert.equal(slot.readyAt, 1900); assert.equal(slot.coverageReadyAt, 1500);
  assert.equal(f.s.seamTransaction, transaction);
  assert.equal(f.s.seamDeferred.get(coarse.key).dirty, false);
  assert.equal(f.s.pendingMeshes.length, 0);
});
