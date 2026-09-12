import { OutpostField } from './outposts.js';
import { Noise } from './noise.js';
import { hash2i, hash3i, unit } from './rng.js';
import { smoothstep, lerp, clamp, TAU } from './math.js';
import { sdBox, sdCylinderY, smin } from './sdf.js';
import { solidBoxDistance } from './box-field.js';
import { PLAYER, WORLD } from './constants.js';
import { CAVE_CELL, caveBiomeColor, caveFloorAt, caveColumn, type CaveSite, type CaveColumn } from './caves.js';
import { STRUCTURE_KIND, buildStructureFamily, generateUndergroundStructure,
  type StructureKind, type StructureSite, type UndergroundStructure } from './structures.js';
export { STRUCTURE_KIND, type StructureKind, type StructureSite } from './structures.js';
import { sdBoulder } from './rock-shape.js';
import { Landscape, type MountainSite, type RoadSegment, type RoadSample } from './landscape.js';
import { buildCityBlock, cityLiftSites, capitalPlan, type CityDistrict, type CityLiftSite } from './cities.js';
import { capitalBoundary, capitalSegments, capitalDistance, CAPITAL_SKY_HEIGHT, type CapitalSegment } from './capital-geometry.js';
import { rainforestAt } from './rainforest.js';
import { gradeLiquidTerrain, liquidAtSurfaceColumn, islandCoastDistance, ISLAND_SHORE_START, canReachCoast, type LiquidSample } from './liquids.js';
import { buildTransportPlan, transportGroundAt, type TransportPlan } from './transport.js';
import { TransportBridgeIndex } from './transport-geometry.js';
import { transitDistance } from './transit-motion.js';
import { createJungleTempleSites, buildJungleTemplePlan, jungleTempleColumn, jungleTempleField, jungleTempleGrade,
  type JungleTempleSite, type TempleColumn } from './jungle-temples.js';
export { CITY_RADIUS, type CityDistrict } from './cities.js';
export type { MountainSite, RoadSegment, RoadSample } from './landscape.js';
export { CAVE_BIOME, caveBiomeAt, cavePathPoint, sampleCaveFloorLayers, type CaveFloorSpot, type CaveBiome, type CaveSite, type CaveColumn } from './caves.js';

// The entire authoritative world - terrain, biomes, caves, boulders,
// structures, vegetation stems, and border - is derived deterministically
// from a seed. Its signed field f(x,y,z) is canonical (air > 0, solid < 0);
// after CSG operations its magnitude is only a marching/broad-phase hint,
// not an exact metric distance.
//
// Why this matters:
//  * Physics collides against the FIELD (volumetric), never against meshes.
//    There is no "missed raycast" failure mode, so players cannot fall
//    through the world. Rendering is a separate, purely cosmetic meshing pass.
//  * Server and client evaluate the identical function (integer-hash noise,
//    no transcendentals), so predicted movement matches authoritative
//    movement bit-for-bit as far as the world is concerned.
//  * No terrain data is ever stored or transmitted - any server process can
//    simulate any region of the world from just the seed (see ARCHITECTURE).

export const MAT = {
  GRASS: 0,
  DIRT: 1,
  ROCK: 2,
  SAND: 3,
  SNOW: 4,
  CONCRETE: 5,
  CAVE: 6,
  BASALT: 7,
  LAVA: 8,
  ROAD: 9,
} as const;
export type MatId = (typeof MAT)[keyof typeof MAT];

export interface ColumnData {
  templeSite?: JungleTempleSite;
  temple?: TempleColumn;
  rainforest?: number;
  transport?: boolean;
  h: number;      // terrain height
  temp: number;   // 0..1
  moist: number;  // 0..1
  desert: number; // 0..1
  entr: number;   // cave-entrance mask 0..1
  /** Legacy density scale for consumers; explicit cave coordinates are below. */
  entrRaw: number;
  /** Volcanic highland province mask 0..1 (rare; tall basalt + lava). */
  volc: number;
  /** Flat lava-pool surface elevation, or -1000 when this column has none. */
  lavaY: number;
  /** Continuous basin envelope retained when roads reshape volcanic ground. */
  lavaBasin?: { level: number; channel: number };
  /** Explicit gallery/chamber footprint, including a 10m meshing apron. */
  cave?: CaveColumn;
  /** Overlapping approaches share a chamber but retain their own arch field. */
  caveBranches?: CaveColumn[];
  /** Graded road/trail lane; shared by material selection and prop exclusion. */
  road?: RoadSample;
  /** Paved city core; its surrounding blend remains ordinary terrain. */
  city?: CityDistrict;
  /** Signed horizontal field of a rare bedrock buttress in deep chambers. */
  deepRock?: number;
}

export interface Box { x: number; y: number; z: number; hx: number; hy: number; hz: number; facade?: number; floorY?: number; capital?: boolean }
export interface RBox extends Box { r: number }
export interface StructureFoundation extends Box { underground?: boolean }

export const VEGETATION_KIND = {
  BROADLEAF: 0,
  CONIFER: 1,
  CACTUS: 2,
} as const;
export type VegetationKind =
  (typeof VEGETATION_KIND)[keyof typeof VEGETATION_KIND];

/**
 * One deterministic plant transform. The stem is authoritative cover; its
 * canopy is cosmetic so foliage never traps players or blocks invisible
 * projectiles.
 */
export interface VegetationPlacement {
  rainforest?: boolean;
  x: number;
  /** Terrain support height / bottom of the stem. */
  y: number;
  z: number;
  radius: number;
  height: number;
  canopyRadius: number;
  kind: VegetationKind;
  yaw: number;
}

interface StructData {
  site: StructureSite;
  pad: Box;
  solids: Box[];
  cuts: Box[];
}

export interface StructureRegion {
  transportBridges?: TransportBridgeIndex;
  capitalArea?: boolean;
  capitalSegments?: CapitalSegment[];
  sites: StructureSite[];
  pads: Box[];
  solids: Box[];
  cuts: Box[];
  /** Exact plinths own terrain rendering within their XZ footprint. */
  foundations?: StructureFoundation[];
}

export interface Region extends StructureRegion {
  boulders: RBox[];
  vegetation: VegetationPlacement[];
}

export interface TraceHit {
  hit: boolean;
  dist: number;
  x: number; y: number; z: number;
  nx: number; ny: number; nz: number;
}

const STRUCT_CELL = 256;
/** Includes the largest compound/pyramid plus terrain smoothing. */
const STRUCT_MARGIN = 58;
const BOULDER_CELL = 36;
const BOULDER_MARGIN = 5;
export const VEGETATION_CELL = 64;
const VEGETATION_MARGIN = 4;
const STRUCT_CACHE_LIMIT = 16_384;
const PROP_CACHE_LIMIT = 65_536;
const REGION_CACHE_LIMIT = 16_384;
const PAD_SMOOTH = 0.6;
/** Roof thickness outside the explicit open arch; shared with the mesher. */
export const CAVE_MIN_ROOF = 4.8;
/** Compatibility masks for prop placement; cave footprint is authoritative. */
export const CAVE_ENTRANCE_THRESHOLD = 0.72;
export const CAVE_SHAFT_BREACH_ENTR = 0.18;
const CAVE_ENTRANCE_HEADROOM = 1;
const TRACE_MIN_STEP = 0.035;
/** Covers steep massif faces and overlapping graded road shoulders. */
const TRACE_FIELD_SCALE = 0.32;
const SPAWN_AXIS_SPAN = PLAYER.HEIGHT - PLAYER.RADIUS * 2;
const SPAWN_AXIS_OFFSETS = [
  PLAYER.RADIUS,
  PLAYER.RADIUS + SPAWN_AXIS_SPAN * 0.25,
  PLAYER.HEIGHT * 0.5,
  PLAYER.RADIUS + SPAWN_AXIS_SPAN * 0.75,
  PLAYER.HEIGHT - PLAYER.RADIUS,
] as const;
const SPAWN_INV_SQRT3 = 1 / Math.sqrt(3);
const SPAWN_PROBE_DIRS: readonly (readonly [number, number, number])[] = [
  [-1, 0, 0], [1, 0, 0],
  [0, -1, 0], [0, 1, 0],
  [0, 0, -1], [0, 0, 1],
  [-SPAWN_INV_SQRT3, -SPAWN_INV_SQRT3, -SPAWN_INV_SQRT3],
  [-SPAWN_INV_SQRT3, -SPAWN_INV_SQRT3, SPAWN_INV_SQRT3],
  [-SPAWN_INV_SQRT3, SPAWN_INV_SQRT3, -SPAWN_INV_SQRT3],
  [-SPAWN_INV_SQRT3, SPAWN_INV_SQRT3, SPAWN_INV_SQRT3],
  [SPAWN_INV_SQRT3, -SPAWN_INV_SQRT3, -SPAWN_INV_SQRT3],
  [SPAWN_INV_SQRT3, -SPAWN_INV_SQRT3, SPAWN_INV_SQRT3],
  [SPAWN_INV_SQRT3, SPAWN_INV_SQRT3, -SPAWN_INV_SQRT3],
  [SPAWN_INV_SQRT3, SPAWN_INV_SQRT3, SPAWN_INV_SQRT3],
];

/** Polynomial smooth maximum, dual of sdf.ts' smooth minimum. */
function smax(a: number, b: number, k: number): number {
  return -smin(-a, -b, k);
}

/** Collision-free cache key even if the playable world later grows. */
function cellKey(i: number, j: number): string {
  return `${i},${j}`;
}

/**
 * Immutable world cells need no invalidation. FIFO eviction keeps memory
 * bounded without the latency cliff caused by clearing an entire hot cache.
 */
function setBounded<K, V>(
  cache: Map<K, V>,
  key: K,
  value: V,
  limit: number,
): void {
  if (!cache.has(key) && cache.size >= limit) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
  cache.set(key, value);
}

export class World {
  readonly noise: Noise;
  private readonly landscape: Landscape;
  private structCache = new Map<string, StructData | null>();
  private undergroundStructCache = new Map<string, UndergroundStructure | null>();
  private boulderCache = new Map<string, RBox[] | null>();
  private vegetationCache = new Map<string, VegetationPlacement[] | null>();
  private regionCache = new Map<string, Region>();
  private structureRegionCache = new Map<string, StructureRegion>();
  private cityLifts: readonly CityLiftSite[] | null = null;
  private transportPlan?: TransportPlan;
  private transportCells = new Map<string, Box[]>();
  private transportBridgeIndex?: TransportBridgeIndex;
  /** Activated only by simulation; render workers keep the static field. */
  readonly outposts = new OutpostField();
  motionTime?: number;
  private flatCityColumns: readonly ColumnData[] | null = null;
  // Repeated vertical/contact probes share immutable terrain columns. Keep
  // exact coordinates (no quantization) and evict one oldest entry at a time.
  // Public column() still returns fresh data; moving solids are never cached.
  private readonly sdfColumnRows = new Map<number, Map<number, ColumnData>>();
  private readonly sdfColumnXs = new Float64Array(512);
  private readonly sdfColumnZs = new Float64Array(512);
  private sdfColumnCount = 0;
  private sdfColumnCursor = 0;
  private caveCache = new Map<string, CaveSite | null>();
  private jungleTemples: readonly JungleTempleSite[] | null = null;

  // 1-entry memo for regionAt(): collision queries cluster spatially, so the
  // previous region is almost always reusable.
  private lastRegion: Region | null = null;
  private lrSi0 = 1e9; private lrSi1 = 1e9;
  private lrSj0 = 1e9; private lrSj1 = 1e9;
  private lrBi0 = 1e9; private lrBi1 = 1e9;
  private lrBj0 = 1e9; private lrBj1 = 1e9;
  private lrVi0 = 1e9; private lrVi1 = 1e9;
  private lrVj0 = 1e9; private lrVj1 = 1e9;

  constructor(readonly seed: number) {
    this.noise = new Noise(seed | 0);
    this.landscape = new Landscape(seed, (x, z) => this.naturalColumn(x, z).h, (x, z) => this.rawColumn(x, z));
  }

  // ---- Column (2D) data --------------------------------------------------

  private rawColumn(x: number, z: number): ColumnData {
    // NOTE ON TUNING: fbm2 is normalized to [-1,1] but its TYPICAL range is
    // about +-0.4; every threshold below is calibrated to that, not to the
    // theoretical bounds.
    const n = this.noise;
    const wx = x + 60 * n.fbm2(x * 0.0009 + 137.0, z * 0.0009 - 91.0, 2);
    const wz = z + 60 * n.fbm2(x * 0.0009 - 52.0, z * 0.0009 + 71.0, 2);

    const cont = n.fbm2(wx * 0.00022, wz * 0.00022, 3);
    const hills = n.fbm2(wx * 0.0035, wz * 0.0035, 4);
    // Broad mountain provinces still create distinct lowland and alpine
    // regions, but no province is perfectly flat: a faster regional mask
    // varies the rolling-hill amplitude inside an ordinary play area, while a
    // small baseline ridge contribution gives even lowlands readable relief.
    const mountain = smoothstep(
      -0.45, 0.30,
      n.fbm2(x * 0.00045 + 913.0, z * 0.00045 + 400.0, 2),
    );
    const rugged = smoothstep(
      -0.45, 0.35,
      n.fbm2(wx * 0.0014 - 221.0, wz * 0.0014 + 663.0, 3),
    );
    const ridge = n.ridge2(wx * 0.0011, wz * 0.0011, 4);

    const temp = clamp(0.5 + 1.15 * n.fbm2(x * 0.00028 + 700.0, z * 0.00028 - 300.0, 2), 0, 1);
    const moist = clamp(0.5 + 1.15 * n.fbm2(x * 0.0003 - 330.0, z * 0.0003 + 800.0, 2), 0, 1);
    const desert = smoothstep(0.62, 0.74, temp) * smoothstep(0.46, 0.34, moist);
    // Volcanic highlands: a rare province (~2-3% of the map in ~1km zones)
    // of towering black massifs and lava channels. Unwarped, own salts.
    // The wide ramp keeps the mask's own slope contribution gentle.
    const volc = smoothstep(
      0.42, 0.74,
      n.fbm2(x * 0.00035 + 1777.0, z * 0.00035 - 909.0, 2),
    );

    // Damping the mid-frequency relief inside volcanic provinces buys back
    // slope budget for the volcanic uplift itself.
    const hillAmp = lerp(14, 27, rugged) * (1 - desert * 0.28) * (1 - volc * 0.6);
    // Real mountains: a long-wavelength massif carries the bulk (the short
    // ridge field stays modest - its 285m wavelength cannot hold 150m+ of
    // amplitude without breaking the slope budget), and its profile passes
    // through a soft staircase in mountain provinces. That concentrates
    // slope into terrace risers - steep cliff faces you fall off - between
    // walkable benches. The separate angular massifs and road shoulders
    // are added afterward; TRACE_FIELD_SCALE covers their steeper faces.
    const ridgeAmp = (26 + mountain * 44) * (1 - volc * 0.55);
    const massif = n.ridge2(wx * 0.0004 + 47.0, wz * 0.0004 - 12.0, 3);
    let mass = massif * massif;
    const tiers = mass * 4.0;
    const tier = Math.floor(tiers);
    const stepped = (tier + smoothstep(0.25, 0.75, tiers - tier)) / 4.0;
    // Volcanic provinces lean harder on the terrace staircase: slope
    // concentrates into cliff risers between walkable benches.
    mass = lerp(mass, stepped, Math.min(0.85, 0.45 * mountain + 0.5 * volc));
    // Where an ordinary massif overlaps the volcanic province, damp it:
    // the two uplifts stacking at full strength busts the slope budget.
    const massifAmp = mountain * 190 * (1 - volc * 0.3);
    let h = 12 + cont * 52 + hills * hillAmp +
      ridge * ridge * ridgeAmp + mass * massifAmp;
    // The volcanic uplift carries its OWN ridge system - reusing the massif
    // field left provinces flat wherever that field happened to be quiet.
    // Hard 0.75-weight terracing turns most of the amplitude into cliff
    // bands: ~30m sheer risers between walkable benches.
    let volcChannel = 0;
    if (volc > 0.001) {
      const vraw = n.ridge2(wx * 0.00085 + 313.0, wz * 0.00085 - 989.0, 3);
      let vmass = vraw * vraw;
      const vtiers = vmass * 5.0;
      const vtier = Math.floor(vtiers);
      const vstep = (vtier + smoothstep(0.1, 0.9, vtiers - vtier)) / 5.0;
      vmass = lerp(vmass, vstep, 0.5);
      // Lava basins suppress the uplift under them. Deliberately plain
      // fbm with a WIDE transition: ridge2's fold creases produced 10m-wide
      // ravines whose walls busted the slope envelope; fbm gives smooth
      // lake basins with gentle shores instead.
      // ~330m wavelength: several basin candidates per ~1km province, so
      // no zone can miss out on lava by noise phase luck (0.0016 gave one
      // blob per zone at best, and the main 1337 zone lost that lottery).
      volcChannel = smoothstep(
        0.04, 0.46,
        n.fbm2(x * 0.0024 + 2113.0, z * 0.0024 - 577.0, 2),
      ) * smoothstep(0.36, 0.54, volc);
      // Basins suppress the uplift almost entirely: floors sink to near
      // the base level no matter how tall the local ridges are, so every
      // zone's basins reach the (flat, base-anchored) lava pool level.
      h += volc * (24 + 138 * vmass) * (1 - volcChannel * 0.78);
    }
    if (desert > 0.01) {
      const cn = n.ridge2(x * 0.0021 + 5.0, z * 0.0021 - 8.0, 3);
      h -= desert * smoothstep(0.45, 0.8, cn) * 26;
    }
    // Medium-scale surface detail keeps even lowland provinces readable
    // instead of pancake-flat; the amplitude stays inside the conservative
    // field-march slope envelope (seed 424242 sits closest to its limits).
    h += n.fbm2(wx * 0.011 + 431.0, wz * 0.011 - 87.0, 2) *
      (2.4 + 2.8 * rugged) * (1 - desert * 0.5);
    // Lava channels: winding gorges carved through volcanic provinces and
    // flooded up to a smooth low-frequency pool surface. Channels crossing
    // high ground stay dry gorges; the lava glows in the low runs. Adding
    // the fill via smax is strictly MORE solid, so no cave-seal guarantee
    // can weaken and the pool floor is ordinary walkable (deadly) terrain.
    let lavaY = -1000;
    let poolCore = false;
    let poolLevel = 0;
    if (volcChannel > 0.02) {
      h -= volcChannel * 18;
      // The pool surface rides the smooth plateau base (continent +
      // volcanic lift), so each lake reads flat. The fill fades out where
      // the carved floor sits far below the pool level - lava collects in
      // valleys instead of forming 40m glowing walls on mountainsides.
      // Anchored just above the deep-damped basin floor (~base + uplift
      // *0.15 - carve), so basins flood in EVERY zone regardless of how
      // tall the local ridges are.
      const poolY = 12 + cont * 52 + volc * 20;
      if (volcChannel > 0.28 && h < poolY + 2) {
        const reach = smoothstep(34, 9, poolY - h);
        const fill = smax(h, poolY, 3.0);
        // Blend saturates exactly where the core tag begins, so every
        // tagged column genuinely sits AT the pool surface.
        h = lerp(h, fill, smoothstep(0.28, 0.45, volcChannel) * reach);
        if (volcChannel > 0.45) { poolCore = true; poolLevel = poolY; }
      }
    }
    // Only the surface of a filled pool receives the lava material tag.
    if (poolCore && Math.abs(h - poolLevel) < 1.2) lavaY = poolLevel;
    // Soft-clamp into the world's vertical guarantees (sky empty above
    // MAX_HEIGHT, caves bottoming out above MIN_CAVE_Y). The high clamp is
    // asymptotic (cap 252, 28m under MAX_HEIGHT): volcanic peaks stack on
    // ordinary massifs, and a linear knee would overflow the sky guarantee.
    if (h > 200) {
      const t = (h - 200) / 52;
      h = 200 + 52 * (t / (1 + t));
    }
    if (h < -26) h = -26 + (h + 26) * 0.25;

    return { h, temp, moist, desert, entr: 0, entrRaw: 0, volc, lavaY,
      lavaBasin: volcChannel > 0.02 ? { level: 12 + cont * 52 + volc * 20, channel: volcChannel } : undefined };
  }

  collectJungleTemples(): readonly JungleTempleSite[] {
    return this.jungleTemples ??= createJungleTempleSites(this.seed, (x,z) => this.naturalColumn(x,z));
  }

  private jungleTempleAt(x: number, z: number, margin = 0): JungleTempleSite | undefined {
    return this.collectJungleTemples().find(site => Math.abs(x-site.x)<=site.radius+margin && Math.abs(z-site.z)<=site.radius+margin);
  }

  private naturalColumn(x: number, z: number): ColumnData {
    const col = this.rawColumn(x, z);
    // Volcanic provinces already supply their own massifs and flooded
    // basins. Fade the new ridge system out before those basins begin,
    // keeping their liquid surface level instead of lifting glowing hills.
    col.h += this.landscape.uplift(x, z) * (1 - smoothstep(0.08, 0.35, col.volc));
    if (col.h > 190) {
      if (this.landscape.mountain(Math.floor(x / 1024), Math.floor(z / 1024)).dramatic) col.h = Math.min(274, col.h);
      else {
        const excess = col.h - 190;
        col.h = 190 + 62 * excess / (62 + excess);
      }
    }
    return col;
  }

  private baseColumn(x: number, z: number): ColumnData {
    const col = this.naturalColumn(x, z);
    col.rainforest = rainforestAt(this.seed, x, z) * (1 - smoothstep(.08, .3, col.volc));
    if (col.rainforest > 0) {
      col.temp = lerp(col.temp, .84, col.rainforest);
      col.moist = lerp(col.moist, .97, col.rainforest);
      col.desert *= 1 - col.rainforest;
    }
    const city = this.landscape.cityAt(x, z, 192);
    if (city) {
      if (capitalBoundary(city, x, z) <= 0) { col.city = city; col.volc = 0; col.lavaY = -1000; col.lavaBasin = undefined; }
    }
    const road = this.landscape.roadAt(x, z, col.h);
    if (road) {
      const weight = road.gradeWeight;
      if (weight > 0) {
        col.h = lerp(col.h, road.height, weight);
        // A road embankment can rise out of a pool, but excavation cannot
        // leave a damaging, invisible liquid plane above the visible road.
        // Refill the same continuous basin envelope after grading; this
        // also gives freshly cut shores a smooth transition into the lake.
        const basin = col.lavaBasin;
        if (basin) {
          col.lavaY = -1000;
          if (basin.channel > 0.28 && col.h < basin.level + 2) {
            const reach = smoothstep(34, 9, basin.level - col.h);
            col.h = lerp(col.h, smax(col.h, basin.level, 3),
              smoothstep(0.28, 0.45, basin.channel) * reach);
            if (basin.channel > 0.45 && Math.abs(col.h - basin.level) < 1.2) col.lavaY = basin.level;
          }
        }
      }
      col.road = road;
    }
    col.h = gradeLiquidTerrain(this.seed, x, z, col.h);
    if (canReachCoast(x,z) && islandCoastDistance(this.seed, x, z) > ISLAND_SHORE_START) { col.lavaY = -1000; col.lavaBasin = undefined; col.volc = 0; }
    if (!city && col.lavaBasin && col.lavaBasin.channel > .28) {
      const basin = col.lavaBasin;
      // Fade excavation across the upper bank. A hard height predicate here
      // would cut an eight-metre seam into otherwise continuous terrain.
      col.h -= 6 * smoothstep(.28, .8, basin.channel) * smoothstep(basin.level + 24, basin.level, col.h);
      if (col.h < basin.level) col.lavaY = basin.level;
    }
    if (city) {
      // District grading owns its full floor, including where an old hill
      // trail crosses the enlarged boundary. Blend after roads so their
      // weighted shoulders cannot lift terrain through the exact pavement.
      const boundary = capitalBoundary(city, x, z);
      let target = city.y;
      if (city.theme === 'vesper') {
        // An open geological abyss, not a subtractive cave with a hidden roof.
        const depth = smoothstep(-40, -260, boundary);
        target = lerp(city.y, -65 + 5 * Math.sin(x * .008) * Math.cos(z * .009), depth);
        const axis = Math.min(Math.abs(x - city.x), Math.abs(z - city.z));
        const edge = Math.max(Math.abs(x - city.x), Math.abs(z - city.z));
        target = lerp(target, city.y, smoothstep(70, 24, axis) * smoothstep(1550, 1800, edge));
      }
      // A fully graded floor has exactly its authored height. Interpolating
      // at weight 1 can retain a few floating-point bits of the old hill.
      col.h = boundary <= 0 && city.theme !== 'vesper'
        ? target : lerp(col.h, target, smoothstep(192, 0, boundary));
    }
    const temple = this.jungleTempleAt(x,z,120);
    if(temple && !city) {
      const weight=jungleTempleGrade(temple,x,z);
      col.h=lerp(col.h,temple.y,weight);
      col.templeSite=temple;
      col.temple=jungleTempleColumn(temple,x,z);
      col.volc*=1-weight;
      if(weight>.5) {col.lavaY=-1000;col.lavaBasin=undefined;}
    }
    return col;
  }

  roadAt(x: number, z: number): RoadSample | undefined { return this.landscape.roadAt(x, z); }
  /** Surface liquid volumes stop at their actual bed. Caves below a lake are
   * dry unless they have an explicit, separately levelled cistern volume. */
  liquidAt(x: number, y: number, z: number): LiquidSample | undefined {
    const col = this.column(x, z);
    const surface = liquidAtSurfaceColumn(this.seed, x, y, z, col.h, col.lavaY);
    if (surface) return surface;
    if (col.templeSite) {
      for (const pool of buildJungleTemplePlan(col.templeSite).cisterns) {
        const distance = Math.hypot((x - pool.x) / pool.hx, (z - pool.z) / pool.hz) - 1;
        if (distance <= 0 && y >= pool.bottom && y <= pool.level)
          return { id: pool.id, kind: 'water', surfaceY: pool.level, bottomY: pool.bottom, distance, flowX: 0, flowZ: 0 };
      }
    }
    return undefined;
  }
  collectRoadSegments(minX: number, maxX: number, minZ: number, maxZ: number): RoadSegment[] {
    return this.landscape.collectRoads(minX, maxX, minZ, maxZ);
  }
  collectMountains(minX: number, maxX: number, minZ: number, maxZ: number): MountainSite[] {
    return this.landscape.collectMountains(minX, maxX, minZ, maxZ);
  }
  collectCities(): readonly CityDistrict[] { return this.landscape.cities(); }

  collectCityLifts(): readonly CityLiftSite[] {
    return this.cityLifts ??= [...this.collectCities().flatMap(city => cityLiftSites(city)), ...this.collectTransportPlan().lifts];
  }

  collectTransportPlan(): TransportPlan {
    if (this.transportPlan) return this.transportPlan;
    const plan = buildTransportPlan({ seed: this.seed, cities: this.collectCities(), temples: this.collectJungleTemples(),
      sampleHeight: (x, z) => this.baseColumn(x, z).h });
    this.transportPlan = plan;
    this.transportBridgeIndex = new TransportBridgeIndex(plan.bridges);
    for (const box of plan.solids) for (let x = Math.floor((box.x - box.hx) / 256); x <= Math.floor((box.x + box.hx) / 256); x++)
      for (let z = Math.floor((box.z - box.hz) / 256); z <= Math.floor((box.z + box.hz) / 256); z++) {
        const key = `${x},${z}`, cell = this.transportCells.get(key);
        if (cell) cell.push(box); else this.transportCells.set(key, [box]);
      }
    return plan;
  }

  /** Deterministic uphill cave, wholly contained in its grid cell. */
  private caveFor(ix: number, iz: number): CaveSite | null {
    const key = cellKey(ix, iz);
    if (this.caveCache.has(key)) return this.caveCache.get(key)!;
    const seed = hash2i(this.seed ^ 0x6c8e9cf5, ix, iz);
    let result: CaveSite | null = null;
    if (unit(seed) > 0.22) {
      const cx = (ix + 0.5) * CAVE_CELL + (unit(hash2i(seed, 0x394fcd, 0)) - 0.5) * 22;
      const cz = (iz + 0.5) * CAVE_CELL + (unit(hash2i(seed, 0x759acc, 0)) - 0.5) * 22;
      if (this.landscape.cityAt(cx, cz, 145)) { setBounded(this.caveCache, key, null, STRUCT_CACHE_LIMIT); return null; }
      // Authored shrine galleries own their supported floors and stone
      // sleeves. Do not publish a procedural entrance whose tunnel would be
      // sealed by that masonry; temples already supply two or four exits.
      if (this.jungleTempleAt(cx, cz, 145)) { setBounded(this.caveCache, key, null, STRUCT_CACHE_LIMIT); return null; }
      const stations = this.collectTransportPlan().stations;
      // Station clearings extend114m from their hall; reserve another145m
      // for a cave's chamber, either mouth and its open approach apron.
      if (stations.some(station => Math.abs(cx - station.x - 80) < 260 && Math.abs(cz - station.z - 80) < 260)) {
        setBounded(this.caveCache, key, null, STRUCT_CACHE_LIMIT); return null;
      }
      // Steep summit faces keep their continuous rock profile. An entrance
      // apron fitted on a cliff would create a much steeper raised wedge.
      if (this.landscape.mountain(Math.floor(cx / 1024), Math.floor(cz / 1024)).dramatic &&
        this.landscape.uplift(cx, cz) > 12) { setBounded(this.caveCache, key, null, STRUCT_CACHE_LIMIT); return null; }
      const center = this.baseColumn(cx, cz);
      if (center.volc < 0.35 && center.h > -12) {
        let best = -Infinity, dx = 1, dz = 0, mx = cx - 72, mz = cz;
        // Eight fixed directions keep generation bit-identical on both ends.
        const dirs = [[1, 0], [0.7071067811865476, 0.7071067811865476], [0, 1],
          [-0.7071067811865476, 0.7071067811865476], [-1, 0],
          [-0.7071067811865476, -0.7071067811865476], [0, -1],
          [0.7071067811865476, -0.7071067811865476]];
        for (const dir of dirs) {
          const x = cx - dir[0] * 72, z = cz - dir[1] * 72;
          const rise = center.h - this.baseColumn(x, z).h;
          if (rise > best) { best = rise; dx = dir[0]; dz = dir[1]; mx = x; mz = z; }
        }
        const mouth = this.baseColumn(mx, mz);
        result = { x: mx, y: mouth.h, z: mz, dx, dz, length: 72, mouthLength: 28,
          depth: 15 + unit(hash2i(seed, 0x32817f, 0)) * 4,
          width: 7.5 + unit(hash2i(seed, 0x731cbf, 0)) * 2.5,
          chamberRadius: 20 + unit(hash2i(seed, 0x951def, 0)) * 5,
          height: 12 + unit(hash2i(seed, 0x53fcc1, 0)) * 5,
          bend: (unit(hash2i(seed, 0x139c71, 0)) - 0.5) * 10, seed };
        // Roof the route only after the hillside supplies actual headroom.
        // A fixed mouth length can put a low stone lintel across the path
        // when the uphill route briefly crosses a hollow.
        for (let t = 24; t <= 64; t += 4) {
          const floor = mouth.h - result.depth * smoothstep(0, 72, t);
          if (this.baseColumn(mx + dx * t, mz + dz * t).h - floor < CAVE_MIN_ROOF + 3.6) result.mouthLength = t + 5;
        }
        // Roads retain a continuous surface; cave mouths choose adjacent
        // hillsides instead of punching pits into trunk lanes or switchbacks.
        for (let t = -28; t <= result.mouthLength + 8; t += 8) {
          const road = this.landscape.roadAt(mx + dx * t, mz + dz * t);
          if (road && road.distance < road.width + 18) { result = null; break; }
        }
        if (result && center.h < result.y - result.depth + 12) result = null;
        if (result) {
          // A through-cave has two independently fitted hillside approaches.
          // Join them on one level chamber floor, rather than intersecting
          // sloping tubes and leaving a one-way drop at their junction.
          const floor = result.y - result.depth;
          for (let i = 0; i < dirs.length; i++) {
            const dir = dirs[(i + (seed & 7)) % dirs.length];
            if (dir[0] * dx + dir[1] * dz > 0.1) continue;
            const length = 88;
            const ex = cx - dir[0] * length, ez = cz - dir[1] * length;
            const entrance = this.baseColumn(ex, ez);
            const depth = entrance.h - floor;
            if (entrance.volc > 0.3 || depth < 8 || depth > 25.5) continue;
            const exit: CaveSite = { ...result, x: ex, y: entrance.h, z: ez,
              dx: dir[0], dz: dir[1], depth, length, bend: 0,
              mouthLength: 28, levelChamber: true };
            let valid = true;
            for (let t = 24; t <= length - 8; t += 4) {
              if (this.baseColumn(ex + dir[0] * t, ez + dir[1] * t).h - caveFloorAt(exit, t) < CAVE_MIN_ROOF + 3.6) {
                exit.mouthLength = t + 5;
              }
            }
            if (exit.mouthLength > length - 14) continue;
            for (let t = -28; t <= exit.mouthLength + 8; t += 8) {
              const road = this.landscape.roadAt(ex + dir[0] * t, ez + dir[1] * t);
              if (road && road.distance < road.width + 18) { valid = false; break; }
            }
            if (!valid) continue;
            result.levelChamber = true;
            result.exit = exit;
            break;
          }
        }
      }
    }
    setBounded(this.caveCache, key, result, STRUCT_CACHE_LIMIT);
    return result;
  }

  collectCaveSites(minX: number, maxX: number, minZ: number, maxZ: number): CaveSite[] {
    const sites: CaveSite[] = [];
    for (let iz = Math.floor(minZ / CAVE_CELL); iz <= Math.floor(maxZ / CAVE_CELL); iz++) {
      for (let ix = Math.floor(minX / CAVE_CELL); ix <= Math.floor(maxX / CAVE_CELL); ix++) {
        const site = this.caveFor(ix, iz);
        if (site) { sites.push(site); if (site.exit) sites.push(site.exit); }
      }
    }
    return sites;
  }

  column(x: number, z: number): ColumnData {
    const col = this.baseColumn(x, z);
    const arrival = transportGroundAt(this.collectTransportPlan(), x, z, col.h);
    if (arrival) {
      col.h = lerp(col.h, arrival.height, arrival.weight); col.transport = true;
      // Arrival halls keep one dry, walkable grade. A procedural cave mouth
      // cannot cut a hole beneath their lift or airlift boarding lane.
      col.entr = col.entrRaw = 0;
      return col;
    }
    const rx = Math.floor(x / 96), rz = Math.floor(z / 96);
    const localX = x - (rx + 0.5) * 96, localZ = z - (rz + 0.5) * 96;
    if (Math.abs(localX) < 28 && Math.abs(localZ) < 28) {
      const salt = this.seed ^ 0x4439ac;
      const px = localX - (unit(hash2i(salt, rx, rz)) - 0.5) * 20;
      const pz = localZ - (unit(hash2i(salt + 1, rx, rz)) - 0.5) * 20;
      const radius = 4 + unit(hash2i(salt + 2, rx, rz)) * 4;
      const radial = Math.max(Math.abs(px) * 0.94 + Math.abs(pz) * 0.35,
        Math.abs(pz) * 0.94 + Math.abs(px) * 0.35) - radius;
      const apron = Math.max(0, radial - 4);
      col.deepRock = radial + apron * apron;
    }
    const site = this.caveFor(Math.floor(x / CAVE_CELL), Math.floor(z / CAVE_CELL));
    if (!site) return col;
    const main = caveColumn(site, x, z), exit = site.exit ? caveColumn(site.exit, x, z) : undefined;
    if (!main && !exit) return col;
    const branches = [main, exit].filter((c): c is CaveColumn => c !== undefined);
    let selected = branches[0];
    const strata = this.noise.fbm2(x * 0.067 + 317, z * 0.067 - 91, 2);
    for (const cave of branches) {
      cave.chamber += strata * 3.2;
      // Talus rises along room edges and alcoves; the central walking lane
      // stays exactly on its guaranteed continuous grade.
      cave.floor += smoothstep(3.5, 13, Math.abs(cave.side)) * (2.2 + strata * 1.5) *
        (site.exit ? smoothstep(5, -2, cave.chamber) : 1);
      if (cave.footprint > selected.footprint) selected = cave;
      // A broad approach is part of the heightfield. Its center meets the
      // gallery floor exactly, so walking between exterior and cave has no lip.
      const apron = smoothstep(-34, -6, cave.forward) * smoothstep(16, 2, cave.forward) *
        smoothstep(cave.width + 10, cave.width * 0.48, Math.abs(cave.side));
      col.h = lerp(col.h, cave.floor, apron);
      // A route aimed uphill can still cross a local hollow. Fill its broad
      // shoulders to the same grade instead of leaving a floating path floor
      // above a depression that the player could fall into.
      const support = smoothstep(-34, -6, cave.forward) *
        smoothstep(cave.site.mouthLength + 8, cave.site.mouthLength, cave.forward) *
        smoothstep(cave.width + 10, cave.width * 0.48, Math.abs(cave.side));
      col.h = lerp(col.h, Math.max(col.h, cave.floor), support);
      const entrance = cave.mouth <= 0
        ? CAVE_ENTRANCE_THRESHOLD * smoothstep(-2, 0, cave.mouth)
        : CAVE_ENTRANCE_THRESHOLD + (1 - CAVE_ENTRANCE_THRESHOLD) * smoothstep(0, 2, cave.mouth);
      col.entr = Math.max(col.entr, entrance);
    }
    col.cave = selected;
    if (branches.length > 1) col.caveBranches = branches;
    col.entrRaw = col.entr * 0.5;
    return col;
  }

  terrainHeight(x: number, z: number): number {
    return this.column(x, z).h;
  }

  // ---- Caves -------------------------------------------------------------

  /** Smooth lower envelope; its theoretical range is MIN_CAVE_Y+2..+14. */
  private caveFloorY(x: number, z: number): number {
    const n = this.noise;
    const broad = n.fbm2(x * 0.0031 - 211.0, z * 0.0031 + 487.0, 3);
    const detail = n.fbm2(x * 0.0107 + 619.0, z * 0.0107 - 143.0, 2);
    return WORLD.MIN_CAVE_Y + 8 + broad * 4 + detail * 2;
  }

  /** The deep network is sealed under a meshable crust, independent of mouths. */
  private caveCarve(x: number, y: number, z: number, col: ColumnData): number {
    const skin = smoothstep(col.h - CAVE_MIN_ROOF, col.h - CAVE_MIN_ROOF - 6, y);
    const floorY = this.caveFloorY(x, z);
    const floor = smoothstep(floorY, floorY + 10, y);
    const n = this.noise;
    const a = n.fbm3(x * 0.017, y * 0.028, z * 0.017, 2);
    const b = n.fbm3(x * 0.013 + 400, y * 0.022, z * 0.013 - 177, 2);
    const tunnels = (0.145 - (a * a + b * b)) * 30;
    const rooms = (n.fbm3(x * 0.006 - 900, y * 0.009, z * 0.006 + 333, 2) - 0.40) * 46;
    let interior = Math.max(tunnels, rooms) - (1 - Math.min(skin, floor)) * 30;
    if (col.deepRock !== undefined) {
      // Bedrock rises into immense roof-supporting ribs and faceted pillars.
      // Reuse existing 3D fields for taper; no new noise evaluations. The
      // authored exit galleries are kept clear, and existing floor bounds
      // are only made more solid, so no pits or lower cutoff breaches form.
      const routeClearance = col.cave ? smoothstep(-8, -2, col.cave.footprint) * 32 : 0;
      const buttress = col.deepRock + a * 1.2 + b * 0.8 + routeClearance;
      interior = Math.min(interior, buttress);
    }
    if (col.cave) {
      // Keep the complete approach and chamber floor: an unrelated deeper
      // noise cavity must never eat the guaranteed route back to daylight.
      // The clamp recedes continuously into rock outside the cave footprint.
      if (col.caveBranches) {
        for (const cave of col.caveBranches) interior = lerp(interior, Math.min(interior, y - cave.floor),
          smoothstep(-10, -2, cave.footprint));
      } else interior = lerp(interior, Math.min(interior, y - col.cave.floor),
        smoothstep(-10, -2, col.cave.footprint));
    }
    return interior;
  }

  /** Exact graded floor, barrel gallery, asymmetric chamber and open mouth. */
  private siteCarve(y: number, col: ColumnData, c = col.cave!): number {
    const site = c.site;
    const up = y - c.floor;
    const gallery = Math.min(
      (1 - Math.hypot(c.side / c.width, (up - 2) / 8.5)) * c.width,
      c.forward + 32, site.length + 8 - c.forward,
    );
    // Offset roof lobes and sloping upper ledges are part of collision, not
    // floating decorations. The broad variations remain visible at 1m LOD.
    const radial = clamp(1 - c.chamber / site.chamberRadius, 0, 1);
    const chamberRoof = 2 + site.height * Math.sqrt(1 - radial * radial) + c.side * 0.06;
    const chamber = Math.min(c.chamber, chamberRoof - up);
    // The gallery's roof always has a full crust. A separate open arch face
    // breaks that crust in one meshable vertical boundary, avoiding films
    // where an arbitrary ellipsoid happens to graze the terrain.
    const roofed = Math.min(Math.max(gallery, chamber), col.h - CAVE_MIN_ROOF - y);
    const openMouth = Math.min(c.mouth, col.h + 1 - y);
    // Recede below the deep field's global lower bound at the padded edge.
    // The compact column lookup therefore stays continuous even in solid
    // rock, as well as preserving every visible air/solid sign crossing.
    const apron = Math.max(0, -c.footprint - 2);
    return Math.min(Math.max(roofed, openMouth), up) - apron * apron * 2;
  }

  /** Canonical terrain/cave field before props, structures, and the border. */
  private terrainSdfCol(x: number, y: number, z: number, col: ColumnData): number {
    const terrain = y - col.h;
    if (y >= col.h + 1) return col.temple ? jungleTempleField(col.temple,y,terrain) : terrain;
    let site = -Infinity;
    if (col.caveBranches) {
      for (const branch of col.caveBranches) site = Math.max(site, this.siteCarve(y, col, branch));
    } else if (col.cave) site = this.siteCarve(y, col);
    const d=y>=col.h-CAVE_MIN_ROOF ? Math.max(terrain,site) : Math.max(terrain,site,this.caveCarve(x,y,z,col));
    return col.temple ? jungleTempleField(col.temple,y,d) : d;
  }

  private terrainSdf(x: number, y: number, z: number): number {
    return this.terrainSdfCol(x, y, z, this.column(x, z));
  }

  /**
   * True when terrain rock (props and structures ignored) lies anywhere
   * directly above the point. This is the honest "is the camera actually
   * underground" predicate: an open-air entrance bowl sits below the
   * nominal heightfield but has clear sky above, whereas any real cave
   * interior has a roof. Heightfield-depth heuristics cannot tell those
   * apart and used to lock the renderer's cave mode (opaque dark horizon)
   * while the player stood in an open bowl. The vertical march reuses one
   * column's 2D data, so the common outdoor case costs a few evaluations.
   */
  roofedAbove(x: number, y: number, z: number): boolean {
    const col = this.column(x, z);
    // Above the entrance headroom the terrain field is positive and grows
    // with height; nothing can be overhead.
    const top = col.h + CAVE_ENTRANCE_HEADROOM;
    if (y >= top) return false;
    let cy = y;
    let d = this.terrainSdfCol(x, cy, z, col);
    if (d <= 0) return true; // inside rock counts as roofed
    for (let i = 0; i < 400 && cy < top; i++) {
      cy += Math.max(d * 0.45, TRACE_MIN_STEP);
      d = this.terrainSdfCol(x, cy, z, col);
      if (d <= 0) return true;
    }
    // A ray hugging an aperture wall can exhaust the budget without a
    // verdict; treating that as roofed errs toward cave rendering, never
    // toward blacking out an open sky.
    return cy < top;
  }

  /**
   * First terrain-only surface below a column. Used while placing props, so
   * it deliberately cannot recurse through bouldersFor()/regionAt().
   */
  private terrainGroundY(x: number, z: number): number | null {
    const col = this.column(x, z);
    let airY = Math.min(WORLD.MAX_HEIGHT - 1, col.h + 2);
    let airD = this.terrainSdfCol(x, airY, z, col);
    if (airD <= 0) return null; // column contract was violated

    const bottom = WORLD.MIN_CAVE_Y - 2;
    for (let i = 0; i < 256 && airY > bottom; i++) {
      const step = Math.max(0.05, Math.min(1, airD * 0.45));
      const y = Math.max(bottom, airY - step);
      const d = this.terrainSdfCol(x, y, z, col);
      if (d <= 0) {
        let solidY = y;
        for (let k = 0; k < 12; k++) {
          const mid = (airY + solidY) * 0.5;
          if (this.terrainSdfCol(x, mid, z, col) > 0) airY = mid;
          else solidY = mid;
        }
        return solidY;
      }
      airY = y;
      airD = d;
    }
    return null;
  }

  private terrainNormalY(x: number, y: number, z: number): number {
    const e = 0.16;
    const dx = this.terrainSdf(x + e, y, z) - this.terrainSdf(x - e, y, z);
    const dy = this.terrainSdf(x, y + e, z) - this.terrainSdf(x, y - e, z);
    const dz = this.terrainSdf(x, y, z + e) - this.terrainSdf(x, y, z - e);
    const len = Math.hypot(dx, dy, dz);
    return len > 1e-9 ? dy / len : 0;
  }

  // ---- Procedural structures --------------------------------------------

  private structFor(ci: number, cj: number): StructData | null {
    const key = cellKey(ci, cj);
    const cached = this.structCache.get(key);
    if (cached !== undefined) return cached;
    if(this.jungleTempleAt((ci+.5)*STRUCT_CELL,(cj+.5)*STRUCT_CELL,STRUCT_CELL*.5+58)) {
      setBounded(this.structCache,key,null,STRUCT_CACHE_LIMIT);return null;
    }
    const city = this.landscape.cityAt((ci + .5) * STRUCT_CELL, (cj + .5) * STRUCT_CELL, 360);
    if (city) {
      const block = buildCityBlock(city, ci, cj);
      if (block) { setBounded(this.structCache, key, block, STRUCT_CACHE_LIMIT); return block; }
      if (city.theme) { setBounded(this.structCache, key, null, STRUCT_CACHE_LIMIT); return null; }
    }
    if (this.collectTransportPlan().stations.some(station =>
      Math.abs(station.x + 80 - (ci + .5) * STRUCT_CELL) < STRUCT_CELL * .5 + 130 &&
      Math.abs(station.z + 80 - (cj + .5) * STRUCT_CELL) < STRUCT_CELL * .5 + 130)) {
      setBounded(this.structCache, key, null, STRUCT_CACHE_LIMIT); return null;
    }

    const s = this.seed + 91099;
    let out: StructData | null = null;
    if (unit(hash2i(s, ci, cj)) < 0.72) {
      const cellX = ci * STRUCT_CELL + STRUCT_CELL * 0.5;
      const cellZ = cj * STRUCT_CELL + STRUCT_CELL * 0.5;
      const cellCol = this.column(cellX, cellZ);
      if (liquidAtSurfaceColumn(this.seed, cellX, cellCol.h + .1, cellZ, cellCol.h, cellCol.lavaY)) {
        setBounded(this.structCache, key, null, STRUCT_CACHE_LIMIT); return null;
      }
      const styleRoll = unit(hash2i(s + 70, ci, cj));
      // Pyramids are deliberately rare monuments (roughly one per 25-70
      // structure cells, favoring deserts); villages appear as the uncommon
      // tail of every biome's style table.
      const monumentRoll = unit(hash2i(s + 71, ci, cj));
      // Runways need long flat ground, which the relief filter enforces; the
      // roll is generous because most rugged candidates fail placement.
      const runwayRoll = unit(hash2i(s + 72, ci, cj));
      const complexRoll = unit(hash2i(s + 73, ci, cj));
      // Volcanic cells host at most a megapyramid; ordinary kinds selected
      // there would fail the volc footprint rejection below anyway. The
      // border margin keeps the colossus fully inside the playable square.
      let kind: StructureKind =
        cellCol.volc > 0.6 && monumentRoll < 0.3 &&
        Math.max(Math.abs(cellX), Math.abs(cellZ)) < WORLD.BORDER - 200
          ? STRUCTURE_KIND.MEGAPYRAMID
          : complexRoll < 0.06 ? STRUCTURE_KIND.MILITARY_BASE
          : complexRoll < 0.13 ? STRUCTURE_KIND.ENCAMPMENT
          : complexRoll < 0.17 ? STRUCTURE_KIND.RADAR_STATION
          : complexRoll < 0.21 ? STRUCTURE_KIND.RESEARCH_STATION
          : runwayRoll < 0.075
          ? STRUCTURE_KIND.RUNWAY
          : monumentRoll < (cellCol.desert > 0.4 ? 0.055 : 0.014)
          ? STRUCTURE_KIND.PYRAMID
          : cellCol.desert > 0.52
            ? (styleRoll < 0.50
                ? STRUCTURE_KIND.COURTYARD
                : styleRoll < 0.84
                  ? STRUCTURE_KIND.HANGAR
                  : STRUCTURE_KIND.VILLAGE)
            : cellCol.temp < 0.34
              ? (styleRoll < 0.58
                  ? STRUCTURE_KIND.RELAY
                  : styleRoll < 0.86
                    ? STRUCTURE_KIND.BUNKER
                    : STRUCTURE_KIND.VILLAGE)
              : styleRoll < 0.30
                ? STRUCTURE_KIND.BUNKER
                : styleRoll < 0.56
                  ? STRUCTURE_KIND.COURTYARD
                  : styleRoll < 0.74
                    ? STRUCTURE_KIND.HANGAR
                    : styleRoll < 0.87
                      ? STRUCTURE_KIND.RELAY
                      : STRUCTURE_KIND.VILLAGE;
      let dims =
        kind === STRUCTURE_KIND.BUNKER ? { hx: 7.2, hz: 7.2 } :
        kind === STRUCTURE_KIND.COURTYARD ? { hx: 9.0, hz: 9.0 } :
        kind === STRUCTURE_KIND.HANGAR ? { hx: 7.6, hz: 10.8 } :
        kind === STRUCTURE_KIND.RELAY ? { hx: 10.4, hz: 7.2 } :
        kind === STRUCTURE_KIND.VILLAGE ? { hx: 14.5, hz: 14.5 } :
        kind === STRUCTURE_KIND.PYRAMID ? { hx: 17.5, hz: 17.5 } :
        kind === STRUCTURE_KIND.MEGAPYRAMID ? { hx: 54, hz: 54 } :
        kind === STRUCTURE_KIND.MILITARY_BASE ? { hx: 46, hz: 34 } :
        kind === STRUCTURE_KIND.ENCAMPMENT ? { hx: 25, hz: 23 } :
        kind === STRUCTURE_KIND.RADAR_STATION ? { hx: 20, hz: 18 } :
        kind === STRUCTURE_KIND.RESEARCH_STATION ? { hx: 22, hz: 20 } :
        { hx: 42, hz: 10 };
      const rot = unit(hash2i(s + 3, ci, cj)) < 0.5;
      let footprintHx = rot ? dims.hz : dims.hx;
      let footprintHz = rot ? dims.hx : dims.hz;

      let best: {
        x: number;
        z: number;
        minH: number;
        maxH: number;
        relief: number;
        score: number;
      } | null = null;
      const transportNeighbors = new Set<Box>();
      for (let x = ci - 1; x <= ci + 1; x++) for (let z = cj - 1; z <= cj + 1; z++)
        for (const box of this.transportCells.get(`${x},${z}`) ?? []) transportNeighbors.add(box);
      // Richer terrain should reduce suitability, not erase structures.
      // Search several deterministic candidates and use the gentlest valid
      // footprint; foundations handle the remaining few metres of relief.
      for (let pass = 0; pass < 2; pass++) {
      if (pass > 0) {
        if (best || kind < STRUCTURE_KIND.MILITARY_BASE) break;
        // Rugged cells still get useful cover when a large installation
        // cannot fit. Rare compounds must not erase ordinary settlements.
        kind = STRUCTURE_KIND.BUNKER;
        dims = { hx: 7.2, hz: 7.2 };
        footprintHx = footprintHz = 7.2;
      }
      for (let attempt = 0; attempt < 24; attempt++) {
        const px = cellX +
          (unit(hash2i(s + 1 + attempt * 11, ci, cj)) - 0.5) *
            STRUCT_CELL * (kind >= STRUCTURE_KIND.MILITARY_BASE ? 0.46 : 0.64);
        const pz = cellZ +
          (unit(hash2i(s + 2 + attempt * 11, ci, cj)) - 0.5) *
            STRUCT_CELL * (kind >= STRUCTURE_KIND.MILITARY_BASE ? 0.46 : 0.64);
        let minH = Infinity;
        let maxH = -Infinity;
        let crossesEntrance = false;
        let roadDistance = 0;
        const roadGuard = Math.hypot(footprintHx, footprintHz) / 8 + 1.2;
        // A 9x9 stencil keeps the largest gap below 3m even for a hangar.
        // Sparse corner/center sampling can miss a hillock under the floor or
        // a hollow below the foundation and create buried/floating interiors.
        for (let ix = 0; ix <= 8; ix++) {
          const ox = lerp(-footprintHx, footprintHx, ix / 8);
          for (let iz = 0; iz <= 8; iz++) {
            const oz = lerp(-footprintHz, footprintHz, iz / 8);
            const col = this.column(px + ox, pz + oz);
            if (col.h < minH) minH = col.h;
            if (col.h > maxH) maxH = col.h;
            if (col.entr > CAVE_ENTRANCE_THRESHOLD) crossesEntrance = true;
            if (col.road && col.road.distance < col.road.width + roadGuard) crossesEntrance = true;
            if (ix === 4 && iz === 4) roadDistance = col.road?.distance ?? 0;
            // A dead-flat lava lake would otherwise be a perfect site score.
            // The megapyramid is the one structure that BELONGS on basalt.
            if (col.lavaY > -999) crossesEntrance = true;
            if (kind !== STRUCTURE_KIND.MEGAPYRAMID && col.volc > 0.55) {
              crossesEntrance = true;
            }
          }
        }
        const relief = maxH - minH;
        const padTop = maxH + 0.14;
        // Smooth-union pads bulge slightly above both input surfaces. Put an
        // exact flat floor just above that conservative maximum so interiors
        // never inherit a wavy/buried collision floor.
        const padDelta = padTop - maxH;
        const padBulge =
          Math.max(0, PAD_SMOOTH - padDelta) ** 2 /
          (4 * PAD_SMOOTH);
        const top = padTop + padBulge + 0.025;
        // Keep authored pier/pylon foundations out of ordinary interiors.
        // Elevated decks remain compatible with buildings well below them;
        // only intersecting candidate footprints need another placement.
        for (const reserved of transportNeighbors) {
          if (reserved.y - reserved.hy > top + 80 || reserved.y + reserved.hy < minH - 2) continue;
          if (Math.abs(px - reserved.x) < footprintHx + reserved.hx + 4 &&
              Math.abs(pz - reserved.z) < footprintHz + reserved.hz + 4) {
            crossesEntrance = true; break;
          }
        }
        let maxApproachDelta = 0;
        let approachesReachable = true;
        // Every family has an intended through-route on its local Z axis.
        // Check just beyond both foundation aprons, with rotation applied.
        const compound = kind === STRUCTURE_KIND.MILITARY_BASE;
        const approachZ = dims.hz + (compound ? 12 : 1);
        for (const side of [-1, 1]) {
          const localZ = side * approachZ;
          const ax = rot ? px + localZ : px;
          const az = rot ? pz : pz + localZ;
          const approach = this.column(ax, az);
          const delta = top - approach.h;
          maxApproachDelta = Math.max(maxApproachDelta, Math.abs(delta));
          if (
            approach.entr > CAVE_ENTRANCE_THRESHOLD ||
            delta < -0.45 ||
            delta > (compound ? 6 : 1.30)
          ) {
            approachesReachable = false;
          }
        }
        // The megapyramid tolerates volcanic relief (its plinth swallows
        // it), skips the walk-up approach rule (you enter via its gates),
        // and caps lower so its 78m of tiers stay under the sky guarantee.
        const mega = kind === STRUCTURE_KIND.MEGAPYRAMID;
        if (
          crossesEntrance ||
          (!mega && !approachesReachable) ||
          relief > (mega ? 24 : compound ? 9 : 4.8) ||
          minH <= WORLD.MIN_CAVE_Y + 8 ||
          maxH >= (mega ? 172 : WORLD.MAX_HEIGHT - 18)
        ) continue;
        const score = relief + maxApproachDelta * 0.7 + Math.min(roadDistance, 400) * 0.002;
        if (!best || score < best.score) {
          best = { x: px, z: pz, minH, maxH, relief, score };
        }
      }
      }

      if (best) {
        const px = best.x;
        const pz = best.z;
        const padTop = best.maxH + 0.14;
        const padDelta = padTop - best.maxH;
        const padBulge =
          Math.max(0, PAD_SMOOTH - padDelta) ** 2 /
          (4 * PAD_SMOOTH);
        const top = padTop + padBulge + 0.025;
        const bottom = Math.min(padTop - 0.4, best.minH - 0.35);
        const padHx = footprintHx;
        const padHz = footprintHz;
        const pad: Box = {
          x: px,
          y: (padTop + bottom) * 0.5,
          z: pz,
          hx: padHx,
          hy: (padTop - bottom) * 0.5,
          hz: padHz,
        };
        const solids: Box[] = [];
        const cuts: Box[] = [];
        const add = (
          lx: number, ly: number, lz: number,
          hx: number, hy: number, hz: number,
        ): void => {
          solids.push(rot
            ? {
                x: px + lz, y: top + ly, z: pz - lx,
                hx: hz, hy, hz: hx,
              }
            : {
                x: px + lx, y: top + ly, z: pz + lz,
                hx, hy, hz,
              });
        };
        const splitWallX = (
          z: number, halfLength: number, doorWidth: number,
          y: number, halfHeight: number, thickness: number,
        ): void => {
          const segmentHalf = (halfLength * 2 - doorWidth) * 0.25;
          const center = doorWidth * 0.5 + segmentHalf;
          add(-center, y, z, segmentHalf, halfHeight, thickness);
          add(center, y, z, segmentHalf, halfHeight, thickness);
        };
        const splitWallZ = (
          x: number, halfLength: number, doorWidth: number,
          y: number, halfHeight: number, thickness: number,
        ): void => {
          const segmentHalf = (halfLength * 2 - doorWidth) * 0.25;
          const center = doorWidth * 0.5 + segmentHalf;
          add(x, y, -center, thickness, halfHeight, segmentHalf);
          add(x, y, center, thickness, halfHeight, segmentHalf);
        };
        // Exact walkable slab over the smoothly terrain-fitted foundation.
        // It also gives the analytic structure renderer a canonical floor.
        add(0, (bottom - top) * 0.5, 0, dims.hx, (top - bottom) * 0.5, dims.hz);
        // A single intermediate tread halves the largest permitted approach
        // rise, keeping hillside entrances reachable without forcing every
        // generated site onto an unnaturally flat patch.
        const stepHalfWidth =
          kind === STRUCTURE_KIND.RELAY ? 0.72 : 1.15;
        for (const side of [-1, 1]) {
          if (kind === STRUCTURE_KIND.MILITARY_BASE) {
            const localZ = side * (dims.hz + 12);
            const ax = rot ? px + localZ : px;
            const az = rot ? pz : pz + localZ;
            const delta = top - this.column(ax, az).h;
            const count = Math.max(1, Math.ceil(delta / 0.45));
            for (let i = 0; i < count; i++) {
              const treadTop = top - delta * (i + 1) / (count + 1);
              add(0, treadTop - top - 0.35, side * (dims.hz + 0.5 + i * 0.8),
                3, 0.35, 0.48);
            }
            continue;
          }
          const localZ = side * (dims.hz + 1.0);
          const ax = rot ? px + localZ : px;
          const az = rot ? pz : pz + localZ;
          const delta = top - this.column(ax, az).h;
          if (delta <= 0.45) continue;
          const stepTop = top - delta * 0.5;
          add(
            0,
            stepTop - top - 0.56,
            side * (dims.hz + 0.45),
            stepHalfWidth,
            0.56,
            0.65,
          );
        }

        if (kind >= STRUCTURE_KIND.MILITARY_BASE) {
          buildStructureFamily(kind, add, hash2i(s + 74, ci, cj));
        } else if (kind === STRUCTURE_KIND.BUNKER) {
          const w = 6.25;
          const wallY = 1.7;
          const wallH = 1.7;
          const t = 0.55;
          add(-w, wallY, 0, t, wallH, w);
          add(w, wallY, 0, t, wallH, w);
          splitWallX(-w, w, 2.8, wallY, wallH, t);
          splitWallX(w, w, 2.8, wallY, wallH, t);
          // A divided interior creates close cover without dead-ending either
          // entrance; the central opening is wider than a player capsule.
          splitWallX(0, 4.5, 2.4, 1.25, 1.25, 0.56);
          // Authoritative isolated boxes stay thicker than the renderer's
          // finest 1m lattice, regardless of their fractional world offset.
          add(0, 3.65, 0, 6.45, 0.56, 6.45);
          add(-3.7, 0.58, -3.3, 0.7, 0.58, 0.7);
          add(3.7, 0.58, 3.3, 0.7, 0.58, 0.7);
        } else if (kind === STRUCTURE_KIND.COURTYARD) {
          const w = 8.2;
          const t = 0.58;
          const wallY = 1.45;
          const wallH = 1.45;
          splitWallX(-w, w, 3.4, wallY, wallH, t);
          splitWallX(w, w, 3.4, wallY, wallH, t);
          splitWallZ(-w, w, 3.4, wallY, wallH, t);
          splitWallZ(w, w, 3.4, wallY, wallH, t);
          // Broken inner arcades and pillars make several routes through the
          // roofless ruin instead of one empty square.
          add(-3.2, 1.1, -2.7, 2.0, 1.1, 0.56);
          add(3.4, 1.1, 2.9, 1.8, 1.1, 0.56);
          for (const [x, z] of [[-5.4, 4.8], [5.2, -4.9], [-1.8, 4.7], [1.9, -4.8]]) {
            add(x, 1.15, z, 0.56, 1.15, 0.56);
          }
          add(0, 0.55, 0, 1.2, 0.55, 1.2);
        } else if (kind === STRUCTURE_KIND.HANGAR) {
          const xw = 6.75;
          const zw = 9.8;
          const t = 0.62;
          add(xw, 2.0, 0, t, 2.0, zw);
          splitWallZ(-xw, zw, 3.0, 2.0, 2.0, t);
          splitWallX(-zw, xw, 4.8, 2.0, 2.0, t);
          splitWallX(zw, xw, 4.8, 2.0, 2.0, t);
          // Two roof strips leave a long skylight and keep the interior
          // readable from above.
          add(-4.25, 4.18, 0, 2.5, 0.56, 9.45);
          add(4.25, 4.18, 0, 2.5, 0.56, 9.45);
          add(-3.8, 0.7, -4.7, 0.85, 0.7, 1.2);
          add(3.8, 0.7, 4.5, 0.85, 0.7, 1.2);
          add(0, 0.56, 2.0, 1.45, 0.56, 0.65);
        } else if (kind === STRUCTURE_KIND.VILLAGE) {
          // Four huts of slightly different sizes around an open plaza with
          // a central well. Every door faces the plaza, and the north-south
          // lane between the hut rows is the intended through-route.
          const hutY = 1.25;
          const hutH = 1.25;
          const t = 0.56;
          const huts: readonly [number, number, number][] = [
            [-8.6, -8.4, 3.2], [8.4, -8.6, 3.6],
            [-8.3, 8.6, 3.4], [8.6, 8.3, 3.0],
          ];
          for (const [hcx, hcz, w] of huts) {
            add(hcx, hutY, hcz - w, w, hutH, t);
            add(hcx, hutY, hcz + w, w, hutH, t);
            const outerSide = Math.sign(hcx);
            add(hcx + outerSide * w, hutY, hcz, t, hutH, w);
            // Plaza-facing wall carries the door: two flanking segments.
            const innerX = hcx - outerSide * w;
            const segment = (w * 2 - 1.6) * 0.25;
            add(innerX, hutY, hcz - (0.8 + segment), t, hutH, segment);
            add(innerX, hutY, hcz + (0.8 + segment), t, hutH, segment);
            add(hcx, hutH * 2 + 0.56, hcz, w + 0.35, 0.56, w + 0.35);
          }
          // Well and two market stalls give the plaza interior cover
          // without blocking the lane ends the approach steps land on.
          add(0, 0.85, 0, 0.85, 0.85, 0.85);
          add(-4.6, 0.62, 0.4, 1.1, 0.62, 0.56);
          add(4.7, 0.62, -0.5, 1.1, 0.62, 0.56);
        } else if (kind === STRUCTURE_KIND.RUNWAY) {
          // A jet strip: the flat foundation is the runway itself. Low edge
          // lights flank it and a small tower marks the threshold; the whole
          // centerline stays obstacle-free for takeoff rolls.
          // Offset from the centerline grid so the canonical crossing route
          // (local x = 0) stays clear between the marker rows.
          for (let i = 0; i < 6; i++) {
            const lx = -30 + i * 12;
            add(lx, 0.6, -8.8, 0.6, 0.6, 0.6);
            add(lx, 0.6, 8.8, 0.6, 0.6, 0.6);
          }
          add(-38, 1.7, -7.6, 1.3, 1.7, 1.3);
        } else if (kind === STRUCTURE_KIND.PYRAMID) {
          // A rare stepped monument. Every 1.15m riser is jumpable, so the
          // summit is a climbable vantage point; the foundation leaves a
          // 2m walkway ring around the base.
          for (let i = 0; i < 7; i++) {
            const half = 15.5 - i * 2.05;
            add(0, 0.575 + i * 1.15, 0, half, 0.575, half);
          }
          add(0, 0.575 + 7 * 1.15, 0, 1.3, 0.575, 1.3);
        } else if (kind === STRUCTURE_KIND.MEGAPYRAMID) {
          // The volcanic colossus: nine 8.6m tiers rising ~78m, assembled
          // HOLLOW from wall/slab boxes (the client renders solids as exact
          // opaque boxes, so interiors must be built, not carved). Inside:
          // a 48m grand hall behind four full-height gates, a vertical
          // shaft up the core, and a summit chamber with two open slits
          // (rocket-jump territory - the vantage point is earned).
          const tierHalf = (i: number): number => 54 - i * 5.55;
          const tierY = (i: number): number => 4.3 + i * 8.6;
          // Tier 0: gate-split perimeter walls around the hall (r 24..54).
          splitWallX(39, 54, 5.6, 4.3, 4.3, 15);
          splitWallX(-39, 54, 5.6, 4.3, 4.3, 15);
          splitWallZ(39, 54, 5.6, 4.3, 4.3, 15);
          splitWallZ(-39, 54, 5.6, 4.3, 4.3, 15);
          // Tier 1: unbroken ring; the hall is two tiers tall.
          {
            const half = tierHalf(1);
            const mid = (24 + half) / 2, thick = (half - 24) / 2;
            add(0, tierY(1), mid, half, 4.3, thick);
            add(0, tierY(1), -mid, half, 4.3, thick);
            add(mid, tierY(1), 0, thick, 4.3, half);
            add(-mid, tierY(1), 0, thick, 4.3, half);
          }
          // Tiers 2-6: solid slabs with a 4.6m square shaft up the core.
          for (let i = 2; i <= 6; i++) {
            const half = tierHalf(i);
            const mid = (2.3 + half) / 2, wing = (half - 2.3) / 2;
            add(mid, tierY(i), 0, wing, 4.3, half);
            add(-mid, tierY(i), 0, wing, 4.3, half);
            add(0, tierY(i), mid, 2.3, 4.3, wing);
            add(0, tierY(i), -mid, 2.3, 4.3, wing);
          }
          // Tier 7: the summit chamber (interior half 9) with open slits
          // through the east/west walls - doorways onto a 60m drop.
          {
            const half = tierHalf(7);
            const mid = (9 + half) / 2, thick = (half - 9) / 2;
            add(0, tierY(7), mid, half, 4.3, thick);
            add(0, tierY(7), -mid, half, 4.3, thick);
            splitWallZ(mid, 9, 3.0, tierY(7), 4.3, thick);
            splitWallZ(-mid, 9, 3.0, tierY(7), 4.3, thick);
          }
          // Tier 8 roof + capstone.
          add(0, tierY(8), 0, tierHalf(8), 4.3, tierHalf(8));
          add(0, tierY(9), 0, 4.6, 4.3, 4.6);
        } else {
          const podX = 5.3;
          const roomHx = 3.9;
          const roomHz = 5.7;
          const t = 0.55;
          for (const side of [-1, 1]) {
            const cx = side * podX;
            add(cx, 1.6, -roomHz, roomHx, 1.6, t);
            add(cx, 1.6, roomHz, roomHx, 1.6, t);
            const outerX = cx + side * roomHx;
            add(outerX, 1.6, 0, t, 1.6, roomHz);
            splitWallZ(
              cx - side * roomHx,
              roomHz,
              2.6,
              1.6,
              1.6,
              t,
            );
            add(cx, 3.42, 0, roomHx, 0.56, roomHz);
          }
          // The open central breezeway connects both rooms and the two
          // exterior approaches; low windbreaks provide outdoor cover.
          add(-3.2, 0.7, -6.3, 1.3, 0.7, 0.56);
          add(3.2, 0.7, 6.3, 1.3, 0.7, 0.56);
        }

        const site: StructureSite = {
          kind,
          x: px,
          z: pz,
          top,
          hx: padHx,
          hz: padHz,
          rotated: rot,
        };
        out = { site, pad, solids, cuts };
      }
    }
    setBounded(this.structCache, key, out, STRUCT_CACHE_LIMIT);
    return out;
  }

  private bouldersFor(ci: number, cj: number): RBox[] | null {
    const key = cellKey(ci, cj);
    const cached = this.boulderCache.get(key);
    if (cached !== undefined) return cached;

    const s = this.seed + 50021;
    let out: RBox[] | null = null;
    const cx = ci * BOULDER_CELL + BOULDER_CELL / 2;
    const cz = cj * BOULDER_CELL + BOULDER_CELL / 2;
    const u0 = unit(hash2i(s, ci, cj));
    if (u0 < 0.5) {
      const col = this.column(cx, cz);
      let p = 0.34 * (1 - col.desert * 0.6);
      if (col.temp < 0.34) p *= 1.35;
      if (u0 < p) {
        out = [];
        const count = unit(hash2i(s + 1, ci, cj)) < 0.3 ? 2 : 1;
        for (let k = 0; k < count; k++) {
          const bx = cx + (unit(hash2i(s + 2 + k * 5, ci, cj)) - 0.5) * 24;
          const bz = cz + (unit(hash2i(s + 3 + k * 5, ci, cj)) - 0.5) * 24;
          const size = 0.95 + unit(hash2i(s + 4 + k * 5, ci, cj)) * 2.8;
          const hy = size * (0.42 + unit(hash2i(s + 12 + k * 5, ci, cj)) * 0.75);
          const hz = size * (0.75 + unit(hash2i(s + 5 + k * 5, ci, cj)) * 0.5);
          const rockCol = this.column(bx, bz);
          if (rockCol.city || rockCol.templeSite || rockCol.transport) continue;
          if (rockCol.road && rockCol.road.distance < rockCol.road.width + Math.max(size, hz) + 3) continue;
          // Keep the two-way gallery approach clear; mineral/rubble dressing
          // is cosmetic and belongs along its walls, outside this route.
          if (rockCol.cave && rockCol.cave.footprint > -4 && rockCol.cave.forward < 40) continue;
          const opening = rockCol.entr > CAVE_ENTRANCE_THRESHOLD;
          let crossesEntrance = false;
          for (const ox of [-size, 0, size]) {
            for (const oz of [-hz, 0, hz]) {
              if ((this.column(bx + ox, bz + oz).entr > CAVE_ENTRANCE_THRESHOLD) !== opening) {
                crossesEntrance = true;
                break;
              }
            }
            if (crossesEntrance) break;
          }
          // A center-supported rock whose rounded footprint hangs across an
          // entrance rim reads as a floating prop from inside the cavern.
          if (crossesEntrance) continue;
          // No boulders bobbing in lava pools.
          if (this.column(bx, bz).lavaY > -999) continue;
          const supportY = this.terrainGroundY(bx, bz);
          if (supportY === null || this.terrainNormalY(bx, supportY, bz) < 0.48) continue;
          // Keep entrances, perimeter routes, and sight lines around
          // structures free of unlucky boulder placements.
          if (this.blockedByStructure(bx, bz, Math.max(size, hz) + 2.2)) continue;
          // Rest on the first real terrain surface with only a shallow embed.
          // Deeply burying the center can punch the bottom through a thin cave
          // roof and make the primitive appear suspended in the room below.
          const by = supportY + hy - 0.06;
          out.push({
            x: bx, y: by, z: bz,
            hx: size, hy, hz,
            r: size * 0.3,
          });
        }
      }
    }
    setBounded(this.boulderCache, key, out, PROP_CACHE_LIMIT);
    return out;
  }

  private blockedByStructure(
    x: number,
    z: number,
    clearance: number,
  ): boolean {
    const i0 = Math.floor((x - clearance - STRUCT_MARGIN) / STRUCT_CELL);
    const i1 = Math.floor((x + clearance + STRUCT_MARGIN) / STRUCT_CELL);
    const j0 = Math.floor((z - clearance - STRUCT_MARGIN) / STRUCT_CELL);
    const j1 = Math.floor((z + clearance + STRUCT_MARGIN) / STRUCT_CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const structure = this.structFor(i, j);
        if (!structure) continue;
        const pad = structure.pad;
        if (
          Math.abs(x - pad.x) <= pad.hx + clearance &&
          Math.abs(z - pad.z) <= pad.hz + clearance
        ) return true;
      }
    }
    return false;
  }

  private vegetationFor(
    ci: number,
    cj: number,
  ): VegetationPlacement[] | null {
    const key = cellKey(ci, cj);
    const cached = this.vegetationCache.get(key);
    if (cached !== undefined) return cached;

    const s = this.seed + 170141;
    const out: VegetationPlacement[] = [];
    const baseX = ci * VEGETATION_CELL;
    const baseZ = cj * VEGETATION_CELL;
    // Four jittered subcells preserve broad traversal lanes even in the
    // densest grove; no global list or state is needed.
    for (let slot = 0; slot < 4; slot++) {
      const qx = slot & 1;
      const qz = slot >> 1;
      const salt = slot * 17;
      const x = baseX + qx * 32 + 16 +
        (unit(hash2i(s + 1 + salt, ci, cj)) - 0.5) * 19;
      const z = baseZ + qz * 32 + 16 +
        (unit(hash2i(s + 2 + salt, ci, cj)) - 0.5) * 19;
      const col = this.column(x, z);
      if (col.city || col.templeSite || col.transport) continue;
      if (liquidAtSurfaceColumn(this.seed, x, col.h + .1, z, col.h, col.lavaY)) continue;
      const rainforest = (col.rainforest ?? 0) > .35 && col.h < 175;
      const grove = smoothstep(
        -0.28,
        0.28,
        this.noise.fbm2(x * 0.0018 + 181.0, z * 0.0018 - 347.0, 2),
      );
      // Match the altitude-adjusted temperature used by materialAt(), so
      // snowy highlands transition to conifers instead of leafy forests.
      const surfaceTemp = col.temp - Math.max(0, col.h) * 0.005;
      const treeLine = smoothstep(-0.08, 0.12, surfaceTemp);
      const temperate =
        smoothstep(0.20, 0.46, surfaceTemp) *
        smoothstep(0.93, 0.70, surfaceTemp);
      const green = smoothstep(0.28, 0.64, col.moist);
      const broadleaf =
        temperate * green * (1 - col.desert) * lerp(0.28, 1, grove);
      const conifer =
        smoothstep(0.52, 0.20, surfaceTemp) *
        smoothstep(0.20, 0.52, col.moist) *
        lerp(0.35, 1, grove) *
        treeLine;
      const cactus =
        col.desert * lerp(0.72, 0.38, grove);
      // Nothing grows on volcanic ash (and cacti have no altitude gate, so
      // a hot volcanic highland would otherwise sprout cacti beside lava).
      // The hard 2.2x factor zeroes growth well before the basalt line.
      const density = Math.max(
        rainforest ? .96 : 0,
        broadleaf * 0.92,
        conifer * 0.82,
        cactus * 0.62,
      ) * Math.max(0, 1 - col.volc * 2.2);
      if (unit(hash2i(s + 3 + salt, ci, cj)) >= density) continue;

      const kind: VegetationKind =
        rainforest ? VEGETATION_KIND.BROADLEAF : cactus >= broadleaf && cactus >= conifer
          ? VEGETATION_KIND.CACTUS
          : conifer > broadleaf
            ? VEGETATION_KIND.CONIFER
            : VEGETATION_KIND.BROADLEAF;
      // `size` scales overall stature while `shape` independently varies
      // girth and canopy spread, so tall-narrow, short-broad, and everything
      // between all occur - decorrelated silhouettes read as individuals
      // where a single shared parameter produced a clone army.
      const size = unit(hash2i(s + 4 + salt, ci, cj));
      const shape = unit(hash2i(s + 6 + salt, ci, cj));
      const radius =
        rainforest ? 1.7 + size * 1.8 + shape * .3 : kind === VEGETATION_KIND.CACTUS
          ? 0.40 + shape * 0.30
          : 0.42 + size * 0.18 + shape * 0.12;
      const height =
        rainforest ? 36 + size * 33 : kind === VEGETATION_KIND.CACTUS
          ? 3.0 + size * 3.6
          : kind === VEGETATION_KIND.CONIFER
            ? 7.2 + size * 7.4
            : 6.2 + size * 6.6;
      const canopyRadius =
        rainforest ? 10 + size * 7 + shape * 3 : kind === VEGETATION_KIND.CACTUS
          ? 0.85 + size * 0.4
          : kind === VEGETATION_KIND.CONIFER
            ? 1.9 + size * 1.5 + shape * 1.3
            : 2.4 + size * 1.5 + shape * 1.7;
      if (col.road && col.road.distance < col.road.width + canopyRadius + 2) continue;

      // Entrances need a visible, traversable rim. Check the entire canopy
      // footprint, not merely the stem center.
      let nearEntrance = false;
      for (const ox of [-canopyRadius, 0, canopyRadius]) {
        for (const oz of [-canopyRadius, 0, canopyRadius]) {
          if (
            this.column(x + ox, z + oz).entr >
            CAVE_ENTRANCE_THRESHOLD - 0.025
          ) {
            nearEntrance = true;
            break;
          }
        }
        if (nearEntrance) break;
      }
      if (nearEntrance) continue;
      const supportY = this.terrainGroundY(x, z);
      if (
        supportY === null ||
        Math.abs(supportY - col.h) > 0.8 ||
        this.terrainNormalY(x, supportY, z) <
          (kind === VEGETATION_KIND.CACTUS ? 0.66 : 0.72) ||
        this.blockedByStructure(x, z, canopyRadius + 2.2)
      ) continue;

      out.push({
        x,
        y: supportY + 0.015,
        z,
        radius,
        height,
        canopyRadius,
        kind,
        rainforest,
        yaw: unit(hash2i(s + 5 + salt, ci, cj)) * TAU,
      });
    }

    const result = out.length > 0 ? out : null;
    setBounded(this.vegetationCache, key, result, PROP_CACHE_LIMIT);
    return result;
  }

  /** Deterministic vegetation transforms affecting an XZ rectangle. */
  collectVegetation(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): VegetationPlacement[] {
    const out: VegetationPlacement[] = [];
    const i0 = Math.floor((minX - VEGETATION_MARGIN) / VEGETATION_CELL);
    const i1 = Math.floor((maxX + VEGETATION_MARGIN) / VEGETATION_CELL);
    const j0 = Math.floor((minZ - VEGETATION_MARGIN) / VEGETATION_CELL);
    const j1 = Math.floor((maxZ + VEGETATION_MARGIN) / VEGETATION_CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const vegetation = this.vegetationFor(i, j);
        if (vegetation) out.push(...vegetation);
      }
    }
    return out;
  }

  /** Collect all authoritative primitives affecting an XZ rectangle. */
  private undergroundStructFor(ci: number, cj: number): UndergroundStructure | null {
    const key = cellKey(ci, cj);
    if (this.undergroundStructCache.has(key)) return this.undergroundStructCache.get(key)!;
    if(this.jungleTempleAt((ci+.5)*STRUCT_CELL,(cj+.5)*STRUCT_CELL,STRUCT_CELL*.5+32)) {
      setBounded(this.undergroundStructCache,key,null,STRUCT_CACHE_LIMIT);return null;
    }
    const value = generateUndergroundStructure(this.seed, ci, cj,
      (x, y, z) => this.terrainSdf(x, y, z), (x, z) => this.column(x, z).h);
    setBounded(this.undergroundStructCache, key, value, STRUCT_CACHE_LIMIT);
    return value;
  }

  collectUndergroundSites(minX: number, maxX: number, minZ: number, maxZ: number): StructureSite[] {
    const sites: StructureSite[] = [];
    for (let x = Math.floor((minX - 10) / STRUCT_CELL); x <= Math.floor((maxX + 10) / STRUCT_CELL); x++) {
      for (let z = Math.floor((minZ - 10) / STRUCT_CELL); z <= Math.floor((maxZ + 10) / STRUCT_CELL); z++) {
        const data = this.undergroundStructFor(x, z);
        if (data) sites.push(data.site);
      }
    }
    return sites;
  }

  /** Surface descriptors only: never constructs unrelated underground sites. */
  collectSurfaceSites(minX: number, maxX: number, minZ: number, maxZ: number, kind?: StructureKind): StructureSite[] {
    const sites: StructureSite[] = [];
    const salt = this.seed + 91099;
    for (let x = Math.floor((minX - STRUCT_MARGIN) / STRUCT_CELL); x <= Math.floor((maxX + STRUCT_MARGIN) / STRUCT_CELL); x++) {
      for (let z = Math.floor((minZ - STRUCT_MARGIN) / STRUCT_CELL); z <= Math.floor((maxZ + STRUCT_MARGIN) / STRUCT_CELL); z++) {
        // Necessary conditions from the canonical family selector. Testing
        // them before terrain fitting makes rare runway discovery cheap,
        // without duplicating geometry or caching rejected filtered queries.
        if (kind === STRUCTURE_KIND.RUNWAY &&
          (unit(hash2i(salt, x, z)) >= 0.72 || unit(hash2i(salt + 73, x, z)) < 0.21 ||
           unit(hash2i(salt + 72, x, z)) >= 0.075)) continue;
        const data = this.structFor(x, z);
        if (data && (kind === undefined || data.site.kind === kind)) sites.push(data.site);
      }
    }
    return sites;
  }

  /** Collect all authoritative primitives affecting an XZ rectangle. */
  collectStructures(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): StructureRegion {
    const si0 = Math.floor((minX - STRUCT_MARGIN) / STRUCT_CELL);
    const si1 = Math.floor((maxX + STRUCT_MARGIN) / STRUCT_CELL);
    const sj0 = Math.floor((minZ - STRUCT_MARGIN) / STRUCT_CELL);
    const sj1 = Math.floor((maxZ + STRUCT_MARGIN) / STRUCT_CELL);
    const cacheable = (si1 - si0 + 1) * (sj1 - sj0 + 1) <= 16;
    const key = `${si0},${si1},${sj0},${sj1}`;
    const cached = cacheable ? this.structureRegionCache.get(key) : undefined;
    if (cached) return cached;
    const region: StructureRegion = {
      capitalSegments: [],
      sites: [],
      pads: [],
      solids: [],
      cuts: [],
      foundations: [],
    };
    this.collectTransportPlan();
    region.transportBridges = this.transportBridgeIndex;
    const transport = new Set<Box>();
    for (let x = si0; x <= si1; x++) for (let z = sj0; z <= sj1; z++)
      for (const box of this.transportCells.get(`${x},${z}`) ?? []) transport.add(box);
    region.solids.push(...transport);
    for (let i = si0; i <= si1; i++) {
      for (let j = sj0; j <= sj1; j++) {
        const st = this.structFor(i, j);
        if (st) {
          region.sites.push(st.site);
          if (!st.solids[0]?.capital) region.pads.push(st.pad);
          region.solids.push(...st.solids);
          if (!st.solids[0]?.capital) region.foundations!.push(st.solids[0]);
          region.cuts.push(...st.cuts);
        }
        const underground = this.undergroundStructFor(i, j);
        if (underground) {
          region.solids.push(...underground.solids);
          region.foundations!.push({ ...underground.solids[0], underground: true });
        }
      }
    }
    for(const temple of this.collectJungleTemples()) {
      if(temple.x+temple.radius<si0*STRUCT_CELL || temple.x-temple.radius>(si1+1)*STRUCT_CELL ||
        temple.z+temple.radius<sj0*STRUCT_CELL || temple.z-temple.radius>(sj1+1)*STRUCT_CELL) continue;
      for(const box of buildJungleTemplePlan(temple).solids) {
        if(box.x+box.hx<si0*STRUCT_CELL || box.x-box.hx>(si1+1)*STRUCT_CELL ||
          box.z+box.hz<sj0*STRUCT_CELL || box.z-box.hz>(sj1+1)*STRUCT_CELL) continue;
        region.solids.push(box);
      }
    }
    for (const city of this.collectCities()) {
      if (!city.theme || city.x + city.radius + 350 < minX || city.x - city.radius - 350 > maxX ||
          city.z + city.radius + 350 < minZ || city.z - city.radius - 350 > maxZ) continue;
      region.capitalArea = true;
      region.capitalSegments!.push(...capitalSegments(capitalPlan(city)!, si0 * 256, (si1 + 1) * 256, sj0 * 256, (sj1 + 1) * 256));
    }
    if (region.capitalArea) region.solids = [...new Set(region.solids)];
    if (cacheable) setBounded(this.structureRegionCache, key, region, 1024);
    return region;
  }

  /** Boulder-only placements for bounded instanced rendering. */
  collectBoulders(minX: number, maxX: number, minZ: number, maxZ: number): RBox[] {
    const boulders: RBox[] = [];
    const bi0 = Math.floor((minX - BOULDER_MARGIN) / BOULDER_CELL);
    const bi1 = Math.floor((maxX + BOULDER_MARGIN) / BOULDER_CELL);
    const bj0 = Math.floor((minZ - BOULDER_MARGIN) / BOULDER_CELL);
    const bj1 = Math.floor((maxZ + BOULDER_MARGIN) / BOULDER_CELL);
    for (let i = bi0; i <= bi1; i++) {
      for (let j = bj0; j <= bj1; j++) {
        const bs = this.bouldersFor(i, j);
        if (bs) boulders.push(...bs);
      }
    }
    return boulders;
  }

  /** Collect all authoritative primitives affecting an XZ rectangle. */
  collectRegion(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    includeVegetation = true,
  ): Region {
    const structures = this.collectStructures(minX, maxX, minZ, maxZ);
    const region: Region = {
      ...structures,
      boulders: this.collectBoulders(minX, maxX, minZ, maxZ),
      vegetation: [],
    };
    if (includeVegetation) {
      region.vegetation.push(
        ...this.collectVegetation(minX, maxX, minZ, maxZ),
      );
    }
    return region;
  }

  /** Region for a single point, memoized on the last cell tuple. */
  regionAt(x: number, z: number): Region {
    // These bounds exactly mirror collectRegion(). Caching only lower indices
    // is incorrect: an upper index changes within the
    // same lower-index cell, making primitive membership depend on which
    // nearby point happened to be queried first.
    const si0 = Math.floor((x - STRUCT_MARGIN) / STRUCT_CELL);
    const si1 = Math.floor((x + STRUCT_MARGIN) / STRUCT_CELL);
    const sj0 = Math.floor((z - STRUCT_MARGIN) / STRUCT_CELL);
    const sj1 = Math.floor((z + STRUCT_MARGIN) / STRUCT_CELL);
    const bi0 = Math.floor((x - BOULDER_MARGIN) / BOULDER_CELL);
    const bi1 = Math.floor((x + BOULDER_MARGIN) / BOULDER_CELL);
    const bj0 = Math.floor((z - BOULDER_MARGIN) / BOULDER_CELL);
    const bj1 = Math.floor((z + BOULDER_MARGIN) / BOULDER_CELL);
    const vi0 = Math.floor((x - VEGETATION_MARGIN) / VEGETATION_CELL);
    const vi1 = Math.floor((x + VEGETATION_MARGIN) / VEGETATION_CELL);
    const vj0 = Math.floor((z - VEGETATION_MARGIN) / VEGETATION_CELL);
    const vj1 = Math.floor((z + VEGETATION_MARGIN) / VEGETATION_CELL);
    if (this.lastRegion &&
        si0 === this.lrSi0 && si1 === this.lrSi1 &&
        sj0 === this.lrSj0 && sj1 === this.lrSj1 &&
        bi0 === this.lrBi0 && bi1 === this.lrBi1 &&
        bj0 === this.lrBj0 && bj1 === this.lrBj1 &&
        vi0 === this.lrVi0 && vi1 === this.lrVi1 &&
        vj0 === this.lrVj0 && vj1 === this.lrVj1) {
      return this.lastRegion;
    }
    const key = [
      si0, si1, sj0, sj1,
      bi0, bi1, bj0, bj1,
      vi0, vi1, vj0, vj1,
    ].join(',');
    const region = this.regionCache.get(key) ??
      this.collectRegion(x, x, z, z);
    if (!this.regionCache.has(key)) {
      setBounded(this.regionCache, key, region, REGION_CACHE_LIMIT);
    }
    this.lastRegion = region;
    this.lrSi0 = si0; this.lrSi1 = si1;
    this.lrSj0 = sj0; this.lrSj1 = sj1;
    this.lrBi0 = bi0; this.lrBi1 = bi1;
    this.lrBj0 = bj0; this.lrBj1 = bj1;
    this.lrVi0 = vi0; this.lrVi1 = vi1;
    this.lrVj0 = vj0; this.lrVj1 = vj1;
    return region;
  }

  // ---- The field ---------------------------------------------------------

  /**
   * Canonical field given precomputed column data + region. d > 0 is air.
   * Client prediction, server physics, and traces evaluate this exact
   * topology. Terrain/structures are meshed, while deterministic vegetation
   * transforms render matching analytic stems plus cosmetic canopies.
   */
  sdfCol(x: number, y: number, z: number, col: ColumnData, region: Region): number {
    let d = this.terrainSdfCol(x, y, z, col);

    const bs = region.boulders;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      const bd = sdBoulder(x, y, z, b);
      if (bd < d) d = bd;
    }
    const ps = region.pads;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      d = smin(d, sdBox(x, y, z, p.x, p.y, p.z, p.hx, p.hy, p.hz), PAD_SMOOTH);
    }
    // The exact plinth owns its engineered floor. Smooth terrain unions
    // can otherwise bulge a few centimetres above it between site probes,
    // producing both flickering floor faces and invisible movement bumps.
    // Underground platforms flatten only their floor band, never the roof.
    for (const f of region.foundations ?? []) {
      const top = f.y + f.hy;
      if (Math.abs(x - f.x) <= f.hx && Math.abs(z - f.z) <= f.hz &&
          y >= f.y - f.hy && (!f.underground || y <= top + 0.6)) {
        d = Math.max(d, y - top);
      }
    }
    d = solidBoxDistance(region.solids, x, y, z, d);
    if (region.transportBridges) d = region.transportBridges.distance(x, y, z, d);
    if (region.capitalArea) {
      // Cap marching at the spatial-index apron; omitted remote towers can
      // never be jumped over by a long ray step through high empty sky.
      d = capitalDistance(region.capitalSegments!, x, y, z, d);
    }
    const cs = region.cuts;
    for (let i = 0; i < cs.length; i++) {
      const b = cs[i];
      const cd = -sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz);
      if (cd > d) d = cd;
    }
    const vegetation = region.vegetation;
    for (let i = 0; i < vegetation.length; i++) {
      const plant = vegetation[i];
      const stem = sdCylinderY(
        x, y, z,
        plant.x, plant.y + plant.height * 0.5, plant.z,
        plant.radius, plant.height * 0.5,
      );
      if (stem < d) d = stem;
    }

    const border = WORLD.BORDER - Math.max(Math.abs(x), Math.abs(z));
    if (border < d) d = border;
    // Capsule broad-phase probes use sdfCol directly. They must see the same
    // moving deck/wall union as ordinary sdf and its contact/gradient probes.
    // Terrain workers leave motionTime unset and continue meshing static land.
    d = this.outposts.distance(x, y, z, d);
    return this.motionTime === undefined ? d : transitDistance(this, this.motionTime, x, y, z, d);
  }

  sdf(x: number, y: number, z: number): number {
    return this.staticSdf(x, y, z);
  }

  private staticSdf(x: number, y: number, z: number): number {
    // Within a fully graded city, near-surface terrain is an exact plane.
    // The abyss, station clearings, cave approaches, outskirts and deep rock
    // keep their canonical columns. Props, cuts, camps and moving transport
    // always pass through the complete field below.
    if (!this.flatCityColumns) {
      this.flatCityColumns = this.collectCities().filter(c => c.theme !== 'vesper').map(city => ({
        h: city.y, city, temp: 0, moist: 0, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000,
      }));
    }
    for (const flat of this.flatCityColumns) {
      if (y < flat.h - CAVE_MIN_ROOF) continue;
      const city = flat.city!, dx = x - city.x, dz = z - city.z;
      if (city.theme) {
        const distance2 = dx * dx + dz * dz, radius2 = city.radius * city.radius;
        if (distance2 > radius2 * 1.03 * 1.03 ||
            distance2 > radius2 * .85 * .85 && capitalBoundary(city, x, z) > 0) continue;
      } else if (Math.max(Math.abs(dx), Math.abs(dz)) > city.radius) continue;
      if (transportGroundAt(this.collectTransportPlan(), x, z, flat.h) ||
          this.caveFor(Math.floor(x / CAVE_CELL), Math.floor(z / CAVE_CELL))) break;
      return this.sdfCol(x, y, z, flat, this.regionAt(x, z));
    }
    let column = this.sdfColumnRows.get(x)?.get(z);
    if (!column) {
      column = this.column(x, z);
      const cursor = this.sdfColumnCursor;
      if (this.sdfColumnCount === 512) {
        const oldX = this.sdfColumnXs[cursor], row = this.sdfColumnRows.get(oldX)!;
        row.delete(this.sdfColumnZs[cursor]);
        if (row.size === 0) this.sdfColumnRows.delete(oldX);
      } else this.sdfColumnCount++;
      let row = this.sdfColumnRows.get(x);
      if (!row) this.sdfColumnRows.set(x, row = new Map());
      row.set(z, column);
      this.sdfColumnXs[cursor] = x; this.sdfColumnZs[cursor] = z;
      this.sdfColumnCursor = (cursor + 1) & 511;
    }
    return this.sdfCol(x, y, z, column, this.regionAt(x, z));
  }

  /** Outward (into-air) surface normal via central differences. */
  gradient(x: number, y: number, z: number, out: { x: number; y: number; z: number }): void {
    const e = 0.12;
    const dx = this.sdf(x + e, y, z) - this.sdf(x - e, y, z);
    const dy = this.sdf(x, y + e, z) - this.sdf(x, y - e, z);
    const dz = this.sdf(x, y, z + e) - this.sdf(x, y, z - e);
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) {
      out.x = 0; out.y = 1; out.z = 0;
    } else {
      out.x = dx / len; out.y = dy / len; out.z = dz / len;
    }
  }

  /**
   * Conservatively march a ray against the implicit field. A hit always
   * requires a real air-to-solid sign bracket; a small positive local minimum
   * is not a surface.
   */
  trace(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number): TraceHit {
    const out: TraceHit = { hit: false, dist: maxDist, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
    let t = 0;
    let d = this.sdf(ox, oy, oz);
    if (d <= 0) {
      out.hit = true; out.dist = 0;
      out.x = ox; out.y = oy; out.z = oz;
      const g = { x: 0, y: 0, z: 0 };
      this.gradient(ox, oy, oz, g);
      out.nx = g.x; out.ny = g.y; out.nz = g.z;
      return out;
    }

    // A ray nearly parallel to a real surface can remain close to it for a
    // long distance (the vertical ray down a narrow entrance shaft is the
    // important example). A fixed 320-iteration budget used to expire after
    // only 11.2m at the minimum step and made groundY return its sentinel in
    // canonical air. Size the safety budget from the requested travel range;
    // ordinary sphere-marched rays still exit in a handful of iterations.
    const maxIters = Math.ceil(maxDist / TRACE_MIN_STEP) + 2;
    for (let i = 0; i < maxIters && t < maxDist; i++) {
      // A small positive value is not a hit: non-distance fields can have a
      // positive local minimum. Advance until an actual outside->solid sign
      // bracket exists, then preserve its solid endpoint while bisecting.
      const step = Math.max(d * TRACE_FIELD_SCALE, TRACE_MIN_STEP);
      const nextT = Math.min(maxDist, t + step);
      const nd = this.sdf(
        ox + dx * nextT,
        oy + dy * nextT,
        oz + dz * nextT,
      );
      if (nd <= 0) {
        let lo = t;      // known air
        let hi = nextT;  // known solid
        for (let k = 0; k < 12; k++) {
          const mid = (lo + hi) * 0.5;
          if (this.sdf(ox + dx * mid, oy + dy * mid, oz + dz * mid) > 0) lo = mid;
          else hi = mid;
        }
        const ht = hi; // retain the non-positive side of the bracket
        out.hit = true;
        out.dist = ht;
        out.x = ox + dx * ht; out.y = oy + dy * ht; out.z = oz + dz * ht;
        const g = { x: 0, y: 0, z: 0 };
        this.gradient(out.x, out.y, out.z, g);
        out.nx = g.x; out.ny = g.y; out.nz = g.z;
        return out;
      }
      if (nextT >= maxDist) break;
      t = nextT;
      d = nd;
    }
    return out;
  }

  /** First surface straight down from the sky. */
  groundY(x: number, z: number): number {
    const top = this.landscape.cityAt(x, z)?.theme ? CAPITAL_SKY_HEIGHT : WORLD.MAX_HEIGHT - 1;
    const hit = this.trace(x, top, z, 0, -1, 0, top - WORLD.KILL_Y + 10);
    return hit.hit ? hit.y : 0;
  }

  /** Full spawn-safety check for one column; shared by both spawn searches. */
  private spawnCandidate(
    x: number,
    z: number,
  ): { x: number; y: number; z: number } | null {
    if (
      Math.max(Math.abs(x), Math.abs(z)) > WORLD.BORDER - STRUCT_MARGIN
    ) return null;
    const col = this.column(x, z);
    if (col.entr > CAVE_ENTRANCE_THRESHOLD - 0.04) return null;
    // Never spawn in the volcanic province: a perfectly flat lava pool
    // would otherwise pass every geometric check below.
    if (col.volc > 0.35 || col.lavaY > -999) return null;
    const gy = this.terrainGroundY(x, z);
    if (
      gy === null ||
      gy < -30 ||
      gy > 95 ||
      Math.abs(gy - col.h) > 0.8 ||
      this.terrainNormalY(x, gy, z) < 0.62
    ) return null;

    const feetY = gy + 0.12;
    for (const offset of SPAWN_AXIS_OFFSETS) {
      const cy = feetY + offset;
      if (this.sdf(x, cy, z) <= 0.025) return null;
      for (const direction of SPAWN_PROBE_DIRS) {
        if (this.sdf(
          x + direction[0] * PLAYER.RADIUS,
          cy + direction[1] * PLAYER.RADIUS,
          z + direction[2] * PLAYER.RADIUS,
        ) <= 0.025) {
          return null;
        }
      }
    }
    return { x, y: feetY, z };
  }

  /**
   * A safe spawn in an annulus around an arbitrary anchor (the server uses
   * a random living player, so action follows the population instead of a
   * fixed origin). Returns null when the neighborhood offers no safe
   * ground within the attempt budget - cliffs, caves, or the border.
   */
  findSpawnNear(
    anchorX: number,
    anchorZ: number,
    rand: () => number,
    minRadius = 60,
    maxRadius = 120,
  ): { x: number; y: number; z: number } | null {
    for (let i = 0; i < 40; i++) {
      const angle = rand() * TAU;
      // sqrt keeps the density uniform over the annulus area.
      const t = Math.sqrt(rand());
      const radius = minRadius + (maxRadius - minRadius) * t;
      const spawn = this.spawnCandidate(
        anchorX + Math.cos(angle) * radius,
        anchorZ + Math.sin(angle) * radius,
      );
      if (spawn) return spawn;
    }
    return null;
  }

  /** A safe spawn point near the world origin. `rand` in [0,1). */
  findSpawn(rand: () => number): { x: number; y: number; z: number } {
    const candidate = (x: number, z: number) => this.spawnCandidate(x, z);

    for (let i = 0; i < 64; i++) {
      const ang = rand() * TAU;
      const r = Math.sqrt(rand()) * WORLD.SPAWN_RADIUS;
      const spawn = candidate(Math.cos(ang) * r, Math.sin(ang) * r);
      if (spawn) return spawn;
    }
    // A deterministic fallback avoids ever returning a blocked origin after
    // an adversarial random stream or unusually dense generated site.
    for (let ring = 0; ring <= WORLD.SPAWN_RADIUS; ring += 24) {
      const count = Math.max(1, Math.ceil((TAU * Math.max(ring, 1)) / 24));
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * TAU;
        const spawn = candidate(
          Math.cos(angle) * ring,
          Math.sin(angle) * ring,
        );
        if (spawn) return spawn;
      }
    }
    return { x: 0, y: this.groundY(0, 0) + 0.5, z: 0 };
  }

  // ---- Materials / colors (used by the client mesher) --------------------

  material(x: number, y: number, z: number, col: ColumnData, normalY: number, region: Region, classifyRoads = true): MatId {
    for (const b of region.solids) {
      if (sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz) < 0.35) return MAT.CONCRETE;
    }
    for (const p of region.pads) {
      if (sdBox(x, y, z, p.x, p.y, p.z, p.hx, p.hy, p.hz) < 0.35) return MAT.CONCRETE;
    }
    for (const b of region.boulders) {
      if (sdBoulder(x, y, z, b) < 0.3) {
        // Volcanic provinces get black boulders, not pale granite litter.
        return col.volc > 0.4 ? MAT.BASALT : MAT.ROCK;
      }
    }
    if (y < col.h - 2.6) return MAT.CAVE;
    if (col.city?.theme) return col.city.theme === 'vesper' ? MAT.BASALT : MAT.CONCRETE;
    // Lava pools: the flooded surface itself. The band test (not one-sided)
    // matters because bilinear column interpolation at pool shores mixes the
    // -1000 sentinel into meaningless values that must never read as lava.
    if (col.lavaY > -999 && Math.abs(y - col.lavaY) < 1.5) return MAT.LAVA;
    // Footsteps still identify roads, but renderers paint them continuously
    // in world space. Their underlying triangles must retain the local biome
    // (especially basalt), including while the road texture is streaming.
    if (classifyRoads) {
      const road = col.road ?? this.landscape.roadAt(x, z);
      if (road && road.distance < road.width + 0.5 && Math.abs(y - road.height) < 1.8) return MAT.ROAD;
    }
    // Volcanic surfaces are ash-black basalt all the way up: no snowcaps,
    // no sand, no grass in the burned province.
    if (col.volc > 0.4) return MAT.BASALT;
    if ((col.rainforest ?? 0) > .35) return normalY < .55 ? MAT.ROCK : normalY < .78 ? MAT.DIRT : MAT.GRASS;
    const tAdj = col.temp - Math.max(0, y) * 0.005;
    if (tAdj < 0.34) return MAT.SNOW;
    if (col.desert > 0.5) return MAT.SAND;
    if (normalY < 0.55) return MAT.ROCK;
    if (normalY < 0.78) return MAT.DIRT;
    if (y > 78) return MAT.ROCK;
    return MAT.GRASS;
  }

  /** Write an RGB color (0..1) for a surface point into out[o..o+2]. */
  vertexColor(
    mat: MatId, x: number, y: number, z: number, col: ColumnData,
    out: { [i: number]: number }, o: number, normalY = 1, paintRoads = true,
  ): void {
    let r: number, g: number, b: number;
    switch (mat) {
      case MAT.GRASS: {
        const m = clamp(col.moist, 0, 1);
        r = lerp(0.50, 0.27, m); g = lerp(0.54, 0.50, m); b = lerp(0.26, 0.21, m);
        break;
      }
      case MAT.DIRT: r = 0.46; g = 0.36; b = 0.25; break;
      case MAT.ROCK: r = 0.50; g = 0.50; b = 0.53; break;
      case MAT.SAND: r = 0.82; g = 0.72; b = 0.50; break;
      case MAT.SNOW: r = 0.90; g = 0.92; b = 0.96; break;
      case MAT.CONCRETE: r = 0.60; g = 0.61; b = 0.64; break;
      case MAT.BASALT: r = 0.11; g = 0.095; b = 0.105; break;
      case MAT.LAVA: r = 1.0; g = 0.42; b = 0.06; break;
      case MAT.ROAD: {
        // Begin from the local biome; the continuous shoulder blend below
        // avoids a binary dark triangle edge at the lane material boundary.
        if (col.temp - Math.max(0, y) * 0.005 < 0.34) { r = 0.90; g = 0.92; b = 0.96; }
        else if (col.desert > 0.5) { r = 0.82; g = 0.72; b = 0.50; }
        else if (y > 78) { r = 0.50; g = 0.50; b = 0.53; }
        else { r = lerp(0.50, 0.27, col.moist); g = lerp(0.54, 0.50, col.moist); b = lerp(0.26, 0.21, col.moist); }
        break;
      }
      default: { // Geological provinces retain readable mineral strata at depth.
        caveBiomeColor(this.seed, x, z, out, o);
        const depth = clamp((col.h - y) * 0.018, 0, 0.48);
        const strata = 0.92 + Math.sin(y * 0.73 + x * 0.018 + z * 0.012) * 0.08;
        const f = (1 - depth) * strata;
        r = out[o] * f; g = out[o + 1] * f; b = out[o + 2] * f;
        break;
      }
    }
    // Natural provinces blend continuously; material labels remain useful for
    // footsteps without drawing a hard snow/desert/altitude contour on land.
    if (mat === MAT.GRASS || mat === MAT.DIRT || mat === MAT.ROCK || mat === MAT.SAND || mat === MAT.SNOW || mat === MAT.ROAD) {
      const moisture = clamp(col.moist, 0, 1);
      r = lerp(.50, .27, moisture); g = lerp(.54, .50, moisture); b = lerp(.26, .21, moisture);
      const soil = 1 - smoothstep(.60, .85, normalY);
      r = lerp(r, .46, soil); g = lerp(g, .36, soil); b = lerp(b, .25, soil);
      const stone = Math.max(1 - smoothstep(.42, .62, normalY), smoothstep(68, 105, y) * (1 - (col.rainforest ?? 0)));
      r = lerp(r, .50, stone); g = lerp(g, .50, stone); b = lerp(b, .53, stone);
      const sand = smoothstep(.32, .68, col.desert);
      r = lerp(r, .82, sand); g = lerp(g, .72, sand); b = lerp(b, .50, sand);
      const snow = (1 - smoothstep(.26, .43, col.temp - Math.max(0, y) * .005)) * smoothstep(.3, .65, normalY);
      r = lerp(r, .90, snow); g = lerp(g, .92, snow); b = lerp(b, .96, snow);
    }
    if (col.city && Math.abs(y - col.city.y) < 1.5) {
      const road = col.road;
      const lane = road ? smoothstep(road.width + .8, road.width - .3, road.distance) : 0;
      r = lerp(.57, .20, lane); g = lerp(.58, .23, lane); b = lerp(.56, .25, lane);
    }
    if (col.city?.theme === 'vesper') {
      const depth = smoothstep(col.city.y - 20, -55, y);
      r = lerp(.14, .025, depth); g = lerp(.19, .07, depth); b = lerp(.20, .065, depth);
    } else if (col.city?.theme === 'aurelia') {
      const axis = Math.min(Math.abs(x - col.city.x), Math.abs(z - col.city.z));
      const avenue = smoothstep(48, 40, axis);
      r = lerp(.46, .23, avenue); g = lerp(.43, .24, avenue); b = lerp(.36, .23, avenue);
    } else if ((col.rainforest ?? 0) > 0 && mat !== MAT.CAVE && mat !== MAT.CONCRETE) {
      const forest = col.rainforest!;
      r = lerp(r, .20, forest * .6); g = lerp(g, .31, forest * .5); b = lerp(b, .13, forest * .5);
    }
    if (paintRoads && !col.city && mat !== MAT.CONCRETE && mat !== MAT.CAVE && mat !== MAT.LAVA && mat !== MAT.BASALT) {
      const road = col.road ?? this.landscape.roadAt(x, z);
      if (road) {
        const gravel = smoothstep(road.width + 3.5, road.width - 1.5, road.distance) *
          smoothstep(4, 1, Math.abs(y - road.height));
        const warm = col.desert > 0.5;
        const rr = road.trail ? 0.49 : warm ? 0.52 : 0.39;
        const rg = road.trail ? 0.37 : warm ? 0.43 : 0.37;
        const rb = road.trail ? 0.24 : warm ? 0.30 : 0.33;
        r = lerp(r, rr, gravel); g = lerp(g, rg, gravel); b = lerp(b, rb, gravel);
      }
    }
    const j = 1 + (unit(hash3i(this.seed ^ 0x5eed, Math.floor(x * 2), Math.floor(y * 2), Math.floor(z * 2))) - 0.5) * 0.12;
    out[o] = clamp(r * j, 0, 1);
    out[o + 1] = clamp(g * j, 0, 1);
    out[o + 2] = clamp(b * j, 0, 1);
  }
}
