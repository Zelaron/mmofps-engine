import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { type ColumnData } from '@shared/index';
import { GroundCoverRenderer, MAX_GROUND_COVER_VISUALS } from '../src/render/ground-cover.js';

function source(overrides: Partial<ColumnData> = {}) {
  let queries = 0;
  let columnQueries = 0;
  return {
    seed: 71,
    get queries() { return queries; },
    get columnQueries() { return columnQueries; },
    column() {
      columnQueries++;
      return { h: 12, temp: 0.75, moist: 0.8, desert: 0, entr: 0,
        entrRaw: 0, volc: 0, lavaY: -1000, ...overrides };
    },
    collectStructures() {
      queries++;
      return { sites: [], solids: [], cuts: [],
        pads: [{ x: 12, y: 12, z: 8, hx: 5, hy: 1, hz: 5 }] };
    },
  };
}

test('ground cover stays deterministic, capped and clear of structure aprons', () => {
  const world = source();
  const a = new GroundCoverRenderer(world);
  const b = new GroundCoverRenderer(source());
  assert.equal(a.update(Number.NaN, 0), false);
  assert.equal(a.update(0, 0), true);
  b.update(0, 0);
  assert.equal(a.group.children.length, 2);
  assert.ok(a.count > 200 && a.count <= MAX_GROUND_COVER_VISUALS);
  let allocated = 0;
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  for (const mesh of a.group.children) {
    assert.ok(mesh instanceof THREE.InstancedMesh);
    allocated += mesh.instanceMatrix.count;
    const twin = b.group.getObjectByName(mesh.name) as THREE.InstancedMesh;
    assert.equal(mesh.count, twin.count);
    assert.deepEqual(mesh.instanceMatrix.array, twin.instanceMatrix.array);
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix);
      assert.ok(Math.abs(position.x - 12) > 7 || Math.abs(position.z - 8) > 7,
        'cosmetic grass must not grow through building aprons');
    }
    const version = mesh.instanceMatrix.version;
    a.animate(12);
    assert.equal(mesh.instanceMatrix.version, version);
  }
  assert.equal(allocated, MAX_GROUND_COVER_VISUALS);
  assert.equal(a.update(15.9, 15.9), false);
  assert.equal(world.queries, 1, 'same-cell movement must not resample the world');
  assert.equal(a.update(16, 16), true);
  assert.equal(world.queries, 2);
  a.dispose();
  a.dispose();
  b.dispose();
  assert.equal(a.count, 0);
  assert.equal(a.group.children.length, 0);
  assert.equal(a.update(100, 100), false);
});

test('ground cover rejects lava, volcanic ground and cave entrance columns', () => {
  for (const override of [{ lavaY: 12 }, { volc: 0.8 }, { entr: 0.9 }]) {
    const renderer = new GroundCoverRenderer(source(override));
    renderer.update(0, 0);
    assert.equal(renderer.count, 0);
    renderer.dispose();
  }
});

test('overlapping ground-cover cells reuse samples and discard old traversal history', () => {
  for (const overrides of [{}, { volc: 0.8 }]) {
    const world = source(overrides);
    const renderer = new GroundCoverRenderer(world);
    renderer.update(0, 0);
    const initialQueries = world.columnQueries;
    const initialMatrices = renderer.group.children.map((mesh) => {
      const pool = mesh as THREE.InstancedMesh;
      return Array.from(pool.instanceMatrix.array.slice(0, pool.count * 16));
    });
    renderer.update(16, 0);
    const adjacentQueries = world.columnQueries - initialQueries;
    assert.ok(adjacentQueries > 0 && adjacentQueries < initialQueries * 0.30,
      'a 16m move must sample only the entering edge, including rejected cells');
    for (let step = 2; step <= 48; step++) {
      renderer.update(step * 16, 0);
    }
    const beforeReturn = world.columnQueries;
    renderer.update(0, 0);
    assert.equal(world.columnQueries - beforeReturn, initialQueries,
      'departed cells must be evicted rather than retaining unbounded traversal history');
    renderer.group.children.forEach((mesh, i) => {
      const pool = mesh as THREE.InstancedMesh;
      assert.deepEqual(Array.from(pool.instanceMatrix.array.slice(0, pool.count * 16)), initialMatrices[i],
        'rebuilding evicted cells must restore the exact same placements');
    });
    renderer.dispose();
  }
});
