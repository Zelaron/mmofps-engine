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
/** Even the largest diagonal rounded-island radius plus the full125m coast
 * displacement stays inland here:7300*2^(1/6)+125 < SHORE_START. */
export function canReachCoast(x:number,z:number):boolean {return Math.max(Math.abs(x),Math.abs(z))>=7300;}
/** Rounded coast leaves both distant capitals on land and the safety wall offshore. */
export function islandRadius(x: number, z: number): number {
  const ax = Math.abs(x), az = Math.abs(z), scale = Math.max(1, ax, az);
  return scale * ((ax / scale) ** 6 + (az / scale) ** 6) ** (1 / 6);
}
export function islandCoastDistance(seed: number, x: number, z: number): number {
  const radius = islandRadius(x, z), angle = Math.atan2(z, x);
  return radius - 80 * Math.sin(angle * 7 + seed * .01) - 45 * Math.sin(angle * 13);
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
