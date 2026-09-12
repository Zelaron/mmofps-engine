import * as THREE from 'three';
import { ROCK_GRANITE_PLANES, type RockBounds, type World } from '@shared/index';
import type { ScenerySource } from './scenery-stream.js';
import { createSurfaceNoise } from './surface-material.js';
import { boulderGeometry } from './rock-geometry.js';
import { applyCitySceneryTint } from './city-environment.js';
export { boulderGeometry } from './rock-geometry.js';

export const ROCK_RENDER_CELL_SIZE = 64;
// The far edge stays at least 914m from the camera throughout a rebuild cell,
// beyond even the grenade's 840m maximum authoritative travel distance.
export const ROCK_RENDER_RADIUS = 960;
export const ROCK_NEAR_DISTANCE = 300;
export const ROCK_NEAR_BUDGET = 128;
// At most two boulders inhabit a 36m generation cell. The complete query
// rectangle can touch at most 56*56 cells; this capacity never culls cover.
export const MAX_ROCK_VISUALS = 6272;
type RockWorld = Pick<World, 'collectBoulders' | 'column'>;

function rockMaterial(): THREE.MeshStandardMaterial {
  const texture = createSurfaceNoise();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: .94, metalness: 0 });
  material.customProgramCacheKey = () => 'instanced-geological-boulders-physical-v2';
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rockNoise = { value: texture };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        attribute float rockVariation;
        varying vec3 vRockPosition;
        varying vec3 vRockNormal;
      `)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        // Instance transforms contain translation and nonuniform scale only.
        vRockNormal = normalize(mat3(modelMatrix) * (objectNormal / vec3(
          instanceMatrix[0][0], instanceMatrix[1][1], instanceMatrix[2][2])));
      `)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        if (rockVariation >= 0.0) {
          // Analytic radial intersection with the canonical granite core and
          // planes; the instance's continuous lean needs no CPU geometry copy.
          vec3 d = normalize(transformed);
          float lean = (rockVariation - 0.5) * 0.24;
          float u = d.x + d.y * lean + d.z * 0.11;
          float v = d.z - d.x * 0.13 + d.y * 0.04;
          float a = u * u * 1.15 + d.y * d.y * 0.90 + v * v * 1.32;
          float b = d.y * 0.18;
          float r = (-b + sqrt(b * b + 4.0 * a * 1.0726)) / (2.0 * a);
          r = min(r, 1.0 / max(max(abs(d.x), abs(d.y)), abs(d.z)));
          ${ROCK_GRANITE_PLANES.map((p) => `r = min(r, ${p[3].toFixed(9)} / max(0.00001,
            dot(d, vec3(${p[0].toFixed(9)}, ${p[1].toFixed(9)}, ${p[2].toFixed(9)}))));`).join('\n')}
          transformed = d * r;
        }
        vRockPosition = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
      `);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D rockNoise;
        varying vec3 vRockPosition;
        varying vec3 vRockNormal;
      `)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 rockN = abs(normalize(vRockNormal));
        vec2 rockUV = rockN.y > max(rockN.x, rockN.z) ? vRockPosition.xz :
          (rockN.x > rockN.z ? vRockPosition.zy : vRockPosition.xy);
        vec2 grain = texture2D(rockNoise, rockUV * 0.085).rg;
        vec2 closeGrain = texture2D(rockNoise, rockUV * 0.41).rg;
        float nearDetail = 1.0 - smoothstep(100.0, 330.0, length(vViewPosition));
        float bedding = sin(vRockPosition.y * 5.4 + vRockPosition.x * 0.42 + grain.y * 1.1);
        float mineral = 1.0 - smoothstep(0.02, 0.13, abs(bedding));
        float grit = (grain.x - 0.5) * 0.23 + (grain.y - 0.5) * 0.31 +
          (closeGrain.x - 0.5) * 0.14;
        diffuseColor.rgb *= 1.0 + (grit + bedding * 0.035) * nearDetail;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.24, 1.20, 1.08),
          mineral * nearDetail * 0.32);
        float rockHeight = (grain.y * 0.11 + closeGrain.y * 0.032 + closeGrain.x * 0.002) * nearDetail;
      `)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        // A small world-space relief field reuses the two color samples.
        // Fragment derivatives light pits and grain without extra triangles,
        // texture reads, passes, or changes to the collision silhouette.
        vec3 rockDx = dFdx(-vViewPosition), rockDy = dFdy(-vViewPosition);
        vec3 rockR1 = cross(rockDy, normal), rockR2 = cross(normal, rockDx);
        float rockDet = dot(rockDx, rockR1) * faceDirection;
        vec3 rockGradient = sign(rockDet) * (dFdx(rockHeight) * rockR1 + dFdy(rockHeight) * rockR2);
        normal = normalize(max(abs(rockDet), 0.0000001) * normal - rockGradient);
      `);
  };
  material.addEventListener('dispose', () => texture.dispose());
  applyCitySceneryTint(material, 'rock');
  return material;
}

/** Eight shared meshes, no animation or per-frame terrain sampling. The near
 * budget only selects detail: every remaining collidable rock uses a far mesh. */
export class RockRenderer {
  readonly group = new THREE.Group();
  private readonly material = rockMaterial();
  private readonly pools: THREE.InstancedMesh[] = [];
  private readonly matrix = new THREE.Matrix4();
  private readonly tint = new THREE.Color();
  private cellX: number | null = null;
  private cellZ: number | null = null;
  private disposed = false;

  constructor(private readonly world: RockWorld, private readonly scenery?: ScenerySource) {
    this.group.name = 'boulders';
    for (let lod = 0; lod < 2; lod++) {
      for (let family = 0; family < 4; family++) {
        const capacity = lod === 0 ? ROCK_NEAR_BUDGET : MAX_ROCK_VISUALS;
        const geometry = boulderGeometry(family, lod === 0);
        geometry.setAttribute('rockVariation', new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1)
          .setUsage(THREE.DynamicDrawUsage));
        const mesh = new THREE.InstancedMesh(geometry, this.material, capacity);
        mesh.name = `boulders-${lod === 0 ? 'near' : 'far'}-${family}`;
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
          .setUsage(THREE.DynamicDrawUsage);
        mesh.castShadow = false;
        this.pools.push(mesh);
        this.group.add(mesh);
      }
    }
  }

  get count(): number { return this.pools.reduce((sum, mesh) => sum + mesh.count, 0); }

  update(cameraX: number, cameraZ: number): boolean {
    if (this.disposed || !Number.isFinite(cameraX) || !Number.isFinite(cameraZ)) return false;
    const cx = Math.floor(cameraX / ROCK_RENDER_CELL_SIZE);
    const cz = Math.floor(cameraZ / ROCK_RENDER_CELL_SIZE);
    if (cx === this.cellX && cz === this.cellZ) return false;
    const x = (cx + 0.5) * ROCK_RENDER_CELL_SIZE, z = (cz + 0.5) * ROCK_RENDER_CELL_SIZE;
    const bounds = { minX: x - ROCK_RENDER_RADIUS, maxX: x + ROCK_RENDER_RADIUS,
      minZ: z - ROCK_RENDER_RADIUS, maxZ: z + ROCK_RENDER_RADIUS };
    const source = this.scenery && !this.scenery.failed ? this.scenery.read('rocks', bounds) :
      this.world.collectBoulders(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ)
        .map(rock => ({ rock, desert: this.world.column(rock.x, rock.z).desert > .5 }));
    if (!source) return false;
    this.cellX = cx; this.cellZ = cz;
    const rocks = source
      .map(({ rock, desert }) => ({ rock, desert, distance: (rock.x - x) ** 2 + (rock.z - z) ** 2 }))
      .filter(({ distance }) => distance <= ROCK_RENDER_RADIUS ** 2)
      .sort((a, b) => a.distance - b.distance);
    for (const pool of this.pools) pool.count = 0;
    let nearCount = 0;
    for (const { rock, desert, distance } of rocks) {
      const variation = (rock.hx * 13.57 + rock.hz * 7.11) % 1;
      const family = Math.min(3, Math.floor(variation * 4));
      const near = distance < ROCK_NEAR_DISTANCE ** 2 && nearCount < ROCK_NEAR_BUDGET;
      if (near) nearCount++;
      const pool = this.pools[(near ? 0 : 4) + family];
      const i = pool.count++;
      this.matrix.makeScale(rock.hx, rock.hy, rock.hz).setPosition(rock.x, rock.y, rock.z);
      pool.setMatrixAt(i, this.matrix);
      this.colorFor(rock, family, desert);
      pool.setColorAt(i, this.tint);
      (pool.geometry.getAttribute('rockVariation') as THREE.InstancedBufferAttribute)
        .setX(i, family === 0 ? variation : -1);
    }
    for (const pool of this.pools) {
      pool.instanceMatrix.needsUpdate = true;
      pool.instanceColor!.needsUpdate = true;
      (pool.geometry.getAttribute('rockVariation') as THREE.InstancedBufferAttribute).needsUpdate = true;
      if (pool.count > 0) pool.computeBoundingSphere();
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const pool of this.pools) {
      pool.count = 0;
      this.group.remove(pool);
      pool.dispose();
      pool.geometry.dispose();
    }
    this.material.dispose();
  }

  private colorFor(rock: RockBounds, family: number, desert: boolean): void {
    this.tint.setHex(desert ? [0xaaa18b, 0xa6987f, 0x797870, 0xa19786][family] :
      [0x90958f, 0x7d8b87, 0x686e70, 0x92948b][family]);
    const variation = Math.sin(rock.x * 0.72 + rock.z * 0.51) * 0.07;
    this.tint.multiplyScalar(0.96 + variation);
  }
}
