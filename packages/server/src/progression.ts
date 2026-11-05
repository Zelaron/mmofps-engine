import { TICK_RATE } from '@shared/constants';
import { BTN } from '@shared/movement';
import { inCaptureRange, type Faction, type ProgressStatus, type Territory } from '@shared/frontier';
import { XP_REASON, XP_VALUES, DAILY_COUNT, dailyDay, dailyOrders, dailyResetSeconds, encodeXp, rankForXp, rankName, rankProgress,
  type DailyMetric, type DailyStatus } from '@shared/progression';
import type { ServerPlayer } from './game.js';

/** Hits within this window before a kill earn assist credit. */
export const ASSIST_WINDOW_TICKS = 10 * TICK_RATE;
/** Kills this close to a control count as defending or assaulting it. */
export const OBJECTIVE_KILL_RADIUS = 110;

/** Career experience for human soldiers. Every reward is sent immediately so
 * the client can show it as a ribbon; totals persist with the character. */
export function awardXp(player: ServerPlayer, amount: number, reason: number): void {
  // Invulnerable playtest hyperspeed earns no career progress.
  if (player.isBot || !(amount > 0) || ((player.lastCmd?.buttons ?? 0) & BTN.HYPER) !== 0) return;
  player.xp = Math.min(4_000_000_000, player.xp + Math.round(amount));
  player.warXp += Math.round(amount);
  player.sink?.send(encodeXp(amount, reason, player.xp, rankForXp(player.xp)));
}

export function progressStatus(player: ServerPlayer, now = Date.now()): ProgressStatus | undefined {
  if (player.isBot) return undefined;
  const { rank, into, next } = rankProgress(player.xp);
  return { xp: player.xp, rank, rankName: rankName(rank), into, next, kills: player.careerKills,
    captures: player.captures, warsWon: player.warsWon, bestStreak: player.bestStreak, streak: player.spree,
    daily: dailyStatus(player, now) };
}

/** A new UTC day starts fresh orders. */
function rollDaily(player: ServerPlayer, now: number): readonly ReturnType<typeof dailyOrders>[number][] {
  const day = dailyDay(now);
  if (player.dailyDay !== day) { player.dailyDay = day; player.dailyProgress = new Array(DAILY_COUNT).fill(0); player.dailyDone = 0; }
  return dailyOrders(day);
}

export function dailyStatus(player: ServerPlayer, now = Date.now()): DailyStatus {
  const orders = rollDaily(player, now);
  return { resetsIn: dailyResetSeconds(now), orders: orders.map((order, i) => ({ id: order.id, label: order.label, goal: order.goal,
    progress: Math.min(order.goal, player.dailyProgress[i] ?? 0), xp: order.xp, done: (player.dailyDone & (1 << i)) !== 0 })) };
}

/** Counts toward today's orders and pays an order's bonus the moment it is
 * done. `streak` records the best streak reached, every other metric adds. */
export function advanceDaily(player: ServerPlayer, metric: DailyMetric, amount = 1, now = Date.now()): void {
  if (player.isBot || !(amount > 0) || ((player.lastCmd?.buttons ?? 0) & BTN.HYPER) !== 0) return;
  const orders = rollDaily(player, now);
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    if (order.metric !== metric || (player.dailyDone & (1 << i)) !== 0) continue;
    const before = player.dailyProgress[i] ?? 0;
    player.dailyProgress[i] = Math.min(order.goal, metric === 'streak' ? Math.max(before, amount) : before + amount);
    if (player.dailyProgress[i] >= order.goal) { player.dailyDone |= 1 << i; awardXp(player, order.xp, XP_REASON.DAILY); }
  }
}

/** Remember who hurt whom, bounded, for assist credit on the eventual kill. */
export function recordHit(victim: ServerPlayer, attacker: ServerPlayer, tick: number): void {
  if (attacker.id === victim.id) return;
  victim.recentAttackers.delete(attacker.id);
  victim.recentAttackers.set(attacker.id, tick);
  if (victim.recentAttackers.size > 12) victim.recentAttackers.delete(victim.recentAttackers.keys().next().value!);
}

/** Experience for an enemy kill, its context (objective, streak, revenge)
 * and assists. `spreeBefore` is the victim's streak before it was reset. */
export function rewardKill(victim: ServerPlayer, attacker: ServerPlayer, tick: number, spreeBefore: number,
  territories: readonly Territory[], players: ReadonlyMap<number, ServerPlayer>): void {
  if (attacker.id !== victim.id) {
    attacker.careerKills++;
    attacker.bestStreak = Math.max(attacker.bestStreak, attacker.spree);
    awardXp(attacker, victim.isBot ? XP_VALUES.kill : XP_VALUES.killHuman, XP_REASON.KILL);
    advanceDaily(attacker, 'kills');
    advanceDaily(attacker, 'streak', attacker.spree);
    if (attacker.spree >= 3 && (attacker.spree === 3 || attacker.spree % 5 === 0))
      awardXp(attacker, XP_VALUES.streakStep * Math.min(10, attacker.spree), XP_REASON.STREAK);
    if (attacker.lastKilledBy === victim.id) {
      awardXp(attacker, XP_VALUES.revenge, XP_REASON.REVENGE); attacker.lastKilledBy = -1;
      advanceDaily(attacker, 'revenge');
    }
    if (spreeBefore >= 5) awardXp(attacker, XP_VALUES.shutdown, XP_REASON.SHUTDOWN);
    const s = victim.state;
    let objective: Territory | undefined, best = OBJECTIVE_KILL_RADIUS;
    for (const site of territories) {
      const d = Math.hypot(site.x - s.px, site.z - s.pz);
      if (d < best && Math.abs(site.y - s.py) < 40) { best = d; objective = site; }
    }
    if (objective && attacker.faction) {
      if (objective.owner === attacker.faction) { awardXp(attacker, XP_VALUES.defend, XP_REASON.DEFEND); advanceDaily(attacker, 'defends'); }
      else if (objective.owner === victim.faction || objective.captureFaction === attacker.faction) {
        awardXp(attacker, XP_VALUES.assault, XP_REASON.ASSAULT); advanceDaily(attacker, 'assaults');
      }
    }
    victim.lastKilledBy = attacker.id;
  }
  for (const [id, hitAt] of victim.recentAttackers) {
    if (id === attacker.id || tick - hitAt > ASSIST_WINDOW_TICKS) continue;
    const helper = players.get(id);
    if (helper && helper.faction !== victim.faction) { awardXp(helper, XP_VALUES.assist, XP_REASON.ASSIST); advanceDaily(helper, 'assists'); }
  }
  victim.recentAttackers.clear();
}

/** Everyone on foot inside a control when it changes hands shares the credit. */
export function rewardCapture(participants: readonly ServerPlayer[], site: Territory, neutralized: boolean): void {
  for (const player of participants) {
    if (player.state.vehicle || !inCaptureRange(site, player.state.px, player.state.py, player.state.pz, !player.isBot)) continue;
    if (!neutralized) { player.captures++; player.warCaptures++; advanceDaily(player, 'captures'); }
    awardXp(player, neutralized ? XP_VALUES.neutralize : XP_VALUES.capture, neutralized ? XP_REASON.NEUTRALIZE : XP_REASON.CAPTURE);
  }
}

/** Securing a base rewards the faction's humans fighting around it. */
export function rewardBase(players: Iterable<ServerPlayer>, base: { x: number; z: number }, owner: Faction): void {
  for (const player of players) {
    if (player.isBot || player.faction !== owner || !player.state.alive) continue;
    if (Math.hypot(player.state.px - base.x, player.state.pz - base.z) < 1100) {
      awardXp(player, XP_VALUES.base, XP_REASON.BASE); advanceDaily(player, 'bases');
    }
  }
}

/** End of a war: the winners' soldiers earn a victory bonus, everyone else
 * service pay, so every war is worth finishing. */
export function rewardWar(players: Iterable<ServerPlayer>, victor: Faction): void {
  for (const player of players) {
    if (player.isBot || !player.faction) continue;
    if (player.faction === victor) { player.warsWon++; awardXp(player, XP_VALUES.victory, XP_REASON.VICTORY); }
    else awardXp(player, XP_VALUES.warService, XP_REASON.WAR_SERVICE);
  }
}
