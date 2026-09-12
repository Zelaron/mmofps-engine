import { OUTPOST_TYPES, OUTPOST_CELL_LIMIT, OUTPOST_OWNER_LIMIT, outpostCell, planOutpost, mayUseOutpost, type OutpostSite, type Outpost } from '@shared/outposts';
import { encodeOutposts } from '@shared/outpost-wire';
import { PLAYER } from '@shared/constants';
import { WEAPONS } from '@shared/weapons';
import type { Game, ServerPlayer } from './game.js';

export class OutpostSystem {
  enabled = false;
  readonly reservations = new Set<OutpostSite>();
  private readonly sent = new Map<number, string>();
  constructor(private readonly game: Game) {}
  prepare(p: ServerPlayer, type: number, x: number, z: number, facing: number): OutpostSite {
    this.canWork(p);
    if (Math.hypot(x - p.state.px, z - p.state.pz) > 10) throw new Error('Build within ten metres.');
    const { site, reason } = planOutpost(this.game.world, type, x, z, facing);
    if (reason) throw new Error(reason);
    if (Math.abs(site.y - p.state.py) > 3) throw new Error('Reach the site on foot first.');
    if (p.salvage < OUTPOST_TYPES[type].cost) throw new Error('Not enough salvage. Discover another city.');
    const field = this.game.world.outposts, nearby = field.nearby(x, z), key = outpostCell(x, z);
    if ([...field.sites.values()].filter(s => s.owner === p.id).length >= OUTPOST_OWNER_LIMIT) throw new Error('Pack an old module before building another.');
    if (nearby.filter(s => outpostCell(s.x, s.z) === key).length + [...this.reservations].filter(s => outpostCell(s.x, s.z) === key).length >= OUTPOST_CELL_LIMIT) throw new Error('This patch already has four modules. Build farther away.');
    if ([...this.reservations].some(s => Math.hypot(s.x - x, s.z - z) < 8)) throw new Error('Another builder is working here.');
    const clearance = type === 0 ? 6.3 : 2.5;
    for (const other of this.game.players.values()) if (other.state.alive && Math.abs(other.state.py - site.y) < 5 && Math.hypot(other.state.px - x, other.state.pz - z) < clearance) throw new Error('Keep the site clear of people.');
    for (const v of this.game.vehicles.values()) if (Math.abs(v.y - site.y) < 12 && Math.hypot(v.x - x, v.z - z) < 15) throw new Error('Move away from vehicles before building.');
    const dx = x - p.state.px, dy = site.y + 1 - p.state.py - PLAYER.EYE_HEIGHT, dz = z - p.state.pz, distance = Math.hypot(dx, dy, dz);
    if (this.game.world.trace(p.state.px, p.state.py + PLAYER.EYE_HEIGHT, p.state.pz, dx / distance, dy / distance, dz / distance, distance - .1).hit) throw new Error('You need a clear view of the site.');
    this.reservations.add(site); return site;
  }
  canWork(p: ServerPlayer): void {
    if (!this.enabled) throw new Error('Construction is unavailable on this world.');
    if (!p.state.alive || p.state.vehicle || p.state.airlift || !p.state.grounded) throw new Error('Build while standing on solid ground.');
    if (this.game.tick < p.regenBlockUntil) throw new Error('Leave combat before working on camp.');
  }
  prepareRemoval(p: ServerPlayer, id: number): Outpost {
    this.canWork(p);
    const site = this.game.world.outposts.sites.get(id);
    if (!site || site.owner !== p.id) throw new Error('Only the owner can pack this module.');
    if (Math.hypot(site.x - p.state.px, site.y - p.state.py, site.z - p.state.pz) > 10) throw new Error('Reach your module before packing it.');
    for (const other of this.game.players.values()) if (other.state.alive && Math.abs(other.state.py - site.y) < 5 && Math.hypot(other.state.px - site.x, other.state.pz - site.z) < (site.type === 0 ? 6.3 : 2.5)) throw new Error('Everyone must step clear before packing.');
    return site;
  }
  forget(id: number): void { this.sent.delete(id); }
  send(p: ServerPlayer, force = false): void {
    if (!p.sink) return;
    const field = this.game.world.outposts, stamp = `${this.enabled}:${field.stamp(p.state.px, p.state.pz)}`;
    if (!force && this.sent.get(p.id) === stamp) return;
    p.sink.send(encodeOutposts({ enabled: this.enabled, sites: field.nearby(p.state.px, p.state.pz) })); this.sent.set(p.id, stamp);
  }
  step(): void {
    for (const p of this.game.players.values()) {
      if (p.isBot) continue;
      this.send(p);
      if (!p.state.alive || p.state.vehicle || p.state.airlift || this.game.tick < p.regenBlockUntil) continue;
      const services = new Set<number>();
      for (const site of this.game.world.outposts.nearby(p.state.px, p.state.pz)) {
        if (site.type === 0 || !mayUseOutpost(site, p.id, p.faction) || Math.hypot(site.x - p.state.px, site.y - p.state.py, site.z - p.state.pz) > 5) continue;
        const dx = site.x - p.state.px, dy = site.y + 2.3 - p.state.py - PLAYER.EYE_HEIGHT, dz = site.z - p.state.pz, distance = Math.hypot(dx, dy, dz);
        if (distance > .1 && this.game.world.trace(p.state.px, p.state.py + PLAYER.EYE_HEIGHT, p.state.pz, dx / distance, dy / distance, dz / distance, distance - .1).hit) continue;
        services.add(site.type);
      }
      if (services.has(1)) p.health = Math.min(PLAYER.MAX_HEALTH, p.health + 6);
      if (services.has(2)) for (const def of WEAPONS) if (!def.spawnEmpty && !def.infiniteReserve) {
        const a = p.ammo[def.id]; a.reserve = Math.min(def.reserveSize, a.reserve + Math.max(1, Math.ceil(def.magazineSize / 5)));
      }
    }
  }
}
