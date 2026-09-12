import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WEAPONS } from '@shared/weapons';
import {
  buildWeaponModel, cloneWorldWeapon, poseWeaponReload, weaponGripPoints,
} from '../src/render/weapon-models.js';

test('every weapon builds in both detail levels with animated parts', () => {
  for (let w = 0; w < WEAPONS.length; w++) {
    const fp = buildWeaponModel(w, true);
    const world = buildWeaponModel(w, false);
    assert.ok(fp.group.children.length >= world.group.children.length,
      `first-person model of weapon ${w} should be at least as detailed`);
    assert.ok(fp.rests.length > 0, `weapon ${w} needs at least one animated part`);
  }
  // Mag-fed weapons animate a magazine; break/tube weapons animate a round.
  assert.ok(buildWeaponModel(0, true).mag && buildWeaponModel(1, true).mag);
  assert.ok(buildWeaponModel(2, true).breech && buildWeaponModel(4, true).breech);
  assert.ok(buildWeaponModel(3, true).shell);
  // Cave weapons: railgun swaps a capacitor cell, nuke gun swings its drum.
  assert.ok(buildWeaponModel(5, true).mag);
  assert.ok(buildWeaponModel(6, true).mag);
});

test('nuke gun drum reload is idempotent', () => {
  const m = buildWeaponModel(6, true);
  const rest = m.mag!.position.y;
  poseWeaponReload(m, 6, 0.5);
  const swung = m.mag!.position.y;
  assert.ok(swung < rest - 0.05, 'drum swings out mid-reload');
  poseWeaponReload(m, 6, 0.5);
  assert.equal(m.mag!.position.y, swung);
  poseWeaponReload(m, 6, -1);
  assert.equal(m.mag!.position.y, rest);
});

test('reload posing is idempotent and reveals the round mid-reload', () => {
  const m = buildWeaponModel(1, true);
  const magRest = m.mag!.position.y;
  poseWeaponReload(m, 1, 0.35);
  const dropped = m.mag!.position.y;
  assert.ok(dropped < magRest - 0.05, 'mag should drop mid-reload');
  poseWeaponReload(m, 1, 0.35);
  assert.equal(m.mag!.position.y, dropped, 'posing twice must not accumulate');
  poseWeaponReload(m, 1, -1);
  assert.equal(m.mag!.position.y, magRest, 'idle pose restores rest transform');

  const rocket = buildWeaponModel(3, true);
  assert.equal(rocket.shell!.visible, false, 'round hidden at rest');
  poseWeaponReload(rocket, 3, 0.5);
  assert.equal(rocket.shell!.visible, true, 'round visible while inserting');
  poseWeaponReload(rocket, 3, -1);
  assert.equal(rocket.shell!.visible, false);
});

test('new weapon magazines and power cells move independently and reset after cancelled reloads', () => {
  for (const id of [7, 8, 9]) {
    const model = buildWeaponModel(id, true), mag = model.mag!;
    assert.ok(mag, `weapon ${id} needs a reloadable magazine or cell`);
    const rest = mag.position.clone(), body = model.group.position.clone();
    poseWeaponReload(model, id, .4);
    const removed = mag.position.clone();
    assert.ok(removed.y < rest.y - .25);
    assert.deepEqual(model.group.position, body);
    poseWeaponReload(model, id, .4);
    assert.deepEqual(mag.position, removed);
    poseWeaponReload(model, id, -1);
    assert.deepEqual(mag.position, rest);
  }
});

test('world clones are independent of their template', () => {
  const a = cloneWorldWeapon(2);
  const b = cloneWorldWeapon(2);
  assert.notEqual(a, b);
  a.position.set(1, 2, 3);
  assert.notEqual(a.position.x, b.position.x);
});

function geometryBudget(group: THREE.Object3D): { draws: number; triangles: number } {
  let draws = 0, triangles = 0;
  group.traverseVisible((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    draws++;
    triangles += (obj.geometry.index?.count ?? obj.geometry.getAttribute('position').count) / 3;
  });
  return { draws, triangles };
}

test('detailed weapons keep reload assemblies while shared world weapons stay within three draws', () => {
  for (let weapon = 0; weapon < WEAPONS.length; weapon++) {
    const model = buildWeaponModel(weapon, true);
    poseWeaponReload(model, weapon, .5);
    const first = geometryBudget(model.group), world = geometryBudget(cloneWorldWeapon(weapon));
    assert.ok(first.draws <= 7, `weapon ${weapon}: ${first.draws} first-person draws`);
    assert.ok(first.triangles <= 3500, `weapon ${weapon}: ${first.triangles} triangles including reload round`);
    assert.ok(world.draws <= 3, `weapon ${weapon}: ${world.draws} world draws`);
    assert.ok(world.triangles <= 1250, `weapon ${weapon}: ${world.triangles} world triangles`);
    assert.ok(first.triangles > world.triangles * 1.5, `weapon ${weapon} needs a cheaper world silhouette`);
    for (const rest of model.rests) {
      assert.ok(rest.obj.parent, `weapon ${weapon}: batching must preserve ${rest.obj.name}'s pivot`);
      assert.ok(rest.obj instanceof THREE.Group && rest.obj.children.length > 0);
    }
  }
});

test('weapon batches preserve finite normals, grip reach and the existing muzzle envelope', () => {
  for (let weapon = 0; weapon < WEAPONS.length; weapon++) for (const detail of [true, false]) {
    const model = buildWeaponModel(weapon, detail);
    const bounds = new THREE.Box3().setFromObject(model.group);
    const size = bounds.getSize(new THREE.Vector3());
    assert.ok(size.x < .25 && size.y < .46 && size.z < 1.05, `weapon ${weapon} must fit the existing camera rig`);
    assert.ok(Math.abs(bounds.min.z - model.muzzle.z) <= .005, `weapon ${weapon}: muzzle stays on the front of the barrel`);
    const contacts = weaponGripPoints(weapon);
    for (const point of [contacts.trigger, contacts.support]) assert.ok(bounds.containsPoint(new THREE.Vector3(...point)));
    model.group.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const normal = obj.geometry.getAttribute('normal'), position = obj.geometry.getAttribute('position');
      assert.equal(normal.count, position.count);
      assert.equal(obj.geometry.getAttribute('color').count, position.count);
      for (let i = 0; i < position.count; i++) {
        assert.ok(Number.isFinite(position.getX(i) + position.getY(i) + position.getZ(i)));
        assert.ok(Math.abs(Math.hypot(normal.getX(i), normal.getY(i), normal.getZ(i)) - 1) < .00001);
      }
    });
  }
});

test('barrel openings have depth and face-correct interior surfaces', () => {
  for (let weapon = 0; weapon < WEAPONS.length; weapon++) {
    const model = buildWeaponModel(weapon, true);
    model.group.updateMatrixWorld(true);
    const front = model.muzzle.clone();
    if (weapon === 2) front.x = -.036; // One of the scattergun's two actual bores.
    front.z -= .04;
    const ray = new THREE.Raycaster(front, new THREE.Vector3(0, 0, 1));
    const hits = ray.intersectObject(model.group, true).filter(hit => {
      let obj: THREE.Object3D | null = hit.object;
      while (obj) { if (!obj.visible) return false; obj = obj.parent; }
      return true;
    });
    assert.ok(hits.length > 0, `weapon ${weapon} should have a recessed bore backing`);
    assert.ok(hits[0].distance >= .075, `weapon ${weapon}: barrel must not be a solid muzzle polygon (${hits[0].distance})`);
  }
});

test('world weapon clones share baked geometry and exclude reload-only rounds', () => {
  for (let weapon = 0; weapon < WEAPONS.length; weapon++) {
    const a = cloneWorldWeapon(weapon), b = cloneWorldWeapon(weapon);
    assert.deepEqual(a.userData.muzzle, buildWeaponModel(weapon, false).muzzle.toArray());
    assert.deepEqual(a.userData.muzzle, b.userData.muzzle);
    assert.notEqual(a.userData.muzzle, b.userData.muzzle, 'clone muzzle metadata must be independent');
    assert.ok(a.children.every(child => child instanceof THREE.Mesh));
    assert.equal(a.children.length, b.children.length);
    for (let i = 0; i < a.children.length; i++) {
      const ma = a.children[i] as THREE.Mesh, mb = b.children[i] as THREE.Mesh;
      assert.equal(ma.geometry, mb.geometry);
      assert.equal(ma.material, mb.material);
      assert.notEqual(ma, mb);
    }
  }
});
