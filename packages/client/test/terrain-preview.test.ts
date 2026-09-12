import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAT, type World } from '@shared/index';
import { meshTerrainPreview, TerrainPreviewBuilder } from '../src/render/terrain-preview.js';

test('terrain preview has continuous exact ownership with only 121 cheap column samples', () => {
  let queries = 0;
  const world = {
    column(x: number, z: number) { queries++; return { h: 10 + x * 0.1 - z * 0.04 }; },
    material() { return MAT.GRASS; },
    vertexColor(_mat: number, _x: number, _y: number, _z: number, _col: unknown, color: number[]) {
      color[0] = 0.3; color[1] = 0.5; color[2] = 0.2;
    },
  } as unknown as World;
  for (const tx of [0, 1]) {
    const before = queries;
    const bundle = meshTerrainPreview(world, tx, -1);
    assert.equal(queries - before, 121, 'no SDF slabs, props, structures or spawn scans belong in emergency coverage');
    assert.equal(bundle.portals.positions.length, 0);
    assert.equal(bundle.chunks.length, 1);
    const chunk = bundle.chunks[0];
    assert.equal(chunk.partGrid, 16);
    assert.equal(chunk.caveDepth, undefined);
    assert.ok(chunk.positions.length / 9 <= 1024);
    const offsets = chunk.partOffsets!;
    for (let part = 0; part < 256; part++) {
      assert.ok(offsets[part + 1] > offsets[part], 'every leaf must have coverage');
      const bx = tx * 512 + (part % 16) * 32, bz = -512 + Math.floor(part / 16) * 32;
      for (let i = offsets[part]; i < offsets[part + 1]; i += 3) {
        const x = chunk.positions[i], y = chunk.positions[i + 1], z = chunk.positions[i + 2];
        assert.ok(x >= bx - 1e-5 && x <= bx + 32 + 1e-5 && z >= bz - 1e-5 && z <= bz + 32 + 1e-5);
        assert.ok(Math.abs(y - (10 + x * 0.1 - z * 0.04)) < 0.0001,
          'shared edges must retain the same sampled surface, including negative tile coordinates');
        assert.ok(chunk.normals[i + 1] > 0.99);
      }
    }
  }
});

test('incremental emergency previews yield after bounded samples and match worker geometry', () => {
  let queries = 0;
  const world = {
    column(x: number, z: number) { queries++; return {h: 20 + Math.sin(x / 200) * 20 + z / 100}; },
    material() { return MAT.GRASS; },
    vertexColor(_m: unknown, _x: unknown, _y: unknown, _z: unknown, _c: unknown, color: number[]) { color.fill(0.5); },
  } as unknown as World;
  const builder = new TerrainPreviewBuilder(world, -2, 3);
  let bundle;
  for (let i = 0; i < 16 && !bundle; i++) {
    const before = queries;
    bundle = builder.advance(Infinity, 8);
    assert.ok(queries - before <= 8);
  }
  assert.ok(bundle);
  assert.equal(queries, 121);
  assert.deepEqual(bundle, meshTerrainPreview(world, -2, 3));
  const before = queries;
  assert.equal(builder.advance(Infinity), bundle);
  assert.equal(queries, before, 'completion cannot resample or allocate again');
});
