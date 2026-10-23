import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { SceneMgr, createSky } from '../src/render/scene.js';
import { CityAtmosphere, BASE_SKY_HORIZON } from '../src/render/city-atmosphere.js';
import { ShaderPreparation } from '../src/render/shader-preparation.js';

/** Exercise the real atmosphere/render path without requiring a GPU in Node. */
function fixture() {
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(), sky = createSky();
  const atmosphereFog = new THREE.Fog(BASE_SKY_HORIZON, 90, 4600);
  const sun = new THREE.DirectionalLight();
  const atmosphere = new CityAtmosphere(sky.material, atmosphereFog,
    new THREE.HemisphereLight(), sun);
  atmosphere.setCities([{ x: 5120, y: 50, z: 5120, radius: 384, theme: 'aurelia' }]);
  scene.fog = atmosphereFog;
  const rendered: { color: number; near: number; far: number }[] = [];
  const manager: SceneMgr = Object.assign(Object.create(SceneMgr.prototype), {
    scene, camera, sky, cityAtmosphere: atmosphere, atmosphereFog, sun, lightDirection: new THREE.Vector3(),
    liquidFog: new THREE.Fog(0x164952, .6, 32), caveHorizon: new THREE.Object3D(),
    renderer: { info: { reset() {} } },
    shaderPreparation: new ShaderPreparation(() => {}, () => true), lastPlayable: false, worldPresented: false,
    contactLighting: { render(s: THREE.Scene, _camera: THREE.PerspectiveCamera, underwater: boolean) {
      const fog = s.fog as THREE.Fog;
      assert.equal(underwater, fog.near === .6, 'liquid haze disables contact darkening');
      rendered.push({ color: fog.color.getHex(), near: fog.near, far: fog.far });
    } },
  });
  const frame = (liquid: 'water' | 'lava' | null, x = 0, y = 20, z = 0) => {
    camera.position.set(x, y, z); manager.liquidKind = liquid; manager.render(true);
    return rendered.at(-1)!;
  };
  const dispose = () => {
    sky.geometry.dispose(); sky.material.uniforms.cloudNoise.value.dispose(); sky.material.dispose();
  };
  return { frame, dispose, sky };
}

test('submerged horizon uses the exact liquid fog color and restores the sky above water',()=>{
  const f=fixture();
  try {
    for(const kind of ['water','lava'] as const){
      const fog=f.frame(kind);assert.equal(f.sky.material.uniforms.liquidView.value,1);
      assert.equal(f.sky.material.uniforms.liquidColor.value.getHex(),fog.color);
    }
    f.frame(null);assert.equal(f.sky.material.uniforms.liquidView.value,0);
  }finally{f.dispose();}
});

test('leaving water or lava restores fog immediately even when cached atmosphere weights do not change', () => {
  const f = fixture();
  try {
    const dry = f.frame(null);
    for (const kind of ['water', 'lava', 'water'] as const) {
      const wet = f.frame(kind);
      assert.deepEqual(wet, { color: kind === 'water' ? 0x164952 : 0x9b2609, near: .6, far: kind === 'water' ? 32 : 7 });
      assert.deepEqual(f.frame(null), dry, `${kind} exit must restore color and visibility in the first dry frame`);
      assert.deepEqual(f.frame(null), dry, 'standing still must stay clear');
    }
  } finally { f.dispose(); }
});

test('dry respawn after water then lava cannot inherit either liquid fog', () => {
  const f = fixture();
  try {
    const dry = f.frame(null);
    f.frame('water', 0, -5, 0);
    f.frame('lava', 20, -5, 0);
    assert.deepEqual(f.frame(null, 100, 20, 0), dry, 'a new dry position with the same biome must reset haze');
  } finally { f.dispose(); }
});

test('travelling between atmospheres while submerged restores the destination atmosphere on exit', () => {
  const f = fixture();
  try {
    const city = f.frame(null, 5120, 52, 5120);
    const outside = f.frame(null);
    assert.notEqual(city.color, outside.color);
    f.frame('water');
    f.frame('water', 5120, 52, 5120);
    assert.deepEqual(f.frame(null, 5120, 52, 5120), city);
    f.frame('lava', 5120, 52, 5120);
    f.frame('lava');
    assert.deepEqual(f.frame(null), outside);
  } finally { f.dispose(); }
});
