import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { CreatureState } from '@shared/wildlife';
import { BossAttackModels, bossAttackPose } from '../src/render/boss-attacks.js';

const attack = { originX: 0, originY: 10, originZ: 0, x: 600, y: 0, z: 30, radius: 9, fireTick: 120, impactTick: 240 };
const boss = (id = 1): CreatureState => ({ id, species: 9, x: 0, y: 0, z: 0, yaw: 0, speed: 0,
  alert: true, rangedAttack: { ...attack } });

test('boss projectile playback enters the committed flight and reaches the exact warned point', () => {
  assert.deepEqual(bossAttackPose(attack, 90), { phase: 'charge', x: 0, y: 10, z: 0, progress: 0 });
  const middle = bossAttackPose(attack, 180);
  assert.equal(middle.phase, 'flight'); assert.equal(middle.x, 300); assert.equal(middle.z, 15);
  assert.ok(middle.y > 45, 'the projectile visibly arcs above the direct path');
  assert.deepEqual(bossAttackPose(attack, 240), { phase: 'impact', x: 600, y: 0, z: 30, progress: 0 });
  const epoch = 2 ** 40;
  assert.deepEqual(bossAttackPose({ ...attack, fireTick: epoch + 120, impactTick: epoch + 240 }, epoch + 180), middle);
});

test('target ring uses the true radius and never follows a moving caster or camera', () => {
  const models = new BossAttackModels(2), creature = boss();
  try {
    models.sync([creature], 90); models.update(90);
    assert.equal(models.rings.count, 1); assert.equal(models.bolts.count, 1); assert.equal(models.impacts.count, 0);
    const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), rotation = new THREE.Quaternion();
    models.rings.getMatrixAt(0, matrix); matrix.decompose(position, rotation, scale);
    assert.equal(position.x, attack.x); assert.equal(position.z, attack.z);
    assert.ok(Math.abs(scale.x - attack.radius) < 1e-6);
    models.sync([{ ...creature, x: 55, y: 30, z: -15 }], 180); models.update(180);
    models.bolts.getMatrixAt(0, matrix); matrix.decompose(position, rotation, scale);
    assert.equal(position.x, 300); assert.equal(position.z, 15);
    assert.equal(models.rings.count, 1, 'the danger zone remains visible throughout flight');
  } finally { models.dispose(); }
});

test('impact survives authoritative payload removal briefly, while cancellation and death remove it immediately', () => {
  const models = new BossAttackModels(2);
  try {
    const creature = boss(); models.sync([creature], 90);
    models.sync([{ ...creature, rangedAttack: undefined }], 240); models.update(250);
    assert.equal(models.impacts.count, 1); assert.equal(models.rings.count, 0); assert.equal(models.bolts.count, 0);
    models.update(280); assert.equal(models.impacts.count, 0);
    models.sync([creature], 90); models.sync([{ ...creature, rangedAttack: undefined }], 100); models.update(241);
    assert.equal(models.impacts.count, 0, 'cancelled casts do not invent impacts');
    models.sync([creature], 90); models.sync([{ ...creature, dead: true }], 100); models.update(100);
    assert.equal(models.rings.count, 0); assert.equal(models.bolts.count, 0);
  } finally { models.dispose(); }
});

test('attack geometry and retained effects remain bounded and reject malformed positions', () => {
  const models = new BossAttackModels(2);
  try {
    models.sync(Array.from({ length: 20 }, (_, i) => boss(i)), 90); models.update(100);
    assert.equal(models.rings.count, 2); assert.equal(models.bolts.count, 2);
    for (const mesh of models.meshes) assert.ok(mesh.instanceMatrix.array.every(Number.isFinite));
    models.sync([{ ...boss(), rangedAttack: { ...attack, x: NaN } }], 100); models.update(100);
    assert.equal(models.rings.count, 0); assert.equal(models.bolts.count, 0);
    models.sync([], 101); models.update(102);
    assert.ok(models.meshes.every(mesh => mesh.count === 0));
  } finally { models.dispose(); }
});
