import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World, cavePathPoint } from '@shared/worldgen';
import {
  CAVE_FOG_FAR, CAVE_HORIZON_RADIUS, CAVE_MESH_RADIUS, CHUNK_SIZE,
  LOD1_RADIUS, LOD1_STEP,
} from '@shared/constants';
import { ChunkManager } from '../src/render/chunks.js';
import {
  partitionChunkMeshes, type ChunkMesh, type EntrancePortalMesh,
} from '../src/render/surfacenets.js';

interface MeshRequest {
  type: 'mesh';
  reqId: number;
  cx: number;
  cz: number;
  caveDetail: boolean;
  step: number;
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
  portalGroup: THREE.Group;
  onMeshed(slot: TestSlot, msg: TestMeshed): void;
  syncCoarseVisibility(): void;
  coarseVisibility(st: TestState): Uint8Array;
  removeState(st: TestState): void;
  advanceEmergencyCoverage(now: number): void;
  emergencyPreview: { key: string; builder: { sampledColumns: number } } | null;
}

function internals(manager: ChunkManager): ChunkInternals {
  return manager as unknown as ChunkInternals;
}

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
  const requestId = forcedReq++;
  const step = st.lod === 0 ? 1 : st.lod === 1 ? 4 : 16;
  st.status = 'meshing';
  st.requestId = requestId;
  const slot: TestSlot = {
    worker: new FakeWorker(),
    watchdog: null,
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
  assert.equal(st.status, 'ready');
  assert.equal(st.installed, true);
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

  complete(manager, fine);
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

  complete(manager, fine, [], finePortal(32, 64));
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

  complete(manager, fine);
  assert.equal(coarse.partVisible?.[4 * 16 + 5], 0,
    'a ready exact leaf must not overlap LOD2 while its LOD1 parent is pending');
  assert.equal(coarse.partVisible?.reduce((n, v) => n + v, 0), 255);

  complete(manager, mid);
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

test('installed finer geometry keeps masking ancestors during a cave upgrade', () => {
  const manager = new ChunkManager(1337, 1);
  manager.update(0, 200, 0);
  const state = internals(manager);
  const mid = state.columns.get('1:0,0');
  const far = state.columns.get('2:0,0');
  assert.ok(mid && far);
  complete(manager, far, flatTile(512, 16));
  complete(manager, mid, flatTile(128, 4));
  assert.equal(mid.installedCaveDetail, false);

  manager.update(0, -60, 0);
  assert.equal(mid.status, 'queued');
  assert.equal(mid.installed, true);
  assert.equal(mid.installedCaveDetail, false);
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
  complete(manager, fine);
  assert.equal(reconciled, 2,
    'completion work must be O(ancestor depth), not O(global LOD2 tile count)');
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

test('underground dispatch encloses the local cave then fills cheap surface coverage before exact detail', () => {
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
  assert.ok(order.slice(firstLod2).every((job) => job.preview),
    'expensive detail must not starve the first horizon coverage');
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

test('nearby ground detail starts before hundreds of distant horizon previews', () => {
  const manager = new ChunkManager(1337, 1);
  try {
    const state = internals(manager); let previews = 0, detailed = false;
    for (let i = 0; i < 60; i++) {
      manager.update(0, 200, 0);
      const slot = state.workers[0], job = slot.job;
      assert.ok(job);
      if (job.step === 1) { detailed = true; break; }
      assert.ok(job.preview, 'initial coarse work is cheap coverage');
      previews++;
      state.onMeshed(slot, { type: 'meshed', reqId: job.requestId, cx: job.cx, cz: job.cz,
        step: job.step, caveDetail: job.caveDetail, preview: true, chunks: [], portals: emptyPortals(job.step) });
    }
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
  complete(manager, fine, finePatch(32, 32));
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
