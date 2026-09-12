import * as THREE from 'three';
import { createSurfaceNoise } from './surface-material.js';
import { SURFACE_GRADIENT_GLSL } from './material-detail.js';

/** Close-up machining and molded grain; mipmaps and distance fade keep
 * remote weapons cheap and stable. The pattern moves with each assembly. */
export function createWeaponSurface(composite: boolean): THREE.MeshStandardMaterial {
  const noise = createSurfaceNoise();
  const material = new THREE.MeshStandardMaterial({ vertexColors: true,
    metalness: composite ? .05 : .75, roughness: composite ? .62 : .32 });
  material.onBeforeCompile = shader => {
    shader.uniforms.weaponGrain = { value: noise };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWeaponPosition, vWeaponNormal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWeaponPosition = transformed; vWeaponNormal = normal;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D weaponGrain;
        varying vec3 vWeaponPosition, vWeaponNormal;
        ${SURFACE_GRADIENT_GLSL}
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 weaponN = abs(normalize(vWeaponNormal));
        vec2 finishUV = weaponN.y > max(weaponN.x, weaponN.z) ? vWeaponPosition.xz :
          (weaponN.x > weaponN.z ? vWeaponPosition.zy : vWeaponPosition.xy);
        vec2 finishGrain = texture2D(weaponGrain, finishUV * ${composite ? 'vec2(4.0)' : 'vec2(14.0, 3.0)'}).rg;
        float finishDetail = 1.0 - smoothstep(2.0, 8.0, length(vViewPosition));
        diffuseColor.rgb *= 1.0 - (1.0 - finishGrain.g) * .065 * finishDetail;
        float finishHeight = (finishGrain.r - .5) * ${composite ? '.00008' : '.000035'} * finishDetail;
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (finishGrain.g - .5) * .18 * finishDetail, .2, .9);
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = detailNormal(-vViewPosition, normal, finishHeight);
      `);
  };
  material.customProgramCacheKey = () => `weapon-finish-v1-${composite}`;
  material.addEventListener('dispose', () => noise.dispose());
  return material;
}
