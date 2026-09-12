import * as THREE from 'three';
import { CAVE_HORIZON_RADIUS } from '@shared/constants';

// Terrain uses the default opaque render order (0). Visible terrain therefore
// seeds depth first, entrance caps mark only unobstructed aperture pixels next,
// and the cave horizon fills every remaining far pixel last.
export const CAVE_PORTAL_RENDER_ORDER = 1;
export const CAVE_HORIZON_RENDER_ORDER = 2;
export const CAVE_PORTAL_STENCIL_REF = 1;

/** Invisible, depth-tested parity of crossings through real cave mouths. */
export function createEntrancePortalMaterial(): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    side: THREE.DoubleSide,
    fog: false,
    colorWrite: false,
    depthTest: true,
    depthWrite: false,
    stencilWrite: true,
    stencilWriteMask: CAVE_PORTAL_STENCIL_REF,
    stencilRef: CAVE_PORTAL_STENCIL_REF,
    stencilFunc: THREE.AlwaysStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.InvertStencilOp,
  });
  // A cap can be streamed as far out as the LOD1 ring (768m), but it must
  // never stencil through the nearer 520m cave horizon. Clip in camera-space
  // radial distance per fragment; unlike ordinary linear fog, this remains
  // exact toward the edges of the wide field of view.
  material.onBeforeCompile = (shader) => {
    shader.uniforms.cavePortalMaxDistance = { value: CAVE_HORIZON_RADIUS };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vCavePortalViewPosition;',
      )
      .replace(
        '#include <project_vertex>',
        '#include <project_vertex>\n' +
        'vCavePortalViewPosition = mvPosition.xyz;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\n' +
        'uniform float cavePortalMaxDistance;\n' +
        'varying vec3 vCavePortalViewPosition;',
      )
      .replace(
        '#include <clipping_planes_fragment>',
        '#include <clipping_planes_fragment>\n' +
        'if (length(vCavePortalViewPosition) >= cavePortalMaxDistance) discard;',
      );
  };
  material.customProgramCacheKey = () => 'canonical-cave-portal-radius-v1';
  return material;
}
