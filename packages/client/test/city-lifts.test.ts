import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { cityLiftPose, type World } from '@shared/index';
import type { CityDistrict, CityLiftSite } from '@shared/cities';
import { CityLiftRenderer } from '../src/render/city-lifts.js';

const cities: CityDistrict[] = [
  { id: 2, name: 'Vesper Reach', theme: 'vesper', x: 0, y: 20, z: 0, radius: 384, seed: 5 },
  { id: 3, name: 'Aurelia Bastion', theme: 'aurelia', x: 4096, y: 50, z: 4096, radius: 384, seed: 6 },
];
const sites: CityLiftSite[] = [
  { id: 201, cityId: 2, x: 128, z: -128, bottom: 20, top: 44, hx: 2.2, hz: 2.2, phase: 0 },
  { id: 202, cityId: 2, x: -128, z: 128, bottom: 20, top: 44, hx: 2.2, hz: 2.2, phase: 3 },
  { id: 301, cityId: 3, x: 4096, z: 4096, bottom: 50, top: 120, hx: 2.2, hz: 2.2, phase: 0 },
];
const world = { collectCityLifts: () => sites, collectCities: () => cities } as unknown as World;

test('city lift decks use two fixed pools and the shared authoritative clock', () => {
  const renderer = new CityLiftRenderer(world);
  const pools = renderer.group.children as THREE.InstancedMesh[];
  assert.equal(pools.length, 2);
  assert.ok(pools.every(p => p.instanceMatrix.count === sites.length));
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), rotation = new THREE.Quaternion();
  let visualClearance: number | undefined;
  for (const time of [0, 2, 5, 8, 13, 18, 24, 51.75]) {
    renderer.update(time, 0, 0);
    for (const pool of pools) {
      assert.equal(pool.count, 2);
      assert.ok(pool.instanceMatrix.array.every(Number.isFinite));
      for (let i = 0; i < 2; i++) {
        pool.getMatrixAt(i, matrix); matrix.decompose(position, rotation, scale);
        assert.equal(position.x, sites[i].x); assert.equal(position.z, sites[i].z);
        const clearance = position.y - cityLiftPose(sites[i], time).y;
        assert.ok(clearance > .01 && clearance < .08, 'visible deck clears a coincident landing without floating above the feet');
        visualClearance ??= clearance;
        assert.ok(Math.abs(clearance - visualClearance) < 1e-5, 'shared clock motion retains a constant visual clearance');
        assert.ok(Math.abs(scale.x - sites[i].hx) < 1e-6 && Math.abs(scale.z - sites[i].hz) < 1e-6);
        assert.ok(pool.boundingSphere!.containsPoint(position), 'moving decks remain inside recomputed draw bounds');
      }
    }
  }
  renderer.dispose();
});

test('distant lift pools empty and repopulate with current poses when returning', () => {
  const renderer = new CityLiftRenderer(world), pools = renderer.group.children as THREE.InstancedMesh[];
  renderer.update(0, 0, 0);
  renderer.update(8, 20000, 20000);
  assert.ok(pools.every(p => p.count === 0));
  renderer.update(16, 4096, 4096);
  assert.ok(pools.every(p => p.count === 1));
  const matrix = new THREE.Matrix4(), center = new THREE.Vector3();
  for (const p of pools) {
    p.getMatrixAt(0, matrix); center.setFromMatrixPosition(matrix);
    assert.equal(center.x, 4096); assert.equal(center.z, 4096);
    assert.ok(center.y - cityLiftPose(sites[2], 16).y > .01 && center.y - cityLiftPose(sites[2], 16).y < .08);
    assert.ok(p.boundingSphere!.containsPoint(center));
  }
  renderer.update(51, 0, 0);
  assert.ok(pools.every(p => p.count === 2));
  assert.match(renderer.hint(0, 128, 20, -128)!, /LIFT DEPARTS IN 6s/);
  assert.match(renderer.hint(5, 128, cityLiftPose(sites[0], 5).y, -128)!, /LIFT DEPARTS IN 1s/);
  assert.match(renderer.hint(7, 128, cityLiftPose(sites[0], 7).y, -128)!, /ASCENT LIFT/);
  assert.equal(renderer.hint(0, 20000, 20, 20000), null);
  renderer.dispose();
});

test('city lift disposal releases both frame and field buffers and materials', () => {
  const renderer = new CityLiftRenderer(world);
  let geometries = 0, materials = 0, instances = 0;
  for (const pool of renderer.group.children as THREE.InstancedMesh[]) {
    pool.geometry.addEventListener('dispose', () => geometries++);
    (pool.material as THREE.Material).addEventListener('dispose', () => materials++);
    pool.addEventListener('dispose', () => instances++);
  }
  renderer.dispose();
  assert.deepEqual({ geometries, materials, instances }, { geometries: 2, materials: 2, instances: 2 });
  assert.equal(renderer.group.children.length, 0);
});
