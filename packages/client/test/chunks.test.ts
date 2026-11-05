import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World, cavePathPoint, MAT } from '@shared/worldgen';
import {
  CAVE_FOG_FAR, CAVE_HORIZON_RADIUS, CAVE_MESH_RADIUS, CHUNK_SIZE,
  LOD1_RADIUS, LOD1_STEP,
} from '@shared/constants';
import { ChunkManager } from '../src/render/chunks.js';
import { meshTerrainPreview } from '../src/render/terrain-preview.js';
import {
  partitionChunkMeshes, meshColumnChunks, type ChunkMesh, type EntrancePortalMesh,
} from '../src/render/surfacenets.js';

interface MeshRequest {
  type: 'mesh';
  reqId: number;
  cx: number;
  cz: number;
  caveDetail: boolean;
  step: number;
  urgentCoverage?: boolean;
}

class FakeWorker {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null = null;
  onerror: ((ev: ErrorEvent) => unknown) | null = null;
  onmessageerror: ((ev: MessageEvent<unknown>) => unknown) | null = null;
  readonly messages: unknown[] = [];
  terminated = false;

  postMessage(msg: unknown): void {
    this.messages.push(msg);
  }

  terminate(): void {
    this.terminated = true;
  }
}

(globalThis as unknown as { Worker: typeof Worker }).Worker =
  FakeWorker as unknown as typeof Worker;

interface TestParts {
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  offsets: Uint32Array;
}

interface TestState {
  key: string;
  cx: number;
  cz: number;
  lod: 0 | 1 | 2;
  caveDetail: boolean;
  status: 'queued' | 'meshing' | 'ready';
  requestId: number | null;
  installed: boolean;
  installedCaveDetail: boolean | null;
  previewInstalled?: boolean;
  canonicalRequest: { previewReqId: number; caveDetail: boolean } | null;
  retiring: boolean;
  meshes: THREE.Mesh[];
  portalMeshes: THREE.Mesh[];
  parts: TestParts | null;
  portalParts: { positions: Float32Array; offsets: Uint32Array } | null;
  partGrid: number;
  partVisible: Uint8Array | null;
}

interface TestJob {
  key: string;
  requestId: number;
  cx: number;
  cz: number;
  step: number;
  caveDetail: boolean;
  preview?: boolean;
}

interface TestSlot {
  worker: FakeWorker;
  job: TestJob | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  readyAt: number;
  coverageReadyAt: number;
}

interface TestMeshed {
  type: 'meshed';
  reqId: number;
  cx: number;
  cz: number;
  caveDetail: boolean;
  step: number;
  chunks: ChunkMesh[];
  portals: EntrancePortalMesh;
  preview?: boolean;
}

interface ChunkInternals {
  columns: Map<string, TestState>;
  queue: TestState[];
  desired: Set<string>;
  workers: TestSlot[];
  pump(px: number, pz: number): void;
  flushMeshes(): void;
  portalGroup: THREE.Group;
  onMeshed(slot: TestSlot, msg: TestMeshed): void;
  syncCoarseVisibility(): void;
  coarseVisibility(st: TestState): Uint8Array;
  removeState(st: TestState): void;
  cancelObsoleteJobs(): void;
  advanceEmergencyCoverage(now: number): void;
  emergencyPreview: { key: string; builder: { sampledColumns: number } } | null;
  lastUnderground: boolean;
  flight: boolean;
  groundTravel: boolean;
  groundTurnRate: number;
  groundMotionVx: number;
  groundMotionVz: number;
  groundPath: { x: number; z: number; seconds: number }[];
  updateGroundForecast(px: number, pz: number, vx: number, vz: number, speed: number, seconds: number): void;
  yieldGroundWorker(urgent: ReadonlySet<string>, ground?: ReadonlyMap<string, number>): void;
  lookX: number;
  lookZ: number;
  terrainWorld: World;
  roads: { update(x: number, z: number): void };
  coveredAt(x: number, z: number, cave?: boolean, canonicalGround?: boolean): boolean;
}

function internals(manager: ChunkManager): ChunkInternals {
  return manager as unknown as ChunkInternals;
}

test('scenery readiness requires complete installed canonical footprints and publishes coverage revisions', (t) => {
  const manager = new ChunkManager(1337, 1), state = internals(manager);
  t.mock.method(state.terrainWorld, 'column', () => { throw new Error('readiness must not sample the world'); });
  const add = (lod: 0 | 1 | 2, cx: number, cz: number): TestState => {
    const st: TestState = { key: `${lod}:${cx},${cz}`, lod, cx, cz, caveDetail: false,
      status: 'queued', requestId: null, installed: false, installedCaveDetail: null, canonicalRequest: null,
      retiring: false, meshes: [], portalMeshes: [], parts: null, portalParts: null, partGrid: 0, partVisible: null };
    state.columns.set(st.key, st); state.desired.add(st.key); return st;
  };
  let request = 100;
  const install = (st: TestState, preview = false) => {
    const slot = state.workers[0], step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16;
    st.requestId = ++request; st.status = 'meshing';
    slot.job = { key: st.key, requestId: request, cx: st.cx, cz: st.cz, step, caveDetail: false, preview };
    state.onMeshed(slot, { type: 'meshed', reqId: request, cx: st.cx, cz: st.cz,
      step, caveDetail: false, preview, chunks: [], portals: emptyPortals(step) });
  };
  try {
    install(add(2, 0, 0), true);
    assert.equal(manager.sceneryCoverageRevision, 0, 'a visible coarse preview cannot release props');
    assert.equal(manager.sceneryGroundReady(16, 16, 2, 2), false);
    const middle = add(1, 0, 0);
    assert.equal(manager.sceneryGroundReady(16, 16, 2, 2), false, 'queued canonical geometry does not count');
    install(middle);
    assert.ok(manager.sceneryCoverageRevision > 0);
    assert.equal(manager.sceneryGroundReady(16, 16, 2, 2), true);
    assert.equal(manager.sceneryGroundReady(127, 16, 2, 2), false, 'a prop spanning the edge needs both sides');
    const adjacent = add(0, 4, 0); install(adjacent);
    assert.equal(manager.sceneryGroundReady(127, 16, 2, 2), true, 'mixed installed fine and middle tiles cover the footprint');
    const beforeEvict = manager.sceneryCoverageRevision;
    state.removeState(adjacent);
    assert.ok(manager.sceneryCoverageRevision > beforeEvict);
    assert.equal(manager.sceneryGroundReady(127, 16, 2, 2), false);
    // Four supported corners cannot prove the intervening terrain exists.
    for (let z = 0; z < 3; z++) for (let x = 8; x < 11; x++) {
      if (x === 9 && z === 1) continue;
      const st = add(0, x, z); st.installed = true; st.installedCaveDetail = false;
    }
    assert.equal(manager.sceneryGroundReady(304, 48, 47, 47), false, 'an interior missing leaf rejects the full footprint');
    install(add(0, 9, 1));
    assert.equal(manager.sceneryGroundReady(304, 48, 47, 47), true);
    assert.equal(manager.sceneryGroundReady(NaN, 0, 1, 1), false);
    assert.equal(manager.sceneryGroundReady(16, 16, -1, 1), false);
    const beforeQueuedRemoval = manager.sceneryCoverageRevision;
    state.removeState(add(0, -2, -2));
    assert.equal(manager.sceneryCoverageRevision, beforeQueuedRemoval, 'removing a queued job does not invalidate scenery');
  } finally { manager.dispose(); }
  assert.equal(manager.sceneryGroundReady(16, 16, 2, 2), false);
});

test('local terrain rest gates every dispatch and keeps camera priorities current', (t) => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });
  t.after(() => {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const manager = new ChunkManager(1337, 1), state = internals(manager);
  try {
    for (const cx of [0, 10, 20]) {
      const column: TestState = { key: `0:${cx},0`, cx, cz: 0, lod: 0,
        caveDetail: false, status: 'queued', requestId: null, installed: false,
        installedCaveDetail: null, canonicalRequest: null, retiring: false, meshes: [], portalMeshes: [],
        parts: null, portalParts: null, partGrid: 0, partVisible: null };
      state.columns.set(column.key, column); state.queue.push(column); state.desired.add(column.key);
    }
    state.pump(0, 0);
    const slot = state.workers[0], worker = slot.worker;
    const request = worker.messages.at(-1) as MeshRequest;
    assert.equal(request.cx, 0);
    now = 1100;
    const result = new MessageEvent('message', { data: { ...request, type: 'meshed',
      chunks: [], portals: emptyPortals(1), workMs: 100 } });
    worker.onmessage?.(result);
    state.flushMeshes();
    assert.equal(worker.messages.length, 2, 'completion-triggered pump respects the rest');
    assert.equal(manager.streaming.restingWorkers, 1);
    now = 1150; worker.onmessage?.(result);
    assert.equal(slot.readyAt, 1400, 'a duplicate result cannot extend the background rest');
    assert.equal(slot.coverageReadyAt, 1200, 'urgent coverage retains its original deadline');
    state.pump(640, 0);
    now = 1399; state.pump(640, 0);
    assert.equal(worker.messages.length, 2, 'frame-triggered pumps also respect the rest');
    now = 1400; state.pump(640, 0);
    assert.equal(worker.messages.length, 3);
    assert.equal((worker.messages.at(-1) as MeshRequest).cx, 20,
      'dispatch uses the current camera priority rather than the old nearest tile');
    assert.equal(manager.streaming.restingWorkers, 0);
  } finally { manager.dispose(); }
});

test('ground neighborhood distinguishes a covered camera from complete surrounding canonical terrain and caches reads', (t) => {
  const { manager, state, add } = localCoverageFixture(t);
  t.mock.method(state, 'pump', () => {});
  t.mock.method(state.terrainWorld, 'column', () => { throw new Error('installed coverage must not query the world'); });
  const fine = add(0, 0, 0); complete(manager, fine);
  const preview = add(2, 0, 0); preview.installed = preview.previewInstalled = true;
  assert.equal(manager.streaming.currentGroundCovered, true);
  assert.equal(manager.groundNeighborhood.covered, false);
  assert.equal(manager.groundNeighborhood.ready, 0, 'one fine cell is not its whole 128m neighborhood tile');
  const get = state.columns.get.bind(state.columns); let reads = 0;
  t.mock.method(state.columns, 'get', (key: string) => { reads++; return get(key); });
  const before = manager.groundNeighborhood;
  assert.equal(manager.groundNeighborhood, before);
  assert.equal(reads, 0, 'unchanged diagnostic reads do no tile traversal');
  for (let z = -1; z <= 1; z++) for (let x = -1; x <= 1; x++) {
    if (x || z) complete(manager, add(1, x, z));
  }
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
    if (x || z) complete(manager, add(0, x, z));
  }
  reads = 0;
  assert.deepEqual(manager.groundNeighborhood, { covered: true, ready: 9, total: 9, missing: [] });
  assert.ok(reads <= 153, `bounded neighborhood lookup count: ${reads}`);
  state.removeState(fine);
  assert.deepEqual(manager.groundNeighborhood.missing, ['1:0,0'], 'stationary eviction invalidates complete fine coverage');
  const middle = add(1, 0, 0);
  assert.equal(manager.groundNeighborhood.covered, false, 'queued replacement is not installed terrain');
  complete(manager, middle);
  assert.equal(manager.groundNeighborhood.covered, true, 'stationary completion invalidates the cached deficit');
  state.lastUnderground = true;
  assert.equal(manager.groundNeighborhood.ready, 0, 'surface tiles cannot certify the surrounding cave enclosure');
  middle.caveDetail = true; complete(manager, middle);
  assert.equal(manager.groundNeighborhood.ready, 1);
});

test('ground neighborhood follows negative-coordinate boundary walks and teleports with a fixed nine-tile footprint', (t) => {
  const { manager, state, add } = localCoverageFixture(t);
  t.mock.method(state, 'pump', () => {});
  Object.assign(state, { lastPx: -1, lastPz: -1 });
  for (let z = -2; z <= 0; z++) for (let x = -2; x <= 0; x++) complete(manager, add(1, x, z));
  const covered = manager.groundNeighborhood;
  assert.equal(covered.covered, true);
  Object.assign(state, { lastPx: -127, lastPz: -100 });
  assert.equal(manager.groundNeighborhood, covered, 'motion inside a middle tile keeps the cached footprint');
  Object.assign(state, { lastPx: 0 });
  assert.deepEqual(manager.groundNeighborhood.missing, ['1:1,-2', '1:1,-1', '1:1,0']);
  Object.assign(state, { lastPx: 4096, lastPz: -8192 });
  assert.equal(manager.groundNeighborhood.total, 9); assert.equal(manager.groundNeighborhood.ready, 0);
  assert.equal(manager.groundNeighborhood.missing.length, 9, 'teleport does not accumulate old neighborhood keys');
  manager.dispose();
  assert.equal(manager.groundNeighborhood.covered, false);
});

function localCoverageFixture(t: TestContext) {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname: 'localhost' } });
  t.after(() => {
    if (previousLocation) Object.defineProperty(globalThis, 'location', previousLocation);
    else Reflect.deleteProperty(globalThis, 'location');
  });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  const manager = new ChunkManager(1337, 1), state = internals(manager);
  t.after(() => manager.dispose());
  const add = (lod: 0 | 1 | 2, cx: number, cz: number, caveDetail = false) => {
    const st: TestState = { key: `${lod}:${cx},${cz}`, cx, cz, lod, caveDetail,
      status: 'queued', requestId: null, installed: false, installedCaveDetail: null, canonicalRequest: null,
      retiring: false, meshes: [], portalMeshes: [], parts: null, portalParts: null, partGrid: 0, partVisible: null };
    state.columns.set(st.key, st); state.queue.push(st); state.desired.add(st.key);
    return st;
  };
  return { manager, state, add, at: (time: number) => { now = time; } };
}

test('local current ground gets canonical coverage after its preview while other refinement waits', (t) => {
  const { manager, state, add, at } = localCoverageFixture(t);
  add(2, 0, 0); add(0, 0, 0); add(1, 0, 0); add(2, 2, 0);
  state.pump(1, 1);
  const slot = state.workers[0], worker = slot.worker;
  assert.equal(slot.job!.key, '2:0,0', 'initial coverage dispatch is immediate');
  const request = worker.messages.at(-1) as MeshRequest;
  assert.equal(request.urgentCoverage, true);
  at(1100); worker.onmessage!({ data: { ...request, type: 'meshed', preview: true,
    chunks: [], portals: emptyPortals(16), workMs: 100 } } as MessageEvent);
  state.flushMeshes();
  assert.equal(manager.stats.columnsReady, 0, 'preview remains queued for canonical refinement');
  assert.equal(manager.currentCoverageReady, true, 'installed preview releases local startup without waiting for refinement');
  assert.equal(slot.readyAt, 1400);
  assert.equal(slot.coverageReadyAt, 1200);
  at(1199); state.pump(1025, 1);
  assert.equal(slot.job, null, 'camera travel cannot shorten the existing coverage rest');
  at(1200); state.pump(1, 1);
  assert.equal(slot.job!.key, '1:0,0', 'current canonical ground precedes fine refinement and distant previews');
  const canonical = worker.messages.at(-1) as MeshRequest;
  assert.equal(canonical.urgentCoverage, true);
  assert.equal(slot.readyAt, 1400, 'current coverage cannot erase the background deadline');
  at(1300); worker.onmessage!({ data: { ...canonical, type: 'meshed', chunks: [],
    portals: emptyPortals(4), workMs: 100 } } as MessageEvent);
  state.flushMeshes();
  assert.equal(manager.streaming.currentGroundCovered, true);
  at(1400); state.pump(1, 1);
  assert.equal(slot.job, null, 'installed canonical ground ends urgency; the full fine ring waits its normal rest');
  state.pump(1025, 1);
  assert.equal(slot.job!.key, '2:2,0', 'the current missing footprint uses the earlier deadline');
});

test('walking across a canonical boundary yields unrelated work without losing rest or accepting stale output', (t) => {
  const { manager, state, add, at } = localCoverageFixture(t);
  const coarse = add(2, 0, 0), oldGround = add(1, 0, 0);
  for (const st of [coarse, oldGround]) { st.installed = true; st.status = 'ready'; st.installedCaveDetail = false; }
  add(0, 3, 0);
  state.pump(127, 1);
  const slot = state.workers[0], worker = slot.worker, old = worker.messages.at(-1) as MeshRequest;
  assert.equal(slot.job!.key, '0:3,0');
  add(0, 4, 0); add(1, 1, 0); add(2, 1, 0);
  slot.readyAt = 1900; slot.coverageReadyAt = 1500;
  at(1400); state.pump(129, 1);
  assert.equal(slot.job, null);
  assert.deepEqual(worker.messages.at(-1), { type: 'cancel', reqId: old.reqId });
  assert.equal(slot.worker, worker); assert.equal(worker.terminated, false);
  assert.equal(slot.readyAt, 1900); assert.equal(slot.coverageReadyAt, 1500);
  at(1499); state.pump(129, 1); assert.equal(slot.job, null);
  at(1500); state.pump(129, 1);
  assert.equal(slot.job!.key, '1:1,0', 'the new current tile wins even beside a closer fine-tile centre');
  const canonical = worker.messages.at(-1) as MeshRequest;
  assert.equal(canonical.urgentCoverage, true);
  for (let frame = 1; frame <= 20; frame++) { at(1500 + frame * 16); state.pump(129 + frame * .15, 1); }
  assert.equal(worker.messages.at(-1), canonical, 'useful current canonical work is never cancelled by repeated pumps');
  worker.onmessage!({ data: { ...old, type: 'meshed', chunks: [], portals: emptyPortals(1), paced: true } } as MessageEvent);
  assert.equal(slot.job!.requestId, canonical.reqId); assert.equal(manager.streaming.waitingUploads, 0);
  assert.equal(state.coveredAt(129, 1, false, true), false);
  at(1850); worker.onmessage!({ data: { ...canonical, type: 'meshed', chunks: [],
    portals: emptyPortals(4), workMs: 100 } } as MessageEvent);
  state.flushMeshes();
  assert.equal(state.coveredAt(129, 1, false, true), true);
  assert.equal(worker.messages.filter((msg: any) => msg.type === 'init').length, 1);
});

test('current foot urgency preserves an active fine job instead of repeatedly replacing it with middle coverage', (t) => {
  const { state, add, at } = localCoverageFixture(t);
  const coarse = add(2, 0, 0); coarse.installed = true; coarse.status = 'ready';
  add(0, 0, 0); state.pump(1, 1);
  const slot = state.workers[0], worker = slot.worker, fine = worker.messages.at(-1) as MeshRequest;
  assert.equal(slot.job!.key, '0:0,0'); assert.equal(fine.urgentCoverage, true);
  add(1, 0, 0); add(2, 1, 0);
  for (let frame = 1; frame <= 60; frame++) { at(1000 + frame * 16); state.pump(1 + frame * .1, 1); }
  assert.equal(worker.messages.at(-1), fine);
  assert.equal(worker.messages.filter((msg: any) => msg.type === 'cancel').length, 0);
  at(2000); worker.onmessage!({ data: { ...fine, type: 'meshed', chunks: [],
    portals: emptyPortals(1), workMs: 100 } } as MessageEvent);
  state.flushMeshes();
  assert.equal(state.coveredAt(7, 1, false, true), true);
  at(2100); state.pump(7, 1);
  assert.equal(slot.job, null, 'middle refinement has no urgency once current fine terrain is installed');
});

test('cooperative terrain initializes local pacing and does not rest twice after an atomic result', (t) => {
  const { manager, state, add, at } = localCoverageFixture(t);
  add(2, 0, 0); add(0, 0, 0);
  const slot = state.workers[0], worker = slot.worker;
  assert.deepEqual(worker.messages[0], { type: 'init', seed: 1337, cooperative: true });
  state.pump(1, 1);
  const request = worker.messages.at(-1) as MeshRequest;
  assert.equal(request.urgentCoverage, true);
  at(1100); worker.onmessage!({ data: { ...request, type: 'meshed', preview: true,
    chunks: [], portals: emptyPortals(16), workMs: 100, elapsedMs: 205, maxSliceMs: 9, slices: 20, paced: true } } as MessageEvent);
  assert.equal(slot.readyAt, 1100); assert.equal(slot.coverageReadyAt, 1100);
  state.flushMeshes();
  assert.equal(manager.currentCoverageReady, true);
  assert.equal(slot.job!.key, '0:0,0', 'refinement continues after the worker already paid its rests');
  assert.equal((worker.messages.at(-1) as MeshRequest).urgentCoverage, true, 'preview-only current ground still needs canonical coverage');
});

test('local travel cancels obsolete work on the warm worker and fences late output before reassignment', (t) => {
  const { manager, state, add } = localCoverageFixture(t);
  const obsolete = add(2, 0, 0); add(2, 2, 0);
  state.pump(1, 1);
  const slot = state.workers[0], worker = slot.worker, oldRequest = worker.messages.at(-1) as MeshRequest;
  state.removeState(obsolete); state.cancelObsoleteJobs();
  assert.equal(slot.worker, worker); assert.equal(worker.terminated, false);
  assert.deepEqual(worker.messages.at(-1), { type: 'cancel', reqId: oldRequest.reqId });
  state.pump(1025, 1); const replacement = worker.messages.at(-1) as MeshRequest;
  assert.equal(replacement.cx, 2); assert.notEqual(replacement.reqId, oldRequest.reqId);
  worker.onmessage!({ data: { ...oldRequest, type: 'meshed', preview: true,
    chunks: [], portals: emptyPortals(16), paced: true, workMs: 100 } } as MessageEvent);
  state.flushMeshes();
  assert.equal(slot.job!.requestId, replacement.reqId);
  assert.equal(manager.streaming.waitingUploads, 0);
  assert.equal(worker.messages.filter((msg: any) => msg.type === 'init').length, 1, 'travel retains the same World and caches');
  manager.dispose(); assert.equal(worker.terminated, true, 'final disposal still releases the real worker');
});

test('local flight urgency covers an unmeshed crossed tile even when current and endpoint tiles are installed', (t) => {
  const { state, add, at } = localCoverageFixture(t);
  const current = add(2, 0, 0), endpoint = add(2, 2, 0);
  current.installed = endpoint.installed = true;
  current.status = endpoint.status = 'ready';
  add(2, 1, 0); add(2, 1, 1);
  state.flight = true; state.lookX = 768; state.lookZ = 0;
  const slot = state.workers[0]; slot.readyAt = 1750; slot.coverageReadyAt = 1250;
  at(1249); state.pump(400, 100);
  assert.equal(slot.job, null);
  at(1250); state.pump(400, 100);
  assert.equal(slot.job!.key, '2:1,0', 'missing land crossed before the endpoint cannot wait for background refinement');
  assert.equal((slot.worker.messages.at(-1) as MeshRequest).urgentCoverage, true);
  assert.equal(state.columns.get('2:1,1')!.status, 'queued', 'off-course terrain remains background work');
});

test('local underground urgency requires canonical cave enclosure and stops once that enclosure is installed', (t) => {
  const { manager, state, add, at } = localCoverageFixture(t);
  const surface = add(2, 0, 0); surface.installed = true; surface.status = 'ready';
  add(0, 0, 0, true); add(1, 0, 0, true); add(1, 1, 0, true);
  state.lastUnderground = true;
  assert.equal(manager.currentCoverageReady, false, 'an exterior preview cannot release underground startup');
  const slot = state.workers[0]; slot.readyAt = 1750; slot.coverageReadyAt = 1250;
  at(1249); state.pump(1, 1);
  assert.equal(slot.job, null);
  at(1250); state.pump(1, 1);
  assert.equal(slot.job!.key, '1:0,0', 'surface preview cannot replace the first real walls around the camera');
  assert.equal((slot.worker.messages.at(-1) as MeshRequest).urgentCoverage, true);
  const request = slot.worker.messages.at(-1) as MeshRequest;
  at(1350); slot.worker.onmessage!({ data: { ...request, type: 'meshed',
    chunks: [], portals: emptyPortals(4), workMs: 100 } } as MessageEvent);
  state.flushMeshes();
  assert.equal(state.columns.get('1:0,0')!.installedCaveDetail, true);
  assert.equal(manager.currentCoverageReady, true, 'canonical cave enclosure releases underground startup');
  at(1450); state.pump(1, 1);
  assert.equal(slot.job, null, 'canonical enclosure prevents nearby cave detail from bypassing background rest');
  at(1650); state.pump(1, 1);
  assert.equal(slot.job!.key, '1:1,0', 'surrounding canonical ground advances with ordinary background rest');
  const surrounding = slot.worker.messages.at(-1) as MeshRequest;
  assert.equal(surrounding.urgentCoverage, false);
  at(1700); slot.worker.onmessage!({ data: { ...surrounding, type: 'meshed',
    chunks: [], portals: emptyPortals(4), workMs: 100 } } as MessageEvent);
  state.flushMeshes();
  at(2000); state.pump(1, 1);
  assert.equal(slot.job!.key, '0:0,0', 'exact detail progresses after the bounded surrounding coverage and rest');
});

let forcedReq = 100_000;

function emptyPortals(step: number): EntrancePortalMesh {
  if (step === 4) {
    return {
      positions: new Float32Array(),
      partGrid: 4,
      partOffsets: new Uint32Array(17),
    };
  }
  return { positions: new Float32Array() };
}

function complete(
  manager: ChunkManager,
  st: TestState,
  chunks: ChunkMesh[] = [],
  portals?: EntrancePortalMesh,
): void {
  deliver(manager, st, chunks, portals);
  assert.equal(st.status, 'ready');
  assert.equal(st.installed, true);
}

function deliver(manager: ChunkManager, st: TestState, chunks: ChunkMesh[] = [], portals?: EntrancePortalMesh): void {
  const requestId = forcedReq++;
  const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16;
  st.status = 'meshing';
  st.requestId = requestId;
  const slot: TestSlot = {
    worker: new FakeWorker(),
    watchdog: null,
    readyAt: 0,
    coverageReadyAt: 0,
    job: {
      key: st.key, requestId, cx: st.cx, cz: st.cz,
      step, caveDetail: st.caveDetail,
    },
  };
  internals(manager).onMeshed(slot, {
    type: 'meshed', reqId: requestId, cx: st.cx, cz: st.cz,
    caveDetail: st.caveDetail, step, chunks,
    portals: portals ?? emptyPortals(step),
  });
}

function flatTile(size: number, grid: number): ChunkMesh[] {
  const positions = new Float32Array([
    0, 0, 0, size, 0, 0, size, 0, size,
    0, 0, 0, size, 0, size, 0, 0, size,
  ]);
  const normals = new Float32Array(positions.length);
  const colors = new Uint8Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    normals[i + 1] = 1;
    colors[i] = 80; colors[i + 1] = 120; colors[i + 2] = 160;
  }
  return partitionChunkMeshes(
    [{ cy: 0, positions, normals, colors }],
    0, 0, size, grid,
  );
}

function finePatch(baseX: number, baseZ: number): ChunkMesh[] {
  const positions = new Float32Array([
    baseX + 2, 0, baseZ + 2,
    baseX + 28, 0, baseZ + 2,
    baseX + 2, 0, baseZ + 28,
  ]);
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0]);
  const colors = new Uint8Array([80, 100, 120, 80, 100, 120, 80, 100, 120]);
  return [{ cy: 0, positions, normals, colors }];
}

/** A real closed-across-neighbors terrain surface for mask/seam tests.
 * An empty fine payload above a nonempty coarse heightfield is a missing
 * vertical band, so it must no longer masquerade as a compatible boundary. */
function fullSurface(st: TestState, y = 0): ChunkMesh[] {
  const scale = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16, size = 32 * scale;
  const source = flatTile(size, scale);
  for (const chunk of source) for (let i = 0; i < chunk.positions.length; i += 3) {
    chunk.positions[i] += st.cx * size; chunk.positions[i + 1] = y;
    chunk.positions[i + 2] += st.cz * size;
  }
  return st.lod === 0 ? source.map(({ partGrid, partOffsets, ...mesh }) => mesh) : source;
}

function portalTile(size: number, grid: number): EntrancePortalMesh {
  const positions: number[] = [];
  const offsets = new Uint32Array(grid * grid + 1);
  const partSize = size / grid;
  for (let z = 0; z < grid; z++) {
    for (let x = 0; x < grid; x++) {
      const part = z * grid + x;
      offsets[part] = positions.length;
      const bx = x * partSize, bz = z * partSize;
      positions.push(
        bx + 2, 1, bz + 2,
        bx + partSize - 2, 1, bz + 2,
        bx + 2, 1, bz + partSize - 2,
      );
    }
  }
  offsets[offsets.length - 1] = positions.length;
  return {
    positions: new Float32Array(positions),
    partGrid: grid,
    partOffsets: offsets,
  };
}

function finePortal(baseX: number, baseZ: number): EntrancePortalMesh {
  return {
    positions: new Float32Array([
      baseX + 2, 1, baseZ + 2,
      baseX + 30, 1, baseZ + 2,
      baseX + 2, 1, baseZ + 30,
    ]),
  };
}

function visibleScalars(st: TestState): number {
  return st.meshes.reduce(
    (sum, mesh) => sum + (mesh.geometry.index ? mesh.geometry.drawRange.count : mesh.geometry.getAttribute('position').count) * 3,
    0,
  );
}

function visiblePortalScalars(st: TestState): number {
  return st.portalMeshes.reduce(
    (sum, mesh) => sum + (mesh.geometry.index ? mesh.geometry.drawRange.count : mesh.geometry.getAttribute('position').count) * 3,
    0,
  );
}

function assertNoVisibleCoarseOverlap(state: ChunkInternals): void {
  const ready = (key: string): boolean =>
    state.desired.has(key) && state.columns.get(key)?.installed === true;
  for (const coarse of state.columns.values()) {
    if (coarse.lod === 0 || !coarse.partVisible) continue;
    for (let pz = 0; pz < coarse.partGrid; pz++) {
      for (let px = 0; px < coarse.partGrid; px++) {
        if (!coarse.partVisible[pz * coarse.partGrid + px]) continue;
        if (coarse.lod === 1) {
          assert.equal(ready(`0:${coarse.cx * 4 + px},${coarse.cz * 4 + pz}`), false,
            `${coarse.key} exposes a part over ready LOD0`);
        } else {
          const t1x = coarse.cx * 4 + Math.floor(px / 4);
          const t1z = coarse.cz * 4 + Math.floor(pz / 4);
          assert.equal(ready(`1:${t1x},${t1z}`), false,
            `${coarse.key} exposes a leaf under ready LOD1`);
          assert.equal(ready(`0:${coarse.cx * 16 + px},${coarse.cz * 16 + pz}`), false,
            `${coarse.key} exposes a leaf under ready LOD0`);
        }
      }
    }
  }
}

test('LOD1 clips and masks exactly one ready desired LOD0 footprint, then re-exposes it', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const coarse = state.columns.get('1:0,0');
  const fine = state.columns.get('0:1,2');
  assert.ok(coarse && fine);

  complete(manager, coarse, flatTile(128, 4));
  assert.equal(coarse.partGrid, 4);
  assert.equal(coarse.parts?.offsets.length, 17);
  assert.ok(coarse.partVisible?.every((v) => v === 1));
  const allScalars = visibleScalars(coarse);

  complete(manager, fine, fullSurface(fine));
  const hiddenPart = 2 * 4 + 1;
  assert.equal(coarse.partVisible?.[hiddenPart], 0);
  assert.equal(coarse.partVisible?.reduce((n, v) => n + v, 0), 15);
  assert.ok(visibleScalars(coarse) < allScalars);
  assertNoVisibleCoarseOverlap(state);

  // A stale/non-desired ready state must not keep a fallback hidden.
  state.desired.delete(fine.key);
  state.syncCoarseVisibility();
  assert.equal(coarse.partVisible?.[hiddenPart], 1);
  assert.equal(visibleScalars(coarse), allScalars);
  assert.equal(coarse.status, 'ready', 're-exposure must reuse retained CPU geometry');

  state.desired.add(fine.key);
  fine.status = 'queued';
  state.syncCoarseVisibility();
  assert.equal(coarse.partVisible?.[hiddenPart], 0,
    'installed fine geometry remains coverage while its replacement is pending');
  fine.status = 'ready';
  state.syncCoarseVisibility();
  assert.equal(coarse.partVisible?.[hiddenPart], 0);
  assertNoVisibleCoarseOverlap(state);
});

test('entrance portal caps install and mask atomically with their terrain LOD', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const coarse = state.columns.get('1:0,0');
  const fine = state.columns.get('0:1,2');
  assert.ok(coarse && fine);
  assert.equal(state.portalGroup.visible, true,
    'surface cameras stencil rays entering caves as well as exiting them');

  complete(manager, coarse, flatTile(128, 4), portalTile(128, 4));
  assert.equal(coarse.portalMeshes.length, 1);
  const allPortalScalars = visiblePortalScalars(coarse);
  assert.equal(allPortalScalars, 16 * 9);

  complete(manager, fine, fullSurface(fine), finePortal(32, 64));
  assert.equal(fine.portalMeshes.length, 1, 'fine terrain and its cap install together');
  assert.equal(coarse.partVisible?.[2 * 4 + 1], 0);
  assert.equal(visiblePortalScalars(coarse), allPortalScalars - 9,
    'the exact fine footprint must hide its coarse cap');

  state.desired.delete(fine.key);
  state.syncCoarseVisibility();
  assert.equal(visiblePortalScalars(coarse), allPortalScalars,
    'coarse cap reappears with the terrain fallback');

  manager.update(0, -60, 0);
  assert.equal(state.portalGroup.visible, true,
    'underground cameras enable the already-streamed canonical caps');
});

test('camera envelope parity switches immediately while cave streaming settles', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, -60, 0);
  const state = internals(manager);
  assert.equal(manager.isUnderground, true);
  assert.equal(manager.isBelowSurfaceEnvelope, true);
  assert.equal(state.portalGroup.visible, true);
  manager.update(0, 200, 0);
  assert.equal(manager.isUnderground, false,
    'open sky roof state must not inherit streaming hysteresis');
  assert.equal(manager.isBelowSurfaceEnvelope, false,
    'a camera above the aperture caps must switch its horizon stencil immediately');
  assert.equal(state.portalGroup.visible, true);
  assert.equal(state.columns.get('1:0,0')?.caveDetail, true,
    'instant sky visibility must preserve the existing cave mesh cache');
  manager.dispose();
});

test('exterior cave approaches prefetch bounded cave walls beyond the entrance', () => {
  const world = new World(1337);
  const site = world.collectCaveSites(0,960,0,960)[0];
  assert.ok(site);
  const outside = cavePathPoint(site,-17);
  outside.y = world.column(outside.x,outside.z).h + 4;
  const manager = new ChunkManager(1337, 1);
  manager.update(outside.x,outside.y,outside.z);
  const state = internals(manager);
  assert.equal(manager.isUnderground, false);
  assert.equal(manager.isBelowSurfaceEnvelope, false);
  const back = cavePathPoint(site,270);
  assert.equal(state.columns.get(`1:${Math.floor(back.x/128)},${Math.floor(back.z/128)}`)?.caveDetail, true,
    'distant walls seen through an entrance must have an underground band');
  assert.ok([...state.columns.values()].filter((c) => c.lod === 1 && c.caveDetail).length <= 130);
  assert.ok([...state.columns.values()].filter((c) => c.lod === 2).every((c) => !c.caveDetail));
  // Camera under open sky but below the nominal mouth envelope still starts
  // with underground parity, so looking up through its cap preserves sky.
  const apron = Array.from({length: Math.floor(site.mouthLength)-3},(_,i) => cavePathPoint(site,i+2))
    .find(p => world.column(p.x,p.z).h > p.y+2.2);
  assert.ok(apron);
  manager.update(apron.x,apron.y+1.8,apron.z);
  assert.equal(manager.isUnderground, false);
  assert.equal(manager.isBelowSurfaceEnvelope, true);
  // A different surface area must not inherit approach prefetch forever.
  for (let i = 0; i < 21; i++) manager.update(1400, 250, 1400);
  assert.equal(state.columns.get('1:10,10')?.caveDetail, false);
  manager.dispose();
});

test('LOD2 recursively masks exact LOD0 leaves while LOD1 is pending', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const coarse = state.columns.get('2:0,0');
  const fine = state.columns.get('0:5,4');
  const mid = state.columns.get('1:1,1');
  assert.ok(coarse && fine && mid);

  complete(manager, coarse, flatTile(512, 16));
  assert.equal(coarse.partGrid, 16);
  assert.equal(coarse.partVisible?.reduce((n, v) => n + v, 0), 256);

  complete(manager, fine, fullSurface(fine));
  assert.equal(coarse.partVisible?.[4 * 16 + 5], 0,
    'a ready exact leaf must not overlap LOD2 while its LOD1 parent is pending');
  assert.equal(coarse.partVisible?.reduce((n, v) => n + v, 0), 255);

  complete(manager, mid, fullSurface(mid));
  for (let z = 4; z < 8; z++) {
    for (let x = 4; x < 8; x++) {
      assert.equal(coarse.partVisible?.[z * 16 + x], 0,
        `ready LOD1 must mask recursive leaf ${x},${z}`);
    }
  }
  assertNoVisibleCoarseOverlap(state);

  state.desired.delete(mid.key);
  state.desired.delete(fine.key);
  state.syncCoarseVisibility();
  for (let z = 4; z < 8; z++) {
    for (let x = 4; x < 8; x++) assert.equal(coarse.partVisible?.[z * 16 + x], 1);
  }
});

test('installed finer geometry keeps masking ancestors during a cave upgrade', (t) => {
  const manager = new ChunkManager(1337, 1);
  t.after(() => manager.dispose());
  manager.update(0, 200, 0);
  const state = internals(manager);
  const mid = state.columns.get('1:0,0');
  const far = state.columns.get('2:0,0');
  assert.ok(mid && far);
  complete(manager, far, flatTile(512, 16));
  complete(manager, mid, flatTile(128, 4));
  assert.equal(mid.installedCaveDetail, false);
  const installedMeshes = mid.meshes;

  manager.update(0, -60, 0);
  assert.equal(mid.status, 'meshing', 'missing current cave enclosure is dispatched immediately');
  const upgrade = state.workers[0].job;
  assert.equal(upgrade?.key, mid.key);
  assert.equal(upgrade?.requestId, mid.requestId);
  assert.equal(upgrade?.caveDetail, true, 'the pending request supplies the newly required cave walls');
  assert.equal(mid.installed, true);
  assert.equal(mid.installedCaveDetail, false);
  assert.equal(mid.meshes, installedMeshes, 'dispatching the cave upgrade cannot replace or remove installed geometry');
  assert.ok(mid.meshes.length > 0, 'old installed mesh stays visible until atomic replacement');
  for (let z = 0; z < 4; z++) {
    for (let x = 0; x < 4; x++) {
      assert.equal(far.partVisible?.[z * 16 + x], 0,
        'underlying LOD2 must not reappear beneath an installed upgrading LOD1');
    }
  }
  assertNoVisibleCoarseOverlap(state);
});

test('installed edge detail retires only after a desired fallback is installed', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const edge = state.columns.get('0:-7,0');
  const parent = state.columns.get('1:-2,0');
  assert.ok(edge && parent);
  complete(manager, edge, finePatch(-7 * 32, 0));
  assert.equal(parent.installed, false);
  const retainedMesh = edge.meshes[0];

  manager.update(32, 200, 0);
  assert.equal(state.desired.has(edge.key), false);
  assert.equal(state.columns.get(edge.key), edge);
  assert.equal(edge.retiring, true);
  assert.equal(edge.meshes[0], retainedMesh, 'no one-frame ring hole while fallback is pending');

  manager.update(0, 200, 0);
  assert.equal(edge.retiring, false, 'moving back reuses the installed state');
  assert.equal(edge.meshes[0], retainedMesh);

  manager.update(32, 200, 0);
  assert.equal(edge.retiring, true);
  complete(manager, parent, []); // A valid empty completion still establishes coverage.
  assert.equal(parent.installed, true);
  assert.equal(state.columns.has(edge.key), false,
    'retiring detail is released in the fallback completion callback');
});

test('a fine completion reconciles only its two coarse ancestors', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const mid = state.columns.get('1:0,0');
  const far = state.columns.get('2:0,0');
  const fine = state.columns.get('0:1,1');
  assert.ok(mid && far && fine);
  complete(manager, far, flatTile(512, 16));
  complete(manager, mid, flatTile(128, 4));

  const original = state.coarseVisibility.bind(state);
  let reconciled = 0;
  state.coarseVisibility = (st: TestState): Uint8Array => {
    reconciled++;
    return original(st);
  };
  complete(manager, fine, fullSurface(fine));
  assert.equal(reconciled, 2,
    'completion work must be O(ancestor depth), not O(global LOD2 tile count)');
});

test('mixed-LOD seams publish with masks, cache unchanged boundaries, and retire their GPU resources', (t) => {
  const manager = new ChunkManager(1337, 1), state = internals(manager);
  t.after(() => manager.dispose());
  manager.update(0, 200, 0);
  t.mock.method(state, 'pump', () => {});
  const parent = state.columns.get('1:0,0')!, fine = state.columns.get('0:1,1')!;
  complete(manager, parent, fullSurface(parent));
  t.mock.method(state.terrainWorld, 'column', () => { throw new Error('seam publication must use installed buffers only'); });
  complete(manager, fine, fullSurface(fine, 2));
  const seams = manager as any;
  assert.equal(parent.partVisible?.[5], 0);
  assert.equal(seams.seamEdges.size, 4, 'all four exposed fine/coarse boundaries close in the same publication');
  const group = seams.seamGroups.get(parent), geometry = group.terrain.geometry;
  assert.ok(geometry.getAttribute('position').count > 0);
  assert.equal(seams.seamGroups.size, 1, 'strips share one coarse-tile draw');
  const boundaryCache = (fine as any).seamBoundaries;
  const cacheSize = boundaryCache.size;
  state.syncCoarseVisibility(); state.syncCoarseVisibility();
  assert.equal(seams.seamGroups.get(parent).terrain.geometry, geometry, 'identical masks do not rebuild seam buffers');
  assert.equal(boundaryCache.size, cacheSize);
  let disposed = 0;
  geometry.addEventListener('dispose', () => disposed++);
  complete(manager, fine, fullSurface(fine, 3));
  assert.equal(disposed, 1, 'old seam buffers retire with replacement geometry');
  assert.equal(seams.seamEdges.size, 4);
  state.desired.delete(fine.key); state.removeState(fine); state.syncCoarseVisibility();
  assert.equal(parent.partVisible?.[5], 1);
  assert.equal(seams.seamEdges.size, 0);
  assert.equal(seams.seamGroups.size, 0);
  manager.dispose();
  assert.equal(manager.group.children.length, 0);
});

test('removing a horizon tile revisits only its perimeter and owned strips, and retires them', (t) => {
  const manager = new ChunkManager(1337, 1), state = internals(manager);
  t.after(() => manager.dispose());
  manager.update(0, 200, 0);
  t.mock.method(state, 'pump', () => {});
  // A fine leaf directly on a horizon tile (no LOD1 tile installed between
  // them): the horizon tile owns all four seam strips.
  const horizon = state.columns.get('2:0,0')!, fine = state.columns.get('0:1,1')!;
  complete(manager, horizon, fullSurface(horizon));
  complete(manager, fine, fullSurface(fine, 2));
  const seams = manager as any;
  assert.equal(seams.seamEdges.size, 4);
  assert.equal(seams.seamGroups.get(horizon).parts.size, 4);
  const strip = seams.seamGroups.get(horizon).terrain.geometry;
  let disposed = 0;
  strip.addEventListener('dispose', () => disposed++);
  const dirty: string[] = [];
  const add = seams.seamDirty.add.bind(seams.seamDirty);
  t.mock.method(seams.seamDirty, 'add', (key: string) => { dirty.push(key); return add(key); });
  state.desired.delete(horizon.key); state.removeState(horizon);
  assert.ok(dirty.length <= 64 + 4, `perimeter and owned strips only, not all 544 leaf edges (${dirty.length})`);
  for (const key of seams.seamGroups.get(horizon).parts.keys()) assert.ok(dirty.includes(key), 'every owned strip is revisited');
  state.syncCoarseVisibility(); seams.syncTerrainSeams();
  assert.equal(seams.seamEdges.size, 0, 'no strip survives its owner');
  assert.equal(seams.seamGroups.size, 0);
  assert.equal(disposed, 1);
  assert.ok(fine.installed, 'the fine leaf itself is untouched');
});

test('an incompatible replacement retains the published fine mesh and its coarse mask', (t) => {
  const manager = new ChunkManager(1337, 1), state = internals(manager);
  t.after(() => manager.dispose());
  manager.update(0, 200, 0); t.mock.method(state, 'pump', () => {});
  const parent = state.columns.get('1:0,0')!, fine = state.columns.get('0:1,1')!;
  complete(manager, parent, fullSurface(parent)); complete(manager, fine, fullSurface(fine, 1));
  const oldMeshes = fine.meshes, oldMask = parent.partVisible;
  const oldSeams = (manager as any).seamGroups.get(parent).terrain;
  // An empty new band cannot meet a nonempty adjacent heightfield. This is
  // deliberately not the valid empty/empty worker protocol exercised above.
  complete(manager, fine, []);
  assert.equal(fine.meshes, oldMeshes);
  assert.equal(parent.partVisible, oldMask);
  assert.equal((manager as any).seamGroups.get(parent).terrain, oldSeams);
  assert.equal((manager as any).seamDeferred.size, 1);
  state.flushMeshes(); state.flushMeshes();
  assert.equal(fine.meshes, oldMeshes, 'unchanged neighbors do not spin on rejected publication');
  manager.dispose();
  assert.equal((manager as any).seamDeferred.size, 0);
});

test('incompatible retirement retains the leaf and updates its own parent when a different parent neighbor becomes compatible', (t) => {
  const manager = new ChunkManager(1337, 1), state = internals(manager);
  t.after(() => manager.dispose());
  manager.update(128, 200, 64); t.mock.method(state, 'pump', () => {});
  const parent = state.columns.get('1:0,0')!, neighborParent = state.columns.get('1:1,0')!;
  const retiring = state.columns.get('0:3,1')!, neighbor = state.columns.get('0:4,1')!;
  // The coarse fallback is initially completely hidden. An injected finite
  // neighbor band is only discovered when retirement would expose its edge.
  for (let z = 0; z < 4; z++) for (let x = 0; x < 8; x++) {
    const fine = state.columns.get(`0:${x},${z}`)!;
    complete(manager, fine, fine === neighbor ? [...fullSurface(fine, 1), ...fullSurface(fine, -2)] : fullSurface(fine, 1));
  }
  complete(manager, parent, fullSurface(parent)); complete(manager, neighborParent, fullSurface(neighborParent));
  const oldMesh = retiring.meshes[0];
  state.desired.delete(retiring.key);
  (manager as any).pruneUndesired(); state.syncCoarseVisibility();
  assert.equal(state.columns.get(retiring.key), retiring);
  assert.equal(retiring.meshes[0], oldMesh);
  assert.equal(retiring.retiring, true);
  assert.equal((retiring as any).seamRetained, true);
  assert.equal(parent.partVisible?.[7], 0, 'incompatible fallback cannot unmask under the retained leaf');
  complete(manager, neighbor, fullSurface(neighbor, 1));
  assert.equal(state.columns.has(retiring.key), false, 'compatible neighbor publication permits atomic retirement');
  assert.equal(parent.partVisible?.[7], 1, 'retirement reconciles its own parent despite the completion being in another parent');
  assert.equal(neighborParent.partVisible?.[4], 0, 'the completed neighbor still masks its own parent');
  assert.ok((manager as any).seamGroups.get(parent).terrain.geometry.getAttribute('position').count > 0);
});

test('adjacent retiring leaves cannot assume each other will pass a later removal guard', (t) => {
  const manager = new ChunkManager(1337, 1), state = internals(manager);
  t.after(() => manager.dispose());
  manager.update(0, 200, 0); t.mock.method(state, 'pump', () => {});
  const parent = state.columns.get('1:0,0')!, a = state.columns.get('0:1,1')!;
  const b = state.columns.get('0:2,1')!, c = state.columns.get('0:3,1')!;
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
    const fine = state.columns.get(`0:${x},${z}`)!;
    complete(manager, fine, fine === b || fine === c
      ? [...fullSurface(fine, 1), ...fullSurface(fine, -2)] : fullSurface(fine, 1));
  }
  complete(manager, parent, fullSurface(parent));
  const oldA = a.meshes, oldB = b.meshes;
  state.desired.delete(a.key); state.desired.delete(b.key);
  (manager as any).pruneUndesired(); state.syncCoarseVisibility();
  assert.equal(a.meshes, oldA, 'A must validate against the still-present B, not its hypothetical fallback');
  assert.equal(b.meshes, oldB, 'B is independently retained by its incompatible boundary with desired C');
  assert.equal(state.columns.get(a.key), a); assert.equal(state.columns.get(b.key), b);
  assert.equal(parent.partVisible?.[5], 0); assert.equal(parent.partVisible?.[6], 0);
});

let nativeDeferredPair: { a: ChunkMesh[]; b: ChunkMesh[]; preview: ChunkMesh[] } | undefined;
function deferredPairFixture(t: TestContext) {
  const manager = new ChunkManager(1337, 1), state = internals(manager), intern = manager as any;
  t.after(() => manager.dispose());
  manager.update(-2982.7, 200, 2249.08); t.mock.method(state, 'pump', () => {});
  const parent = state.columns.get('2:-6,4')!, a = state.columns.get('1:-24,18')!, b = state.columns.get('1:-23,18')!;
  nativeDeferredPair ??= {
    a: meshColumnChunks(state.terrainWorld, a.cx, a.cz, false, 4),
    b: meshColumnChunks(state.terrainWorld, b.cx, b.cz, false, 4),
    preview: meshTerrainPreview(state.terrainWorld, parent.cx, parent.cz).chunks,
  };
  complete(manager, parent, nativeDeferredPair.preview);
  return { manager, state, intern, parent, a, b, meshes: nativeDeferredPair };
}

test('ready canonical neighbors replace their incompatible preview boundary atomically without retrying unrelated arrivals', (t) => {
  const { manager, state, intern, parent, a, b, meshes } = deferredPairFixture(t);
  const mask = parent.partVisible, oldMesh = parent.meshes[0];
  deliver(manager, a, meshes.a);
  assert.equal(a.installed, false, 'the native finite band cannot join an interim infinite-below preview');
  let checks = 0; const prepare = intern.prepareSeam.bind(intern);
  t.mock.method(intern, 'prepareSeam', (...args: unknown[]) => { checks++; return prepare(...args); });
  state.flushMeshes();
  let initialSlices = 0;
  for (; initialSlices < 200 && (intern.seamTransaction || intern.seamDeferred.get(a.key)?.dirty); initialSlices++) {
    state.flushMeshes();
    assert.equal(a.installed, false, 'rejected first member cannot publish during bounded preparation');
    assert.equal(parent.partVisible, mask, 'preparation preserves the original ownership mask');
  }
  assert.equal(intern.seamTransaction, null, 'initial rejected transaction settles within the existing200-slice bound');
  assert.ok(intern.seamDeferred.has(a.key), 'the same first result remains retained for its real neighbor');
  assert.equal(intern.seamDeferred.get(a.key).dirty, false);
  const firstChecks = checks;
  for (let i = 0; i < 20; i++) state.flushMeshes();
  assert.equal(checks, firstChecks, 'unchanged dependencies never rebuild a rejected boundary each frame');
  const unrelated = [...state.columns.values()].find(st => st.lod === 2 && st.cx > 0)!;
  complete(manager, unrelated, []); const afterUnrelated = checks;
  state.flushMeshes(); assert.equal(checks, afterUnrelated, 'unrelated geometry cannot wake the deferred component');
  assert.equal(parent.partVisible, mask); assert.equal(parent.meshes[0], oldMesh);
  deliver(manager, b, meshes.b);
  assert.equal(b.installed, false, 'the second result is prepared before either ownership mask changes');
  let iterations = 0;
  for (; iterations < 200 && !a.installed; iterations++) {
    state.flushMeshes();
    assert.equal(a.installed, b.installed, 'no frame exposes one canonical tile against the incompatible preview');
    if (!a.installed) assert.equal(parent.partVisible, mask, 'preparation preserves the published fallback mask');
  }
  assert.ok(a.installed && b.installed && iterations > 1, 'native pair makes bounded progress across preparation frames');
  for (let z = 8; z < 12; z++) for (let x = 0; x < 8; x++) assert.equal(parent.partVisible?.[z * 16 + x], 0);
  assert.equal(intern.seamDeferred.size, 0); assert.equal(intern.seamTransaction, null);
  assert.ok(intern.seamGroups.get(parent).parts.size > 0);
});

test('a stale cave-detail request discards prepared transaction resources and keeps the published fallback', (t) => {
  const { manager, state, intern, parent, a, b, meshes } = deferredPairFixture(t);
  const mask = parent.partVisible;
  deliver(manager, a, meshes.a); deliver(manager, b, meshes.b);
  for (let i = 0; i < 200 && !intern.seamTransaction?.geometry.length; i++) state.flushMeshes();
  const staged = intern.seamTransaction?.geometry[0].meshes[0]; assert.ok(staged);
  assert.equal(staged.parent, null, 'prepared geometry is not attached early');
  let disposed = 0; staged.geometry.addEventListener('dispose', () => disposed++);
  b.caveDetail = true; state.flushMeshes();
  assert.equal(disposed, 1); assert.equal(a.installed, false); assert.equal(b.installed, false);
  assert.equal(parent.partVisible, mask); assert.equal(b.status, 'queued');
  assert.equal(intern.seamDeferred.has(b.key), false, 'obsolete surface payload cannot survive a cave upgrade');
  manager.dispose(); assert.equal(intern.seamDeferred.size, 0); assert.equal(intern.seamTransaction, null);
});

test('a deferred transaction cannot overwrite an unrelated seam added to its shared coarse draw group', (t) => {
  const { manager, state, intern, parent, a, b, meshes } = deferredPairFixture(t);
  deliver(manager, a, meshes.a); deliver(manager, b, meshes.b);
  for (let i = 0; i < 200 && !intern.seamTransaction?.groups; i++) state.flushMeshes();
  assert.ok(intern.seamTransaction?.groups, 'group snapshot is prepared over multiple frames');
  const fine = state.columns.get('0:-90,65')!; assert.ok(fine);
  complete(manager, fine, fullSurface(fine, 60));
  const separateKeys = [...intern.seamGroups.get(parent).parts.keys()] as string[];
  assert.equal(separateKeys.length, 4);
  for (let i = 0; i < 200 && !a.installed; i++) state.flushMeshes();
  assert.ok(a.installed && b.installed);
  for (const key of separateKeys) {
    assert.ok(intern.seamEdges.has(key));
    assert.equal(intern.seamGroups.get(parent).parts.get(key), intern.seamEdges.get(key),
      'the group snapshot must include later changes outside the deferred edge set');
  }
});

test('camera-boundary rebuild cannot count stale LOD0 when selecting LOD1', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  for (let z = 0; z < 4; z++) {
    for (let x = 0; x < 4; x++) {
      const fine = state.columns.get(`0:${x},${z}`);
      assert.ok(fine);
      fine.status = 'ready';
      fine.installed = true;
    }
  }
  const oldCoarse = state.columns.get('1:0,0');
  assert.ok(oldCoarse);
  state.removeState(oldCoarse);

  manager.update(512, 200, 0);
  assert.ok(state.desired.has('1:0,0'), 'tile remains in the new LOD1 range');
  assert.ok(state.columns.has('1:0,0'), 'stale old LOD0 readiness must not suppress fallback');
  assert.equal(state.desired.has('0:0,0'), false, 'old exact state is outside the new selection');
  assert.equal(state.columns.get('0:0,0')?.retiring, true,
    'old exact geometry may retire safely, but cannot count as desired coverage');
});

test('teleport cannot count stale LOD1 when selecting global LOD2', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  for (let z = 0; z < 4; z++) {
    for (let x = 0; x < 4; x++) {
      const mid = state.columns.get(`1:${x},${z}`);
      assert.ok(mid);
      mid.status = 'ready';
      mid.installed = true;
    }
  }
  const oldFar = state.columns.get('2:0,0');
  assert.ok(oldFar);
  state.removeState(oldFar);

  manager.update(2048, 200, 0);
  assert.ok(state.desired.has('2:0,0'));
  assert.ok(state.columns.has('2:0,0'), 'global fallback must be selected structurally');
  assert.equal(state.desired.has('1:0,0'), false);
  assert.equal(state.columns.get('1:0,0')?.retiring, true,
    'stale LOD1 may remain visible only until the new LOD2 fallback installs');
});

test('underground dispatch encloses all touching cave tiles before nearby preview and canonical coverage', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, -60, 0);
  const state = internals(manager);
  const slot = state.workers[0];
  const order: TestJob[] = [];

  for (let i = 0; i < 24; i++) {
    const job = slot.job;
    assert.ok(job, `dispatch ${i} should exist`);
    order.push({ ...job });
    state.onMeshed(slot, {
      type: 'meshed', reqId: job.requestId, cx: job.cx, cz: job.cz,
      caveDetail: job.caveDetail, step: job.step, chunks: [],
      portals: emptyPortals(job.step),
      preview: job.preview,
    });
  }

  assert.ok(order.slice(0, 4).every((job) => job.step === 4 && job.caveDetail),
    'first stage must enclose the camera with the four touching cave tiles');
  const firstLod2 = order.findIndex((job) => job.step === 16);
  assert.equal(firstLod2, 4,
    `useful LOD2 fallback dispatched too late (${firstLod2})`);
  assert.ok(order.slice(firstLod2).every((job) => job.preview ||
    job.step === 4 && job.caveDetail && Math.abs(job.cx) <= 1 && Math.abs(job.cz) <= 1),
    'only the bounded surrounding cave neighborhood can precede the first horizon coverage');
  assert.equal(order[firstLod2].caveDetail, false, 'far LOD stays surface-only behind fog');
});

test('bounded canonical caves extend beyond the opaque underground horizon', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, -60, 0);
  const state = internals(manager);
  assert.ok(CAVE_FOG_FAR < CAVE_HORIZON_RADIUS);
  assert.ok(CAVE_HORIZON_RADIUS < CAVE_MESH_RADIUS);
  const lod1TileM = CHUNK_SIZE * LOD1_STEP;
  const tileHalfDiagonal = Math.SQRT2 * lod1TileM * 0.5;
  assert.ok(LOD1_RADIUS >= CAVE_MESH_RADIUS + tileHalfDiagonal,
    'LOD1 radius must include the center of every tile intersecting the cave disk');
  let desiredLod1 = 0, detailedLod1 = 0, surfaceLod2 = 0;
  for (const key of state.desired) {
    const st = state.columns.get(key);
    assert.ok(st);
    if (st.lod === 0) continue;
    if (st.lod === 1) {
      desiredLod1++;
      const centerX = (st.cx + 0.5) * lod1TileM;
      const centerZ = (st.cz + 0.5) * lod1TileM;
      const dx = Math.max(0, Math.abs(centerX) - lod1TileM * 0.5);
      const dz = Math.max(0, Math.abs(centerZ) - lod1TileM * 0.5);
      const intersectsMeshRadius = Math.hypot(dx, dz) <= CAVE_MESH_RADIUS;
      assert.equal(st.caveDetail, intersectsMeshRadius, `${key} cave-detail radius mismatch`);
      if (st.caveDetail) detailedLod1++;
    } else {
      assert.equal(st.caveDetail, false, `${key} wastes a global step-16 cave slab`);
      surfaceLod2++;
    }
  }
  const tileRange = Math.ceil((CAVE_MESH_RADIUS + lod1TileM) / lod1TileM);
  for (let tz = -tileRange; tz <= tileRange; tz++) {
    for (let tx = -tileRange; tx <= tileRange; tx++) {
      const centerX = (tx + 0.5) * lod1TileM;
      const centerZ = (tz + 0.5) * lod1TileM;
      const dx = Math.max(0, Math.abs(centerX) - lod1TileM * 0.5);
      const dz = Math.max(0, Math.abs(centerZ) - lod1TileM * 0.5);
      if (Math.hypot(dx, dz) <= CAVE_MESH_RADIUS) {
        assert.ok(state.desired.has(`1:${tx},${tz}`),
          `LOD1 selection omits cave-disk tile 1:${tx},${tz}`);
      }
    }
  }
  assert.ok(detailedLod1 > 60 && detailedLod1 < 130);
  assert.ok(desiredLod1 <= 120,
    `origin underground selection retains too many LOD1 tiles (${desiredLod1})`);
  assert.ok(surfaceLod2 > 200);
});

test('queued and in-flight requests upgrade monotonically on descent', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const queued = state.columns.get('0:5,0');
  assert.ok(queued);
  assert.equal(queued.caveDetail, false);

  manager.update(32, -60, 0);
  assert.equal(queued.caveDetail, true);
  assert.equal(state.columns.get('1:0,0')?.caveDetail, true);
  assert.equal(state.columns.get('1:5,0')?.caveDetail, false);
  assert.ok([...state.columns.values()]
    .filter((st) => st.lod === 2 && state.desired.has(st.key))
    .every((st) => !st.caveDetail));

  const requestId = forcedReq++;
  queued.status = 'meshing';
  queued.requestId = requestId;
  const slot: TestSlot = {
    worker: new FakeWorker(),
    watchdog: null,
    readyAt: 0,
    coverageReadyAt: 0,
    job: {
      key: queued.key, requestId, cx: queued.cx, cz: queued.cz,
      step: 1, caveDetail: false,
    },
  };
  state.onMeshed(slot, {
    type: 'meshed', reqId: requestId, cx: queued.cx, cz: queued.cz,
    caveDetail: false, step: 1, chunks: [],
    portals: emptyPortals(1),
  });
  assert.equal(queued.status, 'queued', 'obsolete surface-only result must be retried');
  assert.equal(queued.requestId, null);
  assert.ok(state.queue.includes(queued));
});

test('teleports evict stale queued states instead of accumulating backlog', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const stale = state.columns.get('0:7,0');
  assert.ok(stale);
  assert.equal(stale.status, 'queued');

  manager.update(2048, 200, 0);
  assert.equal(state.columns.has(stale.key), false);
  assert.equal(state.queue.includes(stale), false);
});

test('worker errors retry the active job on a replacement and dispose is idempotent', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const slot = state.workers[0];
  const oldWorker = slot.worker;
  const oldJob = slot.job;
  assert.ok(oldJob);
  const active = state.columns.get(oldJob.key);
  assert.ok(active);

  oldWorker.onerror?.({ preventDefault(): void {} } as ErrorEvent);
  assert.equal(oldWorker.terminated, true);
  assert.notEqual(slot.worker, oldWorker);
  assert.ok(slot.job, 'replacement worker should immediately resume queued work');
  assert.ok(active.status === 'queued' || active.status === 'meshing');
  assert.notEqual(active.requestId, oldJob.requestId);

  // A late response from the dead generation cannot free the replacement.
  const replacementJob = slot.job;
  state.onMeshed(slot, {
    type: 'meshed', reqId: oldJob.requestId, cx: oldJob.cx, cz: oldJob.cz,
    caveDetail: oldJob.caveDetail, step: oldJob.step, chunks: [],
    portals: emptyPortals(oldJob.step),
  });
  assert.equal(slot.job, replacementJob);

  const replacement = slot.worker;
  manager.dispose();
  manager.dispose();
  assert.equal(replacement.terminated, true);
  assert.equal(manager.group.children.length, 0);
  assert.deepEqual(manager.stats, { columnsReady: 0, columnsPending: 0, triangles: 0 });
  const sent = replacement.messages.length;
  manager.update(64, -60, 64);
  assert.equal(replacement.messages.length, sent);
});

test('watchdog replaces a worker that never answers', async () => {
  const manager = new ChunkManager(1337, 1, 15);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const slot = state.workers[0];
  const hung = slot.worker;
  const hungJob = slot.job;
  assert.ok(hungJob);

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(hung.terminated, true);
  assert.notEqual(slot.worker, hung);
  const active = state.columns.get(hungJob.key);
  assert.ok(active);
  assert.ok(active.status === 'queued' || active.status === 'meshing');
  assert.notEqual(active.requestId, hungJob.requestId);
  manager.dispose();
});

test('wrong echoed payload recovers instead of stranding a meshing state', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const slot = state.workers[0];
  const job = slot.job;
  assert.ok(job);
  const active = state.columns.get(job.key);
  assert.ok(active);
  const failed = slot.worker;

  state.onMeshed(slot, {
    type: 'meshed', reqId: job.requestId, cx: job.cx + 1, cz: job.cz,
    caveDetail: job.caveDetail, step: job.step, chunks: [],
    portals: emptyPortals(job.step),
  });
  assert.equal(failed.terminated, true);
  assert.notEqual(slot.worker, failed);
  assert.ok(active.status === 'queued' || active.status === 'meshing');
  assert.notEqual(active.requestId, job.requestId);
});

test('far terrain pages around the camera and evicts installed tiles after long travel', () => {
  const manager = new ChunkManager(1337, 1);
  const state = internals(manager);
  for (const x of [0, 6500, -6500, 4000, 0]) {
    manager.update(x, 270, 0);
    // Seam-checked retirement of old fine tiles is spread over frames with a
    // small per-update budget; it must drain within a bounded number of them.
    let frames = 1;
    while ((manager as unknown as { retireBacklog: boolean }).retireBacklog && frames < 120) { manager.update(x, 270, 0); frames++; }
    assert.equal((manager as unknown as { retireBacklog: boolean }).retireBacklog, false, `retirement drains (${frames} frames)`);
    const far = [...state.columns.values()].filter(s => s.lod === 2);
    assert.ok(far.length < 360, 'far tile count must not grow with world area or travel history');
    assert.ok(state.columns.size < 660, 'no installed near/far tiles stranded at old camera locations');
    for (const st of state.columns.values()) {
      if (st.lod === 2) {
        const dx = Math.max(0, Math.abs((st.cx + 0.5) * 512 - x) - 256);
        const dz = Math.max(0, Math.abs((st.cz + 0.5) * 512) - 256);
        assert.ok(Math.hypot(dx,dz) <= 4800);
      }
      // Model completed geometry, so this exercises resident eviction as
      // well as cancellation of queued work during a long teleport.
      st.installed = true; st.status = 'ready'; st.installedCaveDetail = st.caveDetail;
    }
  }
  manager.dispose();
});

test('seam-checked retirement after a respawn spreads over frames, keeps old tiles until checked and drains', (t) => {
  const manager = new ChunkManager(1337, 1), state = internals(manager) as unknown as ChunkInternals & {
    retireBacklog: boolean; canRetireSeams(st: TestState): boolean };
  t.after(() => manager.dispose());
  let now = 1000, proofs = 0;
  t.mock.method(performance, 'now', () => now);
  const prove = state.canRetireSeams.bind(state);
  t.mock.method(state, 'canRetireSeams', (st: TestState) => { proofs++; now += .5; return prove(st); });
  manager.update(0, 270, 0);
  for (const st of state.columns.values()) { st.installed = true; st.status = 'ready'; st.installedCaveDetail = st.caveDetail; }
  // A 1.5 km respawn: old fine tiles stay inside the far ring, so each needs a seam proof.
  proofs = 0; manager.update(1500, 270, 0);
  const firstFrame = proofs;
  assert.ok(firstFrame > 0 && firstFrame <= 9, `about 4 ms of proofs per frame, not all at once (${firstFrame})`);
  assert.equal(state.retireBacklog, true);
  const waiting = [...state.columns.values()].filter(st => st.retiring && st.lod < 2 && st.installed);
  assert.ok(waiting.length > 20, 'unchecked old tiles remain drawn until their turn');
  let frames = 1;
  while (state.retireBacklog && frames < 200) { proofs = 0; manager.update(1500, 270, 0); assert.ok(proofs <= 9); frames++; }
  assert.equal(state.retireBacklog, false, `the backlog drains (${frames} frames)`);
  assert.ok(waiting.every(st => state.columns.get(st.key) !== st || !st.retiring || (st as TestState & { seamRetained?: boolean }).seamRetained),
    'every deferred tile was eventually checked');
});

test('near seam edges close in the same frame while distant ones drain in budgeted slices', (t) => {
  const manager = new ChunkManager(1337, 1);
  const state = manager as unknown as { seamDirty: Set<string>; prepareSeam(key: string, replacements?: unknown): unknown; pump(): void };
  t.after(() => manager.dispose());
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  manager.update(0, 270, 0);
  t.mock.method(state, 'pump', () => {});
  const prepare = state.prepareSeam.bind(state), visited = new Set<string>();
  t.mock.method(state, 'prepareSeam', (key: string, replacements?: unknown) => {
    if (!replacements) { visited.add(key); now += .05; }
    return prepare(key, replacements);
  });
  const far = Array.from({ length: 400 }, (_, i) => `x:${200 + i},200`), near = Array.from({ length: 24 }, (_, i) => `z:${i - 12},3`);
  for (const key of [...far, ...near]) state.seamDirty.add(key);
  manager.update(0, 270, 0);
  assert.ok(near.every(key => visited.has(key)), 'edges around the fine rings never wait');
  const first = far.filter(key => visited.has(key)).length;
  assert.ok(first >= 40 && first < 150, `about 4 ms of distant edges per frame (${first})`);
  let frames = 1;
  while (state.seamDirty.size && frames < 40) { manager.update(0, 270, 0); frames++; }
  assert.equal(state.seamDirty.size, 0, `distant edges drain (${frames} frames)`);
  assert.ok(far.every(key => visited.has(key)));
});

test('distant coarse masks update in budgeted slices while near ones update at once', (t) => {
  const manager = new ChunkManager(1337, 1);
  const state = manager as unknown as { seamMaskDirty: Set<string>; columns: Map<string, { key: string; lod: number; cx: number; cz: number }>;
    syncOneCoarse(st: unknown): void; pump(): void };
  t.after(() => manager.dispose());
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  manager.update(0, 270, 0);
  t.mock.method(state, 'pump', () => {});
  const sync = state.syncOneCoarse.bind(state), visited = new Set<string>();
  t.mock.method(state, 'syncOneCoarse', (st: { key: string } | undefined) => { if (st) { visited.add(st.key); now += .2; } return sync(st); });
  const tiles = [...state.columns.values()].filter(st => st.lod > 0);
  const centre = (st: { lod: number; cx: number; cz: number }) => Math.hypot((st.cx + .5) * (st.lod === 1 ? 128 : 512), (st.cz + .5) * (st.lod === 1 ? 128 : 512));
  const near = tiles.filter(st => st.lod === 1 && centre(st) < 900).map(st => st.key);
  const far = tiles.filter(st => st.lod === 2 && centre(st) > 2400).map(st => st.key);
  assert.ok(near.length > 4 && far.length > 60);
  for (const key of [...far, ...near]) state.seamMaskDirty.add(key);
  manager.update(0, 270, 0);
  assert.ok(near.every(key => visited.has(key)), 'masks around the camera never wait');
  const first = far.filter(key => visited.has(key)).length;
  assert.ok(first < far.length / 2, `distant masks wait for later frames (${first} of ${far.length})`);
  let frames = 1;
  while (state.seamMaskDirty.size && frames < 80) { manager.update(0, 270, 0); frames++; }
  assert.equal(state.seamMaskDirty.size, 0, `distant masks drain (${frames} frames)`);
  assert.ok(far.every(key => visited.has(key)));
});

test('nearby ground detail starts before hundreds of distant horizon previews', () => {
  const manager = new ChunkManager(1337, 1);
  try {
    const state = internals(manager); let previews = 0, canonical = false, detailed = false;
    for (let i = 0; i < 60; i++) {
      manager.update(0, 200, 0);
      const slot = state.workers[0], job = slot.job;
      assert.ok(job);
      if (job.step === 1) { detailed = true; break; }
      if (job.step === 4) {
        if (!canonical) {
          assert.equal(i, 1, 'current canonical ground follows its first preview');
          assert.equal(job.key, '1:0,0'); canonical = true;
        } else assert.ok(Math.abs(job.cx) <= 1 && Math.abs(job.cz) <= 1,
          'only the bounded nine-tile neighborhood may precede fine detail');
      } else {
        assert.ok(job.preview, 'initial coarse work is cheap coverage');
        previews++;
      }
      state.onMeshed(slot, { type: 'meshed', reqId: job.requestId, cx: job.cx, cz: job.cz,
        step: job.step, caveDetail: job.caveDetail, preview: job.preview, chunks: [], portals: emptyPortals(job.step) });
    }
    assert.ok(canonical, 'walking/boarding receives exact ground before the nearby preview backlog');
    assert.ok(detailed, 'the camera must not wait for the entire horizon to refine its own ground');
    assert.ok(previews >= 4 && previews < 40, `nearby coverage precedes detail (${previews} previews)`);
    assert.ok(state.queue.some(s => s.lod === 2 && !s.installed), 'far coverage continues after local refinement');
  } finally { manager.dispose(); }
});

test('touch profile uses smaller terrain rings and a fixed two-worker budget', () => {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = (() => ({ matches: true })) as unknown as typeof matchMedia;
  try {
    const manager = new ChunkManager(1337);
    manager.update(0,270,0);
    const state = internals(manager);
    assert.equal(state.workers.length,2);
    assert.ok([...state.columns.values()].filter(s => s.lod === 0).length < 100);
    assert.ok([...state.columns.values()].filter(s => s.lod === 2).length < 140);
    manager.dispose();
  } finally { globalThis.matchMedia = previous; }
});

test('coarse mask changes preserve mesh, vertex and index buffers instead of uploading geometry again', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const coarse = state.columns.get('2:0,0')!, fine = state.columns.get('0:1,1')!;
  complete(manager, coarse, flatTile(512, 16));
  const mesh = coarse.meshes[0], geometry = mesh.geometry;
  const position = geometry.getAttribute('position') as THREE.BufferAttribute, index = geometry.index!;
  const indexArray = index.array, count = geometry.drawRange.count;
  let disposed = 0;
  geometry.addEventListener('dispose', () => disposed++);
  complete(manager, fine, fullSurface(fine));
  assert.equal(coarse.meshes[0], mesh);
  assert.equal(mesh.geometry, geometry);
  assert.equal(geometry.getAttribute('position'), position);
  assert.equal(position.version, 0, 'coarse vertex data must not be uploaded again for a mask change');
  assert.equal(geometry.index, index);
  assert.equal(index.array, indexArray);
  assert.ok(geometry.drawRange.count < count);
  assert.equal(disposed, 0);
  state.desired.delete(fine.key); state.syncCoarseVisibility();
  assert.equal(geometry.drawRange.count, count);
  assert.equal(geometry.index, index);
  manager.dispose();
  assert.equal(disposed, 1);
});

test('selection movement reconciles changed installed parents without scanning the horizon', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  complete(manager, state.columns.get('1:-2,0')!, flatTile(128, 4));
  complete(manager, state.columns.get('2:-1,0')!, flatTile(512, 16));
  complete(manager, state.columns.get('2:5,0')!, flatTile(512, 16));
  complete(manager, state.columns.get('0:-7,0')!, finePatch(-224, 0));
  let reconciled = 0;
  const original = state.coarseVisibility.bind(state);
  state.coarseVisibility = (st) => { reconciled++; return original(st); };
  manager.update(32, 200, 0);
  assert.equal(reconciled, 2, 'only the retired edge column’s two ancestors change');
  manager.dispose();
});

test('worker replies wait for a bounded frame install and obsolete travel jobs are cancelled', () => {
  const manager = new ChunkManager(1337, 4);
  manager.update(0, 400, 0, {vx: 132, vz: 0, flight: true});
  const state = internals(manager);
  const oldWorkers = state.workers.map((slot) => slot.worker);
  for (const slot of state.workers) {
    const job = slot.job!;
    assert.equal(job.preview, true);
    slot.worker.onmessage!({ data: {type: 'meshed', reqId: job.requestId, cx: job.cx, cz: job.cz,
      caveDetail: job.caveDetail, step: job.step, preview: true, chunks: [], portals: emptyPortals(job.step)} } as MessageEvent);
  }
  assert.equal(manager.streaming.installed.preview, 0, 'message handlers must not upload geometry outside the frame budget');
  assert.equal(manager.streaming.waitingUploads, 4);
  manager.update(0, 400, 0, {vx: 132, vz: 0, flight: true});
  assert.ok(manager.streaming.installed.preview >= 1 && manager.streaming.installed.preview <= 2);
  assert.ok(manager.streaming.waitingUploads >= 2);
  manager.update(7000, 400, 7000, {vx: -132, vz: 0, flight: true});
  assert.ok(oldWorkers.every((worker) => worker.terminated), 'stale in-flight coverage must not block the new location');
  assert.equal(manager.streaming.waitingUploads, 0);
  assert.ok(state.workers.every((slot) => slot.job?.preview), 'replacement workers must restore cheap coverage first');
  manager.dispose();
});

test('cold sustained jet travel preserves current and ahead coverage with slow workers and bounded queues', () => {
  for (const workerCount of [2, 4]) {
    const manager = new ChunkManager(1337, workerCount);
    const state = internals(manager);
    const scheduled = new Set<number>();
    const jobs = new Map<number, {worker: FakeWorker; job: TestJob; due: number}>();
    let maxStates = 0, maxQueue = 0, maxReplies = 0;
    for (let frame = 0; frame < 1800; frame++) {
      const now = frame / 60 * 1000;
      for (const [id, running] of jobs) {
        if (running.worker.terminated) { jobs.delete(id); continue; }
        if (running.due > now) continue;
        const {job, worker} = running;
        worker.onmessage?.({data: {type: 'meshed', reqId: job.requestId, cx: job.cx, cz: job.cz,
          caveDetail: job.caveDetail, step: job.step, preview: job.preview, chunks: [],
          portals: emptyPortals(job.step)}} as MessageEvent);
        jobs.delete(id);
      }
      const x = frame / 60 * 132, z = frame / 60 * 24;
      manager.update(x, 650, z, {vx: 132, vz: 24, flight: true});
      for (const slot of state.workers) {
        const job = slot.job;
        if (!job || scheduled.has(job.requestId)) continue;
        scheduled.add(job.requestId);
        const duration = job.preview ? 25 : job.step === 16 ? 250 : job.step === 4 ? 1600 : 2500;
        jobs.set(job.requestId, {worker: slot.worker, job: {...job}, due: now + duration});
      }
      if (frame > 30) {
        assert.equal(state.columns.get(`2:${Math.floor(x / 512)},${Math.floor(z / 512)}`)?.installed, true,
          `${workerCount} workers: missing land at frame ${frame}`);
        assert.equal(state.columns.get(`2:${Math.floor((x + 132 * 4) / 512)},${Math.floor((z + 24 * 4) / 512)}`)?.installed, true,
          `${workerCount} workers: missing four-second lookahead at frame ${frame}`);
      }
      maxStates = Math.max(maxStates, state.columns.size);
      maxQueue = Math.max(maxQueue, state.queue.length);
      maxReplies = Math.max(maxReplies, manager.streaming.waitingUploads);
      assert.ok(![...state.columns.values()].some((st) => st.lod === 0), 'high flight must not spend workers on deep 1m cave slabs');
      assert.ok(!state.workers[0].job || state.workers[0].job.preview,
        'one worker must remain available for coverage during flight');
    }
    assert.ok(maxStates < 520 && maxQueue < 520, 'travel history must not accumulate terrain states or stale queued work');
    assert.ok(maxReplies <= workerCount, 'transferred geometry awaiting upload stays bounded by workers');
    manager.update(3960, 0, 720, {vx: 0, vz: 0, flight: true});
    assert.ok([...state.columns.values()].some((st) => st.lod === 0), 'landing must restore nearby exact detail');
    manager.dispose();
  }
});

test('flight detail thresholds resist banking jitter and restore full detail before landing', () => {
  const manager = new ChunkManager(1337, 2), world = new World(1337);
  const ground = world.column(0, 0).h;
  const motion = { vx: 132, vz: 0, flight: true };
  manager.update(0, ground + 70, 0, motion);
  assert.equal(manager.streaming.detailRadius, -1);
  for (const height of [47, 49, 42, 48, 51]) {
    manager.update(0, ground + height, 0, motion);
    assert.equal(manager.streaming.detailRadius, -1);
  }
  manager.update(0, ground + 38, 0, motion);
  assert.equal(manager.streaming.detailRadius, 3);
  for (const height of [17, 19, 16, 21, 52]) {
    manager.update(0, ground + height, 0, motion);
    assert.equal(manager.streaming.detailRadius, 3);
  }
  manager.update(0, ground + 12, 0, motion);
  assert.equal(manager.streaming.detailRadius, 7);
  manager.update(0, ground + 23, 0, motion);
  assert.equal(manager.streaming.detailRadius, 7);
  manager.dispose();
});

test('stalled browser workers cannot leave sustained flight without camera terrain', () => {
  const manager = new ChunkManager(1337, 4);
  const state = internals(manager), motion = {vx: 132, vz: 0, flight: true};
  let emergencyPeak = 0;
  const clockOrigin = performance.now() + 2000;
  for (let frame = 0; frame < 160; frame++) {
    const x = 3900 + frame / 8 * 132;
    manager.update(x, 650, 4400, motion);
    state.advanceEmergencyCoverage(clockOrigin + frame * 125);
    if (frame >= 16) assert.ok(manager.streaming.currentCovered, `missing ground at stalled-worker frame ${frame}`);
    emergencyPeak = Math.max(emergencyPeak, manager.streaming.installed.preview);
    assert.ok(manager.streaming.emergencySamples <= 121, 'only one small tile may be in progress');
    assert.equal(manager.streaming.waitingUploads, 0);
    assert.ok(state.columns.size < 520 && state.queue.length < 520);
  }
  assert.ok(emergencyPeak >= 5 && emergencyPeak <= 8, 'only the travelled camera/lookahead corridor receives emergency geometry');
  manager.dispose();
});

test('emergency lookahead finishes a crossed intermediate tile before the farther endpoint tile', () => {
  const manager = new ChunkManager(1337, 4), state = internals(manager), motion = { vx: 132, vz: 0, flight: true };
  manager.update(3900, 650, 4400, motion);
  complete(manager, state.columns.get('2:7,8')!, flatTile(512, 16));
  const clock = performance.now() + 2000;
  state.advanceEmergencyCoverage(clock);
  const preview = state.emergencyPreview;
  assert.equal(preview?.key, '2:8,8');
  assert.ok(preview!.builder.sampledColumns > 0 && preview!.builder.sampledColumns <= 32);
  // The camera is still in tile7 while its endpoint moves from8 to9. Tile8
  // must remain the next coverage task because the flight crosses it first.
  manager.update(4081, 650, 4400, motion);
  state.advanceEmergencyCoverage(clock + 125);
  assert.ok(state.columns.get('2:8,8')!.installed || state.emergencyPreview === preview,
    'work on the imminent camera tile must not be discarded for a farther endpoint');
  manager.dispose();
});

test('a delayed worker preview preserves the emergency geometry before canonical refinement', () => {
  const manager = new ChunkManager(1337, 4), state = internals(manager);
  manager.update(3900, 650, 4400, {vx: 132, vz: 0, flight: true});
  const current = state.columns.get('2:7,8')!;
  const slot = state.workers.find((s) => s.job?.key === current.key)!;
  const job = {...slot.job!};
  const clock = performance.now() + 2000;
  for (let i = 0; i < 100 && !current.installed; i++) state.advanceEmergencyCoverage(clock + i * 125);
  assert.ok(current.installed);
  const mesh = current.meshes[0];
  let disposed = 0;
  mesh.geometry.addEventListener('dispose', () => disposed++);
  state.onMeshed(slot, {type: 'meshed', reqId: job.requestId, cx: job.cx, cz: job.cz,
    step: job.step, caveDetail: job.caveDetail, preview: true, chunks: [], portals: emptyPortals(16)});
  assert.equal(current.meshes[0], mesh, 'late preview must not overwrite terrain that is already visible');
  assert.equal(disposed, 0);
  complete(manager, current, flatTile(512, 16));
  assert.notEqual(current.meshes[0], mesh);
  assert.equal(disposed, 1, 'canonical terrain replaces and disposes its emergency preview once');
  manager.dispose();
});

test('flight lookahead selection follows a same-cell reversal only when its mid tile changes', () => {
  const manager = new ChunkManager(1337, 2), state = internals(manager);
  manager.update(10, 650, 10, {vx: 132, vz: 0, flight: true});
  assert.ok(state.desired.has('1:6,0'));
  manager.update(10, 650, 10, {vx: -132, vz: 0, flight: true});
  assert.ok(!state.desired.has('1:6,0'));
  assert.ok(state.desired.has('1:-7,0'));
  const desired = [...state.desired];
  manager.update(10, 650, 10, {vx: -131, vz: 0, flight: true});
  assert.deepEqual([...state.desired], desired);
  manager.dispose();
});

test('emergency preview generation stops before descending into the terrain envelope', () => {
  const manager = new ChunkManager(1337, 2), state = internals(manager);
  const motion = {vx: 132, vz: 0, flight: true};
  manager.update(3900, 650, 4400, motion);
  const clock = performance.now() + 2000;
  state.advanceEmergencyCoverage(clock);
  assert.ok(manager.streaming.emergencySamples > 0);
  manager.update(3900, -100, 4400, motion);
  state.advanceEmergencyCoverage(clock + 1000);
  assert.equal(manager.streaming.emergencySamples, 0);
  assert.equal(manager.streaming.installed.preview, 0, 'a partial surface preview cannot become a fake roof underground');
  manager.dispose();
});

test('a worker failure after replying cannot block the replacement behind its stale upload', () => {
  const manager = new ChunkManager(1337, 1), state = internals(manager);
  manager.update(3900, 650, 4400, {vx: 132, vz: 0, flight: true});
  const slot = state.workers[0];
  const reply = () => {
    const job = slot.job!;
    slot.worker.onmessage!({data: {type: 'meshed', reqId: job.requestId, cx: job.cx, cz: job.cz,
      step: job.step, caveDetail: job.caveDetail, preview: job.preview, chunks: [], portals: emptyPortals(job.step)}} as MessageEvent);
  };
  reply();
  assert.equal(manager.streaming.waitingUploads, 1);
  const failed = slot.worker;
  failed.onerror!({preventDefault() {}} as ErrorEvent);
  assert.ok(failed.terminated);
  assert.equal(manager.streaming.waitingUploads, 0);
  reply();
  assert.equal(manager.streaming.waitingUploads, 1, 'the replacement generation must be able to enqueue its response');
  manager.update(3900, 650, 4400, {vx: 132, vz: 0, flight: true});
  assert.equal(manager.streaming.installed.preview, 1);
  manager.dispose();
});

function stubGround(t: TestContext, manager: ChunkManager, height = (_x: number, _z: number) => 0): void {
  const state = internals(manager);
  t.mock.method(state.terrainWorld, 'column', (x: number, z: number) => ({ h: height(x, z) } as ReturnType<World['column']>));
  t.mock.method(state.terrainWorld, 'roofedAbove', () => false);
  t.mock.method(state.roads, 'update', () => {});
}

test('nonlinear preview coverage does not postpone canonical ground for a boosted driver', (t) => {
  const { manager, state, at } = localCoverageFixture(t);
  const height = (x: number) => 50 * Math.sin(x * Math.PI / 64);
  stubGround(t, manager, height);
  const previewWorld = { column: (x: number) => ({ h: height(x) }), material: () => MAT.GRASS,
    vertexColor(_m: unknown, _x: unknown, _y: unknown, _z: unknown, _c: unknown, color: number[]) { color.fill(.5); } } as unknown as World;
  manager.update(32, 54, 64);
  const slot = state.workers[0], request = slot.worker.messages.at(-1) as MeshRequest;
  assert.equal(request.step, 16);
  const preview = meshTerrainPreview(previewWorld, request.cx, request.cz);
  assert.ok(preview.chunks[0].positions.every((v, i) => i % 3 !== 1 || Math.abs(v) < 1e-4),
    '64m preview samples miss this real 50m ridge entirely');
  at(1100); slot.worker.onmessage!({ data: { ...request, type: 'meshed', preview: true, ...preview, workMs: 100 } } as MessageEvent);
  state.flushMeshes();
  assert.equal(manager.streaming.currentCovered, true);
  assert.equal(manager.streaming.currentGroundCovered, false, 'visual fallback is not canonical driving coverage');
  at(1200); manager.update(32, 54, 64, { vx: 81, vz: 0, flight: false });
  const canonical = slot.worker.messages.at(-1) as MeshRequest;
  assert.equal(slot.job!.key, '1:0,0'); assert.equal(canonical.urgentCoverage, true);
  assert.equal(slot.readyAt, 1400, 'only canonical route coverage can use the earlier deadline');
  assert.equal(manager.streaming.groundLookahead, 324);
  const positions: number[] = [];
  for (let z = 0; z < 128; z += 4) for (let x = 0; x < 128; x += 4)
    for (const [vx, vz] of [[x, z], [x, z + 4], [x + 4, z], [x + 4, z], [x, z + 4], [x + 4, z + 4]])
      positions.push(vx, height(vx), vz);
  const native = partitionChunkMeshes([{ cy: 0, positions: new Float32Array(positions),
    normals: new Float32Array(positions.length), colors: new Uint8Array(positions.length) }], 0, 0, 128, 4);
  at(1300); slot.worker.onmessage!({ data: { ...canonical, type: 'meshed', chunks: native, portals: emptyPortals(4), workMs: 100 } } as MessageEvent);
  state.flushMeshes();
  assert.equal(manager.streaming.currentGroundCovered, true);
  assert.deepEqual(state.columns.get('1:0,0')!.parts!.positions, native[0].positions, 'canonical heights are installed unchanged');
  const coarse = state.columns.get('2:0,0')!;
  for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++)
    assert.equal(coarse.partVisible![z * 16 + x], 0, 'the whole native route tile masks its inaccurate preview');
});

test('ground-route turns cancel background work without losing warm workers, deadlines or reply fences', (t) => {
  const { manager, state, add, at } = localCoverageFixture(t);
  stubGround(t, manager);
  const coarse = add(2, 0, 0), current = add(1, 0, 0);
  coarse.installed = current.installed = true; coarse.status = current.status = 'ready';
  current.installedCaveDetail = current.caveDetail = true;
  add(1, 1, 0); add(1, 0, 1);
  state.groundTravel = true; state.lookX = 324;
  state.pump(64, 64);
  const slot = state.workers[0], worker = slot.worker, old = worker.messages.at(-1) as MeshRequest;
  assert.equal(slot.job!.key, '1:1,0');
  slot.readyAt = 1900; slot.coverageReadyAt = 1500;
  state.lookX = 0; state.lookZ = 324;
  at(1400); state.pump(64, 64);
  assert.equal(slot.job, null); assert.deepEqual(worker.messages.at(-1), { type: 'cancel', reqId: old.reqId });
  assert.equal(slot.worker, worker); assert.equal(worker.terminated, false);
  assert.equal(slot.readyAt, 1900); assert.equal(slot.coverageReadyAt, 1500);
  at(1500); state.pump(64, 64);
  assert.equal(slot.job!.key, '1:0,1');
  const turning = worker.messages.at(-1) as MeshRequest;
  worker.onmessage!({ data: { ...old, type: 'meshed', chunks: [], portals: emptyPortals(4), paced: true } } as MessageEvent);
  assert.equal(manager.streaming.waitingUploads, 0); assert.equal(slot.job!.requestId, turning.reqId);
  at(2000); manager.update(7000, 4, 7000, { vx: -81, vz: 0, flight: false });
  assert.equal(slot.worker, worker, 'teleport keeps the cooperative worker and its generated caches');
  assert.ok(!state.columns.has('1:0,1'), 'distant route state is evicted');
  const arrival = slot.job!.requestId;
  worker.onmessage!({ data: { ...turning, type: 'meshed', chunks: [], portals: emptyPortals(4), paced: true } } as MessageEvent);
  assert.equal(manager.streaming.waitingUploads, 0); assert.equal(slot.job!.requestId, arrival);
  assert.equal(worker.messages.filter((msg: any) => msg.type === 'init').length, 1);
});

test('one paced local worker keeps canonical ground ahead during sustained boosted travel and turns', (t) => {
  const { manager, state, at } = localCoverageFixture(t);
  stubGround(t, manager);
  const scheduled = new Set<number>(), jobs = new Map<number, { worker: FakeWorker; job: TestJob; due: number }>();
  let maxStates = 0, maxQueue = 0, cancelled = 0;
  for (let frame = 0; frame < 2040; frame++) {
    const seconds = frame / 60, now = 1000 + seconds * 1000;
    at(now);
    for (const [id, running] of jobs) if (running.due <= now) {
      const { job, worker } = running;
      worker.onmessage?.({ data: { type: 'meshed', reqId: job.requestId, cx: job.cx, cz: job.cz,
        step: job.step, caveDetail: job.caveDetail, preview: job.preview, chunks: [], portals: emptyPortals(job.step), paced: true } } as MessageEvent);
      jobs.delete(id);
    }
    const travel = Math.max(0, seconds - 4);
    const east = Math.min(10, travel), north = Math.min(10, Math.max(0, travel - 10)), west = Math.max(0, travel - 20);
    const x = 64 + 81 * (east - west), z = 64 + 81 * north;
    const vx = travel < 10 ? 81 : travel < 20 ? 0 : -81, vz = travel >= 10 && travel < 20 ? 81 : 0;
    manager.update(x, 4, z, { vx, vz, flight: false });
    for (const slot of state.workers) {
      const job = slot.job;
      if (!job || scheduled.has(job.requestId)) continue;
      scheduled.add(job.requestId);
      // Wall durations include the worker's own measured rest. A long fine
      // job is deliberately slower than a boosted 32m boundary crossing.
      const duration = job.preview ? 40 : job.step === 4 ? 420 : 2500;
      jobs.set(job.requestId, { worker: slot.worker, job: { ...job }, due: now + duration });
    }
    if (seconds >= 4) {
      assert.equal(manager.streaming.currentGroundCovered, true, `driver lacks canonical ground at ${seconds.toFixed(2)}s`);
      const sinceTurn = travel < 10 ? travel : travel < 20 ? travel - 10 : travel - 20;
      if (travel < 10 || sinceTurn > .75)
        assert.equal(state.coveredAt(x + vx, z + vz, false, true), true, `one-second route lead missing at ${seconds.toFixed(2)}s`);
      if (sinceTurn > 2 && Math.floor((x + vx * 4) / 128) === Math.floor((x + vx * 3) / 128) &&
          Math.floor((z + vz * 4) / 128) === Math.floor((z + vz * 3) / 128))
        assert.equal(manager.streaming.aheadGroundCovered, true, 'four-second lead is ready within one second of entering its tile');
    }
    maxStates = Math.max(maxStates, state.columns.size); maxQueue = Math.max(maxQueue, state.queue.length);
    assert.ok(manager.streaming.waitingUploads <= 1);
    assert.equal(manager.streaming.flight, false); assert.equal(manager.streaming.detailRadius, 7);
  }
  cancelled = state.workers[0].worker.messages.filter((msg: any) => msg.type === 'cancel').length;
  assert.ok(cancelled > 0, 'moving route can preempt slow background refinement');
  assert.ok(maxStates < 850 && maxQueue < 850, 'travel history remains bounded');
  assert.ok([...state.columns.values()].some(st => st.lod === 0), 'full nearby detail is still selected');
});

test('fast ground prefetch upgrades cave support before the driver reaches its approach, even after a drained queue', (t) => {
  const { manager, state, add, at } = localCoverageFixture(t);
  stubGround(t, manager);
  const current = add(1, 0, 0, true), ahead = add(1, 1, 0);
  current.installed = ahead.installed = true;
  current.status = ahead.status = 'ready';
  current.installedCaveDetail = true; ahead.installedCaveDetail = false;
  state.queue.length = 0;
  state.groundTravel = true; state.lookX = 324;
  state.pump(64, 64);
  const slot = state.workers[0], worker = slot.worker, request = worker.messages.at(-1) as MeshRequest;
  assert.equal(slot.job!.key, ahead.key);
  assert.equal(request.caveDetail, true, 'first route job includes the native underground band');
  assert.equal(request.urgentCoverage, true);
  at(1800); worker.onmessage!({ data: { ...request, type: 'meshed', chunks: [], portals: emptyPortals(4), paced: true } } as MessageEvent);
  state.flushMeshes();
  state.lastUnderground = true;
  state.pump(192, 64);
  assert.equal(state.coveredAt(192, 64, true, true), true, 'arrival does not expose a surface-only cave fallback');
  assert.equal(worker.messages.filter((msg: any) => msg.type === 'mesh').length, 1, 'approach does not regenerate the same tile');
});

test('ground cave prefetch cancels obsolete surface-only work on the same tile and rejects its late response', (t) => {
  const { manager, state, add, at } = localCoverageFixture(t);
  stubGround(t, manager);
  const current = add(1, 0, 0, true);
  current.installed = current.installedCaveDetail = true; current.status = 'ready';
  state.queue.length = 0; const ahead = add(1, 1, 0);
  state.pump(64, 64);
  const slot = state.workers[0], worker = slot.worker, old = worker.messages.at(-1) as MeshRequest;
  assert.equal(old.caveDetail, false);
  state.groundTravel = true; state.lookX = 324;
  slot.readyAt = 1900; slot.coverageReadyAt = 1500;
  at(1400); state.pump(64, 64);
  assert.equal(slot.job, null); assert.equal(slot.worker, worker);
  assert.deepEqual(worker.messages.at(-1), { type: 'cancel', reqId: old.reqId });
  assert.equal(slot.coverageReadyAt, 1500, 'the upgrade preserves owed worker rest');
  at(1500); state.pump(64, 64);
  const replacement = worker.messages.at(-1) as MeshRequest;
  assert.equal(slot.job!.key, ahead.key); assert.equal(replacement.caveDetail, true);
  worker.onmessage!({ data: { ...old, type: 'meshed', chunks: [], portals: emptyPortals(4), paced: true } } as MessageEvent);
  assert.equal(manager.streaming.waitingUploads, 0); assert.equal(slot.job!.requestId, replacement.reqId);
});

test('covered fast ground refines nearby visible terrain before far previews without promoting its pacing', (t) => {
  const { manager, state, add, at } = localCoverageFixture(t);
  stubGround(t, manager);
  const current = add(1, 0, 0, true);
  current.installed = current.installedCaveDetail = true; current.status = 'ready';
  state.queue.length = 0;
  const near = add(1, 0, 1); add(2, 1, 0);
  state.groundTravel = true; state.lookX = 324;
  const slot = state.workers[0]; slot.coverageReadyAt = 1500; slot.readyAt = 1900;
  at(1500); state.pump(64, 64);
  assert.equal(slot.job, null, 'nearby scenery support keeps the ordinary background deadline');
  at(1900); state.pump(64, 64);
  assert.equal(slot.job!.key, near.key, 'nearby terrain takes precedence over horizon preview work');
  const request = slot.worker.messages.at(-1) as MeshRequest;
  assert.equal(request.urgentCoverage, false); assert.equal(request.caveDetail, false);
});

for (const [dx, dz] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]]) {
  test(`walking refines surrounding canonical ground in direction ${dx},${dz} without bypassing worker rest`, (t) => {
    const { state, add, at } = localCoverageFixture(t);
    const current = add(1, 0, 0); current.installed = true; current.status = 'ready';
    state.queue.length = 0;
    const neighbor = add(1, dx, dz); add(1, 2, 0); add(2, 3, 0);
    const slot = state.workers[0]; slot.coverageReadyAt = 1500; slot.readyAt = 1900;
    at(1500); state.pump(64, 64);
    assert.equal(slot.job, null, 'surrounding scenery support is background work');
    at(1900); state.pump(64, 64);
    assert.equal(slot.job!.key, neighbor.key, 'all eight neighbors precede distant preview and middle-tile work');
    const request = slot.worker.messages.at(-1) as MeshRequest;
    assert.equal(request.urgentCoverage, false);
    assert.equal(request.caveDetail, false, 'the priority does not widen cave selection');
    assert.equal(state.columns.size, 4, 'priority creates no additional tile requests');
  });
}

test('current fine coverage still allows its incomplete middle neighborhood to finish before distant previews', (t) => {
  const { state, add } = localCoverageFixture(t);
  const fine = add(0, 2, 2); fine.installed = true; fine.status = 'ready';
  state.queue.length = 0;
  const middle = add(1, 0, 0); add(1, 1, 0); add(2, 3, 0);
  state.pump(64, 64);
  const slot = state.workers[0];
  assert.equal(slot.job!.key, middle.key);
  assert.equal((slot.worker.messages.at(-1) as MeshRequest).urgentCoverage, false);
});

test('nearby coarse visibility and driving corridor keep precedence over the ground neighborhood', (t) => {
  const { state, add } = localCoverageFixture(t);
  const current = add(1, 0, 0, true); current.installed = current.installedCaveDetail = true; current.status = 'ready';
  state.queue.length = 0;
  const coarse = add(2, -1, 0), neighbor = add(1, 0, 1), route = add(1, 1, 0, true);
  state.pump(64, 64);
  const slot = state.workers[0];
  assert.equal(slot.job!.key, coarse.key, 'nearby land appears before its canonical refinement');
  coarse.status = 'ready'; coarse.installed = true; coarse.requestId = null; slot.job = null;
  state.groundTravel = true; state.lookX = 160;
  state.pump(64, 64);
  assert.equal(slot.job!.key, route.key, 'the actual driving corridor precedes all-direction background support');
  assert.equal(neighbor.status, 'queued');
  assert.equal((slot.worker.messages.at(-1) as MeshRequest).urgentCoverage, true);
});

test('flight retains its preview ordering instead of requesting the ground neighborhood', (t) => {
  const { state, add } = localCoverageFixture(t);
  const current = add(1, 0, 0); current.installed = true; current.status = 'ready';
  state.queue.length = 0;
  add(1, 1, 1); const preview = add(2, 3, 0);
  state.flight = true; state.pump(64, 64);
  assert.equal(state.workers[0].job!.key, preview.key);
});

test('ground forecast can preempt a still-urgent later tile for an earlier arrival without bypassing rest', (t) => {
  const { manager, state, add, at } = localCoverageFixture(t);
  stubGround(t, manager);
  const current = add(1, 0, 0, true);
  current.installed = current.installedCaveDetail = true; current.status = 'ready'; state.queue.length = 0;
  const later = add(1, 2, 0);
  state.groundTravel = true; state.lookX = 324;
  state.pump(64, 64);
  const slot = state.workers[0], worker = slot.worker, old = worker.messages.at(-1) as MeshRequest;
  assert.equal(slot.job!.key, later.key);
  const nearer = add(1, 1, 0);
  state.yieldGroundWorker(new Set([later.key, nearer.key]), new Map([[later.key, .3], [nearer.key, .28]]));
  assert.equal(slot.job!.key, later.key, 'a small ETA revision must not thrash an active urgent job');
  slot.readyAt = 1900; slot.coverageReadyAt = 1500;
  at(1400); state.pump(64, 64);
  assert.equal(slot.job, null, 'nearer deadline preempts even though the old tile is still wanted');
  assert.deepEqual(worker.messages.at(-1), { type: 'cancel', reqId: old.reqId });
  assert.equal(slot.coverageReadyAt, 1500); assert.equal(slot.readyAt, 1900);
  at(1500); state.pump(64, 64);
  assert.equal(slot.job!.key, nearer.key);
  const replacement = slot.job!.requestId;
  worker.onmessage!({ data: { ...old, type: 'meshed', chunks: [], portals: emptyPortals(4), paced: true } } as MessageEvent);
  assert.equal(manager.streaming.waitingUploads, 0); assert.equal(slot.job!.requestId, replacement);
});

for (const [name, vx, vz, nearTieSeconds, earlierSeconds] of [
  ['east20', 20, 0, .1, .5],
  ['north40', 0, -40, .1, .35],
  ['diagonal81', 81 / Math.SQRT2, 81 / Math.SQRT2, .04, .2],
] as const) {
  test(`resumable ground ordering protects spatial near-ties but yields earlier deadlines at ${name}`, (t) => {
    const { state, add } = localCoverageFixture(t);
    const later = add(1, 2, 0, true), nearer = add(1, 1, 0, true);
    state.groundTravel = true; state.groundMotionVx = vx; state.groundMotionVz = vz;
    const slot = state.workers[0];
    later.status = 'meshing'; later.requestId = 7;
    slot.job = { key: later.key, requestId: 7, cx: later.cx, cz: later.cz, step: 4, caveDetail: true };
    slot.readyAt = 2000; slot.coverageReadyAt = 1700;
    const urgent = new Set([later.key, nearer.key]);
    state.yieldGroundWorker(urgent, new Map([[later.key, 3 / 4], [nearer.key, (3 - nearTieSeconds) / 4]]));
    assert.equal(slot.job!.key, later.key, 'a near-tie within the spatial guard does not switch active work');
    state.yieldGroundWorker(urgent, new Map([[later.key, 3 / 4], [nearer.key, (3 - earlierSeconds) / 4]]));
    assert.equal(slot.job, null, 'earlier arrival can win before either deadline becomes imminent');
    assert.deepEqual(slot.worker.messages.at(-1), { type: 'cancel', reqId: 7 });
    assert.equal(later.status, 'queued', 'the yielded exact tile remains available for later resumption');
    assert.equal(slot.readyAt, 2000); assert.equal(slot.coverageReadyAt, 1700);
  });
}

test('fast-ground background work covers nearby sky gaps before side-ground refinement', (t) => {
  const { manager, state, add, at } = localCoverageFixture(t);
  stubGround(t, manager);
  const current = add(1, 0, 0, true);
  current.installed = current.installedCaveDetail = true; current.status = 'ready'; state.queue.length = 0;
  add(1, 0, 1); const preview = add(2, -1, 0);
  state.groundTravel = true; state.lookX = 324;
  const slot = state.workers[0]; slot.coverageReadyAt = 1500; slot.readyAt = 1900;
  at(1500); state.pump(64, 64); assert.equal(slot.job, null);
  at(1900); state.pump(64, 64);
  assert.equal(slot.job!.key, preview.key);
  assert.equal((slot.worker.messages.at(-1) as MeshRequest).urgentCoverage, false, 'visible side cover still uses ordinary pacing');
});

test('ground velocity forecast tracks variable frame cadence and resets unrelated motion', (t) => {
  const { manager, state, at } = localCoverageFixture(t);
  stubGround(t, manager);
  let seconds = 0;
  const speed = 81, rate = .3, radius = speed / rate;
  const update = (time: number) => {
    at(1000 + time * 1000);
    manager.update(64 + radius * (1 - Math.cos(rate * time)), 4, 64 - radius * Math.sin(rate * time),
      { vx: speed * Math.sin(rate * time), vz: -speed * Math.cos(rate * time), flight: false });
  };
  update(0);
  for (let i = 0; seconds < 1; i++) { seconds += i % 2 ? 1 / 40 : 1 / 60; update(seconds); }
  assert.ok(Math.abs(state.groundTurnRate - rate) < .001, '40/60 FPS variation does not change the measured turn');
  const a = rate * seconds;
  assert.ok(Math.abs(state.lookX - radius * (Math.cos(a) - Math.cos(a + rate * 4))) < .2);
  assert.ok(Math.abs(state.lookZ + radius * (Math.sin(a + rate * 4) - Math.sin(a))) < .2);
  assert.equal(state.groundPath.length, 9, 'half-second swept segments bound four-second curvature');
  const px = 64 + radius * (1 - Math.cos(a)), pz = 64 - radius * Math.sin(a);
  const vx = speed * Math.sin(a), vz = -speed * Math.cos(a);
  for (let i = 1; i <= 30; i++) {
    at(1000 + (seconds + i / 60) * 1000);
    manager.update(px + vx * i / 60, 4, pz + vz * i / 60, { vx, vz, flight: false });
  }
  assert.ok(Math.abs(state.groundTurnRate) < .01, 'steering release restores the straight forecast promptly');
  assert.equal(state.groundPath.length, 0);
  let clock = 1000 + (seconds + .5) * 1000;
  at(clock += 17); manager.update(px + vx * .5, 4, pz + vz * .5, { vx: -vx, vz: -vz, flight: false });
  assert.equal(state.groundTurnRate, 0, 'reversed velocity cannot retain the old turn');
  at(clock += 17); manager.update(7000, 4, 7000, { vx: -vx + 1, vz: -vz, flight: false });
  assert.equal(state.groundTurnRate, 0, 'teleport clears motion history');
  at(clock += 17); manager.update(7001, 4, 7001, { vx: vz, vz: -vx, flight: false });
  assert.equal(state.groundTurnRate, 0, 'abrupt lateral slip does not invent a projected turn');
  at(clock += 500); manager.update(7001, 4, 7001, { vx: vz + .5, vz: -vx, flight: false });
  assert.equal(state.groundTurnRate, 0, 'a stale frame cannot extrapolate a turn');
  at(clock += 17); manager.update(7002, 4, 7002, { vx: NaN, vz, flight: false });
  assert.equal(state.groundPath.length, 0); assert.equal(state.groundTravel, false);
});

test('curved boosted travel keeps current canonical ground with realistic delayed native-sized jobs', (t) => {
  const { manager, state, at } = localCoverageFixture(t);
  stubGround(t, manager);
  const speed = 81, rate = .3, radius = speed / rate, turnSeconds = Math.PI / (2 * rate);
  const scheduled = new Set<number>(), jobs = new Map<number, { worker: FakeWorker; job: TestJob; due: number }>();
  let seconds = 0, maxStates = 0;
  for (let frame = 0; seconds <= 35; frame++) {
    const now = 1000 + seconds * 1000; at(now);
    for (const [id, running] of jobs) if (running.due <= now) {
      const { job, worker } = running;
      worker.onmessage?.({ data: { type: 'meshed', reqId: job.requestId, cx: job.cx, cz: job.cz,
        step: job.step, caveDetail: job.caveDetail, preview: job.preview, chunks: [], portals: emptyPortals(job.step), paced: true } } as MessageEvent);
      jobs.delete(id);
    }
    const travel = Math.max(0, seconds - 6), turn = Math.min(turnSeconds, Math.max(0, travel - 8));
    const a = rate * turn, after = Math.max(0, travel - 8 - turnSeconds);
    const x = 64 + radius * (1 - Math.cos(a)) + speed * after;
    const z = 64 - speed * Math.min(8, travel) - radius * Math.sin(a);
    const vx = speed * Math.sin(a), vz = -speed * Math.cos(a);
    manager.update(x, 4, z, { vx, vz, flight: false });
    for (const slot of state.workers) {
      const job = slot.job;
      if (!job || scheduled.has(job.requestId)) continue;
      scheduled.add(job.requestId);
      // Captured Firefox LOD1 cave jobs took roughly0.6–1.1s with their rest;
      // this exercises the tile-corner deadline that a straight ray missed.
      const duration = job.preview ? 40 : job.step === 4 ? job.caveDetail ? 900 : 400 : 2500;
      jobs.set(job.requestId, { worker: slot.worker, job: { ...job }, due: now + duration });
    }
    if (seconds >= 6) assert.equal(manager.streaming.currentGroundCovered, true,
      `curve lacks canonical ground at ${seconds.toFixed(3)}s (x=${x.toFixed(1)},z=${z.toFixed(1)})`);
    maxStates = Math.max(maxStates, state.columns.size);
    seconds += frame % 2 ? 1 / 40 : 1 / 60;
  }
  assert.ok(maxStates < 850, 'curved route and safety guard stay within the existing selection');
  assert.equal(manager.streaming.flight, false); assert.equal(manager.streaming.detailRadius, 7);
});
