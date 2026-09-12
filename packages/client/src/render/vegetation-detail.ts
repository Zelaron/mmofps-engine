import * as THREE from 'three';
import { nativeFoliageGeometry, nativeFoliageTexture, FOLIAGE_WIND_GLSL } from './native-foliage.js';
import { SURFACE_GRADIENT_GLSL } from './material-detail.js';

type Point = readonly [number, number, number];

export function broadleafGeometry(): THREE.BufferGeometry { return nativeFoliageGeometry(false); }
export function coniferGeometry(): THREE.BufferGeometry { return nativeFoliageGeometry(true); }

/** Tapered fork and two secondary twigs in one shared 60-triangle mesh. */
export function branchGeometry(): THREE.BufferGeometry {
  const vertices: number[] = [];
  const colors: number[] = [];
  const segment = (a: Point, b: Point, ra: number, rb: number): void => {
    const direction = new THREE.Vector3(b[0] - a[0], (b[1] - a[1]) * 8, b[2] - a[2]).normalize();
    const rotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
    const ringPoint = (center: Point, radius: number, k: number): Point => {
      const angle = k * Math.PI * 2 / 6;
      const v = new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius).applyQuaternion(rotation);
      return [center[0] + v.x, center[1] * 8 + v.y, center[2] + v.z];
    };
    for (let k = 0; k < 6; k++) {
      const p = ringPoint(a, ra, k), q = ringPoint(a, ra, k + 1);
      const r = ringPoint(b, rb, k), t = ringPoint(b, rb, k + 1);
      for (const v of [p, r, q, q, r, t]) {
        vertices.push(v[0], v[1] / 8, v[2]);
        const shade = 0.70 + (v[1] / 8 + 0.5) * 0.24;
        colors.push(shade, shade * 0.94, shade * 0.85);
      }
    }
  };
  segment([0, -0.5, 0], [0.35, 0.02, 0.12], 1, 0.60);
  segment([0.35, 0.02, 0.12], [0.10, 0.50, 0.06], 0.60, 0.10);
  segment([0.35, 0.02, 0.12], [1.85, 0.34, 0.65], 0.49, 0.055);
  segment([0.10, 0.29, 0.06], [-1.1, 0.44, -0.75], 0.22, 0.035);
  segment([1.1, 0.20, 0.46], [1.6, 0.40, -0.60], 0.18, 0.025);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function stemGeometry(): THREE.BufferGeometry {
  // The radius and both endpoints remain exact authoritative dimensions.
  const geometry = new THREE.CylinderGeometry(1, 1, 1, 10, 1);
  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i);
    const z = positions.getZ(i);
    const shade = 0.72 + (positions.getY(i) + 0.5) * 0.25 +
      Math.sin(Math.atan2(z, x) * 5) * 0.055;
    colors.set([shade, shade * 0.98, shade * 0.94], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export function detailPlantMaterial(
  material: THREE.MeshStandardMaterial,
  kind: 'leaves' | 'needles' | 'bark' | 'cactus',
  clock: { value: number },
): void {
  const foliage = kind === 'leaves' || kind === 'needles';
  material.vertexColors = true;
  if (foliage) {
    material.map = nativeFoliageTexture(kind === 'needles');
    material.side = THREE.DoubleSide;
    material.emissive.copy(material.color).multiplyScalar(0.025);
  }

  material.customProgramCacheKey = () => `vegetation-native-v1-${kind}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFoliageTime = clock;
    shader.vertexShader = `
      uniform float uFoliageTime;
      varying vec3 vPlantPoint;
      varying float vPlantDistance;
    ` + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      ${foliage ? FOLIAGE_WIND_GLSL : ''}
      vPlantPoint = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      vPlantDistance = distance(cameraPosition, vPlantPoint);
    `);
    shader.fragmentShader = `
      varying vec3 vPlantPoint;
      varying float vPlantDistance;
    ` + shader.fragmentShader;
    if (foliage) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${SURFACE_GRADIENT_GLSL}`)
        .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
          float ribPhase = ${kind === 'needles' ? '(vMapUv.x - .5) * (12.0 + vMapUv.y * 9.0) + vMapUv.y * .7' : 'vMapUv.x * 24.0 + sin(vMapUv.y * 9.0) * .09'};
          float ribFade = (1.0 - smoothstep(.08, .4, fwidth(ribPhase))) *
            (1.0 - smoothstep(40.0, 120.0, vPlantDistance));
          normal = detailNormal(-vViewPosition, normal, cos(ribPhase * 6.283185) * .012 * ribFade);
        `);
    }
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `
      #include <color_fragment>
      float plantDetailFade = 1.0 - smoothstep(65.0, 180.0, vPlantDistance);
      ${foliage ? `
        float mottling = sin(vPlantPoint.x * 9.0 + sin(vPlantPoint.z * 6.0)) *
          sin(vPlantPoint.y * 11.0 - vPlantPoint.z * 7.0);
        diffuseColor.rgb *= 1.0 + mottling * 0.16 * plantDetailFade;
      ` : `
        float bark = sin(vPlantPoint.x * 35.0 + vPlantPoint.z * 29.0 +
          sin(vPlantPoint.y * 2.4) * 0.65);
        float crevice = smoothstep(0.58, 0.92, bark);
        diffuseColor.rgb *= 1.0 - crevice * ${kind === 'cactus' ? '0.16' : '0.24'} * plantDetailFade;
      `}
    `);
  };
}
