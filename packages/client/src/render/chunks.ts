import { validateAuthoredSeams, spliceAuthoredBoundary, type AuthoredSeamPayload } from './terrain-authored-seams.js';
import * as THREE from 'three';
import {
  World, CHUNK_SIZE, VIEW_CHUNK_RADIUS, CAVE_DETAIL_RADIUS,
  CAVE_MESH_RADIUS,
  LOD1_STEP, LOD1_RADIUS, LOD2_STEP, WORLD,
} from '@shared/index';
import type { ChunkMesh, EntrancePortalMesh } from './surfacenets.js';
import type { TransportSnapshot } from '@shared/transport';
import { ENTRANCE_PORTAL_LIFT } from './surfacenets.js';
import {
  meshBoundary, stitchBoundary, combineSeamMeshes,
  type BoundaryMesh, type BoundaryPlane, type BoundarySegment, type SeamMesh,
} from './terrain-seams.js';
import { createTerrainMaterial } from './surface-material.js';
import { RoadField } from './road-field.js';
import { renderProfile, workerJobRestMs, isLocalWorldHost } from './device-profile.js';
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
  /** This preview generation could not join existing canonical geometry. */
  canonicalRequest: { previewReqId: number; caveDetail: boolean } | null;
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
  seamSource: readonly BoundaryMesh[];
  seamPortalSource: EntrancePortalMesh | null;
  authoredSeams?: AuthoredSeamPayload;
  seamVersion: number;
  seamBoundaries: Map<string, BoundarySegment[]>;
  seamRetained: boolean;
}

interface SeamEdge {
  a: ColumnState; b: ColumnState;
  aVersion: number; bVersion: number;
  owner: ColumnState;
  terrain: SeamMesh;
  portal: SeamMesh;
}
interface SeamGroup {
  parts: Map<string, SeamEdge>;
  terrain?: THREE.Mesh;
  portal?: THREE.Mesh;
}
interface PreparedGeometry { meshes: THREE.Mesh[]; portals: THREE.Mesh[] }
interface DeferredSeam {
  state: ColumnState;
  candidate: ColumnState;
  msg: MeshedMsg;
  keys: Set<string>;
  dirty: boolean;
}
interface SeamTransaction {
  members: DeferredSeam[];
  replacements: Map<string, ColumnState>;
  keys: string[];
  edgeIndex: number;
  edges: Map<string, SeamEdge | null>;
  geometry: PreparedGeometry[];
  groups?: Map<ColumnState, SeamGroup>;
  groupBases?: Map<ColumnState, SeamGroup | undefined>;
  groupEntries?: [ColumnState, SeamGroup][];
  groupIndex: number;
}

interface WorkerSlot {
  worker: Worker;
  job: WorkerJob | null;
  watchdog: ReturnType<typeof setTimeout> | null;
  readyAt: number;
  coverageReadyAt: number;
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
  authoredSeams?: AuthoredSeamPayload;
  preview?: boolean;
  workMs?: number;
  paced?: boolean;
  elapsedMs?: number;
  maxSliceMs?: number;
  slices?: number;
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
const GROUND_LOOKAHEAD_SECONDS = 4;
const GROUND_LOOKAHEAD_MAX_M = 384;
const GROUND_CORRIDOR_HALF_WIDTH = 8;
const GROUND_FORECAST_STEP_SECONDS = .5;

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
  private readonly scenerySupport = new Map<string, { x: number; z: number; hx: number; hz: number; distance: number; nextCell: string | null }>();
  private scenerySupportGeneration = 0;
  // Every actual publication, including empty/invalid replacement, revokes
  // older evidence. Stale-cell clearing alone is not a fresh publication.
  private scenerySupportPublication = 0;
  private readonly currentSupportJobs = new WeakMap<NonNullable<WorkerSlot['job']>, {
    state: ColumnState; requestId: number; caveDetail: boolean; publication: number;
    cellX: number; cellZ: number; x: number; z: number; hx: number; hz: number;
  }>();
  private scenerySupportCellX = Infinity;
  private scenerySupportCellZ = Infinity;
  private readonly pendingMeshes: { slot: WorkerSlot; worker: Worker; msg: MeshedMsg }[] = [];
  private seamSerial = 0;
  private readonly seamDirty = new Set<string>();
  private readonly seamMaskDirty = new Set<string>();
  private readonly seamEdges = new Map<string, SeamEdge>();
  private readonly seamGroups = new Map<ColumnState, SeamGroup>();
  /** At most one rejected replacement per selected tile; bounded below.
   * Keep its old published geometry until its neighboring contours change. */
  private readonly seamDeferred = new Map<string, DeferredSeam>();
  private seamCandidateMessages = new WeakMap<ColumnState, {
    msg: MeshedMsg; preview: boolean; canonicalRequired?: boolean;
    dependencies: Map<string, { state: ColumnState; version: number }>;
  }>();
  private seamTransaction: SeamTransaction | null = null;
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
  private groundTravel = false;
  private groundTurnRate = 0;
  private groundMotionAt = NaN;
  private groundMotionX = 0;
  private groundMotionZ = 0;
  private groundMotionVx = 0;
  private groundMotionVz = 0;
  private readonly groundPath: { x: number; z: number; seconds: number }[] = [];
  private groundGuardX = 0;
  private groundGuardZ = 0;
  private groundForecastSeconds = GROUND_LOOKAHEAD_SECONDS;
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
  private installedCoverageRevision = 0;
  private neighborhoodCache: { cx: number; cz: number; cave: boolean; revision: number;
    value: { covered: boolean; ready: number; total: number; missing: readonly string[] } } | null = null;
  private readonly workerTimeoutMs: number;
  private readonly profile = renderProfile();
  private readonly cooperative = isLocalWorldHost();
  stats = { columnsReady: 0, columnsPending: 0, triangles: 0 };

  constructor(seed: number, workerCount = 0, workerTimeoutMs = 45_000,
    private readonly transportSnapshot?: TransportSnapshot) {
    this.seed = seed;
    this.workerTimeoutMs = workerTimeoutMs;
    // World adopts and defensively clones the plan lazily on its first query,
    // including emergency coverage on the main thread.
    this.terrainWorld = new World(seed, transportSnapshot);
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
        readyAt: 0,
        coverageReadyAt: 0,
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

  /** Startup can release other generators as soon as the camera has usable
   * land or cave walls. A preview remains queued for exact refinement, so
   * columnsReady alone does not describe whether the player is covered. */
  get currentCoverageReady(): boolean {
    return this.coveredAt(this.lastPx, this.lastPz, this.lastUnderground);
  }

  get sceneryCoverageRevision(): number { return this.installedCoverageRevision; }

  /** Installed coverage around the camera, not only the point beneath it.
   * Nine middle tiles cover the whole 64m scenery cell plus its protected
   * 128m neighborhood. A larger prop still needs its full footprint checked.
   * Cache this QA query until coverage, camera tile or cave admission changes;
   * even a cold query needs at most nine middle and 144 fine lookups. */
  get groundNeighborhood() {
    const cx = Math.floor(this.lastPx / LOD1_TILE_M), cz = Math.floor(this.lastPz / LOD1_TILE_M);
    const cave = this.lastUnderground, revision = this.installedCoverageRevision;
    const cached = this.neighborhoodCache;
    if (cached && cached.cx === cx && cached.cz === cz && cached.cave === cave && cached.revision === revision)
      return cached.value;
    const missing: string[] = [];
    const complete = (tile: ColumnState | undefined) => !!tile?.installed && !tile.previewInstalled &&
      (!cave || tile.installedCaveDetail === true);
    for (let z = cz - 1; z <= cz + 1; z++) for (let x = cx - 1; x <= cx + 1; x++) {
      if (complete(this.columns.get(`1:${x},${z}`))) continue;
      let fine = true;
      for (let dz = 0; dz < LOD1_STEP && fine; dz++) for (let dx = 0; dx < LOD1_STEP; dx++) {
        if (!complete(this.columns.get(`0:${x * LOD1_STEP + dx},${z * LOD1_STEP + dz}`))) { fine = false; break; }
      }
      if (!fine) missing.push(`1:${x},${z}`);
    }
    const value = { covered: missing.length === 0, ready: 9 - missing.length, total: 9, missing };
    this.neighborhoodCache = { cx, cz, cave, revision, value };
    return value;
  }

  /** A whole prop footprint needs installed canonical near/middle geometry.
   * Checking each intersected fine cell permits mixed LOD0/1 coverage without
   * accepting a preview, a queued mesh, or merely supported corner points. */
  sceneryGroundReady(x: number, z: number, hx: number, hz: number): boolean {
    if (this.disposed || !Number.isFinite(x) || !Number.isFinite(z) ||
      !Number.isFinite(hx) || !Number.isFinite(hz) || hx < 0 || hz < 0) return false;
    for (let cz = Math.floor((z - hz) / CHUNK_SIZE); cz <= Math.floor((z + hz) / CHUNK_SIZE); cz++) {
      for (let cx = Math.floor((x - hx) / CHUNK_SIZE); cx <= Math.floor((x + hx) / CHUNK_SIZE); cx++) {
        const fine = this.columns.get(`0:${cx},${cz}`);
        if (fine?.installed && !fine.previewInstalled) continue;
        const middle = this.columns.get(`1:${Math.floor(cx / LOD1_STEP)},${Math.floor(cz / LOD1_STEP)}`);
        if (!middle?.installed || middle.previewInstalled) return false;
      }
    }
    return true;
  }

  get scenerySupportRevision(): number { return this.scenerySupportGeneration; }

  /** At most two future cell crossings, within 128 m along supplied velocity.
   * No camera history, free-look yaw or extra world/scenery samples. */
  scenerySupportFutureCells(): readonly { cellX: number; cellZ: number }[] {
    const age = performance.now() - this.groundMotionAt;
    if (this.disposed || this.flight || this.lastUnderground || !this.groundTravel ||
        !Number.isFinite(age) || age < 0 || age > 250) return [];
    const vx = this.groundMotionVx, vz = this.groundMotionVz;
    const speed = Math.hypot(vx, vz);
    if (!Number.isFinite(vx + vz + speed) || speed <= 12) return [];
    let cellX = Math.floor(this.lastPx / 64), cellZ = Math.floor(this.lastPz / 64);
    const cells: { cellX: number; cellZ: number }[] = [];
    for (let i = 0; i < 2; i++) {
      const tx = vx === 0 ? Infinity : Math.max(0, ((cellX + (vx > 0 ? 1 : 0)) * 64 - this.lastPx) / vx);
      const tz = vz === 0 ? Infinity : Math.max(0, ((cellZ + (vz > 0 ? 1 : 0)) * 64 - this.lastPz) / vz);
      const time = Math.min(tx, tz);
      if (!Number.isFinite(time) || time > 128 / speed) break;
      if (tx <= time + 1e-9) cellX += Math.sign(vx);
      if (tz <= time + 1e-9) cellZ += Math.sign(vz);
      cells.push({ cellX, cellZ });
    }
    return cells;
  }

  /** Scheduled cached placements request at most nine already-selected middle
   * tiles. Current protected support reserves capacity before future support. */
  setSceneryGroundSupport(cellX: number, cellZ: number,
    footprints: readonly { x: number; z: number; hx: number; hz: number }[],
    futureFootprints: readonly { x: number; z: number; hx: number; hz: number }[] = []): void {
    this.scenerySupportPublication++;
    this.scenerySupport.clear();
    this.scenerySupportCellX = cellX; this.scenerySupportCellZ = cellZ;
    if (this.disposed || cellX !== Math.floor(this.lastPx / 64) || cellZ !== Math.floor(this.lastPz / 64)) return;
    const next = this.scenerySupportFutureCells();
    const collect = (items: typeof footprints, middleX: number, middleZ: number, nextCell: string | null,
      futureCell?: { cellX: number; cellZ: number }) => {
      const wanted = new Map<string, { x: number; z: number; hx: number; hz: number; distance: number; nextCell: string | null }>();
      for (const p of items) {
        if (![p.x, p.z, p.hx, p.hz].every(Number.isFinite) || p.hx < 0 || p.hz < 0) continue;
        if (futureCell) {
          const dx = Math.max(futureCell.cellX * 64 - p.x - p.hx, p.x - p.hx - (futureCell.cellX + 1) * 64, 0);
          const dz = Math.max(futureCell.cellZ * 64 - p.z - p.hz, p.z - p.hz - (futureCell.cellZ + 1) * 64, 0);
          if (dx * dx + dz * dz > 128 ** 2) continue;
        }
        const minX = Math.max(middleX - 1, Math.floor((p.x - p.hx) / LOD1_TILE_M));
        const maxX = Math.min(middleX + 1, Math.floor((p.x + p.hx) / LOD1_TILE_M));
        const minZ = Math.max(middleZ - 1, Math.floor((p.z - p.hz) / LOD1_TILE_M));
        const maxZ = Math.min(middleZ + 1, Math.floor((p.z + p.hz) / LOD1_TILE_M));
        for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
          const key = `1:${x},${z}`, st = this.columns.get(key);
          if (!st || !this.desired.has(key) || st.retiring || st.installed && !st.previewInstalled) continue;
          const loX = Math.max(p.x - p.hx, x * LOD1_TILE_M), hiX = Math.min(p.x + p.hx, (x + 1) * LOD1_TILE_M);
          const loZ = Math.max(p.z - p.hz, z * LOD1_TILE_M), hiZ = Math.min(p.z + p.hz, (z + 1) * LOD1_TILE_M);
          if (this.sceneryGroundReady((loX + hiX) * .5, (loZ + hiZ) * .5, (hiX - loX) * .5, (hiZ - loZ) * .5)) continue;
          const distance = Math.hypot(Math.max(Math.abs(this.lastPx - p.x) - p.hx, 0),
            Math.max(Math.abs(this.lastPz - p.z) - p.hz, 0));
          const old = wanted.get(key);
          if (!old || distance < old.distance) wanted.set(key, { ...p, distance, nextCell });
        }
      }
      return wanted;
    };
    const current = collect(footprints, Math.floor(this.lastPx / LOD1_TILE_M), Math.floor(this.lastPz / LOD1_TILE_M), null);
    for (const [key, request] of current) this.scenerySupport.set(key, request);
    if (next.length && this.scenerySupport.size < 9) {
      const future = new Map<string, { x: number; z: number; hx: number; hz: number; distance: number; nextCell: string | null }>();
      for (const cell of next) for (const [key, request] of collect(futureFootprints,
        Math.floor(cell.cellX / 2), Math.floor(cell.cellZ / 2), `${cell.cellX},${cell.cellZ}`, cell)) {
        const old = future.get(key);
        if (!old || request.distance < old.distance) future.set(key, request);
      }
      for (const [key, request] of [...future].sort((a, b) => a[1].distance - b[1].distance)) {
        if (this.scenerySupport.size >= 9) break;
        if (!this.scenerySupport.has(key)) this.scenerySupport.set(key, request);
      }
    }
  }

  private scenerySupportKeys(px: number, pz: number): Map<string, { distance: number; future: boolean }> {
    const result = new Map<string, { distance: number; future: boolean }>();
    if (this.scenerySupportCellX !== Math.floor(px / 64) ||
        this.scenerySupportCellZ !== Math.floor(pz / 64)) {
      if (this.scenerySupport.size) this.scenerySupportGeneration++;
      this.scenerySupport.clear(); return result;
    }
    const next = new Map(this.scenerySupportFutureCells().map(cell => [`${cell.cellX},${cell.cellZ}`, cell]));
    let pruned = false;
    for (const [key, request] of this.scenerySupport)
      if (request.nextCell !== null && !next.has(request.nextCell)) {
        this.scenerySupport.delete(key); pruned = true;
      }
    // A worker completion can prune between scheduled rock refreshes. Publish
    // a separate revision so same-direction resumption cannot lose demand.
    if (pruned) this.scenerySupportGeneration++;
    if (this.flight || this.lastUnderground) return result;
    for (const [key, p] of this.scenerySupport) {
      const mx = p.nextCell === null ? Math.floor(px / LOD1_TILE_M) : Math.floor(next.get(p.nextCell)!.cellX / 2);
      const mz = p.nextCell === null ? Math.floor(pz / LOD1_TILE_M) : Math.floor(next.get(p.nextCell)!.cellZ / 2);
      const st = this.columns.get(key);
      if (!st || !this.desired.has(key) || st.retiring || st.installed && !st.previewInstalled ||
          Math.abs(st.cx - mx) > 1 || Math.abs(st.cz - mz) > 1) { this.scenerySupport.delete(key); continue; }
      const loX = Math.max(p.x - p.hx, st.cx * LOD1_TILE_M), hiX = Math.min(p.x + p.hx, (st.cx + 1) * LOD1_TILE_M);
      const loZ = Math.max(p.z - p.hz, st.cz * LOD1_TILE_M), hiZ = Math.min(p.z + p.hz, (st.cz + 1) * LOD1_TILE_M);
      if (this.sceneryGroundReady((loX + hiX) * .5, (loZ + hiZ) * .5, (hiX - loX) * .5, (hiZ - loZ) * .5)) {
        this.scenerySupport.delete(key); continue;
      }
      result.set(key, { distance: Math.hypot(Math.max(Math.abs(px - p.x) - p.hx, 0),
        Math.max(Math.abs(pz - p.z) - p.hz, 0)), future: p.nextCell !== null });
    }
    return result;
  }

  private yieldScenerySupport(support: ReadonlyMap<string, { distance: number; future: boolean }>, urgent: ReadonlySet<string>): void {
    if (!this.cooperative || this.flight || this.lastUnderground ||
        !this.queue.some(st => st.status === 'queued' && support.has(st.key))) return;
    const current = `0:${Math.floor(this.lastPx / CHUNK_SIZE)},${Math.floor(this.lastPz / CHUNK_SIZE)}`;
    let changed = false;
    for (const slot of this.workers) {
      const job = slot.job;
      // No support-to-support switching: current/route/coarse and completed
      // uploads keep their existing lifetime and ordinary shared rest debt.
      if (!job || job.step !== 1 || job.key === current || urgent.has(job.key) ||
          this.pendingMeshes.some(p => p.slot === slot)) continue;
      const st = this.columns.get(job.key);
      if (!st || st.requestId !== job.requestId || st.retiring) continue;
      st.requestId = null; st.status = 'queued'; this.queue.push(st); changed = true;
    }
    if (changed) this.cancelObsoleteJobs();
  }
  private coveredAt(x: number, z: number, cave = false, canonicalGround = false): boolean {
    const fine = this.columns.get(`0:${Math.floor(x / CHUNK_SIZE)},${Math.floor(z / CHUNK_SIZE)}`);
    if (fine?.installed && (!cave || fine.installedCaveDetail === true)) return true;
    const middle = this.columns.get(`1:${Math.floor(x / LOD1_TILE_M)},${Math.floor(z / LOD1_TILE_M)}`);
    if (middle?.installed && (!cave || middle.installedCaveDetail === true)) return true;
    return !cave && !canonicalGround && this.columns.get(`2:${Math.floor(x / LOD2_TILE_M)},${Math.floor(z / LOD2_TILE_M)}`)?.installed === true;
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
    const now = performance.now();
    return { queued: this.queue.length, inFlight: this.workers.filter((s) => s.job !== null).length,
      restingWorkers: this.workers.filter((s) => s.job === null && s.readyAt > now).length,
      waitingUploads: this.pendingMeshes.length, installed, selectionMs: this.selectionMs, installMs: this.installMs,
      currentCovered: this.coveredAt(this.lastPx, this.lastPz),
      aheadCovered: this.coveredAt(this.lastPx + this.lookX, this.lastPz + this.lookZ),
      currentGroundCovered: this.coveredAt(this.lastPx, this.lastPz, this.lastUnderground, true),
      aheadGroundCovered: this.coveredAt(this.lastPx + this.lookX, this.lastPz + this.lookZ, this.lastUnderground, true),
      groundNeighborhood: this.flight ? null : this.groundNeighborhood,
      groundLookahead: this.groundTravel ? Math.hypot(this.lookX, this.lookZ) : 0,
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
    this.groundTravel = !this.flight && speed > 12;
    const lookSeconds = this.flight && speed > 1 ? Math.min(4, 768 / speed)
      : this.groundTravel ? Math.min(GROUND_LOOKAHEAD_SECONDS, GROUND_LOOKAHEAD_MAX_M / speed) : 0;
    this.lookX = lookSeconds > 0 ? motion!.vx * lookSeconds : 0;
    this.lookZ = lookSeconds > 0 ? motion!.vz * lookSeconds : 0;
    if (this.groundTravel) this.updateGroundForecast(px, pz, motion!.vx, motion!.vz, speed, lookSeconds);
    else { this.groundMotionAt = NaN; this.groundTurnRate = 0; this.groundPath.length = 0; }
    // Ground lookahead fits inside the existing middle ring. Keep the full
    // near ring centered on the driver; only its work order changes.
    const midCx = Math.floor((px + (this.flight ? this.lookX * 0.4 : 0)) / LOD1_TILE_M);
    const midCz = Math.floor((pz + (this.flight ? this.lookZ * 0.4 : 0)) / LOD1_TILE_M);
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
      this.markSeamEdges(st);
      if (st.lod === 0) changedParents.add(`1:${Math.floor(st.cx / 4)},${Math.floor(st.cz / 4)}`);
      changedParents.add(`2:${Math.floor(st.cx / (st.lod === 0 ? 16 : 4))},${Math.floor(st.cz / (st.lod === 0 ? 16 : 4))}`);
    }
    this.pruneUndesired();
    this.cancelObsoleteJobs();
    for (const key of changedParents) this.syncOneCoarse(this.columns.get(key));
    this.syncTerrainSeams();
    this.refreshStats();
  }

  private ensureColumn(lod: Lod, cx: number, cz: number, caveDetail: boolean): void {
    const key = `${lod}:${cx},${cz}`;
    const existing = this.columns.get(key);
    if (existing) {
      existing.retiring = false;
      existing.seamRetained = false;
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
      previewInstalled: false, canonicalRequest: null,
      priority: 0,
      parts: null, portalParts: null, partGrid: 0, partVisible: null,
      seamSource: [], seamPortalSource: null, seamVersion: 0, seamBoundaries: new Map(), seamRetained: false,
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
      if (this.desiredInstalled(`1:${t1x},${t1z}`)) return this.canRetireSeams(st);
      const t2x = Math.floor(st.cx / LOD2_STEP);
      const t2z = Math.floor(st.cz / LOD2_STEP);
      return this.desiredInstalled(`2:${t2x},${t2z}`) && this.canRetireSeams(st);
    }
    const t2x = Math.floor(st.cx / DIRECT_PARTS);
    const t2z = Math.floor(st.cz / DIRECT_PARTS);
    return this.desiredInstalled(`2:${t2x},${t2z}`) && this.canRetireSeams(st);
  }

  private canRetireSeams(st: ColumnState): boolean {
    const removed = { ...st, installed: false };
    const replacement = new Map([[st.key, removed]]);
    for (const key of this.seamKeys(st)) {
      if (this.prepareSeam(key, replacement) === false) {
        if (!st.seamRetained) this.markSeamParents(st);
        st.seamRetained = true;
        return false;
      }
    }
    if (st.seamRetained) this.markSeamParents(st);
    st.seamRetained = false;
    return true;
  }

  /**
   * Rebuild only coarse draw geometry whose exact finer-coverage mask changed.
   * Coverage is selection-local: a stale ready state awaiting pruning can
   * never hide a fallback needed by the new camera selection.
   */
  private syncCoarseVisibility(changed?: ColumnState): void {
    if (!changed) {
      for (const st of this.columns.values()) this.syncOneCoarse(st);
      for (const st of this.columns.values()) if (st.installed && st.lod < 2) this.markSeamEdges(st);
      this.syncTerrainSeams();
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
    this.syncTerrainSeams();
  }

  private syncOneCoarse(st: ColumnState | undefined): void {
    if (st) this.seamMaskDirty.delete(st.key);
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
    const st = this.columns.get(key);
    return !!st && st.installed && (this.desired.has(key) || st.seamRetained);
  }

  private removeState(st: ColumnState): void {
    if (this.columns.get(st.key) !== st) return;
    // Queued or in-flight states without a retained result never owned any
    // boundary. Evicting them cannot change a prepared seam transaction.
    // Retained unpublished candidates still participate in prospective
    // ownership, so their removal must wake and revalidate their neighbors.
    if (st.installed || this.seamDeferred.has(st.key)) {
      this.markSeamEdges(st);
      this.markSeamParents(st);
    }
    this.seamDeferred.delete(st.key);
    if (st.installed && st.lod < 2 && !st.previewInstalled) this.installedCoverageRevision++;
    this.columns.delete(st.key);
    this.disposeMeshes(st);
    st.installed = false;
    st.installedCaveDetail = null;
    st.retiring = false;
    st.parts = null;
    st.portalParts = null;
    st.partVisible = null;
    st.partGrid = 0;
    st.seamSource = []; st.seamPortalSource = null; st.seamBoundaries?.clear(); st.seamRetained = false;
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
      const old = slot.worker, requestId = slot.job.requestId;
      slot.job = null;
      for (let i = this.pendingMeshes.length - 1; i >= 0; i--) {
        if (this.pendingMeshes[i].slot === slot) this.pendingMeshes.splice(i, 1);
      }
      if (this.cooperative) {
        // Preserve the warm generator caches and its worker-owned rest. A
        // matching request id fences cancellation against later assignments.
        try { old.postMessage({ type: 'cancel', reqId: requestId }); continue; }
        catch { this.onWorkerError(slot, old); continue; }
      }
      old.onmessage = null; old.onerror = null; old.onmessageerror = null;
      old.terminate(); slot.readyAt = 0; slot.coverageReadyAt = 0;
      slot.worker = this.createWorker(slot);
    }
  }

  private flushMeshes(): void {
    const start = performance.now();
    // A staged horizon transaction must not occupy every frame while a
    // completed current/cave/route tile waits in the worker's upload slot.
    // Only currently urgent, matching results bypass it; distant completions
    // retain deferred-first fairness. Never grant both full preparation slices.
    let coverageUpload = -1;
    if (this.pendingMeshes.length && (this.seamDeferred.size || this.seamTransaction)) {
      const ground = this.groundTravel ? this.groundCoverageKeys(this.lastPx, this.lastPz) : undefined;
      const urgent = this.urgentCoverageKeys(this.lastPx, this.lastPz, ground);
      coverageUpload = this.pendingMeshes.findIndex(pending => {
        const job = pending.slot.job, msg = pending.msg;
        if (pending.worker !== pending.slot.worker || !job || job.requestId !== msg.reqId ||
            job.cx !== msg.cx || job.cz !== msg.cz || job.step !== msg.step ||
            job.caveDetail !== msg.caveDetail || !!job.preview !== !!msg.preview) return false;
        const st = this.columns.get(job.key);
        return !!st && st.requestId === msg.reqId && st.caveDetail === msg.caveDetail &&
          this.desired.has(job.key) && urgent.has(job.key);
      });
    }
    let installed: number;
    if (coverageUpload >= 0) {
      const pending = this.pendingMeshes.splice(coverageUpload, 1)[0];
      this.onMeshed(pending.slot, pending.msg);
      installed = 1;
    } else installed = this.retryDeferredSeam() ? 1 : 0;
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
        if (this.installGeometry(st, bundle.chunks, bundle.portals)) {
          st.installed = true; st.installedCaveDetail = false; st.previewInstalled = true;
          // Preserve any running worker request. Its delayed preview will only
          // release that slot for refinement, never overwrite this geometry.
          this.pruneRetiring(); this.syncCoarseVisibility(st); this.refreshStats();
        }
      }
      this.emergencyPreview = null;
    }
    this.emergencyMs = performance.now() - started;
  }

  /** Predict changing velocity direction, never the vehicle's free-look yaw.
   * Short smoothing handles render/simulation tick quantization. Teleports,
   * reversals, collisions with an abrupt velocity change, and stale samples
   * drop the estimate instead of projecting an unrelated old turn. */
  private updateGroundForecast(px: number, pz: number, vx: number, vz: number, speed: number, seconds: number): void {
    const now = performance.now(), dt = (now - this.groundMotionAt) / 1000;
    const previousSpeed = Math.hypot(this.groundMotionVx, this.groundMotionVz);
    const dot = vx * this.groundMotionVx + vz * this.groundMotionVz;
    const rate = Math.atan2(this.groundMotionVx * vz - this.groundMotionVz * vx, dot) / dt;
    const continuous = dt > 0 && dt <= .25 && dot > 0 && Number.isFinite(rate) && Math.abs(rate) <= 1 &&
      Math.abs(speed - previousSpeed) <= Math.max(12, previousSpeed * .25) &&
      Math.hypot(px - this.groundMotionX, pz - this.groundMotionZ) <= Math.max(8, (speed + previousSpeed) * dt);
    this.groundTurnRate = continuous
      ? this.groundTurnRate + (rate - this.groundTurnRate) * (1 - Math.exp(-dt / .12)) : 0;
    this.groundMotionAt = now; this.groundMotionX = px; this.groundMotionZ = pz;
    this.groundMotionVx = vx; this.groundMotionVz = vz;
    this.groundForecastSeconds = seconds;
    this.groundGuardX = vx * Math.min(1, seconds); this.groundGuardZ = vz * Math.min(1, seconds);
    const turn = this.groundTurnRate;
    if (Math.abs(turn) < .01) { this.groundPath.length = 0; return; }
    const count = Math.ceil(seconds / GROUND_FORECAST_STEP_SECONDS);
    for (let i = 0; i <= count; i++) {
      const t = Math.min(seconds, i * GROUND_FORECAST_STEP_SECONDS), a = turn * t;
      const point = this.groundPath[i] ?? (this.groundPath[i] = { x: 0, z: 0, seconds: 0 });
      point.x = (vx * Math.sin(a) + vz * (Math.cos(a) - 1)) / turn;
      point.z = (vx * (1 - Math.cos(a)) + vz * Math.sin(a)) / turn;
      point.seconds = t;
    }
    this.groundPath.length = count + 1;
    this.lookX = this.groundPath[count].x; this.lookZ = this.groundPath[count].z;
  }

  /** A fast ground vehicle needs canonical terrain, not a heightfield that
   * happens to cover its XZ. Only the narrow swept route receives urgency;
   * its existing LOD1 tiles retain the ordinary field and cave generator. */
  private groundCoverageKeys(px: number, pz: number): Map<string, number> {
    const keys = new Map<string, number>(), pad = GROUND_CORRIDOR_HALF_WIDTH;
    const wanted = new Map<string, number>();
    const admit = (sx: number, sz: number, dx: number, dz: number, from: number, to: number, guard = false) => {
      const endX = sx + dx, endZ = sz + dz;
      for (let z = Math.floor((Math.min(sz, endZ) - pad) / LOD1_TILE_M); z <= Math.floor((Math.max(sz, endZ) + pad) / LOD1_TILE_M); z++) {
        for (let x = Math.floor((Math.min(sx, endX) - pad) / LOD1_TILE_M); x <= Math.floor((Math.max(sx, endX) + pad) / LOD1_TILE_M); x++) {
          let enter = 0, leave = 1;
          for (const [start, delta, lo] of [[sx, dx, x * LOD1_TILE_M], [sz, dz, z * LOD1_TILE_M]]) {
            if (Math.abs(delta) < .001) {
              if (start < lo - pad || start > lo + LOD1_TILE_M + pad) { leave = -1; break; }
            } else {
              const a = (lo - pad - start) / delta, b = (lo + LOD1_TILE_M + pad - start) / delta;
              enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
            }
          }
          if (enter > leave) continue;
          const seconds = from + (to - from) * enter;
          // The one-second straight guard covers steering release; it must
          // not enqueue a second full four-second route ahead of the curve.
          const priority = (seconds + (guard && seconds > .1 ? .25 : 0)) / this.groundForecastSeconds;
          const key = `1:${x},${z}`;
          wanted.set(key, Math.min(priority, wanted.get(key) ?? Infinity));
        }
      }
    };
    if (this.groundPath.length > 1) {
      for (let i = 1; i < this.groundPath.length; i++) {
        const a = this.groundPath[i - 1], b = this.groundPath[i];
        admit(px + a.x, pz + a.z, b.x - a.x, b.z - a.z, a.seconds, b.seconds);
      }
      admit(px, pz, this.groundGuardX, this.groundGuardZ, 0, Math.min(1, this.groundForecastSeconds), true);
    } else admit(px, pz, this.lookX, this.lookZ, 0, this.groundForecastSeconds);
    for (const [key, priority] of wanted) {
      const st = this.columns.get(key);
      if (!st || !this.desired.has(key)) continue;
      const x = st.cx, z = st.cz;
      // A driver can enter a cave approach before a second surface-only
      // job could be replaced. The bounded route lies inside the existing
      // 600m cave-detail range: generate its ordinary cave band on the
      // first job, while the camera is still above ground.
      const complete = (tile: ColumnState | undefined) => !!tile?.installed &&
        !tile.previewInstalled && tile.installedCaveDetail === true;
      if (complete(st)) continue;
      // Already installed fine columns also provide canonical coverage.
      let fine = true;
      for (let dz = 0; dz < LOD1_STEP && fine; dz++) for (let dx = 0; dx < LOD1_STEP; dx++) {
        if (!complete(this.columns.get(`0:${x * LOD1_STEP + dx},${z * LOD1_STEP + dz}`))) { fine = false; break; }
      }
      if (!fine) {
        this.ensureColumn(1, x, z, true);
        keys.set(key, priority);
      }
    }
    return keys;
  }

  /** Cooperative cancellation retains generator caches and worker-owned rest.
   * A background cave/horizon job must not occupy the only local worker while
   * the player enters missing canonical ground. Completed uploads stay. */
  private currentRockSupport(st: ColumnState,
    support?: ReadonlyMap<string, { distance: number; future: boolean }>): boolean {
    // This map was validated once for the actual pump coordinates. Recheck
    // identity/lifecycle cheaply; future requests keep their existing policy.
    return this.groundTravel && !this.flight && !this.lastUnderground && st.lod === 1 &&
      !st.retiring && (!st.installed || st.previewInstalled) && this.desired.has(st.key) &&
      this.columns.get(st.key) === st && support?.get(st.key)?.future === false;
  }

  private rememberCurrentSupportJob(st: ColumnState, job: NonNullable<WorkerSlot['job']>,
    support: ReadonlyMap<string, { distance: number; future: boolean }>, px: number, pz: number): void {
    if (!this.currentRockSupport(st, support) || job.preview || job.step !== LOD1_STEP ||
        job.key !== st.key || st.requestId !== job.requestId || job.caveDetail !== st.caveDetail) return;
    const p = this.scenerySupport.get(st.key);
    const cellX = Math.floor(px / 64), cellZ = Math.floor(pz / 64);
    if (!p || p.nextCell !== null || cellX !== this.scenerySupportCellX || cellZ !== this.scenerySupportCellZ) return;
    const old = this.currentSupportJobs.get(job);
    if (old?.publication === this.scenerySupportPublication && old.state === st &&
        old.requestId === job.requestId && old.caveDetail === job.caveDetail) return;
    // Copy the accepted representative, not a merely offered rock or the
    // mutable support-map entry. At most one token per existing live job.
    this.currentSupportJobs.set(job, { state: st, requestId: job.requestId, caveDetail: job.caveDetail,
      publication: this.scenerySupportPublication, cellX, cellZ, x: p.x, z: p.z, hx: p.hx, hz: p.hz });
  }

  private retainedCurrentSupportJob(st: ColumnState, job: NonNullable<WorkerSlot['job']>, px: number, pz: number): boolean {
    const token = this.currentSupportJobs.get(job);
    if (!token || this.disposed || !this.groundTravel || this.flight || this.lastUnderground ||
        !Number.isFinite(px) || !Number.isFinite(pz) || token.publication !== this.scenerySupportPublication ||
        token.state !== st || this.columns.get(st.key) !== st || !this.desired.has(st.key) || st.retiring ||
        st.lod !== 1 || st.status !== 'meshing' || st.installed && !st.previewInstalled ||
        job.preview || job.step !== LOD1_STEP || job.key !== st.key ||
        token.requestId !== job.requestId || st.requestId !== job.requestId ||
        token.caveDetail !== st.caveDetail || job.caveDetail !== st.caveDetail) return false;
    const cellX = Math.floor(px / 64), cellZ = Math.floor(pz / 64);
    if (Math.abs(cellX - token.cellX) > 1 || Math.abs(cellZ - token.cellZ) > 1 ||
        Math.abs(st.cx - Math.floor(px / LOD1_TILE_M)) > 1 ||
        Math.abs(st.cz - Math.floor(pz / LOD1_TILE_M)) > 1) return false;
    const loX = Math.max(token.x - token.hx, st.cx * LOD1_TILE_M);
    const hiX = Math.min(token.x + token.hx, (st.cx + 1) * LOD1_TILE_M);
    const loZ = Math.max(token.z - token.hz, st.cz * LOD1_TILE_M);
    const hiZ = Math.min(token.z + token.hz, (st.cz + 1) * LOD1_TILE_M);
    if (hiX < loX || hiZ < loZ || this.sceneryGroundReady((loX + hiX) * .5, (loZ + hiZ) * .5,
        (hiX - loX) * .5, (hiZ - loZ) * .5)) return false;
    // Same existing RockRenderer protected-footprint rule, using the actual
    // new cell. No time grace, World query or expansion of selected columns.
    const dx = Math.max(cellX * 64 - token.x - token.hx, token.x - token.hx - (cellX + 1) * 64, 0);
    const dz = Math.max(cellZ * 64 - token.z - token.hz, token.z - token.hz - (cellZ + 1) * 64, 0);
    return dx * dx + dz * dz <= 128 ** 2;
  }

  private nearbyCoarseCoverage(st: ColumnState, px: number, pz: number): boolean {
    if (!this.groundTravel || this.flight || this.lastUnderground || st.lod !== 2 || st.installed ||
        st.retiring || !this.desired.has(st.key)) return false;
    const dx = Math.max(st.cx * LOD2_TILE_M - px, px - (st.cx + 1) * LOD2_TILE_M, 0);
    const dz = Math.max(st.cz * LOD2_TILE_M - pz, pz - (st.cz + 1) * LOD2_TILE_M, 0);
    return Math.hypot(dx, dz) <= 256;
  }

  private yieldGroundWorker(urgent: ReadonlySet<string>, ground?: ReadonlyMap<string, number>,
    dependencies?: ReadonlyMap<string, ReadonlySet<ColumnState>>, px = this.lastPx, pz = this.lastPz,
    support?: ReadonlyMap<string, { distance: number; future: boolean }>): void {
    if (!this.cooperative) return;
    const waiting = this.queue.some(st => st.status === 'queued' && urgent.has(st.key));
    let nearest = Infinity;
    if (ground) for (const st of this.queue) if (st.status === 'queued')
      nearest = Math.min(nearest, (ground.get(st.key) ?? Infinity) * this.groundForecastSeconds);
    let changed = false;
    for (const slot of this.workers) {
      const job = slot.job;
      if (!job || this.pendingMeshes.some(p => p.slot === slot)) continue;
      const st = this.columns.get(job.key);
      if (!st || st.requestId !== job.requestId) continue;
      // A valid canonical parent is necessary for the waiting current
      // result to publish. Retain its existing job and ordinary worker rest.
      if (!job.preview && dependencies?.has(job.key) && job.caveDetail === st.caveDetail) continue;
      // Give a selected current rock-support job one coherent lifetime after
      // ordinary dispatch. Near/current/cave demand still preempts; merely
      // adding support never cancels a useful route job to start it.
      if (!job.preview && job.step === LOD1_STEP && job.caveDetail === st.caveDetail &&
          (this.currentRockSupport(st, support) || this.retainedCurrentSupportJob(st, job, px, pz)) &&
          this.coveredAt(px, pz) &&
          nearest > Math.min(1, this.groundForecastSeconds) + .25) continue;
      // Once chosen at the ordinary worker deadline, finish nearby coarse
      // coverage while queued canonical work lies beyond the existing
      // one-second steering guard. Current/near/cave work still preempts.
      if (job.caveDetail === st.caveDetail && this.nearbyCoarseCoverage(st, px, pz) &&
          this.coveredAt(px, pz) && nearest > Math.min(1, this.groundForecastSeconds) + .25) continue;
      if (urgent.has(job.key) && job.caveDetail === st.caveDetail) {
        const due = (ground?.get(job.key) ?? 0) * this.groundForecastSeconds;
        // Canonical worker jobs can resume after yielding. Follow the earlier
        // arrival instead of protecting discarded work, but keep ties inside
        // the forecast's existing spatial padding stable across heading noise.
        const speed = Math.max(12, Math.hypot(this.groundMotionVx, this.groundMotionVz));
        const tie = Math.min(GROUND_FORECAST_STEP_SECONDS * .5, GROUND_CORRIDOR_HALF_WIDTH / speed);
        if (!(due - nearest > tie)) continue;
      }
      if (!waiting && !urgent.has(job.key)) continue;
      st.requestId = null;
      st.status = st.retiring ? 'ready' : 'queued';
      if (!st.retiring) this.queue.push(st);
      changed = true;
    }
    if (changed) this.cancelObsoleteJobs();
  }

  /** Only missing coverage can use a worker's shorter local deadline. The
   * flight set includes every crossed coarse tile, not just the lookahead
   * endpoint; an underground camera needs an actual cave enclosure. On foot,
   * finish the current canonical footprint after its first visible preview. */
  private urgentCoverageKeys(px: number, pz: number, ground?: ReadonlyMap<string, number>): Set<string> {
    const keys = new Set<string>();
    if (this.groundTravel) {
      for (const key of (ground ?? this.groundCoverageKeys(px, pz)).keys()) keys.add(key);
      if (!this.lastUnderground && !this.coveredAt(px, pz))
        keys.add(`2:${Math.floor(px / LOD2_TILE_M)},${Math.floor(pz / LOD2_TILE_M)}`);
      return keys;
    }
    if (this.lastUnderground) {
      if (!this.coveredAt(px, pz, true)) {
        for (const [lod, size] of [[0, CHUNK_SIZE], [1, LOD1_TILE_M]]) {
          const key = `${lod}:${Math.floor(px / size)},${Math.floor(pz / size)}`;
          if (this.columns.get(key)?.caveDetail) keys.add(key);
        }
      }
      return keys;
    }
    if (!this.flight || Math.abs(this.lookX) + Math.abs(this.lookZ) < .001) {
      if (!this.coveredAt(px, pz)) keys.add(`2:${Math.floor(px / LOD2_TILE_M)},${Math.floor(pz / LOD2_TILE_M)}`);
      else if (!this.flight && !this.coveredAt(px, pz, false, true)) {
        // Walking toward a parked vehicle must not leave its exact ground
        // behind the horizon-preview backlog. Either canonical LOD suffices;
        // admitting both also preserves an already running current fine job.
        keys.add(`0:${Math.floor(px / CHUNK_SIZE)},${Math.floor(pz / CHUNK_SIZE)}`);
        keys.add(`1:${Math.floor(px / LOD1_TILE_M)},${Math.floor(pz / LOD1_TILE_M)}`);
      }
      return keys;
    }
    const endX = px + this.lookX, endZ = pz + this.lookZ;
    for (let z = Math.floor(Math.min(pz, endZ) / LOD2_TILE_M); z <= Math.floor(Math.max(pz, endZ) / LOD2_TILE_M); z++) {
      for (let x = Math.floor(Math.min(px, endX) / LOD2_TILE_M); x <= Math.floor(Math.max(px, endX) / LOD2_TILE_M); x++) {
        const key = `2:${x},${z}`;
        if (this.columns.get(key)?.installed) continue;
        let enter = 0, leave = 1;
        for (const [start, delta, lo] of [[px, this.lookX, x * LOD2_TILE_M], [pz, this.lookZ, z * LOD2_TILE_M]]) {
          if (Math.abs(delta) < .001) {
            if (start < lo || start > lo + LOD2_TILE_M) { leave = -1; break; }
          } else {
            const a = (lo - start) / delta, b = (lo + LOD2_TILE_M - start) / delta;
            enter = Math.max(enter, Math.min(a, b)); leave = Math.min(leave, Math.max(a, b));
          }
        }
        if (enter <= leave) keys.add(key);
      }
    }
    return keys;
  }

  private pump(px: number, pz: number): void {
    if (this.disposed) return;
    const now = performance.now();
    const ground = this.groundTravel ? this.groundCoverageKeys(px, pz) : undefined;
    const urgent = !this.flight || this.cooperative || this.workers.some(w => w.readyAt > now)
      ? this.urgentCoverageKeys(px, pz, ground) : null;
    const dependencies = this.seamPreviewDependencyStates();
    const support = this.scenerySupportKeys(px, pz);
    // Refresh from actual current publications even when no competing route
    // is queued. A following cell crossing may precede scenery's next turn.
    for (const slot of this.workers) if (slot.job) {
      const st = this.columns.get(slot.job.key);
      if (st) this.rememberCurrentSupportJob(st, slot.job, support, px, pz);
    }
    if (!this.flight && urgent?.size) this.yieldGroundWorker(urgent, ground, dependencies, px, pz, support);
    if (support.size) this.yieldScenerySupport(support, urgent ?? new Set<string>());
    if (this.queue.length === 0) return;
    const free = this.workers.filter((w) => w.job === null && w.coverageReadyAt <= now &&
      (!this.flight || this.workers.length === 1 || w !== this.workers[0] ||
        this.queue.some((st) => st.status === 'queued' && st.lod === 2 && !st.installed)));
    if (free.length === 0) return;
    if (urgent?.size === 0 && free.every(w => w.readyAt > now)) return;

    // Cover the nearby landscape first, then refine the ground underfoot.
    // Hundreds of distant preview tiles must not delay those first nine
    // detailed columns. Flight keeps a worker dedicated to horizon coverage.
    const basePriority = (s: ColumnState): number => {
      const tileM = s.lod === 0 ? CHUNK_SIZE : s.lod === 1 ? LOD1_TILE_M : LOD2_TILE_M;
      const loX = s.cx * tileM, hiX = loX + tileM;
      const loZ = s.cz * tileM, hiZ = loZ + tileM;
      const rx = px < loX ? loX - px : px > hiX ? px - hiX : 0;
      const rz = pz < loZ ? loZ - pz : pz > hiZ ? pz - hiZ : 0;
      const rectDist = Math.hypot(rx, rz);
      const centerDist = Math.hypot((loX + hiX) * 0.5 - px, (loZ + hiZ) * 0.5 - pz);
      if (ground?.has(s.key)) {
        const eta = ground.get(s.key)! * this.groundForecastSeconds;
        // Straight steering-release guard priorities include the existing
        // +.25 s bias. Preserve that entire guard, conservatively including
        // equally near curved-route entries rather than shortening it.
        const near = this.lastUnderground || eta <= Math.min(1, this.groundForecastSeconds) + .25;
        const routePriority = (near ? -12_000_000 : -11_000_000) + ground.get(s.key)! * 1000 + centerDist * .001;
        return this.currentRockSupport(s, support)
          ? Math.min(routePriority, -11_250_000 + support.get(s.key)!.distance) : routePriority;
      }
      // Current coarse coverage still comes first at a cold arrival. Once it
      // exists, one current middle tile covers walking/boarding sooner than
      // the full fine ring; the rest of that ring retains its normal budget.
      if (!this.flight && !this.groundTravel && urgent!.has(s.key))
        return (s.lod === 2 ? -13_000_000 : s.lod === 1 ? -12_000_000 : -11_000_000) + centerDist;
      if (this.groundTravel && s.lod === 2 && !s.installed && urgent!.has(s.key)) return -13_000_000 + centerDist;
      // Seal every tile touching an underground camera before the ordinary
      // nearby preview/neighborhood priorities below can intercept it.
      if (this.lastUnderground && s.lod === 1 && rectDist < 1e-6) return -11_000_000 + centerDist;
      // Keep nearby land visible before refining its exact shape. Otherwise
      // continuous side-ground work can postpone an adjacent preview tile
      // and leave literal sky beside an already covered driving corridor.
      if (!this.flight && s.lod === 2 && !s.installed && rectDist <= 256)
        // Current missing coarse remains first above. This existing envelope
        // precedes only canonical route work beyond the steering guard;
        // its worker pacing and urgency remain ordinary.
        return (this.nearbyCoarseCoverage(s, px, pz) ? -11_500_000 : -10_750_000) + centerDist;
      // Current protected rocks may refine their already-selected middle
      // support before farther route work, below current/near/coarse coverage.
      // Urgency and all ordinary worker deadlines remain unchanged.
      const supported = support.get(s.key);
      if (supported) return (this.currentRockSupport(s, support) ? -11_250_000 :
        supported.future ? -10_600_000 : -10_625_000) + supported.distance;
      // Walking and respawning need surrounding ground too: a single current
      // fine tile cannot support nearby visible scenery. Prioritize at most
      // nine already-selected middle tiles after current/route coverage and
      // nearby previews, with their unchanged ordinary background pacing.
      if (!this.flight && s.lod === 1 && !s.installed &&
          Math.abs(s.cx - Math.floor(px / LOD1_TILE_M)) <= 1 &&
          Math.abs(s.cz - Math.floor(pz / LOD1_TILE_M)) <= 1)
        return -10_500_000 + centerDist;
      if (s.lod === 2 && !s.installed) {
        const ax = Math.max(loX - px - this.lookX, px + this.lookX - hiX, 0);
        const az = Math.max(loZ - pz - this.lookZ, pz + this.lookZ - hiZ, 0);
        const distance = Math.min(rectDist, Math.hypot(ax, az) + 128);
        return (distance < 768 || this.lastUnderground ? -10_000_000 : -1_000_000) + distance + centerDist * 0.001;
      }
      if (s.lod === 0) {
        const ccx = Math.floor(px / CHUNK_SIZE), ccz = Math.floor(pz / CHUNK_SIZE);
        if (Math.max(Math.abs(s.cx - ccx), Math.abs(s.cz - ccz)) <= 1) {
          return -3_000_000 + centerDist;
        }
      }
      const lodBias = s.lod === 2 ? 0 : s.lod === 1 ? 100 : 200;
      return rectDist / tileM * 1000 + lodBias + centerDist / tileM;
    };
    for (const st of this.queue) {
      st.priority = basePriority(st);
      for (const blocked of dependencies.get(st.key) ?? [])
        st.priority = Math.min(st.priority, basePriority(blocked));
    }
    this.queue.sort((a, b) =>
      a.priority - b.priority || b.lod - a.lod || a.key.localeCompare(b.key));

    for (const slot of free) {
      // Keep one flight worker immediately available for entering horizon
      // tiles. A four-second cave job on every worker defeats queue priority.
      const coverageOnly = this.flight && this.workers.length > 1 && slot === this.workers[0];
      let st: ColumnState | undefined;
      while (this.queue.length > 0) {
        const index = coverageOnly || slot.readyAt > now ? this.queue.findIndex((s) =>
          (!coverageOnly || s.lod === 2 && !s.installed) &&
          (slot.readyAt <= now || urgent!.has(s.key))) : 0;
        if (index < 0) break;
        const candidate = this.queue.splice(index, 1)[0];
        if (this.columns.get(candidate.key) === candidate && candidate.status === 'queued') {
          st = candidate;
          break;
        }
      }
      if (!st) break;
      if (st.canonicalRequest && st.canonicalRequest.caveDetail !== st.caveDetail) st.canonicalRequest = null;
      const requestId = this.reqId++;
      st.status = 'meshing';
      st.requestId = requestId;
      const step = st.lod === 0 ? 1 : st.lod === 1 ? LOD1_STEP : LOD2_STEP;
      slot.job = {
        key: st.key, requestId, cx: st.cx, cz: st.cz,
        step, caveDetail: st.caveDetail,
        preview: st.lod === 2 && !st.installed && st.canonicalRequest === null,
      };
      this.rememberCurrentSupportJob(st, slot.job, support, px, pz);
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
          ...(this.cooperative ? { urgentCoverage: urgent!.has(st.key) } : {}),
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

    this.publishMesh(st, msg);
    this.refreshStats();
    this.pump(this.lastPx, this.lastPz);
  }

  private publishMesh(st: ColumnState, msg: MeshedMsg): boolean {
    const authoredSeams = !msg.preview && validateAuthoredSeams(msg.authoredSeams, msg.cx, msg.cz, msg.step)
      ? msg.authoredSeams : undefined;
    const candidate = this.seamCandidate(st, msg.chunks, msg.portals, authoredSeams);
    this.seamCandidateMessages.set(candidate, { msg, preview: msg.preview === true, dependencies: new Map() });
    if (!(msg.preview && st.previewInstalled) && !this.installGeometry(st, msg.chunks, msg.portals, candidate)) {
      if (msg.preview && st.lod === 2 && !st.installed && st.requestId === null &&
          this.columns.get(st.key) === st && this.desired.has(st.key) && !st.retiring &&
          msg.caveDetail === st.caveDetail && !this.seamDeferred.has(st.key) &&
          this.seamCandidateMessages.get(candidate)?.canonicalRequired) {
        // The rejected preview was never published. Do not mark it installed
        // or retain it in a transaction that canonical neighbors cannot join.
        // Its replacement uses the same selected column and ordinary budget.
        st.canonicalRequest = { previewReqId: msg.reqId, caveDetail: msg.caveDetail };
        st.status = 'queued'; this.queue.push(st);
        this.wakeDeferredSeams(this.seamKeys(st));
        return false;
      }
      st.status = 'ready';
      this.seamDeferred.set(st.key, { state: st, candidate, msg, keys: this.seamKeys(st), dirty: true });
      this.wakeDeferredSeams(this.seamKeys(st));
      // A surface-only canonical band can meet another canonical tile but
      // not an interim preview. Keep at most eight ready results so those
      // connected neighbors can publish together without inventing a floor.
      if (this.seamDeferred.size > 8) {
        const key = this.seamDeferred.keys().next().value!;
        this.wakeDeferredSeams(this.seamDeferred.get(key)!.keys);
        this.seamDeferred.delete(key);
        const retry = this.columns.get(key);
        if (retry) { retry.status = 'queued'; this.queue.push(retry); }
      }
      return false;
    }
    this.finishMeshState(st, msg);
    this.pruneRetiring();
    // Every finer completion can change one or more exact coarse masks.
    this.syncCoarseVisibility(st);
    return true;
  }

  private finishMeshState(st: ColumnState, msg: MeshedMsg): void {
    if (!msg.preview) st.canonicalRequest = null;
    this.seamDeferred.delete(st.key);
    st.status = msg.preview ? 'queued' : 'ready';
    st.installed = true;
    st.installedCaveDetail = msg.caveDetail;
    st.previewInstalled = msg.preview === true;
    if (st.lod < 2 && !st.previewInstalled) this.installedCoverageRevision++;
    if (msg.preview) this.queue.push(st);
  }

  private retryDeferredSeam(): boolean {
    if (!this.seamDeferred.size && !this.seamTransaction) return false;
    for (const [key, pending] of this.seamDeferred) {
      const st = this.columns.get(key);
      if (st !== pending.state || !this.desired.has(key) || st.requestId !== null ||
          pending.msg.caveDetail !== st.caveDetail) {
        this.wakeDeferredSeams(pending.keys); this.seamDeferred.delete(key);
        if (st === pending.state && this.desired.has(key) && st.requestId === null) {
          st.status = 'queued'; this.queue.push(st);
        }
      }
    }
    let transaction = this.seamTransaction;
    if (transaction && (transaction.members.some(p => this.seamDeferred.get(p.state.key) !== p || p.dirty) ||
        [...(transaction.groupBases ?? [])].some(([owner, group]) => this.seamGroups.get(owner) !== group))) {
      this.discardSeamTransaction(); transaction = null;
    }
    if (!transaction) {
      const first = [...this.seamDeferred.values()].find(p => p.dirty);
      if (!first) return false;
      const members = [first], keys = new Set(first.keys);
      // A newly arrived READY neighbor wakes this component even though its
      // published preview/version has not changed. The retained set is <=8.
      for (let i = 0; i < members.length; i++) for (const pending of this.seamDeferred.values()) {
        if (members.includes(pending) || ![...pending.keys].some(key => keys.has(key))) continue;
        members.push(pending); for (const key of pending.keys) keys.add(key);
      }
      for (const pending of members) pending.dirty = false;
      transaction = this.seamTransaction = { members,
        replacements: new Map(members.map(p => [p.state.key, p.candidate])),
        keys: [...keys], edgeIndex: 0, edges: new Map(), geometry: [], groupIndex: 0 };
    }
    const began = performance.now();
    while (transaction.edgeIndex < transaction.keys.length) {
      const key = transaction.keys[transaction.edgeIndex++];
      const edge = this.prepareSeam(key, transaction.replacements);
      if (edge === false) { this.discardSeamTransaction(false); return true; }
      transaction.edges.set(key, edge);
      if (performance.now() - began >= UPLOAD_BUDGET_MS) return true;
    }
    if (transaction.geometry.length < transaction.members.length) {
      const pending = transaction.members[transaction.geometry.length];
      transaction.geometry.push(this.prepareGeometry(pending.candidate, pending.msg.chunks, pending.msg.portals));
      return true; // At most one uninstalled mesh preparation per upload slot.
    }
    if (!transaction.groups) {
      this.remapSeamStates(transaction.edges, transaction.replacements);
      transaction.groups = this.planSeamGroups(transaction.edges);
      transaction.groupEntries = [...transaction.groups];
      transaction.groupBases = new Map(transaction.groupEntries.map(([owner]) => [owner, this.seamGroups.get(owner)]));
    }
    if (transaction.groupIndex < transaction.groupEntries!.length) {
      this.prepareSeamGroup(transaction.groupEntries![transaction.groupIndex++][1]);
      return true;
    }
    // Everything expensive is prepared. No render can see an intermediate
    // mask: publish every candidate, then all flags and boundary groups, in
    // one synchronous commit before retiring any old neighbor.
    this.seamTransaction = null;
    for (let i = 0; i < transaction.members.length; i++) {
      const p = transaction.members[i];
      this.commitGeometry(p.state, p.candidate, transaction.geometry[i]);
      this.finishMeshState(p.state, p.msg);
      this.markSeamParents(p.state);
      if (p.state.lod > 0) this.seamMaskDirty.add(p.state.key);
    }
    this.commitSeamGroups(transaction.edges, transaction.groups!);
    this.pruneRetiring(); this.syncTerrainSeams(); this.refreshStats();
    return true;
  }

  private discardSeamTransaction(wake = true): void {
    const transaction = this.seamTransaction;
    if (!transaction) return;
    for (const prepared of transaction.geometry) for (const mesh of [...prepared.meshes, ...prepared.portals])
      mesh.geometry.dispose();
    for (const group of transaction.groups?.values() ?? []) {
      group.terrain?.geometry.dispose(); group.portal?.geometry.dispose();
    }
    if (wake) for (const pending of transaction.members) pending.dirty = true;
    this.seamTransaction = null;
  }

  private wakeDeferredSeams(keys: ReadonlySet<string>): void {
    for (const pending of this.seamDeferred.values()) {
      for (const key of keys) if (pending.keys.has(key)) { pending.dirty = true; break; }
    }
  }

  /** Only leaf edges touched by publication/retirement are reconsidered.
   * A horizon tile has at most 544 distinct edges; ordinary fine arrivals
   * touch four. Stationary frames perform no contour work. */
  private seamKeys(st: ColumnState): Set<string> {
    const scale = st.lod === 0 ? 1 : st.lod === 1 ? LOD1_STEP : LOD2_STEP;
    const keys = new Set<string>();
    for (let z = st.cz * scale; z < (st.cz + 1) * scale; z++) {
      for (let x = st.cx * scale; x < (st.cx + 1) * scale; x++) {
        keys.add(`x:${x},${z}`); keys.add(`x:${x + 1},${z}`);
        keys.add(`z:${x},${z}`); keys.add(`z:${x},${z + 1}`);
      }
    }
    return keys;
  }

  private markSeamEdges(st: ColumnState): void {
    const keys = this.seamKeys(st);
    for (const key of keys) this.seamDirty.add(key);
    this.wakeDeferredSeams(keys);
  }

  private markSeamParents(st: ColumnState): void {
    if (st.lod === 0) this.seamMaskDirty.add(`1:${Math.floor(st.cx / LOD1_STEP)},${Math.floor(st.cz / LOD1_STEP)}`);
    if (st.lod < 2) {
      const scale = st.lod === 0 ? LOD2_STEP : LOD1_STEP;
      this.seamMaskDirty.add(`2:${Math.floor(st.cx / scale)},${Math.floor(st.cz / scale)}`);
    }
  }

  private seamOwner(x: number, z: number, replacements?: ReadonlyMap<string, ColumnState>): ColumnState | undefined {
    const at = (lod: Lod) => {
      const scale = lod === 0 ? 1 : lod === 1 ? LOD1_STEP : LOD2_STEP;
      const key = `${lod}:${Math.floor(x / scale)},${Math.floor(z / scale)}`;
      return replacements?.get(key) ?? this.columns.get(key);
    };
    for (const lod of [0, 1, 2] as const) {
      const st = at(lod);
      if (!st?.installed) continue;
      // Retirement is validated against the geometry actually still present.
      // A neighbor may fail its own removal check later in the same pass;
      // some undesired leaves have not yet been marked retiring by that pass.
      // Only the explicitly staged removed state disappears prospectively.
      return st;
    }
    return undefined;
  }

  private seamBoundary(st: ColumnState, x: number, z: number, key: string,
    plane: BoundaryPlane, portal = false): BoundarySegment[] {
    st.seamBoundaries ??= new Map();
    const cacheKey = `${portal ? 'p' : 't'}:${key}:${x},${z}`;
    const cached = st.seamBoundaries.get(cacheKey);
    if (cached) return cached;
    let meshes: readonly BoundaryMesh[];
    if (st.lod === 0) meshes = portal ? (st.seamPortalSource ? [st.seamPortalSource] : []) : st.seamSource ?? [];
    else {
      const parts = portal ? st.portalParts : st.parts;
      const scale = st.lod === 1 ? LOD1_STEP : LOD2_STEP;
      const part = (z - st.cz * scale) * scale + x - st.cx * scale;
      const lo = parts?.offsets[part] ?? 0, hi = parts?.offsets[part + 1] ?? 0;
      const terrain = !portal ? st.parts : null;
      meshes = parts ? [{ positions: parts.positions.subarray(lo, hi),
        colors: terrain?.colors.subarray(lo, hi), caveDepth: terrain?.caveDepth?.subarray(lo / 3, hi / 3) }] : [];
    }
    const original = meshBoundary(meshes, plane);
    const boundary = portal ? original : spliceAuthoredBoundary(original, st.authoredSeams, x, z, plane);
    st.seamBoundaries.set(cacheKey, boundary);
    return boundary;
  }

  /** Only an observed incompatible mixed-LOD edge can promote a preview's
   * canonical replacement. A projected canonical neighbor is not a preview,
   * even when its state was copied from a published preview. */
  private recordSeamPreviewDependency(a: ColumnState, b: ColumnState,
    replacements?: ReadonlyMap<string, ColumnState>): void {
    for (const [candidate, neighbor] of [[a, b], [b, a]]) {
      const message = this.seamCandidateMessages.get(candidate);
      // A new coarse preview can arrive after finer canonical terrain. Its
      // one-contour heightfield cannot repair a finite slab boundary; retain
      // only this evidence here, and choose canonical work in publishMesh.
      if (message?.preview && candidate.lod === 2 && replacements?.get(candidate.key) === candidate &&
          neighbor.lod < candidate.lod && this.columns.get(neighbor.key) === neighbor &&
          neighbor.installed && !neighbor.previewInstalled) message.canonicalRequired = true;
      if (!message || message.preview || !replacements || replacements.get(candidate.key) !== candidate ||
          replacements.has(neighbor.key) || neighbor.lod <= candidate.lod ||
          this.columns.get(neighbor.key) !== neighbor || !neighbor.installed || !neighbor.previewInstalled ||
          neighbor.retiring || !this.desired.has(neighbor.key)) continue;
      // A finer square meets at most four coarser ownership sides. Keep the
      // evidence bounded independently of the number of boundary segments.
      if (message.dependencies.size < 4 || message.dependencies.has(neighbor.key))
        message.dependencies.set(neighbor.key, { state: neighbor, version: neighbor.seamVersion });
    }
  }

  /** Dependencies borrow only the existing priority of still-retained,
   * current-generation canonical results. They never enter urgentCoverage,
   * so the worker's ordinary work/rest deadline remains unchanged. */
  private seamPreviewDependencyStates(): Map<string, Set<ColumnState>> {
    const dependencies = new Map<string, Set<ColumnState>>();
    for (const pending of this.seamDeferred.values()) {
      const message = this.seamCandidateMessages.get(pending.candidate);
      if (!message) continue;
      const state = this.columns.get(pending.state.key);
      if (message.preview || message.msg !== pending.msg || !state || state !== pending.state ||
          !this.desired.has(state.key) || state.retiring || state.requestId !== null ||
          pending.msg.caveDetail !== state.caveDetail) {
        message.dependencies.clear(); continue;
      }
      for (const [key, dependency] of message.dependencies) {
        const parent = this.columns.get(key);
        if (!parent || parent !== dependency.state || !this.desired.has(key) || parent.retiring ||
            !parent.installed || !parent.previewInstalled || parent.seamVersion !== dependency.version) {
          message.dependencies.delete(key); continue;
        }
        let blocked = dependencies.get(key);
        if (!blocked) { blocked = new Set(); dependencies.set(key, blocked); }
        blocked.add(state);
      }
    }
    return dependencies;
  }
  private prepareSeam(key: string, replacements?: ReadonlyMap<string, ColumnState>): SeamEdge | null | false {
    const axis = key[0] as 'x' | 'z';
    const [x, z] = key.slice(2).split(',').map(Number);
    const ax = x - (axis === 'x' ? 1 : 0), az = z - (axis === 'z' ? 1 : 0);
    const a = this.seamOwner(ax, az, replacements), b = this.seamOwner(x, z, replacements);
    if (!a || !b || a.lod === b.lod) return null;
    const old = this.seamEdges.get(key);
    if (old?.a.key === a.key && old.b.key === b.key &&
        old.aVersion === a.seamVersion && old.bVersion === b.seamVersion) return old;
    const plane: BoundaryPlane = { axis, boundary: (axis === 'x' ? x : z) * CHUNK_SIZE,
      lo: (axis === 'x' ? z : x) * CHUNK_SIZE, hi: (axis === 'x' ? z + 1 : x + 1) * CHUNK_SIZE };
    const terrain = stitchBoundary(this.seamBoundary(a, ax, az, key, plane), this.seamBoundary(b, x, z, key, plane), plane);
    if (!terrain.compatible) {
      this.recordSeamPreviewDependency(a, b, replacements);
      return false;
    }
    const portal = stitchBoundary(this.seamBoundary(a, ax, az, key, plane, true),
      this.seamBoundary(b, x, z, key, plane, true), plane, true);
    if (!portal.compatible) {
      this.recordSeamPreviewDependency(a, b, replacements);
      return false;
    }
    return { a, b, aVersion: a.seamVersion, bVersion: b.seamVersion, owner: a.lod > b.lod ? a : b,
      terrain: terrain.mesh, portal: portal.mesh };
  }

  /** One extra terrain draw per affected coarse tile, not one draw per edge.
   * Cached strips are repacked only when that tile's active seams change. */
  private replaceSeams(changes: Map<string, SeamEdge | null>): void {
    const groups = this.planSeamGroups(changes);
    for (const group of groups.values()) this.prepareSeamGroup(group);
    this.commitSeamGroups(changes, groups);
  }

  private planSeamGroups(changes: Map<string, SeamEdge | null>): Map<ColumnState, SeamGroup> {
    const groups = new Map<ColumnState, SeamGroup>();
    const groupFor = (owner: ColumnState) => {
      let group = groups.get(owner);
      if (!group) { group = { parts: new Map(this.seamGroups.get(owner)?.parts) }; groups.set(owner, group); }
      return group;
    };
    for (const [key, entry] of changes) {
      const old = this.seamEdges.get(key);
      if (old === entry) continue;
      if (old) groupFor(old.owner).parts.delete(key);
      if (entry) groupFor(entry.owner).parts.set(key, entry);
    }
    return groups;
  }

  private prepareSeamGroup(group: SeamGroup): void {
    const terrain = combineSeamMeshes([...group.parts.values()].map(part => part.terrain));
    const portal = combineSeamMeshes([...group.parts.values()].map(part => part.portal));
    group.terrain = terrain.positions.length ? this.createMesh(terrain) : undefined;
    group.portal = portal.positions.length ? this.createPortalMesh(portal.positions) : undefined;
  }

  private commitSeamGroups(changes: Map<string, SeamEdge | null>, groups: Map<ColumnState, SeamGroup>): void {
    for (const [key, entry] of changes) {
      if (entry) this.seamEdges.set(key, entry); else this.seamEdges.delete(key);
    }
    for (const [owner, group] of groups) {
      const old = this.seamGroups.get(owner);
      if (group.terrain) this.group.add(group.terrain);
      if (group.portal) this.portalGroup.add(group.portal);
      if (old?.terrain) { this.group.remove(old.terrain); old.terrain.geometry.dispose(); }
      if (old?.portal) { this.portalGroup.remove(old.portal); old.portal.geometry.dispose(); }
      if (group.parts.size) this.seamGroups.set(owner, group); else this.seamGroups.delete(owner);
    }
  }

  private remapSeamStates(edges: Map<string, SeamEdge | null>, replacements: ReadonlyMap<string, ColumnState>): void {
    for (const entry of edges.values()) if (entry) {
      if (replacements.get(entry.a.key) === entry.a) entry.a = this.columns.get(entry.a.key)!;
      if (replacements.get(entry.b.key) === entry.b) entry.b = this.columns.get(entry.b.key)!;
      if (replacements.get(entry.owner.key) === entry.owner) entry.owner = this.columns.get(entry.owner.key)!;
    }
  }

  private syncTerrainSeams(): void {
    for (const key of this.seamMaskDirty) this.syncOneCoarse(this.columns.get(key));
    this.seamMaskDirty.clear();
    if (!this.seamDirty.size) return;
    const changes = new Map<string, SeamEdge | null>();
    for (const key of this.seamDirty) {
      const entry = this.prepareSeam(key);
      // A replacement has already passed this check before its mask changed.
      // Selection can also remove an edge entirely; never keep a stale strip.
      changes.set(key, entry === false ? null : entry);
    }
    this.seamDirty.clear();
    this.replaceSeams(changes);
  }

  private seamCandidate(st: ColumnState, chunks: ChunkMesh[], portals: EntrancePortalMesh,
    authoredSeams?: AuthoredSeamPayload): ColumnState {
    return { ...st, installed: true, authoredSeams,
      seamSource: st.lod === 0 ? chunks : [], seamPortalSource: st.lod === 0 ? portals : null,
      seamVersion: ++this.seamSerial, seamBoundaries: new Map(),
      parts: st.lod === 0 ? null : this.partsFromPacked(chunks, st.lod === 1 ? DIRECT_PARTS : LOD2_LEAF_PARTS),
      portalParts: st.lod === 0 ? null : this.portalPartsFromPacked(portals, st.lod === 1 ? DIRECT_PARTS : LOD2_LEAF_PARTS) };
  }

  private installGeometry(st: ColumnState, chunks: ChunkMesh[], portals: EntrancePortalMesh,
    candidate = this.seamCandidate(st, chunks, portals)): boolean {
    const replacements = new Map([[st.key, candidate]]);
    const seams = new Map<string, SeamEdge | null>();
    for (const key of this.seamKeys(candidate)) {
      const entry = this.prepareSeam(key, replacements);
      if (entry === false) return false;
      seams.set(key, entry);
    }
    this.remapSeamStates(seams, replacements);
    const prepared = this.prepareGeometry(candidate, chunks, portals);
    this.commitGeometry(st, candidate, prepared);
    this.replaceSeams(seams);
    return true;
  }

  private prepareGeometry(candidate: ColumnState, chunks: ChunkMesh[], portals: EntrancePortalMesh): PreparedGeometry {
    let fresh: THREE.Mesh[];
    let freshPortals: THREE.Mesh[];
    if (candidate.lod === 0) {
      candidate.partGrid = 0;
      candidate.partVisible = null;
      fresh = chunks.map((chunk) => this.createMesh(chunk));
      freshPortals = portals.positions.length > 0
        ? [this.createPortalMesh(portals.positions)]
        : [];
    } else {
      candidate.partGrid = candidate.lod === 1 ? DIRECT_PARTS : LOD2_LEAF_PARTS;
      candidate.partVisible = this.coarseVisibility(candidate);
      fresh = this.meshesForParts(candidate.parts!, candidate.partVisible);
      freshPortals = this.meshesForPortalParts(candidate.portalParts!, candidate.partVisible);
    }
    return { meshes: fresh, portals: freshPortals };
  }

  private commitGeometry(st: ColumnState, candidate: ColumnState, prepared: PreparedGeometry): void {
    st.seamSource = candidate.seamSource; st.seamPortalSource = candidate.seamPortalSource;
    st.authoredSeams = candidate.authoredSeams;
    st.seamVersion = candidate.seamVersion; st.seamBoundaries = candidate.seamBoundaries;
    st.parts = candidate.parts; st.portalParts = candidate.portalParts;
    st.partGrid = candidate.partGrid; st.partVisible = candidate.partVisible;
    this.swapMeshes(st, prepared.meshes, prepared.portals);
    this.markSeamEdges(st);
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
      // Start resting when the worker finishes, not when a later frame
      // installs its buffers. Every dispatch path uses this same deadline.
      const completedAt = performance.now();
      slot.readyAt = completedAt + (ev.data.paced === true ? 0 : workerJobRestMs(ev.data.workMs));
      slot.coverageReadyAt = completedAt + (ev.data.paced === true ? 0 : workerJobRestMs(ev.data.workMs, true));
      // Hold this slot until its transferred buffers can be installed within
      // the next frame's budget; responses cannot build an unbounded inbox.
      this.pendingMeshes.push({ slot, worker, msg: ev.data });
    };
    worker.onerror = (ev: ErrorEvent) => {
      ev.preventDefault?.();
      this.onWorkerError(slot, worker);
    };
    worker.onmessageerror = () => this.onWorkerError(slot, worker);
    worker.postMessage({ type: 'init', seed: this.seed, ...(this.cooperative ? { cooperative: true } : {}),
      ...(this.transportSnapshot ? { transportSnapshot: this.transportSnapshot } : {}) });
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
    slot.readyAt = 0;
    slot.coverageReadyAt = 0;
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
    this.seamCandidateMessages = new WeakMap();
    this.scenerySupport.clear();
    this.discardSeamTransaction(false);
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
      st.seamSource = []; st.seamPortalSource = null; st.seamBoundaries?.clear();
    }
    for (const group of this.seamGroups.values()) {
      if (group.terrain) { this.group.remove(group.terrain); group.terrain.geometry.dispose(); }
      if (group.portal) { this.portalGroup.remove(group.portal); group.portal.geometry.dispose(); }
    }
    this.seamEdges.clear(); this.seamGroups.clear(); this.seamDirty.clear(); this.seamMaskDirty.clear(); this.seamDeferred.clear();
    this.columns.clear();
    this.installedCoverageRevision++;
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
    for (const group of this.seamGroups.values())
      if (group.terrain) tris += group.terrain.geometry.getAttribute('position').count / 3;
    this.stats.columnsReady = ready;
    this.stats.columnsPending = pending;
    this.stats.triangles = Math.round(tris);
  }
}
