import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ray, Vector3 } from 'three';
import { unionFoundationBoundary as original } from './fixtures/terrain-foundation-union-reference.js';
import { unionFoundationBoundary as compact, type FoundationSection, type RenderedBoundarySegment } from '../src/render/terrain-foundation-union.js';
import { stitchBoundary, type BoundaryPoint, type BoundarySegment } from '../src/render/terrain-seams.js';

const plane = { axis: 'z' as const, boundary: 0, lo: 0, hi: 8 };
const proof = { terrainComplete: true, boxesComplete: true, terrainBelowSolid: true };
const point = (u: number, y: number): BoundaryPoint => ({ u, y, r: 32 + u * 8, g: 64 + u * 4, b: 96 - u * 4, depth: 16 + u * 2 });
const face = (lo: number, hi: number, y: number, normalY = 1): RenderedBoundarySegment => ({ a: point(lo, y), b: point(hi, y), normalY });
const box = (id: string, lo = 0, hi = 8, bottom = -2, top = 2): FoundationSection => ({ id, lo, hi, bottom, top });
const parts = (lo = 0, hi = 8, y = 0) => Array.from({ length: (hi - lo) * 8 }, (_, i) => face(lo + i / 8, lo + (i + 1) / 8, y));
const at = (s: BoundarySegment, u: number): BoundaryPoint => {
  const t = (u - s.a.u) / (s.b.u - s.a.u);
  return { u, y: s.a.y + (s.b.y - s.a.y) * t, r: s.a.r + (s.b.r - s.a.r) * t,
    g: s.a.g + (s.b.g - s.a.g) * t, b: s.a.b + (s.b.b - s.a.b) * t, depth: s.a.depth + (s.b.depth - s.a.depth) * t };
};
function run(terrain: BoundarySegment[], boxes: FoundationSection[], rendered: RenderedBoundarySegment[], retained: BoundarySegment[] = rendered) {
  const before = original(terrain, boxes, rendered, plane, proof, retained);
  const after = compact(terrain, boxes, rendered, plane, proof, retained);
  assert.equal(before.compatible, true, !before.compatible ? before.reason : '');
  assert.equal(after.compatible, true, !after.compatible ? after.reason : '');
  assert.equal(after.rawSegments, before.segments.length);
  assert.equal(after.segments.length + after.mergedSegments, after.rawSegments);
  assert.ok(after.operations <= 250000);
  // Dyadic inputs make these interior values exactly representable; no
  // tolerance participates in the compaction decision or these checks.
  for (let i = 0; i < 128; i++) {
    const u = (i + .5) / 16;
    const values = (ss: BoundarySegment[]) => ss.filter(s => s.a.u < u && s.b.u > u)
      .map(s => at(s, u)).sort((a, b) => b.y - a.y);
    assert.deepEqual(values(after.segments), values(before.segments), 'same geometry and exact color/depth affine values');
  }
  return { before, after };
}

test('same oriented retained face coalesces event-only cuts while retaining exact outer endpoint attributes', () => {
  const top = face(0, 8, 2), bottom = face(0, 8, -2, -1), terrain = parts();
  const saved = structuredClone([top, bottom, ...terrain]);
  const { before, after } = run(terrain, [box('a')], [top, bottom]);
  assert.equal(before.segments.length, 64); assert.equal(after.segments.length, 1);
  assert.equal(after.mergedSegments, 63);
  assert.deepEqual(after.segments[0], { a: top.a, b: top.b });
  assert.deepEqual([top, bottom, ...terrain], saved, 'proof inputs remain unchanged');
});

test('an intervening higher terrain interval interrupts the same face and never bridges its hidden gap', () => {
  const terrain = [...parts(0, 3), ...parts(3, 5, 4), ...parts(5, 8)];
  const top = face(0, 8, 2), roof = face(3, 5, 4), bottom = face(0, 8, -2, -1);
  const { after } = run(terrain, [box('a')], [top, roof, bottom]);
  const tops = after.segments.filter(s => s.a.y === 2);
  assert.deepEqual(tops.map(s => [s.a.u, s.b.u]), [[0, 3], [5, 8]]);
  assert.equal(after.segments.some(s => s.a.y === 2 && s.a.u < 4 && s.b.u > 4), false);
});

test('overlapping boxes preserve independent OR transitions and attribute each visible interval to its actual top', () => {
  const a = box('a', 0, 6), b = box('b', 2, 8, -1, 4);
  const { after } = run(parts(), [a, b], [face(0, 6, 2), face(0, 6, -2, -1), face(2, 8, 4), face(2, 8, -1, -1)]);
  assert.deepEqual(after.segments.map(s => [s.a.u, s.b.u, s.a.y]), [[0, 2, 2], [2, 8, 4]]);
});

test('coincident distinct retained faces and disjoint authored footprints remain separate; outside endpoints stay identical', () => {
  const { after } = run(parts(), [box('a')], [face(0, 4, 2), face(4, 8, 2), face(0, 8, -2, -1)]);
  assert.deepEqual(after.segments.map(s => [s.a.u, s.b.u]), [[0, 4], [4, 8]], 'no value-based cross-face merge');
  const outside = [face(0, 1, 0), face(3, 5, 0), face(7, 8, 0)];
  const rendered = [face(0, 8, 2), face(0, 8, -2, -1), ...outside];
  const separate = run(parts(), [box('a', 1, 3), box('b', 5, 7)], rendered, outside);
  const outsideAfter = separate.after.segments.filter(s => s.a.y === 0);
  assert.deepEqual(outsideAfter, separate.before.segments.filter(s => s.a.y === 0), 'same original outside values/order');
  for (let i = 0; i < outside.length; i++) {
    assert.equal(outsideAfter[i].a, outside[i].a); assert.equal(outsideAfter[i].b, outside[i].b);
  }
  assert.deepEqual(separate.after.segments.filter(s => s.a.y === 2).map(s => [s.a.u, s.b.u]), [[1, 3], [5, 7]]);
});

test('finite suspended underside and FrontSide winding survive compaction; opposite retained orientation still rejects', () => {
  const top = face(0, 8, 2), bottom = face(0, 8, -1, -1), floor = face(0, 8, -4);
  const { after } = run(parts(0, 8, -4), [box('a', 0, 8, -1, 2)], [top, bottom, floor]);
  assert.deepEqual(after.segments.map(s => s.a.y), [2, -1, -4]);
  const seam = stitchBoundary(after.segments, [floor], plane); assert.equal(seam.compatible, true);
  const hit = (y: number, from: number) => {
    const ray = new Ray(new Vector3(4, y, from * .01), new Vector3(0, 0, -from));
    const a = new Vector3(), b = new Vector3(), c = new Vector3(), p = new Vector3();
    for (let i = 0; i < seam.mesh.positions.length; i += 9)
      if (ray.intersectTriangle(a.fromArray(seam.mesh.positions, i), b.fromArray(seam.mesh.positions, i + 3),
        c.fromArray(seam.mesh.positions, i + 6), true, p)) return true;
    return false;
  };
  assert.equal(hit(0, 1), true); assert.equal(hit(0, -1), false);
  assert.equal(hit(-2, 1), false); assert.equal(hit(3, 1), false);
  const wrong = compact(parts(), [box('a')], [face(0, 8, 2, -1), face(0, 8, -2, -1)], plane, proof, []);
  assert.equal(wrong.compatible, false);
});
