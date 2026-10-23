import type { ChunkMesh } from './surfacenets.js';

/** A clipped mesh's actual boundary, in (horizontal coordinate, height).
 * Keep every contour: a cave contributes its roof and floor, not one height. */
export interface BoundaryPoint {
  u: number; y: number;
  r: number; g: number; b: number; depth: number;
}
export interface BoundarySegment { a: BoundaryPoint; b: BoundaryPoint }
export interface BoundaryPlane { axis: 'x' | 'z'; boundary: number; lo: number; hi: number }
export type SeamMesh = Pick<ChunkMesh, 'positions' | 'normals' | 'colors' | 'caveDepth'>;
export type BoundaryMesh = Pick<ChunkMesh, 'positions'> & Partial<Pick<ChunkMesh, 'colors' | 'caveDepth'>>;
export type StitchResult = { compatible: true; mesh: SeamMesh; operations: number }
  | { compatible: false; reason: string };

const EPS = 1e-7;
const MAX_SEGMENTS = 8192;
const MAX_EVENTS = 32768;
const MAX_OPERATIONS = 250_000;
const MAX_OUTPUT_TRIANGLES = 8192;

function boundaryPoint(mesh: BoundaryMesh, j: number, other: number): BoundaryPoint {
  return { u: mesh.positions[j + other], y: mesh.positions[j + 1],
    r: mesh.colors?.[j] ?? 128, g: mesh.colors?.[j + 1] ?? 128,
    b: mesh.colors?.[j + 2] ?? 128, depth: mesh.caveDepth?.[j / 3] ?? 0 };
}

function mix(a: BoundaryPoint, b: BoundaryPoint, t: number): BoundaryPoint {
  return { u: a.u + (b.u - a.u) * t, y: a.y + (b.y - a.y) * t,
    r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t, depth: a.depth + (b.depth - a.depth) * t };
}
function at(segment: BoundarySegment, u: number): BoundaryPoint {
  const p = mix(segment.a, segment.b, (u - segment.a.u) / (segment.b.u - segment.a.u));
  p.u = u;
  return p;
}

/** Extract only open edges on an exact ownership plane. Opposite triangle
 * edges cancel, including vertical-slice joins and coplanar shared faces.
 * Inputs are retained CPU buffers; neither World nor a height probe is used. */
export function meshBoundary(meshes: readonly BoundaryMesh[], plane: BoundaryPlane): BoundarySegment[] {
  const axis = plane.axis === 'x' ? 0 : 2, other = 2 - axis;
  const edges = new Map<string, { segment: BoundarySegment; count: number }>();
  for (const mesh of meshes) {
    const p = mesh.positions;
    for (let i = 0; i < p.length; i += 9) for (let edge = 0; edge < 3; edge++) {
      const a = edge * 3, b = (edge + 1) % 3 * 3;
      const ia = i + a, ib = i + b;
      if (p[ia + axis] !== plane.boundary || p[ib + axis] !== plane.boundary) continue;
      let va = boundaryPoint(mesh, ia, other), vb = boundaryPoint(mesh, ib, other);
      let direction = 1;
      if (va.u > vb.u || va.u === vb.u && va.y > vb.y) { [va, vb] = [vb, va]; direction = -1; }
      if (vb.u < plane.lo || va.u > plane.hi) continue;
      if (va.u !== vb.u) {
        const originalA = va, originalB = vb;
        if (va.u < plane.lo) va = mix(originalA, originalB, (plane.lo - originalA.u) / (originalB.u - originalA.u));
        if (vb.u > plane.hi) vb = mix(originalA, originalB, (plane.hi - originalA.u) / (originalB.u - originalA.u));
        va.u = Math.max(plane.lo, va.u); vb.u = Math.min(plane.hi, vb.u);
      }
      if (va.u === vb.u && va.y === vb.y) continue;
      const key = `${va.u},${va.y}/${vb.u},${vb.y}`;
      const existing = edges.get(key);
      if (existing) existing.count += direction;
      else edges.set(key, { segment: { a: va, b: vb }, count: direction });
    }
  }
  // Vertical mesh slices share a ghost strip and may repeat the SAME face.
  // Repetition is one boundary, not two toggles; only opposite orientations
  // are internal triangle edges and cancel each other.
  return [...edges.values()].filter(edge => edge.count !== 0).map(edge => edge.segment);
}

/** Join the two rendered solid cross-sections, never an arbitrary floor.
 * `negative` is west/north of the plane, `positive` east/south. Starting in
 * air above both meshes, each contour crossing toggles that side's solid
 * membership. Emit only their symmetric difference. Shared cave air remains
 * empty; separate roofs/floors receive separate strips. Splitting crossings
 * first prevents a height-order reversal from producing a bow-tie triangle. */
export function stitchBoundary(
  negative: readonly BoundarySegment[], positive: readonly BoundarySegment[], plane: BoundaryPlane,
  sharedOnly = false,
): StitchResult {
  if (negative.length + positive.length > MAX_SEGMENTS)
    return { compatible: false, reason: 'boundary segment budget exceeded' };
  let operations = 0;
  const charge = (n = 1) => (operations += n) <= MAX_OPERATIONS;
  const sortCost = (n: number) => n * Math.ceil(Math.log2(Math.max(2, n)));
  if (![plane.boundary, plane.lo, plane.hi].every(Number.isFinite) || plane.hi <= plane.lo)
    return { compatible: false, reason: 'invalid boundary plane' };
  for (const s of [...negative, ...positive]) {
    if (![s.a.u, s.a.y, s.b.u, s.b.y].every(Number.isFinite))
      return { compatible: false, reason: 'non-finite boundary' };
  }
  const segments = [...negative.map(segment => ({ segment, side: 0 })),
    ...positive.map(segment => ({ segment, side: 1 }))]
    .filter(({ segment: s }) => s.b.u - s.a.u > EPS);
  const cuts = [plane.lo, plane.hi];
  for (const { segment: s } of segments) {
    cuts.push(Math.max(plane.lo, s.a.u), Math.min(plane.hi, s.b.u));
  }
  // Sweep only segments whose horizontal ranges overlap. Ordinary terrain
  // has two active contours; deep caves add their finite roof/floor layers.
  if (!charge(sortCost(segments.length))) return { compatible: false, reason: 'boundary work budget exceeded' };
  const byStart = [...segments].sort((a, b) => a.segment.a.u - b.segment.a.u);
  const active: typeof segments = [];
  for (const next of byStart) {
    const b = next.segment;
    for (let i = active.length - 1; i >= 0; i--) {
      if (!charge()) return { compatible: false, reason: 'boundary work budget exceeded' };
      const a = active[i].segment;
      if (a.b.u <= b.a.u) { active.splice(i, 1); continue; }
      const lo = Math.max(plane.lo, a.a.u, b.a.u), hi = Math.min(plane.hi, a.b.u, b.b.u);
      if (hi - lo <= EPS) continue;
      const d0 = at(a, lo).y - at(b, lo).y, d1 = at(a, hi).y - at(b, hi).y;
      if (d0 * d1 < 0) cuts.push(lo + (hi - lo) * d0 / (d0 - d1));
    }
    active.push(next);
    if (cuts.length > MAX_EVENTS) return { compatible: false, reason: 'boundary intersection budget exceeded' };
  }
  if (!charge(sortCost(cuts.length))) return { compatible: false, reason: 'boundary work budget exceeded' };
  cuts.sort((a, b) => a - b);
  const events = cuts.filter((u, i) => u >= plane.lo && u <= plane.hi && (!i || u - cuts[i - 1] > EPS));
  const positions: number[] = [], normals: number[] = [], colors: number[] = [], depths: number[] = [];
  const triangle = (a: BoundaryPoint, b: BoundaryPoint, c: BoundaryPoint, sign: number) => {
    const area = (b.u - a.u) * (c.y - a.y) - (b.y - a.y) * (c.u - a.u);
    if (Math.abs(area) < 1e-12) return;
    // In (u,y), positive area points -X for an X plane and +Z for Z.
    const desired = plane.axis === 'x' ? -sign : sign;
    if (area * desired < 0) [b, c] = [c, b];
    for (const v of [a, b, c]) {
      positions.push(plane.axis === 'x' ? plane.boundary : v.u, v.y,
        plane.axis === 'z' ? plane.boundary : v.u);
      normals.push(plane.axis === 'x' ? sign : 0, 0, plane.axis === 'z' ? sign : 0);
      colors.push(Math.round(v.r), Math.round(v.g), Math.round(v.b)); depths.push(Math.round(v.depth));
    }
  };
  let startIndex = 0;
  active.length = 0;
  for (let i = 1; i < events.length; i++) {
    const lo = events[i - 1], hi = events[i], middle = (lo + hi) / 2;
    if (hi - lo <= EPS) continue;
    if (!charge(active.length)) return { compatible: false, reason: 'boundary work budget exceeded' };
    for (let j = active.length - 1; j >= 0; j--) if (active[j].segment.b.u <= middle) active.splice(j, 1);
    while (startIndex < byStart.length && byStart[startIndex].segment.a.u < middle) {
      const entry = byStart[startIndex++];
      if (entry.segment.b.u > middle) active.push(entry);
    }
    if (!charge(active.length * 3 + sortCost(active.length)))
      return { compatible: false, reason: 'boundary work budget exceeded' };
    const crossings = active.map(entry => ({ ...entry, y: at(entry.segment, middle).y }))
      .sort((a, b) => b.y - a.y);
    // Entrance caps deliberately cover only candidate mouth cells. Joining
    // two existing caps is valid; extending a lone cap would invent another
    // stencil crossing outside its conservative aperture.
    if (sharedOnly && (!active.some(entry => entry.side === 0) || !active.some(entry => entry.side === 1))) continue;
    let solidA = false, solidB = false;
    const strips: { top: BoundarySegment; bottom: BoundarySegment; sign: number }[] = [];
    for (let j = 0; j < crossings.length;) {
      const top = crossings[j];
      let next = j;
      while (next < crossings.length && Math.abs(crossings[next].y - top.y) < EPS) {
        if (crossings[next].side === 0) solidA = !solidA; else solidB = !solidB;
        next++;
      }
      if (next < crossings.length && solidA !== solidB)
        strips.push({ top: top.segment, bottom: crossings[next].segment, sign: solidA ? 1 : -1 });
      j = next;
    }
    // A missing lower band cannot be repaired with an invented infinite
    // curtain. The caller retains its previous publication and retries when
    // the neighboring geometry changes. Truly empty edges need no stitch.
    if (solidA !== solidB)
      return { compatible: false, reason: `unmatched solid interval below the sampled bands at ${lo}..${hi} (${crossings.filter(c => c.side === 0).length}/${crossings.filter(c => c.side === 1).length} crossings)` };
    for (const { top, bottom, sign } of strips) {
      if (positions.length / 9 + 2 > MAX_OUTPUT_TRIANGLES)
        return { compatible: false, reason: 'boundary output budget exceeded' };
      const a = at(top, lo), b = at(top, hi), c = at(bottom, hi), d = at(bottom, lo);
      triangle(a, b, c, sign); triangle(a, c, d, sign);
    }
  }
  return { compatible: true, operations, mesh: { positions: new Float32Array(positions), normals: new Float32Array(normals),
    colors: new Uint8Array(colors), caveDepth: new Uint8Array(depths) } };
}

export function combineSeamMeshes(meshes: Iterable<SeamMesh>): SeamMesh {
  const list = [...meshes];
  const length = list.reduce((n, mesh) => n + mesh.positions.length, 0);
  const positions = new Float32Array(length), normals = new Float32Array(length);
  const colors = new Uint8Array(length), caveDepth = new Uint8Array(length / 3);
  let offset = 0;
  for (const mesh of list) {
    positions.set(mesh.positions, offset); normals.set(mesh.normals, offset); colors.set(mesh.colors, offset);
    if (mesh.caveDepth) caveDepth.set(mesh.caveDepth, offset / 3);
    offset += mesh.positions.length;
  }
  return { positions, normals, colors, caveDepth };
}
