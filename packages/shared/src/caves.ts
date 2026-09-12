import { clamp, smoothstep } from './math.js';
import { hash2i, unit } from './rng.js';
import { WORLD } from './constants.js';
import type { World } from './worldgen.js';

/** A whole cave fits its 320m cell; column queries need only one cached site. */
export const CAVE_CELL = 320;
export interface CaveSite {
  /** Mouth center and the continuous path's surface elevation. */
  x: number; y: number; z: number;
  dx: number; dz: number;
  length: number; depth: number; width: number; mouthLength: number;
  chamberRadius: number; height: number; bend: number; seed: number;
  /** Another walkable approach to the same chamber, when its hillside fits. */
  exit?: CaveSite;
  /** Galleries finish their descent before their shared level chamber. */
  levelChamber?: boolean;
}

export const CAVE_BIOME = { LIMESTONE: 0, COPPER: 1, GLACIAL: 2, FUNGAL: 3 } as const;
export type CaveBiome = (typeof CAVE_BIOME)[keyof typeof CAVE_BIOME];
/** Large, stable geological provinces: no extra noise fields per SDF sample. */
export function caveBiomeAt(seed: number, x: number, z: number): CaveBiome {
  return Math.floor(unit(hash2i(seed ^ 0x38ca9, Math.floor(x / 512), Math.floor(z / 512))) * 4) as CaveBiome;
}
const BIOME_ROCK = [[0.58, 0.55, 0.45], [0.57, 0.35, 0.23], [0.37, 0.55, 0.65], [0.34, 0.48, 0.36]] as const;
/** Smooth geological transitions; palettes cannot leave colored grid seams. */
export function caveBiomeColor(seed: number, x: number, z: number, out: { [i: number]: number }, offset = 0): void {
  const gx = x / 512 - 0.5, gz = z / 512 - 0.5;
  const ix = Math.floor(gx), iz = Math.floor(gz);
  const u = smoothstep(0.375, 0.625, gx - ix), v = smoothstep(0.375, 0.625, gz - iz);
  const a = BIOME_ROCK[caveBiomeAt(seed, ix * 512, iz * 512)];
  const b = BIOME_ROCK[caveBiomeAt(seed, (ix + 1) * 512, iz * 512)];
  const c = BIOME_ROCK[caveBiomeAt(seed, ix * 512, (iz + 1) * 512)];
  const d = BIOME_ROCK[caveBiomeAt(seed, (ix + 1) * 512, (iz + 1) * 512)];
  for (let i = 0; i < 3; i++) out[offset + i] = (a[i] + (b[i] - a[i]) * u) * (1 - v) + (c[i] + (d[i] - c[i]) * u) * v;
}

export interface CaveFloorSpot { x: number; y: number; z: number }

/** Find every usable level in one deep column, including landings below an
 * arrival floor. Bounded to the 32m deep band and four results per column;
 * returns actual supported pads, never floating fixed-Y guesses. */
export function sampleCaveFloorLayers(
  world: Pick<World, 'column' | 'sdf' | 'roofedAbove'> & Partial<Pick<World, 'regionAt' | 'sdfCol'>>,
  x: number, z: number, limit = 4, upperY = -14,
): CaveFloorSpot[] {
  if (!Number.isFinite(x + z) || !Number.isFinite(limit) || limit <= 0) return [];
  const col = world.column(x, z), spots: CaveFloorSpot[] = [];
  // Reuse the column/primitive region throughout the vertical scan. Broad
  // mountain-cave sampling must not regenerate those queries for every Y.
  const region = world.regionAt?.(x, z);
  const distance = (y: number) => region && world.sdfCol ? world.sdfCol(x, y, z, col, region) : world.sdf(x, y, z);
  const capacity = Math.min(4, Math.floor(limit));
  const step = upperY > -14 ? 1.4 : 0.7;
  let previousY = Math.min(col.h - 9, Number.isFinite(upperY) ? upperY : -14, WORLD.MAX_HEIGHT - 9);
  let previousAir = distance(previousY) > 0.05;
  for (let y = previousY - step; y > WORLD.MIN_CAVE_Y && spots.length < capacity; y -= step) {
    const air = distance(y) > 0.05;
    if (previousAir && !air) {
      let above = previousY, below = y;
      for (let i = 0; i < 9; i++) {
        const mid = (above + below) / 2;
        if (distance(mid) > 0.05) above = mid; else below = mid;
      }
      const floor = above;
      let safe = floor < col.h - 8 && distance(floor + 1.2) >= 1.05 &&
        distance(floor + 2.1) >= 0.35 && world.roofedAbove(x, floor + 1.6, z);
      // A low ledge must support the whole pad, not merely its center.
      if (safe) for (const [dx, dz] of [[1.4, 0], [-1.4, 0], [0, 1.4], [0, -1.4]]) {
        if (world.sdf(x + dx, floor + 0.65, z + dz) < 0.15 ||
            world.sdf(x + dx, floor - 0.65, z + dz) > 0) { safe = false; break; }
      }
      if (safe) spots.push({ x, y: floor, z });
    }
    previousAir = air; previousY = y;
  }
  return spots;
}

export function caveFloorAt(site: CaveSite, forward: number): number {
  const end = site.levelChamber ? site.length - site.chamberRadius - 3 : site.length;
  return site.y - site.depth * smoothstep(0, end, forward);
}

export interface CaveColumn {
  site: CaveSite;
  forward: number;
  side: number;
  floor: number;
  width: number;
  /** Positive inside the footprint; negative in the padded sampling apron. */
  footprint: number;
  /** Signed footprint of the open mouth, excluding its vertical floor. */
  mouth: number;
  chamber: number;
}

export function caveBend(site: CaveSite, forward: number): number {
  const t = clamp(forward / site.length, 0, 1);
  return site.bend * 4 * t * (1 - t);
}

export function cavePathPoint(site: CaveSite, forward: number): { x: number; y: number; z: number } {
  const bend = caveBend(site, forward);
  return {
    x: site.x + site.dx * forward - site.dz * bend,
    y: caveFloorAt(site, forward),
    z: site.z + site.dz * forward + site.dx * bend,
  };
}

/** Column-local cave coordinates, shared by the canonical field and decoration. */
export function caveColumn(site: CaveSite, x: number, z: number): CaveColumn | undefined {
  const rx = x - site.x, rz = z - site.z;
  const forward = rx * site.dx + rz * site.dz;
  const rawSide = -rx * site.dz + rz * site.dx;
  if (forward < -44 || forward > site.length + 42 || Math.abs(rawSide) > 43) return undefined;
  const side = rawSide - caveBend(site, forward);
  const width = site.width * (1 + 0.15 * smoothstep(0, 44, forward));
  const corridor = Math.min(width - Math.abs(side), forward + 32, site.length + 8 - forward);
  // Three overlapping lobes form an asymmetric chamber and side alcoves.
  const cu = forward - site.length;
  const chamber = Math.max(
    site.chamberRadius - Math.hypot(cu, rawSide * 1.12),
    site.chamberRadius * 0.66 - Math.hypot(cu + 12, rawSide - site.chamberRadius * 0.61),
    site.chamberRadius * 0.58 - Math.hypot(cu - 8, rawSide + site.chamberRadius * 0.65),
  );
  const footprint = Math.max(corridor, chamber);
  if (footprint < -10) return undefined;
  const floor = caveFloorAt(site, forward);
  // A slanted, scalloped arch front replaces the old enormous noise crater.
  const mouthEnd = site.mouthLength + side * 0.18 - side * side * 0.032;
  const mouth = Math.min(corridor, mouthEnd - forward);
  return { site, forward, side, floor, width, footprint, mouth, chamber };
}
