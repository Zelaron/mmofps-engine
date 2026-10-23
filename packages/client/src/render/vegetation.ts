import * as THREE from 'three';
import type { ScenerySource } from './scenery-stream.js';
import { sceneryPlacementReady, type SceneryTerrain } from './scenery-readiness.js';
import {
  WORLD,
  VEGETATION_KIND,
  TAU,
  hash3i,
  unit,
  type VegetationPlacement,
  type World,
} from '@shared/index';
import {
  broadleafGeometry,
  coniferGeometry,
  stemGeometry,
  branchGeometry,
  detailPlantMaterial,
} from './vegetation-detail.js';
import { applyCitySceneryTint } from './city-environment.js';
import { nativeFoliageGeometry, foliageDepthMaterial } from './native-foliage.js';

/**
 * Vegetation is deterministic world decoration, not replicated game state.
 * Keep both the query footprint and GPU pools bounded so a dense future biome
 * cannot grow the scene graph or allocate new meshes while the player moves.
 */
export const VEGETATION_RENDER_CELL_SIZE = 64;
// The nearest edge is 14 cells (896m) away, beyond every weapon's maximum
// authoritative reach (the grenade's 840m ballistic path budget), so a
// distant projectile never strikes an unseen stem.
export const VEGETATION_RENDER_RADIUS_CELLS = 14;
export const MAX_VEGETATION_VISUALS = 4096;
/**
 * Plants beyond this camera distance retain small open membrane/frond
 * silhouettes and their solid stem. No extra per-plant scene objects.
 */
export const VEGETATION_NEAR_DISTANCE = 300;
/** Hard ceiling on detailed instances regardless of the distance ring. */
export const VEGETATION_NEAR_BUDGET = 1024;

const MAX_CELL_SIZE = 512;
const MAX_RADIUS_CELLS = 14;
const MAX_STEM_RADIUS = 24;
const MAX_STEM_HEIGHT = 80;
const MAX_CANOPY_RADIUS = 32;

/** Cosmetic per-plant parts beyond the base silhouette, bounding the pools. */
const MAX_BROADLEAF_LOBES = 4;
const MAX_BROADLEAF_BRANCHES = 8;
const MAX_CONIFER_TIERS = 3;
const MAX_CACTUS_ARMS = 3;

const UP = new THREE.Vector3(0, 1, 0);
const ARM_ROTATION = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 0, 1),
  Math.PI * 0.5,
);

// Base material colors, shared by the far-LOD tints (the far pools use a
// white material, so their instance colors are these bases times the same
// per-plant channel multipliers the detailed pools use - a plant keeps its
// exact hue when it crosses the LOD ring).
function linearRgb(hex: number): readonly [number, number, number] {
  const color = new THREE.Color(hex);
  return [color.r, color.g, color.b];
}
// Instance colors are already linear. Passing sRGB fractions here used to
// make distant impostors much brighter than the same trees up close.
const WOOD_RGB = linearRgb(0x817460);
const BROADLEAF_RGB = linearRgb(0x719e90);
const CONIFER_RGB = linearRgb(0x6797ab);
const CACTUS_RGB = linearRgb(0x4f7d48);

/**
 * Broadleaf species palettes: a per-tree multiplier over the leaf channels
 * so groves read as mixed populations (fresh green, dark olive, autumn
 * yellow, pale spring) instead of one green with jitter.
 */
const BROADLEAF_PALETTES: readonly (readonly [number, number, number])[] = [
  [1.0, 1.0, 1.0],
  [0.72, 0.91, 1.12],
  [1.48, 0.86, 0.57],
  [1.12, 1.03, 0.72],
];
/** Conifer palettes: spruce-dark, standard, and a blue-tinged fir. */
const CONIFER_PALETTES: readonly (readonly [number, number, number])[] = [
  [1.0, 1.0, 1.0],
  [0.82, 0.88, 0.96],
  [0.92, 0.98, 1.22],
];

/**
 * Deterministic per-plant unit random. Derived from the placement's quantized
 * world position, so every client renders the identical plant and a rebuilt
 * cell reproduces its previous look exactly. Worldgen spaces plants meters
 * apart; 1/16m quantization can never collide two of them.
 */
function plantRand(placement: VegetationPlacement, salt: number): number {
  return unit(hash3i(
    0x9e3d + placement.kind,
    Math.round(placement.x * 16),
    Math.round(placement.z * 16),
    salt,
  ));
}

export interface VegetationRendererOptions {
  cellSize?: number;
  radiusCells?: number;
  maxInstances?: number;
  /** Camera distance (m) beyond which plants use the far-LOD pools. */
  nearDistance?: number;
  /** Detailed-instance ceiling; overflow spills into the far pools. */
  nearBudget?: number;
}

export interface VegetationRenderStats {
  count: number;
  broadleaf: number;
  conifer: number;
  cactus: number;
}

export interface VegetationRenderBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

type VegetationSource = Pick<World, 'collectVegetation'>;

/**
 * Camera-local, low-poly vegetation built from fixed-capacity instance pools.
 *
 * A placement's stem is rendered from exactly `y` to `y + height`, at exactly
 * `radius`, matching the authoritative collider - in the far ring too, since
 * weapons out-range the near ring. Crowns, needles, and cactus branches are
 * deliberately cosmetic silhouettes around that clear stem.
 *
 * Every cosmetic attribute - crown squash and tilt, satellite lobes, bark
 * branches, conifer tier stack, cactus arm count/placement, species palette,
 * and per-instance color - is a pure function of the placement position, so
 * the population reads as varied individuals without any replicated or
 * per-frame random state.
 *
 * Plants beyond `nearDistance` (or past the `nearBudget` detailed ceiling;
 * placements arrive distance-sorted, so the budget always trims the farthest)
 * are emitted into three cheap far pools instead: a solid stem plus open
 * clustered membranes or whorls, tinted to match their detailed hues.
 * An optional installed-terrain gate delays only unprotected far placements;
 * their canonical positions and pool detail rules are unchanged on arrival.
 */
export class VegetationRenderer {
  readonly group = new THREE.Group();
  readonly cellSize: number;
  readonly radiusCells: number;
  readonly maxInstances: number;
  readonly nearDistance: number;
  readonly nearBudget: number;
  readonly stats: VegetationRenderStats = {
    count: 0,
    broadleaf: 0,
    conifer: 0,
    cactus: 0,
  };

  private readonly world: VegetationSource;
  private readonly stemGeometry = stemGeometry();
  private readonly broadleafGeometry = broadleafGeometry();
  private readonly branchGeometry = branchGeometry();
  private readonly coniferGeometry = coniferGeometry();
  private readonly farStemGeometry =
    new THREE.CylinderGeometry(1, 1, 1, 3, 1, true);
  private readonly farLeafGeometry = nativeFoliageGeometry(false, true);
  private readonly farConiferGeometry = nativeFoliageGeometry(true, true);

  private readonly woodMaterial = new THREE.MeshStandardMaterial({
    color: 0x817460, roughness: .93, envMapIntensity: .25,
  });
  private readonly broadleafMaterial = new THREE.MeshStandardMaterial({
    color: 0x719e90, roughness: .64, envMapIntensity: .25,
  });
  private readonly coniferMaterial = new THREE.MeshStandardMaterial({
    color: 0x6797ab, roughness: .68, envMapIntensity: .25,
  });
  private readonly cactusMaterial = new THREE.MeshStandardMaterial({
    color: 0x4f7d48, roughness: .83, envMapIntensity: .25,
  });
  /** Far pools carry their full color per instance. */
  private readonly farMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff, vertexColors: true, roughness: .75, envMapIntensity: .25, side: THREE.DoubleSide,
  });

  private readonly woodyStems: THREE.InstancedMesh;
  private readonly broadleafCanopies: THREE.InstancedMesh;
  private readonly broadleafLobes: THREE.InstancedMesh;
  private readonly broadleafBranches: THREE.InstancedMesh;
  private readonly coniferCanopies: THREE.InstancedMesh;
  private readonly coniferTiers: THREE.InstancedMesh;
  private readonly cactusStems: THREE.InstancedMesh;
  private readonly cactusArms: THREE.InstancedMesh;
  private readonly cactusTips: THREE.InstancedMesh;
  private readonly farStems: THREE.InstancedMesh;
  private readonly farBroadleaf: THREE.InstancedMesh;
  private readonly farConifers: THREE.InstancedMesh;
  private readonly meshes: THREE.InstancedMesh[];

  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly scale = new THREE.Vector3();
  private readonly euler = new THREE.Euler();
  private readonly yawRotation = new THREE.Quaternion();
  private readonly partRotation = new THREE.Quaternion();
  private readonly color = new THREE.Color();
  private readonly branchDirection = new THREE.Vector3();
  private readonly windClock = { value: 0 };
  private readonly foliageDepth = foliageDepthMaterial(this.windClock);

  private activeCellX: number | null = null;
  private activeCellZ: number | null = null;
  private activeBounds: VegetationRenderBounds | null = null;
  private visibleCellX: number | null = null;
  private visibleCellZ: number | null = null;
  private terrainRevision = -1;
  private candidates: VegetationPlacement[] = [];
  private visible: VegetationPlacement[] = [];
  private disposed = false;

  constructor(
    world: VegetationSource,
    options: VegetationRendererOptions = {},
    private readonly scenery?: ScenerySource,
    private readonly terrain?: SceneryTerrain,
  ) {
    this.world = world;
    this.farStemGeometry.setAttribute('color', new THREE.Float32BufferAttribute(
      new Float32Array(this.farStemGeometry.getAttribute('position').count * 3).fill(1), 3));
    detailPlantMaterial(this.woodMaterial, 'bark', this.windClock);
    detailPlantMaterial(this.broadleafMaterial, 'leaves', this.windClock);
    detailPlantMaterial(this.coniferMaterial, 'needles', this.windClock);
    detailPlantMaterial(this.cactusMaterial, 'cactus', this.windClock);
    for (const material of [this.woodMaterial, this.broadleafMaterial, this.coniferMaterial,
      this.cactusMaterial, this.farMaterial]) applyCitySceneryTint(material, 'plant');
    this.cellSize = boundedInteger(
      options.cellSize,
      VEGETATION_RENDER_CELL_SIZE,
      1,
      MAX_CELL_SIZE,
    );
    this.radiusCells = boundedInteger(
      options.radiusCells,
      VEGETATION_RENDER_RADIUS_CELLS,
      0,
      MAX_RADIUS_CELLS,
    );
    this.maxInstances = boundedInteger(
      options.maxInstances,
      MAX_VEGETATION_VISUALS,
      1,
      MAX_VEGETATION_VISUALS,
    );
    this.nearDistance = boundedInteger(
      options.nearDistance,
      VEGETATION_NEAR_DISTANCE,
      0,
      1 << 16,
    );
    this.nearBudget = Math.min(
      this.maxInstances,
      boundedInteger(
        options.nearBudget,
        VEGETATION_NEAR_BUDGET,
        0,
        VEGETATION_NEAR_BUDGET,
      ),
    );

    const near = Math.max(1, this.nearBudget);
    this.woodyStems = this.pool(
      'vegetation-woody-stems',
      this.stemGeometry,
      this.woodMaterial,
      near,
    );
    this.broadleafCanopies = this.pool(
      'vegetation-broadleaf-canopies',
      this.broadleafGeometry,
      this.broadleafMaterial,
      near,
    );
    this.broadleafLobes = this.pool(
      'vegetation-broadleaf-lobes',
      this.broadleafGeometry,
      this.broadleafMaterial,
      near * MAX_BROADLEAF_LOBES,
    );
    this.broadleafBranches = this.pool(
      'vegetation-broadleaf-branches',
      this.branchGeometry,
      this.woodMaterial,
      near * MAX_BROADLEAF_BRANCHES,
    );
    this.coniferCanopies = this.pool(
      'vegetation-conifer-canopies',
      this.coniferGeometry,
      this.coniferMaterial,
      near,
    );
    this.coniferTiers = this.pool(
      'vegetation-conifer-tiers',
      this.coniferGeometry,
      this.coniferMaterial,
      near * MAX_CONIFER_TIERS,
    );
    this.cactusStems = this.pool(
      'vegetation-cactus-stems',
      this.stemGeometry,
      this.cactusMaterial,
      near,
    );
    this.cactusArms = this.pool(
      'vegetation-cactus-arms',
      this.stemGeometry,
      this.cactusMaterial,
      near * MAX_CACTUS_ARMS,
    );
    this.cactusTips = this.pool(
      'vegetation-cactus-tips',
      this.stemGeometry,
      this.cactusMaterial,
      near * MAX_CACTUS_ARMS,
    );
    this.farStems = this.pool(
      'vegetation-far-stems',
      this.farStemGeometry,
      this.farMaterial,
      this.maxInstances,
    );
    this.farBroadleaf = this.pool(
      'vegetation-far-broadleaf',
      this.farLeafGeometry,
      this.farMaterial,
      this.maxInstances,
    );
    this.farConifers = this.pool(
      'vegetation-far-conifers',
      this.farConiferGeometry,
      this.farMaterial,
      this.maxInstances,
    );
    this.meshes = [
      this.woodyStems,
      this.broadleafCanopies,
      this.broadleafLobes,
      this.broadleafBranches,
      this.coniferCanopies,
      this.coniferTiers,
      this.cactusStems,
      this.cactusArms,
      this.cactusTips,
      this.farStems,
      this.farBroadleaf,
      this.farConifers,
    ];
    this.group.name = 'vegetation';
    this.group.add(...this.meshes);
  }

  get count(): number {
    return this.stats.count;
  }

  get bounds(): Readonly<VegetationRenderBounds> | null {
    return this.activeBounds;
  }

  /** One uniform write; wind never rebuilds or uploads the instance pools. */
  animate(elapsedSeconds: number): void {
    if (!this.disposed && Number.isFinite(elapsedSeconds)) {
      this.windClock.value = elapsedSeconds;
    }
  }

  /**
   * Rebuild on a spatial-cell transition. Returns true only when the active
   * instance set changed, allowing callers and tests to avoid redundant work.
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
    const sameCell = cellX === this.activeCellX && cellZ === this.activeCellZ;
    const revision = this.terrain?.sceneryCoverageRevision ?? 0;
    const sameVisibility = cellX === this.visibleCellX && cellZ === this.visibleCellZ && revision === this.terrainRevision;
    if (sameCell && sameVisibility) return false;

    const bounds = {
      minX: (cellX - this.radiusCells) * this.cellSize,
      maxX: (cellX + this.radiusCells + 1) * this.cellSize,
      minZ: (cellZ - this.radiusCells) * this.cellSize,
      maxZ: (cellZ + this.radiusCells + 1) * this.cellSize,
    };
    let refreshed = false;
    if (!sameCell) {
      const placements = this.scenery && !this.scenery.failed ? this.scenery.read('vegetation', bounds) : this.world.collectVegetation(
        bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ);
      if (placements) {
        this.activeCellX = cellX;
        this.activeCellZ = cellZ;
        this.activeBounds = bounds;
        this.candidates = placements
          .filter((placement) => validPlacement(placement, bounds))
          .sort((a, b) => (
            distanceSq(a, cameraX, cameraZ) - distanceSq(b, cameraX, cameraZ) ||
            a.x - b.x || a.z - b.z || String(a.kind).localeCompare(String(b.kind))))
          .slice(0, this.maxInstances);
        refreshed = true;
      }
    }
    if (!refreshed && sameVisibility) return false;
    const visible = this.candidates.filter(placement => sceneryPlacementReady(this.terrain,
      placement.x, placement.z, Math.max(placement.radius, placement.canopyRadius),
      Math.max(placement.radius, placement.canopyRadius), cellX, cellZ, this.cellSize));
    this.terrainRevision = revision;
    this.visibleCellX = cellX; this.visibleCellZ = cellZ;
    if (!refreshed && visible.length === this.visible.length && visible.every((placement, i) => placement === this.visible[i])) return false;
    this.visible = visible;
    this.rebuild(visible, cameraX, cameraZ);
    return true;
  }

  /** Release all fixed GPU resources. Safe to call repeatedly. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.meshes) {
      mesh.count = 0;
      this.group.remove(mesh);
      mesh.dispose();
    }
    this.stemGeometry.dispose();
    this.broadleafGeometry.dispose();
    this.branchGeometry.dispose();
    this.coniferGeometry.dispose();
    this.farStemGeometry.dispose();
    this.farLeafGeometry.dispose();
    this.farConiferGeometry.dispose();
    this.woodMaterial.dispose();
    this.broadleafMaterial.map?.dispose();
    this.broadleafMaterial.dispose();
    this.coniferMaterial.map?.dispose();
    this.coniferMaterial.dispose();
    this.cactusMaterial.dispose();
    this.farMaterial.dispose();
    this.foliageDepth.dispose();
    this.activeBounds = null;
    this.candidates.length = 0; this.visible.length = 0;
    this.resetStats();
  }

  private pool(
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
  ): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.count = 0;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    // Allocate the color attribute eagerly so the shader is compiled for
    // instance tints once, not on the first rebuild that happens to set one.
    mesh.instanceColor = new THREE.InstancedBufferAttribute(
      new Float32Array(capacity * 3).fill(1),
      3,
    );
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    // Only detailed plants contribute to the bounded desktop sun map.
    // Mobile/low quality disable that map in SceneManager. Wind deforms
    // the depth pass with the same expression as the visible membranes.
    mesh.castShadow = !name.startsWith('vegetation-far-');
    mesh.receiveShadow = mesh.castShadow;
    if (material === this.broadleafMaterial || material === this.coniferMaterial)
      mesh.customDepthMaterial = this.foliageDepth;
    return mesh;
  }

  private rebuild(
    placements: readonly VegetationPlacement[],
    cameraX: number,
    cameraZ: number,
  ): void {
    const counts = {
      woody: 0,
      broadleaf: 0,
      lobes: 0,
      branches: 0,
      conifer: 0,
      tiers: 0,
      cactus: 0,
      arms: 0,
      farStems: 0,
      farBroadleaf: 0,
      farConifers: 0,
    };
    const stats = this.stats;
    this.resetStats();
    const nearDistSq = this.nearDistance * this.nearDistance;
    let nearUsed = 0;

    for (const placement of placements) {
      const near =
        nearUsed < this.nearBudget &&
        distanceSq(placement, cameraX, cameraZ) <= nearDistSq;
      if (near) nearUsed++;
      this.yawRotation.setFromAxisAngle(UP, placement.yaw);
      if (placement.kind === VEGETATION_KIND.BROADLEAF) {
        stats.broadleaf++;
        if (near) {
          this.stemMatrix(placement);
          this.woodyStems.setMatrixAt(counts.woody, this.matrix);
          this.barkTint(this.woodyStems, counts.woody, placement, false);
          counts.woody++;
          counts.broadleaf = this.broadleafCrown(placement, counts.broadleaf);
          counts.lobes = this.broadleafLobeSet(placement, counts.lobes);
          counts.branches = this.broadleafBranchSet(placement, counts.branches);
        } else {
          this.farPlant(placement, counts, false);
        }
      } else if (placement.kind === VEGETATION_KIND.CONIFER) {
        stats.conifer++;
        if (near) {
          this.stemMatrix(placement);
          this.woodyStems.setMatrixAt(counts.woody, this.matrix);
          this.barkTint(this.woodyStems, counts.woody, placement, false);
          counts.woody++;
          const emitted = this.coniferCrown(
            placement, counts.conifer, counts.tiers,
          );
          counts.conifer = emitted.conifer;
          counts.tiers = emitted.tiers;
        } else {
          this.farPlant(placement, counts, true);
        }
      } else {
        stats.cactus++;
        if (near) {
          this.stemMatrix(placement);
          this.cactusStems.setMatrixAt(counts.cactus, this.matrix);
          this.tint(
            this.cactusStems,
            counts.cactus,
            0.82 + plantRand(placement, 1) * 0.36,
            0.92 + plantRand(placement, 2) * 0.16,
            0.86 + plantRand(placement, 3) * 0.18,
          );
          counts.cactus++;
          counts.arms = this.cactusArmSet(placement, counts.arms);
        } else {
          this.stemMatrix(placement);
          this.farStems.setMatrixAt(counts.farStems, this.matrix);
          this.tint(
            this.farStems,
            counts.farStems,
            CACTUS_RGB[0] * (0.82 + plantRand(placement, 1) * 0.36),
            CACTUS_RGB[1] * (0.92 + plantRand(placement, 2) * 0.16),
            CACTUS_RGB[2] * (0.86 + plantRand(placement, 3) * 0.18),
          );
          counts.farStems++;
        }
      }
    }

    this.woodyStems.count = counts.woody;
    this.broadleafCanopies.count = counts.broadleaf;
    this.broadleafLobes.count = counts.lobes;
    this.broadleafBranches.count = counts.branches;
    this.coniferCanopies.count = counts.conifer;
    this.coniferTiers.count = counts.tiers;
    this.cactusStems.count = counts.cactus;
    this.cactusArms.count = counts.arms;
    this.cactusTips.count = counts.arms;
    this.farStems.count = counts.farStems;
    this.farBroadleaf.count = counts.farBroadleaf;
    this.farConifers.count = counts.farConifers;

    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (mesh.count > 0) {
        mesh.computeBoundingSphere();
        // Account for the maximum cosmetic shader sway at a frustum edge.
        if (mesh.boundingSphere) mesh.boundingSphere.radius += 1;
      }
    }

    stats.count = placements.length;
  }

  /** Far tree: collider-sized stem and a single open canopy/whorl mesh. */
  private farPlant(
    placement: VegetationPlacement,
    counts: { farStems: number; farBroadleaf: number; farConifers: number },
    conifer: boolean,
  ): void {
    this.stemMatrix(placement);
    this.farStems.setMatrixAt(counts.farStems, this.matrix);
    this.barkTint(this.farStems, counts.farStems, placement, true);
    counts.farStems++;

    if (conifer) {
      const palette = this.palette(placement, CONIFER_PALETTES, 61);
      const radius =
        placement.canopyRadius * (0.90 + plantRand(placement, 7) * 0.25);
      const apex = this.coniferApex(placement);
      const base =
        placement.y + placement.height * (0.24 + plantRand(placement, 13) * 0.14);
      this.compose(
        placement.x,
        (apex + base) * 0.5,
        placement.z,
        this.yawRotation,
        radius,
        apex - base,
        radius,
      );
      this.farConifers.setMatrixAt(counts.farConifers, this.matrix);
      this.tint(
        this.farConifers,
        counts.farConifers,
        CONIFER_RGB[0] * this.leafChannel(placement, 4, 0.84, 0.26) * palette[0],
        CONIFER_RGB[1] * this.leafChannel(placement, 5, 0.90, 0.20) * palette[1],
        CONIFER_RGB[2] * this.leafChannel(placement, 6, 0.90, 0.34) * palette[2],
      );
      counts.farConifers++;
    } else {
      const palette = this.palette(placement, BROADLEAF_PALETTES, 60);
      const form = this.broadleafForm(placement);
      const centerY = placement.y + placement.height * 0.94;
      const r = placement.canopyRadius * 1.32 * form.spread;
      this.compose(
        placement.x,
        centerY,
        placement.z,
        this.yawRotation,
        r,
        placement.canopyRadius * 1.40 * form.rise,
        r,
      );
      this.farBroadleaf.setMatrixAt(counts.farBroadleaf, this.matrix);
      this.tint(
        this.farBroadleaf,
        counts.farBroadleaf,
        BROADLEAF_RGB[0] * this.leafChannel(placement, 4, 0.74, 0.52) * palette[0],
        BROADLEAF_RGB[1] * this.leafChannel(placement, 5, 0.88, 0.22) * palette[1],
        BROADLEAF_RGB[2] * this.leafChannel(placement, 6, 0.76, 0.42) * palette[2],
      );
      counts.farBroadleaf++;
    }
  }

  private palette(
    placement: VegetationPlacement,
    palettes: readonly (readonly [number, number, number])[],
    salt: number,
  ): readonly [number, number, number] {
    if (placement.rainforest) return ([[.67, .93, .71], [.84, 1.06, .65], [.59, .81, .72]] as const)[Math.floor(plantRand(placement, 60) * 3)];
    return palettes[
      Math.min(
        palettes.length - 1,
        Math.floor(plantRand(placement, salt) * palettes.length),
      )
    ];
  }

  /** Broad, upright and spreading fanwood ecotypes share the same stems. */
  private broadleafForm(placement: VegetationPlacement): { spread: number; rise: number } {
    if (placement.rainforest) return { spread: 1.10 + plantRand(placement, 62) * .16, rise: .30 + plantRand(placement, 63) * .10 };
    const species = Math.min(3, Math.floor(plantRand(placement, 60) * 4));
    return [
      { spread: 1.15, rise: 0.90 },
      { spread: 0.73, rise: 1.25 },
      { spread: 1.23, rise: 0.68 },
      { spread: 0.84, rise: 1.12 },
    ][species];
  }

  /** A small leader crown leaves daylight between the two branching limbs. */
  private broadleafCrown(placement: VegetationPlacement, index: number): number {
    const palette = this.palette(placement, BROADLEAF_PALETTES, 60);
    const form = this.broadleafForm(placement);
    this.euler.set(
      (plantRand(placement, 11) - 0.5) * 0.34,
      plantRand(placement, 12) * TAU,
      (plantRand(placement, 13) - 0.5) * 0.34,
    );
    this.partRotation.setFromEuler(this.euler);
    this.compose(
      placement.x,
      placement.y + placement.height * 0.97,
      placement.z,
      this.partRotation,
      placement.canopyRadius * form.spread * (0.79 + plantRand(placement, 8) * 0.22),
      placement.canopyRadius * form.rise * 1.35,
      placement.canopyRadius * form.spread * (0.79 + plantRand(placement, 9) * 0.22),
    );
    this.broadleafCanopies.setMatrixAt(index, this.matrix);
    this.tint(this.broadleafCanopies, index,
      this.leafChannel(placement, 4, 0.74, 0.52) * palette[0],
      this.leafChannel(placement, 5, 0.88, 0.22) * palette[1],
      this.leafChannel(placement, 6, 0.76, 0.42) * palette[2]);
    return index + 1;
  }

  private broadleafLimb(placement: VegetationPlacement, k: number): {
    dx: number; dz: number; attachY: number; tipY: number;
  } {
    const form = this.broadleafForm(placement);
    const salt = 70 + k * 6;
    const azimuth = placement.yaw + k * 2.65 + plantRand(placement, salt) * 0.55;
    const distance = placement.canopyRadius * form.spread *
      (0.76 + plantRand(placement, salt + 1) * 0.25);
    return {
      dx: Math.cos(azimuth) * distance,
      dz: -Math.sin(azimuth) * distance,
      attachY: placement.y + placement.height * (0.39 + plantRand(placement, salt + 2) * 0.12),
      tipY: placement.y + placement.height * (0.80 + plantRand(placement, salt + 3) * 0.17),
    };
  }

  /** Leaf sprays grow around branch tips instead of orbiting a solid ball. */
  private broadleafLobeSet(placement: VegetationPlacement, index: number): number {
    const palette = this.palette(placement, BROADLEAF_PALETTES, 60);
    const form = this.broadleafForm(placement);
    for (let k = 0; k < MAX_BROADLEAF_LOBES; k++) {
      const salt = 15 + k * 8;
      const limb = this.broadleafLimb(placement, k % 2);
      const reach = k < 2 ? 1 : 0.64;
      const size = placement.canopyRadius * (0.59 + plantRand(placement, salt + 2) * 0.22);
      this.euler.set(
        (plantRand(placement, salt + 4) - 0.5) * 0.6,
        plantRand(placement, salt + 5) * TAU,
        (plantRand(placement, salt + 6) - 0.5) * 0.6,
      );
      this.partRotation.setFromEuler(this.euler);
      this.compose(
        placement.x + limb.dx * reach,
        limb.tipY - (k < 2 ? 0 : placement.canopyRadius * 0.25),
        placement.z + limb.dz * reach,
        this.partRotation,
        size * form.spread,
        size * form.rise * (1.05 + plantRand(placement, salt + 7) * 0.4),
        size * form.spread,
      );
      this.broadleafLobes.setMatrixAt(index, this.matrix);
      const shade = 0.88 + plantRand(placement, salt + 7) * 0.18;
      this.tint(this.broadleafLobes, index,
        this.leafChannel(placement, 4, 0.74, 0.52) * palette[0] * shade,
        this.leafChannel(placement, 5, 0.88, 0.22) * palette[1] * shade,
        this.leafChannel(placement, 6, 0.76, 0.42) * palette[2] * shade);
      index++;
    }
    return index;
  }

  /** Two forked limbs share the same attachment points as the leaf sprays. */
  private broadleafBranchSet(placement: VegetationPlacement, index: number): number {
    for (let k = 0; k < (placement.rainforest ? MAX_BROADLEAF_BRANCHES : 2); k++) {
      if (k >= 2) {
        const angle = placement.yaw + (k - 2) * Math.PI / 3;
        const root = k < 6, reach = root ? placement.radius * 2.5 : placement.canopyRadius * .72;
        const dx = Math.cos(angle) * reach, dz = Math.sin(angle) * reach;
        const length = root ? placement.height * .14 : placement.height * .37;
        const base = root ? placement.y : placement.y + placement.height * .44;
        this.branchDirection.set(root ? -dx : .3, length, root ? -dz : .5);
        const span = this.branchDirection.length();
        this.partRotation.setFromUnitVectors(UP, this.branchDirection.normalize());
        const radius = root ? placement.radius * .43 : .13;
        this.compose(placement.x + dx * (root ? .5 : 1), base + length * .5,
          placement.z + dz * (root ? .5 : 1), this.partRotation, radius, span, radius);
        this.broadleafBranches.setMatrixAt(index, this.matrix);
        this.barkTint(this.broadleafBranches, index++, placement, false);
        continue;
      }
      const limb = this.broadleafLimb(placement, k);
      const dy = limb.tipY - limb.attachY;
      this.branchDirection.set(limb.dx, dy, limb.dz);
      const length = this.branchDirection.length();
      this.partRotation.setFromUnitVectors(UP, this.branchDirection.normalize());
      const radius = placement.radius * (0.53 + plantRand(placement, 74 + k * 6) * 0.14);
      this.compose(
        placement.x + limb.dx * 0.5,
        (limb.attachY + limb.tipY) * 0.5,
        placement.z + limb.dz * 0.5,
        this.partRotation,
        radius, length, radius,
      );
      this.broadleafBranches.setMatrixAt(index, this.matrix);
      this.barkTint(this.broadleafBranches, index, placement, false);
      index++;
    }
    return index;
  }

  /**
   * Two to four open whorls of needle boughs. Spread, per-tier jitter, and
   * palette make pines read as spires, firs, or squat storm-bent trees
   * with daylight between the branches.
   */
  private coniferCrown(
    placement: VegetationPlacement,
    coniferIndex: number,
    tierIndex: number,
  ): { conifer: number; tiers: number } {
    const palette = this.palette(placement, CONIFER_PALETTES, 61);
    const baseRadius =
      placement.canopyRadius * (0.90 + plantRand(placement, 7) * 0.25);
    const apex = this.coniferApex(placement);
    const base =
      placement.y + placement.height * (0.24 + plantRand(placement, 13) * 0.14);
    const span = apex - base;
    const tiers = 3 + (plantRand(placement, 8) < 0.62 ? 1 : 0);
    const coneHeight = span * (0.52 + plantRand(placement, 22) * 0.12);
    const step = (span - coneHeight * 0.70) / (tiers - 1);
    const needleR = this.leafChannel(placement, 4, 0.84, 0.26) * palette[0];
    const needleG = this.leafChannel(placement, 5, 0.90, 0.20) * palette[1];
    const needleB = this.leafChannel(placement, 6, 0.90, 0.34) * palette[2];

    for (let k = 0; k < tiers; k++) {
      const salt = 15 + k * 8;
      const radius = baseRadius *
        (1 - (0.55 * k) / (tiers - 1)) *
        (0.92 + plantRand(placement, salt) * 0.16);
      const bottom = base + step * k;
      const tierHeight = coneHeight * (1 - 0.30 * k / (tiers - 1));
      const jitter = baseRadius * 0.22;
      this.euler.set(
        (plantRand(placement, salt + 3) - 0.5) * 0.17,
        placement.yaw + k * 2.399963,
        (plantRand(placement, salt + 4) - 0.5) * 0.17,
      );
      this.partRotation.setFromEuler(this.euler);
      this.compose(
        placement.x + (plantRand(placement, salt + 1) - 0.5) * jitter,
        bottom + tierHeight * 0.5,
        placement.z + (plantRand(placement, salt + 2) - 0.5) * jitter,
        this.partRotation,
        radius,
        tierHeight,
        radius,
      );
      const shade = 1 - k * 0.045;
      if (k === 0) {
        this.coniferCanopies.setMatrixAt(coniferIndex, this.matrix);
        this.tint(this.coniferCanopies, coniferIndex,
          needleR, needleG, needleB);
        coniferIndex++;
      } else {
        this.coniferTiers.setMatrixAt(tierIndex, this.matrix);
        this.tint(this.coniferTiers, tierIndex,
          needleR * shade, needleG * shade, needleB);
        tierIndex++;
      }
    }
    return { conifer: coniferIndex, tiers: tierIndex };
  }

  private coniferApex(placement: VegetationPlacement): number {
    // The collider trunk retains its full height/radius; give the cosmetic
    // leader enough headroom that the pole cannot poke through its needles.
    return placement.y + placement.height + Math.max(
      placement.radius * 5,
      placement.canopyRadius * (0.88 + plantRand(placement, 12) * 0.10),
    );
  }

  /**
   * Zero to three arms at hash-chosen heights and azimuths. The old fixed
   * left/right pair at fixed heights made every cactus an identical glyph.
   */
  private cactusArmSet(
    placement: VegetationPlacement,
    index: number,
  ): number {
    const roll = plantRand(placement, 20);
    const count =
      roll < 0.22 ? 0 :
      roll < 0.56 ? 1 :
      roll < 0.84 ? 2 :
      MAX_CACTUS_ARMS;
    for (let k = 0; k < count; k++) {
      const salt = 30 + k * 8;
      const azimuth = plantRand(placement, salt) * TAU;
      const attachY =
        placement.y + placement.height * (0.30 + plantRand(placement, salt + 1) * 0.40);
      const armRadius =
        placement.radius * (0.40 + plantRand(placement, salt + 2) * 0.18);
      const armLength = Math.max(
        placement.radius * 1.4,
        placement.canopyRadius * (0.38 + plantRand(placement, salt + 3) * 0.42),
      );
      const tipHeight = Math.max(
        placement.radius * 1.3,
        placement.height * (0.10 + plantRand(placement, salt + 4) * 0.18),
      );
      const dirX = Math.cos(azimuth);
      const dirZ = -Math.sin(azimuth);
      const shade = 0.90 + plantRand(placement, salt + 5) * 0.16;
      const r = (0.82 + plantRand(placement, 1) * 0.36) * shade;
      const g = (0.92 + plantRand(placement, 2) * 0.16) * shade;
      const b = (0.86 + plantRand(placement, 3) * 0.18) * shade;

      this.partRotation.setFromAxisAngle(UP, azimuth).multiply(ARM_ROTATION);
      const armOffset = placement.radius + armLength * 0.5;
      this.compose(
        placement.x + dirX * armOffset,
        attachY,
        placement.z + dirZ * armOffset,
        this.partRotation,
        armRadius,
        armLength,
        armRadius,
      );
      this.cactusArms.setMatrixAt(index, this.matrix);
      this.tint(this.cactusArms, index, r, g, b);

      const tipOffset = placement.radius + armLength;
      this.partRotation.setFromAxisAngle(UP, azimuth);
      this.compose(
        placement.x + dirX * tipOffset,
        attachY + tipHeight * 0.5,
        placement.z + dirZ * tipOffset,
        this.partRotation,
        armRadius,
        tipHeight,
        armRadius,
      );
      this.cactusTips.setMatrixAt(index, this.matrix);
      this.tint(this.cactusTips, index, r, g, b);
      index++;
    }
    return index;
  }

  /** Foliage tint channel: same salts per plant keep its parts related. */
  private leafChannel(
    placement: VegetationPlacement,
    salt: number,
    base: number,
    span: number,
  ): number {
    return base + plantRand(placement, salt) * span;
  }

  /**
   * Bark tint. Detailed pools multiply the wood material's color; far pools
   * use a white material, so the same channels are premultiplied by the
   * wood base for an identical final hue.
   */
  private barkTint(
    mesh: THREE.InstancedMesh,
    index: number,
    placement: VegetationPlacement,
    absolute: boolean,
  ): void {
    const light = 0.84 + plantRand(placement, 1) * 0.30;
    const r = light * (0.94 + plantRand(placement, 2) * 0.12);
    const g = light;
    const b = light * (0.90 + plantRand(placement, 3) * 0.12);
    if (absolute) {
      this.tint(mesh, index, r * WOOD_RGB[0], g * WOOD_RGB[1], b * WOOD_RGB[2]);
    } else {
      this.tint(mesh, index, r, g, b);
    }
  }

  private tint(
    mesh: THREE.InstancedMesh,
    index: number,
    r: number,
    g: number,
    b: number,
  ): void {
    this.color.setRGB(r, g, b);
    mesh.setColorAt(index, this.color);
  }

  private stemMatrix(placement: VegetationPlacement): void {
    this.compose(
      placement.x,
      placement.y + placement.height * 0.5,
      placement.z,
      this.yawRotation,
      placement.radius,
      placement.height,
      placement.radius,
    );
  }

  private compose(
    x: number,
    y: number,
    z: number,
    rotation: THREE.Quaternion,
    sx: number,
    sy: number,
    sz: number,
  ): void {
    this.position.set(x, y, z);
    this.scale.set(sx, sy, sz);
    this.matrix.compose(this.position, rotation, this.scale);
  }

  private resetStats(): void {
    this.stats.count = 0;
    this.stats.broadleaf = 0;
    this.stats.conifer = 0;
    this.stats.cactus = 0;
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

function distanceSq(
  placement: VegetationPlacement,
  x: number,
  z: number,
): number {
  const dx = placement.x - x;
  const dz = placement.z - z;
  return dx * dx + dz * dz;
}

function validPlacement(
  placement: VegetationPlacement,
  bounds: VegetationRenderBounds,
): boolean {
  if (
    !Number.isFinite(placement.x) ||
    !Number.isFinite(placement.y) ||
    !Number.isFinite(placement.z) ||
    !Number.isFinite(placement.radius) ||
    !Number.isFinite(placement.height) ||
    !Number.isFinite(placement.canopyRadius) ||
    !Number.isFinite(placement.yaw) ||
    placement.x < bounds.minX ||
    placement.x >= bounds.maxX ||
    placement.z < bounds.minZ ||
    placement.z >= bounds.maxZ ||
    placement.radius <= 0 ||
    placement.radius > MAX_STEM_RADIUS ||
    placement.height <= 0 ||
    placement.height > MAX_STEM_HEIGHT ||
    placement.canopyRadius < 0 ||
    placement.canopyRadius > MAX_CANOPY_RADIUS ||
    placement.x <= -WORLD.BORDER ||
    placement.x >= WORLD.BORDER ||
    placement.z <= -WORLD.BORDER ||
    placement.z >= WORLD.BORDER
  ) {
    return false;
  }
  if (
    placement.kind !== VEGETATION_KIND.BROADLEAF &&
    placement.kind !== VEGETATION_KIND.CONIFER &&
    placement.kind !== VEGETATION_KIND.CACTUS
  ) {
    return false;
  }
  return (
    placement.kind === VEGETATION_KIND.CACTUS ||
    placement.canopyRadius > 0
  );
}
