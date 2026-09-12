import * as THREE from 'three';
import { CITY_THEME_INNER_SCALE, CITY_THEME_FADE_METRES, CITY_THEME_PALETTES,
  type CityThemeSite } from '@shared/city-themes';

/** All environment materials share two tiny immutable-location uniforms.
 * A new world replaces their values once, without rebuilding shaders. */
export const cityEnvironmentUniforms = {
  vesperRegion: { value: new THREE.Vector4(0, 0, 0, 0) },
  aureliaRegion: { value: new THREE.Vector4(0, 0, 0, 0) },
};

export function setCityEnvironmentSites(cities: readonly CityThemeSite[]): void {
  for (const theme of ['vesper', 'aurelia'] as const) {
    const city = cities.find(c => c.theme === theme);
    const region = cityEnvironmentUniforms[`${theme}Region`].value;
    if (city && Number.isFinite(city.x + city.z + city.radius) && city.radius > 0) {
      const inner = city.radius * CITY_THEME_INNER_SCALE;
      region.set(city.x, city.z, inner, inner + CITY_THEME_FADE_METRES);
    } else region.set(0, 0, 0, 0);
  }
}

export const CITY_REGION_GLSL = `
  uniform vec4 vesperRegion, aureliaRegion;
  float cityRegionWeight(vec2 position, vec4 region) {
    return region.w > 0.0 ? 1.0 - smoothstep(region.z, region.w, length(position - region.xy)) : 0.0;
  }
  vec2 cityRegionWeights(vec2 position) {
    vec2 weights = vec2(cityRegionWeight(position, vesperRegion), cityRegionWeight(position, aureliaRegion));
    return weights / max(1.0, weights.x + weights.y);
  }
  float outsideCityPaving(vec2 position, vec4 region) {
    vec2 offset = abs(position - region.xy);
    return region.w <= 0.0 ? 1.0 : step(region.z / ${CITY_THEME_INNER_SCALE.toFixed(2)}, max(offset.x, offset.y));
  }
  vec2 cityTerrainWeights(vec2 position) {
    // The city's exact slab already carries authored roads/parks/pavement.
    // Only the natural landscape outside that slab needs geological tint.
    return cityRegionWeights(position) * vec2(outsideCityPaving(position, vesperRegion),
      outsideCityPaving(position, aureliaRegion));
  }
`;

function rgb(hex: number): string {
  const c = new THREE.Color(hex);
  return `vec3(${c.r.toFixed(6)}, ${c.g.toFixed(6)}, ${c.b.toFixed(6)})`;
}

/** Shared palette math keeps distant impostors and nearby foliage in phase. */
export const CITY_TINT_GLSL = `
  vec3 cityPalette(vec3 base, vec2 weights, float plant, float mineral) {
    float lightness = dot(base, vec3(0.2126, 0.7152, 0.0722));
    vec3 vesper = mix(${rgb(CITY_THEME_PALETTES.vesper.rock)}, ${rgb(CITY_THEME_PALETTES.vesper.vegetation)}, plant);
    vec3 aurelia = mix(${rgb(CITY_THEME_PALETTES.aurelia.rock)}, ${rgb(CITY_THEME_PALETTES.aurelia.vegetation)}, plant);
    vec3 result = mix(base, vesper * (0.50 + lightness * 1.5), weights.x * 0.78);
    result = mix(result, aurelia * (0.58 + lightness * 1.45), weights.y * 0.52);
    result += mineral * (weights.x * ${rgb(CITY_THEME_PALETTES.vesper.mineral)} * 0.15 +
      weights.y * ${rgb(CITY_THEME_PALETTES.aurelia.mineral)} * 0.13);
    return result;
  }
`;

/** Append a world-anchored tint to existing instanced rock/foliage shaders;
 * no new meshes, texture samples, lights, or changes to the cover outline. */
export function applyCitySceneryTint(material: THREE.Material, kind: 'rock' | 'plant'): void {
  const previous = material.onBeforeCompile;
  const cacheKey = material.customProgramCacheKey();
  material.onBeforeCompile = (shader, renderer) => {
    previous.call(material, shader, renderer);
    Object.assign(shader.uniforms, cityEnvironmentUniforms);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vCitySceneryPosition;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 cityPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cityPosition = instanceMatrix * cityPosition;
        #endif
        vCitySceneryPosition = (modelMatrix * cityPosition).xyz;
      `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `#include <common>
      varying vec3 vCitySceneryPosition;
      ${CITY_REGION_GLSL}
      ${CITY_TINT_GLSL}
    `).replace('#include <color_fragment>', `#include <color_fragment>
      vec2 cityWeights = cityRegionWeights(vCitySceneryPosition.xz);
      float cityMineral = ${kind === 'rock' ? '(1.0 - smoothstep(0.035, 0.12, abs(sin(vCitySceneryPosition.y * 3.6 + vCitySceneryPosition.x * 0.09)))) * 0.6' : '0.0'};
      // Blue native fronds carry the same vegetation tint as green tissue.
      // Warm bark remains below the chroma threshold in both LODs.
      float cityPlant = ${kind === 'plant' ? 'smoothstep(0.005, 0.035, max(diffuseColor.g, diffuseColor.b) - diffuseColor.r)' : '0.0'};
      diffuseColor.rgb = cityPalette(diffuseColor.rgb, cityWeights, cityPlant, cityMineral);
    `);
  };
  material.customProgramCacheKey = () => `${cacheKey}-city-${kind}-v2`;
}
