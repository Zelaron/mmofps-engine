import { captureAuthoredSeamsSteps, finishAuthoredSeamsSteps } from './terrain-authored-seams-worker.js';
import type { AuthoredSeamPayload } from './terrain-authored-seams.js';
import {
  World, CHUNK_SIZE, WORLD, LOD1_STEP, LOD2_STEP,
  CAVE_SHAFT_BREACH_ENTR, CAVE_MIN_ROOF,
  type ColumnData, type Region, type MatId, type StructureFoundation,
} from '@shared/index';
import { cityParcelKind } from '@shared/cities';

// Surface-nets mesher. Runs inside a web worker; converts the analytic SDF
// into flat-shaded, vertex-colored triangle soup, one chunk at a time.
// PURELY COSMETIC - physics never touches these meshes.
//
// `step` scales the voxel size: step=1 is full-detail 32m columns; step=4/16
// are the far-LOD rings (4m/16m voxels, 128m/512m tiles, same sample count
// per chunk). Terrain/caves use this sampled field; exact foundation faces
// share their terrain leaves, while walls, rocks and plants are instanced.
//
// Sampling grid per chunk: 35^3 samples covering local cells -1..33, so
// border cells are shared with neighboring chunks and seams are watertight.

export interface ChunkMesh {
  cy: number;
  positions: Float32Array; // non-indexed triangle soup, world coordinates
  normals: Float32Array;
  colors: Uint8Array;      // rgb, normalized in the shader
  /** Quarter-metres beneath the terrain envelope; zero denotes exterior. */
  caveDepth?: Uint8Array;
  /** Coarse meshes are ordered by exact 32m horizontal fallback leaves. */
  partGrid?: number;
  /** Scalar position offsets; length is partGrid^2 + 1. */
  partOffsets?: Uint32Array;
}

/**
 * Invisible terrain-envelope caps around canonical cave entrances. A
 * depth-visible crossing toggles stencil parity: one crossing changes
 * inside/outside, while an entry followed by an exit preserves real sky.
 */
export interface EntrancePortalMesh {
  positions: Float32Array;
  /** Coarse caps use the same exact 32m fallback partition as terrain. */
  partGrid?: number;
  /** Scalar position offsets; length is partGrid^2 + 1. */
  partOffsets?: Uint32Array;
}

export interface ColumnMeshBundle {
  chunks: ChunkMesh[];
  portals: EntrancePortalMesh;
  authoredSeams?: AuthoredSeamPayload;
}

/** Synchronous callers retain the same completed result. Workers can instead
 * pause the iterator at its row/cell boundaries without changing mesh order. */
function finishMesh<T>(steps: Generator<void, T, void>): T {
  let result = steps.next();
  while (!result.done) result = steps.next();
  return result.value;
}

const N = CHUNK_SIZE;      // 32 cells
const G = N + 3;           // 35 samples per axis (-1 .. 33)
const CELLS = G - 1;       // 34 cells per axis (-1 .. 32)
const CLIP_EPS = 1e-7;
export const ENTRANCE_PORTAL_LIFT = 0.05;

interface PortalVertex {
  x: number;
  y: number;
  z: number;
  /** Conservative entrance envelope; depth supplies the true aperture. */
  candidate: boolean;
}

/**
 * Keep whole candidate cells. A separately clipped contour is necessarily a
 * second approximation of a voxel mouth and leaves thin sky pixels outside
 * its stencil. Conservative caps are invisible and the already-rendered
 * terrain depth rejects every ray obstructed by a roof or a mouth wall.
 */
function emitPortalTriangle(
  out: number[], a: PortalVertex, b: PortalVertex, c: PortalVertex,
): void {
  for (const v of [a, b, c]) out.push(v.x, v.y, v.z);
}

/**
 * Mesh the mouth of every canonical entrance in one horizontal terrain tile.
 *
 * The invisible cap follows the terrain envelope across the conservative
 * footprint of each cave site. It is intentionally wider than the visible
 * mouth: rendered terrain, rather than another entrance contour, determines
 * whether a pixel really sees outside. A roofed camera's exterior sightline
 * crosses the envelope before reaching the sky.
 */
export function meshEntrancePortals(
  world: World, cx: number, cz: number, step = 1,
): EntrancePortalMesh {
  const chunkW = N * step;
  const baseX = cx * chunkW;
  const baseZ = cz * chunkW;
  const cols: ColumnData[] = new Array(G * G);
  for (let iz = 0; iz < G; iz++) {
    for (let ix = 0; ix < G; ix++) {
      cols[iz * G + ix] = world.column(
        baseX + (ix - 1) * step,
        baseZ + (iz - 1) * step,
      );
    }
  }
  return meshEntrancePortalsFromColumns(cols, baseX, baseZ, step);
}

/** Build caps from the 35x35 column cache already needed by terrain. */
function meshEntrancePortalsFromColumns(
  cols: readonly ColumnData[], baseX: number, baseZ: number, step: number,
): EntrancePortalMesh {
  const side = N + 1;
  const samples: PortalVertex[] = new Array(side * side);
  for (let iz = 0; iz < side; iz++) {
    for (let ix = 0; ix < side; ix++) {
      const x = baseX + ix * step;
      const z = baseZ + iz * step;
      // Terrain's cache includes one ghost sample on every side, so its
      // footprint samples occupy indices 1..N+1.
      const col = cols[(iz + 1) * G + ix + 1];
      samples[iz * side + ix] = {
        x,
        y: col.h + ENTRANCE_PORTAL_LIFT,
        z,
        candidate: col.cave !== undefined || col.entr > CAVE_SHAFT_BREACH_ENTR,
      };
    }
  }

  const partGrid = step === 1 ? 1 : step;
  const cellsPerPart = N / partGrid;
  const parts: number[][] = Array.from(
    { length: partGrid * partGrid },
    () => [],
  );
  for (let iz = 0; iz < N; iz++) {
    for (let ix = 0; ix < N; ix++) {
      const p00 = samples[iz * side + ix];
      const p10 = samples[iz * side + ix + 1];
      const p01 = samples[(iz + 1) * side + ix];
      const p11 = samples[(iz + 1) * side + ix + 1];
      if (!(p00.candidate || p10.candidate || p01.candidate || p11.candidate)) continue;
      const px = Math.min(partGrid - 1, Math.floor(ix / cellsPerPart));
      const pz = Math.min(partGrid - 1, Math.floor(iz / cellsPerPart));
      const positions = parts[pz * partGrid + px];
      // A consistent diagonal makes neighboring tiles agree exactly along
      // their shared edge; the material is DoubleSide, so winding is immaterial.
      emitPortalTriangle(positions, p00, p10, p11);
      emitPortalTriangle(positions, p00, p11, p01);
    }
  }
  if (step === 1) return { positions: new Float32Array(parts[0]) };

  let total = 0;
  const partOffsets = new Uint32Array(parts.length + 1);
  for (let i = 0; i < parts.length; i++) {
    partOffsets[i] = total;
    total += parts[i].length;
  }
  partOffsets[parts.length] = total;
  const positions = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    positions.set(part, offset);
    offset += part.length;
  }
  return { positions, partGrid, partOffsets };
}

interface ClipVertex {
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
  r: number; g: number; b: number;
  caveDepth: number;
}

function clipPolygon(
  input: ClipVertex[], axis: 'x' | 'y' | 'z', boundary: number, keepGreater: boolean,
): ClipVertex[] {
  if (input.length === 0) return input;
  const output: ClipVertex[] = [];
  let a = input[input.length - 1];
  let av = a[axis] - boundary;
  let aInside = keepGreater ? av >= -CLIP_EPS : av <= CLIP_EPS;
  for (const b of input) {
    const bv = b[axis] - boundary;
    const bInside = keepGreater ? bv >= -CLIP_EPS : bv <= CLIP_EPS;
    if (aInside !== bInside) {
      const den = b[axis] - a[axis];
      const t = Math.abs(den) < 1e-12 ? 0 : (boundary - a[axis]) / den;
      const mix = (x: number, y: number): number => x + (y - x) * t;
      output.push({
        x: axis === 'x' ? boundary : mix(a.x, b.x),
        y: axis === 'y' ? boundary : mix(a.y, b.y),
        z: axis === 'z' ? boundary : mix(a.z, b.z),
        nx: mix(a.nx, b.nx), ny: mix(a.ny, b.ny), nz: mix(a.nz, b.nz),
        r: mix(a.r, b.r), g: mix(a.g, b.g), b: mix(a.b, b.b),
        caveDepth: mix(a.caveDepth, b.caveDepth),
      });
    }
    if (bInside) output.push(b);
    a = b;
    aInside = bInside;
  }
  return output;
}

/**
 * Exact plinth ownership, before fallback partitioning. Subtracting each
 * prism clips crossing triangles at the footprint and foundation bottom;
 * terrain outside the plinth keeps its original slope and attributes.
 */
export function clipTerrainFoundations(chunks: readonly ChunkMesh[], foundations: readonly StructureFoundation[]): ChunkMesh[] {
  return finishMesh(clipTerrainFoundationsSteps(chunks, foundations));
}

function* clipTerrainFoundationsSteps(
  chunks: readonly ChunkMesh[], foundations: readonly StructureFoundation[],
): Generator<void, ChunkMesh[], void> {
  if (foundations.length === 0) return [...chunks];
  const out: ChunkMesh[] = [];
  for (const chunk of chunks) {
    const positions: number[] = [], normals: number[] = [], colors: number[] = [], depth: number[] = [];
    for (let i = 0; i < chunk.positions.length; i += 9) {
      if (i % (64 * 9) === 0) yield;
      const tri: ClipVertex[] = [];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let v = 0; v < 3; v++) {
        const j = i + v * 3;
        const x = chunk.positions[j], y = chunk.positions[j + 1], z = chunk.positions[j + 2];
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        tri.push({ x, y, z, nx: chunk.normals[j], ny: chunk.normals[j + 1], nz: chunk.normals[j + 2],
          r: chunk.colors[j], g: chunk.colors[j + 1], b: chunk.colors[j + 2], caveDepth: chunk.caveDepth?.[j / 3] ?? 0 });
      }
      let pieces: ClipVertex[][] = [tri];
      for (const box of foundations) {
        const loX = box.x - box.hx, hiX = box.x + box.hx;
        const loZ = box.z - box.hz, hiZ = box.z + box.hz, bottom = box.y - box.hy;
        const top = box.underground ? box.y + box.hy + 0.6 : Infinity;
        if (maxX < loX || minX > hiX || maxZ < loZ || minZ > hiZ || maxY < bottom || minY > top) continue;
        const next: ClipVertex[][] = [];
        for (const piece of pieces) {
          let interior = piece;
          const planes: ['x' | 'y' | 'z', number, boolean][] = [
            ['x', loX, true], ['x', hiX, false], ['z', loZ, true], ['z', hiZ, false], ['y', bottom, true],
          ];
          if (Number.isFinite(top)) planes.push(['y', top, false]);
          for (const [axis, boundary, greater] of planes) {
            if (interior.length < 3) break;
            const exterior = clipPolygon(interior, axis, boundary, !greater);
            // A coincident face belongs to the exact plinth, not both
            // renderers. Keep only pieces with real area outside the prism.
            if (exterior.length >= 3 && exterior.some((v) => Math.abs(v[axis] - boundary) > CLIP_EPS)) next.push(exterior);
            interior = clipPolygon(interior, axis, boundary, greater);
          }
        }
        pieces = next;
        if (pieces.length === 0) break;
      }
      for (const polygon of pieces) {
        for (let k = 1; k + 1 < polygon.length; k++) {
          const a = polygon[0], b = polygon[k], c = polygon[k + 1];
          const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
          const vx = c.x - a.x, vy = c.y - a.y, vz = c.z - a.z;
          if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-8) continue;
          for (const v of [a, b, c]) {
            positions.push(v.x, v.y, v.z);
            const length = Math.hypot(v.nx, v.ny, v.nz) || 1;
            normals.push(v.nx / length, v.ny / length, v.nz / length);
            colors.push(Math.round(v.r), Math.round(v.g), Math.round(v.b));
            depth.push(Math.round(v.caveDepth));
          }
        }
      }
    }
    if (positions.length) out.push({ cy: chunk.cy, positions: new Float32Array(positions),
      normals: new Float32Array(normals), colors: new Uint8Array(colors),
      caveDepth: chunk.caveDepth ? new Uint8Array(depth) : undefined });
  }
  return out;
}

/** Exact plinths travel with their terrain leaf, so their coverage extends
 * through every horizon LOD without a global structure instance pool. */
function* appendFoundationMeshesSteps(
  chunks: ChunkMesh[], foundations: readonly StructureFoundation[], world: World, step: number,
): Generator<void, ChunkMesh[], void> {
  const additions = new Map<number, { p: number[]; n: number[]; c: number[]; d: number[] }>();
  for (const box of foundations) {
    yield;
    const cy = Math.floor(box.y / (N * step));
    let target = additions.get(cy);
    if (!target) { target = { p: [], n: [], c: [], d: [] }; additions.set(cy, target); }
    const center = [box.x, box.y, box.z], half = [box.hx, box.hy, box.hz];
    const h = box.underground ? world.column(box.x, box.z).h : 0;
    const city = box.facade === 5 ? world.collectCities().find(c =>
      Math.abs(c.x - box.x) <= c.radius && Math.abs(c.z - box.z) <= c.radius) : undefined;
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      if (city && axis === 1 && sign === 1) {
        // The city's single authoritative floor also owns asphalt and
        // sidewalks. Split only at lane edges: no overlapping road decals,
        // no extra renderer or per-frame draw, and exact edges at every LOD.
        const cuts = (middle: number, extent: number, origin: number): number[] => {
          const lo = middle - extent, hi = middle + extent, result = [lo, hi];
          for (let lane = -city.radius; lane <= city.radius; lane += 64) {
            const halfLane = lane === 0 ? 9 : 5.8;
            for (const edge of [-halfLane, halfLane]) {
              const p = origin + lane + edge;
              if (p > lo && p < hi) result.push(p);
            }
          }
          return result.sort((a, b) => a - b);
        };
        const xs = cuts(box.x, box.hx, city.x), zs = cuts(box.z, box.hz, city.z);
        const laneAt = (p: number, origin: number): boolean => {
          const lane = Math.round((p - origin) / 64) * 64;
          return Math.abs(p - origin - lane) < (lane === 0 ? 9 : 5.8);
        };
        for (let zi = 0; zi + 1 < zs.length; zi++) {
          for (let xi = 0; xi + 1 < xs.length; xi++) {
            const road = laneAt((xs[xi] + xs[xi + 1]) * .5, city.x) || laneAt((zs[zi] + zs[zi + 1]) * .5, city.z);
            const parcel = cityParcelKind(city, Math.floor(((xs[xi] + xs[xi + 1]) * .5 - city.x) / 64),
              Math.floor(((zs[zi] + zs[zi + 1]) * .5 - city.z) / 64));
            const color = city.theme === 'vesper' ? (road ? [37, 43, 54] : parcel === 'park' ? [59, 87, 82] : [86, 76, 102]) :
              city.theme === 'aurelia' ? (road ? [100, 104, 95] : parcel === 'park' ? [94, 123, 71] : [188, 182, 160]) :
              road ? [62, 70, 73] : parcel === 'park' ? [92, 124, 69] : [161, 160, 148];
            for (const [ix, iz] of [[0, 0], [0, 1], [1, 1], [0, 0], [1, 1], [1, 0]]) {
              target.p.push(xs[xi + ix], box.y + box.hy, zs[zi + iz]);
              target.n.push(0, 1, 0); target.c.push(...color); target.d.push(0);
            }
          }
          yield;
        }
        continue;
      }
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
        const p = [...center]; p[axis] += sign * half[axis]; p[u] += a * half[u]; p[v] += b * half[v];
        return p;
      });
      const indices = sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2];
      for (const index of indices) {
        const p = points[index];
        target.p.push(...p);
        target.n.push(axis === 0 ? sign : 0, axis === 1 ? sign : 0, axis === 2 ? sign : 0);
        target.c.push(153, 156, 163);
        target.d.push(box.underground ? Math.round(Math.max(0, Math.min(63.75, h - p[1])) * 4) : 0);
      }
    }
  }
  const byCy = new Map(chunks.map((chunk) => [chunk.cy, chunk]));
  for (const [cy, addition] of additions) {
    yield;
    const old = byCy.get(cy);
    const positions = new Float32Array((old?.positions.length ?? 0) + addition.p.length);
    const normals = new Float32Array(positions.length), colors = new Uint8Array(positions.length);
    const caveDepth = new Uint8Array(positions.length / 3);
    if (old) {
      positions.set(old.positions); normals.set(old.normals); colors.set(old.colors);
      if (old.caveDepth) caveDepth.set(old.caveDepth);
    }
    const offset = old?.positions.length ?? 0;
    positions.set(addition.p, offset); normals.set(addition.n, offset); colors.set(addition.c, offset);
    caveDepth.set(addition.d, offset / 3);
    byCy.set(cy, { cy, positions, normals, colors, caveDepth });
  }
  return [...byCy.values()].sort((a, b) => a.cy - b.cy);
}

export function partitionChunkMeshes(
  chunks: readonly ChunkMesh[],
  baseX: number,
  baseZ: number,
  tileSize: number,
  grid: number,
): ChunkMesh[] {
  return finishMesh(partitionChunkMeshesSteps(chunks, baseX, baseZ, tileSize, grid));
}

function* partitionChunkMeshesSteps(
  chunks: readonly ChunkMesh[], baseX: number, baseZ: number, tileSize: number, grid: number,
): Generator<void, ChunkMesh[], void> {
  if (chunks.length === 0) return [];
  const partSize = tileSize / grid;
  const positions: number[][] = Array.from({ length: grid * grid }, () => []);
  const normals: number[][] = Array.from({ length: grid * grid }, () => []);
  const colors: number[][] = Array.from({ length: grid * grid }, () => []);
  const caveDepth: number[][] = Array.from({ length: grid * grid }, () => []);
  const hasCaveDepth = chunks.some((chunk) => chunk.caveDepth !== undefined);
  const clampPart = (v: number): number => Math.max(0, Math.min(grid - 1, v));

  for (const chunk of chunks) {
    const p = chunk.positions, n = chunk.normals, c = chunk.colors;
    for (let i = 0; i + 8 < p.length; i += 9) {
      if (i % (64 * 9) === 0) yield;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      for (let v = 0; v < 3; v++) {
        const j = i + v * 3;
        minX = Math.min(minX, p[j]); maxX = Math.max(maxX, p[j]);
        minZ = Math.min(minZ, p[j + 2]); maxZ = Math.max(maxZ, p[j + 2]);
      }
      const x0 = clampPart(Math.floor((minX - baseX) / partSize));
      const x1 = clampPart(Math.floor((maxX - baseX) / partSize));
      const z0 = clampPart(Math.floor((minZ - baseZ) / partSize));
      const z1 = clampPart(Math.floor((maxZ - baseZ) / partSize));
      const singleLoX = baseX + x0 * partSize;
      const singleLoZ = baseZ + z0 * partSize;
      // Nearly every full-detail face is wholly inside its one destination
      // footprint. Preserve it byte-for-byte without allocating clip vertices.
      if (
        x0 === x1 && z0 === z1 &&
        minX >= singleLoX && maxX <= singleLoX + partSize &&
        minZ >= singleLoZ && maxZ <= singleLoZ + partSize
      ) {
        const part = z0 * grid + x0;
        for (let j = i; j < i + 9; j++) {
          positions[part].push(p[j]);
          normals[part].push(n[j]);
          colors[part].push(c[j]);
        }
        if (hasCaveDepth) {
          for (let v = 0; v < 3; v++) caveDepth[part].push(chunk.caveDepth?.[i / 3 + v] ?? 0);
        }
        continue;
      }
      const tri: ClipVertex[] = [];
      for (let v = 0; v < 3; v++) {
        const j = i + v * 3;
        tri.push({
          x: p[j], y: p[j + 1], z: p[j + 2],
          nx: n[j], ny: n[j + 1], nz: n[j + 2],
          r: c[j], g: c[j + 1], b: c[j + 2],
          caveDepth: chunk.caveDepth?.[j / 3] ?? 0,
        });
      }
      for (let pz = z0; pz <= z1; pz++) {
        for (let px = x0; px <= x1; px++) {
          const loX = baseX + px * partSize, hiX = loX + partSize;
          const loZ = baseZ + pz * partSize, hiZ = loZ + partSize;
          let polygon = tri;
          if (minX < loX) polygon = clipPolygon(polygon, 'x', loX, true);
          if (maxX > hiX) polygon = clipPolygon(polygon, 'x', hiX, false);
          if (minZ < loZ) polygon = clipPolygon(polygon, 'z', loZ, true);
          if (maxZ > hiZ) polygon = clipPolygon(polygon, 'z', hiZ, false);
          if (polygon.length < 3) continue;
          const part = pz * grid + px;
          for (let k = 1; k + 1 < polygon.length; k++) {
            const a = polygon[0], b = polygon[k], d = polygon[k + 1];
            const ux = b.x - a.x, uy = b.y - a.y, uz = b.z - a.z;
            const vx = d.x - a.x, vy = d.y - a.y, vz = d.z - a.z;
            const cx = uy * vz - uz * vy;
            const cy = uz * vx - ux * vz;
            const cz = ux * vy - uy * vx;
            if (cx * cx + cy * cy + cz * cz < 1e-14) continue;
            for (const vertex of [a, b, d]) {
              positions[part].push(vertex.x, vertex.y, vertex.z);
              const nl = Math.hypot(vertex.nx, vertex.ny, vertex.nz) || 1;
              normals[part].push(vertex.nx / nl, vertex.ny / nl, vertex.nz / nl);
              colors[part].push(
                Math.max(0, Math.min(255, Math.round(vertex.r))),
                Math.max(0, Math.min(255, Math.round(vertex.g))),
                Math.max(0, Math.min(255, Math.round(vertex.b))),
              );
              if (hasCaveDepth) caveDepth[part].push(Math.round(vertex.caveDepth));
            }
          }
        }
      }
    }
  }

  let total = 0;
  const partOffsets = new Uint32Array(grid * grid + 1);
  for (let i = 0; i < positions.length; i++) {
    partOffsets[i] = total;
    total += positions[i].length;
  }
  partOffsets[positions.length] = total;
  const packedPositions = new Float32Array(total);
  const packedNormals = new Float32Array(total);
  const packedColors = new Uint8Array(total);
  const packedCaveDepth = hasCaveDepth ? new Uint8Array(total / 3) : undefined;
  let offset = 0;
  for (let i = 0; i < positions.length; i++) {
    yield;
    packedPositions.set(positions[i], offset);
    packedNormals.set(normals[i], offset);
    packedColors.set(colors[i], offset);
    packedCaveDepth?.set(caveDepth[i], offset / 3);
    offset += positions[i].length;
  }
  return [{
    cy: chunks[0].cy,
    positions: packedPositions,
    normals: packedNormals,
    colors: packedColors,
    caveDepth: packedCaveDepth,
    partGrid: grid,
    partOffsets,
  }];
}

/**
 * Clip full-detail ghost-cell triangles to the exact 32m column they belong
 * to. The returned protocol intentionally remains ordinary LOD0: one mesh per
 * vertical chunk with no coarse partGrid/partOffsets metadata.
 */
function* clipChunkMeshesToFootprintSteps(
  chunks: readonly ChunkMesh[],
  baseX: number,
  baseZ: number,
  tileSize: number,
): Generator<void, ChunkMesh[], void> {
  const result: ChunkMesh[] = [];
  for (const chunk of chunks) {
    const [clipped] = yield* partitionChunkMeshesSteps([chunk], baseX, baseZ, tileSize, 1);
    if (!clipped || clipped.positions.length === 0) continue;
    result.push({
      cy: chunk.cy,
      positions: clipped.positions,
      normals: clipped.normals,
      colors: clipped.colors,
      caveDepth: clipped.caveDepth,
    });
  }
  return result;
}

// Corner offsets of a cell, and its 12 edges as corner index pairs.
const CORNER = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
] as const;
const EDGE: readonly [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // x
  [0, 2], [1, 3], [4, 6], [5, 7], // y
  [0, 4], [1, 5], [2, 6], [3, 7], // z
];

/**
 * Whether any sample of a LOD1 tile contains a padded cave site. A
 * full-detail column must reuse its containing tile's decision, not
 * only its own 32m footprint: an installed LOD0 column masks that exact part
 * of the coarse fallback, and if the tile extended its band through the cave
 * layer while the column did not, the swap cuts a hole into pit walls the
 * tile had correctly meshed. Evaluating the identical 35x35 sample grid the
 * tile itself uses makes both decisions equal by construction. Memoized per
 * worker: all 16 columns of a tile share one scan.
 */
const tileEntrHotCache = new WeakMap<World, Map<string, boolean>>();
function* lod1TileEntrHotSteps(world: World, tx: number, tz: number): Generator<void, boolean, void> {
  let cache = tileEntrHotCache.get(world);
  if (!cache) {
    cache = new Map();
    tileEntrHotCache.set(world, cache);
  }
  const key = `${tx},${tz}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const tileW = N * LOD1_STEP;
  const baseX = tx * tileW;
  const baseZ = tz * tileW;
  let hot = false;
  outer:
  for (let iz = 0; iz < G; iz++) {
    for (let ix = 0; ix < G; ix++) {
      const c = world.column(
        baseX + (ix - 1) * LOD1_STEP,
        baseZ + (iz - 1) * LOD1_STEP,
      );
      if (c.cave !== undefined || c.entr > CAVE_SHAFT_BREACH_ENTR) {
        hot = true;
        break outer;
      }
      if ((ix & 7) === 7) yield;
    }
    yield;
  }
  cache.set(key, hot);
  return hot;
}

/** Mesh every non-empty terrain chunk in one column (32*step meters square). */
export function meshColumnChunks(
  world: World, cx: number, cz: number, caveDetail: boolean,
  step = 1,
): ChunkMesh[] {
  return finishMesh(meshColumnBundleSteps(world, cx, cz, caveDetail, step, false)).chunks;
}

/**
 * Worker path: mesh terrain and entrance caps from one shared column cache.
 * LOD2 intentionally returns no caps because its terrain is surface-only and
 * lies beyond the bounded cave-visibility system.
 */
export function meshColumnWithPortals(
  world: World, cx: number, cz: number, caveDetail: boolean,
  step = 1,
): ColumnMeshBundle {
  return finishMesh(meshColumnWithPortalsSteps(world, cx, cz, caveDetail, step));
}

/** Exact worker coroutine. Yielding never publishes a partial mesh, reorders
 * queries, or changes geometry. Individual cold world queries and typed-array
 * allocations are synchronous; the caller owns the time budget and rests. */
export function* meshColumnWithPortalsSteps(
  world: World, cx: number, cz: number, caveDetail: boolean, step = 1,
): Generator<void, ColumnMeshBundle, void> {
  return yield* meshColumnBundleSteps(world, cx, cz, caveDetail, step, step < LOD2_STEP);
}

function* meshColumnBundleSteps(
  world: World, cx: number, cz: number, caveDetail: boolean,
  step: number, includePortals: boolean,
): Generator<void, ColumnMeshBundle, void> {
  yield;
  const chunkW = N * step;
  const baseX = cx * chunkW;
  const baseZ = cz * chunkW;

  // Cache column (2D) data once for the whole footprint - the expensive
  // noise is 2D; the 3D part (caves) only runs near the surface band.
  const cols: ColumnData[] = new Array(G * G);
  let minH = Infinity, maxH = -Infinity, maxEntr = 0;
  let hasCaveSite = false;
  for (let iz = 0; iz < G; iz++) {
    for (let ix = 0; ix < G; ix++) {
      const c = world.column(baseX + (ix - 1) * step, baseZ + (iz - 1) * step);
      cols[iz * G + ix] = c;
      if (c.h < minH) minH = c.h;
      if (c.h > maxH) maxH = c.h;
      if (c.entr > maxEntr) maxEntr = c.entr;
      if (c.cave !== undefined) hasCaveSite = true;
      if ((ix & 7) === 7) yield;
    }
    yield;
  }
  const portals = includePortals
    ? meshEntrancePortalsFromColumns(cols, baseX, baseZ, step)
    : { positions: new Float32Array() };
  yield;
  let region = world.collectRegion(
    baseX - 2 * step, baseX + chunkW + 2 * step,
    baseZ - 2 * step, baseZ + chunkW + 2 * step,
    false,
  );
  yield;
  // Exact structure plinths own their top and sides. Mask the sampled
  // terrain precisely at that footprint, so coarse foundation triangles
  // cannot flash through a floor only centimetres above the analytic pad.
  const foundations = (region.foundations ?? []).filter((box) =>
    box.x + box.hx >= baseX - step && box.x - box.hx <= baseX + chunkW + step &&
    box.z + box.hz >= baseZ - step && box.z - box.hz <= baseZ + chunkW + step);
  // Vegetation, boulders and structure solids have exact, camera-local instance
  // renderers. Feeding them through a voxel lattice is slower and can omit a
  // collider whose box/stem falls between samples, especially at step 4.
  // Foundation fields reshape the ground before exact plinth faces replace it.
  region = {
    ...region,
    solids: [],
    capitalSegments: [],
    transportBridges: undefined,
    capitalArea: false,
    cuts: [],
    vegetation: [],
    boulders: [],
  };

  let lo = minH - 3;
  let hi = maxH + 3;
  for (const b of region.boulders) hi = Math.max(hi, b.y + b.hy + 1.5);
  for (const p of region.pads) lo = Math.min(lo, p.y - p.hy - 1.5);
  // Cave entrances cut pits below the local surface even far from the player.
  // Any full-detail column that can breach meshes the whole cave band - a
  // partially meshed pit reads as see-through holes in its walls and floor.
  // All resolutions sample the canonical cave field. Entrance columns always
  // include its vertical band; caveDetail additionally keeps sealed cave
  // interiors around an underground camera at both full and mid detail.
  // The band extends whenever the shaft field could possibly open air, not
  // only above the nominal entrance threshold: shaft flare/noise breach the
  // crust down to CAVE_SHAFT_BREACH_ENTR, and a rim column meshed as a bare
  // surface band used to read as a mid-distance see-through hole in the
  // ground. LOD2 remains a surface-only horizon mesh: one entrance somewhere
  // in a 512m footprint must not force its entire -512..0 vertical cave slab
  // to be generated - its pits are sealed by the band floor cap below.
  // Bounded step-4 caves extend behind an opaque underground fog horizon.
  const pits = step < LOD2_STEP && (
    hasCaveSite || maxEntr > CAVE_SHAFT_BREACH_ENTR ||
    (step === 1 && (yield* lod1TileEntrHotSteps(
      world, Math.floor(cx / LOD1_STEP), Math.floor(cz / LOD1_STEP),
    )))
  );
  if (pits || caveDetail) lo = Math.min(lo, WORLD.MIN_CAVE_Y - 2);

  // Cave-band units end at their footprint, but the network they mesh keeps
  // going: a sightline down a pit can travel hundreds of meters through
  // connected tunnels and exit wherever cave slabs are legitimately absent -
  // a quiet neighbor, or past the LOD1 ring where only surface LOD2 exists.
  // Which neighbors are meshed also depends on the camera, so no field-only
  // neighbor test can seal every case. Instead every cave-band unit is made
  // self-contained: below the locally visible ground, the field is forced
  // solid at LOD1-tile boundaries, so surface nets closes each tunnel mouth
  // with a dark curtain wall. Open pit bowls stay clean - the wall top hugs
  // the sky-visible ground - and near-camera detail columns (caveDetail)
  // never curtain, so a player at an entrance still sees true cave geometry
  // out to the cave-detail radius while farther tunnel mouths fade into
  // rock-dark walls. Underground cameras render caveDetail bands behind an
  // opaque cave fog and never meet a curtain either.
  // Boundary samples are sealed along with true ghosts: edges between the
  // two outermost samples belong to the neighboring unit's owned region, so
  // a wall carried only by the ghost sample would never be emitted. Sealing
  // the boundary sample as well moves the sign change into this unit's owned
  // interior cells, where it survives the exact footprint clip. The probe
  // point looks one half-meter past the plane so a boundary sample tests the
  // tile it faces, not the tile that happens to contain its own coordinates.
  const tileW = N * LOD1_STEP;
  const ownTx = Math.floor(baseX / tileW);
  const ownTz = Math.floor(baseZ / tileW);
  // Everything below the locally sky-visible ground gets sealed solid at a
  // flagged column, but never closer to the surface than the guaranteed
  // crust. groundY only leaves the heightfield where the shaft can breach,
  // so the trace is skipped for the overwhelming majority of samples.
  const sealBelow = new Float32Array(G * G).fill(Infinity);
  let minSeal = Infinity;
  const sealLevel = (colData: ColumnData, wx: number, wz: number): number =>
    Math.min(
      colData.h - CAVE_MIN_ROOF,
      (colData.entr > CAVE_SHAFT_BREACH_ENTR
        ? world.groundY(wx, wz)
        : colData.h) - 0.6,
    );
  if (!caveDetail && (step >= LOD2_STEP || (!hasCaveSite && maxEntr <= CAVE_SHAFT_BREACH_ENTR))) {
    // Far terrain renders no cave slabs at all, so its whole sub-crust
    // volume is sealed: entrance pits floor out exactly at their visible
    // ground, and a sightline that went underground through nearer real
    // caves can never continue beneath the far-terrain blanket to the sky.
    // Quiet surface-only leaves likewise need no hidden cave roofs. On a
    // steep face their thin crust can occupy less than one coarse voxel,
    // letting the surface nets connect air above and below into tiny holes.
    // Explicit entrances and requested underground detail retain real caves.
    for (let iz = 0; iz < G; iz++) {
      for (let ix = 0; ix < G; ix++) {
        const wx = baseX + (ix - 1) * step;
        const wz = baseZ + (iz - 1) * step;
        const seal = sealLevel(cols[iz * G + ix], wx, wz);
        sealBelow[iz * G + ix] = seal;
        if (seal < minSeal) minSeal = seal;
        if ((ix & 7) === 7) yield;
      }
      yield;
    }
  } else if (pits && !caveDetail) {
    for (let iz = 0; iz < G; iz++) {
      for (let ix = 0; ix < G; ix++) {
        const wx = baseX + (ix - 1) * step;
        const wz = baseZ + (iz - 1) * step;
        const west = wx <= baseX;
        const east = wx >= baseX + chunkW;
        const north = wz <= baseZ;
        const south = wz >= baseZ + chunkW;
        if (!west && !east && !north && !south) continue;
        const px = west ? Math.min(wx, baseX - 0.5)
          : east ? Math.max(wx, baseX + chunkW + 0.5) : wx;
        const pz = north ? Math.min(wz, baseZ - 0.5)
          : south ? Math.max(wz, baseZ + chunkW + 0.5) : wz;
        if (Math.floor(px / tileW) === ownTx &&
            Math.floor(pz / tileW) === ownTz) continue;
        const seal = sealLevel(cols[iz * G + ix], wx, wz);
        sealBelow[iz * G + ix] = seal;
        if (seal < minSeal) minSeal = seal;
      }
      yield;
    }
  }
  // The band must reach below the deepest seal: carved entrance basins put
  // the real visible ground well under the heightfield-derived band bottom,
  // and a seal plane outside the sampled band would emit no floor or wall
  // faces at all - a raised clamp once turned an entire far basin into a
  // faceless solid the camera could slip beneath.
  if (minSeal < lo) lo = minSeal - 2;
  for (let i = 0; i < sealBelow.length; i++) {
    if (sealBelow[i] === Infinity) sealBelow[i] = lo;
  }
  // Border wall towers over the terrain.
  const maxAbs = Math.max(Math.abs(baseX), Math.abs(baseX + chunkW), Math.abs(baseZ), Math.abs(baseZ + chunkW));
  if (maxAbs > WORLD.BORDER - chunkW) hi = Math.max(hi, WORLD.MAX_HEIGHT - 20);

  const out: ChunkMesh[] = [];
  const chunkH = N * step;
  const cy0 = Math.floor(lo / chunkH);
  const cy1 = Math.floor(hi / chunkH);
  for (let cy = cy0; cy <= cy1; cy++) {
    yield;
    const mesh = yield* meshChunkSteps(world, cols, region, cx, cy, cz, step, sealBelow);
    if (mesh) out.push(mesh);
  }
  // Coarse clipping is intentionally done in this worker-side path. The
  // render thread receives packed, part-ordered buffers and never performs a
  // large triangle-clipping pass when a streamed tile completes.
  yield;
  const authoredCapture = yield* captureAuthoredSeamsSteps(out, foundations,
    { cx, cz, step, bandFloor: cy0 * chunkH, sealBelow }, partitionChunkMeshesSteps);
  const clippedTerrain = yield* clipTerrainFoundationsSteps(out, foundations);
  const ownedTerrain = yield* appendFoundationMeshesSteps(clippedTerrain, foundations, world, step);
  const chunks = step === 1
    ? yield* clipChunkMeshesToFootprintSteps(ownedTerrain, baseX, baseZ, chunkW)
    : yield* partitionChunkMeshesSteps(ownedTerrain, baseX, baseZ, chunkW, step);
  const authoredSeams = yield* finishAuthoredSeamsSteps(authoredCapture, chunks);
  return { chunks, portals, authoredSeams };
}

function* meshChunkSteps(
  world: World, cols: ColumnData[], region: Region,
  cx: number, cy: number, cz: number, step: number,
  sealBelow: Float32Array,
): Generator<void, ChunkMesh | null, void> {
  const chunkW = N * step;
  const baseX = cx * chunkW, baseY = cy * chunkW, baseZ = cz * chunkW;
  // The pad field supports a small earthen shoulder outside the plinth.
  // Its old concrete proximity mask colored alternating whole terrain
  // triangles before footprint clipping, leaving a pale sawtooth fringe.
  // Concrete belongs exclusively to the analytic foundation faces below.
  const materialRegion = region.pads.length ? { ...region, pads: [] } : region;

  // --- Sample the field ---------------------------------------------------
  // The meshed field is the canonical one unioned with a per-column solid
  // half-space: the band floor everywhere, raised to the boundary curtain
  // level on sealed ghost/boundary columns. A bare vertical clip is not
  // enough - caves and shaft flare can cross the band bottom, and their
  // clipped air columns used to render as open tubes with the sky visible
  // through the ground. The seal turns every such cut into closed dark rock.
  // Columns that mesh the whole cave layer keep their floor at
  // MIN_CAVE_Y - 2, below the deepest generated cave, so sealing never
  // alters their real geometry.
  const d = new Float32Array(G * G * G); // index: (iy*G + iz)*G + ix
  let minD = Infinity, maxD = -Infinity;
  for (let iz = 0; iz < G; iz++) {
    for (let ix = 0; ix < G; ix++) {
      const col = cols[iz * G + ix];
      const wx = baseX + (ix - 1) * step;
      const wz = baseZ + (iz - 1) * step;
      const seal = sealBelow[iz * G + ix];
      for (let iy = 0; iy < G; iy++) {
        const wy = baseY + (iy - 1) * step;
        let v = world.sdfCol(wx, wy, wz, col, region);
        const cap = wy - seal;
        if (cap < v) v = cap;
        d[(iy * G + iz) * G + ix] = v;
        if (v < minD) minD = v;
        if (v > maxD) maxD = v;
      }
    }
    yield;
  }
  if (minD > 0 || maxD < 0) return null; // fully empty / fully solid

  /** Bilinear column data at a world XZ inside this footprint. */
  const colAt = (wx: number, wz: number): ColumnData & { caveExposure: number } => {
    let fx = (wx - baseX) / step + 1;
    let fz = (wz - baseZ) / step + 1;
    if (fx < 0) fx = 0; else if (fx > G - 1.001) fx = G - 1.001;
    if (fz < 0) fz = 0; else if (fz > G - 1.001) fz = G - 1.001;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const tx = fx - x0, tz = fz - z0;
    const c00 = cols[z0 * G + x0], c10 = cols[z0 * G + x0 + 1];
    const c01 = cols[(z0 + 1) * G + x0], c11 = cols[(z0 + 1) * G + x0 + 1];
    const bl = (a: number, b: number, c: number, dd: number): number => {
      const top = a + (b - a) * tx;
      const bot = c + (dd - c) * tx;
      return top + (bot - top) * tz;
    };
    const mouth = bl(c00.cave?.mouth ?? -10, c10.cave?.mouth ?? -10,
      c01.cave?.mouth ?? -10, c11.cave?.mouth ?? -10);
    const exposure = Math.max(0, Math.min(1, (mouth + 8) / 10));
    return {
      h: bl(c00.h, c10.h, c01.h, c11.h),
      city: (tz < .5 ? tx < .5 ? c00 : c10 : tx < .5 ? c01 : c11).city,
      rainforest: bl(c00.rainforest ?? 0, c10.rainforest ?? 0, c01.rainforest ?? 0, c11.rainforest ?? 0),
      temp: bl(c00.temp, c10.temp, c01.temp, c11.temp),
      moist: bl(c00.moist, c10.moist, c01.moist, c11.moist),
      desert: bl(c00.desert, c10.desert, c01.desert, c11.desert),
      entr: bl(c00.entr, c10.entr, c01.entr, c11.entr),
      entrRaw: bl(c00.entrRaw, c10.entrRaw, c01.entrRaw, c11.entrRaw),
      volc: bl(c00.volc, c10.volc, c01.volc, c11.volc),
      // The -1000 no-lava sentinel interpolates into nonsense at pool
      // shores; material() defends with a band test around lavaY.
      lavaY: bl(c00.lavaY, c10.lavaY, c01.lavaY, c11.lavaY),
      // This is the canonical open-mouth field, not terrain height: the
      // graded exterior apron can sit well below the nominal envelope.
      caveExposure: 1 - exposure * exposure * (3 - 2 * exposure),
    };
  };
  // Projection is an agreement boundary with physics, so evaluate fresh
  // analytic column data rather than the bilinear color/biome approximation.
  // It must include the band-floor cap and boundary curtains, or vertices on
  // those sealing planes would be projected onto the unsealed isosurface.
  const fieldAt = (wx: number, wy: number, wz: number): number => {
    const v = world.sdfCol(wx, wy, wz, world.column(wx, wz), region);
    const sx = Math.min(G - 1, Math.max(0, Math.round((wx - baseX) / step) + 1));
    const sz = Math.min(G - 1, Math.max(0, Math.round((wz - baseZ) / step) + 1));
    const cap = wy - sealBelow[sz * G + sx];
    return cap < v ? cap : v;
  };

  // --- Surface-nets vertices ---------------------------------------------
  const vertIdx = new Int32Array(CELLS * CELLS * CELLS).fill(-1);
  const verts: number[] = [];
  const fieldNormals: number[] = [];
  const cd = new Float64Array(8);

  for (let iy = 0; iy < CELLS; iy++) {
    for (let iz = 0; iz < CELLS; iz++) {
      for (let ix = 0; ix < CELLS; ix++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const [ox, oy, oz] = CORNER[c];
          const v = d[((iy + oy) * G + (iz + oz)) * G + (ix + ox)];
          cd[c] = v;
          if (v < 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 0xff) continue;

        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [a, b] of EDGE) {
          const da = cd[a], db = cd[b];
          if ((da < 0) === (db < 0)) continue;
          const t = da / (da - db);
          sx += CORNER[a][0] + (CORNER[b][0] - CORNER[a][0]) * t;
          sy += CORNER[a][1] + (CORNER[b][1] - CORNER[a][1]) * t;
          sz += CORNER[a][2] + (CORNER[b][2] - CORNER[a][2]) * t;
          cnt++;
        }
        const inv = 1 / cnt;
        let vx = baseX + (ix - 1 + sx * inv) * step;
        let vy = baseY + (iy - 1 + sy * inv) * step;
        let vz = baseZ + (iz - 1 + sz * inv) * step;

        // Newton-project the vertex onto the isosurface along the cell's
        // field gradient. The plain crossing average rounds sharp creases
        // (cliff/canyon rims) up to half a voxel inward, which reads as
        // "standing on air" at ledges - the collision field keeps the full
        // edge. Border cells are shared with the neighbor column and use
        // identical samples/clamps, so seams stay watertight.
        // Corner face-differences approximate 4*step*grad(d), so the Newton
        // displacement for value v is v * 4 * step / |g| along -g (the field
        // is not unit-gradient: cave carve slopes are ~3x steeper).
        let gx = (cd[1] + cd[3] + cd[5] + cd[7]) - (cd[0] + cd[2] + cd[4] + cd[6]);
        let gy = (cd[2] + cd[3] + cd[6] + cd[7]) - (cd[0] + cd[1] + cd[4] + cd[5]);
        let gz = (cd[4] + cd[5] + cd[6] + cd[7]) - (cd[0] + cd[1] + cd[2] + cd[3]);
        const gl = Math.sqrt(gx * gx + gy * gy + gz * gz);
        if (gl > 1e-9) {
          gx /= gl; gy /= gl; gz /= gl;
          const scale = (4 * step) / gl;
          const lim = 0.6 * step;
          for (let it = 0; it < 2; it++) {
            const v = fieldAt(vx, vy, vz);
            if (Math.abs(v) < 0.02 * step) break;
            let m = Math.max(-lim, Math.min(lim, v * scale * 0.9));
            if (step > 1) {
              // A 4m cell can span both the steep cave seal and its flat
              // heightfield. Its average gradient then underestimates the
              // local slope, and two unchecked Newton steps oscillate from
              // cave air into rock. Backtracking keeps every coarse move an
              // improvement without adding evaluations to full-detail tiles.
              let improved = false;
              for (let trial = 0; trial < 4; trial++) {
                if (Math.abs(fieldAt(vx - gx * m, vy - gy * m, vz - gz * m)) < Math.abs(v)) {
                  improved = true;
                  break;
                }
                m *= 0.5;
              }
              if (!improved) break;
            }
            vx -= gx * m; vy -= gy * m; vz -= gz * m;
          }
          // Keep the vertex inside its cell so quads stay well-formed.
          const cx0 = baseX + (ix - 1) * step, cy0 = baseY + (iy - 1) * step, cz0 = baseZ + (iz - 1) * step;
          if (vx < cx0) vx = cx0; else if (vx > cx0 + step) vx = cx0 + step;
          if (vy < cy0) vy = cy0; else if (vy > cy0 + step) vy = cy0 + step;
          if (vz < cz0) vz = cz0; else if (vz > cz0 + step) vz = cz0 + step;
        }

        vertIdx[(iy * CELLS + iz) * CELLS + ix] = verts.length / 3;
        verts.push(vx, vy, vz);
        fieldNormals.push(gx, gy, gz);
      }
      yield;
    }
  }
  if (verts.length === 0) return null;

  // --- Quads across sign-changing edges ----------------------------------
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];
  const caveDepth: number[] = [];
  const rgbTmp: number[] = [0, 0, 0];

  const vidx = (ix: number, iy: number, iz: number): number =>
    vertIdx[(iy * CELLS + iz) * CELLS + ix];

  const pushTri = (i1: number, i2: number, i3: number): void => {
    const ax = verts[i1 * 3], ay = verts[i1 * 3 + 1], az = verts[i1 * 3 + 2];
    const bx = verts[i2 * 3], by = verts[i2 * 3 + 1], bz = verts[i2 * 3 + 2];
    const cxx = verts[i3 * 3], cyy = verts[i3 * 3 + 1], czz = verts[i3 * 3 + 2];
    // Flat normal from the winding.
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cxx - ax, vy = cyy - ay, vz = czz - az;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (nl < 1e-12) return;
    nx /= nl; ny /= nl; nz /= nl;

    positions.push(ax, ay, az, bx, by, bz, cxx, cyy, czz);

    // One color per face, sampled at the centroid.
    const mx = (ax + bx + cxx) / 3, my = (ay + by + cyy) / 3, mz = (az + bz + czz) / 3;
    const col = colAt(mx, mz);
    const depth = Math.round(Math.min(63.75, Math.max(0, col.h - my)) * col.caveExposure * 4);
    caveDepth.push(depth, depth, depth);
    // Tiny triangles at a rounded cave roof can tilt toward the sun even
    // when the implicit ceiling faces down. Blend their shading toward the
    // already-sampled field gradients; no extra noise calls or GPU data.
    // Exterior terrain and boulders retain their original faceted normals.
    let sx = nx, sy = ny, sz = nz;
    const caveShade = Math.min(1, Math.max(0, (depth / 4 - 2) / 6)) * 0.7;
    if (caveShade > 0) {
      const gx = fieldNormals[i1 * 3] + fieldNormals[i2 * 3] + fieldNormals[i3 * 3];
      const gy = fieldNormals[i1 * 3 + 1] + fieldNormals[i2 * 3 + 1] + fieldNormals[i3 * 3 + 1];
      const gz = fieldNormals[i1 * 3 + 2] + fieldNormals[i2 * 3 + 2] + fieldNormals[i3 * 3 + 2];
      const gl = Math.hypot(gx, gy, gz);
      if (gl > 1e-9) {
        sx = nx * (1 - caveShade) + gx / gl * caveShade;
        sy = ny * (1 - caveShade) + gy / gl * caveShade;
        sz = nz * (1 - caveShade) + gz / gl * caveShade;
        const sl = Math.hypot(sx, sy, sz);
        if (sl > 1e-9) { sx /= sl; sy /= sl; sz /= sl; }
        else { sx = nx; sy = ny; sz = nz; }
      }
    }
    normals.push(sx, sy, sz, sx, sy, sz, sx, sy, sz);
    const mat: MatId = world.material(mx, my, mz, col, ny, materialRegion, false);
    world.vertexColor(mat, mx, my, mz, col, rgbTmp, 0, ny, false);
    const r = Math.round(rgbTmp[0] * 255), g = Math.round(rgbTmp[1] * 255), b = Math.round(rgbTmp[2] * 255);
    colors.push(r, g, b, r, g, b, r, g, b);
  };

  const emitQuad = (i1: number, i2: number, i3: number, i4: number, flip: boolean): void => {
    if (i1 < 0 || i2 < 0 || i3 < 0 || i4 < 0) return;
    if (flip) {
      pushTri(i1, i4, i3);
      pushTri(i1, i3, i2);
    } else {
      pushTri(i1, i2, i3);
      pushTri(i1, i3, i4);
    }
  };

  // Edges are "owned" by this chunk when their low sample sits in local
  // cells [0, 32) - neighbors own the rest, so nothing is duplicated.
  // X-edges: samples (ix,iy,iz)-(ix+1,iy,iz), ix in [1,32]; cells around it.
  for (let iy = 1; iy <= CELLS - 1; iy++) {
    for (let iz = 1; iz <= CELLS - 1; iz++) {
      for (let ix = 1; ix <= N; ix++) {
        const d0 = d[(iy * G + iz) * G + ix];
        const d1 = d[(iy * G + iz) * G + ix + 1];
        if ((d0 < 0) === (d1 < 0)) continue;
        // air at lower x => normal -x with this ordering
        emitQuad(
          vidx(ix, iy - 1, iz - 1),
          vidx(ix, iy - 1, iz),
          vidx(ix, iy, iz),
          vidx(ix, iy, iz - 1),
          d0 < 0,
        );
      }
      yield;
    }
  }
  // Y-edges.
  for (let iy = 1; iy <= N; iy++) {
    for (let iz = 1; iz <= CELLS - 1; iz++) {
      for (let ix = 1; ix <= CELLS - 1; ix++) {
        const d0 = d[(iy * G + iz) * G + ix];
        const d1 = d[((iy + 1) * G + iz) * G + ix];
        if ((d0 < 0) === (d1 < 0)) continue;
        // air at lower y => normal -y with this ordering
        emitQuad(
          vidx(ix - 1, iy, iz - 1),
          vidx(ix, iy, iz - 1),
          vidx(ix, iy, iz),
          vidx(ix - 1, iy, iz),
          d0 < 0,
        );
      }
      yield;
    }
  }
  // Z-edges.
  for (let iy = 1; iy <= CELLS - 1; iy++) {
    for (let iz = 1; iz <= N; iz++) {
      for (let ix = 1; ix <= CELLS - 1; ix++) {
        const d0 = d[(iy * G + iz) * G + ix];
        const d1 = d[(iy * G + (iz + 1)) * G + ix];
        if ((d0 < 0) === (d1 < 0)) continue;
        // air at lower z => normal -z with this ordering
        emitQuad(
          vidx(ix - 1, iy - 1, iz),
          vidx(ix - 1, iy, iz),
          vidx(ix, iy, iz),
          vidx(ix, iy - 1, iz),
          d0 < 0,
        );
      }
      yield;
    }
  }

  if (positions.length === 0) return null;
  return {
    cy,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    colors: new Uint8Array(colors),
    caveDepth: new Uint8Array(caveDepth),
  };
}
