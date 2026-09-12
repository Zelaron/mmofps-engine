import * as THREE from 'three';
import { WORLD, hash3i, unit, type Box, type World } from '@shared/index';
import { structureMaterial } from './structure-detail.js';
import { disjointStructureBoxes } from '@shared/structures';
import type { ScenerySource } from './scenery-stream.js';
import { StructureSamples, STRUCTURE_GENERATION_CELL as GENERATION_CELL,
  STRUCTURE_HALF_EXTENT as MAX_BOX_HALF_EXTENT, STRUCTURE_CACHE_CELLS, structureBoxKey as boxKey } from './scenery-samples.js';
export { STRUCTURE_CACHE_CELLS } from './scenery-samples.js';

/**
 * Authoritative structure boxes need an analytic rendering path in addition
 * to the terrain mesh. Coarse terrain LODs can otherwise omit a wall that is
 * still solid to players and projectiles.
 */
export const STRUCTURE_RENDER_CELL_SIZE = 128;
// At the least-covered edge of the active cell this leaves 896m of boxes,
// beyond the longest 700m authoritative weapon path.
export const STRUCTURE_RENDER_RADIUS_CELLS = 7;

/**
 * Complex installations and exact union decomposition need more instances
 * than single huts. The fixed 8192-box pool costs under 0.7MB of instance
 * data and still uses one solid draw call. Actual nearby counts stay lower.
 */
export const MAX_STRUCTURE_VISUALS = 8192;
/** Cosmetic fittings are close-range only and add exactly two draw pools. */
export const STRUCTURE_DETAIL_DISTANCE = 220;
export const STRUCTURE_DETAIL_BUDGET = 384;
export const STRUCTURE_TRIMS_PER_DETAIL = 8;

const MAX_CELL_SIZE = 512;
const MAX_RADIUS_CELLS = 12;
const IDENTITY_ROTATION = new THREE.Quaternion();
const STRUCTURE_PALETTES = [0xa4aaa6, 0xb4ac97, 0x889b9c, 0xa8a39a];
const CITY_PALETTES = [0xb5c2bc, 0xa6aca4, 0x597a80, 0x97aba6, 0xc4c1aa, 0x708f92];
const CITY_ROOF_PALETTES = [0x9a503e, 0xb77551, 0x744e45];
const CITY_INDUSTRIAL_PALETTES = [0x748589, 0x879391, 0x667d82];
const CITY_CANOPY_PALETTES = [0xc5a963, 0xbcb193, 0x986a4f];
const VESPER_PALETTES = [0x373048, 0x293947, 0x413149, 0x263d43];
const VESPER_METAL = [0x21323b, 0x354250, 0x452f50];
const AURELIA_PALETTES = [0xd1c8ac, 0xbebca4, 0xddd5bb, 0xbab7a1];
const AURELIA_GOLD = [0xaa8d45, 0xc7a353, 0xb79960];
interface OwnedGeometry { signature: string; boxes: Box[] }

export interface StructureRendererOptions {
  cellSize?: number;
  radiusCells?: number;
  maxInstances?: number;
}

export interface StructureRenderBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface StructureRenderStats {
  count: number;
  rejected: number;
  truncated: number;
}

type StructureSource = Pick<World, 'collectStructures'>;

/**
 * A camera-local, fixed-capacity overlay of authoritative structure solids.
 *
 * Shared structure boxes are already transformed into world-space AABBs.
 * A 2x2x2 BoxGeometry scaled by each half extent therefore matches the
 * authoritative sdBox exactly. Exact plinths travel with terrain chunks, so
 * their single owner remains visible beyond this nearby structure pool.
 */
export class StructureRenderer {
  readonly group = new THREE.Group();
  readonly cellSize: number;
  readonly radiusCells: number;
  readonly maxInstances: number;
  readonly stats: StructureRenderStats = {
    count: 0,
    rejected: 0,
    truncated: 0,
  };
  readonly timings = { query: 0, ownership: 0, instances: 0, fittings: 0, prefetch: 0 };

  private readonly samples: StructureSamples;
  private readonly geometry = new THREE.BoxGeometry(2, 2, 2);
  private readonly material = structureMaterial();
  private readonly trimMaterial = new THREE.MeshLambertMaterial({ color: 0x394b50 });
  // Emissive-looking paint costs no dynamic lights, shadows or bloom pass.
  private readonly lightMaterial = new THREE.MeshBasicMaterial({ color: 0xb7e1ce });
  private readonly solids: THREE.InstancedMesh;
  private readonly facade: THREE.InstancedBufferAttribute;
  private readonly trims: THREE.InstancedMesh;
  private readonly lights: THREE.InstancedMesh;

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly tint = new THREE.Color();
  private readonly trimBoxes: Box[] = [];
  private readonly ownedCells = new Map<string, OwnedGeometry>();
  private readonly ownedTrims = new Map<string, OwnedGeometry>();

  private activeCellX: number | null = null;
  private activeCellZ: number | null = null;
  private activeBounds: StructureRenderBounds | null = null;
  private disposed = false;

  constructor(
    world: StructureSource,
    options: StructureRendererOptions = {},
    private readonly scenery?: ScenerySource,
  ) {
    this.samples = new StructureSamples(world);
    this.cellSize = boundedInteger(
      options.cellSize,
      STRUCTURE_RENDER_CELL_SIZE,
      1,
      MAX_CELL_SIZE,
    );
    this.radiusCells = boundedInteger(
      options.radiusCells,
      STRUCTURE_RENDER_RADIUS_CELLS,
      0,
      MAX_RADIUS_CELLS,
    );
    this.maxInstances = boundedInteger(
      options.maxInstances,
      MAX_STRUCTURE_VISUALS,
      1,
      MAX_STRUCTURE_VISUALS,
    );

    this.solids = new THREE.InstancedMesh(
      this.geometry,
      this.material,
      this.maxInstances,
    );
    this.solids.name = 'structure-solids';
    // Two floats per box keep the whole skyline in the existing solid draw.
    this.facade = new THREE.InstancedBufferAttribute(new Float32Array(this.maxInstances * 2), 2);
    this.facade.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('instanceFacade', this.facade);
    this.solids.count = 0;
    this.solids.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.solids.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(this.maxInstances * 3).fill(1), 3,
    );
    this.solids.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.solids.castShadow = true;
    this.solids.receiveShadow = true;

    const detailCapacity = Math.min(this.maxInstances, STRUCTURE_DETAIL_BUDGET);
    this.trims = new THREE.InstancedMesh(this.geometry, this.trimMaterial, detailCapacity * STRUCTURE_TRIMS_PER_DETAIL);
    this.lights = new THREE.InstancedMesh(this.geometry, this.lightMaterial, detailCapacity * 2);
    this.trims.name = 'structure-metal-trim';
    this.lights.name = 'structure-marker-lights';
    for (const mesh of [this.trims, this.lights]) {
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }

    this.group.name = 'structures';
    this.group.add(this.solids, this.trims, this.lights);
  }

  get count(): number {
    return this.stats.count;
  }

  get bounds(): Readonly<StructureRenderBounds> | null {
    return this.activeBounds;
  }

  get cacheStats(): { cells: number; solids: number; trims: number; pending: number } {
    return { cells: this.samples.cells.size, solids: this.ownedCells.size,
      trims: this.ownedTrims.size, pending: this.samples.prefetch.length };
  }

  /**
   * Rebuild only after crossing a renderer cell. Returns true when the active
   * instance set changed and false for same-cell or invalid updates.
   */
  update(cameraX: number, cameraZ: number): boolean {
    if (
      this.disposed ||
      !Number.isFinite(cameraX) ||
      !Number.isFinite(cameraZ)
    ) {
      return false;
    }

    const cellX = Math.floor(cameraX / this.cellSize);
    const cellZ = Math.floor(cameraZ / this.cellSize);
    this.timings.prefetch = 0;
    if (cellX === this.activeCellX && cellZ === this.activeCellZ) {
      // Warm one frontier generation cell on an otherwise idle call. A
      // fast vehicle then reaches already sampled geometry instead of
      // synchronously fitting a whole new row at a 128 m boundary.
      const next = this.samples.prefetch.shift();
      if (next) {
        const start = performance.now();
        this.samples.collectCell(next.x, next.z);
        this.timings.prefetch = performance.now() - start;
      }
      return false;
    }

    const bounds: StructureRenderBounds = {
      minX: (cellX - this.radiusCells) * this.cellSize,
      maxX: (cellX + this.radiusCells + 1) * this.cellSize,
      minZ: (cellZ - this.radiusCells) * this.cellSize,
      maxZ: (cellZ + this.radiusCells + 1) * this.cellSize,
    };

    // collectStructures deliberately avoids boulders and vegetation. Exact
    // plinths are sent with terrain leaves; the remaining boxes are instanced.
    let stamp = performance.now();
    const source = this.scenery && !this.scenery.failed ? this.scenery.read('structures', bounds) : this.samples.collect(bounds);
    if (!source) return false;
    this.activeCellX = cellX;
    this.activeCellZ = cellZ;
    this.activeBounds = bounds;
    this.timings.query = performance.now() - stamp;
    stamp = performance.now();
    // Plinths are exact chunk geometry at every LOD. Keeping their same box
    // in this pool would reintroduce duplicate floors at close range.
    const visible: Box[] = [];
    let rejected = 0;
    for (const box of source) {
      if (validBox(box, bounds)) visible.push(box);
      else rejected++;
    }
    // Stable ownership prevents material boundaries moving when the camera
    // crosses a streaming cell. Only the final capacity selection is near-first.
    visible.sort(compareBoxes);

    // Intersecting wall/roof boxes share coplanar exterior faces with
    // different per-box material coordinates. Assign the occupied volume
    // once so camera motion cannot make those faces flash against each other.
    const owned = this.ownedGeometry(visible, this.ownedCells);
    owned.sort((a, b) => distanceSq(a, cameraX, cameraZ) - distanceSq(b, cameraX, cameraZ) ||
      a.x - b.x || a.z - b.z || a.y - b.y);
    this.timings.ownership = performance.now() - stamp;
    stamp = performance.now();
    const count = Math.min(owned.length, this.maxInstances);
    this.trims.count = 0;
    this.trimBoxes.length = 0;
    this.lights.count = 0;
    let details = 0;
    for (let i = 0; i < count; i++) {
      const box = owned[i];
      this.position.set(box.x, box.y, box.z);
      this.scale.set(box.hx, box.hy, box.hz);
      this.matrix.compose(this.position, IDENTITY_ROTATION, this.scale);
      this.solids.setMatrixAt(i, this.matrix);
      // A shared site palette ties individual walls/roofs into one complex.
      const blockSize = box.facade ? 64 : 256;
      const site = hash3i(0x6c27, Math.floor(box.x / blockSize), Math.floor(box.z / blockSize), 3);
      const style = (box.facade ?? 0) % 16;
      const palettes = (box.facade ?? 0) >= 32 ? (style >= 6 ? AURELIA_GOLD : AURELIA_PALETTES) :
        (box.facade ?? 0) >= 16 ? (style >= 6 ? VESPER_METAL : VESPER_PALETTES) :
        box.facade === 7 ? CITY_ROOF_PALETTES : box.facade === 6 ? CITY_INDUSTRIAL_PALETTES :
        box.facade === 8 ? CITY_CANOPY_PALETTES : box.facade ? CITY_PALETTES : STRUCTURE_PALETTES;
      const palette = palettes[Math.floor(unit(site) * palettes.length)];
      this.tint.setHex(palette);
      this.solids.setColorAt(i, this.tint);
      this.facade.setXY(i, box.facade ?? 0, box.floorY ?? 0);
      if (details < STRUCTURE_DETAIL_BUDGET &&
        distanceSq(box, cameraX, cameraZ) <= STRUCTURE_DETAIL_DISTANCE ** 2 &&
        this.addFittings(box)) {
        details++;
      }
    }
    this.solids.count = count;
    this.timings.instances = performance.now() - stamp;
    stamp = performance.now();
    // Adjacent fitted walls can still make overlapping L-shaped bands.
    // Assign their actual volume once, just as for the structural walls.
    const trims = this.ownedGeometry(this.trimBoxes, this.ownedTrims);
    this.trims.count = Math.min(trims.length, this.trims.instanceMatrix.count);
    for (let i = 0; i < this.trims.count; i++) {
      const b = trims[i];
      this.matrix.makeScale(b.hx, b.hy, b.hz).setPosition(b.x, b.y, b.z);
      this.trims.setMatrixAt(i, this.matrix);
    }
    this.solids.instanceMatrix.needsUpdate = true;
    this.solids.instanceColor!.needsUpdate = true;
    this.facade.needsUpdate = true;
    if (count > 0) this.solids.computeBoundingSphere();
    for (const mesh of [this.trims, this.lights]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.count > 0) mesh.computeBoundingSphere();
    }

    this.stats.count = count;
    this.stats.rejected = rejected;
    this.stats.truncated = owned.length - count;
    this.timings.fittings = performance.now() - stamp;
    return true;
  }

  private ownedGeometry(boxes: Box[], cache: Map<string, OwnedGeometry>): Box[] {
    const groups = new Map<string, Box[]>();
    for (const box of boxes) {
      const x = Math.floor(box.x / GENERATION_CELL), z = Math.floor(box.z / GENERATION_CELL);
      // Canonical installations fit their own generation cells. Custom or
      // future geometry that crosses a cell boundary keeps the exact global
      // union path, so caching can never introduce overlapping owners.
      if (box.x - box.hx < x * GENERATION_CELL || box.x + box.hx > (x + 1) * GENERATION_CELL ||
          box.z - box.hz < z * GENERATION_CELL || box.z + box.hz > (z + 1) * GENERATION_CELL) {
        return disjointStructureBoxes(boxes);
      }
      const key = `${x},${z}`, group = groups.get(key);
      if (group) group.push(box); else groups.set(key, [box]);
    }
    const result: Box[] = [];
    for (const [key, group] of groups) {
      group.sort(compareBoxes);
      const signature = group.map(boxKey).join(';');
      let owned = cache.get(key);
      if (!owned || owned.signature !== signature) {
        owned = { signature, boxes: disjointStructureBoxes(group) };
      }
      boundedSet(cache, key, owned);
      result.push(...owned.boxes);
    }
    return result;
  }

  /** Release all three fixed GPU pools. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of [this.solids, this.trims, this.lights]) {
      mesh.count = 0;
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.geometry.dispose();
    this.material.dispose();
    this.trimMaterial.dispose();
    this.lightMaterial.dispose();
    this.activeBounds = null;
    this.stats.count = 0;
    this.stats.rejected = 0;
    this.stats.truncated = 0;
    this.samples.cells.clear(); this.ownedCells.clear(); this.ownedTrims.clear(); this.samples.prefetch.length = 0;
  }

  /** Fittings follow each existing solid; nothing spans an opening or route. */
  private addFittings(box: Box): boolean {
    // City architecture carries its own cornices, awnings and shopfronts.
    if (box.facade) return false;
    const wall = box.hy >= 0.85 && Math.min(box.hx, box.hz) <= 1.2 &&
      Math.max(box.hx, box.hz) >= 1.5;
    const slab = box.hy < 0.85 && Math.min(box.hx, box.hz) > 2;
    if (!wall && !slab) return false;
    const width = 0.055;
    const inset = 0.025;
    if (slab) {
      // Four flush metal coping edges give roof slabs and foundation aprons
      // a manufactured silhouette without adding new walkable surfaces.
      for (const side of [-1, 1]) {
        this.fitting(this.trims, box.x, box.y + box.hy - width + 0.012,
          box.z + side * (box.hz - width - inset), box.hx - inset, width, width);
        this.fitting(this.trims, box.x + side * (box.hx - width - inset),
          box.y + box.hy - width + 0.012, box.z, width, width, box.hz - width * 2 - inset - 0.005);
      }
      return true;
    }
    const alongX = box.hx > box.hz;
    for (const side of [-1, 1]) {
      // The broad faces reveal 2cm beyond the wall. All end caps are inset
      // inside it: a flush endpoint still z-fights when viewed around a corner.
      this.fitting(this.trims, box.x, box.y + side * (box.hy - width - inset), box.z,
        box.hx + (alongX ? -inset : 0.02), width, box.hz + (alongX ? 0.02 : -inset));
      this.fitting(this.trims,
        box.x + (alongX ? side * (box.hx - width - inset) : 0), box.y,
        box.z + (alongX ? 0 : side * (box.hz - width - inset)),
        alongX ? width : box.hx + 0.02, box.hy - width * 2 - inset - 0.005,
        alongX ? box.hz + 0.02 : width);
      const lightY = box.y + box.hy - 0.29;
      this.fitting(this.lights,
        box.x + (alongX ? 0 : side * (box.hx + 0.026)), lightY,
        box.z + (alongX ? side * (box.hz + 0.026) : 0),
        alongX ? 0.24 : 0.016, 0.035, alongX ? 0.016 : 0.24);
    }
    return true;
  }

  private fitting(
    mesh: THREE.InstancedMesh,
    x: number, y: number, z: number,
    hx: number, hy: number, hz: number,
  ): void {
    if (mesh === this.trims) {
      this.trimBoxes.push({ x, y, z, hx, hy, hz });
      return;
    }
    this.position.set(x, y, z);
    this.scale.set(hx, hy, hz);
    this.matrix.compose(this.position, IDENTITY_ROTATION, this.scale);
    mesh.setMatrixAt(mesh.count++, this.matrix);
  }
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

function compareBoxes(a: Box, b: Box): number {
  return a.x - b.x || a.z - b.z || a.y - b.y || a.hx - b.hx || a.hy - b.hy || a.hz - b.hz;
}

function boundedSet<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  if (cache.size >= STRUCTURE_CACHE_CELLS) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
}

function distanceSq(box: Box, x: number, z: number): number {
  const dx = box.x - x;
  const dz = box.z - z;
  return dx * dx + dz * dz;
}

function validBox(
  box: Box,
  bounds: StructureRenderBounds,
): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.z) &&
    Number.isFinite(box.hx) &&
    Number.isFinite(box.hy) &&
    Number.isFinite(box.hz) &&
    box.hx > 0 &&
    box.hy > 0 &&
    box.hz > 0 &&
    box.hx <= MAX_BOX_HALF_EXTENT &&
    box.hy <= MAX_BOX_HALF_EXTENT &&
    box.hz <= MAX_BOX_HALF_EXTENT &&
    box.x + box.hx >= bounds.minX &&
    box.x - box.hx < bounds.maxX &&
    box.z + box.hz >= bounds.minZ &&
    box.z - box.hz < bounds.maxZ &&
    box.x + box.hx > -WORLD.BORDER &&
    box.x - box.hx < WORLD.BORDER &&
    box.z + box.hz > -WORLD.BORDER &&
    box.z - box.hz < WORLD.BORDER
  );
}
