import { WORLD } from './constants.js';
import { mulberry32 } from './rng.js';
import type { World } from './worldgen.js';
import { cavePathPoint } from './caves.js';

// Deterministic teleporter network, derived from the static world seed.
// The server sends this base layout to clients on admission; regional
// encounters use the same deterministic queries in a background worker.
//
// Topology: surface pairs and directed cave returns sharing surface anchors.
// NO cave<->cave pairs - a player lost underground who finally finds a pad
// must always come out under open sky.

export interface TeleporterPad {
  x: number;
  y: number;
  z: number;
  /** True when the pad sits on a cave floor under a rock roof. */
  cave: boolean;
  /** Index of the destination pad. Several cave returns may share it. */
  partner: number;
}

/** Players within this XZ distance of the pad center are teleported. */
export const TELEPORT_RADIUS = 2.1;
/** Re-teleport lockout after arriving (seconds). */
export const TELEPORT_COOLDOWN_SECONDS = 3;

const SURFACE_PAIRS = 1;
const CAVE_PAIRS = 28;
const CAVE_SURFACE_ANCHORS = 7;
/** Pads never generate closer together than this (XZ meters). */
const MIN_SPACING = 240;
/** Pads stay within this radius of the origin, near the action. */
const PLACEMENT_EXTENT = 1900;

function tooClose(
  x: number, z: number,
  placed: { x: number; z: number }[],
  minDist: number,
): boolean {
  const d2 = minDist * minDist;
  for (const p of placed) {
    const dx = p.x - x, dz = p.z - z;
    if (dx * dx + dz * dz < d2) return true;
  }
  return false;
}

/** Flat, open-sky, standable surface spot; returns ground y or null. */
export function surfaceSpot(world: World, x: number, z: number): number | null {
  const col = world.column(x, z);
  // Stay away from cave entrance funnels, extreme terrain, and the
  // volcanic province (pads on lava would be a death trap).
  if (col.entr > 0.55) return null;
  if (col.volc > 0.3 || col.lavaY > -999) return null;
  if (col.h < -18 || col.h > WORLD.MAX_HEIGHT - 12) return null;
  // Local flatness across the pad footprint.
  let lo = col.h, hi = col.h;
  for (const [dx, dz] of [[1.6, 0], [-1.6, 0], [0, 1.6], [0, -1.6]] as const) {
    const h = world.column(x + dx, z + dz).h;
    if (h < lo) lo = h;
    if (h > hi) hi = h;
  }
  if (hi - lo > 1.1) return null;
  const gy = world.groundY(x, z);
  // groundY returns 0 as a miss sentinel; also reject bowls/overhangs where
  // the first surface from the sky is far from the column height.
  if (Math.abs(gy - col.h) > 1.2) return null;
  // Standing clearance for the arriving player.
  if (world.sdf(x, gy + 1.0, z) < 0.4 || world.sdf(x, gy + 1.9, z) < 0.3) return null;
  return gy;
}

/** Roofed cave-floor spot with headroom; returns floor y or null. */
export function caveSpot(world: World, x: number, z: number): number | null {
  const col = world.column(x, z);
  // Prefer deep interior over entrance bowls; entrances already have exits.
  if (col.entr > 0.4) return null;
  // Cheap pre-probe: cave air is only plausible in the deep band.
  let hasAir = false;
  for (const y of [-24, -30, -36]) {
    if (y < col.h - 8 && world.sdf(x, y, z) > 0.6) { hasAir = true; break; }
  }
  if (!hasAir) return null;
  // Walk down through the deep band; land on the first air->solid crossing.
  let prevAir = false;
  let prevY = 0;
  for (let y = Math.min(col.h - 9, -14); y > WORLD.MIN_CAVE_Y; y -= 0.7) {
    const air = world.sdf(x, y, z) > 0.05;
    if (prevAir && !air) {
      // Bisect the floor between prevY (air) and y (solid).
      let a = prevY, b = y;
      for (let i = 0; i < 10; i++) {
        const m = (a + b) / 2;
        if (world.sdf(x, m, z) > 0.05) a = m; else b = m;
      }
      const floor = a;
      if (floor > col.h - 8) return null;
      // Must be genuinely underground with generous standing room; the
      // 1.1m clearance sphere doubles as a "reasonable chamber" proxy.
      if (!world.roofedAbove(x, floor + 1.6, z)) return null;
      if (world.sdf(x, floor + 1.2, z) < 1.1) return null;
      if (world.sdf(x, floor + 2.1, z) < 0.35) return null;
      return floor;
    }
    prevAir = air;
    prevY = y;
  }
  return null;
}

/**
 * Deterministically find `count` standable cave-floor spots. Shared by the
 * teleporter network (pads) and the server's cave-loot scatter, each with
 * its own salt so the two sets land in different places.
 */
export function findCaveFloorSpots(
  world: World,
  count: number,
  salt: number,
  minSpacing: number,
  guard: number,
  avoid: { x: number; z: number }[] = [],
  avoidDist = 0,
  reachableOnly = false,
): { x: number; y: number; z: number }[] {
  const rng = mulberry32((world.seed ^ salt) >>> 0);
  const spots: { x: number; y: number; z: number }[] = [];
  if (reachableOnly) {
    // Rare rewards belong to chambers players can reach and leave on foot.
    // The old fixed-depth probe could only choose isolated deep noise rooms.
    const extent = PLACEMENT_EXTENT * 0.85;
    const sites = world.collectCaveSites(-extent, extent, -extent, extent);
    for (let i = 0; i < Math.min(guard, sites.length * 8) && spots.length < count; i++) {
      const site = sites[Math.floor(rng() * sites.length)];
      if (!site) break;
      const point = cavePathPoint(site, 57 + rng() * 19);
      const side = (rng() - 0.5) * 5;
      const x = point.x - site.dz * side, z = point.z + site.dx * side;
      if (Math.abs(x) > extent || Math.abs(z) > extent) continue;
      if (tooClose(x, z, spots, minSpacing) ||
          (avoidDist > 0 && tooClose(x, z, avoid, avoidDist))) continue;
      const col = world.column(x, z);
      if (!col.cave) continue;
      const y = col.cave.floor;
      if (!world.roofedAbove(x, y + 1.6, z) || world.sdf(x, y + 1.2, z) < 1.1 ||
          world.sdf(x, y + 2.1, z) < 0.35 || world.sdf(x, y - 0.05, z) > 0) continue;
      spots.push({ x, y, z });
    }
    return spots;
  }
  for (let i = 0; i < guard && spots.length < count; i++) {
    const x = (rng() * 2 - 1) * (PLACEMENT_EXTENT * 0.85);
    const z = (rng() * 2 - 1) * (PLACEMENT_EXTENT * 0.85);
    if (tooClose(x, z, spots, minSpacing)) continue;
    if (avoidDist > 0 && tooClose(x, z, avoid, avoidDist)) continue;
    const y = caveSpot(world, x, z);
    if (y !== null) spots.push({ x, y, z });
  }
  return spots;
}

/**
 * Generate the seed-deterministic teleporter network. Runs a bounded
 * candidate search (~a few thousand column probes) - call once at startup.
 */
export function generateTeleporters(world: World): TeleporterPad[] {
  const rng = mulberry32((world.seed ^ 0x7e1e70a7) >>> 0);
  const surface: { x: number; y: number; z: number }[] = [];
  const needSurface = SURFACE_PAIRS * 2 + CAVE_SURFACE_ANCHORS;

  for (let i = 0; i < 24000 && surface.length < needSurface; i++) {
    const x = (rng() * 2 - 1) * PLACEMENT_EXTENT;
    const z = (rng() * 2 - 1) * PLACEMENT_EXTENT;
    if (tooClose(x, z, surface, MIN_SPACING)) continue;
    const y = surfaceSpot(world, x, z);
    if (y !== null) surface.push({ x, y, z });
  }
  // Cave pads are the underground's lifeline: pack them densely enough
  // that a lost spelunker plausibly stumbles onto one.
  const caves = findCaveFloorSpots(
    world, CAVE_PAIRS, 0x7e1e70a8, 100, 60000,
  );

  const pads: TeleporterPad[] = [];
  const link = (
    a: { x: number; y: number; z: number }, aCave: boolean,
    b: { x: number; y: number; z: number }, bCave: boolean,
  ): void => {
    const ia = pads.length;
    pads.push({ ...a, cave: aCave, partner: ia + 1 });
    pads.push({ ...b, cave: bCave, partner: ia });
  };

  // Preserve the underground lifelines while reducing the old36 aboveground
  // pads to9. Shared directed destinations do not require another visible
  // surface pad for every cavern exit.
  let s = 0;
  for (let i = 0; i < SURFACE_PAIRS && s + 1 < surface.length; i++, s += 2) {
    link(surface[s], false, surface[s + 1], false);
  }
  const anchors: number[] = [];
  for (; s < surface.length; s++) {
    anchors.push(pads.length); pads.push({ ...surface[s], cave: false, partner: -1 });
  }
  for (let i = 0; i < caves.length && anchors.length; i++) {
    const partner = anchors[i % anchors.length], index = pads.length;
    pads.push({ ...caves[i], cave: true, partner });
    if (pads[partner].partner < 0) pads[partner].partner = index;
  }
  for (const index of anchors) if (pads[index].partner < 0) {
    pads[index].partner = pads.findIndex(p => p.cave);
    if (pads[index].partner < 0) pads[index].partner = index === 0 ? 1 : 0;
  }
  return pads;
}
