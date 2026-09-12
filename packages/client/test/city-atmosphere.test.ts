import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSky, createCaveHorizon } from '../src/render/scene.js';
import { CityAtmosphere, BASE_SKY_TOP, BASE_SKY_HORIZON } from '../src/render/city-atmosphere.js';
import { setCityEnvironmentSites, cityEnvironmentUniforms, applyCitySceneryTint } from '../src/render/city-environment.js';
import { createTerrainMaterial } from '../src/render/surface-material.js';
import { CITY_THEME_PALETTES } from '@shared/city-themes';

const cities = [{ x: -4096, y: 35, z: -4096, radius: 384, theme: 'vesper' as const },
  { x: 5120, y: 50, z: 5120, radius: 384, theme: 'aurelia' as const }];

test('camera-local city atmosphere preserves the two-light/dome and cave visibility contracts', () => {
  const sky = createSky(), fog = new THREE.Fog(BASE_SKY_HORIZON, 90, 4600), cave = createCaveHorizon();
  const hemi = new THREE.HemisphereLight(), sun = new THREE.DirectionalLight();
  const mood = new CityAtmosphere(sky.material, fog, hemi, sun);
  mood.setCities(cities);
  const caveColor = cave.material.color.clone(), caveMask = cave.material.stencilFunc;
  for (const c of cities) {
    mood.update({ x: c.x, y: c.y + 1.62, z: c.z });
    assert.ok(sky.material.uniforms.skyTop.value.equals(new THREE.Color(CITY_THEME_PALETTES[c.theme].skyTop)));
    assert.ok(fog.color.equals(sky.material.uniforms.skyHorizon.value));
    assert.ok(sun.position.equals(sky.material.uniforms.sunDirection.value));
    // The physical surface shader also receives the sky environment; preserve
    // readable directional contrast and a nonzero ambient floor in both cities.
    assert.ok(hemi.intensity >= .68 && sun.intensity >= 1.7, 'twilight retains ambient fill and the key light');
  }
  mood.update({ x: 0, y: 20, z: 0 });
  assert.ok(sky.material.uniforms.skyTop.value.equals(BASE_SKY_TOP));
  assert.ok(fog.color.equals(BASE_SKY_HORIZON));
  assert.equal(fog.near, 90); assert.equal(fog.far, 4600);
  assert.ok(cave.material.color.equals(caveColor)); assert.equal(cave.material.stencilFunc, caveMask);
  assert.equal(sky.material.depthWrite, false); assert.equal(sky.material.side, THREE.BackSide);
  assert.equal((sky.material.fragmentShader.match(/texture2D\(/g) ?? []).length, 2, 'new cloud strata reuse the original two noise samples');
  sky.geometry.dispose(); sky.material.uniforms.cloudNoise.value.dispose(); sky.material.dispose();
  cave.geometry.dispose(); cave.material.dispose();
});

test('world-anchored scenery palettes preserve underlying shaders and reset between worlds', () => {
  setCityEnvironmentSites([{ x: 0, y: 0, z: 0, radius: 384 }, ...cities]);
  assert.equal(cityEnvironmentUniforms.vesperRegion.value.x, -4096);
  assert.equal(cityEnvironmentUniforms.aureliaRegion.value.x, 5120);
  const terrain = createTerrainMaterial();
  const shader = () => ({ uniforms: {} as Record<string, {value: unknown}>,
    vertexShader: '#include <common>\nvoid main(){\n#include <begin_vertex>\n#include <project_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main(){\n#include <color_fragment>\n#include <fog_fragment>\n}' });
  const ts = shader(); (terrain.onBeforeCompile as unknown as (s: typeof ts) => void)(ts);
  assert.match(ts.fragmentShader, /cityTerrainWeights\(vSurfacePosition.xz\) \* \(1.0 - cavern\)/,
    'interior geology remains independent from city surface accents');
  assert.match(ts.fragmentShader, /outsideCityPaving\(position, vesperRegion\)/,
    'authored city pavement colors are not repaletted as natural terrain');
  assert.match(ts.fragmentShader, /cavernFogColor/);
  assert.equal(ts.uniforms.vesperRegion, cityEnvironmentUniforms.vesperRegion);
  for (const kind of ['rock', 'plant'] as const) {
    const material = new THREE.MeshLambertMaterial();
    material.onBeforeCompile = s => { s.uniforms.existingDetail = { value: 7 }; };
    applyCitySceneryTint(material, kind);
    const s = shader(); (material.onBeforeCompile as unknown as (compiled: typeof s) => void)(s);
    assert.equal(s.uniforms.existingDetail.value, 7);
    assert.match(s.vertexShader, /instanceMatrix \* cityPosition/);
    assert.match(s.fragmentShader, /cityRegionWeights\(vCitySceneryPosition.xz\)/);
    material.dispose();
  }
  terrain.dispose(); setCityEnvironmentSites([]);
  assert.equal(cityEnvironmentUniforms.vesperRegion.value.w, 0);
  assert.equal(cityEnvironmentUniforms.aureliaRegion.value.w, 0);
});
