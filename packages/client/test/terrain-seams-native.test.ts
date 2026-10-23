import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ray, Vector3 } from 'three';
import { CHUNK_SIZE } from '@shared/constants';
import { World, cavePathPoint } from '@shared/worldgen';
import { meshColumnChunks, type ChunkMesh } from '../src/render/surfacenets.js';
import {
  meshBoundary, stitchBoundary, type BoundaryMesh, type BoundaryPlane,
  type BoundarySegment, type SeamMesh,
} from '../src/render/terrain-seams.js';

/** Select the actual visible 32 m ownership part, not the entire parent tile. */
function coarsePart(chunks: readonly ChunkMesh[], x: number, z: number): BoundaryMesh[] {
  assert.ok(x >= 0 && x < 4 && z >= 0 && z < 4);
  return chunks.map(chunk => {
    assert.equal(chunk.partGrid, 4);
    assert.ok(chunk.partOffsets);
    const part = z * 4 + x, lo = chunk.partOffsets[part], hi = chunk.partOffsets[part + 1];
    return {
      positions: chunk.positions.subarray(lo, hi),
      colors: chunk.colors.subarray(lo, hi),
      caveDepth: chunk.caveDepth?.subarray(lo / 3, hi / 3),
    };
  });
}

interface Edge {
  name: string;
  plane: BoundaryPlane;
  negative: readonly BoundaryMesh[];
  positive: readonly BoundaryMesh[];
}

function interiorEdges(
  fine: readonly ChunkMesh[], coarse: readonly ChunkMesh[], cx: number, cz: number,
): Edge[] {
  const px = Math.floor(cx / 4), pz = Math.floor(cz / 4);
  const ix = cx - px * 4, iz = cz - pz * 4;
  const x = cx * CHUNK_SIZE, z = cz * CHUNK_SIZE;
  const edges: Edge[] = [];
  if (ix > 0) edges.push({ name: 'west',
    plane: { axis: 'x', boundary: x, lo: z, hi: z + CHUNK_SIZE },
    negative: coarsePart(coarse, ix - 1, iz), positive: fine });
  if (ix < 3) edges.push({ name: 'east',
    plane: { axis: 'x', boundary: x + CHUNK_SIZE, lo: z, hi: z + CHUNK_SIZE },
    negative: fine, positive: coarsePart(coarse, ix + 1, iz) });
  if (iz > 0) edges.push({ name: 'north',
    plane: { axis: 'z', boundary: z, lo: x, hi: x + CHUNK_SIZE },
    negative: coarsePart(coarse, ix, iz - 1), positive: fine });
  if (iz < 3) edges.push({ name: 'south',
    plane: { axis: 'z', boundary: z + CHUNK_SIZE, lo: x, hi: x + CHUNK_SIZE },
    negative: fine, positive: coarsePart(coarse, ix, iz + 1) });
  return edges;
}

/** Heights at a point strictly inside segment ranges; no contour sweep reuse. */
function crossingHeights(segments: readonly BoundarySegment[], u: number): number[] {
  return segments.filter(s => s.a.u < u && u < s.b.u)
    .map(s => s.a.y + (s.b.y - s.a.y) * ((u - s.a.u) / (s.b.u - s.a.u)))
    .sort((a, b) => b - a);
}

/** A short, back-face-culled ray straddles only this ownership plane. */
function crossesFace(
  meshes: readonly BoundaryMesh[], plane: BoundaryPlane, u: number, y: number,
  from: -1 | 1, reach = .0001,
): boolean {
  const origin = plane.axis === 'x'
    ? new Vector3(plane.boundary + from * reach, y, u)
    : new Vector3(u, y, plane.boundary + from * reach);
  const direction = plane.axis === 'x' ? new Vector3(-from, 0, 0) : new Vector3(0, 0, -from);
  const ray = new Ray(origin, direction);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), hit = new Vector3();
  for (const mesh of meshes) for (let i = 0; i < mesh.positions.length; i += 9) {
    a.fromArray(mesh.positions, i); b.fromArray(mesh.positions, i + 3); c.fromArray(mesh.positions, i + 6);
    if (ray.intersectTriangle(a, b, c, true, hit) && origin.distanceToSquared(hit) <= 4 * reach * reach)
      return true;
  }
  return false;
}

function checkBuffers(mesh: SeamMesh): void {
  assert.equal(mesh.positions.length % 9, 0);
  assert.equal(mesh.normals.length, mesh.positions.length);
  assert.equal(mesh.colors.length, mesh.positions.length);
  assert.equal(mesh.caveDepth?.length, mesh.positions.length / 3);
  assert.ok(mesh.positions.length / 9 <= 8192);
  assert.ok(mesh.positions.every(Number.isFinite));
}

test('native respawn tile closes real slits on all four mixed-detail ownership boundaries', t => {
  const world = new World(1337);
  const fine = meshColumnChunks(world, -91, 70, true, 1);
  const coarse = meshColumnChunks(world, -23, 17, false, 4);
  const edges = interiorEdges(fine, coarse, -91, 70);
  assert.equal(edges.length, 4);
  const evidence: { edge: string; gaps: number; operations: number; triangles: number }[] = [];
  for (const edge of edges) {
    const negative = meshBoundary(edge.negative, edge.plane);
    const positive = meshBoundary(edge.positive, edge.plane);
    assert.ok(negative.length > 0 && positive.length > 0, `${edge.name}: real neighboring contours`);
    const result = stitchBoundary(negative, positive, edge.plane);
    assert.equal(result.compatible, true, `${edge.name}: ${!result.compatible ? result.reason : ''}`);
    if (!result.compatible) continue;
    checkBuffers(result.mesh);
    assert.ok(result.operations <= 250_000);
    let gaps = 0;
    for (let i = 0; i < 32; i++) {
      // Avoid exact mesh vertices and compare the actual upper curves, not
      // sampled World heights, which need not coincide with either LOD.
      const u = edge.plane.lo + (i + .375) * (edge.plane.hi - edge.plane.lo) / 32;
      const a = crossingHeights(negative, u)[0], b = crossingHeights(positive, u)[0];
      if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) < .002) continue;
      const y = (a + b) / 2, from = a > b ? 1 : -1;
      // This must be a former hole through the actual retained terrain soup.
      assert.equal(crossesFace([...edge.negative, ...edge.positive], edge.plane, u, y, from), false,
        `${edge.name}: expected a former slit at ${u},${y}`);
      assert.equal(crossesFace([result.mesh], edge.plane, u, y, from), true,
        `${edge.name}: missing front face at ${u},${y}`);
      assert.equal(crossesFace([result.mesh], edge.plane, u, y, from === 1 ? -1 : 1), false,
        `${edge.name}: seam must face the open side`);
      gaps++;
    }
    assert.ok(gaps > 0, `${edge.name}: fixture must contain a measurable former slit`);
    evidence.push({ edge: edge.name, gaps, operations: result.operations, triangles: result.mesh.positions.length / 9 });
  }
  t.diagnostic(JSON.stringify(evidence));
});

test('a native mixed-detail cave passage stays open between its separate roof and floor contours', t => {
  const world = new World(1337);
  const site = world.collectCaveSites(-640, -321, -640, -321)[0];
  assert.ok(site);
  const point = cavePathPoint(site, 35);
  point.y += 1.7;
  assert.equal(world.roofedAbove(point.x, point.y, point.z), true);
  const cx = Math.floor(point.x / CHUNK_SIZE), cz = Math.floor(point.z / CHUNK_SIZE);
  const fine = meshColumnChunks(world, cx, cz, true, 1);
  const coarse = meshColumnChunks(world, Math.floor(cx / 4), Math.floor(cz / 4), true, 4);
  let sharedAir = 0, seamTriangles = 0, operations = 0;
  for (const edge of interiorEdges(fine, coarse, cx, cz)) {
    const negative = meshBoundary(edge.negative, edge.plane), positive = meshBoundary(edge.positive, edge.plane);
    const result = stitchBoundary(negative, positive, edge.plane);
    assert.equal(result.compatible, true, `${edge.name}: ${!result.compatible ? result.reason : ''}`);
    if (!result.compatible) continue;
    checkBuffers(result.mesh);
    assert.ok(result.operations <= 250_000);
    seamTriangles += result.mesh.positions.length / 9;
    operations += result.operations;
    for (let i = 0; i < 64; i++) {
      const u = edge.plane.lo + (i + .375) * (edge.plane.hi - edge.plane.lo) / 64;
      const a = crossingHeights(negative, u), b = crossingHeights(positive, u);
      // A genuine cavity needs an exterior surface, then a roof, then a
      // floor on BOTH installed sides; a top-height-only test cannot pass.
      if (a.length < 3 || b.length < 3) continue;
      for (let ai = 1; ai + 1 < a.length; ai += 2) for (let bi = 1; bi + 1 < b.length; bi += 2) {
        const roof = Math.min(a[ai], b[bi]), floor = Math.max(a[ai + 1], b[bi + 1]);
        if (roof - floor < 1 || Math.min(a[0], b[0]) - roof < .5) continue;
        const y = (roof + floor) / 2;
        const x = edge.plane.axis === 'x' ? edge.plane.boundary : u;
        const z = edge.plane.axis === 'z' ? edge.plane.boundary : u;
        if (world.sdf(x, y, z) <= .25) continue;
        assert.equal(crossesFace([result.mesh], edge.plane, u, y, -1), false,
          'a common native cave opening must not receive a west/north curtain');
        assert.equal(crossesFace([result.mesh], edge.plane, u, y, 1), false,
          'a common native cave opening must not receive an east/south curtain');
        sharedAir++;
      }
    }
  }
  assert.ok(sharedAir > 0, 'fixture must exercise a real native cavity crossing a mixed-detail edge');
  assert.ok(seamTriangles > 0, 'fixture must publish actual seam faces while retaining the cave aperture');
  t.diagnostic(JSON.stringify({ cx, cz, sharedAir, seamTriangles, operations }));
});
