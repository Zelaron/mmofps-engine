import type { BoundaryPlane, BoundaryPoint, BoundarySegment } from './terrain-seams.js';

export interface AuthoredSeamPayload {
  version: 1;
  /** Leaf X, leaf Z, side (west/east/north/south) triples. */
  keys: Int32Array;
  rangeOffsets: Uint32Array;
  ranges: Float64Array;
  segmentOffsets: Uint32Array;
  segments: Float64Array;
}
export const AUTHORED_SEAM_LIMITS = Object.freeze({ edges: 64, segments: 512, bytes: 65_536,
  scratchBytes: 1_048_576, triangleComparisons: 2_000_000, boxesPerEdge: 64, proofEntries: 2048 });
const finite = (a: ArrayLike<number>) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };
export function authoredSeamPlane(x: number, z: number, side: number): BoundaryPlane {
  return side < 2 ? { axis: 'x', boundary: (x + side) * 32, lo: z * 32, hi: (z + 1) * 32 }
    : { axis: 'z', boundary: (z + side - 2) * 32, lo: x * 32, hi: (x + 1) * 32 };
}
function bytes(p: AuthoredSeamPayload): number {
  return p.keys.byteLength + p.rangeOffsets.byteLength + p.ranges.byteLength +
    p.segmentOffsets.byteLength + p.segments.byteLength;
}
/** Cosmetic metadata is optional. Reject the whole override on malformed or
 * partial data; its ordinary triangle payload keeps its original behavior. */
function validAuthoredSeams(value: unknown, cx?: number, cz?: number, step?: number): value is AuthoredSeamPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as AuthoredSeamPayload;
  if (p.version !== 1 || !(p.keys instanceof Int32Array) || !(p.rangeOffsets instanceof Uint32Array) ||
      !(p.ranges instanceof Float64Array) || !(p.segmentOffsets instanceof Uint32Array) ||
      !(p.segments instanceof Float64Array) || p.keys.length % 3 !== 0 ||
      p.ranges.length % 2 !== 0 || p.segments.length % 12 !== 0) return false;
  const count = p.keys.length / 3;
  if (count > AUTHORED_SEAM_LIMITS.edges || p.segments.length / 12 > AUTHORED_SEAM_LIMITS.segments ||
      bytes(p) > AUTHORED_SEAM_LIMITS.bytes || p.rangeOffsets.length !== count + 1 || p.segmentOffsets.length !== count + 1 ||
      p.rangeOffsets[0] !== 0 || p.segmentOffsets[0] !== 0 || p.rangeOffsets[count] !== p.ranges.length ||
      p.segmentOffsets[count] !== p.segments.length || !finite(p.ranges) || !finite(p.segments)) return false;
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    const x = p.keys[i * 3], z = p.keys[i * 3 + 1], side = p.keys[i * 3 + 2], key = `${x},${z},${side}`;
    if (side < 0 || side > 3 || seen.has(key) || (step !== undefined &&
        (x < cx! * step || x >= (cx! + 1) * step || z < cz! * step || z >= (cz! + 1) * step))) return false;
    seen.add(key);
    const plane = authoredSeamPlane(x, z, side), r0 = p.rangeOffsets[i], r1 = p.rangeOffsets[i + 1];
    const s0 = p.segmentOffsets[i], s1 = p.segmentOffsets[i + 1];
    if (r1 <= r0 || r0 % 2 || r1 % 2 || r1 > p.ranges.length || s1 < s0 || s0 % 12 || s1 % 12 || s1 > p.segments.length) return false;
    let previous = plane.lo;
    for (let r = r0; r < r1; r += 2) {
      const lo = p.ranges[r], hi = p.ranges[r + 1];
      if (lo < previous || hi <= lo || hi > plane.hi) return false;
      previous = hi;
    }
    for (let s = s0; s < s1; s += 12) {
      const lo = p.segments[s], hi = p.segments[s + 6];
      if (hi <= lo) return false;
      let covered = false;
      for (let r = r0; r < r1; r += 2) if (lo >= p.ranges[r] && hi <= p.ranges[r + 1]) { covered = true; break; }
      if (!covered) return false;
    }
    // The worker proves solid below its complete band. Each overridden u
    // interval must therefore retain at least one transition from sky air.
    // A truncated/empty patch must not erase the original boundary there.
    const spans: { lo: number; hi: number }[] = [];
    for (let s = s0; s < s1; s += 12) spans.push({ lo: p.segments[s], hi: p.segments[s + 6] });
    spans.sort((a, b) => a.lo - b.lo || a.hi - b.hi);
    let next = 0;
    for (let r = r0; r < r1; r += 2) {
      let cursor = p.ranges[r];
      while (next < spans.length && spans[next].lo <= cursor) {
        cursor = Math.max(cursor, spans[next++].hi);
      }
      if (cursor < p.ranges[r + 1]) return false;
    }
  }
  return true;
}
export function validateAuthoredSeams(value: unknown, cx: number, cz: number, step: number): value is AuthoredSeamPayload {
  return [1, 4, 16].includes(step) && Number.isSafeInteger(cx) && Number.isSafeInteger(cz) && validAuthoredSeams(value, cx, cz, step);
}
const point = (data: Float64Array, offset: number): BoundaryPoint => ({ u: data[offset], y: data[offset + 1],
  r: data[offset + 2], g: data[offset + 3], b: data[offset + 4], depth: data[offset + 5] });
const at = (s: BoundarySegment, u: number): BoundaryPoint => {
  if (u === s.a.u) return s.a; if (u === s.b.u) return s.b;
  const t = (u - s.a.u) / (s.b.u - s.a.u);
  return { u, y: s.a.y + (s.b.y - s.a.y) * t, r: s.a.r + (s.b.r - s.a.r) * t,
    g: s.a.g + (s.b.g - s.a.g) * t, b: s.a.b + (s.b.b - s.a.b) * t, depth: s.a.depth + (s.b.depth - s.a.depth) * t };
};
/** Called with the column-validated payload. Direct callers still get safe
 * whole fallback if scalar bounds or the matched edge are malformed. */
export function spliceAuthoredBoundary(original: BoundarySegment[], payload: AuthoredSeamPayload | undefined,
  leafX: number, leafZ: number, plane: BoundaryPlane): BoundarySegment[] {
  if (!validAuthoredSeams(payload)) return original;
  const side = plane.axis === 'x' ? (plane.boundary === leafX * 32 ? 0 : plane.boundary === (leafX + 1) * 32 ? 1 : -1)
    : (plane.boundary === leafZ * 32 ? 2 : plane.boundary === (leafZ + 1) * 32 ? 3 : -1);
  if (side < 0) return original;
  let index = -1;
  for (let i = 0; i < payload.keys.length; i += 3)
    if (payload.keys[i] === leafX && payload.keys[i + 1] === leafZ && payload.keys[i + 2] === side) { index = i / 3; break; }
  if (index < 0) return original;
  const r0 = payload.rangeOffsets[index], r1 = payload.rangeOffsets[index + 1], s0 = payload.segmentOffsets[index], s1 = payload.segmentOffsets[index + 1];
  const ranges: { lo: number; hi: number }[] = [];
  let previous = plane.lo;
  for (let r = r0; r < r1; r += 2) {
    const lo = payload.ranges[r], hi = payload.ranges[r + 1];
    if (lo < previous || hi <= lo || hi > plane.hi) return original;
    ranges.push({ lo, hi }); previous = hi;
  }
  const output: BoundarySegment[] = [];
  for (const s of original) {
    if (s.a.u === s.b.u) {
      if (!ranges.some(r => r.lo < s.a.u && s.a.u < r.hi)) output.push(s);
      if (output.length > 8192) return original;
      continue;
    }
    let cursor = s.a.u;
    for (const range of ranges) {
      if (range.hi <= cursor || range.lo >= s.b.u) continue;
      if (range.lo > cursor) output.push({ a: at(s, cursor), b: at(s, Math.min(range.lo, s.b.u)) });
      cursor = Math.max(cursor, Math.min(range.hi, s.b.u));
    }
    if (cursor < s.b.u) output.push(cursor === s.a.u ? s : { a: at(s, cursor), b: s.b });
    if (output.length > 8192) return original;
  }
  for (let s = s0; s < s1; s += 12) {
    const a = point(payload.segments, s), b = point(payload.segments, s + 6);
    if (!ranges.some(r => a.u >= r.lo && b.u <= r.hi) || b.u <= a.u) return original;
    output.push({ a, b }); if (output.length > 8192) return original;
  }
  return output;
}

export interface AuthoredSeamPatch { x: number; z: number; side: number; ranges: { lo: number; hi: number }[]; segments: BoundarySegment[] }
export function packAuthoredSeams(patches: readonly AuthoredSeamPatch[], cx: number, cz: number, step: number): AuthoredSeamPayload | undefined {
  if (!patches.length) return undefined;
  if (patches.length > AUTHORED_SEAM_LIMITS.edges) return undefined;
  let rangeCount = 0, segmentCount = 0;
  for (const patch of patches) {
    rangeCount += patch.ranges.length; segmentCount += patch.segments.length;
    const size = patches.length * 12 + (patches.length + 1) * 8 + rangeCount * 16 + segmentCount * 96;
    if (segmentCount > AUTHORED_SEAM_LIMITS.segments || size > AUTHORED_SEAM_LIMITS.bytes) return undefined;
  }
  const keys: number[] = [], rangeOffsets = [0], ranges: number[] = [], segmentOffsets = [0], segments: number[] = [];
  for (const patch of patches) {
    keys.push(patch.x, patch.z, patch.side);
    for (const r of patch.ranges) ranges.push(r.lo, r.hi);
    rangeOffsets.push(ranges.length);
    for (const s of patch.segments) for (const p of [s.a, s.b]) segments.push(p.u, p.y, p.r, p.g, p.b, p.depth);
    segmentOffsets.push(segments.length);
  }
  const p: AuthoredSeamPayload = { version: 1, keys: new Int32Array(keys), rangeOffsets: new Uint32Array(rangeOffsets),
    ranges: new Float64Array(ranges), segmentOffsets: new Uint32Array(segmentOffsets), segments: new Float64Array(segments) };
  return validateAuthoredSeams(p, cx, cz, step) ? p : undefined;
}
