import type { World } from './worldgen.js';
import type { Faction } from './frontier.js';
import { WORLD } from './constants.js';

export const OUTPOST_TYPES = [
  { name: 'Trail shelter', cost: 20, description: 'A raised deck, cover and a roof for your camp.' },
  { name: 'Medical station', cost: 25, description: 'Rest nearby to recover health after combat.' },
  { name: 'Ammo fabricator', cost: 30, description: 'Replenishes ordinary ammunition after combat.' },
] as const;
export const OUTPOST_CELL = 128;
export const OUTPOST_CELL_LIMIT = 4;
export const OUTPOST_OWNER_LIMIT = 6;
export const OUTPOST_VISIBLE_LIMIT = 100; // 5 x 5 cells, at most four in each.
export interface OutpostSite { type: number; x: number; y: number; z: number; facing: number }
export interface Outpost extends OutpostSite { id: number; owner: number; faction: Faction }
export interface CampBox { x: number; y: number; z: number; hx: number; hy: number; hz: number; top?: number; slopeX?: number; slopeZ?: number }
export interface OutpostSnapshot { enabled: boolean; sites: Outpost[] }
export type OutpostAction = { action: 'build'; type: number; x: number; z: number; facing: number } | { action: 'remove'; id: number };
export function outpostCell(x: number, z: number): string { return `${Math.floor(x / OUTPOST_CELL)}:${Math.floor(z / OUTPOST_CELL)}`; }
export function validOutpostSite(s: OutpostSite): boolean {
  return !!s && Number.isInteger(s.type) && s.type >= 0 && s.type < OUTPOST_TYPES.length && Number.isInteger(s.facing) && s.facing >= 0 && s.facing < 4 &&
    [s.x, s.y, s.z].every(Number.isFinite) && Math.abs(s.x) < WORLD.BORDER - 20 && Math.abs(s.z) < WORLD.BORDER - 20 && s.y > WORLD.KILL_Y + 10 && s.y < 1000;
}
export function outpostBoxes(site: OutpostSite): CampBox[] {
  const b: CampBox[] = [], add = (x: number, y: number, z: number, hx: number, hy: number, hz: number) => b.push({ x, y, z, hx, hy, hz });
  if (site.type === 0) {
    add(0, -.22, 0, 3, .42, 3);
    // The raised floor can sit above uneven ground. This clipped box is a
    // continuous 40% entrance ramp, shared by rendering and capsule contacts.
    b.push({ x: 0, y: -.4, z: 4.1, hx: 1.5, hy: .6, hz: 1.3, top: -.32, slopeX: 0, slopeZ: .4 });
    add(0, 3.15, 0, 3.15, .15, 3.15);
    for (const x of [-2.8, 2.8]) for (const z of [-2.8, 2.8]) add(x, 1.65, z, .16, 1.45, .16);
    add(0, 1.15, -2.8, 2.6, .95, .14);
    for (const x of [-2.8, 2.8]) add(x, .7, 0, .14, .5, 2.65);
  } else {
    add(0, -.18, 0, 1.35, .38, 1.35);
    add(0, .95, 0, .72, .75, .65);
    add(0, 1.82, 0, .92, .12, .83);
  }
  const a = site.facing * Math.PI / 2, c = Math.round(Math.cos(a)), s = Math.round(Math.sin(a));
  return b.map(v => ({ x: site.x + c * v.x + s * v.z, y: site.y + v.y, z: site.z - s * v.x + c * v.z,
    hx: Math.abs(c) * v.hx + Math.abs(s) * v.hz, hy: v.hy, hz: Math.abs(s) * v.hx + Math.abs(c) * v.hz,
    ...(v.top === undefined ? {} : { top: site.y + v.top, slopeX: s * v.slopeZ!, slopeZ: c * v.slopeZ! }) }));
}
function boxDistance(b: CampBox, x: number, y: number, z: number): number {
  const dx = Math.abs(x - b.x) - b.hx, dy = Math.abs(y - b.y) - b.hy, dz = Math.abs(z - b.z) - b.hz;
  const box = Math.hypot(Math.max(0, dx), Math.max(0, dy), Math.max(0, dz)) + Math.min(0, Math.max(dx, dy, dz));
  return b.top === undefined ? box : Math.max(box, (y - b.top + (x - b.x) * b.slopeX! + (z - b.z) * b.slopeZ!) / Math.hypot(1, b.slopeX!, b.slopeZ!));
}
/** Mutable structures never enter terrain meshing. The main client and server
 * use the same boxes for movement, projectiles and line-of-sight queries. */
export class OutpostField {
  readonly sites = new Map<number, Outpost>();
  private readonly cells = new Map<string, { site: Outpost; boxes: CampBox[] }[]>();
  private readonly versions = new Map<string, number>();
  private revision = 0;
  private collisionX = NaN;
  private collisionZ = NaN;
  private collisionRevision = -1;
  private collisionBoxes: CampBox[] = [];
  replace(sites: readonly Outpost[]): void {
    this.sites.clear(); this.cells.clear(); this.versions.clear();
    for (const site of sites) this.add(site);
  }
  add(site: Outpost): void {
    this.remove(site.id);
    const key = outpostCell(site.x, site.z), entries = this.cells.get(key) ?? [];
    entries.push({ site, boxes: outpostBoxes(site) }); this.cells.set(key, entries); this.sites.set(site.id, site);
    this.versions.set(key, ++this.revision);
  }
  remove(id: number): void {
    const site = this.sites.get(id); if (!site) return;
    const key = outpostCell(site.x, site.z), entries = this.cells.get(key)!.filter(e => e.site.id !== id);
    if (entries.length) this.cells.set(key, entries); else this.cells.delete(key);
    this.sites.delete(id);
    this.revision++;
    if (entries.length) this.versions.set(key, this.revision); else this.versions.delete(key);
  }
  nearby(x: number, z: number): Outpost[] {
    const result: Outpost[] = [], cx = Math.floor(x / OUTPOST_CELL), cz = Math.floor(z / OUTPOST_CELL);
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (const e of this.cells.get(`${cx + dx}:${cz + dz}`) ?? []) result.push(e.site);
    return result;
  }
  stamp(x: number, z: number): string {
    const cx = Math.floor(x / OUTPOST_CELL), cz = Math.floor(z / OUTPOST_CELL), result = [cx, cz];
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) result.push(this.versions.get(`${cx + dx}:${cz + dz}`) ?? 0);
    return result.join(':');
  }
  distance(x: number, y: number, z: number, original: number): number {
    if (!this.sites.size) return original;
    // Beyond the 3x3 collision neighborhood the nearest omitted structure is
    // at least one cell minus its extent away. Keep sphere traces conservative.
    let distance = Math.min(original, OUTPOST_CELL - 6);
    const cx = Math.floor(x / OUTPOST_CELL), cz = Math.floor(z / OUTPOST_CELL);
    // A capsule evaluates many neighboring probes. Resolve its cell once,
    // avoiding nine string keys/map lookups for every SDF contact probe.
    if (cx !== this.collisionX || cz !== this.collisionZ || this.revision !== this.collisionRevision) {
      this.collisionX = cx; this.collisionZ = cz; this.collisionRevision = this.revision; this.collisionBoxes = [];
      for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) for (const e of this.cells.get(`${cx + dx}:${cz + dz}`) ?? []) this.collisionBoxes.push(...e.boxes);
    }
    for (const box of this.collisionBoxes) distance = Math.min(distance, boxDistance(box, x, y, z));
    return distance;
  }
}
export function mayUseOutpost(site: Outpost, owner: number, faction: Faction): boolean {
  return site.owner === owner || site.faction === faction;
}
/** Shared preview rules; authoritative callers also check people, vehicles,
 * inventory, lease, density, owner limits and concurrent reservations. */
export function planOutpost(world: World, type: number, x: number, z: number, facing: number): { site: OutpostSite; reason: string | null } {
  const site = { type, x, y: 0, z, facing }, fail = (reason: string) => ({ site, reason });
  if (!validOutpostSite(site)) return fail('Choose a valid site inside the frontier.');
  if (world.collectCities().some(c => Math.hypot(x - c.x, z - c.z) < c.radius + 100)) return fail('Build beyond the city outskirts.');
  const plan = world.collectTransportPlan();
  if ([...plan.stations, ...plan.harbors, ...plan.pods].some(s => Math.hypot(x - s.x, z - s.z) < 180)) return fail('Keep transit areas clear.');
  const col = world.column(x, z);
  if (col.road && col.road.distance < col.road.width + 15) return fail('Leave roads and trails clear.');
  const radius = type === 0 ? 3.4 : 1.6, heights: number[] = [];
  for (const dx of [-radius, 0, radius]) for (const dz of [-radius, 0, radius]) {
    const px = x + dx, pz = z + dz, h = world.groundY(px, pz);
    if (Math.abs(h - world.terrainHeight(px, pz)) > .8 || world.liquidAt(px, h + .1, pz)) return fail('Find dry, solid surface ground.');
    heights.push(h);
  }
  if (Math.max(...heights) - Math.min(...heights) > .65) return fail('Find a more level patch of ground.');
  site.y = Math.max(...heights) + .03;
  if (!validOutpostSite(site)) return fail('This ground cannot support a camp.');
  for (const existing of world.outposts.nearby(x, z)) if (Math.hypot(x - existing.x, z - existing.z) < (type === 0 ? 5.5 : 1.7) + (existing.type === 0 ? 5.5 : 1.7) + 1) return fail('Leave room between camp modules.');
  if (type === 0) {
    const a = facing * Math.PI / 2, rx = x + Math.sin(a) * 5.4, rz = z + Math.cos(a) * 5.4;
    if (world.groundY(rx, rz) < site.y - 1 || world.sdf(rx, site.y + .4, rz) < .12) return fail('The entrance ramp needs clear, supported ground.');
  }
  // Probe the occupied volume, not just its base: reject rocks, trees, roofs
  // and overhanging infrastructure before installing any dynamic collision.
  for (const dx of [-radius, 0, radius]) for (const dz of [-radius, 0, radius]) for (const dy of [.35, 1, 2, 3.5])
    if (world.sdf(x + dx, site.y + dy, z + dz) < .12) return fail('This site overlaps terrain or a structure.');
  return { site, reason: null };
}
