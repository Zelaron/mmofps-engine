import { clamp, lerp, smoothstep } from './math.js';
import { hash2i, unit } from './rng.js';
import { generateCities, type CityDistrict } from './cities.js';
import { capitalBoundary } from './capital-geometry.js';

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
export interface RoadSample {
  distance: number; height: number; width: number; trail: boolean;
  dx: number; dz: number;
  gradeWeight: number;
}

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
  private edges = new Map<string, RoadSegment[]>();
  private trails = new Map<string, RoadSegment[]>();
  private tiles = new Map<string, RoadSegment[]>();
  private cityList: CityDistrict[] | null = null;
  private cityRoads: RoadSegment[] | null = null;
  private highlights: Set<string> | null = null;
  constructor(readonly seed: number, private naturalHeight: (x: number, z: number) => number,
    private base: (x: number, z: number) => { h: number; volc: number }) {}

  cities(): readonly CityDistrict[] {
    return this.cityList ??= generateCities(this.seed, this.naturalHeight, (x, z) => this.base(x, z).volc < .2);
  }
  cityAt(x: number, z: number, margin = 0): CityDistrict | undefined {
    return this.cities().find(city => capitalBoundary(city, x, z) <= margin);
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
    const x = ix * LANDSCAPE_CELL + (unit(hash2i(s, ix, iz)) - 0.5) * 54;
    const z = iz * LANDSCAPE_CELL + (unit(hash2i(s + 7, ix, iz)) - 0.5) * 54;
    return cacheSet(this.nodes, key, { x, z, y: this.naturalHeight(x, z) });
  }

  private edge(ix: number, iz: number, axis: number): RoadSegment[] {
    const key = `${ix},${iz},${axis}`, found = this.edges.get(key);
    if (found) return found;
    const a = this.node(ix, iz), b = this.node(ix + (axis === 0 ? 1 : 0), iz + (axis === 1 ? 1 : 0));
    const bend = (unit(hash2i(this.seed ^ (axis ? 0x821af : 0x90aba), ix, iz)) - 0.5) * 130;
    const variation = unit(hash2i(this.seed ^ 0x639ba, ix + axis * 73, iz));
    const curve = (variation < .5 ? -1 : 1) * (55 + Math.abs(variation - .5) * 80);
    const segments: RoadSegment[] = [];
    let previous = a;
    for (let i = 1; i <= 32; i++) {
      // Broad curves on every rural link, with flat tangents at shared nodes.
      const t = i / 32, envelope = Math.sin(Math.PI * t) ** 2;
      const offset = (bend + curve * Math.sin(Math.PI * 2 * t)) * envelope;
      const next = i === 32 ? b : {
        x: lerp(a.x, b.x, t) + (axis === 1 ? offset : 0),
        z: lerp(a.z, b.z, t) + (axis === 0 ? offset : 0),
        y: lerp(a.y, b.y, t),
      };
      segments.push({ a: previous, b: next, width: 5.8, trail: false, id: key });
      previous = next;
    }
    return cacheSet(this.edges, key, segments);
  }

  private trail(ix: number, iz: number): RoadSegment[] {
    const key = `${ix},${iz}`, found = this.trails.get(key);
    if (found) return found;
    const s = this.mountain(ix, iz);
    // Join the existing west/south trunk at its exact midpoint, including
    // the shared interpolated elevation. No dead ends at road junctions.
    const edge = this.edge(ix, iz, s.dx === 1 ? 1 : 0);
    const points: RoadPoint[] = [edge[edge.length / 2 - 1].b];
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
      const ends = [this.edge(ix - 1, iz, 0)[15].b, this.edge(ix, iz, 0)[15].b,
        this.edge(ix, iz - 1, 1)[15].b, this.edge(ix, iz, 1)[15].b];
      const starts = [point(-city.radius, 0), point(city.radius, 0), point(0, -city.radius), point(0, city.radius)];
      for (let i = 0; i < 4; i++) roads.push({ a: starts[i], b: ends[i], width: 9, trail: false, id: `city-access:${city.id}` });
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

  roadAt(x: number, z: number, naturalHeight?: number): RoadSample | undefined {
    const ix = Math.floor(x / ROAD_TILE), iz = Math.floor(z / ROAD_TILE), key = `${ix},${iz}`;
    let segments = this.tiles.get(key);
    if (!segments) segments = cacheSet(this.tiles, key,
      this.collectRoads(ix * ROAD_TILE, (ix + 1) * ROAD_TILE, iz * ROAD_TILE, (iz + 1) * ROAD_TILE));
    let result: RoadSample | undefined;
    let best = Infinity;
    let sumWeight = 0, sumHeight = 0, gradeWeight = 0;
    let dramatic = false, corridorLow = -Infinity, corridorHigh = Infinity;
    for (const segment of segments) {
      const dx = segment.b.x - segment.a.x, dz = segment.b.z - segment.a.z;
      const length2 = dx * dx + dz * dz;
      const t = clamp(((x - segment.a.x) * dx + (z - segment.a.z) * dz) / length2, 0, 1);
      const distance = Math.hypot(x - lerp(segment.a.x, segment.b.x, t), z - lerp(segment.a.z, segment.b.z, t));
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
      const influence = smoothstep(segment.width + shoulder, segment.width, distance);
      // Blend overlapping shoulders instead of switching abruptly between
      // a high switchback and a low trunk road at their Voronoi boundary.
      const edgeDistance = Math.max(0, distance - segment.width);
      const falloff = 1 + edgeDistance * edgeDistance;
      // Short curve chords must not outweigh an entire neighboring lane just
      // because the corner was tessellated into more segments.
      const weight = segment.dramatic ? influence / (1 + edgeDistance * edgeDistance * .05)
        : influence / falloff * Math.min(1, Math.sqrt(length2) / 24);
      if (!segment.dramatic) {
        sumWeight += weight;
        sumHeight += height * weight;
        gradeWeight = Math.max(gradeWeight, influence);
      }
      if (distance - segment.width >= best) continue;
      best = distance - segment.width;
      const length = Math.sqrt(length2);
      result = { distance, height, width: segment.width,
        trail: segment.trail, dx: dx / length, dz: dz / length, gradeWeight: 0 };
    }
    if (result) {
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
    }
    return result;
  }
}
