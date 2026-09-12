import * as THREE from 'three';
import { CAVE_FOG_NEAR, CAVE_FOG_FAR } from '@shared/constants';
import { CAVE_FOG_HEX } from './atmosphere.js';
import { renderProfile } from './device-profile.js';
import { cityEnvironmentUniforms, CITY_REGION_GLSL, CITY_TINT_GLSL } from './city-environment.js';
import { ROAD_GLSL, ROAD_COLOR_GLSL, type RoadField } from './road-field.js';
import { SURFACE_GRADIENT_GLSL } from './material-detail.js';

/** Small repeatable, mipmapped grain: no network assets or per-frame work. */
export function createSurfaceNoise(): THREE.DataTexture {
  const size = 128;
  const bytes = new Uint8Array(size * size * 4);
  const hash = (x: number, y: number): number => {
    let h = Math.imul(x & 127, 374761393) ^ Math.imul(y & 127, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      // Separate frequencies in RG so the material can combine broad
      // mineral patches with fine grit using a single sample.
      bytes[i] = Math.round(hash(x, y) * 255);
      const u = x / 8, v = y / 8;
      const ix = Math.floor(u), iy = Math.floor(v);
      const fx = u - ix, fy = v - iy;
      const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
      const n = (a: number, b: number) => hash((a & 15) * 8, (b & 15) * 8);
      const a = n(ix, iy) * (1 - sx) + n(ix + 1, iy) * sx;
      const b = n(ix, iy + 1) * (1 - sx) + n(ix + 1, iy + 1) * sx;
      bytes[i + 1] = Math.round((a * (1 - sy) + b * sy) * 255);
      bytes[i + 2] = bytes[i + 1];
      bytes[i + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(bytes, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** All LODs share world-space geological detail. Triplanar projection follows
 * cliffs, floor and cave ceilings without stretching or changing collision. */
export function createTerrainMaterial(roads?: RoadField['uniforms']): THREE.MeshStandardMaterial {
  const texture = createSurfaceNoise();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: .92, metalness: 0 });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, cityEnvironmentUniforms);
    if (roads) Object.assign(shader.uniforms, roads);
    shader.uniforms.surfaceNoise = { value: texture };
    shader.uniforms.surfaceFogLimit = { value: renderProfile().fogFar };
    // Fog executes after output color conversion, like Three's own fog chunk.
    shader.uniforms.cavernFogColor = { value: new THREE.Color(CAVE_FOG_HEX) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float caveDepth;\nvarying float vCaveDepth;\nvarying vec3 vSurfacePosition;\nvarying vec3 vSurfaceNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCaveDepth = caveDepth * 0.25;\nvSurfacePosition = (modelMatrix * vec4(position, 1.0)).xyz;\nvSurfaceNormal = normalize(mat3(modelMatrix) * normal);');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D surfaceNoise;\nuniform float surfaceFogLimit;\nuniform vec3 cavernFogColor;\nvarying float vCaveDepth;\nvarying vec3 vSurfacePosition;\nvarying vec3 vSurfaceNormal;\n${SURFACE_GRADIENT_GLSL}\n${CITY_REGION_GLSL}\n${CITY_TINT_GLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 surfaceN = abs(normalize(vSurfaceNormal));
        vec3 projection = pow(surfaceN, vec3(4.0));
        projection /= max(0.0001, projection.x + projection.y + projection.z);
        vec2 grain = texture2D(surfaceNoise, vSurfacePosition.zy * 0.085).rg * projection.x;
        grain += texture2D(surfaceNoise, vSurfacePosition.xz * 0.085).rg * projection.y;
        grain += texture2D(surfaceNoise, vSurfacePosition.xy * 0.085).rg * projection.z;
        float macroGrain = texture2D(surfaceNoise, vSurfacePosition.xz * 0.0014).g;
        float slope = 1.0 - smoothstep(0.45, 0.85, surfaceN.y);
        float nearDetail = 1.0 - smoothstep(75.0, 320.0, length(vViewPosition));
        float strata = sin(vSurfacePosition.y * 1.7 + grain.y * 4.0) * slope;
        float brightness = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        float snow = smoothstep(0.68, 0.88, brightness) * smoothstep(0.5, 0.8, surfaceN.y);
        float vegetation = smoothstep(0.015, 0.075, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
        float detail = (grain.x - 0.5) * 0.22 + (grain.y - 0.5) * 0.43 + strata * 0.10;
        diffuseColor.rgb *= mix(0.87, 1.07, macroGrain) * (1.0 + detail * nearDetail);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.80, 0.89, 0.98), snow * (1.0 - macroGrain) * .42);
        float surfaceRelief = mix(0.065 + slope * 0.10, 0.015, snow);
        float detailHeight = (grain.y * surfaceRelief + grain.x * .004 + strata * slope * .017) * nearDetail;
        float cavern = smoothstep(1.5, 8.0, vCaveDepth);
        vec2 cityWeights = cityTerrainWeights(vSurfacePosition.xz) * (1.0 - cavern);
        float cityGrass = smoothstep(0.005, 0.05, diffuseColor.g - max(diffuseColor.r, diffuseColor.b));
        float cityVein = (1.0 - smoothstep(0.025, 0.12, abs(sin(vSurfacePosition.y * 2.9 + grain.y * 1.8)))) * slope * nearDetail;
        diffuseColor.rgb = cityPalette(diffuseColor.rgb, cityWeights, cityGrass, cityVein);
        ${roads ? ROAD_COLOR_GLSL + '\n        detailHeight *= mix(1.0, .15, roadCover);' : ''}
        // Mineral beds follow the rock across chunks and continue naturally
        // out onto exposed entrance walls instead of changing at a mode switch.
        float bedding = sin(vSurfacePosition.y * 0.72 + grain.y * 0.7 +
          sin(vSurfacePosition.x * 0.018 + vSurfacePosition.z * 0.021) * 1.8);
        float seam = 1.0 - smoothstep(0.04, 0.14, abs(bedding));
        // The canonical vertex palette carries limestone, copper, glacial
        // and fungal geology. Texture its existing hue rather than covering
        // every province with the same gray limestone overlay.
        vec3 mineralRock = diffuseColor.rgb * (0.90 + grain.x * 0.16 + bedding * slope * 0.065);
        mineralRock = mix(mineralRock, mineralRock * 1.45 + vec3(0.025),
          seam * 0.25 * nearDetail * slope);
        diffuseColor.rgb = mix(diffuseColor.rgb, mineralRock, cavern * 0.72);
        float nearbyBounce = 0.11 + 0.28 / (1.0 + dot(vViewPosition, vViewPosition) * 0.006);
        totalEmissiveRadiance += diffuseColor.rgb * cavern * nearbyBounce;
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(mix(.82, .66, snow) + vegetation * .1 + (grain.y - .5) * .16, .55, .98);
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = detailNormal(-vViewPosition, normal, detailHeight);
      `)
      .replace('#include <fog_fragment>', `
        #ifdef USE_FOG
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor,
            smoothstep(fogNear, min(fogFar, surfaceFogLimit), length(vViewPosition)));
        #endif
        float cavernFog = smoothstep(${CAVE_FOG_NEAR.toFixed(1)}, ${CAVE_FOG_FAR.toFixed(1)}, length(vViewPosition));
        gl_FragColor.rgb = mix(gl_FragColor.rgb, linearToOutputTexel(vec4(cavernFogColor, 1.0)).rgb,
          cavernFog * smoothstep(1.5, 8.0, vCaveDepth));
      `);
    if (roads) shader.fragmentShader = ROAD_GLSL + shader.fragmentShader;
  };
  material.customProgramCacheKey = () => `terrain-relief-triplanar-v8-${!!roads}`;
  material.addEventListener('dispose', () => texture.dispose());
  return material;
}
