import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { vehicleEyeHeight, bastionGunMuzzle, jetGunMuzzle, rotationFromEuler } from '@shared/index';
import { buildVehicleHull, aimVehicleWeapon, vehicleMuzzlePosition, VehicleModels } from '../src/render/vehicles.js';

test('capital hulls have distinct finite silhouettes within four static draws and6000 triangles', t => {
  for (const [type, variant] of [[3,1],[2,2]] as const) {
    const first = buildVehicleHull(type, variant), second = buildVehicleHull(type, variant);
    first.updateMatrixWorld(true); let triangles = 0; const parts: THREE.Mesh[] = [];
    first.traverse(o => { if (o instanceof THREE.Mesh && o.name !== 'attached-muzzle-flash') parts.push(o); });
    for (const mesh of parts) {
      const other = second.getObjectByName(mesh.name) as THREE.Mesh;
      assert.equal(mesh.geometry, other.geometry); assert.equal(mesh.material, other.material);
      triangles += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3;
      assert.equal(mesh.geometry.groups.length, 0);
      assert.ok(Array.from(mesh.geometry.getAttribute('position').array).every(Number.isFinite));
    }
    assert.ok(parts.length <= 4); assert.ok(triangles <= 6000, `${triangles} triangles`);
    const box = new THREE.Box3(); for(const mesh of parts) box.union(new THREE.Box3().setFromObject(mesh));
    assert.ok(box.min.y >= -.01); assert.ok(box.max.x - box.min.x > (type === 3 ? 22 : 4));
    const sight = new THREE.Raycaster(new THREE.Vector3(0, vehicleEyeHeight(type, variant), 0), new THREE.Vector3(0,0,-1));
    assert.equal(sight.intersectObjects(parts, false).length, 0, 'driver can see the horizon');
    t.diagnostic(`${type}/${variant}: ${parts.length} draws, ${triangles} triangles`);
  }
});

test('special gun attachments agree with authoritative axes through turret turns and jet inversion', () => {
  const tank = buildVehicleHull(2,2), jet = buildVehicleHull(3,1), actual = new THREE.Vector3();
  for(const heading of [-2,0,1.2]) for(const yaw of [-2.2,0,1.8]) for(const pitch of [-.6,.3,1]) {
    tank.rotation.y = heading; aimVehicleWeapon(tank,yaw,pitch); tank.updateMatrixWorld(true);
    assert.ok(vehicleMuzzlePosition(tank,actual)); const expected = bastionGunMuzzle(heading,yaw,pitch);
    assert.ok(actual.distanceTo(new THREE.Vector3(expected.x,expected.y,expected.z)) < 1e-6);
  }
  const q=rotationFromEuler(.7,Math.PI*1.4,2.3); jet.quaternion.set(q.x,q.y,q.z,q.w); jet.updateMatrixWorld(true);
  vehicleMuzzlePosition(jet,actual);
  assert.ok(actual.distanceTo(new THREE.Vector3().copy(jetGunMuzzle(1)).applyQuaternion(jet.quaternion)) < 1e-6);
});

test('parked replication can replace a base hull with a variant under the same id', () => {
  const models = new VehicleModels(), base = { id: 3, type: 3, x: 0, y: 0, z: 0, heading: 0, health: 420 };
  models.update([base]); const common = models.group.children[0];
  models.update([{...base, variant:1,health:720}]); assert.notEqual(models.group.children[0],common);
  assert.equal(models.nearestPrompt(0,0,0)?.variant,1);
});
