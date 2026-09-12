import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { CavePOI, CavePropKind } from '@shared/encounters';
import { CaveLandmarkRenderer, CAVE_LANDMARK_LIMIT } from '../src/render/cave-landmarks.js';

function poi(index: number): CavePOI {
  const p = { x: index * 5, y: -30, z: 0 }, kinds: CavePropKind[] = ['shelter', 'rig', 'crystal', 'rack', 'beacon'];
  return { ...p, id: `0,0:${index}`, regionKey: '0,0', cave: true, kind: 'camp', weapon: 5,
    loot: { ...p, x: p.x + 7, id: `loot:${index}`, weapon: 5, cave: true }, returnPad: p,
    returnTarget: { ...p, y: 30 }, props: Array.from({ length: 4 }, (_, i) =>
      ({ ...p, x: p.x + i, kind: kinds[(index + i) % kinds.length], yaw: index * 0.4, scale: 1 })) };
}

test('dense cave landmarks keep five fixed draw pools and a bounded nearby discovery budget', () => {
  const field = { pads: [], pois: Array.from({ length: 500 }, (_, i) => poi(i)), revision: 1,
    stats: { cached: 9, wanted: 9, pending: null }, update: () => false };
  const renderer = new CaveLandmarkRenderer(field);
  assert.equal(renderer.group.children.length, 5);
  let triangles = 0;
  for (const object of renderer.group.children) {
    const mesh = object as THREE.InstancedMesh;
    assert.ok(mesh.geometry.getAttribute('color'), 'merged detail retains distinct metal, fabric and crystal colors');
    const perInstance = (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3;
    assert.ok(perInstance < 2000, 'landmark silhouettes stay inexpensive when instanced');
    triangles += perInstance;
  }
  assert.ok(triangles < 4500);
  for (const x of [0, 100, 500, 1000, 10000, 0]) {
    renderer.update(x, -28, 0);
    assert.ok(renderer.stats.discoveries <= CAVE_LANDMARK_LIMIT);
    assert.ok(renderer.stats.props <= CAVE_LANDMARK_LIMIT * 4);
    for (const object of renderer.group.children) {
      const mesh = object as THREE.InstancedMesh;
      assert.ok(mesh.count <= mesh.instanceMatrix.count);
      assert.ok(mesh.instanceMatrix.array.every(Number.isFinite));
    }
    if (x === 10000) assert.equal(renderer.stats.props, 0);
    else assert.equal(renderer.stats.discoveries, CAVE_LANDMARK_LIMIT);
  }
  renderer.dispose(); renderer.dispose(); renderer.update(0, -30, 0);
  assert.equal(renderer.group.children.length, 0);
});

test('landmark transforms remain at their sampled world roots over movement and worker progress', () => {
  const field = { pads: [], pois: [poi(0)], revision: 1,
    stats: { cached: 1, wanted: 9, pending: null }, update: () => false };
  const renderer = new CaveLandmarkRenderer(field), matrix = new THREE.Matrix4();
  renderer.update(23.9, -30, 0);
  const initial = new Map<string, number[]>();
  for (const object of renderer.group.children) {
    const mesh = object as THREE.InstancedMesh;
    if (mesh.count) { mesh.getMatrixAt(0, matrix); initial.set(mesh.name, matrix.elements.slice()); }
  }
  field.revision++;
  renderer.update(24.1, -24, 0);
  for (const object of renderer.group.children) {
    const mesh = object as THREE.InstancedMesh;
    if (mesh.count) { mesh.getMatrixAt(0, matrix); assert.deepEqual(matrix.elements, initial.get(mesh.name)); }
  }
  renderer.dispose();
});
