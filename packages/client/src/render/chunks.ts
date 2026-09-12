import * as THREE from 'three';
import {
  World, CHUNK_SIZE, VIEW_CHUNK_RADIUS, CAVE_DETAIL_RADIUS,
  CAVE_MESH_RADIUS,
  LOD1_STEP, LOD1_RADIUS, LOD2_STEP, WORLD,
} from '@shared/index';
import type { ChunkMesh, EntrancePortalMesh } from './surfacenets.js';
import { ENTRANCE_PORTAL_LIFT } from './surfacenets.js';
import { createTerrainMaterial } from './surface-material.js';
import { RoadField } from './road-field.js';
import { renderProfile } from './device-profile.js';
import { TerrainPreviewBuilder } from './terrain-preview.js';
import {
  CAVE_PORTAL_RENDER_ORDER, createEntrancePortalMaterial,
} from './cave-visibility.js';

// Streams one canonical terrain field around the camera at three resolutions:
//   LOD0 - full detail (1m voxels, 32m columns) within VIEW_CHUNK_RADIUS.
//   LOD1 - coarse mid terrain (4m voxels, 128m tiles) out to LOD1_RADIUS.
//   LOD2 - far terrain (16m voxels, 512m tiles) around the camera out beyond
//          the fog horizon, with a fixed budget independent of world area.
// Coarse tiles are fallbacks, not a second terrain layer. Their triangle soup
// is clipped into exact finer-grid footprints, and those parts are removed
// from the draw geometry as finer tiles become ready. Keeping the clipped CPU
// data resident lets a fallback reappear immediately after a camera move.
// Cameras underground or on an entrance approach request canonical cave
// bands at LOD0 and bounded LOD1. Entrance-cap crossing parity preserves real
// outside sightlines and darkens unseen far cave cutoffs from either side of
// a mouth. Far LOD2 stays surface-only to keep memory bounded.

type ColumnStatus = 'queued' | 'meshing' | 'ready';
type Lod = 0 | 1 | 2;

interface ColumnState {
  key: string;
  cx: number;
  cz: number;
  lod: Lod;
  caveDetail: boolean;
  status: ColumnStatus;
  requestId: number | null;
  /** A completed response, including a valid empty mesh, is installed. */
  installed: boolean;
  installedCaveDetail: boolean | null;
  /** Cheap heightfield coverage awaits its canonical SDF replacement. */
  previewInstalled: boolean;
  priority: number;
  /** Undesired installed geometry retained until its fallback is installed. */
  retiring: boolean;
  meshes: THREE.Mesh[];
  portalMeshes: THREE.Mesh[];
  /** CPU-side clipped geometry for independently masked coarse footprints. */
  parts: HorizontalParts | null;
  /** CPU-side entrance caps packed into the same horizontal footprints. */
  portalParts: PortalParts | null;
  partGrid: number;
  partVisible: Uint8Array | null;
}

interface WorkerSlot {
  worker: Worker;
  job: WorkerJob | null;
  watchdog: ReturnType<typeof setTimeout> | null;
}

interface WorkerJob {
  key: string;
  requestId: number;
  cx: number;
  cz: number;
  step: number;
  caveDetail: boolean;
  preview?: boolean;
}

interface MeshedMsg {
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

export interface ChunkMotion { vx: number; vz: number; flight: boolean }

export interface HorizontalParts {
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
  caveDepth?: Uint8Array;
  offsets: Uint32Array;
}

interface PortalParts {
  positions: Float32Array;
  offsets: Uint32Array;
}

const LOD1_TILE_M = CHUNK_SIZE * LOD1_STEP; // 128m
const LOD2_TILE_M = CHUNK_SIZE * LOD2_STEP; // 512m
/** ~1/3s of continuous open sky before cave rendering disengages. */
const OPEN_SKY_EXIT_FRAMES = 20;
const DIRECT_PARTS = LOD1_STEP; // Every direct LOD transition is exactly 4x4.
const LOD2_LEAF_PARTS = LOD1_STEP * LOD1_STEP; // Recursive 4x4 -> 4x4 LOD0 leaves.
const UPLOAD_BUDGET_MS = 3;
const UPLOADS_PER_FRAME = 2;
const EMERGENCY_DELAY_MS = 250;
const EMERGENCY_SAMPLE_BUDGET_MS = 1;

export class ChunkManager {
  readonly group = new THREE.Group();
  private readonly portalGroup = new THREE.Group();
  private readonly seed: number;
  private readonly terrainWorld: World;
  private readonly columns = new Map<string, ColumnState>();
  private readonly material: THREE.MeshStandardMaterial;
  private readonly roads: RoadField;
  private readonly portalMaterial = createEntrancePortalMaterial();
  private readonly workers: WorkerSlot[] = [];
  private queue: ColumnState[] = [];
  private readonly pendingMeshes: { slot: WorkerSlot; worker: Worker; msg: MeshedMsg }[] = [];
  private readonly desired = new Set<string>();
  private lastCcx = 1e9;
  private lastCcz = 1e9;
  private lastMidCx = 1e9;
  private lastMidCz = 1e9;
  private lastUnderground = false;
  private cameraRoofed = false;
  private belowSurfaceEnvelope = false;
  private openSkyStreak = 0;
  private haveSelection = false;
  private lastPx = 0;
  private lastPz = 0;
  private flight = false;
  private flightDetailTier: 0 | 1 | 2 = 0;
  private detailRadius = VIEW_CHUNK_RADIUS;
  private lookX = 0;
  private lookZ = 0;
  private selectionMs = 0;
  private installMs = 0;
  private emergencyMs = 0;
  private missingCoverageSince: number | null = null;
  private emergencyPreview: { key: string; builder: TerrainPreviewBuilder } | null = null;
  private reqId = 1;
  private disposed = false;
  private readonly workerTimeoutMs: number;
  private readonly profile = renderProfile();
  stats = { columnsReady: 0, columnsPending: 0, triangles: 0 };

  constructor(seed: number, workerCount = 0, workerTimeoutMs = 45_000) {
    this.seed = seed;
    this.workerTimeoutMs = workerTimeoutMs;
    this.terrainWorld = new World(seed);
    this.roads = new RoadField(this.terrainWorld);
    this.material = createTerrainMaterial(this.roads.uniforms);
    this.group.add(this.portalGroup);
    if (workerCount <= 0) {
      const hc = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4;
      workerCount = Math.min(this.profile.workers, Math.max(2, Math.floor(hc / 2)));
    }
    for (let i = 0; i < workerCount; i++) {
      const slot: WorkerSlot = {
        worker: null as unknown as Worker,
        job: null,
        watchdog: null,
      };
      slot.worker = this.createWorker(slot);
      this.workers.push(slot);
    }
  }

  get isUnderground(): boolean {
    return this.cameraRoofed;
  }

  /** Starting parity for rays crossing the invisible terrain envelope. */
  get isBelowSurfaceEnvelope(): boolean {
    return this.belowSurfaceEnvelope;
  }

  /** Lightweight QA counters, separate from the public HUD stats contract. */
  get streaming() {
    const installed = { preview: 0, lod0: 0, lod1: 0, lod2: 0 };
    for (const st of this.columns.values()) {
      if (!st.installed) continue;
      if (st.previewInstalled) installed.preview++;
      else if (st.lod === 0) installed.lod0++;
      else if (st.lod === 1) installed.lod1++;
      else installed.lod2++;
    }
    const covered = (x: number, z: number) => {
      for (const [lod, size] of [[0, CHUNK_SIZE], [1, LOD1_TILE_M], [2, LOD2_TILE_M]]) {
        if (this.columns.get(`${lod}:${Math.floor(x / size)},${Math.floor(z / size)}`)?.installed) return true;
      }
      return false;
    };
    return { queued: this.queue.length, inFlight: this.workers.filter((s) => s.job !== null).length,
      waitingUploads: this.pendingMeshes.length, installed, selectionMs: this.selectionMs, installMs: this.installMs,
      currentCovered: covered(this.lastPx, this.lastPz),
      aheadCovered: covered(this.lastPx + this.lookX, this.lastPz + this.lookZ),
      flight: this.flight, detailRadius: this.detailRadius, emergencyMs: this.emergencyMs,
      emergencySamples: this.emergencyPreview?.builder.sampledColumns ?? 0 };
  }

  /** Call every frame with the player/camera position. */
  update(px: number, py: number, pz: number, motion?: ChunkMotion): void {
    if (!this.disposed) this.roads.update(px, pz);
    if (this.disposed || !Number.isFinite(px + py + pz)) return;
    this.lastPx = px;
    this.lastPz = pz;
    const ccx = Math.floor(px / CHUNK_SIZE);
    const ccz = Math.floor(pz / CHUNK_SIZE);
    // Roof state and envelope parity update immediately. Streaming alone
    // has hysteresis, so a jagged mouth cannot thrash the cave-band queue or
    // leave the sky using an old camera-side stencil after an exit.
    const finite = Number.isFinite(px + py + pz);
    const col = finite ? this.terrainWorld.column(px, pz) : undefined;
    const previousRadius = this.detailRadius, previousFlight = this.flight;
    this.flight = motion?.flight === true;
    const speed = motion && Number.isFinite(motion.vx + motion.vz) ? Math.hypot(motion.vx, motion.vz) : 0;
    const lookSeconds = speed > 1 && this.flight ? Math.min(4, 768 / speed) : 0;
    this.lookX = lookSeconds > 0 ? motion!.vx * lookSeconds : 0;
    this.lookZ = lookSeconds > 0 ? motion!.vz * lookSeconds : 0;
    const midCx = Math.floor((px + this.lookX * 0.4) / LOD1_TILE_M);
    const midCz = Math.floor((pz + this.lookZ * 0.4) / LOD1_TILE_M);
    const altitude = col ? py - col.h : 0;
    const normalRadius = Math.min(VIEW_CHUNK_RADIUS, this.profile.nearChunks);
    // A pilot hundreds of metres above the ground cannot see 1m cave detail.
    // Restore the normal footprint before landing; separate climb/descent
    // thresholds prevent bank/terrain-height jitter from thrashing the queue.
    if (!this.flight) this.flightDetailTier = 0;
    else if (!previousFlight) this.flightDetailTier = altitude > 48 ? 2 : altitude > 18 ? 1 : 0;
    else if (altitude < 14) this.flightDetailTier = 0;
    else if (altitude > 56) this.flightDetailTier = 2;
    else if (this.flightDetailTier === 0 && altitude > 24) this.flightDetailTier = 1;
    else if (this.flightDetailTier === 2 && altitude < 40) this.flightDetailTier = 1;
    this.detailRadius = this.flightDetailTier === 2 ? -1
      : this.flightDetailTier === 1 ? Math.min(3, normalRadius) : normalRadius;
    const roofed = finite && this.terrainWorld.roofedAbove(px, py, pz);
    this.cameraRoofed = roofed;
    this.belowSurfaceEnvelope = !!col && py < col.h + ENTRANCE_PORTAL_LIFT;
    // An exterior view into a gallery can see genuine cave walls hundreds
    // of metres away. Prefetch the same bounded cave disk from the padded
    // approach, before walking under its roof, instead of exposing the
    // surface-only fallback's absent underground band through the mouth.
    const needsCaves = roofed || (!!col?.cave && py < col.h + 20);
    const movedFar = Math.max(Math.abs(ccx - this.lastCcx), Math.abs(ccz - this.lastCcz)) > 2;
    let underground = this.lastUnderground;
    if (!this.haveSelection || needsCaves || movedFar) {
      underground = needsCaves;
      this.openSkyStreak = 0;
    } else if (underground && !needsCaves) {
      if (++this.openSkyStreak >= OPEN_SKY_EXIT_FRAMES) underground = false;
    } else {
      this.openSkyStreak = 0;
    }
    // Caps run for exterior cameras too: crossing into a cave marks a far
    // cutoff ray; crossing back out clears it. They never write color/depth.
    if (!this.haveSelection || ccx !== this.lastCcx || ccz !== this.lastCcz ||
        midCx !== this.lastMidCx || midCz !== this.lastMidCz || underground !== this.lastUnderground ||
        previousRadius !== this.detailRadius || previousFlight !== this.flight) {
      this.lastCcx = ccx;
      this.lastCcz = ccz;
      this.lastMidCx = midCx;
      this.lastMidCz = midCz;
      this.lastUnderground = underground;
      this.haveSelection = true;
      const start = performance.now();
      this.rebuildSelection(px, pz, ccx, ccz, underground);
      this.selectionMs = performance.now() - start;
    }
    // Completions and selection changes reconcile only affected ancestors.
    // A stationary camera never needs a global fallback-mask pass.
    this.flushMeshes();
    this.advanceEmergencyCoverage();
    this.pump(px, pz);
  }

  private rebuildSelection(px: number, pz: number, ccx: number, ccz: number, underground: boolean): void {
    const previous = new Set(this.desired);
    this.desired.clear();
    // ---- LOD0 ring -------------------------------------------------------
    const R = this.detailRadius;
    for (let dz = -R; dz <= R; dz++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dz * dz > R * R + 1) continue;
        const cx = ccx + dx;
        const cz = ccz + dz;
        const key = `0:${cx},${cz}`;
        const caveDetail = underground ||
          dx * dx + dz * dz <= CAVE_DETAIL_RADIUS * CAVE_DETAIL_RADIUS;
        this.desired.add(key);
        this.ensureColumn(0, cx, cz, caveDetail);
      }
    }

    // ---- LOD1 ring -------------------------------------------------------
    const t1R = Math.ceil(LOD1_RADIUS / LOD1_TILE_M) + 1;
    const aheadScale = this.flight ? 0.4 : 0;
    const midX = px + this.lookX * aheadScale, midZ = pz + this.lookZ * aheadScale;
    const t1cx = Math.floor(midX / LOD1_TILE_M);
    const t1cz = Math.floor(midZ / LOD1_TILE_M);
    for (let dz = -t1R; dz <= t1R; dz++) {
      for (let dx = -t1R; dx <= t1R; dx++) {
        const tx = t1cx + dx;
        const tz = t1cz + dz;
        const centerX = (tx + 0.5) * LOD1_TILE_M;
        const centerZ = (tz + 0.5) * LOD1_TILE_M;
        const dist = Math.hypot(centerX - midX, centerZ - midZ);
        if (dist > LOD1_RADIUS) continue;
        const rectDx = Math.max(0, Math.abs(centerX - px) - LOD1_TILE_M * 0.5);
        const rectDz = Math.max(0, Math.abs(centerZ - pz) - LOD1_TILE_M * 0.5);
        const key = `1:${tx},${tz}`;
        this.desired.add(key);
        this.ensureColumn(1, tx, tz,
          underground && Math.hypot(rectDx, rectDz) <= CAVE_MESH_RADIUS);
      }
    }

    // ---- LOD2: camera-local horizon, independent of world area ------------
    const radius = this.profile.farRadius;
    const xlo = Math.floor(Math.max(-WORLD.BORDER, px - radius) / LOD2_TILE_M);
    const xhi = Math.ceil(Math.min(WORLD.BORDER, px + radius) / LOD2_TILE_M) - 1;
    const zlo = Math.floor(Math.max(-WORLD.BORDER, pz - radius) / LOD2_TILE_M);
    const zhi = Math.ceil(Math.min(WORLD.BORDER, pz + radius) / LOD2_TILE_M) - 1;
    for (let tz = zlo; tz <= zhi; tz++) {
      for (let tx = xlo; tx <= xhi; tx++) {
        const dx = Math.max(0, Math.abs((tx + 0.5) * LOD2_TILE_M - px) - LOD2_TILE_M * 0.5);
        const dz = Math.max(0, Math.abs((tz + 0.5) * LOD2_TILE_M - pz) - LOD2_TILE_M * 0.5);
        if (Math.hypot(dx, dz) > radius) continue;
        const key = `2:${tx},${tz}`;
        this.desired.add(key);
        // The underground fog horizon is opaque except where a depth-visible
        // canonical entrance cap marks a real outside sightline. LOD2 stays
        // surface-only: global step-16 cave slabs would consume hundreds of
        // MB and seconds of worker CPU.
        this.ensureColumn(2, tx, tz, false);
      }
    }

    // Only changed installed coverage can alter a parent mask. A moving
    // camera used to rebuild all 300 horizon masks (256 leaves each).
    const changedParents = new Set<string>();
    for (const st of this.columns.values()) {
      if (st.lod === 2 || !st.installed || previous.has(st.key) === this.desired.has(st.key)) continue;
      if (st.lod === 0) changedParents.add(`1:${Math.floor(st.cx / 4)},${Math.floor(st.cz / 4)}`);
      changedParents.add(`2:${Math.floor(st.cx / (st.lod === 0 ? 16 : 4))},${Math.floor(st.cz / (st.lod === 0 ? 16 : 4))}`);
    }
    this.pruneUndesired();
    this.cancelObsoleteJobs();
    for (const key of changedParents) this.syncOneCoarse(this.columns.get(key));
    this.refreshStats();
  }

  private ensureColumn(lod: Lod, cx: number, cz: number, caveDetail: boolean): void {
    const key = `${lod}:${cx},${cz}`;
    const existing = this.columns.get(key);
    if (existing) {
      existing.retiring = false;
      // Detail is monotonic for a resident tile. If an old request is already
      // in flight, its response is discarded and immediately requeued.
      if (caveDetail) existing.caveDetail = true;
      if (caveDetail && existing.installed &&
          existing.installedCaveDetail !== true && existing.status === 'ready') {
        existing.status = 'queued';
        this.queue.push(existing);
      }
      return;
    }
    const st: ColumnState = {
      key, cx, cz, lod, caveDetail,
      status: 'queued', requestId: null, meshes: [], portalMeshes: [],
      installed: false, installedCaveDetail: null, retiring: false,
      previewInstalled: false,
      priority: 0,
      parts: null, portalParts: null, partGrid: 0, partVisible: null,
    };
    this.columns.set(key, st);
    this.queue.push(st);
  }

  private pruneUndesired(): void {
    let queueChanged = false;
    for (const [key, st] of this.columns) {
      if (this.desired.has(key)) continue;
      if (!st.installed || this.fallbackInstalled(st)) {
        this.removeState(st);
        queueChanged = true;
        continue;
      }
      // Keep visible geometry until a current desired fallback is installed.
      // Cancel a queued upgrade; an in-flight job may finish, but its state
      // remains addressable and can be safely retired in that callback.
      st.retiring = true;
      if (st.status === 'queued') {
        st.status = 'ready';
        st.requestId = null;
        queueChanged = true;
      }
    }
    if (queueChanged) this.compactQueue();
  }

  private pruneRetiring(): void {
    let removed = false;
    for (const st of [...this.columns.values()]) {
      if (!st.retiring || !this.fallbackInstalled(st)) continue;
      this.removeState(st);
      removed = true;
    }
    if (removed) this.compactQueue();
  }

  private fallbackInstalled(st: ColumnState): boolean {
    // A paged-out horizon tile has no coarser fallback and needs none: its
    // footprint is beyond fully saturated fog. Drop old nearby geometry too
    // after a long teleport instead of retaining it forever awaiting a tile
    // the new camera will never request.
    if (st.lod === 2) return true;
    const size = CHUNK_SIZE * (st.lod === 0 ? 1 : LOD1_STEP);
    const dx = Math.max(0, Math.abs((st.cx + 0.5) * size - this.lastPx) - size * 0.5);
    const dz = Math.max(0, Math.abs((st.cz + 0.5) * size - this.lastPz) - size * 0.5);
    if (Math.hypot(dx, dz) > this.profile.farRadius) return true;
    if (st.lod === 0) {
      const t1x = Math.floor(st.cx / LOD1_STEP);
      const t1z = Math.floor(st.cz / LOD1_STEP);
      if (this.desiredInstalled(`1:${t1x},${t1z}`)) return true;
      const t2x = Math.floor(st.cx / LOD2_STEP);
      const t2z = Math.floor(st.cz / LOD2_STEP);
      return this.desiredInstalled(`2:${t2x},${t2z}`);
    }
    const t2x = Math.floor(st.cx / DIRECT_PARTS);
    const t2z = Math.floor(st.cz / DIRECT_PARTS);
    return this.desiredInstalled(`2:${t2x},${t2z}`);
  }

  /**
   * Rebuild only coarse draw geometry whose exact finer-coverage mask changed.
   * Coverage is selection-local: a stale ready state awaiting pruning can
   * never hide a fallback needed by the new camera selection.
   */
  private syncCoarseVisibility(changed?: ColumnState): void {
    if (!changed) {
      for (const st of this.columns.values()) this.syncOneCoarse(st);
      return;
    }
    // A completion can only alter its two ancestors. Avoid allocating masks
    // for every resident LOD2 tile on each nearby LOD0 completion.
    if (changed.lod === 0) {
      this.syncOneCoarse(this.columns.get(
        `1:${Math.floor(changed.cx / LOD1_STEP)},${Math.floor(changed.cz / LOD1_STEP)}`,
      ));
      this.syncOneCoarse(this.columns.get(
        `2:${Math.floor(changed.cx / LOD2_STEP)},${Math.floor(changed.cz / LOD2_STEP)}`,
      ));
    } else if (changed.lod === 1) {
      this.syncOneCoarse(this.columns.get(
        `2:${Math.floor(changed.cx / DIRECT_PARTS)},${Math.floor(changed.cz / DIRECT_PARTS)}`,
      ));
    }
  }

  private syncOneCoarse(st: ColumnState | undefined): void {
    // A coarse surface-only mesh may stay visible while its cave-detail
    // replacement is queued. It must still honor installed finer masks.
    if (!st || st.lod === 0 || !st.parts || !st.partVisible) return;
    const next = this.coarseVisibility(st);
    for (let i = 0; i < next.length; i++) {
      if (next[i] === st.partVisible[i]) continue;
      st.partVisible = next;
      this.rebuildCoarseMeshes(st);
      return;
    }
  }

  private coarseVisibility(st: ColumnState): Uint8Array {
    const grid = st.partGrid;
    const visible = new Uint8Array(grid * grid);
    for (let pz = 0; pz < grid; pz++) {
      for (let px = 0; px < grid; px++) {
        let covered = false;
        if (st.lod === 1) {
          const cx = st.cx * LOD1_STEP + px;
          const cz = st.cz * LOD1_STEP + pz;
          covered = this.desiredInstalled(`0:${cx},${cz}`);
        } else {
          // LOD2 is recursively partitioned at LOD0 granularity. A direct
          // ready LOD1 child masks its whole 4x4 block; while that request is
          // pending, independently ready LOD0 leaves still mask exactly their
          // own 32m footprint, never an adjacent uncovered area.
          const t1x = st.cx * DIRECT_PARTS + Math.floor(px / DIRECT_PARTS);
          const t1z = st.cz * DIRECT_PARTS + Math.floor(pz / DIRECT_PARTS);
          covered = this.desiredInstalled(`1:${t1x},${t1z}`);
          if (!covered) {
            const cx = st.cx * LOD2_STEP + px;
            const cz = st.cz * LOD2_STEP + pz;
            covered = this.desiredInstalled(`0:${cx},${cz}`);
          }
        }
        visible[pz * grid + px] = covered ? 0 : 1;
      }
    }
    return visible;
  }

  private desiredInstalled(key: string): boolean {
    if (!this.desired.has(key)) return false;
    const st = this.columns.get(key);
    return !!st && st.installed;
  }

  private removeState(st: ColumnState): void {
    if (this.columns.get(st.key) !== st) return;
    this.columns.delete(st.key);
    this.disposeMeshes(st);
    st.installed = false;
    st.installedCaveDetail = null;
    st.retiring = false;
    st.parts = null;
    st.portalParts = null;
    st.partVisible = null;
    st.partGrid = 0;
  }

  private compactQueue(): void {
    this.queue = this.queue.filter((st) =>
      this.columns.get(st.key) === st && st.status === 'queued');
  }

  /** Cancel work whose state was evicted instead of spending seconds meshing
   * a runway the jet left behind. Worker generations reject any late reply. */
  private cancelObsoleteJobs(): void {
    for (const slot of this.workers) {
      if (!slot.job || this.columns.get(slot.job.key)?.requestId === slot.job.requestId) continue;
      this.clearWatchdog(slot);
      const old = slot.worker;
      old.onmessage = null; old.onerror = null; old.onmessageerror = null;
      old.terminate(); slot.job = null;
      for (let i = this.pendingMeshes.length - 1; i >= 0; i--) {
        if (this.pendingMeshes[i].slot === slot) this.pendingMeshes.splice(i, 1);
      }
      slot.worker = this.createWorker(slot);
    }
  }

  private flushMeshes(): void {
    const start = performance.now();
    let installed = 0;
    while (this.pendingMeshes.length && installed < UPLOADS_PER_FRAME &&
      (installed === 0 || performance.now() - start < UPLOAD_BUDGET_MS)) {
      const pending = this.pendingMeshes.shift()!;
      if (pending.worker !== pending.slot.worker) continue;
      this.onMeshed(pending.slot, pending.msg);
      installed++;
    }
    this.installMs = performance.now() - start;
  }

  /** Some browsers defer worker startup under sustained rendering pressure.
   * Keep a single camera/ahead tile progressing in bounded frame slices. The
   * ordinary worker pool still owns canonical refinement and the horizon. */
  private advanceEmergencyCoverage(now = performance.now()): void {
    this.emergencyMs = 0;
    if (!this.flight || this.flightDetailTier !== 2 || this.cameraRoofed || this.belowSurfaceEnvelope) {
      this.emergencyPreview = null; this.missingCoverageSince = null; return;
    }
    const missing = (x: number, z: number) => {
      for (const [lod, size] of [[0, CHUNK_SIZE], [1, LOD1_TILE_M]]) {
        if (this.columns.get(`${lod}:${Math.floor(x / size)},${Math.floor(z / size)}`)?.installed) return undefined;
      }
      const st = this.columns.get(`2:${Math.floor(x / LOD2_TILE_M)},${Math.floor(z / LOD2_TILE_M)}`);
      return st && !st.installed && this.desired.has(st.key) ? st : undefined;
    };
    const current = missing(this.lastPx, this.lastPz);
    // Walk the crossed coarse tiles in travel order. Sampling only the end
    // of lookahead could cancel a half-built tile as that endpoint entered
    // its next neighbor, just before the camera entered the discarded tile.
    const crossings = [0, 1];
    for (const [start, delta] of [[this.lastPx, this.lookX], [this.lastPz, this.lookZ]]) {
      if (Math.abs(delta) < .001) continue;
      const lo = Math.min(start, start + delta), hi = Math.max(start, start + delta);
      for (let edge = (Math.floor(lo / LOD2_TILE_M) + 1) * LOD2_TILE_M; edge < hi; edge += LOD2_TILE_M)
        crossings.push((edge - start) / delta);
    }
    crossings.sort((a, b) => a - b);
    let ahead: ColumnState | undefined;
    for (let i = 1; i < crossings.length && !ahead; i++) {
      const t = (crossings[i - 1] + crossings[i]) * .5;
      ahead = missing(this.lastPx + this.lookX * t, this.lastPz + this.lookZ * t);
    }
    ahead ??= missing(this.lastPx + this.lookX, this.lastPz + this.lookZ);
    if (!current && !ahead) {
      this.emergencyPreview = null; this.missingCoverageSince = null; return;
    }
    this.missingCoverageSince ??= now;
    if (now - this.missingCoverageSince < EMERGENCY_DELAY_MS) return;
    const active = this.emergencyPreview && this.columns.get(this.emergencyPreview.key);
    if (!active || active.installed || (active.key !== current?.key && active.key !== ahead?.key)) this.emergencyPreview = null;
    if (!this.emergencyPreview) {
      const target = (current ?? ahead)!;
      this.emergencyPreview = { key: target.key, builder: new TerrainPreviewBuilder(this.terrainWorld, target.cx, target.cz) };
    }
    const started = performance.now();
    const pending = this.emergencyPreview;
    const bundle = pending.builder.advance(started + EMERGENCY_SAMPLE_BUDGET_MS, 32);
    if (bundle) {
      const st = this.columns.get(pending.key);
      if (st && !st.installed && this.desired.has(st.key)) {
        this.installGeometry(st, bundle.chunks, bundle.portals);
        st.installed = true; st.installedCaveDetail = false; st.previewInstalled = true;
        // Preserve any running worker request. Its delayed preview will only
        // release that slot for refinement, never overwrite this geometry.
        this.pruneRetiring(); this.syncCoarseVisibility(st); this.refreshStats();
      }
      this.emergencyPreview = null;
    }
    this.emergencyMs = performance.now() - started;
  }

  private pump(px: number, pz: number): void {
    if (this.disposed || this.queue.length === 0) return;
    const free = this.workers.filter((w) => w.job === null &&
      (!this.flight || this.workers.length === 1 || w !== this.workers[0] ||
        this.queue.some((st) => st.status === 'queued' && st.lod === 2 && !st.installed)));
    if (free.length === 0) return;

    // Cover the nearby landscape first, then refine the ground underfoot.
    // Hundreds of distant preview tiles must not delay those first nine
    // detailed columns. Flight keeps a worker dedicated to horizon coverage.
    const priority = (s: ColumnState): number => {
      const tileM = s.lod === 0 ? CHUNK_SIZE : s.lod === 1 ? LOD1_TILE_M : LOD2_TILE_M;
      const loX = s.cx * tileM, hiX = loX + tileM;
      const loZ = s.cz * tileM, hiZ = loZ + tileM;
      const rx = px < loX ? loX - px : px > hiX ? px - hiX : 0;
      const rz = pz < loZ ? loZ - pz : pz > hiZ ? pz - hiZ : 0;
      const rectDist = Math.hypot(rx, rz);
      const centerDist = Math.hypot((loX + hiX) * 0.5 - px, (loZ + hiZ) * 0.5 - pz);
      if (s.lod === 2 && !s.installed) {
        const ax = Math.max(loX - px - this.lookX, px + this.lookX - hiX, 0);
        const az = Math.max(loZ - pz - this.lookZ, pz + this.lookZ - hiZ, 0);
        const distance = Math.min(rectDist, Math.hypot(ax, az) + 128);
        return (distance < 768 || this.lastUnderground ? -10_000_000 : -1_000_000) + distance + centerDist * 0.001;
      }
      // An underground camera needs real walls around its own position;
      // surface previews cannot provide that first local cave enclosure.
      if (this.lastUnderground && s.lod === 1 && rectDist < 1e-6) return -11_000_000 + centerDist;
      if (s.lod === 0) {
        const ccx = Math.floor(px / CHUNK_SIZE), ccz = Math.floor(pz / CHUNK_SIZE);
        if (Math.max(Math.abs(s.cx - ccx), Math.abs(s.cz - ccz)) <= 1) {
          return -3_000_000 + centerDist;
        }
      }
      const lodBias = s.lod === 2 ? 0 : s.lod === 1 ? 100 : 200;
      return rectDist / tileM * 1000 + lodBias + centerDist / tileM;
    };
    for (const st of this.queue) st.priority = priority(st);
    this.queue.sort((a, b) =>
      a.priority - b.priority || b.lod - a.lod || a.key.localeCompare(b.key));

    for (const slot of free) {
      // Keep one flight worker immediately available for entering horizon
      // tiles. A four-second cave job on every worker defeats queue priority.
      const coverageOnly = this.flight && this.workers.length > 1 && slot === this.workers[0];
      let st: ColumnState | undefined;
      while (this.queue.length > 0) {
        const index = coverageOnly ? this.queue.findIndex((s) => s.lod === 2 && !s.installed) : 0;
        if (index < 0) break;
        const candidate = this.queue.splice(index, 1)[0];
        if (this.columns.get(candidate.key) === candidate && candidate.status === 'queued') {
          st = candidate;
          break;
        }
      }
      if (!st) break;
      const requestId = this.reqId++;
      st.status = 'meshing';
      st.requestId = requestId;
      const step = st.lod === 0 ? 1 : st.lod === 1 ? LOD1_STEP : LOD2_STEP;
      slot.job = {
        key: st.key, requestId, cx: st.cx, cz: st.cz,
        step, caveDetail: st.caveDetail,
        preview: st.lod === 2 && !st.installed,
      };
      this.armWatchdog(slot, requestId);
      try {
        slot.worker.postMessage({
          type: 'mesh',
          reqId: requestId,
          cx: st.cx,
          cz: st.cz,
          caveDetail: st.caveDetail,
          step,
          preview: slot.job.preview,
        });
      } catch {
        this.onWorkerError(slot, slot.worker);
      }
    }
  }

  private onMeshed(slot: WorkerSlot, msg: MeshedMsg): void {
    if (this.disposed) return;
    // A delayed result must not free a slot or overwrite a newer generation.
    const job = slot.job;
    if (!job || job.requestId !== msg.reqId) return;
    // A response with the right id but wrong payload would otherwise free the
    // slot and strand the real state as `meshing` forever. Treat it exactly
    // like a worker failure and retry on a fresh worker.
    if (msg.cx !== job.cx || msg.cz !== job.cz || msg.step !== job.step ||
        msg.caveDetail !== job.caveDetail ||
        (msg.preview === true) !== (job.preview === true) ||
        !this.validChunkPayload(msg.chunks, job.step) ||
        !this.validPortalPayload(msg.portals, job.step)) {
      this.onWorkerError(slot, slot.worker);
      return;
    }
    this.clearWatchdog(slot);
    slot.job = null;
    const st = this.columns.get(job.key);
    if (!st || st.requestId !== msg.reqId) {
      this.pump(this.lastPx, this.lastPz);
      return; // evicted/replaced mid-flight
    }
    st.requestId = null;

    // The camera entered this column's cave-detail radius while the old,
    // surface-only request was running. Do not install the stale geometry.
    if (job.caveDetail !== st.caveDetail) {
      if (st.retiring && st.installed) {
        st.status = 'ready';
      } else {
        st.status = 'queued';
        this.queue.push(st);
      }
      this.pruneRetiring();
      this.refreshStats();
      this.pump(this.lastPx, this.lastPz);
      return;
    }

    if (st.retiring && this.fallbackInstalled(st)) {
      this.removeState(st);
      this.compactQueue();
      this.refreshStats();
      this.pump(this.lastPx, this.lastPz);
      return;
    }

    if (!(job.preview && st.previewInstalled)) this.installGeometry(st, msg.chunks, msg.portals);
    st.status = job.preview ? 'queued' : 'ready';
    st.installed = true;
    st.installedCaveDetail = job.caveDetail;
    st.previewInstalled = job.preview === true;
    if (job.preview) this.queue.push(st);
    this.pruneRetiring();
    // Every finer completion can change one or more exact coarse masks.
    this.syncCoarseVisibility(st);
    this.refreshStats();
    this.pump(this.lastPx, this.lastPz);
  }

  private installGeometry(st: ColumnState, chunks: ChunkMesh[], portals: EntrancePortalMesh): void {
    let fresh: THREE.Mesh[];
    let freshPortals: THREE.Mesh[];
    if (st.lod === 0) {
      st.parts = null;
      st.portalParts = null;
      st.partGrid = 0;
      st.partVisible = null;
      fresh = chunks.map((chunk) => this.createMesh(chunk));
      freshPortals = portals.positions.length > 0
        ? [this.createPortalMesh(portals.positions)]
        : [];
    } else {
      const grid = st.lod === 1 ? DIRECT_PARTS : LOD2_LEAF_PARTS;
      st.parts = this.partsFromPacked(chunks, grid);
      st.portalParts = this.portalPartsFromPacked(portals, grid);
      st.partGrid = grid;
      st.partVisible = this.coarseVisibility(st);
      fresh = this.meshesForParts(st.parts, st.partVisible);
      freshPortals = this.meshesForPortalParts(st.portalParts, st.partVisible);
    }
    // Swap after adding the replacement to avoid a visible hole.
    this.swapMeshes(st, fresh, freshPortals);
  }

  private createMesh(chunk: Pick<ChunkMesh, 'positions' | 'normals' | 'colors' | 'caveDepth'>): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(chunk.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(chunk.colors, 3, true));
    geo.setAttribute('caveDepth', new THREE.BufferAttribute(
      chunk.caveDepth ?? new Uint8Array(chunk.positions.length / 3), 1,
    ));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.material);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  private createPortalMesh(positions: Float32Array): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.portalMaterial);
    mesh.renderOrder = CAVE_PORTAL_RENDER_ORDER;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  private validChunkPayload(chunks: readonly ChunkMesh[], step: number): boolean {
    const grid = step === 1 ? 0 : step;
    for (const chunk of chunks) {
      if (chunk.positions.length !== chunk.normals.length ||
          chunk.positions.length !== chunk.colors.length ||
          chunk.positions.length % 9 !== 0) return false;
      if (chunk.caveDepth !== undefined &&
          (!(chunk.caveDepth instanceof Uint8Array) ||
           chunk.caveDepth.length * 3 !== chunk.positions.length)) return false;
      if (step === 1) {
        if (chunk.partGrid !== undefined || chunk.partOffsets !== undefined) return false;
        continue;
      }
      const offsets = chunk.partOffsets;
      if (chunk.partGrid !== grid || !offsets || offsets.length !== grid * grid + 1 ||
          offsets[0] !== 0 || offsets[offsets.length - 1] !== chunk.positions.length) return false;
      for (let i = 1; i < offsets.length; i++) {
        if (offsets[i] < offsets[i - 1] || offsets[i] % 9 !== 0) return false;
      }
    }
    return true;
  }

  private validPortalPayload(
    portal: EntrancePortalMesh, step: number,
  ): boolean {
    if (!portal || !(portal.positions instanceof Float32Array)) return false;
    if (portal.positions.length % 9 !== 0) return false;
    if (step === 1) {
      return portal.partGrid === undefined && portal.partOffsets === undefined;
    }
    if (step >= LOD2_STEP) {
      return portal.positions.length === 0 &&
        portal.partGrid === undefined && portal.partOffsets === undefined;
    }
    const offsets = portal.partOffsets;
    if (portal.partGrid !== step || !offsets ||
        offsets.length !== step * step + 1 ||
        offsets[0] !== 0 ||
        offsets[offsets.length - 1] !== portal.positions.length) return false;
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i] < offsets[i - 1] || offsets[i] % 9 !== 0) return false;
    }
    return true;
  }

  private partsFromPacked(chunks: readonly ChunkMesh[], grid: number): HorizontalParts {
    if (chunks.length === 0) {
      return {
        positions: new Float32Array(0),
        normals: new Float32Array(0),
        colors: new Uint8Array(0),
        offsets: new Uint32Array(grid * grid + 1),
      };
    }
    if (chunks.length === 1) {
      return {
        positions: chunks[0].positions,
        normals: chunks[0].normals,
        colors: chunks[0].colors,
        caveDepth: chunks[0].caveDepth,
        offsets: chunks[0].partOffsets!,
      };
    }
    // The worker normally emits one packed column. Keep a compact merge path
    // for future per-vertical-slice packing without allocating one typed
    // array object per leaf across the resident LOD2 set.
    const partCount = grid * grid;
    let total = 0;
    const offsets = new Uint32Array(partCount + 1);
    for (let part = 0; part < partCount; part++) {
      offsets[part] = total;
      for (const chunk of chunks) {
        total += chunk.partOffsets![part + 1] - chunk.partOffsets![part];
      }
    }
    offsets[partCount] = total;
    const positions = new Float32Array(total);
    const normals = new Float32Array(total);
    const colors = new Uint8Array(total);
    const caveDepth = new Uint8Array(total / 3);
    let offset = 0;
    for (let part = 0; part < partCount; part++) {
      for (const chunk of chunks) {
        const lo = chunk.partOffsets![part], hi = chunk.partOffsets![part + 1];
        positions.set(chunk.positions.subarray(lo, hi), offset);
        normals.set(chunk.normals.subarray(lo, hi), offset);
        colors.set(chunk.colors.subarray(lo, hi), offset);
        if (chunk.caveDepth) caveDepth.set(chunk.caveDepth.subarray(lo / 3, hi / 3), offset / 3);
        offset += hi - lo;
      }
    }
    return { positions, normals, colors, caveDepth, offsets };
  }

  private portalPartsFromPacked(
    portal: EntrancePortalMesh, grid: number,
  ): PortalParts {
    if (portal.positions.length === 0) {
      return {
        positions: portal.positions,
        offsets: new Uint32Array(grid * grid + 1),
      };
    }
    return {
      positions: portal.positions,
      offsets: portal.partOffsets!,
    };
  }

  private meshesForParts(parts: HorizontalParts, visible: Uint8Array): THREE.Mesh[] {
    if (parts.positions.length === 0) return [];
    const mesh = this.createMesh(parts);
    this.setVisibleParts(mesh, parts.offsets, visible);
    return [mesh];
  }

  private meshesForPortalParts(parts: PortalParts, visible: Uint8Array): THREE.Mesh[] {
    if (parts.positions.length === 0) return [];
    const mesh = this.createPortalMesh(parts.positions);
    this.setVisibleParts(mesh, parts.offsets, visible);
    return [mesh];
  }

  /** Keep vertex buffers, bounds and mesh objects intact across mask changes.
   * Only one reusable index buffer changes; no terrain arrays are recopied. */
  private setVisibleParts(mesh: THREE.Mesh, offsets: Uint32Array, visible: Uint8Array): void {
    const geometry = mesh.geometry;
    let index = geometry.index;
    if (!index) {
      index = new THREE.BufferAttribute(new Uint32Array(geometry.getAttribute('position').count), 1);
      index.setUsage(THREE.DynamicDrawUsage);
      geometry.setIndex(index);
    }
    const values = index.array as Uint32Array;
    let count = 0;
    for (let part = 0; part < visible.length; part++) {
      if (!visible[part]) continue;
      for (let vertex = offsets[part] / 3; vertex < offsets[part + 1] / 3; vertex++) values[count++] = vertex;
    }
    geometry.setDrawRange(0, count);
    mesh.visible = count > 0;
    index.clearUpdateRanges();
    if (count > 0) index.addUpdateRange(0, count);
    index.needsUpdate = true;
  }

  private rebuildCoarseMeshes(st: ColumnState): void {
    if (!st.parts || !st.partVisible) return;
    if (st.meshes[0]) this.setVisibleParts(st.meshes[0], st.parts.offsets, st.partVisible);
    if (st.portalMeshes[0] && st.portalParts) {
      this.setVisibleParts(st.portalMeshes[0], st.portalParts.offsets, st.partVisible);
    }
  }
  private swapMeshes(
    st: ColumnState, fresh: THREE.Mesh[], freshPortals: THREE.Mesh[],
  ): void {
    for (const mesh of fresh) this.group.add(mesh);
    for (const mesh of freshPortals) this.portalGroup.add(mesh);
    this.disposeMeshes(st);
    st.meshes = fresh;
    st.portalMeshes = freshPortals;
  }

  private disposeMeshes(st: ColumnState): void {
    for (const m of st.meshes) {
      this.group.remove(m);
      m.geometry.dispose();
    }
    st.meshes = [];
    for (const m of st.portalMeshes) {
      this.portalGroup.remove(m);
      m.geometry.dispose();
    }
    st.portalMeshes = [];
  }

  private createWorker(slot: WorkerSlot): Worker {
    const worker = new Worker('/mesher.worker.js');
    // Assign before initialization so even a synchronous initialization
    // failure is recognized as belonging to this slot generation.
    slot.worker = worker;
    worker.onmessage = (ev: MessageEvent<MeshedMsg>) => {
      if (this.disposed || slot.worker !== worker || slot.job?.requestId !== ev.data.reqId ||
          this.pendingMeshes.some((p) => p.slot === slot)) return;
      this.clearWatchdog(slot);
      // Hold this slot until its transferred buffers can be installed within
      // the next frame's budget; responses cannot build an unbounded inbox.
      this.pendingMeshes.push({ slot, worker, msg: ev.data });
    };
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      this.onWorkerError(slot, worker);
    };
    worker.onmessageerror = () => this.onWorkerError(slot, worker);
    worker.postMessage({ type: 'init', seed: this.seed });
    return worker;
  }

  private armWatchdog(slot: WorkerSlot, requestId: number): void {
    this.clearWatchdog(slot);
    slot.watchdog = setTimeout(() => {
      if (slot.job?.requestId === requestId) this.onWorkerError(slot, slot.worker);
    }, this.workerTimeoutMs);
    // Node's test runner should not stay alive solely for browser watchdogs.
    (slot.watchdog as unknown as { unref?: () => void }).unref?.();
  }

  private clearWatchdog(slot: WorkerSlot): void {
    if (slot.watchdog === null) return;
    clearTimeout(slot.watchdog);
    slot.watchdog = null;
  }

  private onWorkerError(slot: WorkerSlot, failed: Worker): void {
    if (this.disposed || slot.worker !== failed) return;
    this.clearWatchdog(slot);
    for (let i = this.pendingMeshes.length - 1; i >= 0; i--) {
      if (this.pendingMeshes[i].slot === slot) this.pendingMeshes.splice(i, 1);
    }
    const job = slot.job;
    slot.job = null;
    if (job) {
      const st = this.columns.get(job.key);
      if (st && st.status === 'meshing' && st.requestId === job.requestId) {
        st.requestId = null;
        if (st.retiring && st.installed) {
          st.status = 'ready';
        } else {
          st.status = 'queued';
          this.queue.push(st);
        }
      }
    }
    failed.onmessage = null;
    failed.onerror = null;
    failed.onmessageerror = null;
    failed.terminate();
    slot.worker = this.createWorker(slot);
    this.compactQueue();
    this.pruneRetiring();
    this.refreshStats();
    this.pump(this.lastPx, this.lastPz);
  }

  /** Release workers and all CPU/GPU terrain resources. Safe to call twice. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.emergencyPreview = null;
    for (const slot of this.workers) {
      this.clearWatchdog(slot);
      slot.worker.onmessage = null;
      slot.worker.onerror = null;
      slot.worker.onmessageerror = null;
      slot.worker.terminate();
      slot.job = null;
    }
    for (const st of this.columns.values()) {
      this.disposeMeshes(st);
      st.parts = null;
      st.portalParts = null;
      st.partVisible = null;
    }
    this.columns.clear();
    this.pendingMeshes.length = 0;
    this.queue = [];
    this.desired.clear();
    this.material.dispose();
    this.roads.dispose();
    this.portalMaterial.dispose();
    this.group.remove(this.portalGroup);
    this.refreshStats();
  }

  private refreshStats(): void {
    let ready = 0, pending = 0, tris = 0;
    for (const st of this.columns.values()) {
      if (st.status === 'ready') ready++;
      else pending++;
      for (const m of st.meshes) {
        tris += (m.geometry.index ? m.geometry.drawRange.count : m.geometry.getAttribute('position').count) / 3;
      }
    }
    this.stats.columnsReady = ready;
    this.stats.columnsPending = pending;
    this.stats.triangles = Math.round(tris);
  }
}
