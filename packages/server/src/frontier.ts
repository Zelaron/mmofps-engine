import type { World } from '@shared/worldgen';
import { CAPTURE_SECONDS, DISCOVERY_REWARD, FACTION_COOLDOWN_SECONDS, FACTIONS, PLANET_CAMPAIGN_REWARD, inCaptureRange, isFaction, type CampaignBase, type CampaignOrder, type SpawnOption, type Faction, type FrontierState, type Territory } from '@shared/frontier';
import { campaignLayout, campaignPoint } from './campaign-layout.js';
import { TICK_RATE, PLAYER } from '@shared/constants';
import { encodeServerMessage } from '@shared/protocol';
import { encodeFrontierState } from '@shared/frontier-wire';
import type { ServerPlayer } from './game.js';
import { SpatialIndex } from './spatial-index.js';
import { ReinforcementPlanner } from './reinforcements.js';
import { CampaignDirector } from './campaign-director.js';
import { planetBySeed } from '@shared/universe';

export interface CampaignAlert { baseId: string; baseName: string; attacker: Faction; defender: Faction; message: string }

export class Frontier {
  readonly territories: Territory[];
  readonly bases: CampaignBase[];
  revision = 0;
  mobileSpawns: (player: ServerPlayer) => SpawnOption[] = () => [];
  threatReports: (player: ServerPlayer) => NonNullable<FrontierState['threats']> = () => [];
  spawnActors: () => Iterable<ServerPlayer> = () => this.actors;
  campaignAlert: (alert: CampaignAlert) => void = () => {};
  readonly reinforcementPlanner: ReinforcementPlanner;
  private actors: ServerPlayer[] = [];
  private currentTick = 0;
  private readonly director: CampaignDirector;
  private readonly attackSeenAt = new Map<string, number>();
  private readonly reserves = new Map<Faction, SpawnOption>();
  private readonly index = new SpatialIndex<ServerPlayer>(256);
  private readonly combat = new Map<string, { x: number; z: number; tick: number; weight: number; factions: Set<number> }>();

  /** Coarse, short-lived reports show battles without exposing individual
   * player positions or keeping an unbounded combat history. */
  recordCombat(x: number, z: number, factions: number[], tick: number): void {
    if (![x, z, tick].every(Number.isFinite)) return;
    this.reinforcementPlanner.recordCombat(x, z, tick);
    const cell = 256, ix = Math.floor(x / cell), iz = Math.floor(z / cell), id = `${ix},${iz}`;
    const old = this.combat.get(id), active = old && tick - old.tick < 30 * TICK_RATE;
    const row = active ? old : { x: (ix + .5) * cell, z: (iz + .5) * cell, tick, weight: 0, factions: new Set<number>() };
    row.tick = tick; row.weight = Math.min(20, row.weight + 1);
    for (const faction of factions) if (faction > 0 && isFaction(faction)) row.factions.add(faction);
    this.combat.delete(id); this.combat.set(id, row);
    if (this.combat.size > 64) this.combat.delete(this.combat.keys().next().value!);
  }

  battleReports(tick: number): NonNullable<FrontierState['battles']> {
    const reports: NonNullable<FrontierState['battles']> = [];
    for (const [id, row] of this.combat) {
      const age = (tick - row.tick) / TICK_RATE;
      if (age >= 30) { this.combat.delete(id); continue; }
      const nearest = this.bases.reduce((a, b) => Math.hypot(a.x - row.x, a.z - row.z) < Math.hypot(b.x - row.x, b.z - row.z) ? a : b);
      reports.push({ id, x: row.x, z: row.z, intensity: Math.max(.1, Math.min(1, row.weight / 12) * (1 - age / 30)),
        factions: [...row.factions].sort(), name: Math.hypot(nearest.x - row.x, nearest.z - row.z) < 1200 ? `${nearest.name} engagement` : 'Frontier engagement' });
    }
    return reports.sort((a, b) => b.intensity - a.intensity).slice(0, 12);
  }

  constructor(readonly world: World) {
    const layout = campaignLayout(world);
    this.territories = layout.territories; this.bases = layout.bases;
    this.reinforcementPlanner = new ReinforcementPlanner(world, this.territories);
    this.director = new CampaignDirector(this.bases, this.territories);
    for (const faction of [1, 2, 3] as const) {
      const home = this.bases.find(b => b.homeFaction === faction) ?? this.bases.find(b => b.owner === faction);
      if (home) {
        const scale = Math.hypot(home.x, home.z) || 1;
        const point = campaignPoint(world, home.x - home.x / scale * 220, home.z - home.z / scale * 220);
        this.reserves.set(faction, { ...point, id: `reserve-${faction}`, name: `${FACTIONS[faction].name} coastal reinforcements`, kind: 'base' });
      }
    }
  }

  restore(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const saved = data as { version?: number; seed?: number; territories?: unknown[] };
    if (saved.seed !== this.world.seed || !Array.isArray(saved.territories)) return;
    const restored = new Set<string>();
    for (const raw of saved.territories) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Partial<Territory>, site = this.territories.find(s => s.id === row.id);
      if (!site || !isFaction(row.owner) || typeof row.influence !== 'number' || !Number.isFinite(row.influence)) continue;
      site.owner = row.owner; site.influence = Math.max(-1, Math.min(1, row.influence));
      site.captureFaction = isFaction(row.captureFaction) ? row.captureFaction : site.owner || (site.influence < 0 ? 1 : site.influence > 0 ? 2 : 0);
      site.captureProgress = typeof row.captureProgress === 'number' && Number.isFinite(row.captureProgress) ? Math.max(0, Math.min(1, row.captureProgress)) : Math.abs(site.influence);
      restored.add(site.id);
    }
    if ((saved.version ?? 1) < 3) for (const base of this.bases) {
      const controls = this.territories.filter(t => t.baseId === base.id), old = controls.filter(t => restored.has(t.id));
      // Former single-flag cities/harbors retain their captured allegiance.
      // Unclaimed old sites can receive the new coastal campaign footholds.
      if (old.length !== 1 || !old[0].owner) continue;
      for (const control of controls.filter(t => !restored.has(t.id))) {
        control.owner = old[0].owner; control.captureFaction = old[0].owner;
        control.captureProgress = 1; control.influence = old[0].owner === 1 ? -1 : 1;
      }
    }
    this.reconcileBases();
    this.director.reset();
  }
  save(): object { return { version: 3, seed: this.world.seed, territories: this.territories.map(({ id, owner, influence, captureFaction, captureProgress }) => ({ id, owner, influence, captureFaction, captureProgress })) }; }

  enlist(player: ServerPlayer, faction: unknown, tick: number): string | null {
    if (!isFaction(faction) || !faction) return 'Choose a fighting faction.';
    if (player.faction === faction) return null;
    if (!player.state.alive || player.state.vehicle || player.state.airlift) return 'Change faction while on foot.';
    if (tick < player.factionChangeAt || tick < player.regenBlockUntil) return 'Leave combat and wait before changing allegiance.';
    player.faction = faction; player.preferredSpawnId = '';
    player.factionChangeAt = tick + FACTION_COOLDOWN_SECONDS * TICK_RATE;
    return null;
  }

  step(players: Iterable<ServerPlayer>, tick: number, dt: number): void {
    this.actors = [...players]; this.currentTick = tick;
    this.index.clear();
    for (const player of this.actors) {
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
      site.captureRate = 0; site.progressRate = 0; site.pressureFaction = 0;
      const presence = [0, 0, 0, 0];
      for (const player of this.index.query(site.x, site.z, site.radius)) {
        const s = player.state;
        if (!player.faction || s.vehicle || !inCaptureRange(site, s.px, s.py, s.pz)) continue;
        presence[player.faction] += player.isBot ? .2 : 1;
        if (player.faction === site.owner && tick >= player.regenBlockUntil) player.health = Math.min(PLAYER.MAX_HEALTH, player.health + dt * 4);
      }
      const factions = ([1, 2, 3] as const).filter(f => presence[f] > 0);
      site.contested = factions.length > 1;
      this.reinforcementPlanner.observeControl(site, factions, tick);
      if (site.owner) for (const attacker of factions.filter(f => f !== site.owner)) this.announceAttack(site, attacker, tick);
      if (site.contested && tick % TICK_RATE < 12) this.recordCombat(site.x, site.z, factions, tick);
      if (site.contested || !factions.length) continue;
      const faction = factions[0], delta = Math.min(3, presence[faction]) * dt / CAPTURE_SECONDS;
      const previousOwner = site.owner, beforeInfluence = site.influence;
      let claimant = site.captureFaction ?? site.owner, progress = site.captureProgress ?? Math.abs(site.influence);
      // Legacy worlds (and tools editing their old signed field) remain loadable.
      if (Math.abs(progress - Math.abs(site.influence)) > 1e-8 || (!site.owner && site.influence === 0)) {
        progress = Math.abs(site.influence); claimant = site.owner || (site.influence < 0 ? 1 : site.influence > 0 ? 2 : 0);
      }
      const before = progress, reducing = claimant !== 0 && claimant !== faction;
      if (reducing) {
        progress -= delta;
        if (progress <= 1e-10) { site.owner = 0; progress = Math.max(0, -progress); claimant = progress ? faction : 0; }
      } else { claimant = faction; progress += delta; }
      progress = Math.min(1, progress);
      if (progress >= 1 && claimant === faction) site.owner = faction;
      site.captureFaction = claimant; site.captureProgress = progress; site.pressureFaction = faction;
      site.influence = claimant === 1 ? -progress : progress;
      site.captureRate = dt > 0 ? (site.influence - beforeInfluence) / dt : 0;
      site.progressRate = dt > 0 && (before !== progress || reducing) ? (reducing ? -1 : 1) * Math.min(3, presence[faction]) / CAPTURE_SECONDS : 0;
      if (site.owner !== previousOwner) {
        const message = encodeServerMessage(site.owner
          ? `${FACTIONS[site.owner].name} captured ${site.name}.`
          : `${site.name} neutralized. Hold the zone to capture it.`);
        for (const player of this.index.query(site.x, site.z, site.radius * 3)) {
          if (Math.hypot(player.state.px - site.x, player.state.pz - site.z) <= site.radius * 3) player.sink?.send(message);
          if (site.owner && player.faction === site.owner && !player.isBot && !player.state.vehicle &&
            inCaptureRange(site, player.state.px, player.state.py, player.state.pz) && !player.campaignRewards.includes(this.world.seed)) {
            player.campaignRewards.push(this.world.seed); player.salvage += PLANET_CAMPAIGN_REWARD;
            player.sink?.send(encodeServerMessage(`${planetBySeed(this.world.seed).name} campaign contract completed · +${PLANET_CAMPAIGN_REWARD} salvage.`));
          }
        }
      }
    }
    this.reconcileBases(true);
    this.director.update(this.actors, tick);
    this.revision++;
  }

  private reconcileBases(announce = false): void {
    for (const base of this.bases) {
      const controls = this.territories.filter(t => t.baseId === base.id), previous = base.owner;
      base.owner = ([1, 2, 3] as const).find(f => controls.filter(t => t.owner === f).length >= base.requiredPoints) ?? 0;
      if (announce && previous !== base.owner) for (const p of this.actors) p.sink?.send(encodeServerMessage(base.owner
        ? `${FACTIONS[base.owner].name} secured ${base.name}. Reinforcements unlocked.`
        : `${base.name} lost its control network. Respawn unavailable.`));
    }
  }

  private announceAttack(site: Territory, attacker: Faction, tick: number): void {
    const base = this.bases.find(b => b.id === site.baseId); if (!base) return;
    const key = `${base.id}:${attacker}`, previous = this.attackSeenAt.get(key);
    this.attackSeenAt.set(key, tick);
    if (previous !== undefined && tick - previous < 30 * TICK_RATE) return;
    const message = `${base.name} on ${planetBySeed(this.world.seed).name} is under attack by ${FACTIONS[attacker].name}.`;
    const bytes = encodeServerMessage(message);
    for (const player of this.actors) player.sink?.send(bytes);
    this.campaignAlert({ baseId: base.id, baseName: base.name, attacker, defender: site.owner, message });
  }

  /** Squad assignments are cached across bot thinks and react to changes in
   * capture pressure, including a foothold in a base we do not yet own. */
  order(player: ServerPlayer): CampaignOrder | undefined {
    return this.director.order(player, this.spawnActors, this.currentTick);
  }

  objective(player: ServerPlayer): Territory | null {
    const order = this.order(player);
    return this.territories.find(t => t.id === order?.targetId) ?? null;
  }

  spawnBases(player: ServerPlayer): CampaignBase[] {
    const order = this.order(player);
    return this.bases.filter(b => b.owner === player.faction && player.faction !== 0).sort((a, b) =>
      Math.hypot(a.x - (order?.x ?? player.state.px), a.z - (order?.z ?? player.state.pz)) -
      Math.hypot(b.x - (order?.x ?? player.state.px), b.z - (order?.z ?? player.state.pz)));
  }

  reinforcementOptions(player: ServerPlayer, tick = this.currentTick): SpawnOption[] {
    if (!player.faction) return [];
    const actors = [...this.spawnActors()];
    const owned = this.spawnBases(player);
    const partial = this.bases.filter(base => base.owner !== player.faction && this.territories.some(t => t.baseId === base.id && t.owner === player.faction));
    const options = [...owned, ...partial].map(base => this.reinforcementPlanner.baseOption(base, player, actors, tick));
    for (const mobile of this.mobileSpawns(player)) {
      if (this.reinforcementPlanner.safe(player, mobile, actors, tick)) options.push({ ...mobile, available: true });
    }
    if (!options.some(o => o.available !== false) && this.reserves.has(player.faction)) {
      const reserve = this.reinforcementPlanner.reserveOption(this.reserves.get(player.faction)!, player, actors, tick);
      if (reserve) options.push(reserve);
    }
    return options;
  }

  spawnOptions(player: ServerPlayer, tick = this.currentTick): SpawnOption[] {
    return this.reinforcementOptions(player, tick).filter(option => option.available !== false);
  }

  snapshot(player: ServerPlayer, nearby: Iterable<ServerPlayer>, tick: number): FrontierState {
    const reinforcements = this.reinforcementOptions(player, tick);
    const options = reinforcements.filter(option => option.available !== false);
    const order = this.order(player);
    return { revision: this.revision, territories: this.territories, bases: this.bases,
      reinforcements: { selected: reinforcements.some(o => o.id === player.preferredSpawnId) ? player.preferredSpawnId : null, options: reinforcements },
      battles: this.battleReports(tick), threats: this.threatReports(player).slice(0, 8),
      ...(player.lastDeath ? { death: player.lastDeath } : {}),
      ...(order ? { order } : {}),
      ...(!player.state.alive ? { respawn: { remaining: Math.max(0, Math.ceil((player.respawnAtTick - tick) / TICK_RATE)),
        selected: options.some(o => o.id === player.preferredSpawnId) ? player.preferredSpawnId : null, options } } : {}),
      you: { faction: player.faction, salvage: player.salvage, discoveries: [...player.discoveries], campaignRewards: [...player.campaignRewards],
        factionCooldown: Math.max(0, Math.ceil((Math.max(player.factionChangeAt, player.regenBlockUntil) - tick) / TICK_RATE)) },
      nearby: [...nearby].map(p => ({ id: p.id, faction: p.faction })).slice(0, 128) };
  }
  send(player: ServerPlayer, nearby: Iterable<ServerPlayer>, tick: number): void {
    player.sink?.send(encodeFrontierState(this.snapshot(player, nearby, tick)));
  }
}
