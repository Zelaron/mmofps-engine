import { clamp, lerp, smoothstep, hypot2 } from './math.js';
import { hash2i, unit } from './rng.js';
import { generateCities, type CityDistrict } from './cities.js';
import { capitalBoundary } from './capital-geometry.js';
import { gradeLiquidTerrain, liquidFootprint, surfaceLiquidVolumes, canReachCoast, mainCoastDistance, originalCoastDistance, ISLAND_SHORE_START } from './liquids.js';
import { detourRoad } from './road-routing.js';

export const LANDSCAPE_CELL = 1024;
const ROAD_TILE = 128;
export interface MountainSite {
  x: number; z: number; dx: number; dz: number;
  length: number; width: number; height: number; style: number; seed: number;
  ix: number; iz: number;
  dramatic?: boolean;
}
export interface RoadPoint { x: number; y: number; z: number }
export interface RoadSegment {
  a: RoadPoint; b: RoadPoint;
  /** Road lane half width; broad graded shoulders surround it. */
  width: number;
  trail: boolean;
  dramatic?: boolean;
  id: string;
}
/** The routed road network (edges and summit trails) as compact polylines.
 * Route searches are deterministic per seed, so a worker can compute the
 * whole island and hand it to other World instances of the same seed; they
 * decode each link on first use instead of re-running its route search.
 * Coordinates are float64, so adopted links are bit-identical. */
export interface RoadNetworkSnapshot {
  version: 1;
  seed: number;
  /** `e:<ix>,<iz>,<axis>` for trunk links, `t:<ix>,<iz>` for summit trails. */
  keys: string[];
  /** Point ranges per key (points, not coordinates); length keys.length + 1. */
  offsets: Uint32Array;
  /** x, y, z per point. A link with fewer than two points has no road. */
  points: Float64Array;
  /** Per key: bit 0 dramatic trail. */
  flags: Uint8Array;
}

export interface RoadSample {
  distance: number; height: number; width: number; trail: boolean;
  dx: number; dz: number;
  gradeWeight: number;
}

/** Constant work shared by every terrain sample in a road tile. */
interface RoadTileSegment {
  readonly segment: RoadSegment;
  readonly dx: number; readonly dz: number;
  readonly length2: number; readonly length: number;
  readonly chordWeight: number;
  readonly minX: number; readonly maxX: number;
  readonly minZ: number; readonly maxZ: number;
}
interface RoadTile {
  segments: readonly RoadTileSegment[];
  cells: Map<number, readonly RoadTileSegment[]>;
}

function prepareRoadSegment(segment: RoadSegment): RoadTileSegment {
  const dx = segment.b.x - segment.a.x, dz = segment.b.z - segment.a.z;
  const length2 = dx * dx + dz * dz;
  const reach = segment.dramatic ? 180 : 90;
  // Keep the broad phase conservative even when endpoint interpolation
  // rounds past an endpoint by a few ulps. The exact distance check below
  // still decides the original 90/180m cutoff, including its boundary.
  const padding = Number.EPSILON * 8 * (Math.abs(segment.a.x) + Math.abs(segment.b.x) +
    Math.abs(segment.a.z) + Math.abs(segment.b.z) + reach);
  const extent = length2 > 0 ? reach + padding : Infinity;
  const length = Math.sqrt(length2);
  return { segment, dx, dz, length2, length, chordWeight: Math.min(1, length / 24),
    minX: Math.min(segment.a.x, segment.b.x) - extent,
    maxX: Math.max(segment.a.x, segment.b.x) + extent,
    minZ: Math.min(segment.a.z, segment.b.z) - extent,
    maxZ: Math.max(segment.a.z, segment.b.z) + extent };
}

interface LandscapeColumn { h: number; volc: number; lavaBasin?: { level: number; channel: number } }

/** Round hairpins with short quadratic chords while preserving both ends. */
export function roundedRoadPoints(points: RoadPoint[], radius: number): RoadPoint[] {
  const result = [points[0]];
  const mix = (a: RoadPoint, b: RoadPoint, t: number): RoadPoint => ({ x: lerp(a.x,b.x,t), y: lerp(a.y,b.y,t), z: lerp(a.z,b.z,t) });
  for (let i = 1; i + 1 < points.length; i++) {
    const a=points[i-1], b=points[i], c=points[i+1];
    const ab=Math.hypot(b.x-a.x,b.z-a.z), bc=Math.hypot(c.x-b.x,c.z-b.z);
    const reach=Math.min(radius,ab*.3,bc*.3), entry=mix(b,a,reach/ab), exit=mix(b,c,reach/bc);
    result.push(entry);
    for(let j=1;j<=10;j++) { const t=j/10; result.push(mix(mix(entry,b,t),mix(b,exit,t),t)); }
  }
  result.push(points[points.length-1]); return result;
}

function cacheSet<T>(cache: Map<string, T>, key: string, value: T): T {
  if (!cache.has(key) && cache.size >= 16384) cache.delete(cache.keys().next().value!);
  cache.set(key, value);
  return value;
}

/** Compact deterministic ridges and a connected graded road/switchback network. */
export class Landscape {
  private mountains = new Map<string, MountainSite>();
  private nodes = new Map<string, RoadPoint>();
  /** Junction keys in the reshaped coast's new water. */
  private seaNodes = new Set<string>();
  private edges = new Map<string, RoadSegment[]>();
  private trails = new Map<string, RoadSegment[]>();
  private tiles = new Map<string, RoadTile>();
  private lastRoadTile: { x: number; z: number; tile: RoadTile } | undefined;
  private cityList: CityDistrict[] | null = null;
  private cityRoads: RoadSegment[] | null = null;
  private network: { snapshot: RoadNetworkSnapshot; index: Map<string, number> } | null = null;
  private highlights: Set<string> | null = null;
  constructor(readonly seed: number, private naturalHeight: (x: number, z: number) => number,
    private base: (x: number, z: number) => LandscapeColumn) {}

  /** Keep the lane and a dry verge outside both flooded basins and cuts that
   * would expose lava. Heights refer to the planned road, not just the hill. */
  private roadClear(x: number, z: number, y: number, margin = 18, avoidBasins = true, summitTrail = false): boolean {
    for (const [dx, dz] of [[0, 0], [-margin, 0], [margin, 0], [0, -margin], [0, margin]]) {
      // Roads stay out of the bays and rounded corners the coast now gives
      // to the sea; elsewhere the network is as it always was.
      if (this.newlyFlooded(x + dx, z + dz)) return false;
      // Inland lake/river excavation also runs after roads. Keep ordinary
      // roads outside its graded bank; ferries have their own dock approaches.
      for (const volume of surfaceLiquidVolumes()) {
        if (volume.shape === 'ocean' || Math.abs(x + dx - volume.x) > volume.rx + 180 ||
          Math.abs(z + dz - volume.z) > volume.rz + 180) continue;
        if (liquidFootprint(volume, this.seed, x + dx, z + dz).distance < 150) return false;
      }
      const col = this.base(x + dx, z + dz), basin = col.lavaBasin;
      if (basin && basin.channel > .18 &&
        gradeLiquidTerrain(this.seed, x + dx, z + dz, avoidBasins ? Math.min(col.h, y) : y) < basin.level + 12) return false;
      // Trunk detours must go around dramatic peaks. Cutting straight across
      // their switchbacks can exceed the collision field's slope envelope.
      if (!summitTrail && this.mountain(Math.floor((x + dx) / LANDSCAPE_CELL), Math.floor((z + dz) / LANDSCAPE_CELL)).dramatic &&
        Math.abs(this.naturalHeight(x + dx, z + dz) - y) > 40) return false;
    }
    return true;
  }

  /** In a bay or rounded corner the reshaped coast gave to the sea. */
  private newlyFlooded(x: number, z: number): boolean {
    if (!canReachCoast(x, z)) return false;
    const shore = mainCoastDistance(this.seed, x, z);
    return shore > ISLAND_SHORE_START && shore - originalCoastDistance(this.seed, x, z) > 30;
  }

  private dryRoute(points: RoadPoint[], avoidBasins = true, summitTrail = false): boolean {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 12));
      for (let j = 0; j <= steps; j++) {
        const t = j / steps;
        if (!this.roadClear(lerp(a.x, b.x, t), lerp(a.z, b.z, t), lerp(a.y, b.y, t), 18, avoidBasins, summitTrail)) return false;
      }
    }
    return true;
  }

  cities(): readonly CityDistrict[] {
    return this.cityList ??= generateCities(this.seed, this.naturalHeight, (x, z) => this.base(x, z).volc < .2);
  }
  cityAt(x: number, z: number, margin = 0): CityDistrict | undefined {
    for (const city of this.cities()) {
      // Every authored outline lies between .85r and 1.03r. Most terrain
      // probes are nowhere near a city; only the narrow edge band needs its
      // trigonometric boundary. Padding leaves all numerical ties to it.
      const dx=x-city.x,dz=z-city.z;
      if(!city.theme){if(Math.max(Math.abs(dx),Math.abs(dz))-city.radius<=margin)return city;continue;}
      const epsilon=Number.EPSILON*16*Math.max(1,Math.abs(x),Math.abs(z),city.radius),outer=city.radius*1.03+margin+epsilon;
      if(outer<0||Math.abs(dx)>outer||Math.abs(dz)>outer)continue;
      const distance2=dx*dx+dz*dz;if(distance2>outer*outer)continue;
      const inner=city.radius*.85+margin-epsilon;
      if(inner>=0&&distance2<inner*inner||capitalBoundary(city,x,z)<=margin)return city;
    }
    return undefined;
  }
  private highMountainCells(): Set<string> {
    if (this.highlights) return this.highlights;
    const cells = new Set<string>();
    for (const [gx, gz] of [[-2, -2], [1, 2], [-5, 3], [4, -5]]) {
      let chosen = `${gx},${gz}`, score = Infinity;
      for (let i = 0; i < 9; i++) {
        const x = gx + i % 3, z = gz + Math.floor(i / 3);
        const sample = this.base((x + .5) * 1024, (z + .5) * 1024);
        const rank = sample.volc * 100 + unit(hash2i(this.seed ^ 0x6729, x, z));
        if (rank < score) { chosen = `${x},${z}`; score = rank; }
      }
      cells.add(chosen);
    }
    return this.highlights = cells;
  }

  mountain(ix: number, iz: number): MountainSite {
    const key = `${ix},${iz}`, cached = this.mountains.get(key);
    if (cached) return cached;
    const seed = hash2i(this.seed ^ 0x47a81e, ix, iz);
    const random = (salt: number) => unit(hash2i(seed, salt, 0));
    const rotated = random(19) > 0.5;
    const x = (ix + .5) * LANDSCAPE_CELL + (random(3) - .5) * 24;
    const z = (iz + .5) * LANDSCAPE_CELL + (random(5) - .5) * 24;
    const dramatic = this.highMountainCells().has(key);
    return cacheSet(this.mountains, key, {
      x, z,
      dx: rotated ? 0 : 1, dz: rotated ? 1 : 0,
      length: 425 + random(7) * 40, width: 300 + random(11) * 45,
      height: dramatic ? 258 + random(13) * 12 - this.base(x, z).h : 105 + random(13) * 60,
      style: Math.floor(random(17) * 3), seed, ix, iz, dramatic,
    });
  }

  uplift(x: number, z: number): number {
    const s = this.mountain(Math.floor(x / LANDSCAPE_CELL), Math.floor(z / LANDSCAPE_CELL));
    const rx = x - s.x, rz = z - s.z;
    const u = rx * s.dx + rz * s.dz, v = -rx * s.dz + rz * s.dx;
    // Unequal planar shoulders create long ridgelines, crags, and rock faces.
    const radial = Math.max(Math.abs(u) / s.length, Math.abs(v) / s.width,
      Math.abs(u * 0.54 + v * 0.46) / (s.length * 0.76));
    const mass = Math.max(0, 1 - radial);
    if (mass <= 0) return 0;
    if (s.dramatic) {
      // A few sheer rock bands and a narrow upper ridge make true landmarks.
      // The rest of the map retains the original gentler rolling massifs.
      const shape = mass * .52 + Math.pow(mass, 1.8) * .20 + smoothstep(.22, .46, mass) * .28;
      return shape * s.height;
    }
    const tierCount = s.style === 2 ? 3 : 5;
    const tiers = mass * tierCount, tier = Math.floor(tiers);
    const stepped = (tier + smoothstep(0.23, 0.77, tiers - tier)) / tierCount;
    const shape = lerp(mass, stepped, s.style === 1 ? 0.24 : 0.48);
    return shape * s.height;
  }

  private node(ix: number, iz: number): RoadPoint {
    const key = `${ix},${iz}`, found = this.nodes.get(key);
    if (found) return found;
    const s = this.seed ^ 0x4481acc;
    let x = ix * LANDSCAPE_CELL + (unit(hash2i(s, ix, iz)) - 0.5) * 54;
    let z = iz * LANDSCAPE_CELL + (unit(hash2i(s + 7, ix, iz)) - 0.5) * 54;
    // A junction the reshaped coast put in the sea gets no roads at all; a
    // relocation search there would only probe more open water.
    if (this.newlyFlooded(x, z)) { this.seaNodes.add(key); return cacheSet(this.nodes, key, { x, z, y: 0 }); }
    let y = this.naturalHeight(x, z);
    if (!this.roadClear(x, z, y, 40)) {
      // Relocate the shared junction once, so every connecting road agrees.
      search: for (let radius = 32; radius <= 512; radius += 32) {
        for (let i = 0; i < 16; i++) {
          const angle = i * Math.PI / 8, nx = x + Math.cos(angle) * radius, nz = z + Math.sin(angle) * radius;
          const ny = this.naturalHeight(nx, nz);
          if (this.roadClear(nx, nz, ny, 40)) { x = nx; z = nz; y = ny; break search; }
        }
      }
    }
    return cacheSet(this.nodes, key, { x, z, y });
  }

  /** Use a snapshot computed elsewhere (same seed) for links not yet cached. */
  adoptRoadNetwork(snapshot: RoadNetworkSnapshot): boolean {
    if (snapshot?.version !== 1 || snapshot.seed !== this.seed || snapshot.offsets.length !== snapshot.keys.length + 1) return false;
    const index = new Map<string, number>();
    for (let i = 0; i < snapshot.keys.length; i++) index.set(snapshot.keys[i], i);
    this.network = { snapshot, index };
    return true;
  }

  /** Every routed link and trail computed so far, as a transferable snapshot. */
  exportRoadNetwork(): RoadNetworkSnapshot {
    const keys: string[] = [], counts: number[] = [], flags: number[] = [];
    const lines: RoadPoint[][] = [];
    const add = (key: string, segments: readonly RoadSegment[]) => {
      const line = segments.length ? [segments[0].a, ...segments.map(segment => segment.b)] : [];
      keys.push(key); lines.push(line); counts.push(line.length); flags.push(segments[0]?.dramatic ? 1 : 0);
    };
    for (const [key, segments] of this.edges) add(`e:${key}`, segments);
    for (const [key, segments] of this.trails) add(`t:${key}`, segments);
    const offsets = new Uint32Array(keys.length + 1);
    for (let i = 0; i < counts.length; i++) offsets[i + 1] = offsets[i] + counts[i];
    const points = new Float64Array(offsets[keys.length] * 3);
    let j = 0;
    for (const line of lines) for (const p of line) { points[j++] = p.x; points[j++] = p.y; points[j++] = p.z; }
    return { version: 1, seed: this.seed, keys, offsets, points, flags: Uint8Array.from(flags) };
  }

  /** Decodes one adopted link exactly as `edge`/`trail` would have built it. */
  private adopted(key: string, id: string, width: number, trail: boolean): RoadSegment[] | undefined {
    const network = this.network, i = network?.index.get(key);
    if (!network || i === undefined) return undefined;
    const { offsets, points, flags } = network.snapshot, dramatic = (flags[i] & 1) !== 0;
    const line: RoadPoint[] = [];
    for (let p = offsets[i]; p < offsets[i + 1]; p++) line.push({ x: points[p * 3], y: points[p * 3 + 1], z: points[p * 3 + 2] });
    const segments: RoadSegment[] = [];
    for (let p = 0; p + 1 < line.length; p++) {
      segments.push(trail ? { a: line[p], b: line[p + 1], width, trail: true, dramatic, id }
        : { a: line[p], b: line[p + 1], width, trail: false, id });
    }
    return segments;
  }

  private edge(ix: number, iz: number, axis: number): RoadSegment[] {
    const key = `${ix},${iz},${axis}`, found = this.edges.get(key);
    if (found) return found;
    const adopted = this.adopted(`e:${key}`, key, 5.8, false);
    if (adopted) return cacheSet(this.edges, key, adopted);
    const a = this.node(ix, iz), b = this.node(ix + (axis === 0 ? 1 : 0), iz + (axis === 1 ? 1 : 0));
    if (this.seaNodes.has(`${ix},${iz}`) || this.seaNodes.has(`${ix + (axis === 0 ? 1 : 0)},${iz + (axis === 1 ? 1 : 0)}`))
      return cacheSet(this.edges, key, []);
    const bend = (unit(hash2i(this.seed ^ (axis ? 0x821af : 0x90aba), ix, iz)) - 0.5) * 130;
    const variation = unit(hash2i(this.seed ^ 0x639ba, ix + axis * 73, iz));
    const curve = (variation < .5 ? -1 : 1) * (55 + Math.abs(variation - .5) * 80);
    const curvePoints = (detour: number): RoadPoint[] => Array.from({ length: 33 }, (_, i) => {
      if (i === 0) return a;
      if (i === 32) return b;
      // Detours retain the same smooth approach and exact shared junctions.
      const t = i / 32, envelope = Math.sin(Math.PI * t) ** 2;
      const offset = (bend + detour + curve * Math.sin(Math.PI * 2 * t)) * envelope;
      return { x: lerp(a.x, b.x, t) + (axis === 1 ? offset : 0),
        z: lerp(a.z, b.z, t) + (axis === 0 ? offset : 0), y: lerp(a.y, b.y, t) };
    });
    let points = curvePoints(0);
    if (!this.dryRoute(points)) {
      for (const detour of [96, -96, 192, -192, 320, -320, 448, -448]) {
        const candidate = curvePoints(detour);
        if (this.dryRoute(candidate)) { points = candidate; break; }
      }
      if (!this.dryRoute(points)) {
        const detour = detourRoad(a, b, (p, q) => this.dryRoute([p, q]));
        if (detour) {
          const rounded = roundedRoadPoints(detour, 24);
          points = this.dryRoute(rounded) ? rounded : detour;
        }
      }
      // A high embankment is safe when its full verge clears the lava. If
      // neither banks nor an elevated route can connect these two junctions,
      // leave this link out; the surrounding grid supplies alternative links.
      if (!this.dryRoute(points, false)) {
        const detour = detourRoad(a, b, (p, q) => this.dryRoute([p, q], false));
        if (!detour) return cacheSet(this.edges, key, []);
        const rounded = roundedRoadPoints(detour, 24);
        points = this.dryRoute(rounded, false) ? rounded : detour;
      }
    }
    const segments: RoadSegment[] = [];
    for (let i = 1; i < points.length; i++) segments.push({ a: points[i - 1], b: points[i], width: 5.8, trail: false, id: key });
    return cacheSet(this.edges, key, segments);
  }

  private trail(ix: number, iz: number): RoadSegment[] {
    const key = `${ix},${iz}`, found = this.trails.get(key);
    if (found) return found;
    const adopted = this.adopted(`t:${key}`, `trail:${key}`, 2.7, true);
    if (adopted) return cacheSet(this.trails, key, adopted);
    const s = this.mountain(ix, iz);
    // These switchbacks climb the added mountain system, which fades out in
    // volcanic country. Do not draw a summit trail into a flooded crater.
    if (this.base(s.x, s.z).volc > .35) return cacheSet(this.trails, key, []);
    // Join an existing west/south trunk vertex at its exact elevation.
    // Detours may have a different number of chords from ordinary links.
    const edge = this.edge(ix, iz, s.dx === 1 ? 1 : 0);
    if (!edge.length) return cacheSet(this.trails, key, []);
    const points: RoadPoint[] = [edge[Math.max(0, Math.floor(edge.length / 2) - 1)].b];
    const steps = s.dramatic ? [[-.96, 0], [-.90, -.43], [-.81, .43], [-.72, -.39],
      [-.63, .35], [-.54, -.31], [-.45, .26], [-.36, -.21], [-.27, .16], [-.18, -.10], [-.09, .05], [0, 0]] : [[-0.94, 0], [-0.80, -0.40], [-0.65, 0.40],
      [-0.50, -0.31], [-0.35, 0.24], [-0.20, -0.13], [-0.08, 0.06], [0, 0]];
    for (const [along, side] of steps) {
      const u = along * s.length, v = side * s.width;
      const x = s.x + s.dx * u - s.dz * v;
      const z = s.z + s.dz * u + s.dx * v;
      points.push({ x, z, y: this.naturalHeight(x, z) });
    }
    const segments: RoadSegment[] = [];
    const rounded = roundedRoadPoints(points, s.dramatic ? 14 : 18);
    if (!this.dryRoute(rounded, true, true)) return cacheSet(this.trails, key, []);
    for (let i = 0; i + 1 < rounded.length; i++) {
      segments.push({ a: rounded[i], b: rounded[i + 1], width: 2.7, trail: true, dramatic: s.dramatic, id: `trail:${key}` });
    }
    return cacheSet(this.trails, key, segments);
  }

  private urbanRoads(): RoadSegment[] {
    if (this.cityRoads) return this.cityRoads;
    const roads: RoadSegment[] = [];
    for (const city of this.cities()) {
      if (city.theme) continue;
      const point = (dx: number, dz: number): RoadPoint => ({ x: city.x + dx, y: city.y, z: city.z + dz });
      for (let lane = -city.radius; lane <= city.radius; lane += 64) {
        for (const axis of [0, 1]) roads.push({ a: point(axis ? lane : -city.radius, axis ? -city.radius : lane),
          b: point(axis ? lane : city.radius, axis ? city.radius : lane), width: lane === 0 ? 9 : 5.8, trail: false, id: `city:${city.id}` });
      }
      const ix = city.x / 1024, iz = city.z / 1024;
      const middle = (roads: RoadSegment[]): RoadPoint | undefined => roads[Math.max(0, Math.floor(roads.length / 2) - 1)]?.b;
      const ends = [middle(this.edge(ix - 1, iz, 0)), middle(this.edge(ix, iz, 0)),
        middle(this.edge(ix, iz - 1, 1)), middle(this.edge(ix, iz, 1))];
      const starts = [point(-city.radius, 0), point(city.radius, 0), point(0, -city.radius), point(0, city.radius)];
      for (let i = 0; i < 4; i++) if (ends[i]) roads.push({ a: starts[i], b: ends[i]!, width: 9, trail: false, id: `city-access:${city.id}` });
    }
    return this.cityRoads = roads;
  }

  collectMountains(minX: number, maxX: number, minZ: number, maxZ: number): MountainSite[] {
    const out: MountainSite[] = [];
    for (let iz = Math.floor(minZ / LANDSCAPE_CELL); iz <= Math.floor(maxZ / LANDSCAPE_CELL); iz++) {
      for (let ix = Math.floor(minX / LANDSCAPE_CELL); ix <= Math.floor(maxX / LANDSCAPE_CELL); ix++) out.push(this.mountain(ix, iz));
    }
    return out;
  }

  collectRoads(minX: number, maxX: number, minZ: number, maxZ: number): RoadSegment[] {
    const out: RoadSegment[] = [];
    // Curves can bend across either side of a cell. Query both neighbors so
    // the terrain grade and road paint agree on every 128m cache boundary.
    for (let iz = Math.floor(minZ / LANDSCAPE_CELL) - 1; iz <= Math.floor(maxZ / LANDSCAPE_CELL) + 1; iz++) {
      for (let ix = Math.floor(minX / LANDSCAPE_CELL) - 1; ix <= Math.floor(maxX / LANDSCAPE_CELL) + 1; ix++) {
        for (const segment of [...this.edge(ix, iz, 0), ...this.edge(ix, iz, 1), ...this.trail(ix, iz)]) {
          const reach = segment.dramatic ? 180 : 96;
          if (Math.max(segment.a.x, segment.b.x) < minX - reach || Math.min(segment.a.x, segment.b.x) > maxX + reach ||
              Math.max(segment.a.z, segment.b.z) < minZ - reach || Math.min(segment.a.z, segment.b.z) > maxZ + reach) continue;
          if (this.cities().some(city => capitalBoundary(city, (segment.a.x + segment.b.x) / 2,
            (segment.a.z + segment.b.z) / 2) < (city.theme ? 100 : !segment.trail ? 106 : -10000))) continue;
          out.push(segment);
        }
      }
    }
    for (const segment of this.urbanRoads()) {
      if (Math.max(segment.a.x, segment.b.x) < minX - 96 || Math.min(segment.a.x, segment.b.x) > maxX + 96 ||
          Math.max(segment.a.z, segment.b.z) < minZ - 96 || Math.min(segment.a.z, segment.b.z) > maxZ + 96) continue;
      out.push(segment);
    }
    return out;
  }

  /** Exact full-road collection with checkpoints between canonical jobs.
   * Generate both edges and the trail before filtering, as collectRoads does.
   * A cold edge/trail remains indivisible; injected providers stay synchronous. */
  *collectRoadSteps(minX: number, maxX: number, minZ: number, maxZ: number): Generator<void, RoadSegment[], void> {
    if (this.collectRoads !== canonicalMapRoadCollector || this.trail !== canonicalMapTrailCollector ||
        this.edge !== canonicalMapEdgeCollector || this.urbanRoads !== canonicalMapUrbanCollector)
      return this.collectRoads(minX, maxX, minZ, maxZ);
    const out: RoadSegment[] = [];
    for (let iz = Math.floor(minZ / LANDSCAPE_CELL) - 1; iz <= Math.floor(maxZ / LANDSCAPE_CELL) + 1; iz++) {
      for (let ix = Math.floor(minX / LANDSCAPE_CELL) - 1; ix <= Math.floor(maxX / LANDSCAPE_CELL) + 1; ix++) {
        const along = this.edge(ix, iz, 0); yield;
        const across = this.edge(ix, iz, 1); yield;
        const trail = this.trail(ix, iz); yield;
        for (const segment of [...along, ...across, ...trail]) {
          const reach = segment.dramatic ? 180 : 96;
          if (Math.max(segment.a.x, segment.b.x) < minX - reach || Math.min(segment.a.x, segment.b.x) > maxX + reach ||
              Math.max(segment.a.z, segment.b.z) < minZ - reach || Math.min(segment.a.z, segment.b.z) > maxZ + reach) continue;
          if (this.cities().some(city => capitalBoundary(city, (segment.a.x + segment.b.x) / 2,
            (segment.a.z + segment.b.z) / 2) < (city.theme ? 100 : !segment.trail ? 106 : -10000))) continue;
          out.push(segment);
        }
      }
    }
    const urban = this.urbanRoads(); yield;
    for (const segment of urban) {
      if (Math.max(segment.a.x, segment.b.x) < minX - 96 || Math.min(segment.a.x, segment.b.x) > maxX + 96 ||
          Math.max(segment.a.z, segment.b.z) < minZ - 96 || Math.min(segment.a.z, segment.b.z) > maxZ + 96) continue;
      out.push(segment);
    }
    return out;
  }

  /** Tactical maps discard summit trails. Keep the canonical cell, edge and
   * city order without generating those unused switchbacks. The hot terrain
   * collector above remains unchanged; custom collectors retain its behavior. */
  collectMajorRoads(minX: number, maxX: number, minZ: number, maxZ: number): RoadSegment[] {
    if (this.collectRoads !== canonicalMapRoadCollector || this.trail !== canonicalMapTrailCollector)
      return this.collectRoads(minX, maxX, minZ, maxZ).filter(road => !road.trail);
    const out: RoadSegment[] = [];
    for (let iz = Math.floor(minZ / LANDSCAPE_CELL) - 1; iz <= Math.floor(maxZ / LANDSCAPE_CELL) + 1; iz++) {
      for (let ix = Math.floor(minX / LANDSCAPE_CELL) - 1; ix <= Math.floor(maxX / LANDSCAPE_CELL) + 1; ix++) {
        for (const segment of [...this.edge(ix, iz, 0), ...this.edge(ix, iz, 1)]) {
          const reach = segment.dramatic ? 180 : 96;
          if (Math.max(segment.a.x, segment.b.x) < minX - reach || Math.min(segment.a.x, segment.b.x) > maxX + reach ||
              Math.max(segment.a.z, segment.b.z) < minZ - reach || Math.min(segment.a.z, segment.b.z) > maxZ + reach) continue;
          if (this.cities().some(city => capitalBoundary(city, (segment.a.x + segment.b.x) / 2,
            (segment.a.z + segment.b.z) / 2) < (city.theme ? 100 : !segment.trail ? 106 : -10000))) continue;
          if (!segment.trail) out.push(segment);
        }
      }
    }
    for (const segment of this.urbanRoads()) {
      if (Math.max(segment.a.x, segment.b.x) < minX - 96 || Math.min(segment.a.x, segment.b.x) > maxX + 96 ||
          Math.max(segment.a.z, segment.b.z) < minZ - 96 || Math.min(segment.a.z, segment.b.z) > maxZ + 96) continue;
      if (!segment.trail) out.push(segment);
    }
    return out;
  }

  /** Worker-only checkpoints around complete canonical edge jobs. Keep both
   * edge calls ahead of filtering, and preserve cell/cache/urban-road order.
   * Cold nested route generation remains indivisible within one edge. */
  *collectMajorRoadSteps(minX: number, maxX: number, minZ: number, maxZ: number): Generator<void, RoadSegment[], void> {
    if (this.collectMajorRoads !== canonicalMapMajorCollector ||
        this.collectRoads !== canonicalMapRoadCollector || this.trail !== canonicalMapTrailCollector ||
        this.edge !== canonicalMapEdgeCollector || this.urbanRoads !== canonicalMapUrbanCollector)
      return this.collectMajorRoads(minX, maxX, minZ, maxZ);
    const out: RoadSegment[] = [];
    for (let iz = Math.floor(minZ / LANDSCAPE_CELL) - 1; iz <= Math.floor(maxZ / LANDSCAPE_CELL) + 1; iz++) {
      for (let ix = Math.floor(minX / LANDSCAPE_CELL) - 1; ix <= Math.floor(maxX / LANDSCAPE_CELL) + 1; ix++) {
        const along = this.edge(ix, iz, 0); yield;
        const across = this.edge(ix, iz, 1); yield;
        for (const segment of [...along, ...across]) {
          const reach = segment.dramatic ? 180 : 96;
          if (Math.max(segment.a.x, segment.b.x) < minX - reach || Math.min(segment.a.x, segment.b.x) > maxX + reach ||
              Math.max(segment.a.z, segment.b.z) < minZ - reach || Math.min(segment.a.z, segment.b.z) > maxZ + reach) continue;
          if (this.cities().some(city => capitalBoundary(city, (segment.a.x + segment.b.x) / 2,
            (segment.a.z + segment.b.z) / 2) < (city.theme ? 100 : !segment.trail ? 106 : -10000))) continue;
          if (!segment.trail) out.push(segment);
        }
      }
    }
    const urban = this.urbanRoads(); yield;
    for (const segment of urban) {
      if (Math.max(segment.a.x, segment.b.x) < minX - 96 || Math.min(segment.a.x, segment.b.x) > maxX + 96 ||
          Math.max(segment.a.z, segment.b.z) < minZ - 96 || Math.min(segment.a.z, segment.b.z) > maxZ + 96) continue;
      if (!segment.trail) out.push(segment);
    }
    return out;
  }

  roadAt(x: number, z: number, naturalHeight?: number): RoadSample | undefined {
    const ix = Math.floor(x / ROAD_TILE), iz = Math.floor(z / ROAD_TILE);
    let tile = this.lastRoadTile?.x === ix && this.lastRoadTile.z === iz ? this.lastRoadTile.tile : undefined;
    if (!tile) {
      const key = `${ix},${iz}`;
      tile = this.tiles.get(key);
      if (!tile) tile = cacheSet(this.tiles, key, {
        segments: this.collectRoads(ix * ROAD_TILE, (ix + 1) * ROAD_TILE, iz * ROAD_TILE, (iz + 1) * ROAD_TILE).map(prepareRoadSegment),
        cells: new Map(),
      });
      this.lastRoadTile = { x: ix, z: iz, tile };
    }
    // Contact/gradient probes stay in tiny neighborhoods. Cache a conservative
    // subcell list, preserving the parent tile's exact blend and tie order.
    const cellX = Math.floor(x / 32), cellZ = Math.floor(z / 32);
    const cellKey = cellX - ix * 4 + (cellZ - iz * 4) * 4;
    let segments = tile.cells.get(cellKey);
    if (!segments) {
      segments = tile.segments.filter(s => s.maxX >= cellX * 32 && s.minX <= (cellX + 1) * 32 &&
        s.maxZ >= cellZ * 32 && s.minZ <= (cellZ + 1) * 32);
      tile.cells.set(cellKey, segments);
    }
    let winner: RoadTileSegment | undefined, winnerDistance = 0, winnerHeight = 0;
    let best = Infinity;
    let sumWeight = 0, sumHeight = 0, gradeWeight = 0;
    let dramatic = false, corridorLow = -Infinity, corridorHigh = Infinity;
    for (const prepared of segments) {
      if (x < prepared.minX || x > prepared.maxX || z < prepared.minZ || z > prepared.maxZ) continue;
      const { segment, dx, dz, length2 } = prepared;
      const t = clamp(((x - segment.a.x) * dx + (z - segment.a.z) * dz) / length2, 0, 1);
      const distance = hypot2(x - lerp(segment.a.x, segment.b.x, t), z - lerp(segment.a.z, segment.b.z, t));
      if (distance > (segment.dramatic ? 180 : 90)) continue;
      const height = lerp(segment.a.y, segment.b.y, t);
      dramatic ||= !!segment.dramatic;
      if (segment.dramatic) {
        const bank = Math.max(0, distance - segment.width) * 1.45;
        corridorLow = Math.max(corridorLow, height - bank);
        corridorHigh = Math.min(corridorHigh, height + bank);
      }
      // The long summit switchbacks overlap. A fixed broad shoulder keeps a
      // nearly level leg from abruptly losing all weight beside a higher one.
      const shoulder = segment.dramatic ? 56 : Math.min(82, (segment.trail ? 16 : 26) + Math.abs(height - (naturalHeight ?? height)) * 1.2);
      const influence = distance >= segment.width + shoulder ? 0 : smoothstep(segment.width + shoulder, segment.width, distance);
      // Blend overlapping shoulders instead of switching abruptly between
      // a high switchback and a low trunk road at their Voronoi boundary.
      const edgeDistance = Math.max(0, distance - segment.width);
      const falloff = 1 + edgeDistance * edgeDistance;
      // Short curve chords must not outweigh an entire neighboring lane just
      // because the corner was tessellated into more segments.
      const weight = segment.dramatic ? influence / (1 + edgeDistance * edgeDistance * .05)
        : influence / falloff * prepared.chordWeight;
      if (!segment.dramatic) {
        sumWeight += weight;
        sumHeight += height * weight;
        gradeWeight = Math.max(gradeWeight, influence);
      }
      if (distance - segment.width >= best) continue;
      best = distance - segment.width;
      // Materialize only the final nearest lane. Capsule/normal queries used
      // to allocate a throwaway object for every increasingly close chord.
      winner=prepared;winnerDistance=distance;winnerHeight=height;
    }
    if (winner) {
      const result:RoadSample={distance:winnerDistance,height:winnerHeight,width:winner.segment.width,
        trail:winner.segment.trail,dx:winner.dx/winner.length,dz:winner.dz/winner.length,gradeWeight:0};
      result.height = sumWeight > 0 ? sumHeight / sumWeight : result.height;
      result.gradeWeight = gradeWeight;
      if (dramatic && naturalHeight !== undefined) {
        // A bounded-slope cutting/embankment envelope gives each summit lane
        // its real grade. Weighted overlapping shoulders can overshoot into
        // arbitrarily sharp ridges where one neighboring leg loses weight.
        const baseline = lerp(naturalHeight, result.height, result.gradeWeight);
        result.height = corridorLow <= corridorHigh ? clamp(baseline, corridorLow, corridorHigh) : (corridorLow + corridorHigh) * .5;
        result.gradeWeight = 1;
      }
      return result;
    }
    return undefined;
  }
}

const canonicalMapRoadCollector = Landscape.prototype.collectRoads;
const canonicalMapMajorCollector = Landscape.prototype.collectMajorRoads;
const canonicalMapTrailCollector = (Landscape.prototype as unknown as { trail: unknown }).trail;
const canonicalMapEdgeCollector = (Landscape.prototype as unknown as { edge: unknown }).edge;
const canonicalMapUrbanCollector = (Landscape.prototype as unknown as { urbanRoads: unknown }).urbanRoads;
