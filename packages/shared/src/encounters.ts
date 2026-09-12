import { WORLD } from './constants.js';
import { hash2i, mulberry32 } from './rng.js';
import { CAVE_CELL, cavePathPoint, sampleCaveFloorLayers } from './caves.js';
import { surfaceSpot, type TeleporterPad } from './teleporters.js';
import type { World } from './worldgen.js';

export const ENCOUNTER_REGION_SIZE = 1024;
export const ENCOUNTER_CACHE_LIMIT = 96;
export const CAVE_POI_REGION_CAP = 48;
export type EncounterPoint = { x: number; y: number; z: number };
type Point = EncounterPoint;
export type CavePOIKind = 'camp' | 'extraction' | 'shrine' | 'vault';
export type CavePropKind = 'shelter' | 'rig' | 'crystal' | 'rack' | 'beacon';
export interface CaveLandmarkProp extends Point { kind: CavePropKind; yaw: number; scale: number }
export interface EncounterLoot extends Point { id: string; weapon: number; cave: boolean }
export interface CavePOI extends Point {
  id: string; regionKey: string; cave: true; kind: CavePOIKind; weapon: 5 | 6 | 9;
  loot: EncounterLoot; returnPad: Point; returnTarget: Point;
  props: CaveLandmarkProp[];
}
export interface EncounterRegion {
  key: string;
  pads: TeleporterPad[];
  loot: EncounterLoot[];
  pois: CavePOI[];
}

function separated(p: Point, others: readonly Point[], distance: number): boolean {
  return !others.some(q => Math.abs(p.y - q.y) < 7 && Math.hypot(p.x - q.x, p.z - q.z) < distance);
}

/** Pure selection for the authoritative emergency-recall action. This does
 * no terrain work per frame: every candidate was validated at generation. */
export function findRescueSurfaceTarget(pads: readonly TeleporterPad[], x: number, z: number): TeleporterPad | null {
  let best: TeleporterPad | null = null, distance = Infinity;
  for (const pad of pads) if (!pad.cave) {
    const d = Math.hypot(pad.x - x, pad.z - z);
    if (d < distance) { best = pad; distance = d; }
  }
  return best;
}

/** Check the walking floor, not merely line-of-sight over a hidden pit. */
export function caveLootWalkTarget(world: World, start: Point, angle: number, distance = 7): Point | null {
  const dx = Math.cos(angle), dz = Math.sin(angle);
  if (world.trace(start.x, start.y + 1.2, start.z, dx, 0, dz, distance).hit) return null;
  let floor = start.y;
  for (let step = 1; step <= 4; step++) {
    const x = start.x + dx * distance * step / 4, z = start.z + dz * distance * step / 4;
    const hit = world.trace(x, floor + 2, z, 0, -1, 0, 3.2);
    if (!hit.hit || hit.ny < 0.64 || Math.abs(hit.y - floor) > 0.62 ||
        world.sdf(x, hit.y + 1.2, z) < 0.95 || world.sdf(x, hit.y + 1.9, z) < 0.3) return null;
    floor = hit.y;
  }
  const target = { x: start.x + dx * distance, y: floor, z: start.z + dz * distance };
  return world.roofedAbove(target.x, target.y + 1.6, target.z) ? target : null;
}

function* createDiscovery(world: World, regionKey: string, point: Point, id: string, rng: () => number,
  target: Point): Generator<void, CavePOI | null> {
  const kind = (['camp', 'extraction', 'shrine', 'vault'] as const)[Math.floor(rng() * 4)];
  const weapon = kind === 'vault' ? 6 : kind === 'shrine' ? 9 : 5;
  let lootPoint: Point | null = null, heading = rng() * Math.PI * 2;
  for (let side = 0; side < 8 && !lootPoint; side++) {
    const angle = heading + side * Math.PI / 4;
    lootPoint = caveLootWalkTarget(world, point, angle);
    if (lootPoint) heading = angle;
    yield;
  }
  if (!lootPoint) return null;
  const loot: EncounterLoot = { ...lootPoint, id: `${id}:loot`, weapon, cave: true };
  const props: CaveLandmarkProp[] = [];
  const family: CavePropKind[] = kind === 'camp' ? ['shelter', 'rack', 'beacon', 'beacon']
    : kind === 'extraction' ? ['rig', 'rack', 'beacon', 'crystal']
      : kind === 'shrine' ? ['crystal', 'crystal', 'crystal', 'beacon']
        : ['rack', 'rack', 'rig', 'beacon'];
  for (let i = 0; i < family.length; i++) {
    // Pieces stand on individual sampled roots, outside the clear return
    // route. Open frames and small minerals avoid implying opaque cover.
    const angle = heading + (i % 2 ? -1 : 1) * (Math.PI / 2 + Math.floor(i / 2) * 0.48);
    const x = loot.x + Math.cos(angle) * 3.8, z = loot.z + Math.sin(angle) * 3.8;
    const hit = world.trace(x, loot.y + 2.6, z, 0, -1, 0, 5.2);
    let supported = hit.hit && hit.ny > 0.72 && Math.abs(hit.y - loot.y) < 1.2 &&
      world.sdf(x, hit.y + 1.7, z) > 0.6 && world.sdf(x, hit.y + 3.1, z) > 0.2;
    if (supported) for (const [ox, oz] of [[1.45, 0], [-1.45, 0], [0, 1.1], [0, -1.1]]) {
      if (world.sdf(x + ox, hit.y + 0.6, z + oz) < 0.1 || world.sdf(x + ox, hit.y - 0.6, z + oz) > 0) { supported = false; break; }
    }
    if (supported) {
      props.push({ x, y: hit.y, z, kind: family[i], yaw: -heading + Math.PI / 2, scale: 0.9 + rng() * 0.2 });
    }
    yield;
  }
  // An upright distress beacon always has the already validated pad root.
  if (props.length < 2) props.push({ ...point, kind: 'beacon', yaw: heading, scale: 1 });
  return { ...point, id, regionKey, cave: true, kind, weapon, loot,
    returnPad: { ...point }, returnTarget: { ...target }, props };
}

/** District discoveries are dense underground; sparse surface access points
 * feed many independently reachable underground returns. */
export function* generateEncounterRegion(
  world: World, cx: number, cz: number, avoid: readonly TeleporterPad[] = [],
): Generator<void, EncounterRegion> {
  const size = ENCOUNTER_REGION_SIZE, x0 = cx * size, z0 = cz * size;
  const result: EncounterRegion = { key: `${cx},${cz}`, pads: [], loot: [], pois: [] };
  if (x0 < -WORLD.BORDER || z0 < -WORLD.BORDER || x0 >= WORLD.BORDER || z0 >= WORLD.BORDER) return result;
  const rng = mulberry32(hash2i(world.seed ^ 0x7e1009, cx, cz));
  const surfaceAvoid = avoid.filter(p => !p.cave), surface: Point[] = [];
  // Two entrances replace the old eight surface pads. Many cave returns
  // share each destination; reducing surface clutter never removes exits.
  for (let i = 0; i < 360 && surface.length < 2; i++) {
    const x = x0 + 64 + rng() * (size - 128), z = z0 + 64 + rng() * (size - 128);
    if (Math.max(Math.abs(x), Math.abs(z)) > WORLD.BORDER - 80) { yield; continue; }
    const y = surfaceSpot(world, x, z);
    if (y !== null) {
      const p = { x, y, z };
      if (surface.every(q => Math.hypot(q.x - p.x, q.z - p.z) >= 360) &&
          surfaceAvoid.every(q => Math.hypot(q.x - p.x, q.z - p.z) >= 130)) surface.push(p);
    }
    yield;
  }
  if (!surface.length) return result;
  const candidates: { p: Point; key: string; authored: boolean }[] = [];
  const seen = new Set<string>();
  for (let iz = Math.floor(z0 / CAVE_CELL); iz <= Math.floor((z0 + size - 1) / CAVE_CELL); iz++) {
    for (let ix = Math.floor(x0 / CAVE_CELL); ix <= Math.floor((x0 + size - 1) / CAVE_CELL); ix++) {
      const sx = (ix + 0.5) * CAVE_CELL, sz = (iz + 0.5) * CAVE_CELL;
      for (const site of world.collectCaveSites(sx - 1, sx + 1, sz - 1, sz + 1)) {
        const center = cavePathPoint(site, site.length);
        const key = `${Math.round(center.x)},${Math.round(center.z)}`;
        if (seen.has(key) || center.x < x0 || center.x >= x0 + size || center.z < z0 || center.z >= z0 + size) continue;
        seen.add(key);
        const p = cavePathPoint(site, Math.min(site.length - 5, 60));
        const col = world.column(p.x, p.z), y = col.cave?.floor;
        if (y !== undefined && world.roofedAbove(p.x, y + 1.6, p.z) &&
            world.sdf(p.x, y + 1.2, p.z) > 1.05) candidates.push({ p: { ...p, y }, key: `gallery:${key}`, authored: true });
      }
      yield;
    }
  }
  // A stratified146m lattice replaces four random deep pads/km2. Each
  // column checks stacked floors as well as elevated mountain caverns.
  const cells = Array.from({ length: 49 }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
  for (const cell of cells) {
    const ix = cell % 7, iz = Math.floor(cell / 7);
    for (let attempt = 0; attempt < 2; attempt++) {
      const x = x0 + (ix + 0.5) * size / 7 + (rng() - 0.5) * 42;
      const z = z0 + (iz + 0.5) * size / 7 + (rng() - 0.5) * 42;
      const floors = sampleCaveFloorLayers(world, x, z, 3, WORLD.MAX_HEIGHT - 9);
      // Rotate floor priority so a district's upper rooms cannot consume
      // all discovery slots before lower landing levels receive anything.
      const offset = floors.length ? Math.floor(rng() * floors.length) : 0;
      for (let i = 0; i < floors.length; i++) {
        const p = floors[(i + offset) % floors.length];
        candidates.push({ p, key: `cell:${cell}:${Math.round(p.y * 2)}`, authored: false });
      }
      yield;
      if (floors.length) break;
    }
  }
  // Visit every sampled cell once before giving its additional floor a
  // second slot. The bounded list remains evenly spread across the region.
  const selectedCells = new Set<string>();
  const ordered = candidates.filter(c => c.authored);
  for (const c of candidates) if (!c.authored) {
    const cell = c.key.split(':').slice(0, 2).join(':');
    if (!selectedCells.has(cell)) { ordered.push(c); selectedCells.add(cell); }
  }
  for (const c of candidates) if (!ordered.includes(c)) ordered.push(c);
  for (const candidate of ordered) {
    if (result.pois.length >= CAVE_POI_REGION_CAP) break;
    if (Math.max(Math.abs(candidate.p.x), Math.abs(candidate.p.z)) > WORLD.BORDER - 50) continue;
    if (!separated(candidate.p, result.pois, 54) || !separated(candidate.p, avoid.filter(p => p.cave), 18)) continue;
    const target = surface.reduce((a, b) => Math.hypot(a.x - candidate.p.x, a.z - candidate.p.z) <
      Math.hypot(b.x - candidate.p.x, b.z - candidate.p.z) ? a : b);
    const poi = yield* createDiscovery(world, result.key, candidate.p, `${result.key}:${candidate.key}`, rng, target);
    if (poi) { result.pois.push(poi); result.loot.push(poi.loot); }
  }
  for (const top of surface) result.pads.push({ ...top, cave: false, partner: -1 });
  for (const poi of result.pois) {
    const partner = surface.findIndex(p => p.x === poi.returnTarget.x && p.z === poi.returnTarget.z);
    const index = result.pads.length;
    result.pads.push({ ...poi.returnPad, cave: true, partner });
    // One chosen cavern is entered from the surface; all returns remain
    // directed to open sky, including other landings and disconnected rooms.
    if (result.pads[partner].partner < 0) result.pads[partner].partner = index;
  }
  // A rare anchor with no nearby underground candidate can enter another
  // discovered cavern. No self-links or cave-to-cave return traps.
  for (let i = 0; i < surface.length; i++) if (result.pads[i].partner < 0) {
    result.pads[i].partner = result.pois.length ? surface.length : (i + 1) % surface.length;
  }
  if (!result.pois.length && surface.length < 2) result.pads.length = 0;
  // New common weapons stay above ground. Cave-exclusive rewards are
  // represented only by the supported discovery records above.
  for (let i = 0; i < surface.length; i++) {
    const top = surface[i];
    for (let attempt = 0; attempt < 6; attempt++) {
      const angle = rng() * Math.PI * 2, x = top.x + Math.cos(angle) * 9, z = top.z + Math.sin(angle) * 9;
      const y = surfaceSpot(world, x, z);
      yield;
      if (y === null) continue;
      result.loot.push({ x, y, z, id: `${result.key}:surface:${i}`, weapon: i % 2 ? 8 : 7, cave: false });
      break;
    }
  }
  return result;
}

/** Shared deterministic generation, with bounded resident data and frame work.
 * Client and server may finish in different frames; the pad destinations agree. */
export class EncounterField {
  private readonly cache = new Map<string, EncounterRegion>();
  private readonly desired = new Set<string>();
  private pending: { key: string; iterator: Generator<void, EncounterRegion> } | null = null;
  private selection: string | null = null;
  private flat: TeleporterPad[];
  private landmarks: CavePOI[] = [];
  revision = 0;

  constructor(private readonly world: World, readonly base: readonly TeleporterPad[] = []) {
    this.flat = base.slice();
  }
  get pads(): readonly TeleporterPad[] { return this.flat; }
  get pois(): readonly CavePOI[] { return this.landmarks; }
  get regions(): readonly EncounterRegion[] { return [...this.cache.values()].filter(r => this.desired.has(r.key)); }
  get stats() { return { cached: this.cache.size, wanted: this.desired.size, pending: this.pending?.key ?? null }; }

  update(points: readonly { x: number; z: number }[], budgetMs = 1, maxSteps = 8): boolean {
    const version = this.revision;
    const cells = [...new Set(points.filter(p => Number.isFinite(p.x + p.z)).map(p =>
      `${Math.floor(p.x / ENCOUNTER_REGION_SIZE)},${Math.floor(p.z / ENCOUNTER_REGION_SIZE)}`))];
    const selection = cells.slice().sort().join(';');
    if (selection !== this.selection) {
      this.selection = selection; this.desired.clear();
      const candidates = new Map<string, number>();
      for (const cell of cells) {
        const [cx, cz] = cell.split(',').map(Number);
        for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx, z = cz + dz;
          const limit = Math.ceil(WORLD.BORDER / ENCOUNTER_REGION_SIZE);
          if (x < -limit || x >= limit || z < -limit || z >= limit) continue;
          const key = `${x},${z}`, distance = dx * dx + dz * dz;
          candidates.set(key, Math.min(candidates.get(key) ?? Infinity, distance));
        }
      }
      for (const [key] of [...candidates].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, ENCOUNTER_CACHE_LIMIT)) this.desired.add(key);
      if (this.pending && !this.desired.has(this.pending.key)) this.pending = null;
      this.rebuild();
    }
    const started = performance.now();
    for (let steps = 0; steps < maxSteps; steps++) {
      if (!this.pending) {
        const key = [...this.desired].find(k => !this.cache.has(k));
        if (!key) break;
        const [cx, cz] = key.split(',').map(Number);
        this.pending = { key, iterator: generateEncounterRegion(this.world, cx, cz, this.base) };
      }
      const next = this.pending.iterator.next();
      if (next.done) {
        this.cache.set(this.pending.key, next.value); this.pending = null;
        for (const key of this.cache.keys()) {
          if (this.cache.size <= ENCOUNTER_CACHE_LIMIT) break;
          if (!this.desired.has(key)) this.cache.delete(key);
        }
        this.rebuild();
      }
      if (performance.now() - started >= budgetMs) break;
    }
    return this.revision !== version;
  }

  private rebuild(): void {
    const pads = this.base.slice();
    const pois: CavePOI[] = [];
    for (const key of this.desired) {
      const region = this.cache.get(key); if (!region) continue;
      const offset = pads.length;
      pads.push(...region.pads.map(p => ({ ...p, partner: p.partner + offset })));
      pois.push(...region.pois);
    }
    this.flat = pads; this.landmarks = pois; this.revision++;
  }
}
