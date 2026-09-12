import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  CAVE_ENTRANCE_THRESHOLD, CAVE_SHAFT_BREACH_ENTR, World, cavePathPoint,
  MAT, type MatId, type ColumnData,
} from '@shared/worldgen';
import { CHUNK_SIZE, LOD2_STEP, PLAYER } from '@shared/constants';
import { rockProfile } from '@shared/index';
import { boulderGeometry } from '../src/render/rock-geometry.js';
import {
  meshColumnChunks, meshColumnWithPortals, meshEntrancePortals,
  partitionChunkMeshes, clipTerrainFoundations, type ChunkMesh,
} from '../src/render/surfacenets.js';

interface Vec3 { x: number; y: number; z: number }

function forTriangles(chunks: ChunkMesh[], visit: (
  p: Float32Array, n: Float32Array, i: number,
) => void, stride = 1): void {
  for (const c of chunks) {
    for (let i = 0; i + 8 < c.positions.length; i += 9 * stride) {
      visit(c.positions, c.normals, i);
    }
  }
}

function centroid(p: Float32Array, i: number): Vec3 {
  return {
    x: (p[i] + p[i + 3] + p[i + 6]) / 3,
    y: (p[i + 1] + p[i + 4] + p[i + 7]) / 3,
    z: (p[i + 2] + p[i + 5] + p[i + 8]) / 3,
  };
}

function boundarySegmentKeys(
  chunks: ChunkMesh[], axis: 'x' | 'z', boundary: number,
): Set<string> {
  const result = new Set<string>();
  const axisOffset = axis === 'x' ? 0 : 2;
  const otherOffset = axis === 'x' ? 2 : 0;
  // 1mm resolution: fine enough that any real seam gap still mismatches,
  // coarse enough that sub-millimeter hair-edges left by the footprint
  // clipper's epsilon collapse to a point and drop out via the va===vb
  // filter below instead of registering as one-sided phantom edges.
  const quantize = (value: number): number => Math.round(value * 1_000);
  forTriangles(chunks, (p, _n, i) => {
    for (const [a, b] of [[0, 3], [3, 6], [6, 0]] as const) {
      if (
        Math.abs(p[i + a + axisOffset] - boundary) > 1e-5 ||
        Math.abs(p[i + b + axisOffset] - boundary) > 1e-5
      ) continue;
      const va = `${quantize(p[i + a + 1])},${quantize(p[i + a + otherOffset])}`;
      const vb = `${quantize(p[i + b + 1])},${quantize(p[i + b + otherOffset])}`;
      if (va === vb) continue;
      result.add(va < vb ? `${va}|${vb}` : `${vb}|${va}`);
    }
  });
  return result;
}

test('triangle winding points toward canonical-field air', () => {
  const world = new World(1337);
  const g = { x: 0, y: 0, z: 0 };
  let agree = 0;
  let total = 0;
  let dotSum = 0;

  for (const [cx, cz] of [[1, -1], [3, 4], [0, 3]] as const) {
    forTriangles(meshColumnChunks(world, cx, cz, true), (p, n, i) => {
      const m = centroid(p, i);
      world.gradient(m.x, m.y, m.z, g);
      const dot = n[i] * g.x + n[i + 1] * g.y + n[i + 2] * g.z;
      total++;
      dotSum += dot;
      if (dot > 0) agree++;
    }, 3);
  }

  assert.ok(total > 5_000, `too few triangles (${total})`);
  assert.ok(agree / total > 0.995,
    `only ${(100 * agree / total).toFixed(2)}% of normals point into air`);
  assert.ok(dotSum / total > 0.95, `weak average alignment ${(dotSum / total).toFixed(3)}`);
});

test('coarse triangle clipping conserves area and interpolates exact 4x4 parts', () => {
  const positions = new Float32Array([
    -1, 0, -1, -1, 0, 5, 5, 0, 5,
    -1, 0, -1, 5, 0, 5, 5, 0, -1,
  ]);
  const normals = new Float32Array(positions.length);
  const colors = new Uint8Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    normals[i + 1] = 1;
    colors[i] = i * 3; colors[i + 1] = 50 + i; colors[i + 2] = 220 - i;
  }
  const packed = partitionChunkMeshes(
    [{ cy: 0, positions, normals, colors }], 0, 0, 4, 4,
  );
  assert.equal(packed.length, 1);
  const mesh = packed[0];
  assert.equal(mesh.partGrid, 4);
  assert.equal(mesh.partOffsets?.length, 17);
  let area = 0;
  let triangles = 0;
  let interpolatedColor = false;
  const originalColors = new Set(colors);
  for (let part = 0; part < 16; part++) {
    const px = part % 4, pz = Math.floor(part / 4);
    const lo = mesh.partOffsets![part], hi = mesh.partOffsets![part + 1];
    assert.ok(hi > lo, `flat square should occupy part ${part}`);
    for (let i = lo; i < hi; i += 9) {
      const ax = mesh.positions[i], az = mesh.positions[i + 2];
      const bx = mesh.positions[i + 3], bz = mesh.positions[i + 5];
      const cx = mesh.positions[i + 6], cz = mesh.positions[i + 8];
      for (const [x, z] of [[ax, az], [bx, bz], [cx, cz]]) {
        assert.ok(x >= px - 1e-6 && x <= px + 1 + 1e-6);
        assert.ok(z >= pz - 1e-6 && z <= pz + 1 + 1e-6);
      }
      const signed = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
      assert.ok(signed < -1e-9, 'clipping must preserve original winding');
      area += Math.abs(signed) * 0.5;
      triangles++;
      for (let j = i; j < i + 9; j++) {
        if (!originalColors.has(mesh.colors[j])) interpolatedColor = true;
      }
    }
  }
  assert.ok(triangles >= 32);
  assert.ok(Math.abs(area - 16) < 1e-5, `clipped area ${area} should equal parent area 16`);
  assert.equal(interpolatedColor, true);
});

test('a triangle coincident with a part boundary is emitted once', () => {
  const positions = new Float32Array([
    1, 0, 0.2, 1, 1, 0.5, 1, 0, 0.8,
  ]);
  const normals = new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0]);
  const colors = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const mesh = partitionChunkMeshes(
    [{ cy: 0, positions, normals, colors }], 0, 0, 4, 4,
  )[0];
  let occupied = 0;
  for (let part = 0; part < 16; part++) {
    if (mesh.partOffsets![part + 1] > mesh.partOffsets![part]) occupied++;
  }
  assert.equal(occupied, 1);
  assert.equal(mesh.positions.length, 9, 'boundary face must not be duplicated');
  assert.equal(mesh.partOffsets![1], 0);
  assert.equal(mesh.partOffsets![2], 9, 'x=1 plane belongs deterministically to x-part 1');
});

test('cave exposure follows clipped vertices without adding float-sized buffers', () => {
  const positions = new Float32Array([
    -1, 0, -1, -1, 0, 5, 5, 0, 5,
    -1, 0, -1, 5, 0, 5, 5, 0, -1,
  ]);
  const inputDepth = Uint8Array.from([0, 0, 120, 0, 120, 120]);
  const [mesh] = partitionChunkMeshes([{
    cy: 0, positions, normals: new Float32Array(positions.length),
    colors: new Uint8Array(positions.length), caveDepth: inputDepth,
  }], 0, 0, 4, 4);
  assert.ok(mesh.caveDepth instanceof Uint8Array);
  assert.equal(mesh.caveDepth.byteLength, mesh.positions.length / 3);
  for (let i = 0; i < mesh.caveDepth.length; i++) {
    const expected = Math.round((mesh.positions[i * 3] + 1) * 20);
    assert.ok(Math.abs(mesh.caveDepth[i] - expected) <= 1,
      `clipped vertex ${i} lost its interpolated cave depth`);
  }
});

test('foundation clipping removes exact triangle footprints and preserves fallback attributes', () => {
  const positions = new Float32Array([-2, 0, -2, -2, 0, 2, 2, 0, 2,
    -2, 0, -2, 2, 0, 2, 2, 0, -2]);
  const normals = Float32Array.from(positions, (_v, i) => i % 3 === 1 ? 1 : 0);
  const colors = Uint8Array.from(positions, (_v, i) => 60 + i * 7);
  const mesh = { cy: 0, positions, normals, colors, caveDepth: Uint8Array.from([0, 0, 80, 0, 80, 80]) };
  const plinth = { x: 0, y: -1, z: 0, hx: 1, hy: 1, hz: 1 };
  const owned = clipTerrainFoundations([mesh], [plinth]);
  for (const grid of [1, 4, 16]) {
    const chunks = partitionChunkMeshes(owned, -2, -2, 4, grid);
    let area = 0, crossing = 0;
    forTriangles(chunks, (p, n, i) => {
      const c = centroid(p, i);
      assert.ok(Math.abs(c.x) >= 1 - 1e-6 || Math.abs(c.z) >= 1 - 1e-6,
        'a triangle still occupies the exact floor footprint');
      const signed = (p[i + 3] - p[i]) * (p[i + 8] - p[i + 2]) -
        (p[i + 5] - p[i + 2]) * (p[i + 6] - p[i]);
      assert.ok(signed < 0, 'ownership clipping must retain winding');
      area -= signed / 2;
      for (let v = i; v < i + 9; v += 3) {
        assert.ok(Math.abs(Math.hypot(n[v], n[v + 1], n[v + 2]) - 1) < 1e-6);
        if (Math.abs(Math.abs(p[v]) - 1) < 1e-6 || Math.abs(Math.abs(p[v + 2]) - 1) < 1e-6) crossing++;
      }
    });
    assert.ok(Math.abs(area - 12) < 1e-5, `grid ${grid}: retained area ${area} instead of 12`);
    assert.ok(crossing > 0, 'crossing triangles must be clipped rather than dropped by centroid');
    for (const chunk of chunks) {
      assert.equal(chunk.colors.length, chunk.positions.length);
      assert.equal(chunk.caveDepth?.length, chunk.positions.length / 3);
      for (let v = 0; v < chunk.positions.length; v += 3) {
        assert.ok(Math.abs(chunk.caveDepth![v / 3] - (chunk.positions[v] + 2) * 20) <= 1,
          'clipped cave exposure must interpolate with the vertex');
      }
    }
  }
  // An underground floor owns only its floor band; roofs and lower rock
  // remain continuous even when they share the same horizontal footprint.
  for (const y of [-3, 8]) {
    const layer = { ...mesh, positions: Float32Array.from(positions, (v, i) => i % 3 === 1 ? y : v) };
    const kept = clipTerrainFoundations([layer], [{ ...plinth, underground: true }]);
    assert.deepEqual(kept[0].positions, layer.positions);
  }
});

test('real surface and underground plinths own their complete floor at every terrain LOD', () => {
  const world = new World(1337);
  const surface = world.collectStructures(-400, 400, -400, 400).sites[0];
  const deep = world.collectUndergroundSites(-400, 400, -400, 400)[0];
  assert.ok(surface && deep, 'the bounded fixture must contain both structure layers');
  for (const site of [surface, deep]) for (const step of [1, 4, 16]) {
    const width = CHUNK_SIZE * step;
    const chunks: ChunkMesh[] = [];
    for (let cx = Math.floor((site.x - 1) / width); cx <= Math.floor((site.x + 1) / width); cx++) {
      for (let cz = Math.floor((site.z - 1) / width); cz <= Math.floor((site.z + 1) / width); cz++) {
        chunks.push(...meshColumnChunks(world, cx, cz, !!site.underground || step < LOD2_STEP, step));
      }
    }
    const region = world.collectStructures(site.x, site.x, site.z, site.z);
    const foundation = region.foundations?.find((f) => f.x === site.x && f.z === site.z);
    assert.ok(foundation, 'every exact floor needs a terrain ownership volume');
    for (const dx of [-0.71, 0.29, 0.83]) for (const dz of [-0.61, 0.19, 0.79]) {
      const o = { x: site.x + dx, y: site.top + 0.1, z: site.z + dz };
      const hits: number[] = [];
      const hit = rayMeshHit(chunks, o, { x: 0, y: -1, z: 0 }, foundation.hy * 2 + 0.09, hits);
      assert.ok(hit !== null && Math.abs(hit - 0.1) < 1e-4,
        `step ${step}: the exact plinth must cover its floor at any viewing range`);
      assert.equal(hits.length, 1, `step ${step}: sampled terrain still duplicates the exact plinth floor`);
      assert.ok(world.sdf(o.x, site.top - 0.05, o.z) < 0,
        'the clipped terrain must be replaced by real authoritative cover');
    }
  }
});

test('the sampled foundation shoulder keeps terrain materials outside exact concrete faces', () => {
  class MaterialWorld extends World {
    override vertexColor(mat: MatId, _x: number, _y: number, _z: number, _col: ColumnData,
      out: { [i: number]: number }, offset: number): void {
      // Encode the selected material into the actual meshed vertex colors,
      // so the assertion inspects surviving clipped triangles, not a query spy.
      out[offset] = mat / 255; out[offset + 1] = out[offset + 2] = 0;
    }
  }
  const world = new MaterialWorld(1337);
  const site = world.collectStructures(-1900, 1900, -1900, 1900).sites.find((s) => s.kind === 8)!;
  assert.ok(site, 'the fixture needs a large plinth with an exposed terrain shoulder');
  const x = site.x + site.hx;
  const chunks = meshColumnChunks(world, Math.floor((x + 0.5) / CHUNK_SIZE), Math.floor(site.z / CHUNK_SIZE), true);
  let checked = 0;
  for (const chunk of chunks) for (let i = 0; i < chunk.positions.length; i += 9) {
    const m = centroid(chunk.positions, i);
    if (m.x <= x + 1e-5 || m.x >= x + 1.5 || Math.abs(m.z - site.z) >= site.hz ||
        m.y < site.top - 12 || m.y > site.top) continue;
    assert.notEqual(chunk.colors[i], MAT.CONCRETE,
      'the concrete material must end at the exact plinth, without a triangle fringe');
    checked++;
  }
  assert.ok(checked > 15, `only ${checked} exposed shoulder triangles were checked`);
});

test('real coarse meshes are clipped inside exact recursive fallback leaves', () => {
  const world = new World(1337);
  for (const step of [4, 16]) {
    const chunks = meshColumnChunks(world, 0, 0, step === 4, step);
    assert.equal(chunks.length, 1);
    const mesh = chunks[0];
    assert.equal(mesh.partGrid, step);
    assert.equal(mesh.partOffsets?.length, step * step + 1);
    const partSize = CHUNK_SIZE;
    for (let part = 0; part < step * step; part++) {
      const px = part % step, pz = Math.floor(part / step);
      for (let i = mesh.partOffsets![part]; i < mesh.partOffsets![part + 1]; i += 3) {
        const x = mesh.positions[i], z = mesh.positions[i + 2];
        assert.ok(x >= px * partSize - 1e-4 && x <= (px + 1) * partSize + 1e-4,
          `step ${step} part ${part} leaks x=${x}`);
        assert.ok(z >= pz * partSize - 1e-4 && z <= (pz + 1) * partSize + 1e-4,
          `step ${step} part ${part} leaks z=${z}`);
      }
    }
  }
});

test('LOD0 ghost triangles are clipped to exact metadata-free column footprints', () => {
  const world = new World(1337);
  for (const [cx, cz] of [
    [0, 0], [-1, 11], [-20, -2], [-9, -16], [3, 4],
  ] as const) {
    const chunks = meshColumnChunks(world, cx, cz, true);
    assert.ok(chunks.length > 0);
    const loX = cx * CHUNK_SIZE, hiX = loX + CHUNK_SIZE;
    const loZ = cz * CHUNK_SIZE, hiZ = loZ + CHUNK_SIZE;
    for (const chunk of chunks) {
      assert.equal(chunk.partGrid, undefined, 'LOD0 must not carry coarse part metadata');
      assert.equal(chunk.partOffsets, undefined, 'LOD0 must not carry coarse part metadata');
      for (let i = 0; i < chunk.positions.length; i += 3) {
        const x = chunk.positions[i], z = chunk.positions[i + 2];
        assert.ok(x >= loX - 1e-6 && x <= hiX + 1e-6,
          `column ${cx},${cz} leaks x=${x} outside [${loX},${hiX}]`);
        assert.ok(z >= loZ - 1e-6 && z <= hiZ + 1e-6,
          `column ${cx},${cz} leaks z=${z} outside [${loZ},${hiZ}]`);
      }
    }
  }
});

test('adjacent LOD0 columns produce identical clipped seam edges', () => {
  const world = new World(1337);
  for (const [cx, cz, axis] of [
    [0, 0, 'x'], [-1, 11, 'x'], [0, 0, 'z'], [-20, -2, 'z'],
  ] as const) {
    const nextCx = cx + (axis === 'x' ? 1 : 0);
    const nextCz = cz + (axis === 'z' ? 1 : 0);
    const boundary = (axis === 'x' ? cx + 1 : cz + 1) * CHUNK_SIZE;
    const a = boundarySegmentKeys(
      meshColumnChunks(world, cx, cz, true), axis, boundary,
    );
    const b = boundarySegmentKeys(
      meshColumnChunks(world, nextCx, nextCz, true), axis, boundary,
    );
    assert.ok(a.size > 20, `fixture ${cx},${cz} has too little ${axis}-seam geometry`);
    assert.deepEqual(a, b,
      `LOD0 ${axis}-seam ${cx},${cz} -> ${nextCx},${nextCz} is not watertight`);
  }
});

test('surface-only LOD2 does not pay the global cave-slab mesh cost', () => {
  const world = new World(1337);
  const surface = meshColumnChunks(world, 0, 0, false, 16);
  const withCaves = meshColumnChunks(world, 0, 0, true, 16);
  const bytes = (chunks: ChunkMesh[]): number => chunks.reduce((total, chunk) =>
    total + chunk.positions.byteLength + chunk.normals.byteLength +
    chunk.colors.byteLength + (chunk.partOffsets?.byteLength ?? 0), 0);
  const surfaceBytes = bytes(surface);
  const caveBytes = bytes(withCaves);
  assert.ok(surfaceBytes < caveBytes * 0.8,
    `surface LOD2 ${surfaceBytes}B did not avoid cave slab ${caveBytes}B`);
  assert.ok(surfaceBytes < 1_500_000,
    `representative surface-only LOD2 transfer is ${(surfaceBytes / 1e6).toFixed(2)}MB`);
});

test('coarse LODs sample the same canonical field as physics', () => {
  const world = new World(1337);
  for (const step of [4, 16]) {
    let checked = 0;
    let maxError = 0;
    for (const [cx, cz] of [[0, 0], [-1, 1], [0, 2]] as const) {
      const chunks = meshColumnChunks(world, cx, cz, step === 4, step);
      assert.ok(chunks.length > 0, `step ${step} column ${cx},${cz} should mesh`);
      forTriangles(chunks, (p, _n, i) => {
        const ax = p[i], ay = p[i + 1], az = p[i + 2];
        const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
        const c = centroid(p, i);
        for (const [x, y, z] of [
          [(ax + bx) * 0.5, (ay + by) * 0.5, (az + bz) * 0.5],
          [c.x, c.y, c.z],
        ]) {
          maxError = Math.max(maxError, Math.abs(world.sdf(x, y, z)));
          checked++;
        }
      }, 5);
    }
    assert.ok(checked > 2_000, `step ${step}: too few samples (${checked})`);
    assert.ok(maxError < step * 1.6,
      `step ${step} mesh is ${maxError.toFixed(2)} from the canonical field`);
  }
});

/** Topmost y where a vertical ray at (x,z) pierces the triangle soup. */
function rayDownHitY(chunks: ChunkMesh[], x: number, z: number): number | null {
  let best: number | null = null;
  forTriangles(chunks, (p, _n, i) => {
    const ax = p[i], az = p[i + 2];
    const bx = p[i + 3], bz = p[i + 5];
    const cx = p[i + 6], cz = p[i + 8];
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(den) < 1e-12) return;
    const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
    const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
    const wc = 1 - wa - wb;
    // Positions are Float32 triangle soup. A ray exactly on an ownership
    // edge can reconstruct a barycentric weight a few ulps below zero.
    if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) return;
    const y = wa * p[i + 1] + wb * p[i + 4] + wc * p[i + 7];
    if (best === null || y > best) best = y;
  });
  return best;
}

function pointSegmentDistance(
  x: number, z: number, ax: number, az: number, bx: number, bz: number,
): number {
  const dx = bx - ax, dz = bz - az;
  const den = dx * dx + dz * dz;
  const t = den < 1e-12 ? 0 :
    Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / den));
  return Math.hypot(x - (ax + dx * t), z - (az + dz * t));
}

/** Horizontal distance to triangle coverage at approximately one support Y. */
function renderedSupportDistance(
  chunks: ChunkMesh[], x: number, z: number, supportY: number, tolerance = 0.2,
): number {
  let best = Infinity;
  forTriangles(chunks, (p, _n, i) => {
    const v = [
      { x: p[i], y: p[i + 1], z: p[i + 2] },
      { x: p[i + 3], y: p[i + 4], z: p[i + 5] },
      { x: p[i + 6], y: p[i + 7], z: p[i + 8] },
    ];
    const minY = Math.min(v[0].y, v[1].y, v[2].y);
    const maxY = Math.max(v[0].y, v[1].y, v[2].y);
    // One 1m surface-net cell represents a sharp ledge. Its triangle may be
    // vertically rounded by most of a voxel while its horizontal footprint
    // is still well inside the player's support radius.
    const footprintYTolerance = 0.8;
    if (supportY < minY - footprintYTolerance ||
        supportY > maxY + footprintYTolerance) return;
    let projected = Infinity;
    for (let e = 0; e < 3; e++) {
      const a = v[e], b = v[(e + 1) % 3];
      projected = Math.min(projected, pointSegmentDistance(x, z, a.x, a.z, b.x, b.z));
    }
    const pax = v[0].x, paz = v[0].z, pbx = v[1].x, pbz = v[1].z;
    const pcx = v[2].x, pcz = v[2].z;
    const pden = (pbz - pcz) * (pax - pcx) + (pcx - pbx) * (paz - pcz);
    if (Math.abs(pden) > 1e-12) {
      const wa = ((pbz - pcz) * (x - pcx) + (pcx - pbx) * (z - pcz)) / pden;
      const wb = ((pcz - paz) * (x - pcx) + (pax - pcx) * (z - pcz)) / pden;
      if (wa >= 0 && wb >= 0 && wa + wb <= 1) projected = 0;
    }
    best = Math.min(best, projected);
    for (const level of [supportY - tolerance, supportY, supportY + tolerance]) {
      const points: { x: number; z: number }[] = [];
      for (let e = 0; e < 3; e++) {
        const a = v[e], b = v[(e + 1) % 3];
        if (Math.abs(a.y - level) < 1e-7) points.push({ x: a.x, z: a.z });
        if ((a.y < level) === (b.y < level) || Math.abs(b.y - a.y) < 1e-9) continue;
        const t = (level - a.y) / (b.y - a.y);
        points.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
      }
      if (points.length >= 2) {
        for (let k = 1; k < points.length; k++) {
          best = Math.min(best,
            pointSegmentDistance(x, z, points[0].x, points[0].z, points[k].x, points[k].z));
        }
      } else if (points.length === 1) {
        best = Math.min(best, Math.hypot(x - points[0].x, z - points[0].z));
      }
    }
    // Nearly horizontal triangles may sit wholly inside the tolerance slab.
    if (maxY - minY <= tolerance * 2) {
      for (let e = 0; e < 3; e++) {
        const a = v[e], b = v[(e + 1) % 3];
        best = Math.min(best, pointSegmentDistance(x, z, a.x, a.z, b.x, b.z));
      }
      const ax = v[0].x, az = v[0].z, bx = v[1].x, bz = v[1].z;
      const cx = v[2].x, cz = v[2].z;
      const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(den) > 1e-12) {
        const wa = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / den;
        const wb = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / den;
        if (wa >= 0 && wb >= 0 && wa + wb <= 1) best = 0;
      }
    }
  });
  return best;
}

function physicsSurfaceDistance(
  world: World, x: number, z: number, supportY: number, tolerance = 0.25,
): number {
  let best = Infinity;
  for (let ring = 0; ring <= 8; ring++) {
    const radius = PLAYER.RADIUS * ring / 8;
    const samples = ring === 0 ? 1 : 32;
    for (let i = 0; i < samples; i++) {
      const angle = i * Math.PI * 2 / samples;
      const sx = x + Math.cos(angle) * radius;
      const sz = z + Math.sin(angle) * radius;
      if (Math.abs(world.sdf(sx, supportY, sz)) <= tolerance) {
        best = Math.min(best, radius);
      }
    }
  }
  return best;
}

function meshNeighborhood(world: World, cx: number, cz: number, radius = 1): ChunkMesh[] {
  const chunks: ChunkMesh[] = [];
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      chunks.push(...meshColumnChunks(world, cx + dx, cz + dz, true));
    }
  }
  return chunks;
}

test('ghost-floor entrance witness has bidirectional capsule-support agreement', () => {
  const world = new World(1337);
  const x = -14.63519416436553;
  const z = 362.32794635549186;
  const chunks = meshNeighborhood(world, -1, 11);
  const physicsY = world.groundY(x, z);
  const renderedY = rayDownHitY(chunks, x, z);
  assert.ok(renderedY !== null, 'canonical support must have rendered coverage');
  assert.ok(Math.abs(renderedY - physicsY) < 0.1,
    `rendered support ${renderedY.toFixed(3)} vs physics ${physicsY.toFixed(3)}`);

  // A player is supported over a radius, not by an infinitesimal ray. Check
  // the whole collision footprint for both kinds of mismatch: physics-only
  // "air walking" and render-only ledges that can be walked through.
  const offsets: [number, number][] = [[0, 0]];
  for (const radius of [PLAYER.RADIUS * 0.5, PLAYER.RADIUS]) {
    for (let i = 0; i < 12; i++) {
      const angle = i * Math.PI / 6;
      offsets.push([Math.cos(angle) * radius, Math.sin(angle) * radius]);
    }
  }
  for (const [dx, dz] of offsets) {
    const sx = x + dx, sz = z + dz;
    const physics = world.groundY(sx, sz);
    const rendered = rayDownHitY(chunks, sx, sz);
    assert.ok(rendered !== null, `physics-only support at footprint offset ${dx},${dz}`);
    assert.ok(Math.abs(rendered - physics) < 0.18,
      `support mismatch ${Math.abs(rendered - physics).toFixed(3)}m at ${sx},${sz}`);
  }
});

test('adversarial terrain and instanced rock ledges agree within the player support footprint', () => {
  const world = new World(1337);
  const fixtures = [
    { x: -623.141162674427, z: -58.87050295829773 },
    { x: -276.3218433, z: -489.1202618 },
  ];
  for (const fixture of fixtures) {
    const cx = Math.floor(fixture.x / CHUNK_SIZE);
    const cz = Math.floor(fixture.z / CHUNK_SIZE);
    const chunks = meshNeighborhood(world, cx, cz);
    // Rocks now have a separate exact instanced owner. Include that owner's
    // real geometry in the support union, just as the browser scene does.
    for (const rock of world.collectBoulders(fixture.x - 40, fixture.x + 40, fixture.z - 40, fixture.z + 40)) {
      const variation = (rock.hx * 13.57 + rock.hz * 7.11) % 1;
      const family = Math.min(3, Math.floor(variation * 4));
      const geometry = boulderGeometry(family, true);
      const positions = new Float32Array(geometry.getAttribute('position').array);
      for (let i = 0; i < positions.length; i += 3) {
        let scale = 1;
        if (family === 0) {
          // Reconstruct the granite vertex shader's canonical radial surface.
          let lo = 0, hi = 2;
          for (let k = 0; k < 24; k++) {
            const mid = (lo + hi) / 2;
            if (rockProfile(positions[i] * mid, positions[i + 1] * mid, positions[i + 2] * mid, variation) < 0) lo = mid;
            else hi = mid;
          }
          scale = (lo + hi) / 2;
        }
        positions[i] = rock.x + positions[i] * scale * rock.hx;
        positions[i + 1] = rock.y + positions[i + 1] * scale * rock.hy;
        positions[i + 2] = rock.z + positions[i + 2] * scale * rock.hz;
      }
      chunks.push({ cy: 0, positions, normals: new Float32Array(positions.length), colors: new Uint8Array(positions.length) });
      geometry.dispose();
    }
    const physicsY = world.groundY(fixture.x, fixture.z);
    const renderedY = rayDownHitY(chunks, fixture.x, fixture.z);
    assert.ok(renderedY !== null);
    const physicsToMesh = renderedSupportDistance(
      chunks, fixture.x, fixture.z, physicsY,
    );
    assert.ok(physicsToMesh <= PLAYER.RADIUS,
      `physics support at ${fixture.x},${fixture.z} is ${physicsToMesh.toFixed(3)}m from its mesh`);
    const meshToPhysics = physicsSurfaceDistance(
      world, fixture.x, fixture.z, renderedY,
    );
    assert.ok(meshToPhysics <= PLAYER.RADIUS,
      `rendered ledge at ${fixture.x},${fixture.z} is ${meshToPhysics.toFixed(3)}m from physics`);
  }
});

test('randomized and seam support rays agree in both mesh-to-physics directions', () => {
  const world = new World(1337);
  let seed = 0x91e10da5;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  let checked = 0;
  let strict = 0;

  for (const [cx, cz] of [
    [-1, 11], [0, 0], [3, 4], [-4, -4], [-20, -2], [-9, -16],
  ] as const) {
    const chunks = meshNeighborhood(world, cx, cz);
    const check = (x: number, z: number): void => {
      const physics = world.groundY(x, z);
      const rendered = rayDownHitY(chunks, x, z);
      assert.ok(rendered !== null,
        `physics surface has no mesh support at ${x.toFixed(4)},${z.toFixed(4)}`);
      const error = Math.abs(rendered - physics);
      if (error < 0.2) {
        strict++;
      } else {
        const physicsToMesh = renderedSupportDistance(chunks, x, z, physics);
        assert.ok(physicsToMesh <= PLAYER.RADIUS,
          `physics ledge is ${physicsToMesh.toFixed(3)}m outside the rendered support footprint`);
        const meshToPhysics = physicsSurfaceDistance(world, x, z, rendered);
        assert.ok(meshToPhysics <= PLAYER.RADIUS,
          `rendered ledge y=${rendered.toFixed(3)} vs physics y=${physics.toFixed(3)} at ` +
          `${x.toFixed(4)},${z.toFixed(4)} is ${meshToPhysics.toFixed(3)}m from physics`);
      }
      checked++;
    };

    for (let i = 0; i < 32; i++) {
      check((cx + 0.03 + random() * 0.94) * CHUNK_SIZE,
        (cz + 0.03 + random() * 0.94) * CHUNK_SIZE);
    }
    // Probe both sides and exactly on ownership seams. A missing edge in
    // either neighbor used to turn into a physics-only strip.
    for (const e of [-1e-4, 0, 1e-4]) {
      for (const t of [0.17, 0.43, 0.71]) {
        check(cx * CHUNK_SIZE + e, (cz + t) * CHUNK_SIZE);
        check((cx + t) * CHUNK_SIZE, cz * CHUNK_SIZE + e);
      }
    }
  }
  assert.ok(checked >= 300);
  assert.ok(strict / checked > 0.9,
    `only ${(100 * strict / checked).toFixed(1)}% of non-adversarial rays agree exactly`);
});

test('graded entrances remain open and agree with physics in cave-rendering LODs', () => {
  const world = new World(1337);
  const site = world.collectCaveSites(0, 959, 0, 959)[0];
  assert.ok(site);
  const pts: { x: number; z: number; gy: number; h: number }[] = [];
  for (const forward of [18, 20, 22, 24]) {
    const path = cavePathPoint(site, forward);
    for (const side of [-1.5, 1.5]) {
      const x = path.x - site.dz * side, z = path.z + site.dx * side;
      const col = world.column(x, z);
      const gy = world.groundY(x, z);
      assert.ok(col.cave && col.cave.mouth > 0);
      pts.push({ x, z, gy, h: col.h });
    }
  }

  for (const step of [1, 4]) {
    const cache = new Map<string, ChunkMesh[]>();
    const tolerance = step === 1 ? 0.75 : step === 4 ? 2.5 : 12;
    for (const p of pts) {
      const tileW = CHUNK_SIZE * step;
      const cx = Math.floor(p.x / tileW), cz = Math.floor(p.z / tileW);
      const key = `${cx},${cz}`;
      let chunks = cache.get(key);
      if (!chunks) {
        chunks = meshColumnChunks(world, cx, cz, true, step);
        cache.set(key, chunks);
      }
      const hit = rayDownHitY(chunks, p.x, p.z);
      assert.ok(hit !== null, `step ${step}: hole in mesh above pit at ${p.x},${p.z}`);
      assert.ok(hit < p.h - 3,
        `step ${step}: pit capped at ${hit.toFixed(1)} (surface ${p.h.toFixed(1)})`);
      assert.ok(Math.abs(hit - p.gy) <= tolerance,
        `step ${step}: visible ground ${hit.toFixed(2)} vs physics ${p.gy.toFixed(2)}`);
    }
  }
});

/**
 * Count open (unpaired) interior mesh edges: the signature of a see-through
 * surface. Edges on the horizontal clip boundary are excluded - footprint
 * clipping legitimately leaves unpaired segments there, matched by the
 * neighboring column. Surface nets also emit legitimate non-manifold pinch
 * edges (count 3+), so only an edge used exactly once marks a hole.
 */
function openInteriorEdges(
  chunks: readonly ChunkMesh[],
  loX: number, hiX: number, loZ: number, hiZ: number,
): number {
  const counts = new Map<string, number>();
  const quantize = (v: number): number => Math.round(v * 10_000);
  const onClip = (x: number, z: number): boolean =>
    Math.abs(x - loX) < 1e-4 || Math.abs(x - hiX) < 1e-4 ||
    Math.abs(z - loZ) < 1e-4 || Math.abs(z - hiZ) < 1e-4;
  for (const c of chunks) {
    const p = c.positions;
    for (let i = 0; i + 8 < p.length; i += 9) {
      for (const [a, b] of [[0, 3], [3, 6], [6, 0]] as const) {
        const ax = p[i + a], az = p[i + a + 2];
        const bx = p[i + b], bz = p[i + b + 2];
        if (onClip(ax, az) && onClip(bx, bz)) continue;
        const ka = `${quantize(ax)},${quantize(p[i + a + 1])},${quantize(az)}`;
        const kb = `${quantize(bx)},${quantize(p[i + b + 1])},${quantize(bz)}`;
        const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  let open = 0;
  for (const n of counts.values()) if (n === 1) open++;
  return open;
}

/** Open-edge count of a packed coarse mesh, checked per exact 32m leaf. */
function openEdgesPerPart(
  chunks: readonly ChunkMesh[], baseX: number, baseZ: number,
): number {
  let open = 0;
  for (const c of chunks) {
    if (!c.partOffsets || !c.partGrid) continue;
    for (let part = 0; part < c.partGrid * c.partGrid; part++) {
      const lo = c.partOffsets[part], hi = c.partOffsets[part + 1];
      if (hi <= lo) continue;
      const loX = baseX + (part % c.partGrid) * CHUNK_SIZE;
      const loZ = baseZ + Math.floor(part / c.partGrid) * CHUNK_SIZE;
      open += openInteriorEdges(
        [{ cy: c.cy, positions: c.positions.subarray(lo, hi),
          normals: c.normals.subarray(lo, hi), colors: c.colors.subarray(lo, hi) }],
        loX, loX + CHUNK_SIZE, loZ, loZ + CHUNK_SIZE,
      );
    }
  }
  return open;
}

/** Footprint stats exactly as the mesher's 35x35 column cache sees them. */
function meshFootprintStats(
  world: World, cx: number, cz: number,
): { maxEntr: number; minH: number } {
  let maxEntr = 0;
  let minH = Infinity;
  for (let sx = -1; sx <= CHUNK_SIZE + 1; sx++) {
    for (let sz = -1; sz <= CHUNK_SIZE + 1; sz++) {
      const c = world.column(cx * CHUNK_SIZE + sx, cz * CHUNK_SIZE + sz);
      maxEntr = Math.max(maxEntr, c.entr);
      minH = Math.min(minH, c.h);
    }
  }
  return { maxEntr, minH };
}

test('cave-mouth columns mesh their full bands instead of open tubes', () => {
  const world = new World(1337);
  const sites = world.collectCaveSites(-320, 319, -320, 319).slice(0, 3);
  const rims = sites.map((site) => {
    const p = cavePathPoint(site, 22);
    return { cx: Math.floor(p.x / CHUNK_SIZE), cz: Math.floor(p.z / CHUNK_SIZE) };
  });
  const tiles = new Map<string, { tx: number; tz: number }>();
  for (const { cx, cz } of rims) {
    const stats = meshFootprintStats(world, cx, cz);
    assert.ok(
      stats.maxEntr > CAVE_SHAFT_BREACH_ENTR,
      `fixture ${cx},${cz} lost its cave mouth`,
    );
    const chunks = meshColumnChunks(world, cx, cz, false, 1);
    const loX = cx * CHUNK_SIZE, loZ = cz * CHUNK_SIZE;
    assert.equal(
      openInteriorEdges(chunks, loX, loX + CHUNK_SIZE, loZ, loZ + CHUNK_SIZE), 0,
      `rim column ${cx},${cz} still has see-through boundary edges`,
    );
    let minY = Infinity;
    for (const c of chunks) {
      for (let i = 1; i < c.positions.length; i += 3) {
        if (c.positions[i] < minY) minY = c.positions[i];
      }
    }
    assert.ok(minY < stats.minH - 10,
      `rim column ${cx},${cz} did not extend its band into the cave layer ` +
      `(mesh bottom ${minY.toFixed(1)} vs surface ${stats.minH.toFixed(1)})`);
    const tx = Math.floor(cx / 4), tz = Math.floor(cz / 4);
    tiles.set(`${tx},${tz}`, { tx, tz });
  }
  // The containing LOD1 tiles must be watertight inside every exact 32m
  // fallback leaf as well - these are what the mid-distance ring displays.
  for (const { tx, tz } of tiles.values()) {
    const tile = meshColumnChunks(world, tx, tz, false, 4);
    assert.equal(openEdgesPerPart(tile, tx * 128, tz * 128), 0,
      `LOD1 tile ${tx},${tz} has see-through leaves`);
  }
});

test('cave rooms crossing a surface band floor are capped, not see-through', () => {
  const world = new World(1337);
  // Fixtures with no entrance anywhere near (footprint entr is ~0) whose
  // sealed cave rooms still cross the bottom of the meshed surface band.
  // Only the band-floor cap seals these; the entr-driven band extension can
  // never fire for them.
  const rooms = [
    { cx: -100, cz: -82 },
    { cx: -100, cz: -1 },
  ];
  for (const { cx, cz } of rooms) {
    const stats = meshFootprintStats(world, cx, cz);
    assert.ok(stats.maxEntr <= CAVE_SHAFT_BREACH_ENTR,
      `fixture ${cx},${cz} gained an entrance (${stats.maxEntr.toFixed(3)})`);
    // Pre-fix sampled floor of the bottom chunk: air straddling it renders
    // as an open tube unless the cap seals the band bottom.
    const sampleFloor =
      Math.floor((stats.minH - 3) / CHUNK_SIZE) * CHUNK_SIZE - 1;
    let straddles = false;
    for (let ox = 2; ox < CHUNK_SIZE && !straddles; ox += 4) {
      for (let oz = 2; oz < CHUNK_SIZE && !straddles; oz += 4) {
        const x = cx * CHUNK_SIZE + ox, z = cz * CHUNK_SIZE + oz;
        if (world.sdf(x, sampleFloor + 0.8, z) > 0.3 &&
            world.sdf(x, sampleFloor - 0.8, z) > 0.3) straddles = true;
      }
    }
    assert.ok(straddles, `fixture ${cx},${cz} lost its band-crossing room`);
    const chunks = meshColumnChunks(world, cx, cz, false, 1);
    const loX = cx * CHUNK_SIZE, loZ = cz * CHUNK_SIZE;
    assert.equal(
      openInteriorEdges(chunks, loX, loX + CHUNK_SIZE, loZ, loZ + CHUNK_SIZE), 0,
      `room column ${cx},${cz} still has see-through boundary edges`,
    );
  }
});

test('surface-only LOD2 seals far entrance pits instead of showing sky', () => {
  const world = new World(1337);
  const site = world.collectCaveSites(0, 959, 0, 959)[0];
  const path = cavePathPoint(site, 24);
  const pit = { x: path.x, z: path.z, h: world.column(path.x, path.z).h };
  assert.ok(world.groundY(pit.x, pit.z) < pit.h - 3, 'the graded mouth must open below its terrain envelope');

  const tileW = CHUNK_SIZE * LOD2_STEP;
  const chunks = meshColumnChunks(
    world, Math.floor(pit.x / tileW), Math.floor(pit.z / tileW), false, LOD2_STEP,
  );
  const hit = rayDownHitY(chunks, pit.x, pit.z);
  assert.ok(hit !== null, 'sky is visible through a far LOD2 entrance tube');
  assert.ok(hit <= pit.h + LOD2_STEP * 1.6,
    `LOD2 cap floats ${hit.toFixed(1)} above the local surface ${pit.h.toFixed(1)}`);
});

test('no column below the exported breach bound has a broken crust', () => {
  const world = new World(1337);
  assert.ok(CAVE_SHAFT_BREACH_ENTR > 0);
  assert.ok(CAVE_SHAFT_BREACH_ENTR < CAVE_ENTRANCE_THRESHOLD);
  let checked = 0;
  for (const site of world.collectCaveSites(-640, 639, -640, 639)) {
    for (let forward = site.mouthLength + 2; forward <= 72; forward += 4) {
      const { x, z } = cavePathPoint(site, forward);
      const col = world.column(x, z);
      assert.ok(col.entr < CAVE_SHAFT_BREACH_ENTR);
      assert.ok(world.sdf(x, col.h - 0.5, z) < 0,
        `roofed gallery gained an unintended crust opening at ${x},${z}`);
      checked++;
    }
  }
  assert.ok(checked > 50, `too few near-bound samples (${checked})`);
});

/** Closest double-sided triangle hit along a normalized ray. */
function rayMeshHit(chunks: ChunkMesh[], o: Vec3, d: Vec3, maxDist: number, hits?: number[]): number | null {
  let best = maxDist;
  forTriangles(chunks, (p, _n, i) => {
    const e1x = p[i + 3] - p[i], e1y = p[i + 4] - p[i + 1], e1z = p[i + 5] - p[i + 2];
    const e2x = p[i + 6] - p[i], e2y = p[i + 7] - p[i + 1], e2z = p[i + 8] - p[i + 2];
    const hx = d.y * e2z - d.z * e2y;
    const hy = d.z * e2x - d.x * e2z;
    const hz = d.x * e2y - d.y * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-9) return;
    const inv = 1 / det;
    const sx = o.x - p[i], sy = o.y - p[i + 1], sz = o.z - p[i + 2];
    const u = inv * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) return;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = inv * (d.x * qx + d.y * qy + d.z * qz);
    if (v < 0 || u + v > 1) return;
    const t = inv * (e2x * qx + e2y * qy + e2z * qz);
    if (t > 0.02 && t < maxDist) {
      if (t < best) best = t;
      hits?.push(t);
    }
  });
  return best < maxDist ? best : null;
}

test('exterior entrance rays see meshed cave walls instead of sky beyond the near ring', () => {
  const world = new World(1337);
  // An open mountain mouth looks past the 128m near ring into a continuing
  // gallery. Exterior cameras must retain that distant interior coverage.
  const origin = { x: -326.72387017637664, y: 133.51539917679048, z: -475.0634609002367 };
  const rays = [
    { x: -0.9694584179118516, y: -0.23267002029884437, z: -0.07755667343294813 },
  ];
  assert.equal(world.roofedAbove(origin.x, origin.y, origin.z), false);
  const terrain = meshColumnChunks(world, -4, -4, true, 4);
  const cap = meshEntrancePortals(world, -4, -4, 4);
  const proxies = [{ cy: 0, positions: cap.positions, normals: new Float32Array(cap.positions.length),
    colors: new Uint8Array(cap.positions.length) }];
  for (const ray of rays) {
    const physics = world.trace(origin.x, origin.y, origin.z, ray.x, ray.y, ray.z, 520);
    assert.ok(physics.hit && physics.dist > 128 && physics.dist < 240,
      `the fixture must reach beyond the near ring; trace distance ${physics.dist}`);
    const hit = rayMeshHit(terrain, origin, ray, 520);
    assert.ok(hit !== null && Math.abs(hit - physics.dist) < 8,
      `expected the ${physics.dist.toFixed(1)}m cave wall, rendered ${hit}`);
    const crossings: number[] = [];
    rayMeshHit(proxies, origin, ray, 520, crossings);
    crossings.sort((a, b) => a - b);
    const unique = crossings.filter((t, i) => i === 0 || t - crossings[i - 1] > 1e-3);
    assert.equal(unique.length, 1,
      'an exterior ray continuing underground must toggle its horizon parity once');
  }
  assert.equal(rayMeshHit(proxies, origin, { x: 0, y: 1, z: 0 }, 520), null,
    'ordinary outdoor sky must never receive a cave stencil mark');
});

test('roofed gallery rays retain real sky across the entire exit aperture at both cave LODs', () => {
  const world = new World(1337);
  const site = world.collectCaveSites(-640, -321, -640, -321)[0];
  assert.ok(site);
  const origin = cavePathPoint(site, 35);
  origin.y += 1.7;
  assert.equal(world.roofedAbove(origin.x, origin.y, origin.z), true);
  const rays: Vec3[] = [];
  for (const slope of [0.3, 0.4, 0.5, 0.7, 0.9]) {
    for (const side of [-0.2, 0, 0.2]) {
      const x = -site.dx - site.dz * side, z = -site.dz + site.dx * side;
      const length = Math.hypot(x, slope, z);
      const ray = { x: x / length, y: slope / length, z: z / length };
      // Hillside headroom changes the upper silhouette of each entrance.
      // Test every actually visible ray rather than assuming high rays can
      // pass through the authoritative roof.
      if (world.trace(origin.x, origin.y, origin.z, ray.x, ray.y, ray.z, 150).hit) continue;
      rays.push(ray);
    }
  }
  assert.ok(rays.length >= 9, `the exit aperture supplies only ${rays.length} sky rays`);
  for (const step of [1, 4]) {
    const tile = CHUNK_SIZE * step;
    const proxies: ChunkMesh[] = [];
    for (let cz = Math.floor((site.z - 48) / tile); cz <= Math.floor((site.z + 48) / tile); cz++) {
      for (let cx = Math.floor((site.x - 48) / tile); cx <= Math.floor((site.x + 48) / tile); cx++) {
        const { positions } = meshEntrancePortals(world, cx, cz, step);
        proxies.push({ cy: 0, positions, normals: new Float32Array(positions.length),
          colors: new Uint8Array(positions.length) });
      }
    }
    for (const ray of rays) {
      const cap = rayMeshHit(proxies, origin, ray, 150);
      assert.ok(cap !== null,
        `step ${step} darkens a real exterior sky ray: ${JSON.stringify(ray)}`);
    }
    // Widening invisible caps must never punch sky through a genuine roof.
    const up = { x: 0, y: 1, z: 0 };
    const cap = rayMeshHit(proxies, origin, up, 150);
    assert.ok(cap !== null, 'conservative envelope should cover the roofed gallery too');
    const chunks = meshColumnChunks(world, Math.floor(origin.x / tile), Math.floor(origin.z / tile), true, step);
    const roof = rayMeshHit(chunks, origin, up, 150);
    assert.ok(roof !== null && roof < cap,
      `step ${step} must reject the roof cap using real rendered terrain depth (roof ${roof}, cap ${cap})`);
  }
});

test('terrain exposure keeps the open entrance in daylight and the gallery underground', () => {
  const world = new World(1337);
  const site = world.collectCaveSites(0, 959, 0, 959)[0];
  const columns = new Map<string, [number, number]>();
  for (const forward of [24, site.mouthLength + 14]) {
    const p = cavePathPoint(site, forward);
    const cx = Math.floor(p.x / CHUNK_SIZE), cz = Math.floor(p.z / CHUNK_SIZE);
    columns.set(`${cx},${cz}`, [cx, cz]);
  }
  const chunks = [...columns.values()].flatMap(([cx, cz]) => meshColumnChunks(world, cx, cz, true));
  let daylight = 0, underground = 0;
  for (const chunk of chunks) {
    assert.ok(chunk.caveDepth instanceof Uint8Array);
    assert.equal(chunk.caveDepth.length * 3, chunk.positions.length);
    for (let i = 0; i < chunk.positions.length; i += 9) {
      const m = centroid(chunk.positions, i);
      const col = world.column(m.x, m.z);
      if (!col.cave || Math.abs(m.y - col.cave.floor) > 0.2) continue;
      if (col.cave.mouth > 3 && col.h - m.y > 4) {
        assert.equal(chunk.caveDepth[i / 3], 0,
          'an open-air sloped apron must retain exterior fog');
        daylight++;
      } else if (col.cave.mouth < -8 && col.h - m.y > 8) {
        assert.ok(chunk.caveDepth[i / 3] >= 24);
        underground++;
      }
    }
  }
  assert.ok(daylight > 30 && underground > 30,
    `fixture must cover the transition: ${daylight} exterior, ${underground} interior faces`);
});

test('small ceiling faces shade downward without changing exterior facets', () => {
  const world = new World(1337);
  const site = world.collectCaveSites(-640, -321, -640, -321)[0];
  const origin = cavePathPoint(site, 35);
  const chunks = meshNeighborhood(world, Math.floor(origin.x / CHUNK_SIZE), Math.floor(origin.z / CHUNK_SIZE));
  const material = new THREE.MeshBasicMaterial();
  const meshes = chunks.map((chunk) => {
    for (const n of chunk.normals) assert.ok(Number.isFinite(n));
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(chunk.normals, 3));
    return new THREE.Mesh(geometry, material);
  });
  const camera = new THREE.Vector3(origin.x, origin.y + 1.7, origin.z);
  // Derive the roof witness from a generated gallery: road rerouting can
  // relocate entrances, while ceiling faces must still shade toward cave air.
  for (const d of [
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(.1, 1, .1).normalize(),
  ]) {
    const hit = new THREE.Raycaster(camera, d, 0, 50).intersectObjects(meshes)[0];
    assert.ok(hit?.face, 'the ceiling must remain closed');
    const normals = (hit.object as THREE.Mesh).geometry.getAttribute('normal');
    assert.ok(normals.getY(hit.face.a) < -0.2,
      'ceiling shading must face the cave air below, avoiding a bright sunlit sliver');
  }
  let exterior = 0;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.positions.length; i += 9) {
      if (chunk.caveDepth![i / 3] !== 0) continue;
      const p = chunk.positions;
      const a = new THREE.Vector3(p[i], p[i + 1], p[i + 2]);
      const b = new THREE.Vector3(p[i + 3], p[i + 4], p[i + 5]);
      const c = new THREE.Vector3(p[i + 6], p[i + 7], p[i + 8]);
      const flat = b.sub(a).cross(c.sub(a));
      if (flat.lengthSq() < 0.001) continue;
      flat.normalize();
      const shade = new THREE.Vector3(chunk.normals[i], chunk.normals[i + 1], chunk.normals[i + 2]);
      assert.ok(flat.dot(shade) > 0.999, 'exterior facets must retain geometric shading');
      exterior++;
    }
  }
  assert.ok(exterior > 100);
  for (const mesh of meshes) mesh.geometry.dispose();
  material.dispose();
});

test('entrance portal caps mark real shafts and retain exact LOD footprints', () => {
  const world = new World(1337);
  const site = world.collectCaveSites(0, 959, 0, 959)[0];
  const opening = cavePathPoint(site, 20);
  opening.y += 1.7;
  assert.ok(world.sdf(opening.x, opening.y, opening.z) > 0);
  assert.equal(world.roofedAbove(opening.x, opening.y, opening.z), false);

  for (const step of [1, 4]) {
    const tileW = CHUNK_SIZE * step;
    const cx = Math.floor(opening.x / tileW);
    const cz = Math.floor(opening.z / tileW);
    const portal = meshEntrancePortals(world, cx, cz, step);
    assert.ok(portal.positions.length > 0, `step ${step} omitted the entrance cap`);
    assert.equal(portal.positions.length % 9, 0);

    const proxy: ChunkMesh = {
      cy: 0,
      positions: portal.positions,
      normals: new Float32Array(portal.positions.length),
      colors: new Uint8Array(portal.positions.length),
    };
    const hit = rayMeshHit(
      [proxy],
      opening,
      { x: 0, y: 1, z: 0 },
      12,
    );
    assert.ok(hit !== null,
      `step ${step} cap does not intercept a visible shaft ray`);

    const loX = cx * tileW, hiX = loX + tileW;
    const loZ = cz * tileW, hiZ = loZ + tileW;
    for (let i = 0; i < portal.positions.length; i += 3) {
      assert.ok(portal.positions[i] >= loX - 1e-5 &&
        portal.positions[i] <= hiX + 1e-5);
      assert.ok(portal.positions[i + 2] >= loZ - 1e-5 &&
        portal.positions[i + 2] <= hiZ + 1e-5);
    }

    if (step === 1) {
      assert.equal(portal.partGrid, undefined);
      assert.equal(portal.partOffsets, undefined);
    } else {
      assert.equal(portal.partGrid, step);
      assert.equal(portal.partOffsets?.length, step * step + 1);
      assert.equal(portal.partOffsets?.[0], 0);
      assert.equal(
        portal.partOffsets?.[portal.partOffsets.length - 1],
        portal.positions.length,
      );
    }
  }

  const sealed = { x: -112, y: 2, z: -128 };
  assert.ok(world.column(sealed.x, sealed.z).entr <= CAVE_ENTRANCE_THRESHOLD);
  const sealedPortal = meshEntrancePortals(
    world,
    Math.floor(sealed.x / CHUNK_SIZE),
    Math.floor(sealed.z / CHUNK_SIZE),
  );
  const sealedProxy: ChunkMesh = {
    cy: 0,
    positions: sealedPortal.positions,
    normals: new Float32Array(sealedPortal.positions.length),
    colors: new Uint8Array(sealedPortal.positions.length),
  };
  assert.equal(
    rayMeshHit([sealedProxy], sealed, { x: 0, y: 1, z: 0 }, 150),
    null,
    'an enclosed cave direction must not receive an outside stencil mark',
  );
});

test('worker bundle reuses terrain column samples for entrance caps', () => {
  class CountingWorld extends World {
    columnCalls = 0;
    override column(x: number, z: number) {
      this.columnCalls++;
      return super.column(x, z);
    }
  }
  // This LOD1 fixture contains a strong entrance, so a passing test proves
  // actual cap generation—not merely the empty fast path—adds no noise calls.
  const terrainWorld = new CountingWorld(1337);
  const site = new World(1337).collectCaveSites(-640, -321, -640, -321)[0];
  const cx = Math.floor(site.x / (CHUNK_SIZE * 4)), cz = Math.floor(site.z / (CHUNK_SIZE * 4));
  meshColumnChunks(terrainWorld, cx, cz, true, 4);
  const bundleWorld = new CountingWorld(1337);
  const bundle = meshColumnWithPortals(bundleWorld, cx, cz, true, 4);
  assert.ok(bundle.portals.positions.length > 0);
  assert.equal(bundleWorld.columnCalls, terrainWorld.columnCalls,
    'portal generation must consume the terrain mesher’s existing 35x35 cache');
});

test('enclosed cave rays agree bidirectionally across ceilings and horizontal walls', () => {
  const world = new World(1337);
  const origin = { x: -112, y: 2, z: -128 };
  assert.ok(world.sdf(origin.x, origin.y, origin.z) > 0.5, 'fixture must be cave air');

  const chunks: ChunkMesh[] = [];
  for (let cz = -5; cz <= -3; cz++) {
    for (let cx = -5; cx <= -3; cx++) {
      chunks.push(...meshColumnChunks(world, cx, cz, true));
    }
  }
  const directions: Vec3[] = [
    { x: 0, y: 1, z: 0 },
    { x: 1, y: 0, z: 0 }, { x: -1, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: -1 },
  ];
  let seed = 0x51f15e;
  const random = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 0x1_0000_0000;
  };
  for (let i = 0; i < 24; i++) {
    const y = random() * 1.6 - 0.8;
    const angle = random() * Math.PI * 2;
    const h = Math.sqrt(1 - y * y);
    const d = { x: Math.cos(angle) * h, y, z: Math.sin(angle) * h };
    directions.push(d, { x: -d.x, y: -d.y, z: -d.z });
  }
  for (const d of directions) {
    const physics = world.trace(origin.x, origin.y, origin.z, d.x, d.y, d.z, 28);
    const rendered = rayMeshHit(chunks, origin, d, 28);
    assert.equal(rendered !== null, physics.hit,
      `mesh/physics hit parity differs toward ${JSON.stringify(d)}`);
    if (!physics.hit || rendered === null) continue;
    assert.ok(Math.abs(rendered - physics.dist) < 0.75,
      `mesh hit ${rendered.toFixed(2)} vs physics ${physics.dist.toFixed(2)} toward ${JSON.stringify(d)}`);
  }
});

test('cave floors vary instead of collapsing onto one global plane', () => {
  const world = new World(1337);
  const bins = new Map<number, number>();
  let count = 0;
  let minY = Infinity, maxY = -Infinity;

  // Columns chosen away from any entrance zone (footprint entrRaw < 0.05):
  // near entrances the floor envelope legitimately rises toward the surface,
  // which would starve this deep-floor census rather than disprove variance.
  for (const [cx, cz] of [
    [-42, -42], [-42, -40], [-42, -38],
    [-40, -42], [-40, -40], [-40, -38],
    [-38, -42], [-38, -40], [-38, -38],
  ] as const) {
    forTriangles(meshColumnChunks(world, cx, cz, true), (p, n, i) => {
      const m = centroid(p, i);
      if (m.y >= -27 || n[i + 1] <= 0.55) return;
      const bin = Math.round(m.y * 10);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
      minY = Math.min(minY, m.y);
      maxY = Math.max(maxY, m.y);
      count++;
    }, 5);
  }

  assert.ok(count > 1_000, `too few deep upward-facing floor samples (${count})`);
  assert.ok(maxY - minY > 3, `cave-floor height span is only ${(maxY - minY).toFixed(2)}m`);
  assert.ok(bins.size > 20, `cave floors occupy only ${bins.size} tenth-meter bands`);
  const dominant = Math.max(...bins.values());
  assert.ok(dominant / count < 0.25,
    `${(100 * dominant / count).toFixed(1)}% of cave floor lies on one 0.1m plane`);
});

test('meshing is deterministic', () => {
  const a = meshColumnChunks(new World(555), 2, 3, true);
  const b = meshColumnChunks(new World(555), 2, 3, true);
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].cy, b[i].cy);
    assert.deepEqual(a[i].positions, b[i].positions);
    assert.equal(a[i].partGrid, b[i].partGrid);
    assert.deepEqual(a[i].partOffsets, b[i].partOffsets);
  }
});
