import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ray, Vector3 } from 'three';
import type { StructureFoundation } from '@shared/index';
import { clipTerrainFoundations, partitionChunkMeshes, type ChunkMesh } from '../src/render/surfacenets.js';
import { meshBoundary, stitchBoundary, type BoundaryMesh, type BoundaryPlane, type BoundarySegment } from '../src/render/terrain-seams.js';
import { captureAuthoredSeamsSteps, finishAuthoredSeamsSteps } from '../src/render/terrain-authored-seams-worker.js';
import { validateAuthoredSeams, spliceAuthoredBoundary, AUTHORED_SEAM_LIMITS } from '../src/render/terrain-authored-seams.js';

function finish<T>(steps: Generator<void, T, void>): T {
  let step = steps.next(), yields = 0;
  while (!step.done) { assert.ok(++yields < 10_000, 'bounded synthetic generator completes'); step = steps.next(); }
  return step.value;
}
// The helper accepts the worker's yielding partitioner. Tests adapt the public
// exact partitioner without replacing its clipping, winding or packed offsets.
function* partition(chunks: readonly ChunkMesh[], x: number, z: number, width: number, grid: number): Generator<void, ChunkMesh[], void> {
  yield;
  return partitionChunkMeshes(chunks, x, z, width, grid);
}
function planeMesh(width = 128): ChunkMesh {
  const p = new Float32Array([0, 0, 0, 0, 0, width, width, 0, width, 0, 0, 0, width, 0, width, width, 0, 0]);
  const n = new Float32Array(p.length); for (let i = 1; i < n.length; i += 3) n[i] = 1;
  return { cy: 0, positions: p, normals: n, colors: new Uint8Array(p.length).fill(90), caveDepth: new Uint8Array(p.length / 3).fill(7) };
}
function boxMesh(box: StructureFoundation): ChunkMesh {
  const p: number[] = [], n: number[] = [], center = [box.x, box.y, box.z], half = [box.hx, box.hy, box.hz];
  // Same six finite faces and winding as appendFoundationMeshesSteps. Shading
  // normals deliberately oppose the faces, proving metadata uses triangle
  // cross products rather than trusting normals as orientation evidence.
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
      const point = [...center]; point[axis] = point[axis]! + sign * half[axis]!;
      point[u] = point[u]! + a! * half[u]!; point[v] = point[v]! + b! * half[v]!; return point;
    });
    for (const i of sign > 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2]) {
      p.push(...corners[i]!); n.push(axis === 0 ? -sign : 0, axis === 1 ? -sign : 0, axis === 2 ? -sign : 0);
    }
  }
  return { cy: 0, positions: new Float32Array(p), normals: new Float32Array(n),
    colors: new Uint8Array(p.length).fill(153), caveDepth: new Uint8Array(p.length / 3) };
}
const foundation: StructureFoundation = { x: 31, y: 1, z: 31, hx: 8.5, hy: 2, hz: 8.5 };
function fixture() {
  const raw = [planeMesh()], boxes = [{ ...foundation }];
  const column = { cx: 0, cz: 0, step: 4, bandFloor: -128, sealBelow: new Float32Array(35 * 35).fill(-8) };
  const final = partitionChunkMeshes([...clipTerrainFoundations(raw, boxes), boxMesh(boxes[0]!)], 0, 0, 128, 4);
  return { raw, boxes, column, final };
}
const copyMeshes = (meshes: readonly ChunkMesh[]) => meshes.map(m => {
  const copy = { ...m, positions: m.positions.slice(), normals: m.normals.slice(), colors: m.colors.slice() };
  if (m.caveDepth !== undefined) copy.caveDepth = m.caveDepth.slice();
  if (m.partOffsets !== undefined) copy.partOffsets = m.partOffsets.slice();
  return copy;
});
function leaf(meshes: readonly ChunkMesh[], x: number, z: number): BoundaryMesh[] {
  const index = z * 4 + x;
  return meshes.map(m => {
    const lo = m.partOffsets![index]!, hi = m.partOffsets![index + 1]!;
    return { positions: m.positions.subarray(lo, hi), colors: m.colors.subarray(lo, hi), caveDepth: m.caveDepth?.subarray(lo / 3, hi / 3) };
  });
}
const segment = (lo: number, hi: number, y: number): BoundarySegment => ({
  a: { u: lo, y, r: 80, g: 80, b: 80, depth: 0 }, b: { u: hi, y, r: 80, g: 80, b: 80, depth: 0 },
});
const heightsAt = (segments: readonly BoundarySegment[], u: number) => segments.filter(s => s.a.u < u && s.b.u > u)
  .map(s => s.a.y + (s.b.y - s.a.y) * (u - s.a.u) / (s.b.u - s.a.u)).sort((a, b) => a - b);
function rayHit(positions: Float32Array, x: number, y: number, z: number, direction: number): boolean {
  const ray = new Ray(new Vector3(x, y, z), new Vector3(direction, 0, 0));
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3();
  for (let i = 0; i < positions.length; i += 9)
    if (ray.intersectTriangle(a.fromArray(positions, i), b.fromArray(positions, i + 3), c.fromArray(positions, i + 6), true, hit)) return true;
  return false;
}

test('worker emits valid patches for both internal axes/sides, using actual clipped finite faces without changing any input attributes', () => {
  const f = fixture(), beforeRaw = copyMeshes(f.raw), beforeFinal = copyMeshes(f.final), beforeBoxes = structuredClone(f.boxes);
  const beforeSeal = f.column.sealBelow.slice();
  const capture = finish(captureAuthoredSeamsSteps(f.raw, f.boxes, f.column, partition)); assert.ok(capture);
  assert.equal(capture.unavailable, false); assert.equal(capture.belowSolid, true);
  const payload = finish(finishAuthoredSeamsSteps(capture, f.final)); assert.ok(payload);
  assert.equal(validateAuthoredSeams(payload, 0, 0, 4), true);
  const keys = Array.from({ length: payload.keys.length / 3 }, (_, i) => Array.from(payload.keys.slice(i * 3, i * 3 + 3)).join(','));
  assert.deepEqual(new Set(keys), new Set(['0,0,1', '1,0,0', '0,1,1', '1,1,0', '0,0,3', '0,1,2', '1,0,3', '1,1,2']));
  assert.equal(capture.stats.provedEdges, 8); assert.equal(capture.stats.omittedEdges, 0);
  assert.ok(capture.stats.outputSegments <= AUTHORED_SEAM_LIMITS.segments);
  assert.ok(capture.stats.scratchPeak <= AUTHORED_SEAM_LIMITS.scratchBytes, 'reported logical retained estimate stays within its limit');
  const plane: BoundaryPlane = { axis: 'x', boundary: 32, lo: 0, hi: 32 };
  const original = meshBoundary(leaf(f.final, 0, 0), plane);
  const repaired = spliceAuthoredBoundary(original, payload, 0, 0, plane);
  assert.deepEqual(heightsAt(original, 28), [-1, 3], 'ordinary box face soup retains its buried finite underside');
  assert.deepEqual(heightsAt(repaired, 28), [3], 'union omits only the buried face within the authored footprint');
  assert.deepEqual(heightsAt(repaired, 10), [0], 'outside the footprint the existing terrain is preserved');
  const across = spliceAuthoredBoundary(meshBoundary(leaf(f.final, 1, 0), plane), payload, 1, 0, plane);
  assert.deepEqual(heightsAt(across, 28), [3], 'both owners independently carry the shared internal plane');
  const higher = [segment(0, 32, 5)], oldSeam = stitchBoundary(original, higher, plane), joined = stitchBoundary(repaired, higher, plane);
  assert.equal(oldSeam.compatible, false); assert.equal(joined.compatible, true);
  if (joined.compatible) {
    assert.equal(rayHit(joined.mesh.positions, 31.99, 4, 28, 1), true, 'real seam front face covers the exposed side');
    assert.equal(rayHit(joined.mesh.positions, 32.01, 4, 28, -1), false, 'triangle winding is retained');
    assert.equal(rayHit(joined.mesh.positions, 31.99, -0.5, 28, 1), false, 'no invented curtain below the exposed foundation top');
  }
  assert.deepEqual(f.raw, beforeRaw); assert.deepEqual(f.final, beforeFinal);
  assert.deepEqual(f.boxes, beforeBoxes); assert.deepEqual(f.column.sealBelow, beforeSeal);
});

test('worker omits unproved lower-solid and over-cap enumeration instead of publishing partial foundation evidence', () => {
  const f = fixture(), raw = copyMeshes(f.raw), final = copyMeshes(f.final);
  for (const sealBelow of [new Float32Array(), new Float32Array([NaN]), new Float32Array([-256])]) {
    const capture = finish(captureAuthoredSeamsSteps(f.raw, f.boxes, { ...f.column, sealBelow }, partition));
    assert.ok(capture); assert.equal(capture.unavailable, true); assert.equal(capture.belowSolid, false);
    assert.equal(capture.edges.length, 0); assert.equal(finish(finishAuthoredSeamsSteps(capture, f.final)), undefined);
  }
  const huge = [{ ...foundation, x: 256, z: 256, hx: 256, hz: 256 }];
  const wide = { ...f.column, step: 16, bandFloor: -512 };
  const capped = finish(captureAuthoredSeamsSteps([planeMesh(512)], huge, wide, partition)); assert.ok(capped);
  assert.equal(capped.unavailable, true); assert.ok(capped.stats.enumeratedEdges > AUTHORED_SEAM_LIMITS.edges);
  assert.equal(capped.edges.length, 0); assert.equal(capped.stats.comparisons, 0, 'reject before retaining preclip triangles');
  assert.equal(finish(finishAuthoredSeamsSteps(capped, [])), undefined);
  assert.equal(finish(captureAuthoredSeamsSteps(f.raw, [], f.column, partition)), undefined);
  assert.deepEqual(f.raw, raw); assert.deepEqual(f.final, final);
});

test('cancelling either generator publishes no payload, including after one edge has been proved', () => {
  const f = fixture(), raw = copyMeshes(f.raw), final = copyMeshes(f.final), seal = f.column.sealBelow.slice();
  const early = captureAuthoredSeamsSteps(f.raw, f.boxes, f.column, partition);
  assert.equal(early.next().done, false);
  assert.deepEqual(early.return(undefined), { done: true, value: undefined });
  assert.deepEqual(early.next(), { done: true, value: undefined });

  const capture = finish(captureAuthoredSeamsSteps(f.raw, f.boxes, f.column, partition)); assert.ok(capture);
  const pending = finishAuthoredSeamsSteps(capture, f.final);
  let step = pending.next(), attempts = 0;
  while (!step.done && capture.stats.provedEdges === 0) {
    assert.ok(++attempts < 500); assert.equal(step.value, undefined, 'yields contain no partially publishable payload');
    step = pending.next();
  }
  assert.equal(step.done, false); assert.ok(capture.stats.provedEdges > 0);
  assert.deepEqual(pending.return(undefined), { done: true, value: undefined });
  assert.deepEqual(pending.next(), { done: true, value: undefined });
  assert.deepEqual(f.raw, raw); assert.deepEqual(f.final, final); assert.deepEqual(f.column.sealBelow, seal);
});
