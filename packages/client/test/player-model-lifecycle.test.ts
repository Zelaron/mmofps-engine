import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { VEHICLE } from '@shared/index';
import type { PlayerView } from '../src/interp.js';
import { PlayerModels } from '../src/render/players.js';

function withModels(run: (models: PlayerModels) => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const context = { measureText: () => ({ width: 100 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ width: 256, height: 56, getContext: () => context }),
  } });
  const models = new PlayerModels();
  try { run(models); }
  finally {
    models.clear();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
}

function view(id: number, partial: Partial<PlayerView> = {}): PlayerView {
  return { id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, dead: false, grounded: true,
    weapon: 1, vehicle: VEHICLE.NONE, heading: 0, vx: 0, vy: 0, vz: 0, ...partial };
}

function tags(models: PlayerModels): THREE.Sprite[] {
  return models.group.children.map(root => {
    const tag = root.children.find(child => child instanceof THREE.Sprite);
    assert.ok(tag instanceof THREE.Sprite);
    return tag;
  });
}

function watchTag(tag: THREE.Sprite): { texture: number; material: number } {
  const count = { texture: 0, material: 0 };
  assert.ok(tag.material.map);
  tag.material.map.addEventListener('dispose', () => count.texture++);
  tag.material.addEventListener('dispose', () => count.material++);
  return count;
}

test('interest departure releases only the absent actor tag, and return creates a fresh owned tag', () => {
  withModels(models => {
    const names = new Map([[1, 'First'], [25, 'Survivor']]);
    models.update([view(1), view(25)], names, 1 / 60);
    const [departed, survivor] = tags(models), a = watchTag(departed), b = watchTag(survivor);
    models.update([view(25)], names, 1 / 60);
    assert.deepEqual(a, { texture: 1, material: 1 });
    assert.deepEqual(b, { texture: 0, material: 0 });
    assert.equal(tags(models)[0], survivor);
    assert.equal(models.muzzlePos(1), null);
    models.remove(1);
    models.update([view(25)], names, 1 / 60);
    assert.deepEqual(a, { texture: 1, material: 1 }, 'repeated removal cannot dispose an asset twice');
    models.update([view(25), view(1)], names, 1 / 60);
    const returned = tags(models)[1];
    assert.notEqual(returned.material, departed.material);
    assert.notEqual(returned.material.map, departed.material.map);
    assert.deepEqual(b, { texture: 0, material: 0 }, 'another actor returning preserves the survivor');
  });
});

test('population replacement clears foot and crew tags once without disposing shared render assets', () => {
  withModels(models => {
    const driver = view(25, { vehicle: VEHICLE.TANK, vehicleId: 9 });
    const gunner = view(2, { vehicle: VEHICLE.TANK, vehicleId: 9, seat: 1 });
    models.update([view(1), driver, gunner], new Map(), 1 / 60);
    const oldTags = tags(models), counts = oldTags.map(watchTag);
    const resources = new Set<THREE.BufferGeometry | THREE.Material>();
    models.group.traverse(object => {
      if (object instanceof THREE.Mesh) {
        resources.add(object.geometry);
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) resources.add(material);
      } else if (object instanceof THREE.Sprite) resources.add(object.geometry);
    });
    let sharedDisposals = 0;
    const disposed = () => sharedDisposals++;
    for (const resource of resources) resource.addEventListener('dispose', disposed);
    try {
      models.clear();
      models.clear();
      assert.equal(models.group.children.length, 0);
      assert.equal(models.muzzlePos(driver.id), null);
      assert.equal(models.flashVehicle(gunner.id), false);
      for (const count of counts) assert.deepEqual(count, { texture: 1, material: 1 });
      assert.equal(sharedDisposals, 0, 'body, weapon, hull, crew and sprite geometry remain shared');
      models.update([view(1)], new Map([[1, 'New world']]), 1 / 60);
      assert.equal(models.group.children.length, 1, 'clear remains reusable for a new welcome');
      assert.notEqual(tags(models)[0].material.map, oldTags[0].material.map);
      models.remove(1);
      assert.equal(sharedDisposals, 0);
    } finally {
      for (const resource of resources) resource.removeEventListener('dispose', disposed);
    }
  });
});
