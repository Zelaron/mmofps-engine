import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ray, Vector3 } from 'three';
import { stitchBoundary, type BoundarySegment, type BoundaryPlane } from '../src/render/terrain-seams.js';
import { unionFoundationBoundary as scopedUnion, type FoundationSection, type RenderedBoundarySegment,
  type UnionProvenance } from '../src/render/terrain-foundation-union.js';

// Synthetic retained faces supply both original contour data and orientation.
const unionFoundationBoundary = (terrain: readonly BoundarySegment[], boxes: readonly FoundationSection[],
  rendered: readonly RenderedBoundarySegment[], plane: BoundaryPlane, provenance: UnionProvenance) =>
  scopedUnion(terrain, boxes, rendered, plane, provenance, rendered.map(({ a, b }) => ({ a, b })));

const plane: BoundaryPlane = { axis: 'z', boundary: 0, lo: -2, hi: 2 };
const complete = { terrainComplete: true, boxesComplete: true, terrainBelowSolid: true };
const segment = (y: number, lo = -2, hi = 2, normalY = 1): RenderedBoundarySegment => ({
  normalY,
  a: { u: lo, y, r: 70, g: 90, b: 110, depth: 20 },
  b: { u: hi, y, r: 70, g: 90, b: 110, depth: 20 },
});
const box = (id: string, bottom: number, top: number, lo = -1, hi = 1): FoundationSection => ({ id, lo, hi, bottom, top });
const faces = (b: FoundationSection) => [segment(b.top, b.lo, b.hi), segment(b.bottom, b.lo, b.hi, -1)];
const heights = (s: readonly BoundarySegment[], u: number) => s.filter(s => s.a.u < u && s.b.u > u)
  .map(s => s.a.y + (s.b.y - s.a.y) * (u - s.a.u) / (s.b.u - s.a.u)).sort((a, b) => b - a);
function expectSegments(result: ReturnType<typeof unionFoundationBoundary>): BoundarySegment[] {
  assert.equal(result.compatible, true, !result.compatible ? result.reason : '');

  assert.ok(result.operations <= 250_000);
  return result.segments;
}
function rayHit(positions: Float32Array, plane: BoundaryPlane, y: number, from: number): boolean {
  const origin = plane.axis === 'z' ? new Vector3(.25, y, from * .01) : new Vector3(from * .01, y, .25);
  const direction = plane.axis === 'z' ? new Vector3(0, 0, -from) : new Vector3(-from, 0, 0);
  const ray = new Ray(origin, direction), a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3();
  for (let i = 0; i < positions.length; i += 9) {
    if (ray.intersectTriangle(a.fromArray(positions, i), b.fromArray(positions, i + 3), c.fromArray(positions, i + 6), true, hit))
      return true;
  }
  return false;
}

test('embedded plinth and sealed coarse terrain use exposed union faces, with real front-side closure', () => {
  const plinth = box('plinth', -1, 1);
  const rendered = [segment(0, -2, -1), segment(0, 1, 2), ...faces(plinth)];
  for (const axis of ['x', 'z'] as const) {
    const p = { ...plane, axis };
    const fine = expectSegments(unionFoundationBoundary([segment(0)], [plinth], rendered, p, complete));
    const coarse = expectSegments(unionFoundationBoundary([segment(5)], [plinth], [segment(5), ...faces(plinth)], p, complete));
    assert.deepEqual(heights(fine, .25), [1]);
    assert.deepEqual(heights(fine, 1.5), [0]);
    assert.deepEqual(heights(coarse, .25), [5], 'sealed terrain contains the complete underground box');
    const seam = stitchBoundary(fine, coarse, p);
    assert.equal(seam.compatible, true);
    if (!seam.compatible) continue;
    assert.equal(rayHit(seam.mesh.positions, p, 2, -1), true);
    assert.equal(rayHit(seam.mesh.positions, p, 2, 1), false, 'front side faces the open fine side');
    assert.equal(rayHit(seam.mesh.positions, p, -2, -1), false, 'no invented unbounded curtain');
  }
});

test('finite suspended platforms retain their visible underside and terrain below', () => {
  const plinth = box('suspended', -1, 1), terrain = [segment(-5)];
  const union = expectSegments(unionFoundationBoundary(terrain, [plinth], [...terrain, ...faces(plinth)], plane, complete));
  assert.deepEqual(heights(union, .25), [1, -1, -5]);
  const island = expectSegments(unionFoundationBoundary([], [plinth], faces(plinth), plane,
    { ...complete, terrainBelowSolid: false }));
  assert.deepEqual(heights(island, .25), [1, -1]);
});

test('overlapping and identical explicit foundations are OR unions, never parity cavities', () => {
  const a = box('a', -1, 1, -2, 1), b = box('b', 0, 2, -1, 2), terrain = [segment(-5)];
  const union = expectSegments(unionFoundationBoundary(terrain, [a, b], [...terrain, ...faces(a), ...faces(b)], plane, complete));
  assert.deepEqual(heights(union, -.5), [2, -1, -5]);
  assert.deepEqual(heights(union, -1.5), [1, -1, -5]);
  assert.deepEqual(heights(union, 1.5), [2, 0, -5]);
  const twin = { ...a, id: 'independent-identical' };
  const identical = expectSegments(unionFoundationBoundary(terrain, [a, twin], [...terrain, ...faces(a)], plane, complete));
  assert.deepEqual(heights(identical, -.5), [1, -1, -5]);
});

test('multiple cave roofs and floors remain independent and shared air receives no seam', () => {
  const terrain = [10, 8, 3, 1, -5].map((y, i) => segment(y, -2, 2, i % 2 ? -1 : 1));
  const plinth = box('lowest-floor', -6, -4);
  const rendered = [...terrain.slice(0, -1), segment(-5, -2, -1), segment(-5, 1, 2), ...faces(plinth)];
  const union = expectSegments(unionFoundationBoundary(terrain, [plinth], rendered, plane, complete));
  assert.deepEqual(heights(union, .25), [10, 8, 3, 1, -4]);
  const seam = stitchBoundary(union, union, plane);
  assert.equal(seam.compatible, true);
  if (seam.compatible) assert.equal(seam.mesh.positions.length, 0);
});

test('removed protruding terrain and incomplete provenance fail without inventing faces', () => {
  const plinth = box('lower-top', -1, 0);
  const protrudes = unionFoundationBoundary([segment(.4)], [plinth], faces(plinth), plane, complete);
  assert.equal(protrudes.compatible, false);
  if (!protrudes.compatible) assert.match(protrudes.reason, /no retained rendered face/);
  for (const incomplete of [{ ...complete, terrainComplete: false }, { ...complete, boxesComplete: false }])
    assert.equal(unionFoundationBoundary([segment(0)], [], [segment(0)], plane, incomplete).compatible, false);
  assert.equal(unionFoundationBoundary([], [plinth], faces(plinth), plane, complete).compatible, false,
    'missing lower terrain band inside the authored interval is not accepted');
  const reversed = unionFoundationBoundary([segment(0)], [plinth], [segment(0, -2, 2, -1)], plane, complete);
  assert.equal(reversed.compatible, false, 'coincident down-facing face cannot support an upward transition');
  const coplanar = unionFoundationBoundary([segment(0)], [plinth], [segment(0, -2, 2, 0)], plane, complete);
  assert.equal(coplanar.compatible, false, 'vertical coplanar side alone does not prove floor air-side orientation');
});

test('malformed data and bounded worst-case contour work fail conservatively', () => {
  const terrain = [segment(0)];
  for (const n of [NaN, Infinity, -Infinity]) {
    assert.equal(unionFoundationBoundary([segment(n)], [], terrain, plane, complete).compatible, false);
    assert.equal(unionFoundationBoundary(terrain, [box('invalid', -1, n)], terrain, plane, complete).compatible, false);
  }
  const duplicate = box('duplicate', -1, 1);
  assert.equal(unionFoundationBoundary(terrain, [duplicate, duplicate], terrain, plane, complete).compatible, false);
  const excessiveBoxes = Array.from({ length: 65 }, (_, i) => box(String(i), -1, 1));
  assert.equal(unionFoundationBoundary(terrain, excessiveBoxes, terrain, plane, complete).compatible, false);
  const parallel = Array.from({ length: 1001 }, (_, i) => segment(i));
  const bounded = unionFoundationBoundary(parallel, [box('work', -2, -1)], parallel, plane, complete);
  assert.equal(bounded.compatible, false);
  if (!bounded.compatible) assert.match(bounded.reason, /work budget/);
  assert.ok(bounded.operations <= 250_001);
});

test('an unchanged native-style fold outside the foundation passes through exactly, without reinterpreting its air side', () => {
  const folded = [segment(53.27894675257524, -2, -1, 1), segment(51.989782672972154, -2, -1, 1),
    segment(51.984432605263144, -2, -1, -1), segment(51.93576935544216, -2, -1, -1)];
  const plinth = box('local', -1, 1, 0, 1);
  const retained = [...folded, segment(0, -2, 0), segment(0, 1, 2), ...faces(plinth)];
  const union = expectSegments(unionFoundationBoundary([...folded, segment(0)], [plinth], retained, plane, complete));
  assert.deepEqual(union.filter(s => s.a.u === -2 && s.b.u === -1), folded.map(({ a, b }) => ({ a, b })));
  assert.deepEqual(heights(union, .25), [1]);
});
