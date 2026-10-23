import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WildlifeModels } from '../src/render/wildlife.js';
import { CREATURE_DEFS, MAX_VISIBLE_CREATURES } from '@shared/wildlife';
import { MAX_ENTITY_ID } from '@shared/entity-id';

test('planet rosters share bounded instance pools and release buffers', () => {
  const models = new WildlifeModels();
  const creatures = Array.from({ length: 70 }, (_, i) => ({ id: i, species: i % CREATURE_DEFS.length,
    x: i, y: 0, z: 0, yaw: 0, speed: 2, alert: false }));
  models.sync(creatures); models.update(1 / 60);
  assert.equal(models.count, MAX_VISIBLE_CREATURES);
  assert.equal(models.group.children.length, CREATURE_DEFS.length * 2 + 4);
  let triangles = 0;
  for (const object of models.group.children) {
    const mesh = object as THREE.InstancedMesh;
    assert.ok(mesh.count <= MAX_VISIBLE_CREATURES * 6);
    assert.ok(mesh.instanceMatrix.array.every(Number.isFinite));
    triangles += mesh.geometry.getAttribute('position').count / 3;
  }
  assert.ok(triangles < 24_000, 'reusable planet species stay within a bounded static geometry budget');
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
  const limbs = models.group.children.slice(CREATURE_DEFS.length, CREATURE_DEFS.length * 2) as THREE.InstancedMesh[];
  assert.deepEqual(limbs.map(mesh => mesh.count), [4, 4, 6, 2, 4, 6, 2, 2, 2, 2, 6, 2, 6, 6]);
  const before = limbs.map(mesh => mesh.instanceMatrix.array.slice());
  for (let i = 0; i < 10; i++) models.update(.1);
  for (let i = 0; i < limbs.length; i++) assert.deepEqual(limbs[i].instanceMatrix.array, before[i],
    'a stale speed field cannot animate stationary feet');
  models.dispose();
});

test('boss attack rings match the authoritative dodge radius and disappear after the windup', () => {
  const models = new WildlifeModels(), species = 9;
  try {
    const boss = { id: 1, species, x: 4, y: 2, z: 8, yaw: 0, speed: 0, alert: true, health: .5, windingUp: true };
    models.sync([boss]); models.update(.1);
    const warnings = models.group.children[CREATURE_DEFS.length * 2] as THREE.InstancedMesh;
    assert.equal(warnings.count, 1);
    const matrix = new THREE.Matrix4(); warnings.getMatrixAt(0, matrix);
    const position = new THREE.Vector3(), rotation = new THREE.Quaternion(), scale = new THREE.Vector3();
    matrix.decompose(position, rotation, scale);
    assert.ok(Math.abs(scale.x - CREATURE_DEFS[species].reach!) < .001);
    assert.ok(Math.abs(position.y - 2.12) < .001);
    models.sync([{ ...boss, windingUp: false }]); models.update(.1); assert.equal(warnings.count, 0);
  } finally { models.dispose(); }
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
