import * as THREE from 'three';
import { createSurfaceNoise } from './surface-material.js';
import { SURFACE_GRADIENT_GLSL } from './material-detail.js';

/** Shared instanced material for painted machinery and transport structures.
 * Relief stays in the model's coordinates as trains/ferries move. */
export function createIndustrialMaterial(vertexColors = true): THREE.MeshStandardMaterial {
  const texture = createSurfaceNoise();
  const material = new THREE.MeshStandardMaterial({ vertexColors, roughness: .6, metalness: .24 });
  material.onBeforeCompile = shader => {
    shader.uniforms.industrialNoise = { value: texture };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vIndustrialPosition, vIndustrialNormal;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vIndustrialPosition = transformed;
        #ifdef USE_INSTANCING
          vIndustrialPosition *= vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #endif
        vIndustrialNormal = normal;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D industrialNoise;
        varying vec3 vIndustrialPosition, vIndustrialNormal;
        ${SURFACE_GRADIENT_GLSL}
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 industrialN = abs(normalize(vIndustrialNormal));
        vec2 panelPosition = industrialN.y > max(industrialN.x, industrialN.z) ? vIndustrialPosition.xz :
          (industrialN.x > industrialN.z ? vIndustrialPosition.zy : vIndustrialPosition.xy);
        vec2 industrialGrain = texture2D(industrialNoise, panelPosition * .14).rg;
        vec2 panelUV = panelPosition * .48;
        vec2 panelEdge = min(fract(panelUV), 1.0 - fract(panelUV));
        float panelAA = max(fwidth(panelUV.x) + fwidth(panelUV.y), .003);
        float joint = 1.0 - smoothstep(.007, .014 + panelAA, min(panelEdge.x, panelEdge.y));
        float industrialDetail = 1.0 - smoothstep(80.0, 240.0, length(vViewPosition));
        float industrialLuma = dot(diffuseColor.rgb, vec3(.2126, .7152, .0722));
        float bareMetal = (1.0 - smoothstep(.07, .2, max(diffuseColor.r, max(diffuseColor.g, diffuseColor.b)) - min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b)))) *
          (1.0 - smoothstep(.28, .5, industrialLuma)) * smoothstep(.02, .07, industrialLuma);
        float emissivePaint = smoothstep(.20, .38, min(diffuseColor.g, diffuseColor.b)) *
          (1.0 - smoothstep(.45, .9, diffuseColor.r / max(.001, diffuseColor.g)));
        diffuseColor.rgb *= 1.0 - (joint * .17 + (1.0 - industrialGrain.g) * .075) * industrialDetail;
        totalEmissiveRadiance += diffuseColor.rgb * emissivePaint * 1.35;
        float industrialHeight = (industrialGrain.r * .0015 + industrialGrain.g * .008 - joint * .009) * industrialDetail;
      `)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(mix(.64, .35, bareMetal) + (industrialGrain.g - .5) * .18, .25, .8);
      `)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
        metalnessFactor = mix(.12, .7, bareMetal);
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = detailNormal(-vViewPosition, normal, industrialHeight);
      `);
  };
  material.customProgramCacheKey = () => `industrial-relief-v1-${vertexColors}`;
  material.addEventListener('dispose', () => texture.dispose());
  return material;
}
