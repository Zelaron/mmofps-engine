import { NET, TICK_RATE } from '@shared/constants';
import { BTN } from '@shared/movement';
import { VEHICLE, weaponDefById } from '@shared/vehicles';
import { inCaptureRange } from '@shared/frontier';
import { campaignSquad } from './campaign-director.js';
import { campaignTravelOrders } from './bot-campaign-state.js';
import type { Bot } from './bots.js';
import type { Game, ServerPlayer } from './game.js';

// Adaptive maintenance is deliberately less aggressive than hard human-slot
// admission. If these protections leave too few candidates, keep the bots.
export const ADAPTIVE_RETIREMENT_HUMAN_RADIUS = Math.max(1200, NET.INTEREST_RADIUS);
export const ADAPTIVE_RETIREMENT_HOSTILE_RADIUS = 390;
export const ADAPTIVE_RETIREMENT_CONTROL_MARGIN = 60;
export const ADAPTIVE_RETIREMENT_PROJECTILE_RADIUS = 120;

type RetirementGame = Pick<Game, 'tick' | 'players' | 'vehicles' | 'projectiles' | 'frontier' | 'areEnemies'>;
const finitePose = (p: ServerPlayer): boolean => Number.isFinite(p.state.px + p.state.py + p.state.pz);
const distance2 = (a: ServerPlayer, b: ServerPlayer): number =>
  (a.state.px - b.state.px) ** 2 + (a.state.pz - b.state.pz) ** 2;
const activeButtons = BTN.FIRE | BTN.ALTFIRE | BTN.RELOAD;
const criticalButtons = BTN.USE | BTN.DODGE | BTN.JUMP;
type Tier = 'dead' | 'quiet' | 'active';
const tierOrder: Record<Tier, number> = { dead: 0, quiet: 1, active: 2 };
export interface AdaptiveRetirementDiagnostics {
  requested: number; registered: number; selected: number; unfilled: number;
  eligible: Record<Tier, number>; selectedByTier: Record<Tier, number>;
  excluded: Record<string, number>;
  witnessBlocked: { squad: number; operation: number };
}
export function createAdaptiveRetirementDiagnostics(): AdaptiveRetirementDiagnostics {
  return { requested: 0, registered: 0, selected: 0, unfilled: 0,
    eligible: { dead: 0, quiet: 0, active: 0 }, selectedByTier: { dead: 0, quiet: 0, active: 0 },
    excluded: {}, witnessBlocked: { squad: 0, operation: 0 } };
}

/** Return safe retirement choices without changing actors, orders or ownership.
 * Dead actors may retire near observers. Distant quiet infantry precede active
 * bot-only forces, whose faction/squad/control presence is retained. The caller
 * owns removal and supplies transfer protection. Only diagnostics are written. */
export function selectAdaptiveRetirements(
  game: RetirementGame, bots: readonly Bot[], count: number, isProtected: (bot: Bot) => boolean,
  diagnostics?: AdaptiveRetirementDiagnostics,
): Bot[] {
  const report = diagnostics ?? createAdaptiveRetirementDiagnostics();
  if (diagnostics) Object.assign(report, createAdaptiveRetirementDiagnostics());
  const excluded = (reason: string) => { report.excluded[reason] = (report.excluded[reason] ?? 0) + 1; };
  if (!Number.isSafeInteger(game.tick) || !Number.isFinite(count) || count < 1) return [];
  report.requested = Math.floor(count);
  const limit = Math.min(bots.length, Math.floor(count));
  const actors = [...game.players.values()];
  const observers = actors.filter(p => !p.isBot || p.sink);
  const unknownObserver = observers.some(p => !finitePose(p));
  const projectiles = [...game.projectiles.values()];
  // removePlayer deletes owned projectiles, including those fired before death.
  const projectileOwners = new Set(projectiles.map(p => p.owner));
  const hazards = projectiles.map(r => {
    const def = weaponDefById(r.weapon), owner = game.players.get(r.owner);
    const human = !!owner && (!owner.isBot || !!owner.sink);
    const splash = def?.splashRadius ?? 0;
    const invalid = !def || !Number.isFinite(r.x + r.y + r.z + splash + r.distLeft) || r.distLeft < 0;
    return { projectile: r, human, invalid,
      radius: Math.max(ADAPTIVE_RETIREMENT_PROJECTILE_RADIUS, splash + 30),
      // A sphere around a human's current projectile encloses every possible
      // remaining path, including arcs and homing, plus its blast margin.
      humanRadius: human ? r.distLeft + splash + 30 : 0 };
  });
  const occupied = new Set<number>();
  for (const hull of game.vehicles.values()) {
    if (hull.occupant >= 0) occupied.add(hull.occupant);
    if ((hull.gunner ?? -1) >= 0) occupied.add(hull.gunner!);
  }
  const factionCounts = new Map<number, number>(), squadCounts = new Map<string, number>();
  const livingSquads = new Map<string, number>();
  const living = actors.filter(p => p.state.alive);
  const hostileNear = new Set<ServerPlayer>();
  for (const p of living) if (finitePose(p) && living.some(q => game.areEnemies(p, q) &&
    (!finitePose(q) || distance2(p, q) <= ADAPTIVE_RETIREMENT_HOSTILE_RADIUS ** 2))) hostileNear.add(p);
  const operations = new Map<ServerPlayer, string[]>(), operationCounts = new Map<string, number>();
  for (const p of living) {
    if (!p.isBot || !finitePose(p)) continue;
    const keys: string[] = [];
    if (p.state.grounded && !p.state.vehicle && !p.airlift && !p.state.airlift)
      for (const site of game.frontier?.territories ?? [])
        if (inCaptureRange(site, p.state.px, p.state.py, p.state.pz)) keys.push('control:' + p.faction + ':' + site.id);
    // Keep faction presence in each active 512 m fight sector too.
    // This is physical presence, not an order query that mutates the director.
    if (hostileNear.has(p)) keys.push('fight:' + p.faction + ':' + Math.floor(p.state.px / 512) + ',' + Math.floor(p.state.pz / 512));
    operations.set(p, keys);
    for (const key of keys) operationCounts.set(key, (operationCounts.get(key) ?? 0) + 1);
  }
  const seen = new Set<ServerPlayer>();
  const roster: { bot: Bot; faction: number; squad: string; ordinal: number; dead: boolean }[] = [];
  let highestOrdinal = 0;
  for (const bot of bots) {
    const p = bot.player;
    if (seen.has(p) || game.players.get(p.id) !== p || !p.isBot) { excluded('unregistered-or-duplicate'); continue; }
    seen.add(p);
    report.registered++;
    const ordinal = p.botRosterIndex ?? p.id;
    const squad = p.faction + ':' + campaignSquad(p);
    factionCounts.set(p.faction, (factionCounts.get(p.faction) ?? 0) + 1);
    squadCounts.set(squad, (squadCounts.get(squad) ?? 0) + 1);
    if (p.state.alive) livingSquads.set(squad, (livingSquads.get(squad) ?? 0) + 1);
    if (Number.isSafeInteger(ordinal) && ordinal >= 0) highestOrdinal = Math.max(highestOrdinal, ordinal);
    roster.push({ bot, faction: p.faction, squad, ordinal, dead: !p.state.alive });
  }
  const candidates: (typeof roster[number] & { tier: Tier; operations: string[] })[] = [];
  for (const row of roster) {
    const { bot, ordinal, dead } = row, p = bot.player, s = p.state;
    let reason: string | undefined;
    if (p.sink) reason = 'observed-bot';
    else if (isProtected(bot) || campaignTravelOrders.has(p)) reason = 'transfer-or-arrival';
    else if (projectileOwners.has(p.id)) reason = 'projectile-owner';
    else if (occupied.has(p.id) || p.vehicleId >= 0 || s.vehicle !== VEHICLE.NONE || (s.vehicleId ?? -1) >= 0 || (s.seat ?? 0) > 0) reason = 'vehicle-crew';
    else if (p.airlift || s.airlift) reason = 'airlift';
    else if (!Number.isSafeInteger(ordinal) || ordinal < 0) reason = 'invalid-roster';
    else if (!dead) {
      if (!finitePose(p) || !Number.isFinite(s.vx + s.vy + s.vz)) reason = 'invalid-pose';
      else if (!s.grounded || s.swimming || s.submerged || s.jumpAscent || s.boosting) reason = 'unsafe-movement';
      else if (unknownObserver || observers.some(h => distance2(p, h) <= ADAPTIVE_RETIREMENT_HUMAN_RADIUS ** 2)) reason = 'human-interest';
      else if (p.spawnProtectedUntil > game.tick || p.fallCreditUntilTick >= game.tick || p.recallSince >= 0 ||
        ((p.lastCmd?.buttons ?? 0) & criticalButtons) || p.inputQueue.some(cmd => !!(cmd.buttons & criticalButtons))) reason = 'critical-action';
      else if (hazards.some(h => h.invalid || h.projectile.homingTarget === p.id ||
        (h.projectile.x - s.px) ** 2 + (h.projectile.y - s.py) ** 2 + (h.projectile.z - s.pz) ** 2 <= h.radius ** 2 ||
        h.human && (h.projectile.x - s.px) ** 2 + (h.projectile.y - s.py) ** 2 + (h.projectile.z - s.pz) ** 2 <= h.humanRadius ** 2)) reason = 'projectile-recipient';
    }
    if (reason) { excluded(reason); continue; }
    const nearControl = !dead && !!game.frontier?.territories.some(site =>
      (s.px - site.x) ** 2 + (s.pz - site.z) ** 2 <= (site.radius + ADAPTIVE_RETIREMENT_CONTROL_MARGIN) ** 2);
    const active = !dead && (p.regenBlockUntil > game.tick || p.lockTicks > 0 || p.lockVehicleId >= 0 ||
      p.fireCd > 0 || p.reloadCd > 0 || p.vehFireCd > 0 || p.vehAltCd > 0 ||
      ((p.lastCmd?.buttons ?? 0) & activeButtons) || p.inputQueue.some(cmd => !!(cmd.buttons & activeButtons)) ||
      hostileNear.has(p) || nearControl);
    const tier: Tier = dead ? 'dead' : active ? 'active' : 'quiet';
    report.eligible[tier]++;
    candidates.push({ ...row, tier, operations: operations.get(p) ?? [] });
  }
  const selected: Bot[] = [], chosen = new Set<Bot>();
  // Rotate the final deterministic roster tie every maintenance period. Faction
  // and squad balance take priority; new bots are not always the first removed.
  const width = highestOrdinal + 1, rotation = Math.floor(game.tick / (4 * TICK_RATE)) % width;
  const rank = (ordinal: number) => (ordinal - rotation + width) % width;
  while (selected.length < limit) {
    let best: typeof candidates[number] | undefined;
    for (const candidate of candidates) {
      if (chosen.has(candidate.bot) || !candidate.dead && ((livingSquads.get(candidate.squad) ?? 0) <= 1 ||
        candidate.operations.some(key => (operationCounts.get(key) ?? 0) <= 1))) continue;
      if (!best || tierOrder[candidate.tier] < tierOrder[best.tier] || candidate.tier === best.tier && (
        (factionCounts.get(candidate.faction) ?? 0) > (factionCounts.get(best.faction) ?? 0) ||
        factionCounts.get(candidate.faction) === factionCounts.get(best.faction) && (
          (squadCounts.get(candidate.squad) ?? 0) > (squadCounts.get(best.squad) ?? 0) ||
          squadCounts.get(candidate.squad) === squadCounts.get(best.squad) &&
          (rank(candidate.ordinal) < rank(best.ordinal) || rank(candidate.ordinal) === rank(best.ordinal) && candidate.bot.player.id < best.bot.player.id))
      )) best = candidate;
    }
    if (!best) break;
    selected.push(best.bot); chosen.add(best.bot);
    report.selectedByTier[best.tier]++;
    factionCounts.set(best.faction, factionCounts.get(best.faction)! - 1);
    squadCounts.set(best.squad, squadCounts.get(best.squad)! - 1);
    if (!best.dead) {
      livingSquads.set(best.squad, livingSquads.get(best.squad)! - 1);
      for (const key of best.operations) operationCounts.set(key, operationCounts.get(key)! - 1);
    }
  }
  for (const candidate of candidates) if (!candidate.dead && !chosen.has(candidate.bot)) {
    if ((livingSquads.get(candidate.squad) ?? 0) <= 1) report.witnessBlocked.squad++;
    else if (candidate.operations.some(key => (operationCounts.get(key) ?? 0) <= 1)) report.witnessBlocked.operation++;
  }
  report.selected = selected.length; report.unfilled = Math.max(0, report.requested - selected.length);
  return selected;
}
