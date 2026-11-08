import { clamp, lerp, smoothstep } from './math.js';

export type LiquidKind = 'water' | 'lava';
export interface LiquidPoint { x: number; z: number; level: number }
export interface LiquidVolume {
  id: number; name: string; kind: LiquidKind; shape: 'ellipse' | 'river' | 'ocean';
  x: number; z: number; rx: number; rz: number; level: number; depth: number;
  underground?: boolean; points?: readonly LiquidPoint[];
}
export interface LiquidSample {
  id: number; kind: LiquidKind; surfaceY: number; bottomY: number;
  distance: number; flowX: number; flowZ: number;
}
export const SWIMMING = { SPEED: 5.6, ACCEL: 12, AIR_SECONDS: 18, DROWN_DPS: 18, LAVA_DPS: 42 } as const;
export const OCEAN_LEVEL = 0;
export const ISLAND_SHORE_START = 8450;
export const ISLAND_SHORE_END = 9300;
/** No coast metric reaches SHORE_START - 150 (where volcanoes fade out) closer
 * than this max-coordinate: the rounded corners and the deepest bays included
 * (tested by sampling; see coastline.test.ts). Offshore islands lie beyond it. */
export function canReachCoast(x:number,z:number):boolean {return Math.max(Math.abs(x),Math.abs(z))>=COAST_REACH;}
export const COAST_REACH = 6700;
/** The original square-ish outline, still used at harbors and runways. */
export function islandRadius(x: number, z: number): number {
  const ax = Math.abs(x), az = Math.abs(z), scale = Math.max(1, ax, az);
  return scale * ((ax / scale) ** 6 + (az / scale) ** 6) ** (1 / 6);
}
/** Bearings that keep the original coast: the ocean harbors and the runways
 * on Meridian's coastal plains, each with a half-window in radians. Stored as
 * unit directions so most points skip every window with a dot product. */
const KEPT_COAST = [
  ...[[0, 9300], [-9300, 0], [0, -9300], [9400, 1100]].map(([x, z]) => [x, z, .2] as const),
  ...[[-8051, -3979], [-4400, 8382], [1117, 8355], [6995, -7580]].map(([x, z]) => [x, z, .18] as const),
].map(([x, z, window]) => ({ cos: x / Math.hypot(x, z), sin: z / Math.hypot(x, z), window, cosWindow: Math.cos(window) }));
/** 0 on a kept bearing, rising smoothly to 1 outside its window. */
function coastOpenness(x: number, z: number, radius: number): number {
  let open = 1;
  for (const kept of KEPT_COAST) {
    const along = x * kept.cos + z * kept.sin;
    if (along < kept.cosWindow * radius) continue;
    const off = Math.atan2(Math.abs(z * kept.cos - x * kept.sin), along);
    const t = Math.min(1, Math.max(0, (off - kept.window * .4) / (kept.window * .6)));
    open = Math.min(open, t * t * (3 - 2 * t));
  }
  return open;
}
/** Capitals reach close to the shore; near them the coast stays as it was.
 * Meridian's Vesper and Aurelia, with their radius. */
const KEPT_CAPITALS: readonly (readonly [number, number, number])[] = [[-5120, -5120, 2000], [6144, 4096, 1800]];
function capitalOpenness(x: number, z: number): number {
  let open = 1;
  for (const [cx, cz, radius] of KEPT_CAPITALS) {
    const t = Math.min(1, Math.max(0, (Math.hypot(x - cx, z - cz) - radius * 1.25) / 700));
    open = Math.min(open, t * t * (3 - 2 * t));
  }
  return open;
}
/** Deepest bay, in metres of coast distance. Bays only: land never advances
 * past the original shore, so the ferry lanes stay in open water. */
export const COAST_BAY_DEPTH = 450;
/** The main island: away from kept bearings its corners round off (p 4
 * instead of 6) and its shore opens into bays. */
let phaseSeed = NaN, phase3 = [1, 0], phase5 = [1, 0];
export function mainCoastDistance(seed: number, x: number, z: number): number {
  const square = islandRadius(x, z), angle = Math.atan2(z, x), radius = Math.max(1e-6, Math.hypot(x, z));
  const open = coastOpenness(x, z, radius) * capitalOpenness(x, z);
  let shape = square;
  if (open > 0) {
    const ax = Math.abs(x), az = Math.abs(z), round = Math.sqrt(Math.sqrt(ax * ax * ax * ax + az * az * az * az));
    // sin(3a + p) and sin(5a + q) from the bearing's unit vector: multiple-
    // angle products instead of trigonometry on this hot terrain path.
    if (seed !== phaseSeed) {
      phaseSeed = seed;
      phase3 = [Math.cos(seed * .013), Math.sin(seed * .013)];
      phase5 = [Math.cos(1.7 + seed * .007), Math.sin(1.7 + seed * .007)];
    }
    const c1 = x / radius, s1 = z / radius, c2 = c1 * c1 - s1 * s1, s2 = 2 * c1 * s1;
    const c3 = c2 * c1 - s2 * s1, s3 = s2 * c1 + c2 * s1, c5 = c3 * c2 - s3 * s2, s5 = s3 * c2 + c3 * s2;
    const f = .6 * (s3 * phase3[0] + c3 * phase3[1]) + .4 * (s5 * phase5[0] + c5 * phase5[1]);
    shape += open * (round - square + COAST_BAY_DEPTH * (f + Math.sqrt(f * f + .04)) / 2.2);
  }
  return shape - 80 * Math.sin(angle * 7 + seed * .01) - 45 * Math.sin(angle * 13);
}
/** Small scenery islands offshore, clear of the ferry lanes and the border. */
export const OFFSHORE_ISLANDS: readonly { x: number; z: number; radius: number }[] = [
  { x: -9100, z: 9100, radius: 430 },
  { x: 10600, z: -4600, radius: 300 },
  { x: -4800, z: -10600, radius: 300 },
];
/** Island shores span this many metres either side of an island's radius. */
const ISLAND_SHORE_HALF = 120;
function offshoreIslandDistance(x: number, z: number): number {
  let best = Infinity;
  for (const island of OFFSHORE_ISLANDS) {
    const reach = island.radius + ISLAND_SHORE_HALF * 3;
    if (Math.abs(x - island.x) > reach || Math.abs(z - island.z) > reach) continue;
    const d = Math.hypot(x - island.x, z - island.z);
    if (d > reach) continue;
    best = Math.min(best, ISLAND_SHORE_START + (d - island.radius + ISLAND_SHORE_HALF) / (2 * ISLAND_SHORE_HALF) * (ISLAND_SHORE_END - ISLAND_SHORE_START));
  }
  return best;
}
/** The coast metric before the reshape; roads use it to tell new bays apart. */
export function originalCoastDistance(seed: number, x: number, z: number): number {
  const angle = Math.atan2(z, x);
  return islandRadius(x, z) - 80 * Math.sin(angle * 7 + seed * .01) - 45 * Math.sin(angle * 13);
}
/** Distance-like coast metric: below SHORE_START is land, past SHORE_END sea. */
export function islandCoastDistance(seed: number, x: number, z: number): number {
  return Math.min(mainCoastDistance(seed, x, z), offshoreIslandDistance(x, z));
}
// Keep optional fields in the same layout for each hot query input. Creating
// the river with an extra property caused repeated V8 wrong-map bailouts.
function uniformVolumes(definitions: readonly LiquidVolume[]): readonly LiquidVolume[] {
  return definitions.map(volume => ({
    id: volume.id, name: volume.name, kind: volume.kind, shape: volume.shape,
    x: volume.x, z: volume.z, rx: volume.rx, rz: volume.rz, level: volume.level, depth: volume.depth,
    points: volume.points, underground: volume.underground,
  }));
}
const volumes: readonly LiquidVolume[] = uniformVolumes([
  { id: 1, name: 'Outer Ocean', kind: 'water', shape: 'ocean', x: 0, z: 0, rx: 11264, rz: 11264, level: 0, depth: 62 },
  { id: 2, name: 'Lake Halcyon', kind: 'water', shape: 'ellipse', x: 4900, z: 1200, rx: 700, rz: 500, level: 6, depth: 22 },
  { id: 3, name: 'Halcyon River', kind: 'water', shape: 'river', x: 7500, z: 1250, rx: 2800, rz: 400, level: 6, depth: 16,
    points: [{ x: 5200, z: 1200, level: 6 }, { x: 6200, z: 1300, level: 5 }, { x: 7200, z: 1500, level: 3.5 },
      { x: 8300, z: 1100, level: 1.5 }, { x: 9800, z: 1100, level: 0 }] },
  { id: 4, name: 'Emerald Lagoon', kind: 'water', shape: 'ellipse', x: 450, z: 1250, rx: 190, rz: 140, level: 12, depth: 14 },
  { id: 5, name: 'Highland Tarn', kind: 'water', shape: 'ellipse', x: -2800, z: -1200, rx: 270, rz: 185, level: 62, depth: 18 },
]);
export function surfaceLiquidVolumes(): readonly LiquidVolume[] { return volumes; }

/** Horizontal footprint and local level. Depth is bounded independently of the surface. */
export function liquidFootprint(volume: LiquidVolume, seed: number, x: number, z: number): LiquidSample {
  let distance: number, surfaceY = volume.level, flowX = 0, flowZ = 0;
  if (volume.shape === 'ocean') distance = 8500 - islandCoastDistance(seed, x, z);
  else if (volume.shape === 'river') {
    distance = Infinity;
    const points = volume.points!;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dx = b.x - a.x, dz = b.z - a.z;
      const length = Math.hypot(dx, dz), t = clamp(((x - a.x) * dx + (z - a.z) * dz) / (length * length), 0, 1);
      const d = Math.hypot(x - a.x - dx * t, z - a.z - dz * t) - 150;
      if (d < distance) { distance = d; surfaceY = lerp(a.level, b.level, t); flowX = dx / length * .65; flowZ = dz / length * .65; }
    }
    // The mouth joins the ocean at one waterline, including shallow boats.
    // Without this, a thin elevated river sheet floats above deep ocean water.
    if (canReachCoast(x,z)) surfaceY = lerp(surfaceY, OCEAN_LEVEL,
      smoothstep(ISLAND_SHORE_START, ISLAND_SHORE_END - 100, islandCoastDistance(seed,x,z)));
  } else {
    const dx = (x - volume.x) / volume.rx, dz = (z - volume.z) / volume.rz;
    distance = (Math.hypot(dx, dz) - 1) * Math.min(volume.rx, volume.rz);
  }
  return { id: volume.id, kind: volume.kind, distance, surfaceY, bottomY: surfaceY - volume.depth, flowX, flowZ };
}
/** Terrain grading only. Actual liquid membership additionally requires a wet
 * terrain bed or an explicitly designated underground volume. */
export function gradeLiquidTerrain(seed: number, x: number, z: number, height: number): number {
  const coast = canReachCoast(x,z) ? smoothstep(ISLAND_SHORE_START, ISLAND_SHORE_END, islandCoastDistance(seed, x, z)) : 0;
  let h = lerp(height, -58 + 3 * Math.sin(x * .0017) * Math.cos(z * .0013), coast);
  for (const volume of volumes) {
    if (volume.shape === 'ocean') continue;
    if (Math.abs(x - volume.x) > volume.rx + 180 || Math.abs(z - volume.z) > volume.rz + 180) continue;
    const sample = liquidFootprint(volume, seed, x, z);
    if (sample.distance > 140) continue;
    const depth = smoothstep(18, -90, sample.distance);
    // Rim grading joins arbitrary hill elevations smoothly to the bank.
    const bed = sample.surfaceY + 1.5 - volume.depth * depth;
    const basin = lerp(h, bed, smoothstep(140, 8, sample.distance));
    // River/lake bank grading may excavate the coast, but must never refill
    // the ocean. The old rim raised sand bars across the estuary ferry lane.
    h = lerp(basin, Math.min(h, basin), smoothstep(0, .12, coast));
  }
  return h;
}
export function liquidAtSurfaceColumn(seed: number, x: number, y: number, z: number,
  terrainHeight: number, lavaY = -1000): LiquidSample | undefined {
  if (lavaY > -999 && terrainHeight < lavaY && y >= terrainHeight - .05 && y <= lavaY)
    return { id: -1, kind: 'lava', surfaceY: lavaY, bottomY: terrainHeight, distance: -1, flowX: 0, flowZ: 0 };
  let result: LiquidSample | undefined;
  for (const volume of volumes) {
    if(volume.shape==='ocean'&&!canReachCoast(x,z))continue;
    if (volume.shape !== 'ocean' && (Math.abs(x - volume.x) > volume.rx + 160 || Math.abs(z - volume.z) > volume.rz + 160)) continue;
    const sample = liquidFootprint(volume, seed, x, z);
    sample.bottomY = Math.max(sample.bottomY, terrainHeight);
    if (sample.distance <= 0 && terrainHeight < sample.surfaceY - .03 &&
      y >= sample.bottomY - .05 && y <= sample.surfaceY && (!result || sample.surfaceY > result.surfaceY)) result = sample;
  }
  return result;
}
