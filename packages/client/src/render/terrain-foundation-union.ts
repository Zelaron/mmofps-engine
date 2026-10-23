import type { BoundaryPlane, BoundaryPoint, BoundarySegment } from './terrain-seams.js';

/** Bounded authored union with identity-proved interval compaction. */
export interface FoundationSection { id: string; lo: number; hi: number; bottom: number; top: number }
/** Direction is taken from the original retained triangle cross product. */
export interface RenderedBoundarySegment extends BoundarySegment { normalY: number }
export interface UnionProvenance {
  terrainComplete: boolean;
  boxesComplete: boolean;
  /** Mesher band-floor cap proves solid below all sampled contours. */
  terrainBelowSolid: boolean;
}
type Result = { compatible: true; segments: BoundarySegment[]; operations: number; rawSegments: number; mergedSegments: number }
  | { compatible: false; reason: string; operations: number };
const EPS = 1e-7, MAX_SEGMENTS = 8192, MAX_BOXES = 64, MAX_EVENTS = 32768, MAX_OPERATIONS = 250_000;
const pointAt = (s: BoundarySegment, u: number): BoundaryPoint => {
  const t = (u - s.a.u) / (s.b.u - s.a.u);
  return { u, y: s.a.y + (s.b.y - s.a.y) * t,
    r: s.a.r + (s.b.r - s.a.r) * t, g: s.a.g + (s.b.g - s.a.g) * t,
    b: s.a.b + (s.b.b - s.a.b) * t, depth: s.a.depth + (s.b.depth - s.a.depth) * t };
};
const flat = (box: FoundationSection, y: number): BoundarySegment => ({
  a: { u: box.lo, y, r: 0, g: 0, b: 0, depth: 0 },
  b: { u: box.hi, y, r: 0, g: 0, b: 0, depth: 0 },
});

/** Union complete pre-ownership sampled terrain with each finite authored box.
 * Only transitions backed by the ACTUAL retained rendered contours survive.
 * In particular, a removed protruding floor is not silently reconstructed.
 * This does not change mesh vertices, the field, or stitchBoundary's verdict. */
export function unionFoundationBoundary(
  terrain: readonly BoundarySegment[], boxes: readonly FoundationSection[],
  rendered: readonly RenderedBoundarySegment[], plane: BoundaryPlane, provenance: UnionProvenance,
  retainedContours: readonly BoundarySegment[],
): Result {
  let operations = 0;
  const fail = (reason: string): Result => ({ compatible: false, reason, operations });
  const charge = (n = 1) => (operations += n) <= MAX_OPERATIONS;
  if (!provenance.terrainComplete || !provenance.boxesComplete) return fail('incomplete union provenance');
  if (![plane.boundary, plane.lo, plane.hi].every(Number.isFinite) || plane.hi <= plane.lo)
    return fail('invalid boundary plane');
  if (terrain.length + rendered.length + boxes.length * 2 > MAX_SEGMENTS ||
      retainedContours.length > MAX_SEGMENTS || boxes.length > MAX_BOXES)
    return fail('union input budget exceeded');
  for (const segment of [...terrain, ...rendered, ...retainedContours]) {
    if (![...Object.values(segment.a), ...Object.values(segment.b)].every(Number.isFinite) || segment.b.u < segment.a.u)
      return fail('invalid union contour');
  }
  if (rendered.some(s => !Number.isFinite(s.normalY))) return fail('missing rendered-face orientation');
  const ids = new Set<string>();
  for (const box of boxes) {
    if (!box.id || ids.has(box.id) || ![box.lo, box.hi, box.bottom, box.top].every(Number.isFinite) ||
        box.hi <= box.lo || box.top <= box.bottom) return fail('invalid explicit foundation');
    ids.add(box.id);
  }
  // Only authored footprints change the old contour contract. Preserve the
  // original rendered boundary elsewhere, including pre-existing folds.
  // Never reinterpret its parity/orientation using the pre-clip soup.
  if (!charge(boxes.length * Math.ceil(Math.log2(Math.max(2, boxes.length))))) return fail('union work budget exceeded');
  const ranges: { lo: number; hi: number }[] = [];
  for (const b of [...boxes].sort((a, b) => a.lo - b.lo)) {
    const lo = Math.max(plane.lo, b.lo), hi = Math.min(plane.hi, b.hi);
    if (hi <= lo) continue;
    const previous = ranges[ranges.length - 1];
    if (previous && lo <= previous.hi) previous.hi = Math.max(previous.hi, hi);
    else ranges.push({ lo, hi });
  }
  const slice = <T extends BoundarySegment>(s: T, lo: number, hi: number): T => ({ ...s,
    a: lo === s.a.u ? s.a : pointAt(s, lo), b: hi === s.b.u ? s.b : pointAt(s, hi) });
  const output: BoundarySegment[] = [];
  for (const s of retainedContours) {
    if (s.a.u === s.b.u) {
      if (!charge(ranges.length)) return fail('union work budget exceeded');
      if (!ranges.some(r => r.lo < s.a.u && s.a.u < r.hi)) output.push(s);
      if (output.length > MAX_SEGMENTS) return fail('union output budget exceeded');
      continue;
    }
    let cursor = s.a.u;
    for (const r of ranges) {
      if (!charge()) return fail('union work budget exceeded');
      if (r.hi <= cursor || r.lo >= s.b.u) continue;
      if (r.lo > cursor) output.push(slice(s, cursor, Math.min(r.lo, s.b.u)));
      cursor = Math.max(cursor, Math.min(r.hi, s.b.u));
    }
    if (cursor < s.b.u) output.push(slice(s, cursor, s.b.u));
    if (output.length > MAX_SEGMENTS) return fail('union output budget exceeded');
  }
  // Outside contours retain their existing values/endpoints/order. Only the later
  // authored transitions may coalesce, and only by retained face identity.
  let rawSegments = output.length, mergedSegments = 0;
  // At most one entry per localRendered face (itself capped at8192). This
  // is a bounded logical inventory, not a claim about JS heap allocation.
  const lastByFace = new Map<RenderedBoundarySegment, BoundarySegment>();
  const localTerrain: BoundarySegment[] = [], localRendered: RenderedBoundarySegment[] = [];
  for (const [input, local] of [[terrain, localTerrain], [rendered, localRendered]] as const) {
    for (const s of input) for (const r of ranges) {
      if (!charge()) return fail('union work budget exceeded');
      const lo = Math.max(s.a.u, r.lo), hi = Math.min(s.b.u, r.hi);
      if (hi - lo <= EPS) continue;
      // Both arrays contain source-compatible slices; orientation is retained
      // for rendered entries and never synthesized for terrain entries.
      (local as BoundarySegment[]).push(slice(s, lo, hi));
      if (local.length > MAX_SEGMENTS) return fail('union input budget exceeded');
    }
  }
  const entries = localTerrain.filter(s => s.b.u - s.a.u > EPS)
    .map(segment => ({ segment, box: -1, enter: false }));
  boxes.forEach((box, i) => {
    entries.push({ segment: flat(box, box.top), box: i, enter: true },
      { segment: flat(box, box.bottom), box: i, enter: false });
  });
  const cuts = [plane.lo, plane.hi];
  for (const s of [...entries.map(e => e.segment), ...localRendered]) {
    if (s.b.u <= plane.lo || s.a.u >= plane.hi) continue;
    cuts.push(Math.max(plane.lo, s.a.u), Math.min(plane.hi, s.b.u));
  }
  // Intersections split height-order changes before union classification.
  // Quadratic candidate work is explicitly capped, including disjoint pairs.
  for (let i = 0; i < entries.length; i++) for (let j = 0; j < i; j++) {
    if (!charge()) return fail('union work budget exceeded');
    const a = entries[i].segment, b = entries[j].segment;
    const lo = Math.max(plane.lo, a.a.u, b.a.u), hi = Math.min(plane.hi, a.b.u, b.b.u);
    if (hi - lo <= EPS) continue;
    const d0 = pointAt(a, lo).y - pointAt(b, lo).y, d1 = pointAt(a, hi).y - pointAt(b, hi).y;
    if (d0 * d1 < 0) cuts.push(lo + (hi - lo) * d0 / (d0 - d1));
    if (cuts.length > MAX_EVENTS) return fail('union event budget exceeded');
  }
  if (!charge(cuts.length * Math.ceil(Math.log2(Math.max(2, cuts.length))))) return fail('union work budget exceeded');
  cuts.sort((a, b) => a - b);
  const events = cuts.filter((u, i) => !i || u - cuts[i - 1] > EPS);
  for (let i = 1; i < events.length; i++) {
    const lo = events[i - 1], hi = events[i], mid = (lo + hi) * .5;
    if (hi - lo <= EPS) continue;
    if (!charge(ranges.length)) return fail('union work budget exceeded');
    if (!ranges.some(r => r.lo < mid && mid < r.hi)) continue;
    if (!charge(entries.length)) return fail('union work budget exceeded');
    const active = entries.filter(e => e.segment.a.u < mid && e.segment.b.u > mid)
      .map(e => ({ ...e, y: pointAt(e.segment, mid).y }));
    if (!charge(active.length * Math.ceil(Math.log2(Math.max(2, active.length))))) return fail('union work budget exceeded');
    active.sort((a, b) => b.y - a.y);
    let terrainSolid = false, boxCount = 0;
    const boxInside = new Set<number>();
    for (let j = 0; j < active.length;) {
      const before = terrainSolid || boxCount > 0;
      let end = j;
      while (end < active.length && Math.abs(active[end].y - active[j].y) < EPS) {
        if (!charge()) return fail('union work budget exceeded');
        const crossing = active[end++];
        if (crossing.box < 0) terrainSolid = !terrainSolid;
        else if (crossing.enter) { boxInside.add(crossing.box); boxCount++; }
        else { boxInside.delete(crossing.box); boxCount--; }
      }
      const after = terrainSolid || boxCount > 0;
      if (before !== after) {
        let supported: BoundarySegment | undefined;
        let supportedFace: RenderedBoundarySegment | undefined;
        // Output attributes and geometry both come from an existing face.
        for (let k = j; k < end && !supported; k++) {
          const desired = active[k].segment, ya = pointAt(desired, lo).y, yb = pointAt(desired, hi).y;
          for (const face of localRendered) {
            if (!charge()) return fail('union work budget exceeded');
            // Descending into solid requires an upward-facing real face;
            // leaving it requires a downward face. Coplanar walls alone do
            // not prove a horizontal contour's exposed air side.
            if (face.normalY * (after ? 1 : -1) <= 0) continue;
            if (face.b.u - face.a.u <= EPS || face.a.u > lo || face.b.u < hi) continue;
            const a = pointAt(face, lo), b = pointAt(face, hi);
            if (Math.abs(a.y - ya) <= EPS && Math.abs(b.y - yb) <= EPS) {
              supported = { a, b }; supportedFace = face; break;
            }
          }
        }
        if (!supported || !supportedFace) return fail(`union transition has no retained rendered face at ${lo}..${hi}`);
        // Retain the original uncompressed proof-piece bound as well as the
        // stored-output bound. Compaction never enlarges the proof budget.
        if (++rawSegments > MAX_SEGMENTS || output.length >= MAX_SEGMENTS) return fail('union output budget exceeded');
        if (!charge(7)) return fail('union work budget exceeded');
        const previous = lastByFace.get(supportedFace), a = previous?.b, b = supported.a;
        if (a && a.u === b.u && a.y === b.y && a.r === b.r && a.g === b.g &&
            a.b === b.b && a.depth === b.depth) {
          // Both intervals were derived from this same oriented affine face.
          // Their exact shared endpoint prevents bridging a missing interval.
          // Outer endpoint values are retained verbatim. Interpolation at a
          // removed internal cut may differ only by IEEE operation ordering;
          // no geometric/attribute tolerance participates in this decision.
          previous!.b = supported.b; mergedSegments++;
        } else {
          output.push(supported);
          lastByFace.set(supportedFace, supported);
        }
      }
      j = end;
    }
    if (boxInside.size !== 0 || boxCount !== 0) return fail('unclosed explicit foundation');
    if (terrainSolid !== provenance.terrainBelowSolid)
      return fail(`incomplete sampled terrain bands at ${lo}..${hi}`);
  }
  return { compatible: true, segments: output, operations, rawSegments, mergedSegments };
}
