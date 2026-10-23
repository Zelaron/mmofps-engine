import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkManager } from '../src/render/chunks.js';
import { partitionChunkMeshes } from '../src/render/surfacenets.js';
import { meshBoundary, type BoundaryPlane, type BoundarySegment } from '../src/render/terrain-seams.js';
import { validateAuthoredSeams, spliceAuthoredBoundary, type AuthoredSeamPayload } from '../src/render/terrain-authored-seams.js';

class WorkerStub {
  onmessage: any = null; onerror: any = null; onmessageerror: any = null;
  messages: any[] = []; terminated = false;
  postMessage(message: unknown) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
(globalThis as any).Worker = WorkerStub;
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });

const segment = (lo: number, hi: number, y: number): BoundarySegment => ({
  a: { u: lo, y, r: 120, g: 120, b: 120, depth: 0 },
  b: { u: hi, y, r: 120, g: 120, b: 120, depth: 0 },
});
const heightsAt = (segments: readonly BoundarySegment[], u: number) => segments
  .filter(s => Math.min(s.a.u, s.b.u) < u && Math.max(s.a.u, s.b.u) > u)
  .map(s => s.a.y + (s.b.y - s.a.y) * (u - s.a.u) / (s.b.u - s.a.u)).sort((a, b) => a - b);
function payload(leafX = 0, leafZ = 0, side = 0,
  ranges = [leafZ * 32 + 8, leafZ * 32 + 24],
  segments = [segment(ranges[0]!, ranges[1]!, 2)]): AuthoredSeamPayload {
  return { version: 1, keys: new Int32Array([leafX, leafZ, side]),
    rangeOffsets: new Uint32Array([0, ranges.length]), ranges: new Float64Array(ranges),
    segmentOffsets: new Uint32Array([0, segments.length * 12]),
    segments: new Float64Array(segments.flatMap(s => [s.a.u, s.a.y, s.a.r, s.a.g, s.a.b, s.a.depth,
      s.b.u, s.b.y, s.b.r, s.b.g, s.b.b, s.b.depth])) };
}

// Actual partitioned mesh contours exercise the existing seam compatibility
// and transaction code. Only worker delivery and wall-clock pacing are fakes.
function geometry(st: any, heights: readonly number[]) {
  const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16, size = 32 * step;
  const x = st.cx * size, z = st.cz * size, p: number[] = [], n: number[] = [];
  heights.forEach((y, layer) => {
    const sign = layer % 2 === 0 ? 1 : -1;
    const corners = [[x, y, z], [x, y, z + size], [x + size, y, z + size], [x + size, y, z]];
    for (const i of sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
      p.push(...corners[i]!); n.push(0, sign, 0);
    }
  });
  const chunks = [{ cy: 0, positions: new Float32Array(p), normals: new Float32Array(n), colors: new Uint8Array(p.length).fill(120) }];
  return st.lod === 0 ? chunks : partitionChunkMeshes(chunks, x, z, size, step);
}

function fixture(t: TestContext, px = 16, pz = 16) {
  let serial = 100;
  t.mock.method(performance, 'now', () => 1000);
  const manager = new ChunkManager(1337, 1), s = manager as any;
  t.after(() => manager.dispose());
  t.mock.method(s.terrainWorld, 'column', () => { throw new Error('metadata lifecycle must not query the World'); });
  s.lastPx = px; s.lastPz = pz; s.flight = false; s.groundTravel = false;
  const add = (lod: number, cx: number, cz: number) => {
    s.ensureColumn(lod, cx, cz, false);
    const key = `${lod}:${cx},${cz}`; s.desired.add(key); return s.columns.get(key);
  };
  const message = (st: any, preview: boolean, reqId: number, authoredSeams?: unknown,
    heights: readonly number[] = [0]) => {
    const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16;
    return { type: 'meshed', reqId, cx: st.cx, cz: st.cz, step, preview,
      caveDetail: st.caveDetail, chunks: geometry(st, heights), authoredSeams,
      portals: { positions: new Float32Array(), ...(step > 1 ? { partGrid: step, partOffsets: new Uint32Array(step * step + 1) } : {}) } };
  };
  const publish = (st: any, authoredSeams?: unknown, preview = false, heights: readonly number[] = [0]) => {
    s.queue = s.queue.filter((q: any) => q !== st);
    st.status = 'meshing'; st.requestId = null;
    const msg = message(st, preview, ++serial, authoredSeams, heights);
    s.publishMesh(st, msg); return msg;
  };
  const dispatch = (st: any) => {
    st.status = 'queued';
    if (!s.queue.includes(st)) s.queue.push(st);
    const slot = s.workers[0]; slot.readyAt = 1000; slot.coverageReadyAt = 1000;
    s.pump(px, pz); assert.ok(slot.job, 'ordinary worker admission dispatched a request');
    assert.equal(slot.job.key, st.key); return { slot, job: slot.job };
  };
  const boundary = (st: any, leafX = 0, leafZ = 0) => {
    const plane: BoundaryPlane = { axis: 'x', boundary: leafX * 32, lo: leafZ * 32, hi: (leafZ + 1) * 32 };
    return s.seamBoundary(st, leafX, leafZ, `x:${leafX},${leafZ}`, plane) as BoundarySegment[];
  };
  return { manager, s, add, message, publish, dispatch, boundary };
}

test('authored metadata validates wholly and replaces only its owned interval; malformed/absent records preserve the original', () => {
  const original = [segment(0, 32, 0), segment(0, 32, -3)], good = payload();
  const plane: BoundaryPlane = { axis: 'x', boundary: 0, lo: 0, hi: 32 };
  assert.equal(validateAuthoredSeams(good, 0, 0, 4), true);
  const repaired = spliceAuthoredBoundary(original, good, 0, 0, plane);
  assert.notEqual(repaired, original);
  assert.deepEqual(heightsAt(repaired, 4), [-3, 0]);
  assert.deepEqual(heightsAt(repaired, 16), [2]);
  assert.deepEqual(heightsAt(repaired, 28), [-3, 0]);
  assert.deepEqual(original, [segment(0, 32, 0), segment(0, 32, -3)], 'input contours are not changed');
  for (const absent of [undefined, null])
    assert.equal(spliceAuthoredBoundary(original, absent as any, 0, 0, plane), original);
  assert.equal(spliceAuthoredBoundary(original, good, 1, 0, { ...plane, boundary: 32 }), original);
  assert.equal(spliceAuthoredBoundary(original, good, 0, 0, { axis: 'z', boundary: 0, lo: 0, hi: 32 }), original);

  const duplicate = { ...good, keys: new Int32Array([0, 0, 0, 0, 0, 0]),
    rangeOffsets: new Uint32Array([0, 2, 4]), ranges: new Float64Array([8, 24, 8, 24]),
    segmentOffsets: new Uint32Array([0, 12, 24]), segments: new Float64Array([...good.segments, ...good.segments]) };
  const badSecond = { ...duplicate, keys: new Int32Array([0, 0, 0, 0, 0, 1]),
    segments: new Float64Array([...good.segments, ...good.segments]) };
  badSecond.segments[13] = NaN;
  const records = Array.from({ length: 65 }, (_, i) => ({
    x: Math.floor(i / 4) % 16, z: Math.floor(i / 64), side: i % 4,
    lo: (i % 4 < 2 ? Math.floor(i / 64) : Math.floor(i / 4) % 16) * 32 + 8,
    hi: (i % 4 < 2 ? Math.floor(i / 64) : Math.floor(i / 4) % 16) * 32 + 24,
  }));
  const recordOverflow = { version: 1, keys: new Int32Array(records.flatMap(r => [r.x, r.z, r.side])),
    rangeOffsets: new Uint32Array(Array.from({ length: 66 }, (_, i) => i * 2)),
    ranges: new Float64Array(records.flatMap(r => [r.lo, r.hi])),
    segmentOffsets: new Uint32Array(Array.from({ length: 66 }, (_, i) => i * 12)),
    segments: new Float64Array(records.flatMap(r => [...payload(r.x, r.z, r.side, [r.lo, r.hi]).segments])) };
  const manyRanges = Array.from({ length: 1024 }, (_, i) => [i / 32, i / 32 + 1 / 64]).flat();
  const byteOverflow = payload(0, 0, 0, manyRanges,
    Array.from({ length: 512 }, (_, i) => segment(manyRanges[i * 2]!, manyRanges[i * 2 + 1]!, 2)));
  assert.ok([byteOverflow.keys, byteOverflow.rangeOffsets, byteOverflow.ranges,
    byteOverflow.segmentOffsets, byteOverflow.segments].reduce((n, a) => n + a.byteLength, 0) > 64 * 1024);
  const invalid: [string, unknown][] = [
    ['version', { ...good, version: 2 }], ['partial', { version: 1, keys: good.keys }],
    ['wrong array type', { ...good, keys: new Float64Array(good.keys) }],
    ['offset cardinality', { ...good, rangeOffsets: new Uint32Array([0]) }],
    ['odd range offset', { ...good, rangeOffsets: new Uint32Array([0, 1]) }],
    ['unconsumed segment scalar', { ...good, segmentOffsets: new Uint32Array([0, 0]) }],
    ['duplicate key', duplicate], ['invalid second record', badSecond],
    ['out-of-leaf range', { ...good, ranges: new Float64Array([-1, 24]) }],
    ['empty declared range', payload(0, 0, 0, [8, 24], [])],
    ['uncovered declared range', payload(0, 0, 0, [8, 24], [segment(8, 12, 2), segment(16, 24, 2)])],
    ['segment outside range', payload(0, 0, 0, [8, 24], [segment(7, 24, 2)])],
    ['non-finite', payload(0, 0, 0, [8, 24], [segment(8, 24, Infinity)])],
    ['segment cap', payload(0, 0, 0, [8, 24], Array.from({ length: 513 }, () => segment(8, 24, 2)))],
    ['record cap', recordOverflow], ['byte cap', byteOverflow],
  ];
  for (const [name, bad] of invalid) {
    assert.equal(validateAuthoredSeams(bad as any, 0, 0, 16), false, name);
    assert.equal(spliceAuthoredBoundary(original, bad as any, 0, 0, plane), original, `${name}: no partial correction`);
  }
  assert.equal(validateAuthoredSeams(payload(4, 0), 0, 0, 4), false, 'a different column cannot lend its metadata');
});

test('canonical publication commits payload with its version/cache; fresh candidates and previews never inherit it', t => {
  const f = fixture(t), st = f.add(1, 0, 0), good = payload();
  const first = f.publish(st, good);
  assert.equal(st.installed, true); assert.equal(st.authoredSeams, good);
  const oldVersion = st.seamVersion, oldCache = st.seamBoundaries;
  const corrected = f.boundary(st);
  assert.deepEqual(heightsAt(corrected, 16), [2]); assert.deepEqual(heightsAt(corrected, 4), [0]);
  assert.equal(f.boundary(st), corrected, 'cache belongs to the committed metadata generation');
  const fresh = f.s.seamCandidate(st, first.chunks, first.portals);
  assert.equal(fresh.authoredSeams, undefined, 'spread-copy cannot inherit the prior correction');
  assert.equal(st.authoredSeams, good, 'preparing a candidate cannot mutate the installed state');
  assert.equal(st.seamBoundaries, oldCache); assert.equal(st.seamVersion, oldVersion);

  f.publish(st);
  assert.equal(st.authoredSeams, undefined); assert.ok(st.seamVersion > oldVersion);
  assert.notEqual(st.seamBoundaries, oldCache); assert.deepEqual(heightsAt(f.boundary(st), 16), [0]);
  const parent = f.add(2, 1, 0), parentPayload = payload(16, 0);
  assert.equal(validateAuthoredSeams(parentPayload, 1, 0, 16), true);
  f.publish(parent, parentPayload, true);
  assert.equal(parent.installed, true); assert.equal(parent.previewInstalled, true);
  assert.equal(parent.authoredSeams, undefined, 'even structurally valid preview metadata is discarded');
  assert.deepEqual(heightsAt(f.boundary(parent, 16, 0), 16), [0]);
});

test('malformed metadata completes ordinary worker geometry without a restart or a partial seam correction', t => {
  const f = fixture(t), st = f.add(1, 0, 0), { slot, job } = f.dispatch(st), worker = slot.worker;
  const bad = payload(); bad.segments[1] = NaN;
  f.s.onMeshed(slot, f.message(st, false, job.requestId, bad));
  assert.equal(slot.worker, worker); assert.equal(worker.terminated, false);
  assert.equal(st.installed, true); assert.equal(st.status, 'ready'); assert.equal(st.authoredSeams, undefined);
  assert.deepEqual(heightsAt(f.boundary(st), 16), [0]);
  assert.equal(f.s.seamDeferred.size, 0, 'metadata rejection does not invent a geometry dependency');
});

test('stale request, cave generation and replaced column replies cannot publish authored metadata', t => {
  const f = fixture(t), st = f.add(1, 0, 0), installed = payload();
  f.publish(st, installed);
  const version = st.seamVersion, cache = st.seamBoundaries;
  const { slot, job } = f.dispatch(st), incoming = payload(0, 0, 0, [8, 24], [segment(8, 24, 3)]);
  f.s.onMeshed(slot, f.message(st, false, job.requestId - 1, incoming));
  assert.equal(slot.job, job); assert.equal(st.authoredSeams, installed);
  st.caveDetail = !job.caveDetail;
  const staleCave = { ...f.message(st, false, job.requestId, incoming), caveDetail: job.caveDetail };
  f.s.onMeshed(slot, staleCave);
  assert.equal(st.authoredSeams, installed); assert.equal(st.seamVersion, version); assert.equal(st.seamBoundaries, cache);
  assert.ok(slot.job); assert.notEqual(slot.job.requestId, job.requestId);
  const obsolete = slot.job, staleReplacement = { ...f.message(st, false, obsolete.requestId, incoming), caveDetail: obsolete.caveDetail };
  st.retiring = true; f.s.desired.delete(st.key); f.s.removeState(st);
  f.s.compactQueue(); f.s.cancelObsoleteJobs();
  const replacement = f.add(1, 0, 0), current = f.dispatch(replacement).job;
  assert.notEqual(replacement, st); assert.equal(replacement.authoredSeams, undefined);
  f.s.onMeshed(slot, staleReplacement);
  assert.equal(slot.job, current); assert.equal(replacement.installed, false); assert.equal(replacement.authoredSeams, undefined);
  f.s.onMeshed(slot, f.message(replacement, false, current.requestId));
  assert.equal(replacement.installed, true); assert.equal(replacement.authoredSeams, undefined);
});

test('real deferred slab publication retains metadata only on its candidate, then commits geometry/cache/masks together', t => {
  const f = fixture(t, 160, 160), parent = f.add(2, 0, 0);
  f.publish(parent, undefined, true, [21.14]);
  const oldMask = parent.partVisible, middle = f.add(1, 1, 1);
  const plane: BoundaryPlane = { axis: 'x', boundary: 128, lo: 128, hi: 160 };
  const raw = geometry(middle, [21.2, 20.08]);
  const contours = meshBoundary(raw, plane);
  assert.ok(contours.length >= 2, 'real finite slab supplies upper and lower contours');
  const good = payload(4, 4, 0, [128, 160], contours);
  assert.equal(validateAuthoredSeams(good, 1, 1, 4), true);
  f.publish(middle, good, false, [21.2, 20.08]);
  const pending = f.s.seamDeferred.get(middle.key); assert.ok(pending);
  assert.equal(middle.installed, false); assert.equal(middle.authoredSeams, undefined);
  assert.equal(middle.seamVersion, 0); assert.equal(pending.candidate.authoredSeams, good);
  assert.equal(parent.partVisible, oldMask, 'rejected metadata generation cannot change the published coverage');

  f.publish(parent, undefined, false, [21.2, 20.08]);
  let commits = 0;
  const commit = f.s.commitGeometry.bind(f.s);
  t.mock.method(f.s, 'commitGeometry', (state: any, candidate: any, prepared: any) => {
    if (state === middle) {
      assert.equal(state.authoredSeams, undefined); assert.equal(state.installed, false);
      assert.equal(candidate.authoredSeams, good); commits++;
    }
    commit(state, candidate, prepared);
    if (state === middle) {
      assert.equal(state.authoredSeams, candidate.authoredSeams);
      assert.equal(state.seamVersion, candidate.seamVersion); assert.equal(state.seamBoundaries, candidate.seamBoundaries);
    }
  });
  for (let i = 0; i < 30 && !middle.installed; i++) f.s.retryDeferredSeam();
  assert.equal(commits, 1); assert.equal(middle.installed, true); assert.equal(middle.authoredSeams, good);
  assert.equal(f.s.seamDeferred.size, 0);
  for (let z = 4; z < 8; z++) for (let x = 4; x < 8; x++) assert.equal(parent.partVisible[z * 16 + x], 0);
  assert.deepEqual(heightsAt(f.boundary(middle, 4, 4), 144), [Math.fround(20.08), Math.fround(21.2)]);
});
