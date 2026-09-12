import * as THREE from 'three';
import type { World } from '@shared/worldgen';
import type { CapitalSweep } from '@shared/capital-geometry';
import { buildAureliaPlan, AURELIA_STONE } from '@shared/aurelia-city';

export const AURELIA_RENDER_DISTANCE = 7200;

/** Continuous tapered sweeps with rounded ends match the canonical swept
 * stone volumes. Narrow ribs are hexagonal masonry; domes have sixteen sides.
 * Geometry is shared at every distance, avoiding skyline/near-shell overlap. */
export function aureliaSweepGeometry(sweeps: readonly CapitalSweep[], origin: { x: number; y: number; z: number }): THREE.BufferGeometry {
  const positions: number[] = [], colors: number[] = [], indices: number[] = [];
  const tangent = new THREE.Vector3(), u = new THREE.Vector3(), v = new THREE.Vector3(), axis = new THREE.Vector3();
  const stone = new THREE.Color(), accent = new THREE.Color(), tint = new THREE.Color();
  const push = (x: number, y: number, z: number, t: number): number => {
    const index = positions.length / 3;
    positions.push(x - origin.x, y - origin.y, z - origin.z);
    tint.copy(stone).lerp(accent, t); colors.push(tint.r, tint.g, tint.b); return index;
  };
  for (const sweep of sweeps) {
    const p = sweep.points, sides = sweep.kind === 'dome' ? 16 : sweep.kind === 'spire' ? 8 : 6;
    stone.setHex(sweep.color); accent.setHex(sweep.accent);
    const starts: number[] = [], frames: { u: THREE.Vector3; v: THREE.Vector3; t: THREE.Vector3 }[] = [];
    for (let i = 0; i < p.length; i++) {
      const a = p[Math.max(0, i - 1)], b = p[Math.min(p.length - 1, i + 1)];
      tangent.set(b.x - a.x, b.y - a.y, b.z - a.z).normalize();
      axis.set(0, Math.abs(tangent.y) > .95 ? 0 : 1, Math.abs(tangent.y) > .95 ? 1 : 0);
      u.crossVectors(axis, tangent).normalize(); v.crossVectors(tangent, u).normalize();
      frames.push({ u: u.clone(), v: v.clone(), t: tangent.clone() });
      starts.push(positions.length / 3);
      for (let j = 0; j < sides; j++) {
        const theta = j / sides * Math.PI * 2, c = Math.cos(theta) * p[i].radius, s = Math.sin(theta) * p[i].radius;
        push(p[i].x + u.x * c + v.x * s, p[i].y + u.y * c + v.y * s, p[i].z + u.z * c + v.z * s,
          sweep.kind === 'dome' ? (j % 4 === 0 ? .30 : .06) : j % 3 === 0 ? .08 : 0);
      }
      if (i) for (let j = 0; j < sides; j++) {
        const a = starts[i - 1] + j, b = starts[i - 1] + (j + 1) % sides;
        const c = starts[i] + j, d = starts[i] + (j + 1) % sides;
        indices.push(a, b, c, b, d, c);
      }
    }
    for (const end of [0, p.length - 1]) {
      const point = p[end], frame = frames[end], sign = end === 0 ? -1 : 1;
      const middle = positions.length / 3, r = point.radius * Math.SQRT1_2;
      for (let j = 0; j < sides; j++) {
        const theta = j / sides * Math.PI * 2, c = Math.cos(theta) * r, s = Math.sin(theta) * r;
        push(point.x + frame.u.x * c + frame.v.x * s + frame.t.x * r * sign,
          point.y + frame.u.y * c + frame.v.y * s + frame.t.y * r * sign,
          point.z + frame.u.z * c + frame.v.z * s + frame.t.z * r * sign, .05);
      }
      const tip = push(point.x + frame.t.x * point.radius * sign, point.y + frame.t.y * point.radius * sign,
        point.z + frame.t.z * point.radius * sign, .05);
      for (let j = 0; j < sides; j++) {
        const a = starts[end] + j, b = starts[end] + (j + 1) % sides, c = middle + j, d = middle + (j + 1) % sides;
        if (sign < 0) indices.push(a, c, b, b, c, d, c, tip, d);
        else indices.push(a, b, c, b, d, c, c, d, tip);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices); geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return geometry;
}

function stoneMaterial(vertexColors = false): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({ color: 0xffffff, vertexColors });
  material.onBeforeCompile = shader => {
    shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vShrineStone, vShrineScale, vShrineNormal;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec4 stonePosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          stonePosition = instanceMatrix * stonePosition;
          vShrineScale = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        #else
          vShrineScale = vec3(0.0);
        #endif
        vShrineStone = stonePosition.xyz;
        vShrineNormal = normal;
      `);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying vec3 vShrineStone, vShrineScale, vShrineNormal;')
      .replace('#include <color_fragment>', `#include <color_fragment>
        float masonry = smoothstep(0.94, 0.995, fract(vShrineStone.y * 0.16));
        float weathering = fract(dot(floor(vShrineStone / 3.0), vec3(0.173, 0.397, 0.237)));
        diffuseColor.rgb *= 0.94 + weathering * 0.07 - masonry * 0.045;
        // Deep multi-storey lancet bays, clustered piers and golden tracery.
        // These are opaque stone/glass recesses; the canonical wall remains
        // solid. Derivative widths keep the distant fine detail from flashing.
        float facade = step(39.0, vShrineScale.y) * (1.0 - smoothstep(0.25, 0.5, abs(vShrineNormal.y)));
        vec2 face = abs(vShrineNormal.x) > 0.5 ? vShrineStone.zy : vShrineStone.xy;
        float width = abs(vShrineNormal.x) > 0.5 ? vShrineScale.z : vShrineScale.x;
        float bay = clamp(width / 3.0, 11.0, 21.0);
        vec2 tile = vec2(fract(face.x / bay) - 0.5, fract((face.y + 19.0) / 91.0));
        float roof = 0.85 - pow(abs(tile.x) / 0.315, 0.8) * 0.25;
        float recessDistance = max(abs(tile.x) - 0.315, max(0.12 - tile.y, tile.y - roof));
        float aa = max(fwidth(recessDistance) * 1.3, 0.001);
        float recess = 1.0 - smoothstep(-aa, aa, recessDistance);
        float rim = (1.0 - smoothstep(0.018 - aa, 0.032 + aa, abs(recessDistance))) * (1.0 - recess);
        float mullion = 1.0 - smoothstep(0.018, 0.018 + max(fwidth(tile.x), 0.004), abs(tile.x));
        float crossbar = 1.0 - smoothstep(0.008, 0.008 + max(fwidth(tile.y), 0.004), abs(fract(tile.y * 6.0) - 0.5));
        float chamber = fract(dot(floor(face / vec2(bay, 15.0)), vec2(0.37, 0.73)));
        vec3 darkGlass = mix(vec3(0.013, 0.012, 0.009), vec3(0.19, 0.088, 0.021), smoothstep(0.7, 0.93, chamber));
        darkGlass = mix(darkGlass, diffuseColor.rgb * 0.50, max(mullion, crossbar) * 0.8);
        diffuseColor.rgb = mix(diffuseColor.rgb, darkGlass, recess * facade * 0.92);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.41, 0.30, 0.13), rim * facade * 0.52);
        float pier = smoothstep(0.40, 0.45, abs(tile.x));
        diffuseColor.rgb *= 1.0 - (1.0 - pier) * facade * 0.09;
        totalEmissiveRadiance += vec3(0.09, 0.031, 0.005) * recess * facade * smoothstep(0.80, 0.95, chamber) * (1.0 - max(mullion, crossbar));
      `);
  };
  material.customProgramCacheKey = () => 'aurelia-lancet-masonry-v2';
  return material;
}

/** Exactly two static draws own the entire capital, including distant boxes.
 * No dynamic rebuilding, detail popping, lights, textures or duplicate shells. */
export class AureliaCity {
  readonly group = new THREE.Group();
  readonly stats = { solids: 0, sweeps: 0, triangles: 0, draws: 0 };
  private readonly districts: { group: THREE.Group; x: number; y: number; z: number }[] = [];
  private disposed = false;
  constructor(world: Pick<World, 'collectCities'>) {
    this.group.name = 'aurelia-shrine-metropolis';
    for (const city of world.collectCities().filter(c => c.theme === 'aurelia')) {
      const plan = buildAureliaPlan(city), district = new THREE.Group();
      district.position.set(city.x, city.y, city.z);
      const boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(2, 2, 2), stoneMaterial(), plan.solids.length);
      boxes.name = 'aurelia-authoritative-masonry';
      const matrix = new THREE.Matrix4(), position = new THREE.Vector3(), scale = new THREE.Vector3(), q = new THREE.Quaternion(), color = new THREE.Color();
      for (let i = 0; i < plan.solids.length; i++) {
        const b = plan.solids[i];
        position.set(b.x - city.x, b.y - city.y, b.z - city.z); scale.set(b.hx, b.hy, b.hz);
        matrix.compose(position, q, scale); boxes.setMatrixAt(i, matrix);
        color.setHex(AURELIA_STONE[((b.facade ?? 64) - 64 + AURELIA_STONE.length) % AURELIA_STONE.length]);
        boxes.setColorAt(i, color);
      }
      boxes.instanceMatrix.needsUpdate = true; boxes.instanceColor!.needsUpdate = true; boxes.computeBoundingSphere();
      const sculpture = new THREE.Mesh(aureliaSweepGeometry(plan.sweeps, city), stoneMaterial(true));
      sculpture.name = 'aurelia-pointed-arches-and-spires';
      district.add(boxes, sculpture); district.visible = false; this.group.add(district);
      this.districts.push({ group: district, x: city.x, y: city.y, z: city.z });
      this.stats.solids += plan.solids.length; this.stats.sweeps += plan.sweeps.length;
      this.stats.triangles += plan.solids.length * 12 + sculpture.geometry.index!.count / 3;
    }
  }
  update(x: number, y: number, z: number): void {
    if (this.disposed) return;
    this.stats.draws = 0;
    for (const d of this.districts) {
      d.group.visible = Number.isFinite(x + y + z) && Math.hypot(x - d.x, z - d.z) < AURELIA_RENDER_DISTANCE && y < d.y + 3600;
      if (d.group.visible) this.stats.draws += 2;
    }
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    for (const d of this.districts) for (const mesh of d.group.children as THREE.Mesh[]) {
      mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose();
      if (mesh instanceof THREE.InstancedMesh) mesh.dispose();
    }
    this.districts.length = 0; this.group.clear(); this.stats.draws = 0;
  }
}
