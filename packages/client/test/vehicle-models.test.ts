import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VEHICLE, vehicleEyeHeight, vehicleLocalOffset, JET_GUN_MUZZLE, JET_BOMB_BAY, type VehicleType, viewDir } from '@shared/index';
import { buildVehicleHull, disposeVehicleHull, aimVehicleWeapon, vehicleMuzzlePosition, updateVehicleHull, VehicleModels } from '../src/render/vehicles.js';

function meshes(root: THREE.Object3D): THREE.Mesh[] {
  const result: THREE.Mesh[] = [];
  // The optional shot flash is tested separately: it is a transient draw,
  // rather than structural hull geometry or a driver sightline obstruction.
  root.traverse((part) => {
    if (part instanceof THREE.Mesh && part.name !== 'attached-muzzle-flash') result.push(part);
  });
  return result;
}

test('detailed vehicles keep strict draw and triangle budgets with valid geometry', (t) => {
  for (const [type, maxDraws, maxTriangles] of [[VEHICLE.JEEP, 7, 4000], [VEHICLE.TANK, 3, 4000], [VEHICLE.JET, 3, 1800]] as const) {
    const root = buildVehicleHull(type);
    const parts = meshes(root);
    let triangles = 0;
    for (const part of parts) {
      const geometry = part.geometry;
      triangles += (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
      assert.equal(geometry.groups.length, 0, 'part batching must not create extra material draws');
      assert.ok(!Array.isArray(part.material), 'one material per batch');
      for (const attribute of ['position', 'normal', 'color']) {
        assert.ok(geometry.getAttribute(attribute), `missing ${attribute}`);
        assert.ok(Array.from(geometry.getAttribute(attribute).array).every(Number.isFinite), `${attribute} is finite`);
      }
    }
    assert.ok(parts.length <= maxDraws, `type ${type}: ${parts.length} draws > ${maxDraws}`);
    assert.ok(triangles <= maxTriangles, `type ${type}: ${triangles} triangles > ${maxTriangles}`);
    t.diagnostic(`type ${type}: ${parts.length} draws, ${triangles} triangles`);
  }
});

test('vehicle detail preserves recognizable dimensions and the forward first-person sightline', () => {
  for (const [type, width, length] of [[VEHICLE.JEEP, 2.5, 4.3], [VEHICLE.TANK, 3.6, 6.7], [VEHICLE.JET, 7.5, 8.2]] as const) {
    const root = buildVehicleHull(type);
    root.updateMatrixWorld(true);
    const parts = meshes(root);
    const box = new THREE.Box3();
    for (const part of parts) box.union(new THREE.Box3().setFromObject(part));
    const size = box.getSize(new THREE.Vector3());
    assert.ok(size.x < width, `type ${type}: width ${size.x}`);
    assert.ok(size.z < length, `type ${type}: length ${size.z}`);
    assert.ok(box.min.y >= -0.01, 'tires and tracks sit on the ground');
    for (const yaw of [-0.35, 0, 0.35]) {
      const ray = new THREE.Raycaster(new THREE.Vector3(0, vehicleEyeHeight(type), 0), new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw)));
      assert.equal(ray.intersectObjects(parts, false).length, 0, `type ${type} obstructs the driver horizon`);
    }
  }
});

test('cloned vehicles share bounded GPU resources and animate independently', () => {
  const first = buildVehicleHull(VEHICLE.JEEP), second = buildVehicleHull(VEHICLE.JEEP);
  const a = meshes(first), b = meshes(second);
  for (let i = 0; i < a.length; i++) {
    assert.equal(a[i].geometry, b[i].geometry);
    assert.equal(a[i].material, b[i].material);
    assert.notEqual(a[i], b[i]);
  }
  updateVehicleHull(first, { dt: 0.05, speed: 10, steering: 1 });
  assert.notEqual(first.getObjectByName('wheel')!.rotation.x, 0);
  assert.ok(first.getObjectByName('steering')!.rotation.y > 0);
  assert.equal(Math.abs(second.getObjectByName('wheel')!.rotation.x), 0);
  const scene = new THREE.Group();
  scene.add(first, second);
  let destroyed = 0;
  a[0].geometry.addEventListener('dispose', () => destroyed++);
  disposeVehicleHull(first);
  assert.equal(first.parent, null);
  assert.equal(second.parent, scene);
  assert.equal(destroyed, 0, 'releasing an instance must not destroy another vehicle geometry');
});

test('turret traverse stays independent and jet exhaust responds only on its own instance', () => {
  const tank = buildVehicleHull(VEHICLE.TANK);
  const turret = tank.getObjectByName('turret')!;
  turret.rotation.y = 0.75;
  assert.equal(tank.getObjectByName('body')!.rotation.y, 0);
  assert.equal(turret.children[0].parent, turret);
  const jet = buildVehicleHull(VEHICLE.JET), parked = buildVehicleHull(VEHICLE.JET);
  updateVehicleHull(jet, { dt: 0.016, speed: 80, throttle: 1 });
  assert.equal(jet.getObjectByName('exhaust')!.visible, true);
  assert.equal(parked.getObjectByName('exhaust')!.visible, false);
  updateVehicleHull(jet, { dt: 0.016, speed: 0, throttle: 0 });
  assert.equal(jet.getObjectByName('exhaust')!.visible, false);
});

test('parked vehicle churn reuses beacon resources and clears proximity state', () => {
  const models = new VehicleModels();
  const snapshot = [{ id: 1, type: VEHICLE.JEEP as VehicleType, x: 0, y: 0, z: 0, heading: 0, health: 100 }];
  models.update(snapshot);
  const original = meshes(models.group);
  models.update([]);
  assert.equal(models.group.children.length, 0);
  models.update(snapshot);
  const recreated = meshes(models.group);
  for (let i = 0; i < original.length; i++) {
    assert.equal(original[i].geometry, recreated[i].geometry);
    assert.equal(original[i].material, recreated[i].material);
  }
  models.dispose();
  assert.equal(models.latest.length, 0);
  assert.equal(models.nearestPrompt(0, 0, 0), null);
});


test('jeep and tank barrels track world aim under hull tilt and a rotated parent', () => {
  for (const type of [VEHICLE.JEEP, VEHICLE.TANK] as const) {
    const parent = new THREE.Group(); parent.rotation.y = -0.7;
    const hull = buildVehicleHull(type); parent.add(hull);
    hull.rotation.set(0.35, 1.1, -0.25, 'YXZ');
    const elevation = hull.getObjectByName('weapon-elevation')!;
    for (const [yaw, pitch] of [[-2.7, -0.7], [0.3, 0.6], [2.6, 1.1]]) {
      aimVehicleWeapon(hull, yaw, pitch); parent.updateMatrixWorld(true);
      const q = elevation.getWorldQuaternion(new THREE.Quaternion());
      const barrelDirection = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      const expected = viewDir(yaw, pitch);
      assert.ok(barrelDirection.distanceTo(new THREE.Vector3(expected.x, expected.y, expected.z)) < 1e-6,
        'visible barrel axis must match the ray fired by the server');
    }
    disposeVehicleHull(hull);
  }
});

test('vehicle firing attachments track barrels and shared bomb release matches YXZ airframe rotation', () => {
  for (const type of [VEHICLE.JEEP, VEHICLE.TANK, VEHICLE.JET] as const) {
    const hull = buildVehicleHull(type);
    hull.position.set(21, 40, -9);
    hull.rotation.set(0.48, -1.3, 1.1, 'YXZ');
    aimVehicleWeapon(hull, 0.4, -0.3);
    const result = new THREE.Vector3();
    assert.equal(vehicleMuzzlePosition(hull, result), true);
    const attachment = hull.getObjectByName('weapon-muzzle')!;
    assert.ok(result.distanceTo(attachment.getWorldPosition(new THREE.Vector3())) < 1e-8);
    if (type !== VEHICLE.JET) {
      const old = result.clone();
      aimVehicleWeapon(hull, -1.1, 0.6);
      vehicleMuzzlePosition(hull, result);
      assert.ok(result.distanceTo(old) > 0.5, 'tracer origin must follow turret articulation');
    } else {
      for (const local of [JET_GUN_MUZZLE, JET_BOMB_BAY, {x: 0, y: 0, z: 4}, {x: 0, y: -4, z: 0}]) {
        const shared = vehicleLocalOffset({heading: hull.rotation.y, vehiclePitch: hull.rotation.x,
          vehicleRoll: hull.rotation.z}, local.x, local.y, local.z);
        const expected = new THREE.Vector3(local.x, local.y, local.z).applyEuler(hull.rotation);
        assert.ok(expected.distanceTo(new THREE.Vector3(shared.x, shared.y, shared.z)) < 1e-8,
          'server release offset must use exactly the model rotation order');
      }
      const beforeLook = result.clone();
      aimVehicleWeapon(hull, 2.7, -1.0);
      vehicleMuzzlePosition(hull, result);
      assert.ok(result.equals(beforeLook), 'jet muzzle must remain fixed when the pilot looks away');
    }
    disposeVehicleHull(hull);
  }
});
