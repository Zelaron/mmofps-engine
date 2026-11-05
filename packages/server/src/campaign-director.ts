import { TICK_RATE } from '@shared/constants';
import { CAMPAIGN_SQUAD_SIZE, inCaptureRange, type CampaignBase, type CampaignOrder, type Faction, type Territory } from '@shared/frontier';
import { VEHICLE } from '@shared/vehicles';
import type { ServerPlayer } from './game.js';
import { botCampaignRole, botRoleId, campaignTravelOrders } from './bot-campaign-state.js';

const REASSESS_TICKS = 2 * TICK_RATE;
const COMMIT_TICKS = 100 * TICK_RATE;
const RESPONSE_TICKS = 45 * TICK_RATE;
const GARRISON_TICKS = 75 * TICK_RATE;

interface Operation {
  base: CampaignBase; target: Territory; defending: boolean; issuedAt: number;
  staging: { x: number; y: number; z: number };
  /** Only one quiet reservation; threatened and overflow defenses are separate. */
  alertGarrison?: boolean;
}
interface ControlMemory { owner: Faction; signature: string; previousOwner: Faction; lostAt: number }
interface Sector {
  base: CampaignBase; controls: Territory[]; presence: number[];
  pressure: Set<Faction>; held: number; defending: boolean; supporting: boolean;
  score: number; capacity: number; urgent: boolean;
}
interface Squad { id: number; members: ServerPlayer[]; x: number; z: number }
type Point = { x: number; y: number; z: number };
/** A human anywhere near a sector draws the war toward the player: friends
 * reinforce their push and enemies come to fight it. */
const HUMAN_GRAVITY_RANGE = 1600;
const HUMAN_GRAVITY = 110;
/** Two other factions already brawling over a base make a poor target. */
const THREE_WAY_PENALTY = 120;
/** Per-squad penalty for stacking on one base. Lower than the old value so a
 * faction can mass a real push instead of spreading one squad everywhere. */
const STACK_PENALTY = 45;
/** Squads massed on one control before an assault opens a second one. */
const ASSAULT_SQUADS_PER_CONTROL = 2;

/** Faction members are interleaved in the roster. Entity IDs may instead come
 * from a worker allocation block, so they are only a legacy fallback. */
export function campaignSquad(player: Pick<ServerPlayer, 'botRosterIndex' | 'id'>): number {
  return Math.floor(Math.max(0, player.botRosterIndex ?? player.id - 1) / (3 * CAMPAIGN_SQUAD_SIZE));
}

/** A bounded strategic auction gives each squad a persistent operation.
 * Captures and pressure interrupt stale plans, while travel commitments and
 * sector budgets prevent every bot chasing the newest/closest firefight. */
export class CampaignDirector {
  private readonly plans = new Map<Faction, Map<number, Operation>>();
  private readonly assessedSquads = new Map<Faction, Set<number>>();
  private readonly memories = new Map<string, ControlMemory>();
  private readonly threatenedUntil = new Map<string, number>();
  private readonly securedUntil = new Map<string, number>();
  private readonly owners = new Map<string, Faction>();
  private nextAssessment = 0;
  private observed = false;
  /** Forward assembly point for an attack on a control, if one is safe. */
  stagingFor: (faction: Faction, base: CampaignBase, target: Territory) => Point | undefined = () => undefined;

  constructor(private readonly bases: readonly CampaignBase[], private readonly controls: readonly Territory[],
    /** Front-line lattice; without it every base is attackable (legacy). */
    private readonly links?: ReadonlyMap<string, readonly string[]>) {}

  /** Bases a faction may attack: neighbors of its holdings on the lattice, any
   * base where it already holds a control, or anywhere if it holds nothing. */
  attackable(faction: Faction): Set<string> {
    const owned = this.bases.filter(base => base.owner === faction);
    const result = new Set<string>();
    // Without a lattice for these bases (legacy layouts, replaced test
    // fixtures), every enemy or neutral base is attackable as before.
    if (!this.links || !owned.length || this.bases.some(base => !this.links!.has(base.id))) {
      for (const base of this.bases) if (base.owner !== faction) result.add(base.id);
      return result;
    }
    for (const base of owned) for (const id of this.links.get(base.id) ?? []) result.add(id);
    for (const site of this.controls) if (site.owner === faction && site.baseId) result.add(site.baseId);
    for (const base of owned) if (this.controls.filter(t => t.baseId === base.id).every(t => t.owner === faction)) result.delete(base.id);
    return result;
  }

  /** Current operations of a faction, one row per target control. */
  operations(faction: Faction): { base: CampaignBase; target: Territory; defending: boolean; squads: number; staging: Point }[] {
    const rows = new Map<string, { base: CampaignBase; target: Territory; defending: boolean; squads: number; staging: Point }>();
    for (const plan of this.plans.get(faction)?.values() ?? []) {
      const row = rows.get(plan.target.id);
      if (row) row.squads++;
      else rows.set(plan.target.id, { base: plan.base, target: plan.target, defending: plan.defending, squads: 1, staging: plan.staging });
    }
    return [...rows.values()].sort((a, b) => b.squads - a.squads || a.target.id.localeCompare(b.target.id));
  }

  /** The operation a human of this faction should join: the plan nearest the
   * player, preferring active fights (attacks and threatened defenses). */
  humanOrder(player: ServerPlayer): { squad: number } | undefined {
    const plans = player.faction ? this.plans.get(player.faction) : undefined;
    if (!plans?.size) return undefined;
    let best: { squad: number; score: number } | undefined;
    for (const [squad, plan] of plans) {
      const distance = Math.hypot(plan.target.x - player.state.px, plan.target.z - player.state.pz);
      const score = distance + (plan.alertGarrison ? 1500 : 0) - (plan.defending && plan.target.contested ? 800 : 0) - (!plan.defending ? 600 : 0);
      if (!best || score < best.score) best = { squad, score };
    }
    return best && { squad: best.squad };
  }

  reset(): void {
    this.plans.clear(); this.assessedSquads.clear(); this.memories.clear(); this.threatenedUntil.clear(); this.securedUntil.clear();
    this.owners.clear(); this.nextAssessment = 0; this.observed = false;
  }

  update(actors: readonly ServerPlayer[], tick: number, force = false): void {
    let changed = false;
    for (const site of this.controls) {
      const signature = `${site.owner}:${site.captureFaction ?? 0}:${site.pressureFaction ?? 0}:${Number(site.contested)}`;
      const old = this.memories.get(site.id);
      if (old?.signature !== signature) changed = true;
      const lost = old && old.owner && old.owner !== site.owner;
      this.memories.set(site.id, { owner: site.owner, signature,
        previousOwner: lost ? old.owner : old?.previousOwner ?? 0, lostAt: lost ? tick : old?.lostAt ?? -Infinity });
      if (site.owner && (site.contested || (site.pressureFaction && site.pressureFaction !== site.owner)))
        this.threatenedUntil.set(`${site.owner}:${site.id}`, tick + RESPONSE_TICKS);
    }
    for (const base of this.bases) {
      const previous = this.owners.get(base.id);
      if (this.observed && previous !== base.owner && base.owner)
        this.securedUntil.set(`${base.owner}:${base.id}`, tick + GARRISON_TICKS);
      this.owners.set(base.id, base.owner);
    }
    this.observed = true;
    if (!force && !changed && tick < this.nextAssessment) return;
    this.nextAssessment = tick + REASSESS_TICKS;
    for (const faction of [1, 2, 3] as const) this.assign(faction, actors, tick);
  }

  order(player: ServerPlayer, actors: () => Iterable<ServerPlayer>, tick: number): CampaignOrder | undefined {
    if (!player.faction) return undefined;
    const squad = player.isBot ? campaignSquad(player) : this.humanOrder(player)?.squad ?? this.plans.get(player.faction)?.keys().next().value ?? 0;
    // A fragmented faction with no holdings can have more squads than attack
    // slots. Remember that its missing orders were considered this assessment;
    // retry only for a new squad, an expired assessment, or a territory update.
    if (!this.plans.get(player.faction)?.has(squad) &&
      (!this.assessedSquads.get(player.faction)?.has(squad) || tick >= this.nextAssessment)) {
      const roster = [...actors()];
      if (!roster.some(p => p.id === player.id)) roster.push(player);
      this.update(roster, tick, true);
    }
    const plan = this.plans.get(player.faction)?.get(squad);
    if (!plan) return undefined;
    const phase = plan.defending ? 'defend' : tick - plan.issuedAt < 12 * TICK_RATE ? 'assemble' : 'attack';
    return { baseId: plan.base.id, targetId: plan.target.id, name: `${plan.defending ? 'Defend' : 'Capture'} ${plan.base.name}`,
      x: plan.target.x, z: plan.target.z, phase, squad, staging: plan.staging };
  }

  private assign(faction: Faction, actors: readonly ServerPlayer[], tick: number): void {
    const bySquad = new Map<number, ServerPlayer[]>();
    for (const actor of actors) {
      if (actor.faction !== faction || !actor.isBot) continue;
      const id = campaignSquad(actor), members = bySquad.get(id) ?? [];
      members.push(actor); bySquad.set(id, members);
    }
    // Human HUD orders can still describe the campaign when the bot roster is
    // empty. They do not create phantom squads competing with real soldiers.
    if (!bySquad.size && actors.some(p => p.faction === faction)) bySquad.set(0, []);
    this.assessedSquads.set(faction, new Set(bySquad.keys()));
    if (!bySquad.size) { this.plans.delete(faction); return; }
    const home = this.bases.find(b => b.homeFaction === faction) ?? this.bases.find(b => b.owner === faction) ?? this.bases[0];
    const squads: Squad[] = [...bySquad].map(([id, members]) => {
      const alive = members.filter(p => p.state.alive && !p.state.airlift);
      return { id, members, x: alive.length ? alive.reduce((n, p) => n + p.state.px, 0) / alive.length : home.x,
        z: alive.length ? alive.reduce((n, p) => n + p.state.pz, 0) / alive.length : home.z };
    });
    const previous = this.plans.get(faction), next = new Map<number, Operation>();
    const sectors = this.sectors(faction, actors, tick, squads.length);
    const assigned = new Map<string, number>(), assignedControls = new Map<string, number>();
    const owned = this.bases.filter(base => base.owner === faction);
    const supplyDistances = new Map(sectors.map(({ base }) => [base.id,
      Math.min(...(owned.length ? owned : [home]).map(source => Math.hypot(source.x - base.x, source.z - base.z)))]));
    const neighbors = new Map(sectors.map(({ base }) => [base.id, sectors.filter(({ base: other }) =>
      other.id !== base.id && Math.hypot(other.x - base.x, other.z - base.z) < 1700).map(({ base }) => base.id)]));
    const nearbyAssignments = new Map<string, number>();
    const guard = this.quietGarrison(faction, squads, sectors, previous, tick);
    if (guard) {
      next.set(guard.squad.id, guard.operation);
      assigned.set(guard.operation.base.id, 1);
      assignedControls.set(guard.operation.target.id, (assignedControls.get(guard.operation.target.id) ?? 0) + 1);
    }
    const candidates = squads.map(squad => {
      const old = previous?.get(squad.id);
      return { squad, bids: sectors.map(sector => ({ sector,
        // Nearby fronts are strongly preferred: a reassigned squad should join a
        // fight within reach, not cross the planet.
        approachPenalty: Math.min(120, Math.min(Math.hypot(squad.x - sector.base.x, squad.z - sector.base.z),
          supplyDistances.get(sector.base.id)! + 600) / 55),
        commitment: old?.base.id === sector.base.id && tick - old.issuedAt < COMMIT_TICKS ? 65 : 0,
      })) };
    });
    // Each pass assigns one complete squad. Bases and actors are summarized
    // once per assessment, never once per bot think or render snapshot. Only
    // capacity and neighboring assignment counts change during the auction.
    while (next.size < squads.length && sectors.length) {
      let best: { squad: Squad; sector: Sector; score: number } | undefined;
      for (const { squad, bids } of candidates) {
        if (next.has(squad.id)) continue;
        for (const { sector, approachPenalty, commitment } of bids) {
          const count = assigned.get(sector.base.id) ?? 0;
          if (count >= sector.capacity) continue;
          // Quiet outlying cities remain worth an expedition. Distance is a
          // preference, not a veto that permanently locks the coast out.
          const score = sector.score - approachPenalty - count * STACK_PENALTY - (nearbyAssignments.get(sector.base.id) ?? 0) * 20 + commitment
            - Math.min(30, Math.max(0, sector.presence[faction] - CAMPAIGN_SQUAD_SIZE * 2) * 2);
          if (!best || score > best.score || score === best.score && squad.id < best.squad.id) best = { squad, sector, score };
        }
      }
      if (!best) break;
      const { squad, sector } = best, old = previous?.get(squad.id);
      const count = assigned.get(sector.base.id) ?? 0;
      const target = this.target(sector, faction, old, assignedControls, tick);
      if (!target) break;
      const same = old?.base.id === sector.base.id;
      const nearest = [...owned].sort((a, b) =>
        Math.hypot(a.x - target.x, a.z - target.z) - Math.hypot(b.x - target.x, b.z - target.z))[0] ?? home;
      // Assaults assemble at a forward staging point a short run from the
      // target (where their reinforcements also arrive), not at a base that
      // may be several kilometres away.
      const forward = sector.defending ? undefined : this.stagingFor(faction, sector.base, target);
      const staging = forward ?? { x: nearest.x, y: nearest.y, z: nearest.z };
      next.set(squad.id, { base: sector.base, target, defending: sector.defending,
        issuedAt: same ? old.issuedAt : tick, staging: { x: staging.x, y: staging.y, z: staging.z } });
      assigned.set(sector.base.id, count + 1);
      assignedControls.set(target.id, (assignedControls.get(target.id) ?? 0) + 1);
      for (const id of neighbors.get(sector.base.id)!) nearbyAssignments.set(id, (nearbyAssignments.get(id) ?? 0) + 1);
    }
    // A nearly conquered map may have fewer attack slots than squads. Extra
    // troops garrison distinct owned bases instead of piling into one fight.
    const garrisons = owned;
    for (const squad of squads.filter(s => !next.has(s.id))) {
      const base = [...garrisons].sort((a, b) => (assigned.get(a.id) ?? 0) - (assigned.get(b.id) ?? 0) ||
        Math.hypot(a.x - squad.x, a.z - squad.z) - Math.hypot(b.x - squad.x, b.z - squad.z))[0];
      if (!base) continue;
      const controls = this.controls.filter(t => t.baseId === base.id), target = controls[squad.id % controls.length];
      if (!target) continue;
      next.set(squad.id, { base, target, defending: true, issuedAt: tick, staging: { x: base.x, y: base.y, z: base.z } });
      assigned.set(base.id, (assigned.get(base.id) ?? 0) + 1);
    }
    this.plans.set(faction, next);
  }

  /** Keep a physically occupied quiet holding alert without recalling a
   * marching squad. Two other living ground squads must remain available;
   * existing threat/loss response and explicit orbital duty take precedence. */
  private quietGarrison(faction: Faction, squads: readonly Squad[], sectors: readonly Sector[],
    previous: ReadonlyMap<number, Operation> | undefined, tick: number): {squad:Squad;operation:Operation} | undefined {
    if (!sectors.length || sectors.some(sector => sector.urgent)) return undefined;
    const groundRole = (p:ServerPlayer) => {
      const role = botCampaignRole(botRoleId(p));
      return role === 'infantry' || role === 'driver' || role === 'gunner';
    };
    const available = squads.flatMap(squad => {
      if (squad.members.some(p => campaignTravelOrders.has(p) || p.airlift || p.state.airlift)) return [];
      const ground = squad.members.filter(groundRole);
      if (ground.length < 4 || ground.length * 2 <= squad.members.length) return [];
      const living = ground.filter(p => p.state.alive);
      if (living.some(p => p.state.vehicle === VEHICLE.JET || p.state.vehicle === VEHICLE.GUNBOAT)) return [];
      return living.length >= 3 ? [{squad,living}] : [];
    });
    if (available.length < 3) return undefined;
    const activeBases = new Set(sectors.map(sector => sector.base.id));
    const candidates: {squad:Squad;target:Territory;base:CampaignBase;present:number;front:number}[] = [];
    for (const base of this.bases) {
      if (base.owner !== faction || activeBases.has(base.id)) continue;
      const controls = this.controls.filter(site => site.baseId === base.id);
      if (!controls.length || controls.some(site => site.owner !== faction || site.contested ||
        site.pressureFaction && site.pressureFaction !== faction)) continue;
      const front = Math.min(...sectors.map(sector => Math.hypot(sector.base.x-base.x, sector.base.z-base.z)));
      for (const {squad,living} of available) for (const target of controls) {
        // A split squad must not recall distant living members merely because
        // three others arrived. Reuse the director's ordinary base presence.
        if (!living.every(p => Math.hypot(p.state.px-base.x,p.state.pz-base.z)<850)) continue;
        const present = living.filter(p => {
          const s=p.state;
          return s.vehicle === VEHICLE.NONE && s.grounded && !s.jumpAscent && !s.swimming && !s.submerged &&
            inCaptureRange(target,s.px,s.py,s.pz,!p.isBot);
        }).length;
        if (present >= 3) candidates.push({squad,target,base,present,front});
      }
    }
    const retained = candidates.find(candidate => {
      const old=previous?.get(candidate.squad.id);
      return old?.alertGarrison && old.base.id===candidate.base.id && old.target.id===candidate.target.id;
    });
    const chosen = retained ?? candidates.sort((a,b) => b.present-a.present || a.front-b.front ||
      a.base.id.localeCompare(b.base.id) || a.squad.id-b.squad.id || a.target.id.localeCompare(b.target.id))[0];
    if (!chosen) return undefined;
    const {squad,base,target}=chosen,old=previous?.get(squad.id);
    return {squad,operation:{base,target,defending:true,alertGarrison:true,
      issuedAt:old?.base.id===base.id?old.issuedAt:tick,staging:{x:base.x,y:base.y,z:base.z}}};
  }

  private sectors(faction: Faction, actors: readonly ServerPlayer[], tick: number, squadCount: number): Sector[] {
    const result: Sector[] = [];
    const attackable = this.attackable(faction);
    const humans = actors.filter(actor => !actor.isBot && actor.faction && actor.state.alive && !actor.state.airlift);
    for (const base of this.bases) {
      const controls = this.controls.filter(t => t.baseId === base.id), presence = [0, 0, 0, 0], pressure = new Set<Faction>();
      for (const actor of actors) {
        if (!actor.state.alive || actor.state.airlift || !actor.faction) continue;
        if (Math.hypot(actor.state.px - base.x, actor.state.pz - base.z) < 850) presence[actor.faction]++;
        for (const control of controls) if (Math.abs(actor.state.py - control.y) <= 8 &&
          Math.hypot(actor.state.px - control.x, actor.state.pz - control.z) <= control.radius + 30) pressure.add(actor.faction);
      }
      for (const control of controls) if (control.pressureFaction) pressure.add(control.pressureFaction);
      const held = controls.filter(t => t.owner === faction).length;
      const endangered = controls.some(t => t.owner === faction && tick < (this.threatenedUntil.get(`${faction}:${t.id}`) ?? -1));
      const lost = controls.some(t => {
        const memory = this.memories.get(t.id);
        return t.owner !== faction && memory?.previousOwner === faction && tick - memory.lostAt < RESPONSE_TICKS;
      });
      const securing = tick < (this.securedUntil.get(`${faction}:${base.id}`) ?? -1);
      const defending = endangered || lost || securing && held === controls.length;
      const supporting = held > 0 && held < controls.length || pressure.has(faction) && held < controls.length;
      if (held === controls.length && !defending) continue;
      // Front lines: attacks only target bases next to friendly territory
      // (or where a foothold already exists); defense is always allowed.
      if (!defending && !supporting && !attackable.has(base.id)) continue;
      const enemies = presence.reduce((n, count, f) => n + (f && f !== faction ? count : 0), 0);
      const strategicValue = base.kind === 'city' ? 105 : base.kind === 'harbor' ? 85 : 70;
      // Enemy forces from two different factions already fighting here.
      const rivals = presence.filter((count, f) => f && f !== faction && count > CAMPAIGN_SQUAD_SIZE).length;
      const near = humans.some(h => controls.some(c => Math.hypot(h.state.px - c.x, h.state.pz - c.z) < HUMAN_GRAVITY_RANGE));
      const score = strategicValue + (endangered || lost ? 280 : securing ? 150 : supporting ? 170 : 0)
        + (base.owner && base.owner !== faction && !enemies ? 30 : 0) + (enemies <= 2 ? 10 : -Math.min(50, enemies * 3))
        + (near ? HUMAN_GRAVITY : 0) - (rivals >= 2 && !defending ? THREE_WAY_PENALTY : 0);
      // A faction masses its squads into real pushes: the busiest fronts take
      // up to four squads, quieter ones one or two.
      const capacity = Math.max(1, Math.min(Math.ceil(squadCount / 3),
        endangered || lost || supporting || near ? 4 : enemies > CAMPAIGN_SQUAD_SIZE ? 3 : 2));
      result.push({ base, controls, presence, pressure, held, defending, supporting, score, capacity, urgent: endangered || lost });
    }
    return result;
  }

  private target(sector: Sector, faction: Faction, old: Operation | undefined, assigned: ReadonlyMap<string, number>, tick: number): Territory | undefined {
    const priority = (site: Territory): number => {
      const memory = this.memories.get(site.id);
      const threatened = site.owner === faction && tick < (this.threatenedUntil.get(`${faction}:${site.id}`) ?? -1);
      const lost = site.owner !== faction && memory?.previousOwner === faction && tick - memory.lostAt < RESPONSE_TICKS;
      return (threatened || lost ? 500 : 0) + (site.owner !== faction ? 100 : 0)
        + (site.pressureFaction === faction ? 35 : 0) + (old?.target.id === site.id ? 12 : 0)
        + (site.captureFaction === faction && site.owner !== faction ? (site.captureProgress ?? 0) * 20 : 0);
    };
    const targets = sector.controls.filter(t => sector.defending || t.owner !== faction)
      .sort((a, b) => priority(b) - priority(a) || a.id.localeCompare(b.id));
    // Reinforcing an ongoing capture shares that flag. Fresh assaults mass
    // two squads on one control before opening a second: spreading single
    // squads across every flag let concentrated defenders win each in turn.
    return sector.defending || sector.supporting ? targets[0] :
      targets.find(target => (assigned.get(target.id) ?? 0) < ASSAULT_SQUADS_PER_CONTROL) ?? targets[0];
  }
}
