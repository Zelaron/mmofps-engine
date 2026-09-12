import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VesperCity, vesperSweepGeometry, vesperDeckBoxes } from '../src/render/vesper-city.js';
import { buildVesperPlan } from '@shared/vesper-city';
import type { CityDistrict } from '@shared/cities';

const city: CityDistrict = { id: 2, name: 'Vesper Reach', theme: 'vesper', x: -5120, y: 82, z: -5120, radius: 2000, seed: 1337 };

test('Vesper keeps the entire distant silhouette while progressively detailing bounded chunks', () => {
  const renderer = new VesperCity({ collectCities: () => [city] });
  renderer.update(city.x + 5200, 500, city.z);
  const far = { ...renderer.stats };
  assert.ok(far.triangles > 8000 && far.triangles < 20_000 && far.draws <= 20);
  assert.equal(far.detailedChunks, 0);
  for (let i = 0; i < 32; i++) renderer.update(city.x, 120, city.z);
  assert.ok(renderer.stats.detailedChunks > 4 && renderer.stats.triangles > far.triangles);
  assert.ok(renderer.stats.triangles < 100_000 && renderer.stats.draws <= 20);
  assert.equal(renderer.stats.boxes, vesperDeckBoxes(buildVesperPlan(city)).length);
  const geometries = renderer.group.children.map(child => (child as THREE.Mesh).geometry);
  renderer.update(city.x + 1, 120, city.z + 1);
  assert.ok(renderer.group.children.every((child, i) => (child as THREE.Mesh).geometry === geometries[i]));
  renderer.update(city.x + 7000, 120, city.z);
  assert.equal(renderer.group.visible, false); assert.equal(renderer.stats.draws, 0);
  renderer.dispose(); assert.equal(renderer.group.children.length, 0);
});

test('curved Vesper shells are finite, capped and outward facing from both sides of a vertical sweep', () => {
  const sweep = { id: 1, kind: 'spire' as const, color: 0x334455, accent: 0x775599,
    points: [{ x: 0, y: 0, z: 0, radius: 2 }, { x: 0, y: 10, z: 0, radius: 2 }] };
  for (const detailed of [false, true]) {
    const geometry = vesperSweepGeometry([sweep], detailed), material = new THREE.MeshBasicMaterial();
    assert.ok(Array.from(geometry.attributes.position.array).every(Number.isFinite));
    const mesh = new THREE.Mesh(geometry, material);
    for (const [origin, direction] of [
      [new THREE.Vector3(0, -5, 0), new THREE.Vector3(0, 1, 0)],
      [new THREE.Vector3(0, 15, 0), new THREE.Vector3(0, -1, 0)],
      [new THREE.Vector3(8, 5, 0), new THREE.Vector3(-1, 0, 0)],
    ]) assert.ok(new THREE.Raycaster(origin, direction).intersectObject(mesh).length > 0);
    geometry.dispose(); material.dispose();
  }
});
