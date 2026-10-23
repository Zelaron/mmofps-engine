import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { ChunkManager } from '../src/render/chunks.js';
import { RockRenderer } from '../src/render/rocks.js';

class FakeWorker {
  onmessage: any = null; onerror: any = null; onmessageerror: any = null;
  messages: any[] = []; terminated = false;
  postMessage(message: any) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
(globalThis as any).Worker = FakeWorker;
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });

const leftRock = { x: -3080.5826, z: -5267.6345, hx: 2.4435, hz: 2.0732 };
const rightRock = { x: -2927.7641, z: -5304.8146, hx: 2.3858, hz: 2.2873 };
function fixture(t: TestContext) {
  const manager = new ChunkManager(1337, 1), s = manager as any;
  t.after(() => manager.dispose());
  s.lastPx = -3000; s.lastPz = -5141;
  t.mock.method(s.terrainWorld, 'column', () => { throw new Error('support must not query the World'); });
  function add(lod: number, cx: number, cz: number, installed = false) {
    const st = { key: `${lod}:${cx},${cz}`, lod, cx, cz, caveDetail: false,
      status: installed ? 'ready' : 'queued', requestId: null as number | null, installed,
      installedCaveDetail: installed ? true : null, previewInstalled: false,
      retiring: false, meshes: [], portalMeshes: [], parts: null, portalParts: null,
      partGrid: 0, partVisible: null, seamSource: [], seamPortalSource: null };
    s.columns.set(st.key, st); s.desired.add(st.key); if (!installed) s.queue.push(st); return st;
  }
  add(1, -24, -41, true);
  const left = add(1, -25, -42), right = add(1, -23, -42), slot = s.workers[0];
  function publish(footprints = [leftRock, rightRock]) {
    s.setSceneryGroundSupport(Math.floor(s.lastPx / 64), Math.floor(s.lastPz / 64), footprints);
  }
  function active(lod: number, cx: number, cz: number) {
    const st = add(lod, cx, cz); s.queue = s.queue.filter((item: any) => item !== st);
    st.requestId = 900; st.status = 'meshing';
    slot.job = { key: st.key, requestId: 900, cx, cz, step: lod === 0 ? 1 : lod === 1 ? 4 : 16,
      caveDetail: false, preview: lod === 2 }; return st;
  }
  return { manager, s, add, left, right, slot, publish, active,
    pump: () => s.pump(s.lastPx, s.lastPz),
    requests: () => slot.worker.messages.filter((m: any) => m.type === 'mesh'),
    cancellations: () => slot.worker.messages.filter((m: any) => m.type === 'cancel') };
}

test('protected footprint proximity beats misleading middle-tile center order', t => {
  const f = fixture(t); f.publish();
  const leftCenter = Math.hypot(-3136 - f.s.lastPx, -5312 - f.s.lastPz);
  const rightCenter = Math.hypot(-2880 - f.s.lastPx, -5312 - f.s.lastPz);
  assert.ok(rightCenter < leftCenter, 'fixture reproduces the original wrong-side center preference');
  f.pump();
  assert.equal(f.slot.job.key, f.left.key);
  assert.equal(f.requests().at(-1).urgentCoverage, false, 'support retains ordinary pacing');
});

test('new support pauses only obsolete fine work and retains ordinary rest before dispatch', t => {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const f = fixture(t), oldWorker = f.slot.worker, fine = f.active(0, -94, -160);
  f.slot.readyAt = 1200; f.slot.coverageReadyAt = 1000;
  f.publish(); f.pump();
  assert.deepEqual(f.cancellations(), [{ type: 'cancel', reqId: 900 }]);
  assert.equal(f.slot.worker, oldWorker); assert.equal(oldWorker.terminated, false);
  assert.equal(fine.status, 'queued'); assert.equal(fine.requestId, null);
  assert.equal(f.slot.job, null); assert.equal(f.slot.readyAt, 1200);
  assert.equal(f.requests().length, 0, 'support does not take the urgent shorter deadline');
  now = 1200; f.pump(); assert.equal(f.slot.job.key, f.left.key);
  assert.equal(f.requests()[0].urgentCoverage, false);
  f.publish([rightRock, leftRock]); f.pump(); f.pump();
  assert.equal(f.cancellations().length, 1, 'hints never preempt support for support');
});

test('current fine, cave enclosure, route/coarse jobs and completed uploads remain untouched', t => {
  for (const guard of ['current', 'cave', 'route', 'coarse', 'upload', 'flight']) {
    const f = fixture(t);
    const active = guard === 'current' ? f.active(0, -94, -161) : guard === 'route' ? f.active(1, -24, -43) :
      guard === 'coarse' ? f.active(2, -7, -11) : f.active(0, -94, -160);
    f.publish();
    if (guard === 'cave') f.s.lastUnderground = true;
    if (guard === 'flight') f.s.flight = true;
    if (guard === 'upload') f.s.pendingMeshes.push({ slot: f.slot, worker: f.slot.worker, msg: {} });
    f.pump();
    assert.equal(f.slot.job?.key, active.key, guard);
    assert.equal(f.cancellations().length, 0, guard);
  }
});

test('urgent route and missing nearby coarse keep priority over scenery support', t => {
  {
    const f = fixture(t), route = f.add(1, -24, -43);
    f.publish(); f.s.groundTravel = true; f.s.groundForecastSeconds = 4;
    t.mock.method(f.s, 'groundCoverageKeys', () => new Map([[route.key, .25]]));
    f.pump(); assert.equal(f.slot.job.key, route.key); assert.equal(f.requests()[0].urgentCoverage, true);
  }
  {
    const f = fixture(t), preview = f.add(2, -7, -11);
    f.publish(); f.pump(); assert.equal(f.slot.job.key, preview.key);
  }
});

test('support is bounded to nine selected middle keys and invalidated on completion or travel', t => {
  const f = fixture(t);
  for (let z = -44; z <= -38; z++) for (let x = -27; x <= -21; x++)
    if (!f.s.columns.has(`1:${x},${z}`)) f.add(1, x, z);
  f.publish([{ x: -3000, z: -5141, hx: 10000, hz: 10000 }]);
  assert.ok(f.s.scenerySupport.size <= 9);
  for (const key of f.s.scenerySupport.keys()) {
    const st = f.s.columns.get(key); assert.ok(Math.abs(st.cx + 24) <= 1 && Math.abs(st.cz + 41) <= 1);
  }
  f.publish([leftRock]); assert.equal(f.s.scenerySupport.size, 1);
  f.add(0, -97, -165, true);
  assert.equal(f.s.scenerySupportKeys(f.s.lastPx, f.s.lastPz).size, 0, 'fine footprint completion also clears the request');
  f.s.columns.delete('0:-97,-165'); f.publish([leftRock]);
  f.s.desired.delete(f.left.key);
  assert.equal(f.s.scenerySupportKeys(f.s.lastPx, f.s.lastPz).size, 0, 'deselection is final');
  f.s.desired.add(f.left.key); f.publish([leftRock]);
  f.s.lastPx += 4096;
  assert.equal(f.s.scenerySupportKeys(f.s.lastPx, f.s.lastPz).size, 0, 'teleport cannot retain old-location hints');
  f.manager.dispose(); f.publish([leftRock]); assert.equal(f.s.scenerySupport.size, 0);
});

test('a footprint crossing a tile edge requests each missing selected support part', t => {
  const f = fixture(t); f.publish([{ x: -3072, z: -5267, hx: 3, hz: 3 }]);
  // The right half lies in a newly selected middle row, not the installed
  // camera row. Both parts matter; installed fine support clears only its half.
  const next = f.add(1, -24, -42);
  f.publish([{ x: -3072, z: -5267, hx: 3, hz: 3 }]);
  assert.deepEqual([...f.s.scenerySupport.keys()].sort(), [f.left.key, next.key].sort());
  next.installed = true;
  assert.deepEqual([...f.s.scenerySupportKeys(f.s.lastPx, f.s.lastPz).keys()], [f.left.key]);
});

test('scheduled admitted-rock refresh publishes support without hiding props or doing same-cell scans', t => {
  const near = { x: 80, y: 5, z: 20, hx: 2, hy: 3, hz: 2, r: .5 };
  const far = { x: 600, y: 8, z: 20, hx: 2, hy: 3, hz: 2, r: .5 };
  let reads = 0, ready = false;
  const world = { collectBoulders: () => { reads++; return [near, far]; }, column: () => ({ desert: 0 }) };
  const terrain = { sceneryCoverageRevision: 0, sceneryGroundReady: () => ready };
  const calls: any[] = [];
  const renderer = new RockRenderer(world as any, undefined, terrain, (cx, cz, rocks) => calls.push({ cx, cz, rocks }));
  t.after(() => renderer.dispose());
  renderer.update(0, 0); assert.equal(renderer.count, 1, 'near collider remains visible over incomplete terrain');
  assert.deepEqual(calls[0].rocks, [near]);
  for (let i = 0; i < 60; i++) renderer.update(i, i);
  assert.equal(reads, 1); assert.equal(calls.length, 1, 'existing spatial/revision refresh is the only publisher');
  ready = true; terrain.sceneryCoverageRevision++;
  renderer.update(60, 60); assert.deepEqual(calls.at(-1).rocks, []); assert.equal(renderer.count, 2);
  const transform = new THREE.Matrix4();
  for (const pool of renderer.group.children as THREE.InstancedMesh[]) for (let i = 0; i < pool.count; i++) {
    pool.getMatrixAt(i, transform); assert.ok([near.y, far.y].includes(transform.elements[13]));
  }
  renderer.dispose(); assert.deepEqual(calls.at(-1).rocks, []);
});
