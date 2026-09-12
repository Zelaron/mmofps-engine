import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WEAPONS } from '@shared/index';
import { Effects } from '../src/render/effects.js';

const ROCKET_WEAPON = 3;
const GRENADE_WEAPON = 4;
const ROCKET_BLAST_RADIUS = WEAPONS[ROCKET_WEAPON].splashRadius!;
const GRENADE_BLAST_RADIUS = WEAPONS[GRENADE_WEAPON].splashRadius!;

type ShockwaveMesh = THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;

function shockwaves(effects: Effects): ShockwaveMesh[] {
  return effects.group.children.filter(
    (child): child is ShockwaveMesh =>
      child instanceof THREE.Mesh &&
      child.userData.effect === 'blast-shockwave',
  );
}

test('explosion shockwaves communicate authoritative blast radii', () => {
  const effects = new Effects();
  const waves = shockwaves(effects);
  const cameraPosition = new THREE.Vector3(0, 0, 30);

  assert.equal(waves.length, 6, 'shockwaves should be preallocated');
  assert.ok(waves.every((wave) => !wave.visible));
  assert.equal(
    new Set(waves.map((wave) => wave.geometry)).size,
    1,
    'the pool should share its immutable sphere geometry',
  );
  assert.equal(
    new Set(waves.map((wave) => wave.material)).size,
    waves.length,
    'simultaneous shockwaves need independent fade materials',
  );

  effects.addExplosion(0, 0, 0, cameraPosition);
  effects.addExplosion(
    20, 0, 0,
    cameraPosition,
    GRENADE_BLAST_RADIUS,
  );
  effects.update(0.2);

  const rocketWave = waves.find((wave) => wave.visible && wave.position.x === 0);
  const grenadeWave = waves.find((wave) => wave.visible && wave.position.x === 20);
  assert.ok(rocketWave);
  assert.ok(grenadeWave);
  assert.ok(
    grenadeWave.scale.x > rocketWave.scale.x * 1.8,
    'the grenade pressure front should read as notably larger',
  );
  assert.ok(
    Math.abs(
      grenadeWave.scale.x / rocketWave.scale.x -
      GRENADE_BLAST_RADIUS / ROCKET_BLAST_RADIUS
    ) < 1e-9,
    'visual expansion must preserve the gameplay-radius ratio',
  );
  assert.ok(rocketWave.material.opacity > 0);
  assert.ok(rocketWave.material.opacity < 0.3);
});

test('shockwave pool remains bounded and retires expired shells', () => {
  const effects = new Effects();
  const waves = shockwaves(effects);
  const initialChildCount = effects.group.children.length;
  const cameraPosition = new THREE.Vector3();

  for (let i = 0; i < 20; i++) {
    effects.addExplosion(
      i, 0, 0,
      cameraPosition,
      i % 2 === 0 ? ROCKET_BLAST_RADIUS : GRENADE_BLAST_RADIUS,
    );
  }

  assert.equal(shockwaves(effects).length, 6);
  assert.equal(effects.group.children.length, initialChildCount);
  assert.equal(waves.filter((wave) => wave.visible).length, 6);

  effects.update(1);
  assert.ok(waves.every((wave) => !wave.visible));
  assert.ok(waves.every((wave) => wave.material.opacity === 0));
});

test('an early explosion retires an unbound prediction by weapon and proximity', () => {
  const effects = new Effects();
  const baseChildren = effects.group.children.length;

  effects.spawnPredictedProjectile(GRENADE_WEAPON, 0, 0, 0, 10, 10, 0);
  assert.equal(effects.group.children.length, baseChildren + 1);

  effects.removeProjectile(777, ROCKET_WEAPON, 0, 0, 0);
  assert.equal(
    effects.group.children.length,
    baseChildren + 1,
    'an unrelated weapon explosion must not consume the prediction',
  );

  effects.removeProjectile(777, GRENADE_WEAPON, 100, 0, 0);
  assert.equal(
    effects.group.children.length,
    baseChildren + 1,
    'a far remote explosion must not consume the local prediction',
  );

  effects.removeProjectile(777, GRENADE_WEAPON, 0, 0, 0);
  assert.equal(effects.group.children.length, baseChildren);
});

test('an authoritative grenade ricochet immediately ends local prediction', () => {
  const effects = new Effects();
  const baseChildren = effects.group.children.length;

  effects.spawnPredictedProjectile(GRENADE_WEAPON, 0, 2, 0, 60, -8, 0);
  assert.equal(effects.group.children.length, baseChildren + 1);
  assert.equal(effects.reconcilePredictedProjectile({
    id: 91,
    x: 1, y: 1.8, z: 0,
    vx: 60, vy: -9, vz: 0,
    weapon: GRENADE_WEAPON,
  }), true, 'ordinary gravity drift keeps the latency-hiding prediction');

  assert.equal(effects.reconcilePredictedProjectile({
    id: 91,
    x: 1.4, y: 1.6, z: 0,
    vx: 42, vy: 5, vz: 0,
    weapon: GRENADE_WEAPON,
  }), false, 'reflected authoritative motion takes over immediately');
  assert.equal(effects.group.children.length, baseChildren);

  effects.spawnPredictedProjectile(GRENADE_WEAPON, 0, 2, 0, 60, -8, 0);
  const firstReflected = {
    id: 92,
    x: 1.4, y: 1.6, z: 0,
    vx: 42, vy: 5, vz: 0,
    weapon: GRENADE_WEAPON,
  };
  assert.equal(
    effects.reconcilePredictedProjectile(firstReflected),
    false,
    'a first authoritative sample that already bounced also takes over',
  );
  effects.updateProjectiles([firstReflected]);
  assert.equal(effects.group.children.length, baseChildren + 1);
  effects.removeProjectile(firstReflected.id);
  assert.equal(effects.group.children.length, baseChildren);

  effects.spawnPredictedProjectile(ROCKET_WEAPON, 0, 2, 0, 48, 0, 0);
  assert.equal(effects.reconcilePredictedProjectile({
    id: 93,
    x: 1, y: 2, z: 0,
    vx: -20, vy: 0, vz: 0,
    weapon: ROCKET_WEAPON,
  }), true, 'non-ricocheting weapons ignore the grenade handoff heuristic');
  effects.clearPredictedProjectiles();
});

test('hard resync clears replicated and predicted projectile visuals', () => {
  const effects = new Effects();
  const baseChildren = effects.group.children.length;

  effects.spawnPredictedProjectile(GRENADE_WEAPON, 0, 0, 0, 10, 10, 0);
  effects.updateProjectiles([{
    id: 41,
    x: 2, y: 3, z: 4,
    vx: 5, vy: 6, vz: 7,
    weapon: ROCKET_WEAPON,
  }]);
  assert.equal(effects.group.children.length, baseChildren + 2);

  effects.clearProjectiles();
  assert.equal(effects.group.children.length, baseChildren);

  // Cleanup is safe to repeat during multiple visibility/network resets.
  effects.clearProjectiles();
  assert.equal(effects.group.children.length, baseChildren);
});

test('capital shockwaves reuse bounded pools while retaining their weapon tint and true radius', () => {
  const effects=new Effects(), waves=shockwaves(effects), cam=new THREE.Vector3(0,0,20);
  for(let i=0;i<30;i++) effects.addExplosion(i,0,0,cam,28,0xc577ff);
  assert.equal(waves.length,6);assert.ok(waves.every(w=>w.material.color.getHex()===0xc577ff));
  effects.update(1);effects.addExplosion(100,0,0,cam,20,0x8ee8ed);
  assert.equal(waves.find(w=>w.visible)!.material.color.getHex(),0x8ee8ed);
  effects.update(1);effects.addExplosion(200,0,0,cam,6);
  assert.equal(waves.find(w=>w.visible)!.material.color.getHex(),0xffd28a,'ordinary blasts cannot inherit a pooled alien tint');
});
