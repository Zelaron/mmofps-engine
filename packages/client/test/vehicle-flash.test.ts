import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VEHICLE, viewDir } from '@shared/index';
import {
  aimVehicleWeapon, buildVehicleHull, disposeVehicleHull, flashVehicleWeapon,
  updateVehicleHull, vehicleMuzzlePosition,
} from '../src/render/vehicles.js';

function flashOf(hull: THREE.Group): THREE.Mesh {
  const flash = hull.getObjectByName('attached-muzzle-flash');
  assert.ok(flash instanceof THREE.Mesh);
  return flash;
}

function visibleMeshes(root: THREE.Object3D): number {
  let count = 0;
  root.traverseVisible(part => { if (part instanceof THREE.Mesh) count++; });
  return count;
}

test('vehicle shots add exactly one temporary draw with shared immutable GPU buffers', () => {
  const hulls = [VEHICLE.JEEP, VEHICLE.TANK, VEHICLE.JET].map(buildVehicleHull);
  const flashes = hulls.map(flashOf);
  let disposals = 0;
  flashes[0].geometry.addEventListener('dispose', () => disposals++);
  for (let i = 0; i < hulls.length; i++) {
    const hull = hulls[i], flash = flashes[i], idleDraws = visibleMeshes(hull);
    assert.equal(flash.visible, false);
    assert.equal(flash.geometry, flashes[0].geometry);
    assert.equal(flash.material, flashes[0].material);
    assert.ok(!Array.isArray(flash.material), 'one material means one extra draw');
    assert.ok((flash.geometry.index?.count ?? flash.geometry.getAttribute('position').count) / 3 <= 24);
    assert.equal(flashVehicleWeapon(hull), true);
    assert.equal(visibleMeshes(hull), idleDraws + 1);
    updateVehicleHull(hull, { dt: 0.07, speed: 0 });
    assert.equal(visibleMeshes(hull), idleDraws);
    // A restarted shot uses the existing attachment, rather than allocating a
    // second cone or changing another vehicle's lifetime/visibility.
    for (let shot = 0; shot < 100; shot++) assert.equal(flashVehicleWeapon(hull), true);
    assert.equal(flashOf(hull), flash);
    assert.equal(visibleMeshes(hull), idleDraws + 1);
    for (let j = i + 1; j < hulls.length; j++) assert.equal(flashes[j].visible, false);
    updateVehicleHull(hull, { dt: 0.07, speed: 0 });
    disposeVehicleHull(hull);
  }
  assert.equal(disposals, 0, 'disposing an instance must preserve all shared flash buffers');
  assert.equal(flashVehicleWeapon(new THREE.Group()), false);
});

test('a live flash stays on the moving and articulating barrel at 90 metres per second', () => {
  for (const type of [VEHICLE.JEEP, VEHICLE.TANK, VEHICLE.JET] as const) {
    const parent = new THREE.Group();
    parent.position.set(-120, 15, 210); parent.rotation.y = 0.4;
    const hull = buildVehicleHull(type); parent.add(hull);
    hull.position.set(23, 41, -16); hull.rotation.set(0.35, 1.1, -0.2, 'YXZ');
    aimVehicleWeapon(hull, -0.7, 0.25);
    flashVehicleWeapon(hull);
    const flash = flashOf(hull);
    const firedAt = flash.getWorldPosition(new THREE.Vector3());

    const dt = 0.03;
    hull.position.z -= 90 * dt;
    hull.rotation.set(-0.12, 1.25, 0.28, 'YXZ');
    const yaw = 0.9, pitch = -0.4;
    aimVehicleWeapon(hull, yaw, pitch);
    updateVehicleHull(hull, { dt, speed: 90, throttle: 1 });
    parent.updateMatrixWorld(true);

    const muzzle = new THREE.Vector3();
    assert.equal(vehicleMuzzlePosition(hull, muzzle), true);
    assert.equal(flash.visible, true, 'flash still has 35ms of its lifetime remaining');
    assert.ok(flash.getWorldPosition(new THREE.Vector3()).distanceTo(muzzle) < 1e-8,
      'the visual origin must follow the barrel, rather than remain at the shot event position');
    assert.ok(muzzle.distanceTo(firedAt) > 1, 'fixture must actually translate the firing origin');
    const direction = new THREE.Vector3(0, 0, -1).applyQuaternion(flash.getWorldQuaternion(new THREE.Quaternion()));
    const aim = viewDir(yaw, pitch);
    const expected = type === VEHICLE.JET
      ? new THREE.Vector3(0, 0, -1).applyQuaternion(hull.getWorldQuaternion(new THREE.Quaternion()))
      : new THREE.Vector3(aim.x, aim.y, aim.z);
    assert.ok(direction.distanceTo(expected) < 1e-6, 'flash follows both turret yaw and barrel elevation');
    const tip = flash.localToWorld(new THREE.Vector3(0, 0, -0.6));
    assert.ok(tip.sub(muzzle).dot(direction) > 0.3, 'the flare extends ahead of the muzzle');

    updateVehicleHull(hull, { dt: 0.04, speed: 90 });
    assert.equal(flash.visible, false);
    flashVehicleWeapon(hull);
    assert.equal(flash.visible, true);
    assert.equal(flash.scale.x, 1, 'subsequent shots restart a full-size flash');
    disposeVehicleHull(hull);
  }
});
