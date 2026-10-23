import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { DeathScene } from '../src/render/death-scene.js';
import type { World } from '@shared/worldgen';

test('corpse elbows and wrists stay connected while the body falls and tumbles', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ id: '', hidden: true, style: { cssText: '' }, textContent: '' }), body: { append() {} },
  } });
  try {
    const scene = new DeathScene(), camera = new THREE.PerspectiveCamera();
    const world = { trace: (x: number, y: number, z: number, dx: number, dy: number, dz: number, dist: number) => ({
      hit: false, x: x + dx * dist, y: y + dy * dist, z: z + dz * dist, nx: 0, ny: 0, nz: 0, dist,
    }) } as World;
    scene.begin(5, { x: 0, y: 25, z: 0, vx: 20, vy: 12, vz: 0, yaw: .4 }, false, camera, 0);
    const operator = scene.group.getObjectByName('operator')!;
    const validate = (): void => {
      scene.group.updateMatrixWorld(true);
      for (const side of [-1, 1]) {
        const upper = operator.getObjectByName(`sleeve-${side}`)!.parent!;
        const forearm = operator.getObjectByName(`forearm-${side}`)!.parent!;
        const hand = operator.getObjectByName(`glove-${side}`)!.parent!;
        // The authored .29m segment is scaled to the .335m joint length.
        assert.ok(upper.localToWorld(new THREE.Vector3(0, -.29, 0))
          .distanceTo(forearm.getWorldPosition(new THREE.Vector3())) < 1e-8, 'elbow detached from upper arm');
        assert.ok(forearm.localToWorld(new THREE.Vector3(0, -.29, 0))
          .distanceTo(hand.getWorldPosition(new THREE.Vector3())) < 1e-8, 'wrist detached from forearm');
      }
    };
    validate();
    for (let frame = 1; frame <= 20; frame++) { scene.update(world, camera, .05, frame * .05, false); validate(); }
    camera.position.set(0, 26.7, 0); camera.rotation.set(.2, 1, 0);
    const before = camera.quaternion.clone();
    scene.begin(6, { x: 0, y: 25, z: 0, vx: 0, vy: 0, vz: 0, yaw: 1 }, true, camera, 2);
    scene.update(world, camera, 0, 2, true);
    assert.ok(camera.quaternion.angleTo(before) < 1e-7, 'death camera starts at the actual view without an immediate rotation cut');
    scene.update(world, camera, .05, 2.16, true);
    assert.ok(camera.quaternion.angleTo(before) > .01, 'camera smoothly turns toward the falling body');
    scene.clear(); assert.equal(scene.group.children.length, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
