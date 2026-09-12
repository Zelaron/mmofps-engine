import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InstancedMesh } from 'three';
import { ResourceModels } from '../src/render/resources.js';
import type { ResourceSnapshot } from '@shared/resources';

test('xenolite models switch between full and depleted crystals with bounded shared geometry', () => {
  const models = new ResourceModels();
  const state: ResourceSnapshot = { enabled: true, target: '', saving: false, progress: 0, reason: '',
    nodes: Array.from({ length: 9 }, (_, i) => ({ id: `${i},0`, x: i * 128 + 24, y: 10, z: 64, remaining: i < 4 ? 0 : 180 })) };
  models.receive(state);
  const meshes = models.group.children as InstancedMesh[];
  assert.deepEqual(meshes.map(m => m.count), [9, 20, 25]);
  assert.equal(new Set(meshes.map(m => m.geometry)).size, 2);
  for (const mesh of meshes) assert.ok(Array.from(mesh.instanceMatrix.array).every(Number.isFinite));
  models.clear(); assert.ok(meshes.every(m => m.count === 0));
  let disposed = 0; for (const geometry of new Set(meshes.map(m => m.geometry))) geometry.addEventListener('dispose', () => disposed++);
  models.dispose(); assert.equal(disposed, 2);
});
