import type { World } from '@shared/worldgen';
import { BOT_CAPTURE_WEIGHT, CAPTURE_DOMINANCE, CAPTURE_MAX_RATE, CAPTURE_SECONDS, DISCOVERY_REWARD, FACTION_COOLDOWN_SECONDS, FACTIONS,
  FINAL_PUSH_SECONDS, PLANET_CAMPAIGN_REWARD, STALEMATE_SECONDS, WAR_INTERMISSION_SECONDS, WAR_MINUTES, WAR_VICTORY_SHARE, inCaptureRange, isFaction, warFaction,
  type CampaignBase, type CampaignOrder, type SpawnOption, type Faction, type FrontierState, type Territory, type WarStatus, type WarDebrief } from '@shared/frontier';
import { campaignLattice, campaignLayout, campaignPoint } from './campaign-layout.js';
import { TICK_RATE, PLAYER } from '@shared/constants';
import { BTN } from '@shared/movement';
import { encodeServerMessage } from '@shared/protocol';
import { encodeFrontierState } from '@shared/frontier-wire';
import type { ServerPlayer } from './game.js';
import { SpatialIndex } from './spatial-index.js';
import { ReinforcementPlanner, STAGING_DISTANCE } from './reinforcements.js';
import { CampaignDirector } from './campaign-director.js';
import { planetBySeed } from '@shared/universe';

export interface CampaignAlert { baseId: string; baseName: string; attacker: Faction; defender: Faction; message: string }
type Point = { x: number; y: number; z: number };
const hyperspeed = (player: ServerPlayer): boolean => ((player.lastCmd?.buttons ?? 0) & BTN.HYPER) !== 0;

/** Saved world format. Version 4 introduced wars with rotating home regions;
 * older saves start a fresh war on the redesigned front-line layout. */
export const WORLD_SAVE_VERSION = 4;
const WAR_TICKS = WAR_MINUTES * 60 * TICK_RATE;
/** The stalemate clock (STALEMATE_SECONDS) starts at a war's first base flip,
 * or this far into the war if none has happened: an opening is never cut short. */
export const STALEMATE_GRACE_SECONDS = 300;

export interface WarRecord {
  number: number;
  /** Simulation tick the war started, or -1 until the clock is known. */
  startedAt: number;
  /** Seconds already fought when restored from a save (consumed on start). */
  elapsed: number;
  victor: Faction;
  decidedAt: number;
  resetAt: number;
  wins: [number, number, number, number];
  /** Tick a base last changed hands in this war, or -1 if none has. */
  movedAt: number;
  /** Tick the current final push ends, or -1 when there is none. */
  pushEndsAt: number;
}

/** Capture outcome reported to the game for progression and announcements. */
export interface CaptureEvent { site: Territory; owner: Faction; previous: Faction; neutralized: boolean; participants: ServerPlayer[] }

/** A held base that has lost one of its controls for this long has its
 * supply cut: its own rally and defense staging close and defenders come from
 * farther away. A long siege then resolves (or the control is retaken in
 * time) instead of grinding on; most sieges end well within this time. */
export const SUPPLY_CUT_SECONDS = 150;
/** With its supply cut, a base's defense stages this far out (attackers
 * stage at STAGING_DISTANCE): defenders arrive later, yet nobody is sent
 * back to a base kilometres away. */
export const CUT_STAGING_DISTANCE = 650;
/** A living human's order stays within a run of where they are. */
const HUMAN_REACH_M = 1200;
/** Within this distance of the kept operation, its order is held. */
const HUMAN_HOLD_M = 600;
/** Battle-report intensity that marks a holding as actively defended. */
const HUMAN_ACTIVE_HEAT = .25;
/** Enemy soldiers this close to an objective count as a fight to join (in
 * battle-report intensity each, up to a cap) before any shot is reported. */
const HUMAN_PRESENCE_M = 450, HUMAN_PRESENCE_CAP = 8, HUMAN_PRESENCE_HEAT = .1;

export class Frontier {
  readonly territories: Territory[];
  readonly bases: CampaignBase[];
  /** Front-line lattice: neighbors of every base. */
  readonly links: Map<string, string[]>;
  revision = 0;
  mobileSpawns: (player: ServerPlayer) => SpawnOption[] = () => [];
  /** Airborne fighter deployment for humans (never chosen automatically). */
  airSpawns: (player: ServerPlayer) => SpawnOption[] = () => [];
  threatReports: (player: ServerPlayer) => NonNullable<FrontierState['threats']> = () => [];
  spawnActors: () => Iterable<ServerPlayer> = () => this.actors;
  campaignAlert: (alert: CampaignAlert) => void = () => {};
  /** Control ownership changes, with the soldiers standing in the zone. */
  captured: (event: CaptureEvent) => void = () => {};
  /** A faction won the war; the map resets after the intermission. */
  warDecided: (war: WarRecord) => void = () => {};
  /** A new war began: territories were reset to the rotated home regions. */
  warStarted: (war: WarRecord) => void = () => {};
  /** A base changed hands (after a control capture). */
  baseChanged: (base: CampaignBase, owner: Faction, previous: Faction) => void = () => {};
  /** Personal progression shown in the strategic snapshot. */
  progress: (player: ServerPlayer) => FrontierState['progress'] = () => undefined;
  /** Runways and whether a fighter is parked on each; set by the game. */
  airfields: () => NonNullable<FrontierState['airfields']> = () => [];
  readonly reinforcementPlanner: ReinforcementPlanner;
  war: WarRecord = { number: 1, startedAt: -1, elapsed: 0, victor: 0, decidedAt: -1, resetAt: -1, wins: [0, 0, 0, 0], movedAt: -1, pushEndsAt: -1 };
  private actors: ServerPlayer[] = [];
  private currentTick = 0;
  private readonly director: CampaignDirector;
  private readonly attackSeenAt = new Map<string, number>();
  private readonly reserves = new Map<Faction, SpawnOption>();
  private readonly index = new SpatialIndex<ServerPlayer>(256);
  private readonly combat = new Map<string, { x: number; z: number; tick: number; weight: number; factions: Set<number> }>();
  /** First-war (slot) owners; each war rotates them between the factions. */
  private readonly slots = new Map<string, { owner: Faction; homeFaction: Faction }>();
  private readonly staging = new Map<string, Point[]>();
  private readonly linkList: [string, string][];

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
    for (const base of this.bases) this.slots.set(base.id, { owner: base.owner, homeFaction: base.homeFaction });
    this.links = campaignLattice(this.bases);
    this.linkList = [];
    for (const [id, neighbors] of this.links) for (const other of neighbors) if (id < other) this.linkList.push([id, other]);
    this.reinforcementPlanner = new ReinforcementPlanner(world, this.territories);
    this.director = new CampaignDirector(this.bases, this.territories, this.links);
    this.director.stagingFor = (faction, base, target) => this.assaultStaging(faction, base, target);
    this.reinforcementPlanner.supplyCut = base => this.supplyCut(base);
    this.computeReserves();
  }

  private computeReserves(): void {
    this.reserves.clear();
    for (const faction of [1, 2, 3] as const) {
      const home = this.bases.find(b => b.homeFaction === faction) ?? this.bases.find(b => b.owner === faction);
      if (home) {
        const scale = Math.hypot(home.x, home.z) || 1;
        const point = campaignPoint(this.world, home.x - home.x / scale * 220, home.z - home.z / scale * 220);
        this.reserves.set(faction, { ...point, id: `reserve-${faction}`, name: `${FACTIONS[faction].name} coastal reinforcements`, kind: 'base' });
      }
    }
  }

  /** Reset every control to its war-start owner for the given war number. */
  private applyWarLayout(number: number): void {
    for (const base of this.bases) {
      const slot = this.slots.get(base.id)!;
      base.owner = warFaction(slot.owner, number); base.homeFaction = warFaction(slot.homeFaction, number);
    }
    for (const site of this.territories) {
      const owner = this.bases.find(b => b.id === site.baseId)?.owner ?? 0;
      site.owner = owner; site.captureFaction = owner; site.captureProgress = owner ? 1 : 0;
      site.influence = owner === 1 ? -1 : owner ? 1 : 0; site.contested = false;
      site.captureRate = 0; site.progressRate = 0; site.pressureFaction = 0;
    }
    this.computeReserves();
    this.staging.clear(); this.combat.clear(); this.attackSeenAt.clear();
    this.lostSince.clear(); this.cutAnnounced.clear();
    // Homes rotate: an order held from the last war may now point at an
    // empty objective of the opposite role. Every soldier chooses afresh.
    this.humanPicks.clear();
    this.director.reset();
  }

  restore(data: unknown): void {
    if (!data || typeof data !== 'object') return;
    const saved = data as { version?: number; seed?: number; territories?: unknown[]; war?: Partial<WarRecord> & { elapsed?: number; decidedFor?: number } };
    if (saved.seed !== this.world.seed || !Array.isArray(saved.territories)) return;
    // Worlds saved before front lines and wars start a fresh war on the new
    // layout; player progress is stored separately and is unaffected.
    if ((saved.version ?? 1) < WORLD_SAVE_VERSION) { this.war = { ...this.war, number: 1, startedAt: -1, elapsed: 0, movedAt: -1, pushEndsAt: -1 }; this.applyWarLayout(1); return; }
    const war = saved.war ?? {};
    const wins = Array.isArray(war.wins) && war.wins.length === 4 && war.wins.every(n => Number.isInteger(n) && n >= 0)
      ? war.wins as WarRecord['wins'] : [0, 0, 0, 0] as WarRecord['wins'];
    const number = Number.isInteger(war.number) && war.number! >= 1 ? war.number! : 1;
    this.applyWarLayout(number);
    for (const raw of saved.territories) {
      if (!raw || typeof raw !== 'object') continue;
      const row = raw as Partial<Territory>, site = this.territories.find(s => s.id === row.id);
      if (!site || !isFaction(row.owner) || typeof row.influence !== 'number' || !Number.isFinite(row.influence)) continue;
      site.owner = row.owner; site.influence = Math.max(-1, Math.min(1, row.influence));
      site.captureFaction = isFaction(row.captureFaction) ? row.captureFaction : site.owner || (site.influence < 0 ? 1 : site.influence > 0 ? 2 : 0);
      site.captureProgress = typeof row.captureProgress === 'number' && Number.isFinite(row.captureProgress) ? Math.max(0, Math.min(1, row.captureProgress)) : Math.abs(site.influence);
    }
    const elapsed = typeof war.elapsed === 'number' && Number.isFinite(war.elapsed) ? Math.max(0, Math.min(WAR_MINUTES * 60, war.elapsed)) : 0;
    this.war = { number, startedAt: -1, elapsed, victor: 0, decidedAt: -1, resetAt: -1, wins, movedAt: -1, pushEndsAt: -1 };
    this.reconcileBases();
    this.director.reset();
  }
  save(): object {
    const elapsed = this.war.startedAt >= 0 ? Math.max(0, (this.currentTick - this.war.startedAt) / TICK_RATE) : this.war.elapsed;
    // A decided war is saved as the next one, so a restart never replays a
    // finished intermission or loses the recorded victory.
    const decided = this.war.victor !== 0;
    return { version: WORLD_SAVE_VERSION, seed: this.world.seed,
      war: { number: decided ? this.war.number + 1 : this.war.number, elapsed: decided ? 0 : elapsed, wins: [...this.war.wins] },
      territories: decided ? [] : this.territories.map(({ id, owner, influence, captureFaction, captureProgress }) => ({ id, owner, influence, captureFaction, captureProgress })) };
  }

  enlist(player: ServerPlayer, faction: unknown, tick: number): string | null {
    if (!isFaction(faction) || !faction) return 'Choose a fighting faction.';
    if (player.faction === faction) return null;
    if (!player.state.alive || player.state.vehicle || player.state.airlift) return 'Change faction while on foot.';
    if (tick < player.factionChangeAt || tick < player.regenBlockUntil) return 'Leave combat and wait before changing allegiance.';
    player.faction = faction; player.preferredSpawnId = '';
    player.factionChangeAt = tick + FACTION_COOLDOWN_SECONDS * TICK_RATE;
    return null;
  }

  /** Capture weight of everyone standing inside a control, by faction. */
  private presence(site: Territory, dt: number, tick: number): { weights: number[]; inside: ServerPlayer[] } {
    const weights = [0, 0, 0, 0], inside: ServerPlayer[] = [];
    for (const player of this.index.query(site.x, site.z, site.radius)) {
      const s = player.state;
      // Invulnerable playtest hyperspeed can roam the map but never takes it.
      if (!player.faction || s.vehicle || !inCaptureRange(site, s.px, s.py, s.pz, !player.isBot) || hyperspeed(player)) continue;
      weights[player.faction] += player.isBot ? BOT_CAPTURE_WEIGHT : 1;
      inside.push(player);
      if (player.faction === site.owner && tick >= player.regenBlockUntil) player.health = Math.min(PLAYER.MAX_HEALTH, player.health + dt * 4);
    }
    return { weights, inside };
  }

  step(players: Iterable<ServerPlayer>, tick: number, dt: number): void {
    this.actors = [...players]; this.currentTick = tick;
    if (this.war.startedAt < 0) this.war.startedAt = tick - Math.round(this.war.elapsed * TICK_RATE);
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
      const { weights, inside } = this.presence(site, dt, tick);
      const factions = ([1, 2, 3] as const).filter(f => weights[f] > 0).sort((a, b) => weights[b] - weights[a] || a - b);
      site.contested = factions.length > 1;
      this.reinforcementPlanner.observeControl(site, factions, tick);
      if (site.owner) for (const attacker of factions.filter(f => f !== site.owner)) this.announceAttack(site, attacker, tick);
      if (site.contested && tick % TICK_RATE < 12) this.recordCombat(site.x, site.z, factions, tick);
      if (!factions.length) continue;
      // The side that clearly outnumbers the others in the zone makes
      // progress; a narrow lead holds the zone contested. One stray enemy no
      // longer freezes a capture indefinitely, so fights resolve.
      const faction = factions[0], margin = weights[faction] - (factions.length > 1 ? weights[factions[1]] : 0);
      if (factions.length > 1 && margin < CAPTURE_DOMINANCE) continue;
      const advantage = Math.min(CAPTURE_MAX_RATE, margin), delta = advantage * dt / CAPTURE_SECONDS;
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
      site.progressRate = dt > 0 && (before !== progress || reducing) ? (reducing ? -1 : 1) * advantage / CAPTURE_SECONDS : 0;
      if (site.owner !== previousOwner) {
        const message = encodeServerMessage(site.owner
          ? `${FACTIONS[site.owner].name} captured ${site.name}.`
          : `${site.name} neutralized. Hold the zone to capture it.`);
        for (const player of this.index.query(site.x, site.z, site.radius * 3)) {
          if (Math.hypot(player.state.px - site.x, player.state.pz - site.z) <= site.radius * 3) player.sink?.send(message);
          if (site.owner && player.faction === site.owner && !player.isBot && !player.state.vehicle &&
            inCaptureRange(site, player.state.px, player.state.py, player.state.pz, true) && !player.campaignRewards.includes(this.world.seed)) {
            player.campaignRewards.push(this.world.seed); player.salvage += PLANET_CAMPAIGN_REWARD;
            player.sink?.send(encodeServerMessage(`${planetBySeed(this.world.seed).name} campaign contract completed · +${PLANET_CAMPAIGN_REWARD} salvage.`));
          }
        }
        this.captured({ site, owner: site.owner, previous: previousOwner, neutralized: !site.owner,
          participants: inside.filter(p => p.faction === faction) });
      }
    }
    this.reconcileBases(true);
    this.updateFootholds(tick);
    this.updateWar(tick);
    this.director.update(this.actors, tick);
    this.revision++;
  }

  private readonly lostSince = new Map<string, number>();
  private readonly cutAnnounced = new Set<string>();
  /** When each held base's controls fell to (or were neutralized by) others. */
  private updateFootholds(tick: number): void {
    for (const base of this.bases) {
      for (const id of base.controlIds) {
        const site = this.territories.find(t => t.id === id);
        if (base.owner && site && site.owner !== base.owner) { if (!this.lostSince.has(id)) this.lostSince.set(id, tick); }
        else this.lostSince.delete(id);
      }
      const cut = this.supplyCut(base, tick);
      if (cut && !this.cutAnnounced.has(base.id)) {
        this.cutAnnounced.add(base.id);
        const lost = this.territories.find(t => base.controlIds.includes(t.id) && t.owner && t.owner !== base.owner);
        this.broadcast(`SUPPLY CUT · ${base.name}: ${lost ? FACTIONS[lost.owner].name : 'the attackers'} held its ground for ${Math.round(SUPPLY_CUT_SECONDS / 60 * 10) / 10} minutes. ${FACTIONS[base.owner].name} must reinforce from farther away until the control is retaken.`);
      } else if (!cut) this.cutAnnounced.delete(base.id);
    }
  }

  /** Where soldiers arrive: held bases and the forward staging of every
   * current operation. Wildlife neither lingers nor attacks there, so a
   * deployment never lands in a creature's jaws; the field beyond is wild. */
  protectedAreas(): { x: number; z: number; radius: number }[] {
    const areas = this.bases.filter(b => b.owner !== 0).map(b => ({ x: b.x, z: b.z, radius: 80 }));
    for (const faction of [1, 2, 3] as const) for (const op of this.director.operations(faction)) {
      for (const p of this.assaultStagingPoints(faction, op.base, op.target)) areas.push({ x: p.x, z: p.z, radius: 60 });
    }
    return areas;
  }

  /** See SUPPLY_CUT_SECONDS. */
  supplyCut(base: CampaignBase, tick = this.currentTick): boolean {
    if (!base.owner) return false;
    for (const id of base.controlIds) {
      const since = this.lostSince.get(id);
      if (since !== undefined && tick - since >= SUPPLY_CUT_SECONDS * TICK_RATE) return true;
    }
    return false;
  }

  /** Bases held per faction: [unclaimed, Accord, Helix, Vanguard]. */
  baseCounts(): [number, number, number, number] {
    const counts: [number, number, number, number] = [0, 0, 0, 0];
    for (const base of this.bases) counts[base.owner]++;
    return counts;
  }
  get victoryBases(): number { return Math.ceil(this.bases.length * WAR_VICTORY_SHARE); }

  private broadcast(text: string): void {
    const bytes = encodeServerMessage(text);
    for (const player of this.actors) player.sink?.send(bytes);
  }

  private updateWar(tick: number): void {
    const war = this.war;
    if (war.victor) {
      if (tick >= war.resetAt) this.startWar(war.number + 1, tick);
      return;
    }
    const counts = this.baseCounts();
    const outright = ([1, 2, 3] as const).find(f => counts[f] >= this.victoryBases);
    if (outright) { this.decideWar(outright, tick, `${FACTIONS[outright].name} holds ${counts[outright]} of ${this.bases.length} bases`); return; }
    const pushOver = war.pushEndsAt >= 0 && tick >= war.pushEndsAt;
    if (!pushOver && tick - war.startedAt < WAR_TICKS) { this.checkStalemate(tick); return; }
    // At the time limit, or the end of a final push, the faction holding the
    // most bases (then controls) wins.
    const controls = [0, 0, 0, 0];
    for (const site of this.territories) controls[site.owner]++;
    const ranked = ([1, 2, 3] as const).slice().sort((a, b) => counts[b] - counts[a] || controls[b] - controls[a]);
    if (counts[ranked[0]] === counts[ranked[1]] && controls[ranked[0]] === controls[ranked[1]]) return; // sudden death
    this.decideWar(ranked[0], tick, pushOver && tick - war.startedAt < WAR_TICKS
      ? `the final push ended with ${FACTIONS[ranked[0]].name} holding the most territory`
      : `time expired with ${FACTIONS[ranked[0]].name} holding the most territory`);
  }

  /** See STALEMATE_SECONDS: start a final push once the front has stalled. */
  private checkStalemate(tick: number): void {
    const war = this.war;
    if (war.pushEndsAt >= 0) return;
    const since = war.movedAt >= 0 ? war.movedAt : war.startedAt + STALEMATE_GRACE_SECONDS * TICK_RATE;
    if (tick - since < STALEMATE_SECONDS * TICK_RATE) return;
    war.pushEndsAt = Math.min(tick + FINAL_PUSH_SECONDS * TICK_RATE, war.startedAt + WAR_TICKS);
    this.broadcast(`FINAL PUSH · No base has changed hands for ${STALEMATE_SECONDS / 60} minutes. In ${FINAL_PUSH_SECONDS / 60} minutes the faction holding the most territory wins war ${war.number}. Take a base to break the deadlock.`);
    this.revision++;
  }

  /** A base changed hands in play: restart the stalemate clock, and a final
   * push still running is called off. */
  private frontMoved(base: CampaignBase): void {
    const war = this.war, tick = this.currentTick;
    if (war.victor) return;
    war.movedAt = tick;
    if (war.pushEndsAt >= 0 && tick < war.pushEndsAt) {
      war.pushEndsAt = -1;
      this.broadcast(`DEADLOCK BROKEN · ${base.owner ? `${FACTIONS[base.owner].name} took ${base.name}` : `${base.name} fell`}. War ${war.number} goes on.`);
    }
  }

  private decideWar(victor: Faction, tick: number, reason: string): void {
    const war = this.war;
    war.victor = victor; war.decidedAt = tick; war.resetAt = tick + WAR_INTERMISSION_SECONDS * TICK_RATE;
    war.wins[victor]++;
    this.broadcast(`VICTORY · ${FACTIONS[victor].name} wins war ${war.number} for ${planetBySeed(this.world.seed).name} (${reason}). A new war begins in ${WAR_INTERMISSION_SECONDS} seconds.`);
    this.warDecided(war);
    this.revision++;
  }

  /** Begin war `number`: home regions rotate between the factions. */
  startWar(number: number, tick: number): void {
    this.war = { number, startedAt: tick, elapsed: 0, victor: 0, decidedAt: -1, resetAt: -1, wins: this.war.wins, movedAt: -1, pushEndsAt: -1 };
    this.applyWarLayout(number);
    this.reconcileBases();
    const homes = ([1, 2, 3] as const).map(f => `${FACTIONS[f].name}: ${this.bases.find(b => b.owner === f && b.kind === 'city')?.name ?? 'the coast'}`);
    this.broadcast(`WAR ${number} BEGINS · Homes rotated — ${homes.join(' · ')}. Take ${this.victoryBases} of ${this.bases.length} bases to win.`);
    this.warStarted(this.war);
    this.revision++;
  }

  warStatus(tick = this.currentTick): WarStatus {
    const war = this.war, started = war.startedAt >= 0 ? war.startedAt : tick - war.elapsed * TICK_RATE;
    return { number: war.number, victor: war.victor,
      remaining: war.victor ? 0 : Math.max(0, Math.ceil((Math.min(started + WAR_TICKS, war.pushEndsAt >= 0 ? war.pushEndsAt : Infinity) - tick) / TICK_RATE)),
      ...(!war.victor && war.pushEndsAt >= 0 ? { finalPush: true } : {}),
      ...(war.victor ? { nextIn: Math.max(0, Math.ceil((war.resetAt - tick) / TICK_RATE)) } : {}),
      bases: this.baseCounts(), victoryBases: this.victoryBases, wins: [...war.wins] as WarStatus['wins'] };
  }

  private reconcileBases(announce = false): void {
    for (const base of this.bases) {
      const controls = this.territories.filter(t => t.baseId === base.id), previous = base.owner;
      base.owner = ([1, 2, 3] as const).find(f => controls.filter(t => t.owner === f).length >= base.requiredPoints) ?? 0;
      if (announce && previous !== base.owner) {
        for (const p of this.actors) p.sink?.send(encodeServerMessage(base.owner
          ? `${FACTIONS[base.owner].name} secured ${base.name}. Reinforcements unlocked.`
          : `${base.name} lost its control network. Respawn unavailable.`));
        this.baseChanged(base, base.owner, previous);
        this.frontMoved(base);
      }
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

  /** Forward assembly point for a faction attacking a control: about 380 m out,
   * on the side facing the attacker's nearest holding. Cached per approach. */
  private assaultStaging(faction: Faction, base: CampaignBase, target: Territory): Point | undefined {
    return this.assaultStagingPoints(faction, base, target)[0];
  }
  private assaultStagingPoints(faction: Faction, base: CampaignBase, target: Territory, around = STAGING_DISTANCE): Point[] {
    let source: CampaignBase | undefined, best = Infinity;
    for (const owned of this.bases) {
      if (owned.owner !== faction || owned.id === base.id) continue;
      const d = Math.hypot(owned.x - target.x, owned.z - target.z);
      if (d < best) { best = d; source = owned; }
    }
    if (!source) return [];
    const key = around === STAGING_DISTANCE ? `${target.id}:${source.id}` : `${target.id}:${source.id}:${around}`;
    if (!this.staging.has(key)) {
      const d = best || 1;
      let points: Point[] = [];
      // Partial test worlds may lack transport/terrain providers; staging is
      // then unavailable and squads use their nearest base as before.
      try { points = this.reinforcementPlanner.stagingPoints(target, (source.x - target.x) / d, (source.z - target.z) / d, 3, around); } catch { points = []; }
      this.staging.set(key, points);
    }
    return this.staging.get(key)!;
  }

  /** A control held by `faction` that an enemy is actively capturing. */
  private underAssault(site: Territory, faction: Faction): boolean {
    return site.owner === faction && !!site.pressureFaction && site.pressureFaction !== faction && (site.progressRate ?? 0) !== 0
      || site.owner === faction && site.contested;
  }

  /** Squad assignments are cached across bot thinks and react to changes in
   * capture pressure, including a foothold in a base we do not yet own.
   * Humans are sent where the fighting is (see humanOperation). */
  order(player: ServerPlayer): CampaignOrder | undefined {
    if (!player.isBot && player.faction) {
      const chosen = this.humanOperation(player);
      if (chosen) return chosen;
    }
    return this.director.order(player, this.spawnActors, this.currentTick);
  }

  private readonly humanPicks = new Map<number, { target: string; until: number }>();
  /** The operation a human should join: active fighting first (recent combat
   * near the target, contested or attacked controls, assaults), then
   * distance. The pick is kept for a while so the HUD order does not flicker.
   * A living soldier is never sent kilometres away while there is a fight
   * within reach: on foot such an order is unusable (its only route was to
   * die). A soldier awaiting deployment goes to the hottest fight anywhere,
   * since the deployment itself lands at that operation's staging. */
  private humanOperation(player: ServerPlayer): CampaignOrder | undefined {
    const operations = this.director.operations(player.faction);
    if (!operations.length) return undefined;
    const tick = this.currentTick, battles = this.battleReports(tick), alive = player.state.alive;
    const distance = (op: (typeof operations)[number]) => Math.hypot(op.target.x - player.state.px, op.target.z - player.state.pz);
    // Before any battle has been reported (a war's first minute), go where the
    // enemy actually is: an undefended objective means a long quiet march.
    const enemies = this.actors.filter(q => q.state.alive && q.faction && q.faction !== player.faction);
    const presence = (t: Territory) => Math.min(HUMAN_PRESENCE_CAP,
      enemies.reduce((n, q) => n + (Math.hypot(q.state.px - t.x, q.state.pz - t.z) < HUMAN_PRESENCE_M ? 1 : 0), 0));
    const score = (op: (typeof operations)[number]) => {
      const t = op.target, d = distance(op);
      const heat = battles.reduce((n, b) => n + (Math.hypot(b.x - t.x, b.z - t.z) < 650 ? b.intensity : 0), 0) + presence(t) * HUMAN_PRESENCE_HEAT;
      // Recent fighting at a holding is a defense in progress, not a quiet one.
      const active = t.contested || this.underAssault(t, player.faction) || heat >= HUMAN_ACTIVE_HEAT;
      const travel = alive && d > HUMAN_REACH_M ? HUMAN_REACH_M / 3 + (d - HUMAN_REACH_M) * 2 : d / 3;
      return heat * 1400 + (active ? 900 : 0) + (op.defending ? (active ? 300 : -2500) : 400) + op.squads * 60 - travel;
    };
    const ranked = [...operations].sort((a, b) => score(b) - score(a));
    const previous = this.humanPicks.get(player.id);
    // Squads re-shuffle exact controls; stay with the same base meanwhile.
    const previousBase = previous && this.territories.find(t => t.id === previous.target)?.baseId;
    const kept = previous && tick < previous.until && (operations.find(op => op.target.id === previous.target)
      ?? operations.find(op => op.base.id === previousBase));
    const best = ranked[0];
    // Already at the kept fight: only a much better one nearby replaces it.
    const margin = kept && alive && distance(kept) < HUMAN_HOLD_M ? 1600 : 700;
    const pick = kept && score(kept) > score(best) - margin ? kept : best;
    // Only a living soldier's order is held (so the HUD does not flicker). A
    // deploying soldier re-chooses until spawning: when a war starts every
    // soldier is down, and a choice made then knows nothing of the enemy.
    if (alive && (!kept || pick !== kept)) this.humanPicks.set(player.id, { target: pick.target.id, until: tick + 45 * TICK_RATE });
    else if (alive && kept && previous && distance(kept) < HUMAN_HOLD_M) previous.until = Math.max(previous.until, tick + 20 * TICK_RATE);
    if (this.humanPicks.size > 512) this.humanPicks.delete(this.humanPicks.keys().next().value!);
    const t = pick.target;
    return { baseId: pick.base.id, targetId: t.id, name: `${pick.defending ? 'Defend' : 'Capture'} ${pick.base.name}`,
      x: t.x, z: t.z, phase: pick.defending ? 'defend' : 'attack', squad: 0, staging: pick.staging };
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

  /** Whether this soldier's faction stages an assault on the control at all
   * (safe or not); bots briefly wait for an unsafe staging to clear. */
  hasAssaultStaging(player: ServerPlayer, targetId: string): boolean {
    if (!player.faction) return false;
    const operation = this.director.operations(player.faction).find(op => op.target.id === targetId && !op.defending);
    return !!operation && this.assaultStagingPoints(player.faction, operation.base, operation.target).length > 0;
  }

  /** Forward deployment for the faction's current assaults. */
  private assaultOptions(player: ServerPlayer, actors: readonly ServerPlayer[], tick: number): SpawnOption[] {
    if (!player.faction) return [];
    const options: SpawnOption[] = [];
    for (const operation of this.director.operations(player.faction)) {
      if (options.length >= 6) continue;
      // Defense of a quiet holding needs no forward point; its base has one.
      if (operation.defending && !this.underAssault(operation.target, player.faction)) continue;
      // A base whose supply is cut stages its defense farther out.
      const cut = operation.defending && this.supplyCut(operation.base, tick);
      const points = this.assaultStagingPoints(player.faction, operation.base, operation.target, cut ? CUT_STAGING_DISTANCE : STAGING_DISTANCE);
      if (!points.length) continue;
      const point = points.find(p => this.reinforcementPlanner.safe(player, p, actors, tick)) ?? points[0];
      const safe = this.reinforcementPlanner.safe(player, point, actors, tick) && this.reinforcementPlanner.supported(point);
      options.push({ id: `assault-${operation.target.id}`, name: `${operation.defending ? 'Defense' : 'Assault'} · ${operation.base.name}`, kind: 'base', ...point,
        baseId: operation.base.id, controlId: operation.target.id, available: safe,
        reason: safe ? `${cut ? 'Supply cut: defense stages farther out, ' : 'Forward staging '}${Math.round(Math.hypot(point.x - operation.target.x, point.z - operation.target.z))} m from ${operation.target.name}.`
          : 'Enemies or recent fighting near the staging area. Another point will be used meanwhile.' });
    }
    return options;
  }

  reinforcementOptions(player: ServerPlayer, tick = this.currentTick): SpawnOption[] {
    if (!player.faction) return [];
    const actors = [...this.spawnActors()];
    const owned = this.spawnBases(player);
    const partial = this.bases.filter(base => base.owner !== player.faction && this.territories.some(t => t.baseId === base.id && t.owner === player.faction));
    const options = [...this.assaultOptions(player, actors, tick),
      ...[...owned, ...partial].map(base => this.reinforcementPlanner.baseOption(base, player, actors, tick))];
    for (const mobile of this.mobileSpawns(player)) {
      if (this.reinforcementPlanner.safe(player, mobile, actors, tick)) options.push({ ...mobile, available: true });
    }
    if (!player.isBot) options.push(...this.airSpawns(player));
    if (!options.some(o => o.available !== false && o.kind !== 'air') && this.reserves.has(player.faction)) {
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
    const progress = this.progress(player);
    const debrief = this.debrief(player);
    return { revision: this.revision, territories: this.territories, bases: this.bases, war: this.warStatus(tick), links: this.linkList,
      ...(progress ? { progress } : {}), ...(debrief ? { debrief } : {}),
      reinforcements: { selected: reinforcements.some(o => o.id === player.preferredSpawnId) ? player.preferredSpawnId : null, options: reinforcements },
      battles: this.battleReports(tick), threats: this.threatReports(player).slice(0, 8), airfields: this.airfields(),
      ...(player.lastDeath ? { death: player.lastDeath } : {}),
      ...(order ? { order } : {}),
      ...(!player.state.alive ? { respawn: { remaining: Math.max(0, Math.ceil((player.respawnAtTick - tick) / TICK_RATE)),
        selected: options.some(o => o.id === player.preferredSpawnId) ? player.preferredSpawnId : null, options } } : {}),
      you: { faction: player.faction, salvage: player.salvage, discoveries: [...player.discoveries], campaignRewards: [...player.campaignRewards],
        factionCooldown: Math.max(0, Math.ceil((Math.max(player.factionChangeAt, player.regenBlockUntil) - tick) / TICK_RATE)) },
      nearby: [...nearby].map(p => ({ id: p.id, faction: p.faction })).slice(0, 128) };
  }
  /** During the intermission after a decided war: what this soldier did in
   * it, and who did the most. Counters reset when the next war begins. */
  debrief(player: ServerPlayer): WarDebrief | undefined {
    if (player.isBot || !this.war.victor || !player.faction) return undefined;
    let best: ServerPlayer | undefined;
    for (const q of this.actors) if (q.faction && q.warKills > (best?.warKills ?? 0)) best = q;
    return { war: this.war.number, victor: this.war.victor, faction: player.faction,
      kills: player.warKills, deaths: player.warDeaths, captures: player.warCaptures, xp: player.warXp,
      ...(best ? { best: { name: best.name, faction: best.faction, kills: best.warKills, you: best.id === player.id } } : {}) };
  }

  send(player: ServerPlayer, nearby: Iterable<ServerPlayer>, tick: number): void {
    player.sink?.send(encodeFrontierState(this.snapshot(player, nearby, tick)));
  }
}
