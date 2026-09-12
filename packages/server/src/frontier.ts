import type { World } from '@shared/worldgen';
import { CAPTURE_SECONDS, DISCOVERY_REWARD, FACTION_COOLDOWN_SECONDS, isFaction, type Faction, type FrontierState, type Territory } from '@shared/frontier';
import { TICK_RATE, PLAYER } from '@shared/constants';
import { encodeServerMessage } from '@shared/protocol';
import { encodeFrontierState } from '@shared/frontier-wire';
import type { ServerPlayer } from './game.js';
import { SpatialIndex } from './spatial-index.js';

export class Frontier {
  readonly territories: Territory[];
  revision = 0;
  private readonly index = new SpatialIndex<ServerPlayer>(256);

  constructor(readonly world: World) {
    this.territories = [];
    for (const city of world.collectCities()) {
      // Meridian has a front through three connected street junctions.
      // Other cities remain kilometres apart, linked by the existing transit.
      for (const offset of city.id === 0 ? [-128, 0, 128] : [0]) {
        this.territories.push({ id: `city-${city.id}-${offset}`, name: city.name + (city.id === 0 ? offset < 0 ? ' · West relay' : offset > 0 ? ' · East relay' : ' · Exchange' : ''),
          kind: 'city', x: city.x + offset, y: city.y + .06, z: city.z,
          radius: city.id === 0 ? 42 : 70,
          owner: city.id === 0 ? offset < 0 ? 1 : offset > 0 ? 2 : 0 : city.id % 2 ? 2 : 1,
          influence: city.id === 0 ? offset < 0 ? -1 : offset > 0 ? 1 : 0 : city.id % 2 ? 1 : -1,
          contested: false });
      }
    }
    for (const [i, harbor] of world.collectTransportPlan().harbors.entries()) {
      this.territories.push({ id: `harbor-${i}`, name: harbor.name, kind: 'harbor',
        x: harbor.x, y: world.groundY(harbor.x, harbor.z), z: harbor.z,
        radius: 55, owner: 0, influence: 0, contested: false });
    }
  }

  restore(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const saved = data as { seed?: number; territories?: unknown[] };
    if (saved.seed !== this.world.seed || !Array.isArray(saved.territories)) return;
    for (const raw of saved.territories) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Partial<Territory>, site = this.territories.find(s => s.id === row.id);
      if (!site || !isFaction(row.owner) || typeof row.influence !== 'number' || !Number.isFinite(row.influence)) continue;
      site.owner = row.owner; site.influence = Math.max(-1, Math.min(1, row.influence));
    }
  }
  save(): object { return { version: 1, seed: this.world.seed, territories: this.territories.map(({ id, owner, influence }) => ({ id, owner, influence })) }; }

  enlist(player: ServerPlayer, faction: unknown, tick: number): string | null {
    if (!isFaction(faction)) return 'Unknown faction';
    if (player.faction === faction) return null;
    if (!player.state.alive || player.state.vehicle || player.state.airlift) return 'Enlist or stand down while on foot.';
    if (tick < player.factionChangeAt || tick < player.regenBlockUntil) return 'Leave combat and wait before changing allegiance.';
    player.faction = faction;
    player.factionChangeAt = tick + FACTION_COOLDOWN_SECONDS * TICK_RATE;
    return null;
  }

  step(players: Iterable<ServerPlayer>, tick: number, dt: number): void {
    this.index.clear();
    for (const player of players) {
      if (!player.state.alive || player.state.airlift) continue;
      this.index.insert(player, player.state.px, player.state.pz);
      if (player.isBot) continue;
      for (const city of this.world.collectCities()) {
        const key = `${this.world.seed}:city-${city.id}`;
        if (player.discoveries.has(key) || Math.hypot(player.state.px - city.x, player.state.pz - city.z) > city.radius) continue;
        player.discoveries.add(key); player.salvage += DISCOVERY_REWARD;
        player.sink?.send(encodeServerMessage(`Charted ${city.name} · +${DISCOVERY_REWARD} salvage`));
      }
    }
    this.index.compact();
    for (const site of this.territories) {
      let accord = 0, helix = 0;
      for (const player of this.index.query(site.x, site.z, site.radius)) {
        const s = player.state;
        if (!player.faction || s.vehicle || Math.abs(s.py - site.y) > 6 || Math.hypot(s.px - site.x, s.pz - site.z) > site.radius) continue;
        const weight = player.isBot ? .2 : 1;
        if (player.faction === 1) accord += weight; else helix += weight;
        if (player.faction === site.owner && tick >= player.regenBlockUntil) player.health = Math.min(PLAYER.MAX_HEALTH, player.health + dt * 4);
      }
      site.contested = accord > 0 && helix > 0;
      if (site.contested || (!accord && !helix)) continue;
      const delta = Math.min(3, accord || helix) * (accord ? -1 : 1) * dt / CAPTURE_SECONDS;
      const before = site.influence;
      site.influence = Math.max(-1, Math.min(1, site.influence + delta));
      if ((before < 0 && site.influence >= 0) || (before > 0 && site.influence <= 0)) site.owner = 0;
      if (site.influence <= -1) site.owner = 1;
      if (site.influence >= 1) site.owner = 2;
    }
    this.revision++;
  }

  objective(player: ServerPlayer): Territory | null {
    let best: Territory | null = null, distance = Infinity;
    for (const site of this.territories) {
      if (site.owner === player.faction && !site.contested) continue;
      const d = Math.hypot(player.state.px - site.x, player.state.pz - site.z);
      if (d < distance) { best = site; distance = d; }
    }
    return best;
  }

  snapshot(player: ServerPlayer, nearby: Iterable<ServerPlayer>, tick: number): FrontierState {
    return { revision: this.revision, territories: this.territories,
      you: { faction: player.faction, salvage: player.salvage, discoveries: [...player.discoveries],
        factionCooldown: Math.max(0, Math.ceil((Math.max(player.factionChangeAt, player.regenBlockUntil) - tick) / TICK_RATE)) },
      nearby: [...nearby].map(p => ({ id: p.id, faction: p.faction })).slice(0, 128) };
  }
  send(player: ServerPlayer, nearby: Iterable<ServerPlayer>, tick: number): void {
    player.sink?.send(encodeFrontierState(this.snapshot(player, nearby, tick)));
  }
}
