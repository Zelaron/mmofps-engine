import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VEGETATION_KIND, type VegetationPlacement } from '@shared/worldgen';
import { VegetationRenderer, MAX_VEGETATION_VISUALS, VEGETATION_NEAR_BUDGET } from '../src/render/vegetation.js';

function tree(x: number, z: number, height = 69): VegetationPlacement {
  return { x, y: 13, z, height, radius: 3.4, canopyRadius: 19,
    yaw: .37, kind: VEGETATION_KIND.BROADLEAF, rainforest: true };
}
function pool(renderer: VegetationRenderer, name: string): THREE.InstancedMesh {
  const mesh = renderer.group.getObjectByName(name);
  assert.ok(mesh instanceof THREE.InstancedMesh); return mesh;
}

test('giant rainforest trunks retain canonical support, height and girth across near/far transitions', () => {
  const placement = tree(8, 8, 80), renderer = new VegetationRenderer({ collectVegetation: () => [placement] });
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
  for (const [cameraX, name] of [[0, 'vegetation-woody-stems'], [384, 'vegetation-far-stems']] as const) {
    renderer.update(cameraX, 0);
    const stems = pool(renderer, name); assert.equal(stems.count, 1);
    stems.getMatrixAt(0, matrix); matrix.decompose(position, rotation, scale);
    assert.ok(Math.abs(position.y - scale.y / 2 - placement.y) < .00001);
    assert.ok(Math.abs(position.y + scale.y / 2 - placement.y - placement.height) < .00001);
    assert.ok(Math.abs(scale.x - placement.radius) < .00001 && Math.abs(scale.z - placement.radius) < .00001);
    const crowns = pool(renderer, cameraX ? 'vegetation-far-broadleaf' : 'vegetation-broadleaf-canopies');
    assert.equal(crowns.count, 1); crowns.getMatrixAt(0, matrix); matrix.decompose(position, rotation, scale);
    assert.ok(scale.y < Math.max(scale.x, scale.z) * .7, 'rainforest giant lost its broad flat canopy');
  }
  renderer.dispose();
});

test('a dense rainforest obeys the4096-tree ceiling and fixed branch/canopy pools', () => {
  const placements = Array.from({ length: 5000 }, (_, i) => tree(1 + i % 80, 1 + Math.floor(i / 80), 36 + i % 34));
  const renderer = new VegetationRenderer({ collectVegetation: () => placements }, {
    maxInstances: 100_000, nearDistance: 10_000, nearBudget: 100_000,
  });
  renderer.update(0, 0);
  assert.equal(renderer.count, MAX_VEGETATION_VISUALS);
  assert.equal(renderer.group.children.length, 12);
  const near = pool(renderer, 'vegetation-woody-stems'), far = pool(renderer, 'vegetation-far-stems');
  assert.equal(near.count, VEGETATION_NEAR_BUDGET);
  assert.equal(near.count + far.count, MAX_VEGETATION_VISUALS);
  const branches = pool(renderer, 'vegetation-broadleaf-branches');
  assert.equal(branches.count, VEGETATION_NEAR_BUDGET * 8);
  assert.ok(pool(renderer, 'vegetation-broadleaf-lobes').count <= VEGETATION_NEAR_BUDGET * 4);
  for (const child of renderer.group.children) {
    const mesh = child as THREE.InstancedMesh;
    assert.ok(mesh.count <= mesh.instanceMatrix.count, `${mesh.name} exceeds its allocated GPU pool`);
    assert.ok(Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16)).every(Number.isFinite));
  }
  renderer.dispose();
});
