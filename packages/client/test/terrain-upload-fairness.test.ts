import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkManager } from '../src/render/chunks.js';

class WorkerStub {
  onmessage: any = null; onerror: any = null; onmessageerror: any = null;
  messages: unknown[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
  terminate() {}
}
(globalThis as any).Worker = WorkerStub;
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });

function fixture(t: TestContext, coarseX = 10) {
  let now = 1000, serial = 100;
  t.mock.method(performance, 'now', () => now);
  const manager = new ChunkManager(1337, 1), s = manager as any;
  t.after(() => manager.dispose());
  t.mock.method(s, 'pump', () => {});
  t.mock.method(s.terrainWorld, 'column', () => { throw new Error('upload admission must not generate world columns'); });
  s.lastPx = 16; s.lastPz = 16; s.groundTravel = true;
  s.lookX = 256; s.lookZ = 0;
  const add = (lod: number, x: number, z: number, cave = false) => {
    s.ensureColumn(lod, x, z, cave);
    const key = `${lod}:${x},${z}`; s.desired.add(key); return s.columns.get(key);
  };
  const message = (st: any, preview = false) => {
    const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16;
    return { type: 'meshed', reqId: ++serial, cx: st.cx, cz: st.cz, step, preview,
      caveDetail: st.caveDetail, chunks: [], portals: step === 4 ?
        { positions: new Float32Array(), partGrid: 4, partOffsets: new Uint32Array(17) } :
        { positions: new Float32Array() } };
  };
  const coarse = add(2, coarseX, 0), coarseMsg = message(coarse, true);
  const candidate = s.seamCandidate(coarse, coarseMsg.chunks, coarseMsg.portals);
  coarse.status = 'ready';
  s.seamDeferred.set(coarse.key, { state: coarse, candidate, msg: coarseMsg, keys: s.seamKeys(coarse), dirty: true });
  const prepare = s.prepareSeam.bind(s);
  // Native topology still runs; only its cost is controlled. A coarse result
  // requires many slices, reproducing the starvation without machine timing.
  t.mock.method(s, 'prepareSeam', (key: string, replacements: Map<string, unknown>) => {
    if (replacements?.has(coarse.key)) now++;
    return prepare(key, replacements);
  });
  const pending = (st: any, preview = false, slot = s.workers[0]) => {
    const msg = message(st, preview);
    st.requestId = msg.reqId; st.status = 'meshing';
    slot.job = { key: st.key, requestId: msg.reqId, cx: st.cx, cz: st.cz,
      step: msg.step, preview, caveDetail: st.caveDetail };
    const entry = { slot, worker: slot.worker, msg }; s.pendingMeshes.push(entry); return entry;
  };
  const extraSlot = () => {
    const slot = { ...s.workers[0], worker: new WorkerStub(), job: null, watchdog: null };
    s.workers.push(slot); return slot;
  };
  return { manager, s, coarse, add, pending, extraSlot, spend: (ms: number) => { now += ms; } };
}

test('urgent ready terrain bypasses a full staged-preview slice and that transaction resumes afterward', t => {
  const f = fixture(t);
  f.s.flushMeshes();
  const transaction = f.s.seamTransaction, priorEdge = transaction.edgeIndex;
  assert.ok(priorEdge > 0 && !f.coarse.installed);
  const ground = f.add(1, 1, 0, true), reply = f.pending(ground);
  const selected = [...f.s.desired];
  f.s.flushMeshes();
  assert.equal(ground.installed, true, 'ready route tile reaches normal validated publication this frame');
  assert.equal(reply.slot.job, null, 'the worker is released for subsequent route work');
  assert.equal(f.s.seamTransaction, transaction);
  assert.equal(transaction.edgeIndex, priorEdge, 'no second full preparation slice in bypass frame');
  assert.deepEqual([...f.s.desired], selected, 'urgency reads do not change selection');
  for (let i = 0; i < 220 && !f.coarse.installed; i++) {
    f.s.flushMeshes(); assert.ok(f.s.installMs <= 3, 'unchanged staged preparation budget');
  }
  assert.ok(f.coarse.installed, 'deferred work resumes and commits when no urgent reply is waiting');
});

test('walking, cave and cold-preview completions use their existing current-coverage urgency', t => {
  for (const mode of ['walking', 'cave', 'cold-preview']) {
    const f = fixture(t); f.s.groundTravel = false;
    if (mode === 'walking') {
      const preview = f.add(2, 0, 0); preview.installed = true; preview.previewInstalled = true;
    }
    f.s.lastUnderground = mode === 'cave';
    const st = f.add(mode === 'cold-preview' ? 2 : 1, 0, 0, mode === 'cave');
    f.pending(st, mode === 'cold-preview');
    f.s.flushMeshes();
    assert.equal(st.installed, true, mode);
    assert.equal(f.s.seamTransaction, null, 'deferred slice did not also begin');
  }
});

test('ordinary distant replies cannot continually displace a staged preview transaction', t => {
  const f = fixture(t), distant = f.add(1, -8, -8, true);
  f.pending(distant);
  let previous = 0;
  for (let i = 0; i < 10; i++) {
    f.s.flushMeshes();
    assert.ok(f.s.seamTransaction.edgeIndex > previous);
    previous = f.s.seamTransaction.edgeIndex;
    assert.equal(distant.installed, false);
    assert.equal(f.s.pendingMeshes.length, 1);
    assert.equal(f.s.installMs, 3);
  }
});

test('stale workers, requests and cave versions do not consume the real urgent completion opportunity', t => {
  const f = fixture(t), valid = f.add(1, 1, 0, true), entry = f.pending(valid);
  const obsolete = f.add(1, 2, 0, false), oldSlot = f.extraSlot(), old = f.pending(obsolete, false, oldSlot);
  obsolete.caveDetail = true;
  f.s.pendingMeshes = [
    { ...entry, worker: new WorkerStub() },
    { ...entry, msg: { ...entry.msg, reqId: entry.msg.reqId - 1 } },
    old, entry,
  ];
  f.s.flushMeshes();
  assert.equal(valid.installed, true);
  assert.equal(obsolete.installed, false, 'old surface payload never installs as cave detail');
  assert.equal(f.s.seamTransaction, null, 'real urgent reply gets the one bypass despite stale entries ahead');
});

test('upload priority follows the current route rather than a completion launch direction', t => {
  const f = fixture(t), oldRoute = f.add(1, 2, 0, true);
  f.pending(oldRoute); f.s.lookX = 0; f.s.lookZ = -256;
  f.s.flushMeshes();
  assert.equal(oldRoute.installed, false);
  const transaction = f.s.seamTransaction, prior = transaction.edgeIndex;
  const actualRoute = f.add(1, 0, -1, true); f.pending(actualRoute, false, f.extraSlot());
  f.s.flushMeshes();
  assert.equal(actualRoute.installed, true);
  assert.equal(transaction.edgeIndex, prior);
});

test('urgent admission retains the two-upload count and existing soft time limit without a second seam budget', t => {
  for (const cost of [1, 4]) {
    const f = fixture(t), entries: any[] = [];
    for (let x = 0; x < 3; x++) entries.push(f.pending(f.add(1, x, 0, true), false, x ? f.extraSlot() : undefined));
    let calls = 0;
    t.mock.method(f.s, 'onMeshed', () => { calls++; f.spend(cost); });
    f.s.flushMeshes();
    assert.equal(calls, cost === 1 ? 2 : 1);
    assert.equal(f.s.seamTransaction, null, 'staged work receives no extra budget in an urgent-upload frame');
    assert.equal(f.s.pendingMeshes.length, 3 - calls);
  }
});

test('a prioritized result that needs its deferred neighbor still publishes both atomically', t => {
  const f = fixture(t, 0), canonical = f.add(1, 1, 0, true);
  const install = f.s.installGeometry.bind(f.s);
  t.mock.method(f.s, 'installGeometry', (st: any, ...args: unknown[]) => st === canonical ? false : install(st, ...args));
  f.pending(canonical); f.s.flushMeshes();
  assert.equal(canonical.installed, false);
  assert.equal(f.coarse.installed, false);
  assert.equal(f.s.seamDeferred.size, 2, 'priority cannot bypass incompatible topology');
  for (let i = 0; i < 230 && !canonical.installed; i++) {
    f.s.flushMeshes();
    assert.equal(canonical.installed, f.coarse.installed, 'no intermediate ownership publication');
  }
  assert.ok(canonical.installed && f.coarse.installed);
  assert.equal(f.s.seamDeferred.size, 0);
});
