import { hash2i, unit } from './rng.js';
import type { Box } from './worldgen.js';

export const STRUCTURE_KIND = {
  BUNKER: 0, COURTYARD: 1, HANGAR: 2, RELAY: 3, VILLAGE: 4,
  PYRAMID: 5, RUNWAY: 6, MEGAPYRAMID: 7,
  MILITARY_BASE: 8, ENCAMPMENT: 9, RADAR_STATION: 10, RESEARCH_STATION: 11,
  CITY_BLOCK: 12,
} as const;
export type StructureKind = (typeof STRUCTURE_KIND)[keyof typeof STRUCTURE_KIND];
export interface StructureSite {
  kind: StructureKind;
  x: number; z: number; top: number; hx: number; hz: number;
  rotated: boolean;
  underground?: boolean;
}

export type AddStructureBox = (
  x: number, y: number, z: number, hx: number, hy: number, hz: number,
) => void;

/** New families use open routes and real solid cover, including their roofs. */
export function buildStructureFamily(kind: StructureKind, add: AddStructureBox, seed: number): void {
  const room = (x: number, z: number, hx: number, hz: number, height: number, door = 2.8): void => {
    const t = 0.42;
    add(x - hx, height / 2, z, t, height / 2, hz);
    add(x + hx, height / 2, z, t, height / 2, hz);
    const wing = (2 * hx - door) / 4;
    for (const side of [-1, 1]) {
      for (const end of [-1, 1]) add(x + side * (door / 2 + wing), height / 2,
        z + end * hz, wing, height / 2, t);
    }
    add(x, height + 0.24, z, hx + 0.5, 0.24, hz + 0.5);
  };
  const tower = (x: number, z: number): void => {
    for (const side of [-1, 1]) for (const end of [-1, 1]) add(x + side * 2.1,
      3, z + end * 2.1, 0.38, 3, 0.38);
    // Broad staircase and two open sides make the lookout usable on foot.
    for (let i = 0; i < 12; i++) add(x + 1.9, (i + 1) * 0.25,
      z + 11.8 - i * 0.8, 1.3, (i + 1) * 0.25, 0.42);
    add(x, 6.2, z, 3.1, 0.2, 3.1);
    add(x - 2.9, 6.85, z, 0.2, 0.45, 3.1);
    add(x, 6.85, z - 2.9, 3.1, 0.45, 0.2);
    for (const side of [-1, 1]) for (const end of [-1, 1]) add(x + side * 2.9,
      7.7, z + end * 2.9, 0.2, 1.3, 0.2);
    add(x, 9, z, 3.3, 0.22, 3.3);
  };
  const barrier = (x: number, z: number, alongX = true): void =>
    add(x, 0.75, z, alongX ? 3.8 : 0.6, 0.75, alongX ? 0.6 : 3.8);
  if (kind === STRUCTURE_KIND.MILITARY_BASE) {
    // A 92x68m installation with a vehicle lane, barracks, motor pool and
    // an accessible watchtower. Both ends of the central lane remain open.
    room(-23, -13, 12, 7, 4.2, 4.8);
    room(24, -16, 9, 5.5, 3.2);
    room(24, 4, 9, 5.5, 3.2);
    room(-22, 16, 10, 5.8, 3.6);
    tower(29, 22);
    for (const side of [-1, 1]) {
      for (const z of [-25, -7, 11]) barrier(side * 43, z, false);
      barrier(side * 17, -31);
      barrier(side * 17, 31);
    }
    for (let i = 0; i < 4; i++) add(-35 + i * 4, 0.85, 27, 1.4, 0.85, 1.7);
  } else if (kind === STRUCTURE_KIND.ENCAMPMENT) {
    // Low modular field shelters, an open briefing area and storage stacks.
    for (const side of [-1, 1]) {
      room(side * 12, -8, 5.2, 4.4, 2.6);
      room(side * 12, 8, 5.2, 4.4, 2.6);
      barrier(side * 12, -20);
      barrier(side * 12, 20);
      add(side * 20, 0.65, 0, 1.4, 0.65, 2.1);
    }
    add(-4.5, 0.85, 1, 1.2, 0.85, 3);
    add(4.5, 0.45, -1, 1.2, 0.45, 3);
  } else if (kind === STRUCTURE_KIND.RADAR_STATION) {
    room(-10, 0, 5.5, 8, 3.6);
    // A stepped mast array has a distinct long-distance silhouette without
    // animated meshes or an expensive translucent dish.
    add(9, 7, 0, 1, 7, 1);
    add(9, 11.6, 0, 6.8, 0.45, 1.3);
    add(9, 14.5, 0, 5.5, 0.42, 1.15);
    for (let i = 0; i < 5; i++) add(3 + i * 3, 13.1, 0, 0.25, 2, 0.8);
    barrier(-10, -14);
    barrier(10, 14);
  } else if (kind === STRUCTURE_KIND.RESEARCH_STATION) {
    room(-11, -7, 6.4, 5.2, 4.5);
    room(11, 7, 6.4, 5.2, 3.1);
    // Elevated utility tanks and a covered loading dock frame a clear lane.
    for (const x of [-14, -8]) {
      add(x, 1.4, 10, 0.4, 1.4, 0.4);
      add(x, 4.3, 10, 2.2, 1.5, 2.4);
      add(x, 6.1, 10, 0.7, 0.3, 0.7);
    }
    const extra = unit(hash2i(seed, 9, 17)) > 0.5;
    if (extra) add(12, 0.9, -12, 3.7, 0.9, 1.5);
    else { add(9, 1.4, -12, 1.4, 1.4, 1.4); add(15, 0.7, -12, 1.4, 0.7, 1.4); }
  }
}

/** AABB subtraction preserves the exact occupied volume while assigning
 * every coplanar exterior patch to one box. Collision still uses the simpler
 * original union. Runs only when the renderer changes its spatial cell. */
export function disjointStructureBoxes(input: readonly Box[]): Box[] {
  const bins = new Map<string, Box[]>();
  const result: Box[] = [];
  const cell = 32;
  const keys = (b: Box): string[] => {
    const out: string[] = [];
    for (let x = Math.floor((b.x - b.hx) / cell); x <= Math.floor((b.x + b.hx) / cell); x++) {
      for (let z = Math.floor((b.z - b.hz) / cell); z <= Math.floor((b.z + b.hz) / cell); z++) out.push(`${x},${z}`);
    }
    return out;
  };
  for (const box of input) {
    const boxKeys = keys(box);
    const candidates = new Set(boxKeys.flatMap((key) => bins.get(key) ?? []));
    let pieces = [box];
    for (const occupied of candidates) {
      pieces = pieces.flatMap((piece) => subtractBox(piece, occupied));
      if (!pieces.length) break;
    }
    result.push(...pieces);
    // Index original boxes, keeping clipping candidates small even when a
    // roof intersecting several walls has split into many visible pieces.
    for (const key of boxKeys) {
      const list = bins.get(key);
      if (list) list.push(box); else bins.set(key, [box]);
    }
  }
  return result;
}

function subtractBox(a: Box, b: Box): Box[] {
  const lo = [a.x - a.hx, a.y - a.hy, a.z - a.hz];
  const hi = [a.x + a.hx, a.y + a.hy, a.z + a.hz];
  const cutLo = [Math.max(lo[0], b.x - b.hx), Math.max(lo[1], b.y - b.hy), Math.max(lo[2], b.z - b.hz)];
  const cutHi = [Math.min(hi[0], b.x + b.hx), Math.min(hi[1], b.y + b.hy), Math.min(hi[2], b.z + b.hz)];
  if (cutHi.some((v, i) => v - cutLo[i] < 1e-7)) return [a];
  const out: Box[] = [];
  const emit = (l: number[], h: number[]): void => {
    if (h.some((v, i) => v - l[i] < 1e-7)) return;
    out.push({ ...a, x: (l[0] + h[0]) / 2, y: (l[1] + h[1]) / 2, z: (l[2] + h[2]) / 2,
      hx: (h[0] - l[0]) / 2, hy: (h[1] - l[1]) / 2, hz: (h[2] - l[2]) / 2 });
  };
  for (let axis = 0; axis < 3; axis++) {
    const lowerHi = [...hi]; lowerHi[axis] = cutLo[axis]; emit(lo, lowerHi);
    const upperLo = [...lo]; upperLo[axis] = cutHi[axis]; emit(upperLo, hi);
    lo[axis] = cutLo[axis]; hi[axis] = cutHi[axis];
  }
  return out;
}

export interface UndergroundStructure { site: StructureSite; solids: Box[] }

/** Uses terrain-only queries, never world.sdf/collectStructures, so cave
 * outposts cannot recurse through their own collision broad phase. */
export function generateUndergroundStructure(seed: number, cellX: number, cellZ: number,
  terrain: (x: number, y: number, z: number) => number,
  height: (x: number, z: number) => number,
  placementAllowed?: (structure: UndergroundStructure) => boolean): UndergroundStructure | null {
  const key = hash2i(seed ^ 0x71095, cellX, cellZ);
  if (unit(key) > 0.32) return null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const x = (cellX + 0.5) * 256 + (unit(hash2i(key, attempt, 3)) - 0.5) * 120;
    const z = (cellZ + 0.5) * 256 + (unit(hash2i(key, attempt, 7)) - 0.5) * 120;
    if (height(x, z) < 0) continue;
    let y = -15;
    let wasAir = false;
    let floor: number | undefined;
    for (; y > -44; y -= 1) {
      const air = terrain(x, y, z) > 0;
      if (wasAir && !air) {
        let lo = y, hi = y + 1;
        for (let i = 0; i < 9; i++) {
          const mid = (lo + hi) / 2;
          if (terrain(x, mid, z) > 0) hi = mid; else lo = mid;
        }
        floor = hi;
        break;
      }
      wasAir = air;
    }
    if (floor === undefined) continue;
    let clear = true;
    let floorTop = floor;
    for (const ox of [-8, 0, 8]) for (const oz of [-8, 0, 8]) {
      if (terrain(x + ox, floor + 0.9, z + oz) < 0.15 ||
          terrain(x + ox, floor - 0.9, z + oz) > 0 ||
          terrain(x + ox, floor + 5.4, z + oz) < 0.5) clear = false;
      let lo = floor - 0.9, hi = floor + 0.9;
      for (let i = 0; i < 7; i++) {
        const mid = (lo + hi) / 2;
        if (terrain(x + ox, mid, z + oz) > 0) hi = mid; else lo = mid;
      }
      floorTop = Math.max(floorTop, hi);
    }
    if (!clear) continue;
    const top = floorTop + 0.14;
    // Both open ends must meet the surrounding cave, not terminate against
    // a rising rock rib just outside the platform's clearance stencil.
    for (const side of [-1, 1]) for (const ox of [-2, 0, 2]) {
      const px = x + ox, pz = z + side * 10;
      if (terrain(px, top - 1.1, pz) > 0 || terrain(px, top + 0.3, pz) <= 0 ||
          terrain(px, top + 2.5, pz) < 0.3) clear = false;
    }
    if (!clear) continue;
    const solids: Box[] = [];
    const add: AddStructureBox = (lx, ly, lz, hx, hy, hz) =>
      solids.push({ x: x + lx, y: top + ly, z: z + lz, hx, hy, hz });
    const plinthBottom = floor - 1;
    add(0, (plinthBottom - top) / 2, 0, 8.5, (top - plinthBottom) / 2, 8.5);
    for (const side of [-1, 1]) add(0, -0.45, side * 8.8, 1.8, 0.25, 0.65);
    for (const side of [-1, 1]) {
      add(side * 6, 0.8, 4.5, 1.8, 0.8, 2.2);
      add(side * 6, 1.2, -4.5, 1.8, 1.2, 1.8);
      add(side * 7.4, 2.2, -7.3, 0.35, 2.2, 0.35);
      add(side * 3.7, 2.2, -7.3, 0.35, 2.2, 0.35);
      add(side * 5.5, 4.5, -5.5, 2.8, 0.2, 2.5);
      add(side * 5.5, 2.2, -3.3, 0.35, 2.2, 0.35);
    }
    const result: UndergroundStructure = { site: { kind: STRUCTURE_KIND.RESEARCH_STATION, x, z, top,
      hx: 8.5, hz: 8.5, rotated: false, underground: true }, solids };
    if (placementAllowed && !placementAllowed(result)) continue;
    return result;
  }
  return null;
}
