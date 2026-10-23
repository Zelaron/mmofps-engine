import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { ChunkManager } from '../src/render/chunks.js';
import { RockRenderer } from '../src/render/rocks.js';

class WorkerStub {
  onmessage: any = null; onerror: any = null; onmessageerror: any = null;
  messages: any[] = []; terminated = false;
  postMessage(message: any) { this.messages.push(message); }
  terminate() { this.terminated = true; }
}
(globalThis as any).Worker = WorkerStub;
Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });
const target = { x: -2934.5954, z: -5010.3788, hx: 2.9182, hz: 3.4324 };
function fixture(t: TestContext) {
  let now = 1000; t.mock.method(performance, 'now', () => now);
  const manager = new ChunkManager(1337, 1), s = manager as any;
  t.after(() => manager.dispose());
  s.lastPx = -3000; s.lastPz = -4820;
  s.groundTravel = true; s.groundMotionVx = 0; s.groundMotionVz = -81; s.groundMotionAt = now;
  t.mock.method(s.terrainWorld, 'column', () => { throw new Error('support must not generate terrain'); });
  function add(lod: number, cx: number, cz: number, installed = false) {
    const st = { key: `${lod}:${cx},${cz}`, lod, cx, cz, caveDetail: false,
      status: installed ? 'ready' : 'queued', requestId: null as number | null, installed,
      installedCaveDetail: installed ? true : null, previewInstalled: false, retiring: false,
      meshes: [], portalMeshes: [], parts: null, portalParts: null, partGrid: 0, partVisible: null,
      seamSource: [], seamPortalSource: null };
    s.columns.set(st.key, st); s.desired.add(st.key); if (!installed) s.queue.push(st); return st;
  }
  add(1, -24, -38, true);
  const tile = add(1, -23, -40);
  return { manager, s, add, tile, now: (value: number) => { now = value; },
    publish: (current: typeof target[] = [], future = [target]) =>
      s.setSceneryGroundSupport(Math.floor(s.lastPx / 64), Math.floor(s.lastPz / 64), current, future),
    keys: () => s.scenerySupportKeys(s.lastPx, s.lastPz),
    pump: () => s.pump(s.lastPx, s.lastPz) };
}

test('two-cell support uses fresh velocity and remains within128m even at diagonal corners', t => {
  const f = fixture(t);
  assert.deepEqual(f.manager.scenerySupportFutureCells(), [{ cellX: -47, cellZ: -77 }, { cellX: -47, cellZ: -78 }]);
  for (const speed of [13, 40, 81, 180]) for (const age of [1000 / 60, 25, 1000 / 30]) {
    f.s.groundMotionVz = -speed; f.now(1000 + age);
    assert.deepEqual(f.manager.scenerySupportFutureCells(), [{ cellX: -47, cellZ: -77 }, { cellX: -47, cellZ: -78 }]);
  }
  f.now(1000);
  f.s.groundMotionVz = 81;
  assert.deepEqual(f.manager.scenerySupportFutureCells(), [{ cellX: -47, cellZ: -75 }, { cellX: -47, cellZ: -74 }]);
  f.s.lastPx = 32; f.s.lastPz = 32; f.s.groundMotionVx = 81;
  assert.deepEqual(f.manager.scenerySupportFutureCells(), [{ cellX: 1, cellZ: 1 }], 'second diagonal crossing lies135.76m away');
  f.s.lastPx = -6000; f.s.lastPz = 4000; f.s.groundMotionVx = 0; f.s.groundMotionVz = -81;
  assert.deepEqual(f.manager.scenerySupportFutureCells(), [{ cellX: -94, cellZ: 61 }, { cellX: -94, cellZ: 60 }], 'teleport uses new position, no old delta');
  f.now(1251); assert.deepEqual(f.manager.scenerySupportFutureCells(), []);
  f.now(999); assert.deepEqual(f.manager.scenerySupportFutureCells(), []);
});

test('cached future protection may request the selected next row before it enters the current3x3', t => {
  const f = fixture(t); f.publish();
  assert.equal(Math.abs(f.tile.cz - Math.floor(f.s.lastPz / 128)), 2);
  assert.equal(f.keys().get(f.tile.key).future, true);
  f.pump(); assert.equal(f.s.workers[0].job.key, f.tile.key);
  assert.equal(f.s.workers[0].worker.messages.at(-1).urgentCoverage, false);
  assert.equal(f.s.columns.size, 2, 'no new terrain selection');
});

test('current support reserves both priority and the hard nine-key capacity before future demand', t => {
  const f = fixture(t), current = f.add(1, -25, -37);
  const currentRock = { x: -3180, z: -4680, hx: 2, hz: 2 };
  f.publish([currentRock]);
  assert.equal(f.keys().get(current.key).future, false);
  assert.equal(f.keys().get(f.tile.key).future, true);
  f.pump(); assert.equal(f.s.workers[0].job.key, current.key, 'current demand wins even when its footprint is farther');
  for (let z = -39; z <= -37; z++) for (let x = -25; x <= -23; x++) {
    const key = `1:${x},${z}`, old = f.s.columns.get(key);
    if (old) { old.installed = false; old.status = 'queued'; } else f.add(1, x, z);
  }
  f.publish([{ x: -3000, z: -4820, hx: 10000, hz: 10000 }]);
  assert.equal(f.s.scenerySupport.size, 9);
  assert.equal(f.s.scenerySupport.has(f.tile.key), false, 'future cannot displace current support');
});

test('future identity survives small turns but drops on direction, stop, mode, age or cell changes', t => {
  const f = fixture(t), current = f.add(1, -25, -38);
  const currentRock = { x: -3130, z: -4800, hx: 2, hz: 2 };
  f.publish([currentRock]); const retained = f.s.scenerySupport.get(f.tile.key);
  f.s.groundMotionVx = .2; f.keys();
  assert.equal(f.s.scenerySupport.get(f.tile.key), retained, 'same next cell does not churn entries');
  f.s.groundMotionVx = -81; f.s.groundMotionVz = 0;
  assert.equal(f.keys().has(f.tile.key), false); assert.ok(f.keys().has(current.key));
  for (const mode of ['stopped', 'flight', 'cave', 'stale']) {
    f.s.groundTravel = true; f.s.flight = false; f.s.lastUnderground = false;
    f.s.groundMotionVx = 0; f.s.groundMotionVz = -81; f.s.groundMotionAt = 1000; f.now(1000);
    f.publish([currentRock]);
    if (mode === 'stopped') f.s.groundTravel = false;
    if (mode === 'flight') f.s.flight = true;
    if (mode === 'cave') f.s.lastUnderground = true;
    if (mode === 'stale') f.now(1251);
    f.keys(); assert.equal(f.s.scenerySupport.has(f.tile.key), false, mode);
    assert.equal(f.s.scenerySupport.has(current.key), true, mode);
  }
  f.s.flight = false; f.s.lastUnderground = false; f.s.groundTravel = true; f.now(1000);
  f.publish([currentRock]); f.s.lastPz -= 128;
  assert.equal(f.keys().size, 0); assert.equal(f.s.scenerySupport.size, 0);
});

test('future requests retain ordinary debt and cannot interrupt already useful middle work', t => {
  const f = fixture(t), fine = f.add(0, -96, -150), slot = f.s.workers[0];
  fine.status = 'meshing'; fine.requestId = 900; f.s.queue = f.s.queue.filter((s: any) => s !== fine);
  slot.job = { key: fine.key, requestId: 900, cx: fine.cx, cz: fine.cz, step: 1, preview: false, caveDetail: true };
  slot.readyAt = 1200; slot.coverageReadyAt = 1000;
  f.publish(); f.pump(); assert.equal(slot.job, null); assert.equal(slot.readyAt, 1200);
  assert.equal(slot.worker.messages.filter((m: any) => m.type === 'mesh').length, 0);
  f.now(1200); f.s.groundMotionAt = 1200; f.pump(); assert.equal(slot.job.key, f.tile.key);
  const cancels = slot.worker.messages.filter((m: any) => m.type === 'cancel').length;
  f.s.groundMotionVx = -81; f.s.groundMotionVz = 0; f.publish(); f.pump();
  assert.equal(slot.job.key, f.tile.key);
  assert.equal(slot.worker.messages.filter((m: any) => m.type === 'cancel').length, cancels);
});

test('future publication reuses cached placements without visibility changes or same-cell rescans', t => {
  const near = { x: -3000, y: 80, z: -4820, hx: 2, hy: 2, hz: 2, r: .5 };
  const ahead = { ...target, y: 84.40408397027268, hy: 3.037225, r: .87546 };
  let reads = 0, next = [{ cellX: -47, cellZ: -77 }, { cellX: -47, cellZ: -78 }];
  const world = { collectBoulders: () => { reads++; return [near, ahead]; }, column: () => ({ desert: 0 }) };
  const terrain = { sceneryCoverageRevision: 0, sceneryGroundReady: () => false, scenerySupportFutureCells: () => next };
  const calls: any[] = [];
  const renderer = new RockRenderer(world as any, undefined, terrain,
    (cx, cz, current, future) => calls.push({ cx, cz, current, future }));
  t.after(() => renderer.dispose());
  renderer.update(-3000, -4820);
  assert.equal(renderer.count, 1, 'future demand cannot expose a far collider early');
  assert.deepEqual(calls.at(-1).current, [near]); assert.deepEqual(calls.at(-1).future, [ahead]);
  for (let i = 0; i < 60; i++) renderer.update(-3000, -4820 - i / 10);
  assert.equal(reads, 1); assert.equal(calls.length, 1);
  next = [{ cellX: -48, cellZ: -76 }, { cellX: -49, cellZ: -76 }]; renderer.update(-3000, -4826);
  assert.equal(reads, 1); assert.deepEqual(calls.at(-1).future, []);
  next = []; renderer.update(-3000, -4826);
  assert.equal(reads, 1); assert.deepEqual(calls.at(-1).future, []);
  assert.equal(renderer.count, 1); assert.equal(calls.length, 3);
});

test('worker-side stale pruning is republished after same-cell same-direction motion resumes', t => {
  const f = fixture(t); let reads = 0;
  const near = { x: -3000, y: 80, z: -4820, hx: 2, hy: 2, hz: 2, r: .5 };
  const ahead = { ...target, y: 84.4, hy: 3, r: .8 };
  const world = { collectBoulders: () => { reads++; return [near, ahead]; }, column: () => ({ desert: 0 }) };
  const renderer = new RockRenderer(world as any, undefined, f.manager, f.manager.setSceneryGroundSupport.bind(f.manager));
  t.after(() => renderer.dispose());
  renderer.update(f.s.lastPx, f.s.lastPz);
  assert.ok(f.s.scenerySupport.has(f.tile.key));
  const revision = f.manager.scenerySupportRevision;
  f.now(1251); f.keys();
  assert.equal(f.s.scenerySupport.has(f.tile.key), false);
  assert.ok(f.manager.scenerySupportRevision > revision);
  f.now(1300); f.s.groundMotionAt = 1300;
  renderer.update(f.s.lastPx, f.s.lastPz);
  assert.ok(f.s.scenerySupport.has(f.tile.key), 'same identity must not hide the publication lost between scheduled refreshes');
  assert.equal(reads, 1, 'existing cached placements suffice');
});
