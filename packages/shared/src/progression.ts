import { ByteReader, ByteWriter, Msg } from './protocol.js';

/** Why a soldier earned experience. Shown as a short on-screen ribbon. */
export const XP_REASON = {
  KILL: 1, ASSIST: 2, CAPTURE: 3, NEUTRALIZE: 4, DEFEND: 5, VEHICLE: 6, STREAK: 7,
  VICTORY: 8, WAR_SERVICE: 9, BASE: 10, REVENGE: 11, BOSS: 12, SHUTDOWN: 13, ASSAULT: 14, FIRST_BLOOD: 15, DAILY: 16,
} as const;
export type XpReason = typeof XP_REASON[keyof typeof XP_REASON];
export const XP_LABELS: Readonly<Record<number, string>> = {
  [XP_REASON.KILL]: 'ENEMY ELIMINATED', [XP_REASON.ASSIST]: 'ASSIST', [XP_REASON.CAPTURE]: 'CONTROL CAPTURED',
  [XP_REASON.NEUTRALIZE]: 'CONTROL NEUTRALIZED', [XP_REASON.DEFEND]: 'DEFENDER', [XP_REASON.VEHICLE]: 'VEHICLE DESTROYED',
  [XP_REASON.STREAK]: 'KILLSTREAK', [XP_REASON.VICTORY]: 'WAR VICTORY', [XP_REASON.WAR_SERVICE]: 'WAR SERVICE',
  [XP_REASON.BASE]: 'BASE SECURED', [XP_REASON.REVENGE]: 'REVENGE', [XP_REASON.BOSS]: 'BOSS HUNTER',
  [XP_REASON.SHUTDOWN]: 'STREAK ENDED', [XP_REASON.ASSAULT]: 'ATTACKER', [XP_REASON.FIRST_BLOOD]: 'FIRST BLOOD',
  [XP_REASON.DAILY]: 'DAILY ORDER COMPLETE',
};
/** Base experience per event. Kills of human players are worth more. */
export const XP_VALUES = {
  kill: 100, killHuman: 150, assist: 40, capture: 250, neutralize: 150, defend: 50, assault: 30,
  vehicle: 150, streakStep: 50, victory: 1500, warService: 400, base: 300, revenge: 50, boss: 500, shutdown: 75, firstBlood: 100,
} as const;

export const MAX_RANK = 60;
const RANK_TITLES = ['Recruit', 'Private', 'Specialist', 'Corporal', 'Sergeant', 'Staff Sergeant', 'Master Sergeant',
  'Warrant Officer', 'Lieutenant', 'Captain', 'Major', 'Lieutenant Colonel', 'Colonel', 'Brigadier', 'Major General',
  'Lieutenant General', 'General', 'Marshal', 'Field Marshal', 'Warlord'] as const;
const NUMERALS = ['I', 'II', 'III'] as const;

/** Total experience needed to reach a rank (rank 1 needs none). The curve
 * makes the first promotions quick and the top ranks a long-term goal. */
export function xpForRank(rank: number): number {
  const r = Math.max(1, Math.min(MAX_RANK, Math.floor(rank)));
  return Math.round(1000 * Math.pow(r - 1, 1.75));
}
export function rankForXp(xp: number): number {
  let rank = 1;
  while (rank < MAX_RANK && xp >= xpForRank(rank + 1)) rank++;
  return rank;
}
export function rankName(rank: number): string {
  const r = Math.max(1, Math.min(MAX_RANK, Math.floor(rank)));
  return `${RANK_TITLES[Math.floor((r - 1) / 3)]} ${NUMERALS[(r - 1) % 3]}`;
}
/** Short insignia text for scoreboards and name tags. */
export function rankShort(rank: number): string {
  return `R${Math.max(1, Math.min(MAX_RANK, Math.floor(rank)))}`;
}
export function rankProgress(xp: number): { rank: number; into: number; next: number } {
  const rank = rankForXp(xp), floor = xpForRank(rank);
  return { rank, into: Math.max(0, xp - floor), next: rank >= MAX_RANK ? 0 : xpForRank(rank + 1) - floor };
}

/** Daily orders: three short goals per UTC day, the same for everyone, so
 * there is always something new to finish and a reason to return tomorrow.
 * Every day has one kill order (anyone can progress) and two other kinds. */
export type DailyMetric = 'kills' | 'assists' | 'captures' | 'defends' | 'assaults' | 'streak' | 'vehicles' | 'bases' | 'revenge';
export interface DailyOrder { id: string; metric: DailyMetric; goal: number; xp: number; label: string }
export const DAILY_ORDERS: readonly DailyOrder[] = [
  { id: 'kills-10', metric: 'kills', goal: 10, xp: 500, label: 'Eliminate 10 enemies' },
  { id: 'kills-20', metric: 'kills', goal: 20, xp: 900, label: 'Eliminate 20 enemies' },
  { id: 'kills-30', metric: 'kills', goal: 30, xp: 1300, label: 'Eliminate 30 enemies' },
  { id: 'assists-4', metric: 'assists', goal: 4, xp: 400, label: 'Assist 4 eliminations' },
  { id: 'captures-2', metric: 'captures', goal: 2, xp: 600, label: 'Capture 2 control points' },
  { id: 'captures-4', metric: 'captures', goal: 4, xp: 1000, label: 'Capture 4 control points' },
  { id: 'defends-4', metric: 'defends', goal: 4, xp: 500, label: 'Stop 4 attackers at your holdings' },
  { id: 'assaults-6', metric: 'assaults', goal: 6, xp: 500, label: 'Defeat 6 defenders in assaults' },
  { id: 'streak-4', metric: 'streak', goal: 4, xp: 600, label: 'Reach a 4-kill streak' },
  { id: 'vehicles-1', metric: 'vehicles', goal: 1, xp: 500, label: 'Destroy an enemy vehicle' },
  { id: 'bases-1', metric: 'bases', goal: 1, xp: 800, label: 'Help secure a base' },
  { id: 'revenge-1', metric: 'revenge', goal: 1, xp: 300, label: 'Take revenge on your killer' },
];
export const DAILY_COUNT = 3;
const DAY_MS = 86_400_000;
export function dailyDay(now = Date.now()): number { return Math.floor(now / DAY_MS); }
export function dailyResetSeconds(now = Date.now()): number { return Math.ceil((DAY_MS - now % DAY_MS) / 1000); }
export function dailyOrders(day: number): readonly DailyOrder[] {
  let h = (Math.imul(Math.floor(day) | 0, 2654435761) ^ 0x5bd1e995) >>> 0 || 1;
  const next = () => { h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0; return h; };
  const kills = DAILY_ORDERS.filter(o => o.metric === 'kills'), others = DAILY_ORDERS.filter(o => o.metric !== 'kills');
  const picked = [kills[next() % kills.length]];
  while (picked.length < DAILY_COUNT) {
    const order = others[next() % others.length];
    if (!picked.some(p => p.metric === order.metric)) picked.push(order);
  }
  return picked;
}
export interface DailyStatus {
  orders: { id: string; label: string; goal: number; progress: number; xp: number; done: boolean }[];
  /** Seconds until the next set of orders (UTC midnight). */
  resetsIn: number;
}

export interface XpEvent { amount: number; reason: number; total: number; rank: number }
export function encodeXp(amount: number, reason: number, total: number, rank: number): Uint8Array {
  return new ByteWriter(12).u8(Msg.SXp).u16(Math.max(0, Math.min(65535, Math.round(amount)))).u8(reason & 255)
    .u32(Math.max(0, Math.min(0xffffffff, Math.floor(total)))).u8(Math.max(1, Math.min(255, rank))).finish();
}
export function decodeXp(r: ByteReader): XpEvent {
  return { amount: r.u16(), reason: r.u8(), total: r.u32(), rank: r.u8() };
}
