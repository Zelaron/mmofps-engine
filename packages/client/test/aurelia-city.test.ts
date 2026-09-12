import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { AureliaCity, aureliaSweepGeometry } from '../src/render/aurelia-city.js';
import { buildAureliaPlan } from '@shared/aurelia-city';
import type { CityDistrict } from '@shared/cities';

const city: CityDistrict = { id: 3, seed: 1337, x: 6144, y: 38, z: 4096, radius: 1800, name: 'Aurelia Bastion', theme: 'aurelia' };
test('Aurelia owns the exact city in two draws below the skyline triangle budget', () => {
  const r = new AureliaCity({ collectCities: () => [city] }), p = buildAureliaPlan(city);
  assert.ok(r.stats.triangles < 150000 && r.stats.triangles > 80000);
  r.update(city.x, city.y + 2, city.z); assert.equal(r.stats.draws, 2);
  const district = r.group.children[0], boxes = district.children[0] as THREE.InstancedMesh;
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), q = new THREE.Quaternion();
  assert.equal(boxes.count, p.solids.length);
  for (let i = 0; i < p.solids.length; i += 17) {
    boxes.getMatrixAt(i, matrix); matrix.decompose(position, q, scale);
    assert.ok(position.clone().add(district.position).distanceTo(new THREE.Vector3(p.solids[i].x, p.solids[i].y, p.solids[i].z)) < .001);
    assert.ok(Math.abs(scale.y - p.solids[i].hy) < .001);
  }
  const geometries = district.children.map(m => (m as THREE.Mesh).geometry);
  r.update(city.x + 10000, city.y, city.z); assert.equal(r.stats.draws, 0);
  r.update(city.x, city.y + 900, city.z); assert.equal(r.stats.draws, 2);
  assert.deepEqual(district.children.map(m => (m as THREE.Mesh).geometry), geometries);
  let disposals = 0; for (const g of geometries) g.addEventListener('dispose', () => disposals++);
  r.dispose(); r.dispose(); assert.equal(disposals, 2); assert.equal(r.group.children.length, 0);
});

test('tapered shrine sweeps have finite closed geometry and outward facing walls', () => {
  const geometry = aureliaSweepGeometry([{ id: 1, kind: 'spire', color: 0x998866, accent: 0xbb9966,
    points: [{ x: 0, y: 0, z: 0, radius: 5 }, { x: 0, y: 40, z: 0, radius: 1 }] }], { x: 0, y: 0, z: 0 });
  assert.ok(geometry.attributes.position.array.every(Number.isFinite));
  assert.ok(geometry.attributes.normal.array.every(Number.isFinite));
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  const ray = new THREE.Raycaster(new THREE.Vector3(20, 20, 0), new THREE.Vector3(-1, 0, 0));
  assert.ok(ray.intersectObject(mesh).length > 0, 'front-face sweep winding hides the monument');
  geometry.computeBoundingBox(); assert.ok(geometry.boundingBox!.min.y <= -4.9 && geometry.boundingBox!.max.y >= 40.9);
  geometry.dispose(); (mesh.material as THREE.Material).dispose();
});
