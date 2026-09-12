import * as THREE from 'three';
import { CAVE_ENTRANCE_THRESHOLD, WORLD, hash3i, unit, rockProfile, type Box, type World } from '@shared/index';

export const GROUND_COVER_CELL_SIZE = 16;
export const GROUND_COVER_RADIUS = 64;
export const MAX_GROUND_COVER_VISUALS = 768;
const GRASS_BUDGET = 640;
const STONE_BUDGET = MAX_GROUND_COVER_VISUALS - GRASS_BUDGET;
const GRID = 8;
const UP = new THREE.Vector3(0, 1, 0);
type GroundCoverWorld = Pick<World, 'seed' | 'column' | 'collectStructures'>;
interface CoverPlacement {
  grass: boolean;
  matrix: THREE.Matrix4;
  color: THREE.Color;
}
interface CoverCell {
  gx: number;
  gz: number;
  placements: CoverPlacement[];
}

function tussockGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  // Seven solid bent blades, three triangles each; no alpha-tested cards.
  for (let blade = 0; blade < 7; blade++) {
    const angle = blade * 2.39996;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const height = 0.34 + (blade % 3) * 0.13;
    const spread = 0.09 + (blade % 4) * 0.095;
    const base = [c * spread, -0.09, s * spread];
    const middle = [base[0] + c * 0.10, height * 0.52, base[2] + s * 0.10];
    const tip = [base[0] + c * 0.25, height, base[2] + s * 0.25];
    const point = (p: number[], width: number): number[] => [p[0] - s * width, p[1], p[2] + c * width];
    const bl = point(base, 0.043), br = point(base, -0.043);
    const ml = point(middle, 0.026), mr = point(middle, -0.026);
    for (const vertex of [bl, br, mr, bl, mr, ml, ml, mr, tip]) {
      positions.push(...vertex);
      const light = 0.55 + Math.max(0, vertex[1]) / height * 0.45;
      colors.push(light * 0.95, light, light * 0.86);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/** Fractured chips use the same geological envelope as collidable boulders. */
function stoneGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, 1);
  const positions = geometry.getAttribute('position');
  const colors = new Float32Array(positions.count * 3);
  for (let i = 0; i < positions.count; i++) {
    const x = positions.getX(i), y = positions.getY(i), z = positions.getZ(i);
    let lower = 0, upper = 2;
    for (let step = 0; step < 14; step++) {
      const radius = (lower + upper) * 0.5;
      if (rockProfile(x * radius, y * radius, z * radius, 0.37) < 0) lower = radius;
      else upper = radius;
    }
    const radius = (lower + upper) * 0.5;
    positions.setXYZ(i, x * radius, y * radius, z * radius);
    const stratum = Math.sin((y + x * 0.3) * 19) > 0.75 ? 0.79 : 1;
    const shade = (0.72 + (y + 1) * 0.12) * stratum;
    colors.set([shade * 0.97, shade, shade * 0.95], i * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function coverMaterial(grass: boolean, time: { value: number }): THREE.MeshLambertMaterial {
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    side: grass ? THREE.DoubleSide : THREE.FrontSide,
    vertexColors: true,
    flatShading: !grass,
  });
  material.customProgramCacheKey = () => `ground-cover-v1-${grass}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uCoverTime = time;
    shader.vertexShader = 'uniform float uCoverTime;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `
      #include <begin_vertex>
      vec3 coverOrigin = instanceMatrix[3].xyz;
      float coverDistance = distance(cameraPosition.xz, coverOrigin.xz);
      float coverFade = 1.0 - smoothstep(34.0, 50.0, coverDistance);
      ${grass ? `
        transformed.x += sin(uCoverTime * 1.7 + coverOrigin.x * 0.31 + coverOrigin.z * 0.19) *
          max(position.y, 0.0) * 0.085;
      ` : ''}
      transformed *= coverFade;
    `);
  };
  return material;
}

/** Two fixed, camera-local pools. Only a 16m cell transition samples terrain. */
export class GroundCoverRenderer {
  readonly group = new THREE.Group();
  private readonly grassGeometry = tussockGeometry();
  private readonly stoneGeometry = stoneGeometry();
  private readonly time = { value: 0 };
  private readonly grassMaterial = coverMaterial(true, this.time);
  private readonly stoneMaterial = coverMaterial(false, this.time);
  private readonly grass = this.pool('ground-grass', this.grassGeometry, this.grassMaterial, GRASS_BUDGET);
  private readonly stones = this.pool('ground-stones', this.stoneGeometry, this.stoneMaterial, STONE_BUDGET);
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3();
  private readonly matrix = new THREE.Matrix4();
  private readonly color = new THREE.Color();
  // Evicted to the current 17×17 grid rectangle on every rebuild, including
  // empty cells. Adjacent camera cells reuse their deterministic samples.
  private readonly cellCache = new Map<string, CoverCell>();
  private cellX: number | null = null;
  private cellZ: number | null = null;
  private disposed = false;

  constructor(private readonly world: GroundCoverWorld) {
    this.group.name = 'ground-cover';
    this.group.add(this.grass, this.stones);
  }

  get count(): number { return this.grass.count + this.stones.count; }

  animate(elapsedSeconds: number): void {
    if (!this.disposed && Number.isFinite(elapsedSeconds)) this.time.value = elapsedSeconds;
  }

  update(cameraX: number, cameraZ: number): boolean {
    if (this.disposed || !Number.isFinite(cameraX) || !Number.isFinite(cameraZ)) return false;
    const cx = Math.floor(cameraX / GROUND_COVER_CELL_SIZE);
    const cz = Math.floor(cameraZ / GROUND_COVER_CELL_SIZE);
    if (cx === this.cellX && cz === this.cellZ) return false;
    this.cellX = cx;
    this.cellZ = cz;
    const centerX = cx * GROUND_COVER_CELL_SIZE + GROUND_COVER_CELL_SIZE / 2;
    const centerZ = cz * GROUND_COVER_CELL_SIZE + GROUND_COVER_CELL_SIZE / 2;
    const minX = centerX - GROUND_COVER_RADIUS;
    const maxX = centerX + GROUND_COVER_RADIUS;
    const minZ = centerZ - GROUND_COVER_RADIUS;
    const maxZ = centerZ + GROUND_COVER_RADIUS;
    const structures = this.world.collectStructures(minX, maxX, minZ, maxZ);
    const minGridX = Math.floor(minX / GRID), maxGridX = Math.floor(maxX / GRID);
    const minGridZ = Math.floor(minZ / GRID), maxGridZ = Math.floor(maxZ / GRID);
    for (const [key, cell] of this.cellCache) {
      if (cell.gx < minGridX || cell.gx > maxGridX || cell.gz < minGridZ || cell.gz > maxGridZ) {
        this.cellCache.delete(key);
      }
    }
    this.grass.count = 0;
    this.stones.count = 0;
    for (let gx = minGridX; gx <= maxGridX; gx++) {
      for (let gz = minGridZ; gz <= maxGridZ; gz++) {
        const rand = (salt: number): number => unit(hash3i(this.world.seed + 0x27a9, gx, gz, salt));
        const x = (gx + 0.15 + rand(1) * 0.70) * GRID;
        const z = (gz + 0.15 + rand(2) * 0.70) * GRID;
        if ((x - centerX) ** 2 + (z - centerZ) ** 2 > GROUND_COVER_RADIUS ** 2 ||
          Math.max(Math.abs(x), Math.abs(z)) >= WORLD.BORDER - 2) continue;
        const key = `${gx},${gz}`;
        let cell = this.cellCache.get(key);
        if (!cell) {
          cell = { gx, gz, placements: this.sampleCell(x, z, rand, structures) };
          this.cellCache.set(key, cell);
        }
        for (const placement of cell.placements) {
          const mesh = placement.grass ? this.grass : this.stones;
          const budget = placement.grass ? GRASS_BUDGET : STONE_BUDGET;
          if (mesh.count >= budget) continue;
          mesh.setMatrixAt(mesh.count, placement.matrix);
          mesh.setColorAt(mesh.count++, placement.color);
        }
      }
    }
    for (const mesh of [this.grass, this.stones]) {
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      if (mesh.count > 0) {
        mesh.computeBoundingSphere();
        if (mesh.boundingSphere) mesh.boundingSphere.radius += 0.15;
      }
    }
    return true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of [this.grass, this.stones]) {
      mesh.count = 0;
      this.group.remove(mesh);
      mesh.dispose();
      mesh.geometry.dispose();
    }
    this.grassMaterial.dispose();
    this.stoneMaterial.dispose();
    this.cellCache.clear();
  }

  private sampleCell(
    x: number, z: number, rand: (salt: number) => number,
    structures: { pads: readonly Box[]; solids: readonly Box[] },
  ): CoverPlacement[] {
    const placements: CoverPlacement[] = [];
    const col = this.world.column(x, z);
    if (col.city || !Number.isFinite(col.h) || col.entr > CAVE_ENTRANCE_THRESHOLD - 0.08 ||
      col.lavaY > -999 || col.volc > 0.4 ||
      structures.pads.some((box) => covers(box, x, z)) ||
      structures.solids.some((box) => covers(box, x, z))) return placements;
    // Away from an entrance/pad, column.h is the exact terrain surface;
    // avoid full groundY ray marches and cache these cheap samples instead.
    const dx = this.world.column(x + 0.65, z).h - col.h;
    const dz = this.world.column(x, z + 0.65).h - col.h;
    if (dx * dx + dz * dz > 0.30) return placements;
    const grassy = col.desert < 0.5 && col.temp - Math.max(0, col.h) * 0.005 >= 0.34 &&
      col.h < 78 && rand(3) < 0.48 + col.moist * 0.45;
    if (grassy) {
      for (let k = 0; k < 3; k++) {
        const px = x + (rand(10 + k * 4) - 0.5) * 2.8;
        const pz = z + (rand(11 + k * 4) - 0.5) * 2.8;
        const support = this.world.column(px, pz);
        if (support.entr > CAVE_ENTRANCE_THRESHOLD - 0.08 || support.lavaY > -999 ||
          structures.pads.some((box) => covers(box, px, pz))) continue;
        const size = 0.68 + rand(12 + k * 4) * 0.72;
        this.color.setHex(col.moist > 0.5 ? 0x62754b : 0x8c8b55);
        this.color.multiplyScalar(0.85 + rand(13 + k * 4) * 0.25);
        placements.push(this.placement(true, px, support.h, pz,
          size, size, size, rand(4 + k) * Math.PI * 2));
      }
    }
    if (rand(5) < (grassy ? 0.23 : 0.72)) {
      const size = 0.19 + rand(6) * 0.31;
      this.color.setHex(col.desert > 0.5 ? 0x9d8e70 : 0x787e7b);
      placements.push(this.placement(false, x, col.h + size * 0.12, z,
        size * (1.05 + rand(8) * 0.95), size * (0.48 + rand(9) * 0.30), size, rand(7) * Math.PI * 2));
    }
    return placements;
  }

  private pool(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    return mesh;
  }

  private placement(grass: boolean, x: number, y: number, z: number,
    sx: number, sy: number, sz: number, yaw: number): CoverPlacement {
    this.position.set(x, y, z);
    this.rotation.setFromAxisAngle(UP, yaw);
    this.scale.set(sx, sy, sz);
    this.matrix.compose(this.position, this.rotation, this.scale);
    return { grass, matrix: this.matrix.clone(), color: this.color.clone() };
  }
}

function covers(box: Box, x: number, z: number): boolean {
  return Math.abs(x - box.x) <= box.hx + 2 && Math.abs(z - box.z) <= box.hz + 2;
}
