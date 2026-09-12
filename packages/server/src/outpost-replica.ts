import { validOutpostSite, outpostCell, OUTPOST_CELL_LIMIT, type Outpost, type OutpostField, type OutpostSite } from '@shared/outposts';
import { isFaction } from '@shared/frontier';
import type { RegionBounds } from '@shared/regions';
import type { PlanetId } from '@shared/universe';
import type { AuthorityToken } from './region-transfers.js';
import { OUTPOST_REGION_HALO } from './outpost-ledger.js';

export interface OutpostCursor {
  authority: AuthorityToken; planet: PlanetId; region: string; layoutVersion: number; revision: number;
}
export interface RegionalOutposts { cursor: OutpostCursor; bounds: RegionBounds; sites: Outpost[] | null }
export interface OutpostCellUpdate { key: string; revision: number; sites: Outpost[] }
export function sameOutpostScope(a: OutpostCursor, b: OutpostCursor): boolean {
  return a.authority.id === b.authority.id && a.authority.epoch === b.authority.epoch &&
    a.planet === b.planet && a.region === b.region && a.layoutVersion === b.layoutVersion;
}
const contains = (b: RegionBounds, s: { x: number; z: number }) =>
  s.x >= b.minX && s.x < b.maxX && s.z >= b.minZ && s.z < b.maxZ;
function validSite(site: Outpost): boolean {
  return validOutpostSite(site) && Number.isSafeInteger(site.id) && site.id > 0 &&
    Number.isSafeInteger(site.owner) && site.owner > 0 && isFaction(site.faction);
}
function sameSite(a: Outpost, b: Outpost): boolean {
  return a.id === b.id && a.owner === b.owner && a.faction === b.faction && a.type === b.type &&
    a.x === b.x && a.y === b.y && a.z === b.z && a.facing === b.facing;
}

/** A regional collider view, including read-only neighboring camps. A late
 * heartbeat cannot erase a just-built wall; a late build reply cannot revive
 * a packed module. Complete cell updates preserve concurrent changes without
 * starving the regional freshness lease while builders are active. */
export class OutpostReplica {
  private epoch: number | undefined;
  private current: OutpostCursor | undefined;
  private bounds: RegionBounds | undefined;
  private readonly cells = new Map<string, number>();
  constructor(private readonly field: OutpostField, private readonly owner: { id: string; planet: PlanetId; region: string }) {}
  bind(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || this.epoch !== undefined && this.epoch !== epoch)
      throw new Error('Camp authority changed');
    this.epoch = epoch;
  }
  get cursor(): OutpostCursor | undefined {
    return this.current ? { ...this.current, authority: { ...this.current.authority } } : undefined;
  }
  apply(view: RegionalOutposts): boolean {
    const c = view?.cursor, b = view?.bounds;
    if (!c || !b || this.epoch === undefined || c.authority?.id !== this.owner.id || c.authority.epoch !== this.epoch ||
        c.planet !== this.owner.planet || c.region !== this.owner.region || b.id !== c.region ||
        !Number.isSafeInteger(c.revision) || c.revision < 0 || !Number.isSafeInteger(c.layoutVersion) || c.layoutVersion < 1 ||
        ![b.minX, b.maxX, b.minZ, b.maxZ].every(Number.isFinite) || b.minX >= b.maxX || b.minZ >= b.maxZ ||
        this.current && (!sameOutpostScope(c, this.current) || this.bounds &&
          ['minX', 'maxX', 'minZ', 'maxZ'].some(k => b[k as keyof RegionBounds] !== this.bounds![k as keyof RegionBounds])))
      throw new Error('Invalid regional camp snapshot');
    if (c.revision < (this.current?.revision ?? 0)) return false;
    if (view.sites === null) {
      if (!this.current || c.revision !== this.current.revision) throw new Error('Camp snapshot has no baseline');
      return true;
    }
    if (!Array.isArray(view.sites) || view.sites.length > 8192 || view.sites.some(s => !validSite(s) ||
        s.x < b.minX - OUTPOST_REGION_HALO || s.x >= b.maxX + OUTPOST_REGION_HALO ||
        s.z < b.minZ - OUTPOST_REGION_HALO || s.z >= b.maxZ + OUTPOST_REGION_HALO) ||
        new Set(view.sites.map(s => s.id)).size !== view.sites.length) throw new Error('Invalid regional camp geometry');
    // A newer committed cell is a complete authoritative set, including
    // removals. Preserve that whole set while advancing the rest of the view.
    // Keeping only individual new modules could reintroduce a module packed
    // between the older snapshot and that construction transaction.
    const newer = (s: Outpost) => (this.cells.get(outpostCell(s.x, s.z)) ?? 0) > c.revision;
    const merged = view.sites.filter(s => !newer(s));
    for (const site of this.field.sites.values()) if (newer(site)) merged.push(site);
    this.replace(merged);
    this.current = { ...c, authority: { ...c.authority } }; this.bounds = { ...b };
    for (const [key, revision] of this.cells) if (revision <= c.revision) this.cells.delete(key);
    return true;
  }
  commit(cell: OutpostCellUpdate, location: OutpostSite): boolean {
    if (!this.current || !this.bounds || !cell || !validOutpostSite(location) ||
        !Number.isSafeInteger(cell.revision) || cell.revision < 1 || cell.key !== outpostCell(location.x, location.z) ||
        !Array.isArray(cell.sites) || cell.sites.length > OUTPOST_CELL_LIMIT ||
        cell.sites.some(s => !validSite(s) || outpostCell(s.x, s.z) !== cell.key) ||
        new Set(cell.sites.map(s => s.id)).size !== cell.sites.length) throw new Error('Invalid camp mutation receipt');
    if (!contains(this.bounds, location)) throw new Error('Cannot mutate a neighboring camp replica');
    if (cell.revision <= Math.max(this.current.revision, this.cells.get(cell.key) ?? 0)) return false;
    const merged = [...this.field.sites.values()].filter(s => outpostCell(s.x, s.z) !== cell.key);
    this.replace([...merged, ...cell.sites]); this.cells.set(cell.key, cell.revision);
    return true;
  }
  private replace(sites: Outpost[]): void {
    // Preserve unchanged cell stamps, so a camp elsewhere in this region
    // does not resend every player's local construction snapshot.
    const ids = new Set(sites.map(s => s.id));
    for (const id of this.field.sites.keys()) if (!ids.has(id)) this.field.remove(id);
    for (const site of sites) {
      const old = this.field.sites.get(site.id);
      if (!old || !sameSite(old, site)) this.field.add(site);
    }
  }
}
