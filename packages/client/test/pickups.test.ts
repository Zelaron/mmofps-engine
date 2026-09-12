import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  PICKUP_AMMO, PICKUP_HEALTH, WEAPONS,
  type SnapshotPickup,
} from '@shared/index';
import {
  MAX_PICKUP_VISUALS, PickupModels,
} from '../src/render/pickups.js';

function pickup(
  id: number,
  kind: SnapshotPickup['kind'],
  weapon: number,
  x = id,
  y = 2,
  z = -id,
): SnapshotPickup {
  return { id, kind, weapon, x, y, z };
}

function objectById(models: PickupModels, id: number): THREE.Group | undefined {
  return models.group.children.find(
    (child) => child.userData.pickupId === id,
  ) as THREE.Group | undefined;
}

test('pickup visuals mirror complete snapshots and retire stale ids', () => {
  const models = new PickupModels();
  models.sync([
    pickup(11, PICKUP_HEALTH, -1, 1, 3, 5),
    pickup(12, PICKUP_AMMO, 3, 8, 4, -2),
  ]);

  assert.equal(models.count, 2);
  assert.equal(models.group.children.length, 2);
  const health = objectById(models, 11);
  const ammo = objectById(models, 12);
  assert.ok(health);
  assert.ok(ammo);
  assert.equal(health.userData.pickupKind, PICKUP_HEALTH);
  assert.equal(ammo.userData.pickupKind, PICKUP_AMMO);
  assert.equal(ammo.userData.weapon, 3);
  assert.equal(ammo.userData.weaponName, 'Rocket Launcher');
  assert.ok(
    health.children.some((child) => child.userData.pickupPart === 'health-cross'),
    'health drops should carry a high-contrast cross',
  );
  assert.ok(
    ammo.children.some((child) => child.userData.pickupPart === 'ammo-mark'),
    'ammo drops should carry an ammunition mark',
  );

  const oldY = ammo.position.y;
  const oldRotation = ammo.rotation.y;
  models.update(0.1);
  assert.notEqual(ammo.position.y, oldY, 'pickups should bob');
  assert.notEqual(ammo.rotation.y, oldRotation, 'pickups should rotate');

  models.sync([pickup(12, PICKUP_AMMO, 3, 9, 6, -3)]);
  assert.equal(models.count, 1);
  assert.equal(objectById(models, 11), undefined);
  assert.equal(objectById(models, 12), ammo, 'stable ids should reuse their hierarchy');
  assert.equal(ammo.position.x, 9);
  assert.equal(ammo.position.z, -3);

  models.clear();
  assert.equal(models.count, 0);
  assert.equal(models.group.children.length, 0);
  models.clear();
  models.dispose();
});

test('kind or ammo-type reuse replaces the visual without leaking children', () => {
  const models = new PickupModels();
  models.sync([pickup(7, PICKUP_AMMO, 1)]);
  const first = objectById(models, 7);
  assert.ok(first);

  models.sync([pickup(7, PICKUP_AMMO, 4)]);
  const second = objectById(models, 7);
  assert.ok(second);
  assert.notEqual(second, first);
  assert.equal(models.group.children.length, 1);
  assert.equal(second.userData.weapon, 4);

  models.sync([pickup(7, PICKUP_HEALTH, -1)]);
  const third = objectById(models, 7);
  assert.ok(third);
  assert.notEqual(third, second);
  assert.equal(models.group.children.length, 1);
  assert.equal(third.userData.pickupKind, PICKUP_HEALTH);
  models.dispose();
});

test('pickup scene growth is bounded and malformed entries are ignored', () => {
  const models = new PickupModels();
  const oversized = Array.from(
    { length: MAX_PICKUP_VISUALS + 25 },
    (_, id) => pickup(id + 1, PICKUP_AMMO, id % WEAPONS.length),
  );
  oversized.unshift({
    ...pickup(900, PICKUP_HEALTH, -1),
    x: Number.NaN,
  });
  oversized.unshift(pickup(1, PICKUP_AMMO, 3));

  models.sync(oversized);
  assert.equal(models.count, MAX_PICKUP_VISUALS);
  assert.equal(models.group.children.length, MAX_PICKUP_VISUALS);
  assert.equal(objectById(models, 900), undefined);
  assert.equal(
    models.group.children.filter((child) => child.userData.pickupId === 1).length,
    1,
    'duplicate ids should not create duplicate scene objects',
  );
  models.dispose();
});
