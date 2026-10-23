import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ray, Vector3 } from 'three';
import {
  stitchBoundary, type BoundaryPlane, type BoundarySegment, type SeamMesh,
} from '../src/render/terrain-seams.js';

function segment(lo: number, hi: number, y0: number, y1 = y0): BoundarySegment {
  return {
    a: { u: lo, y: y0, r: 40, g: 80, b: 120, depth: 0 },
    b: { u: hi, y: y1, r: 80, g: 120, b: 160, depth: 100 },
  };
}

/** Actual front-face ray intersections, independent of the contour sweep. */
function hits(mesh: SeamMesh, plane: BoundaryPlane, u: number, y: number, from: -1 | 1): boolean {
  const origin = plane.axis === 'x'
    ? new Vector3(plane.boundary + from, y, u)
    : new Vector3(u, y, plane.boundary + from);
  const direction = plane.axis === 'x' ? new Vector3(-from, 0, 0) : new Vector3(0, 0, -from);
  const ray = new Ray(origin, direction), p = mesh.positions;
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), out = new Vector3();
  for (let i = 0; i < p.length; i += 9) {
    a.fromArray(p, i); b.fromArray(p, i + 3); c.fromArray(p, i + 6);
    if (ray.intersectTriangle(a, b, c, true, out)) return true;
  }
  return false;
}

function assertNormals(mesh: SeamMesh): void {
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), normal = new Vector3();
  for (let i = 0; i < mesh.positions.length; i += 9) {
    a.fromArray(mesh.positions, i); b.fromArray(mesh.positions, i + 3); c.fromArray(mesh.positions, i + 6);
    normal.crossVectors(b.sub(a), c.sub(a)).normalize();
    assert.ok(normal.dot(new Vector3().fromArray(mesh.normals, i)) > .9999,
      'published normal must agree with triangle winding');
  }
}

for (const axis of ['x', 'z'] as const) {
  test(`crossing mixed-detail contours close only the solid difference with correct ${axis} faces`, () => {
    const plane: BoundaryPlane = { axis, boundary: -2880, lo: -32, hi: 0 };
    // The coarse contour and its finer neighbor exchange height order at u=-16.
    // Their endpoints agree with two analytic planes, giving an independent oracle.
    const result = stitchBoundary([segment(-32, 0, 0)], [
      segment(-32, -24, -4, -2), segment(-24, -16, -2, 0),
      segment(-16, -8, 0, 2), segment(-8, 0, 2, 4),
    ], plane);
    assert.equal(result.compatible, true);
    if (!result.compatible) return;
    assertNormals(result.mesh);
    for (let i = 0; i < 31; i++) {
      const u = -31.5 + i, height = (u + 16) / 4;
      for (let j = 0; j < 30; j++) {
        const y = -4.35 + j * .3;
        if (Math.abs(y) < .001 || Math.abs(y - height) < .001) continue;
        const negativeSolid = y < 0, positiveSolid = y < height;
        assert.equal(hits(result.mesh, plane, u, y, 1), negativeSolid && !positiveSolid,
          `positive-side ray at ${u},${y}`);
        assert.equal(hits(result.mesh, plane, u, y, -1), positiveSolid && !negativeSolid,
          `negative-side ray at ${u},${y}`);
      }
    }
  });
}

test('multiple roof and floor layers leave every shared air band open', () => {
  const plane: BoundaryPlane = { axis: 'x', boundary: -32, lo: -32, hi: 0 };
  const levelsA = [10, 7, 4, 2, 0], levelsB = [11, 8, 3, 1, -1];
  const result = stitchBoundary(levelsA.map(y => segment(-32, 0, y)),
    levelsB.map(y => segment(-32, 0, y)), plane);
  assert.equal(result.compatible, true);
  if (!result.compatible) return;
  assertNormals(result.mesh);
  for (let i = 0; i < 56; i++) {
    const y = -1.875 + i * .25;
    const a = levelsA.filter(level => y < level).length % 2 === 1;
    const b = levelsB.filter(level => y < level).length % 2 === 1;
    assert.equal(hits(result.mesh, plane, -12.25, y, 1), a && !b);
    assert.equal(hits(result.mesh, plane, -12.25, y, -1), b && !a);
  }
});

test('identical boundaries with different segmentation produce no faces', () => {
  const plane: BoundaryPlane = { axis: 'z', boundary: 0, lo: -32, hi: 0 };
  const result = stitchBoundary([segment(-32, 0, -8, 8)],
    [segment(-32, -24, -8, -4), segment(-24, -8, -4, 4), segment(-8, 0, 4, 8)], plane);
  assert.equal(result.compatible, true);
  if (result.compatible) assert.equal(result.mesh.positions.length, 0);
});

test('unmatched lower contour bands reject publication instead of inventing a floor', () => {
  const result = stitchBoundary([segment(-32, 0, 10)],
    [segment(-32, 0, 10), segment(-32, 0, 2)],
    { axis: 'x', boundary: 0, lo: -32, hi: 0 });
  assert.equal(result.compatible, false);
});

test('one empty side permits a finite rock band but rejects a truncated heightfield', () => {
  const plane: BoundaryPlane = { axis: 'x', boundary: -64, lo: -32, hi: 0 };
  const island = stitchBoundary([segment(-32, 0, 10), segment(-32, 0, 5)], [], plane);
  assert.equal(island.compatible, true);
  if (island.compatible) {
    assertNormals(island.mesh);
    assert.equal(hits(island.mesh, plane, -12.5, 7, 1), true);
    assert.equal(hits(island.mesh, plane, -12.5, 7, -1), false);
    assert.equal(hits(island.mesh, plane, -12.5, 3, 1), false);
    assert.equal(hits(island.mesh, plane, -12.5, 12, 1), false);
  }
  assert.equal(stitchBoundary([segment(-32, 0, 10)], [], plane).compatible, false);
});

test('invalid contour coordinates reject publication before range filtering', () => {
  const plane: BoundaryPlane = { axis: 'z', boundary: 0, lo: -32, hi: 0 };
  for (const value of [NaN, Infinity, -Infinity]) {
    for (const coordinate of ['u', 'y'] as const) {
      const invalid = segment(-32, 0, 10);
      invalid.a[coordinate] = value;
      assert.equal(stitchBoundary([invalid], [segment(-32, 0, 11)], plane).compatible, false);
    }
  }
});

test('portal-only joins never extend a lone cap beyond its existing horizontal span', () => {
  const plane: BoundaryPlane = { axis: 'z', boundary: -64, lo: -32, hi: 0 };
  const result = stitchBoundary([segment(-32, 0, 10)], [segment(-24, -8, 12)], plane, true);
  assert.equal(result.compatible, true);
  if (!result.compatible) return;
  assert.equal(hits(result.mesh, plane, -28, 11, -1), false);
  assert.equal(hits(result.mesh, plane, -4, 11, -1), false);
  assert.equal(hits(result.mesh, plane, -16, 11, -1), true);
});

test('many parallel contours have a work limit even without intersections', () => {
  // Segment and intersection counts alone do not bound this overlapping sweep.
  const a = Array.from({ length: 2000 }, (_, i) => segment(-32, 0, i * 2));
  const b = Array.from({ length: 2000 }, (_, i) => segment(-32, 0, i * 2 + .5));
  const result = stitchBoundary(a, b, { axis: 'x', boundary: 0, lo: -32, hi: 0 });
  assert.equal(result.compatible, false);
  if (!result.compatible) assert.match(result.reason, /budget|limit/i);
});
