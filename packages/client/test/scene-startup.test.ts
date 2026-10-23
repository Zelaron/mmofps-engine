import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneMgr, createSky } from '../src/render/scene.js';
import { ShaderPreparation } from '../src/render/shader-preparation.js';

test('waiting for a snapshot performs no world draw and joining still waits for complete shader preparation', () => {
  const sky = createSky(), camera = new THREE.PerspectiveCamera();
  let submissions = 0, draws = 0, ready = false, atmosphereUpdates = 0;
  const preparation = new ShaderPreparation(() => { submissions++; }, () => ready);
  const manager: SceneMgr = Object.assign(Object.create(SceneMgr.prototype), {
    scene: new THREE.Scene(), camera, sky, caveHorizon: new THREE.Object3D(),
    atmosphereFog: new THREE.Fog(0x888888, 90, 4600),
    cityAtmosphere: { update() { atmosphereUpdates++; } },
    sun: new THREE.DirectionalLight(), lightDirection: new THREE.Vector3(),
    renderer: { info: { reset() {} } }, shaderPreparation: preparation,
    lastPlayable: false, worldPresented: false, contextLost: false,
    contactLighting: { render() { draws++; } },
  });
  const presented = () => (manager as unknown as { worldPresented: boolean }).worldPresented;
  try {
    for (let i = 0; i < 10; i++) manager.render(false);
    assert.equal(submissions, 0);
    assert.equal(draws, 0);
    assert.equal(atmosphereUpdates, 0);
    assert.equal(presented(), false);

    manager.render(true);
    assert.equal(submissions, 1);
    assert.equal(draws, 0, 'joining still waits for shader completion');
    assert.equal(presented(), false);
    ready = true;
    manager.render(true);
    assert.equal(submissions, 2, 'the current scene is verified before its first draw');
    assert.equal(draws, 1);
    assert.equal(presented(), true);

    ready = false;
    for (let i = 0; i < 10; i++) manager.render(false);
    assert.equal(submissions, 2);
    assert.equal(draws, 1);
    assert.equal(presented(), false, 'a loading transition withdraws the presented-world signal');
    assert.equal(preparation.pending, true);
    manager.render(true);
    assert.equal(submissions, 3);
    assert.equal(draws, 1, 'rejoining cannot reuse a stale preparation result');
    ready = true;
    manager.render(true);
    assert.equal(draws, 2);
    assert.equal(presented(), true);
  } finally {
    sky.geometry.dispose(); sky.material.uniforms.cloudNoise.value.dispose(); sky.material.dispose();
  }
});
