import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WildlifeModels } from '../src/render/wildlife.js';
import { CREATURE_DEFS } from '@shared/wildlife';
import { MAX_ENTITY_ID } from '@shared/entity-id';

test('all six wildlife species share bounded instance pools and release buffers', () => {
  const models = new WildlifeModels();
  const creatures = Array.from({ length: 70 }, (_, i) => ({ id: i, species: i % CREATURE_DEFS.length,
    x: i, y: 0, z: 0, yaw: 0, speed: 2, alert: false }));
  models.sync(creatures); models.update(1 / 60);
  assert.equal(models.count, 18);
  assert.equal(models.group.children.length, 12);
  let triangles = 0;
  for (const object of models.group.children) {
    const mesh = object as THREE.InstancedMesh;
    assert.ok(mesh.count <= 108);
    assert.ok(mesh.instanceMatrix.array.every(Number.isFinite));
    triangles += mesh.geometry.getAttribute('position').count / 3;
  }
  assert.ok(triangles < 12_000, 'six reusable species stay within a small static geometry budget');
  models.sync([]); models.update(1 / 60);
  assert.equal(models.count, 0);
  assert.ok(models.group.children.every(object => (object as THREE.InstancedMesh).count === 0));
  models.dispose(); assert.equal(models.group.children.length, 0);
});

test('runner birds have two feet, arthropods six, and stopped snapshots stop locomotion', () => {
  const models = new WildlifeModels();
  const creatures = CREATURE_DEFS.map((_def, species) => ({ id: species + 1, species,
    x: species * 3, y: 0, z: 0, yaw: 0, speed: 7, alert: false }));
  models.sync(creatures); models.update(.1);
  const limbs = models.group.children.slice(CREATURE_DEFS.length) as THREE.InstancedMesh[];
  assert.deepEqual(limbs.map(mesh => mesh.count), [4, 4, 6, 2, 4, 6]);
  const before = limbs.map(mesh => mesh.instanceMatrix.array.slice());
  for (let i = 0; i < 10; i++) models.update(.1);
  for (let i = 0; i < limbs.length; i++) assert.deepEqual(limbs[i].instanceMatrix.array, before[i],
    'a stale speed field cannot animate stationary feet');
  models.dispose();
});

test('maximum-width entity IDs retain distinct tracks and animate small steps without precision loss', () => {
  const models = new WildlifeModels();
  try {
    const creatures = [MAX_ENTITY_ID - 1, MAX_ENTITY_ID].map((id, i) => ({ id, species: 0, x: i * 3, y: 0, z: 0, yaw: 0, speed: 1, alert: false }));
    models.sync(creatures); models.update(1 / 60);
    const tracks = (models as unknown as { tracks: Map<number, { phase: number }> }).tracks;
    assert.equal(tracks.size, 2);
    const before = creatures.map(c => tracks.get(c.id)!.phase);
    assert.ok(before.every(phase => phase >= 0 && phase < Math.PI * 2));
    models.sync(creatures.map(c => ({ ...c, x: c.x + .04 }))); models.update(1 / 60);
    for (let i = 0; i < creatures.length; i++) {
      const after = tracks.get(creatures[i].id)!.phase;
      assert.ok(after > before[i] && after - before[i] < .25, 'sub-frame foot movement must advance the animation phase');
    }
  } finally { models.dispose(); }
});
