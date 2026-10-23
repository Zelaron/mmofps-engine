import type { ChunkMesh } from './surfacenets.js';
import { meshBoundary, type BoundaryMesh, type BoundaryPlane, type BoundaryPoint, type BoundarySegment } from './terrain-seams.js';
import { unionFoundationBoundary, type FoundationSection, type RenderedBoundarySegment } from './terrain-foundation-union.js';
import { AUTHORED_SEAM_LIMITS as LIMIT, authoredSeamPlane, packAuthoredSeams,
  type AuthoredSeamPatch, type AuthoredSeamPayload } from './terrain-authored-seams.js';

interface Foundation { x: number; y: number; z: number; hx: number; hy: number; hz: number }
interface Column { cx: number; cz: number; step: number; bandFloor: number; sealBelow: Float32Array }
type Partition = (chunks: readonly ChunkMesh[], x: number, z: number, width: number, grid: number) => Generator<void, ChunkMesh[], void>;
interface Edge {
  x: number; z: number; side: number; plane: BoundaryPlane; boxes: FoundationSection[];
  terrain?: BoundarySegment[];
  p: number[]; n: number[]; c: number[]; d: number[];
}
export interface AuthoredCapture {
  column: Column; edges: Edge[]; belowSolid: boolean; unavailable: boolean;
  stats: { foundationCount: number; enumeratedEdges: number; keptEdges: number; comparisons: number;
    /** Logical retained data estimate; not a JS heap/partition-temporary limit. */
    scratchPeak: number; proofPeakEntries: number; payloadBytes: number;
    preclipSegments: number; outputSegments: number; provedEdges: number; omittedEdges: number;
    omissionReasons: Record<string, number>; reason?: string };
}
function omit(capture: AuthoredCapture, reason: string): AuthoredCapture {
  capture.unavailable = true; capture.stats.reason = reason;
  capture.edges.length = 0;
  return capture;
}
/** Boundary capture shares the existing worker generator. It keeps only
 * triangles touching requested ownership planes, never a second whole tile. */
export function* captureAuthoredSeamsSteps(chunks: readonly ChunkMesh[], foundations: readonly Foundation[],
  column: Column, partition: Partition): Generator<void, AuthoredCapture | undefined, void> {
  if (!foundations.length) return undefined;
  const capture: AuthoredCapture = { column, edges: [], belowSolid: false, unavailable: false,
    stats: { foundationCount: foundations.length, enumeratedEdges: 0, keptEdges: 0, comparisons: 0,
      scratchPeak: 0, proofPeakEntries: 0, payloadBytes: 0,
      preclipSegments: 0, outputSegments: 0, provedEdges: 0, omittedEdges: 0, omissionReasons: {} } };
  // The actual mesh sampler unions its field with y-sealBelow at EVERY
  // column. Its generated band begins no higher than the lowest such seal.
  // This is the source of the lower-solid datum, not an assumed odd count.
  capture.belowSolid = Number.isFinite(column.bandFloor) && column.sealBelow.length > 0;
  for (const seal of column.sealBelow)
    if (!Number.isFinite(seal) || column.bandFloor > seal) capture.belowSolid = false;
  if (!capture.belowSolid) return omit(capture, 'unproved band-floor solid datum');
  const x0 = column.cx * column.step, z0 = column.cz * column.step;
  const x1 = x0 + column.step, z1 = z0 + column.step;
  const edges = new Map<string, Edge>();
  let enumeration = 0;
  const add = (x: number, z: number, side: number) => {
    if (x < x0 || x >= x1 || z < z0 || z >= z1) return;
    if (![x, z].every(n => Number.isInteger(n) && n >= -2147483648 && n <= 2147483647)) return;
    const key = `${x},${z},${side}`;
    if (!edges.has(key)) edges.set(key, { x, z, side, plane: authoredSeamPlane(x, z, side), boxes: [], p: [], n: [], c: [], d: [] });
  };
  // Enumeration is bounded by the tile's actual32m grid, including both
  // one-sided records for an internal ownership plane. No World queries.
  for (const f of foundations) {
    if (++enumeration > 8192) return omit(capture, 'foundation enumeration budget');
    if (![f.x, f.y, f.z, f.hx, f.hy, f.hz].every(Number.isFinite) || f.hx <= 0 || f.hy <= 0 || f.hz <= 0)
      return omit(capture, 'invalid explicit foundation');
    const loX = Math.fround(f.x - f.hx), hiX = Math.fround(f.x + f.hx);
    const loZ = Math.fround(f.z - f.hz), hiZ = Math.fround(f.z + f.hz);
    for (let gx = Math.max(x0, Math.ceil(loX / 32)); gx <= Math.min(x1, Math.floor(hiX / 32)); gx++) {
      for (let z = Math.max(z0, Math.floor(loZ / 32)); z < Math.min(z1, Math.ceil(hiZ / 32)); z++) {
        if (++enumeration > 8192) return omit(capture, 'foundation edge enumeration budget');
        add(gx - 1, z, 1); add(gx, z, 0);
      }
    }
    for (let gz = Math.max(z0, Math.ceil(loZ / 32)); gz <= Math.min(z1, Math.floor(hiZ / 32)); gz++) {
      for (let x = Math.max(x0, Math.floor(loX / 32)); x < Math.min(x1, Math.ceil(hiX / 32)); x++) {
        if (++enumeration > 8192) return omit(capture, 'foundation edge enumeration budget');
        add(x, gz - 1, 3); add(x, gz, 2);
      }
    }
    yield;
  }
  capture.stats.enumeratedEdges = edges.size;
  // Do not truncate an enumeration and accidentally call its box list complete.
  if (edges.size > LIMIT.edges) return omit(capture, 'column edge-record cap');
  for (const edge of edges.values()) {
    for (let i = 0; i < foundations.length; i++) {
      const f = foundations[i], p = edge.plane, ax = p.axis === 'x' ? f.x : f.z, ah = p.axis === 'x' ? f.hx : f.hz;
      if (p.boundary < Math.fround(ax - ah) || p.boundary > Math.fround(ax + ah)) continue;
      const u = p.axis === 'x' ? f.z : f.x, h = p.axis === 'x' ? f.hz : f.hx;
      const lo = Math.max(p.lo, Math.fround(u - h)), hi = Math.min(p.hi, Math.fround(u + h));
      if (hi <= lo) continue;
      edge.boxes.push({ id: String(i), lo, hi, bottom: Math.fround(f.y - f.hy), top: Math.fround(f.y + f.hy) });
      if (edge.boxes.length > LIMIT.boxesPerEdge) return omit(capture, 'edge box cap');
    }
    if (edge.boxes.length) capture.edges.push(edge);
    yield;
  }
  capture.stats.keptEdges = capture.edges.length;
  let scratch = 0, triangles = 0;
  for (const mesh of chunks) for (let i = 0; i < mesh.positions.length; i += 9) {
    if ((triangles++ & 63) === 0) yield;
    const p = mesh.positions;
    const minX = Math.min(p[i], p[i + 3], p[i + 6]), maxX = Math.max(p[i], p[i + 3], p[i + 6]);
    const minZ = Math.min(p[i + 2], p[i + 5], p[i + 8]), maxZ = Math.max(p[i + 2], p[i + 5], p[i + 8]);
    for (const edge of capture.edges) {
      if (++capture.stats.comparisons > LIMIT.triangleComparisons) return omit(capture, 'column triangle-comparison cap');
      const plane = edge.plane;
      if (plane.axis === 'x' ? minX > plane.boundary || maxX < plane.boundary || minZ > plane.hi || maxZ < plane.lo
        : minZ > plane.boundary || maxZ < plane.boundary || minX > plane.hi || maxX < plane.lo) continue;
      // JS number scratch plus its eventual typed copy are both charged.
      scratch += 30 * 8 + 84;
      if (scratch > LIMIT.scratchBytes) return omit(capture, 'column retained scratch cap');
      capture.stats.scratchPeak = Math.max(capture.stats.scratchPeak, scratch);
      for (let j = i; j < i + 9; j++) { edge.p.push(p[j]); edge.n.push(mesh.normals[j]); edge.c.push(mesh.colors[j]); }
      for (let j = i / 3; j < i / 3 + 3; j++) edge.d.push(mesh.caveDepth?.[j] ?? 0);
    }
  }
  for (const edge of capture.edges) {
    yield;
    const raw: ChunkMesh = { cy: 0, positions: new Float32Array(edge.p), normals: new Float32Array(edge.n),
      colors: new Uint8Array(edge.c), caveDepth: new Uint8Array(edge.d) };
    const clipped = yield* partition([raw], edge.x * 32, edge.z * 32, 32, 1);
    edge.terrain = meshBoundary(clipped, edge.plane);
    scratch -= edge.p.length / 9 * (30 * 8 + 84);
    scratch += edge.terrain.length * 256; // Conservative retained JS point/segment allowance.
    edge.p.length = edge.n.length = edge.c.length = edge.d.length = 0;
    capture.stats.preclipSegments += edge.terrain.length;
    capture.stats.scratchPeak = Math.max(capture.stats.scratchPeak, scratch);
    if (scratch > LIMIT.scratchBytes) return omit(capture, 'column contour scratch cap');
  }
  return capture;
}

const mix = (a: BoundaryPoint, b: BoundaryPoint, t: number): BoundaryPoint => ({
  u: a.u + (b.u - a.u) * t, y: a.y + (b.y - a.y) * t,
  r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t,
  b: a.b + (b.b - a.b) * t, depth: a.depth + (b.depth - a.depth) * t,
});
/** Preserve canonical edge cancellation/order; attach proof from an original
 * retained triangle in the surviving edge direction, never shading normals. */
export function* orientedBoundarySteps(meshes: readonly BoundaryMesh[], plane: BoundaryPlane,
  budget: { reason?: string; proofEntries?: number } = {}): Generator<void, {
  contours: BoundarySegment[]; oriented: RenderedBoundarySegment[];
} | undefined, void> {
  const axis = plane.axis === 'x' ? 0 : 2, other = 2 - axis;
  const proof = new Map<string, { count: number; positive: number[]; negative: number[] }>();
  let triangles = 0;
  for (const mesh of meshes) for (let i = 0; i < mesh.positions.length; i += 9) {
    if ((triangles++ & 63) === 0) yield;
    if (triangles > 8192) { budget.reason = 'edge triangle cap'; return undefined; }
    const p = mesh.positions, normalY = (p[i + 5] - p[i + 2]) * (p[i + 6] - p[i]) - (p[i + 3] - p[i]) * (p[i + 8] - p[i + 2]);
    const point = (j: number): BoundaryPoint => ({ u: p[j + other], y: p[j + 1], r: mesh.colors?.[j] ?? 128,
      g: mesh.colors?.[j + 1] ?? 128, b: mesh.colors?.[j + 2] ?? 128, depth: mesh.caveDepth?.[j / 3] ?? 0 });
    for (let e = 0; e < 3; e++) {
      const ia = i + e * 3, ib = i + (e + 1) % 3 * 3;
      if (p[ia + axis] !== plane.boundary || p[ib + axis] !== plane.boundary) continue;
      let a = point(ia), b = point(ib), direction = 1;
      if (a.u > b.u || a.u === b.u && a.y > b.y) { [a, b] = [b, a]; direction = -1; }
      if (b.u < plane.lo || a.u > plane.hi) continue;
      if (a.u !== b.u) {
        const aa = a, bb = b;
        if (a.u < plane.lo) a = mix(aa, bb, (plane.lo - aa.u) / (bb.u - aa.u));
        if (b.u > plane.hi) b = mix(aa, bb, (plane.hi - aa.u) / (bb.u - aa.u));
        a.u = Math.max(plane.lo, a.u); b.u = Math.min(plane.hi, b.u);
      }
      if (a.u === b.u && a.y === b.y) continue;
      const key = `${a.u},${a.y}/${b.u},${b.y}`;
      let entry = proof.get(key);
      if (!entry) {
        if (proof.size >= LIMIT.proofEntries) { budget.reason = 'edge orientation-map cap'; return undefined; }
        entry = { count: 0, positive: [], negative: [] }; proof.set(key, entry);
        budget.proofEntries = proof.size;
      }
      entry.count += direction;
      const list = direction > 0 ? entry.positive : entry.negative;
      if (!list.some(n => Math.sign(n) === Math.sign(normalY))) list.push(normalY);
    }
  }
  const contours = meshBoundary(meshes, plane), oriented: RenderedBoundarySegment[] = [];
  if (contours.length > 512) { budget.reason = 'edge final-contour cap'; return undefined; }
  for (const s of contours) {
    if (s.a.u === s.b.u) continue;
    const entry = proof.get(`${s.a.u},${s.a.y}/${s.b.u},${s.b.y}`);
    if (!entry || !entry.count) { budget.reason = 'missing surviving face orientation'; return undefined; }
    for (const normalY of entry.count > 0 ? entry.positive : entry.negative) oriented.push({ ...s, normalY });
  }
  return { contours, oriented };
}
function leafMeshes(chunks: readonly ChunkMesh[], capture: AuthoredCapture, edge: Edge): BoundaryMesh[] {
  const { cx, cz, step } = capture.column;
  if (step === 1) return [...chunks];
  const part = (edge.z - cz * step) * step + edge.x - cx * step;
  return chunks.map(c => {
    const lo = c.partOffsets![part], hi = c.partOffsets![part + 1];
    return { positions: c.positions.subarray(lo, hi), colors: c.colors.subarray(lo, hi), caveDepth: c.caveDepth?.subarray(lo / 3, hi / 3) };
  });
}
export function* finishAuthoredSeamsSteps(capture: AuthoredCapture | undefined, chunks: readonly ChunkMesh[]): Generator<void, AuthoredSeamPayload | undefined, void> {
  if (!capture || capture.unavailable || !capture.belowSolid) return undefined;
  const patches: AuthoredSeamPatch[] = [];
  const omitted = (reason: string) => {
    capture.stats.omittedEdges++;
    capture.stats.omissionReasons[reason] = (capture.stats.omissionReasons[reason] ?? 0) + 1;
  };
  for (const edge of capture.edges) {
    yield;
    const budget: { reason?: string; proofEntries?: number } = {};
    const final = yield* orientedBoundarySteps(leafMeshes(chunks, capture, edge), edge.plane, budget);
    capture.stats.proofPeakEntries = Math.max(capture.stats.proofPeakEntries, budget.proofEntries ?? 0);
    if (!final || !edge.terrain) { omitted(budget.reason ?? 'missing pre-clip terrain'); continue; }
    const result = unionFoundationBoundary(edge.terrain, edge.boxes, final.oriented, edge.plane,
      { terrainComplete: true, boxesComplete: true, terrainBelowSolid: capture.belowSolid }, final.contours);
    yield;
    if (!result.compatible) { omitted(result.reason); continue; }
    const ranges: { lo: number; hi: number }[] = [];
    for (const box of [...edge.boxes].sort((a, b) => a.lo - b.lo)) {
      const previous = ranges[ranges.length - 1];
      if (previous && box.lo <= previous.hi) previous.hi = Math.max(previous.hi, box.hi);
      else ranges.push({ lo: box.lo, hi: box.hi });
    }
    const inside = result.segments.filter(s => s.b.u > s.a.u && ranges.some(r => s.a.u >= r.lo && s.b.u <= r.hi));
    if (capture.stats.outputSegments + inside.length > LIMIT.segments) { omitted('column output-segment cap'); continue; }
    const patch = { x: edge.x, z: edge.z, side: edge.side, ranges, segments: inside };
    const packed = packAuthoredSeams([...patches, patch], capture.column.cx, capture.column.cz, capture.column.step);
    if (!packed) { omitted('column payload cap or incomplete patch'); continue; }
    capture.stats.payloadBytes = packed.keys.byteLength + packed.rangeOffsets.byteLength + packed.ranges.byteLength +
      packed.segmentOffsets.byteLength + packed.segments.byteLength;
    patches.push(patch); capture.stats.outputSegments += inside.length; capture.stats.provedEdges++;
  }
  return packAuthoredSeams(patches, capture.column.cx, capture.column.cz, capture.column.step);
}
