import type { DailyStatus } from './progression.js';

/** Strategic state travels at 1 Hz, separately from predicted movement. */
/** Zero denotes unclaimed territory, never a player allegiance. */
export type Faction = 0 | 1 | 2 | 3;
export const FACTIONS = [
  { id: 0, name: 'Unclaimed', color: '#8b9b9a', description: 'Territory awaiting a faction claim.' },
  { id: 1, name: 'Terran Accord', color: '#68dfd0', description: 'Hold the cities. Keep the frontier connected.' },
  { id: 2, name: 'Helix Combine', color: '#ff9a66', description: 'Break the blockade. Claim a new home.' },
  { id: 3, name: 'Vanguard Pact', color: '#bc9cff', description: 'Unite the outlying colonies. Secure the next frontier.' },
] as const;
export function isFaction(value: unknown): value is Faction { return value === 0 || value === 1 || value === 2 || value === 3; }
export interface Territory {
  id: string; name: string; kind: 'city' | 'relay' | 'harbor';
  x: number; y: number; z: number; radius: number;
  owner: Faction; influence: number; contested: boolean;
  /** Signed influence per second; zero when empty, held or contested. */
  captureRate?: number;
  baseId?: string;
  /** Claim strength is independent of faction color/sign. */
  captureFaction?: Faction;
  captureProgress?: number;
  pressureFaction?: Faction;
  progressRate?: number;
  /** Lowest and highest dry open ground inside the ring, on a control whose
   * flag stands on open ground. A human anywhere on that ground counts (to
   * within CAPTURE_HEIGHT), so a ring on a slope has no dead side for players.
   * Bots keep the flag band: they walk to the flag, and counting them on the
   * slopes only made more captures stall as contested. Missing: only the
   * flag's height counts. */
  ground?: [number, number];
}
export interface CampaignBase {
  id: string; name: string; kind: 'city' | 'harbor' | 'outpost';
  x: number; y: number; z: number; owner: Faction; homeFaction: Faction;
  controlIds: string[]; requiredPoints: number;
}
export interface SpawnOption {
  /** 'air' deploys the soldier in a fighter jet already in flight. */
  id: string; name: string; x: number; y: number; z: number; kind: 'base' | 'mobile' | 'air';
  /** Flight heading for airborne deployment. */
  heading?: number;
  /** Missing availability means available for older strategic snapshots. */
  available?: boolean; reason?: string; baseId?: string; controlId?: string;
}
export interface CampaignOrder {
  baseId: string; targetId: string; name: string; x: number; z: number;
  phase: 'assemble' | 'attack' | 'defend'; squad: number;
  staging: { x: number; y: number; z: number };
}
/** One war for a planet: it ends when a faction holds two thirds of the
 * bases, or at the time limit (most bases wins). The map then resets with the
 * home regions rotated, so every war starts fresh from a different corner. */
export interface WarStatus {
  number: number;
  /** Seconds until the time limit, or the end of a final push, decides the
   * war (0 once decided). */
  remaining: number;
  /** The front has stalled: when `remaining` runs out, the faction holding
   * the most territory wins, unless a base changes hands first. */
  finalPush?: boolean;
  victor: Faction;
  /** Seconds until the next war begins, once a victor is decided. */
  nextIn?: number;
  /** Bases held per faction: [unclaimed, Accord, Helix, Vanguard]. */
  bases: [number, number, number, number];
  /** Bases a faction must hold to win outright. */
  victoryBases: number;
  /** Wars won on this planet: [unused, Accord, Helix, Vanguard]. */
  wins: [number, number, number, number];
}
/** Personal progression carried in the strategic snapshot. */
export interface ProgressStatus {
  xp: number; rank: number; rankName: string;
  /** XP into the current rank and needed for the next one. */
  into: number; next: number;
  kills: number; captures: number; warsWon: number; bestStreak: number;
  streak: number;
  /** Today's three daily orders and this soldier's progress on them. */
  daily?: DailyStatus;
}
/** This soldier's part in a decided war, shown during the intermission. */
export interface WarDebrief {
  war: number; victor: Faction; faction: Faction;
  kills: number; deaths: number; captures: number; xp: number;
  /** The war's most decorated soldier on this world (most eliminations). */
  best?: { name: string; faction: Faction; kills: number; you: boolean };
}
export interface FrontierState {
  revision: number;
  territories: Territory[];
  war?: WarStatus;
  progress?: ProgressStatus;
  debrief?: WarDebrief;
  /** Bases adjacent to each base on the front-line lattice. */
  links?: [string, string][];
  you: { faction: Faction; salvage: number; discoveries: string[]; factionCooldown: number; campaignRewards?: number[] };
  nearby: { id: number; faction: Faction }[];
  bases?: CampaignBase[];
  order?: CampaignOrder;
  reinforcements?: { selected: string | null; options: SpawnOption[] };
  respawn?: { remaining: number; selected: string | null; options: SpawnOption[] };
  death?: { x: number; y: number; z: number };
  battles?: { id: string; x: number; z: number; intensity: number; factions: number[]; name: string }[];
  /** Planetary reports expose major creatures, not distant individual soldiers. */
  threats?: { id: number; species: number; x: number; y: number; z: number; health: number; engaged: boolean }[];
  /** Runways on this world, and whether a fighter jet is parked there and free. */
  airfields?: { x: number; z: number; ready: boolean }[];
}
export const CAMPAIGN_SQUAD_SIZE = 6;
export const CAPTURE_SECONDS = 60;
export const CAPTURE_HEIGHT = 6;
/** Capture weight of one bot soldier; a human counts 1. */
export const BOT_CAPTURE_WEIGHT = .25;
/** The leading faction progresses only with this much more capture weight
 * than the runner-up. A smaller lead holds the zone contested. */
export const CAPTURE_DOMINANCE = .35;
/** Maximum capture speed multiplier (in human equivalents of advantage). */
export const CAPTURE_MAX_RATE = 3;
/** Death-event cause used when a new war redeploys every soldier. Clients
 * treat it as a deployment, not a kill: no feed line, no death camera. */
export const WAR_REDEPLOY_WEAPON = 253;
/** A creature's attack: a death, but not a suicide (no frag penalty). */
export const WILDLIFE_WEAPON = 251;
/** Long enough to explore caves, find superweapons and still fight for bases. */
export const WAR_MINUTES = 120;
export const WAR_VICTORY_SHARE = 2 / 3;
/** A war in which no base has changed hands for this long enters a final
 * push. A frozen front then ends in a climax and a fresh war, instead of
 * grinding on to the time limit (an early Meridian war froze from minute 7).
 * Base flips are rare on a map this size: a 6-minute window ended every
 * simulated war after 15-30 minutes. */
export const STALEMATE_SECONDS = 900;
/** Length of the final push: then the time-limit rule decides the war,
 * unless a base changes hands first. */
export const FINAL_PUSH_SECONDS = 180;
export const WAR_INTERMISSION_SECONDS = 30;
/** Faction holding each home region in war `number` (1-based): homes rotate. */
export function warFaction(slot: Faction, number: number): Faction {
  if (!slot) return 0;
  return (((slot - 1 + Math.max(0, number - 1)) % 3) + 1) as Faction;
}
/** How far height `y` lies outside a soldier's capture heights at a control:
 * 0 within them, positive above, negative below. Roofs and caves fall
 * outside. A human also counts on the ring's ground band (see `ground`). */
export function captureHeightGap(site: Pick<Territory, 'y' | 'ground'>, y: number, human = false): number {
  let low = site.y - CAPTURE_HEIGHT, high = site.y + CAPTURE_HEIGHT;
  if (human && site.ground) { low = Math.min(low, site.ground[0] - CAPTURE_HEIGHT); high = Math.max(high, site.ground[1] + CAPTURE_HEIGHT); }
  return y > high ? y - high : y < low ? y - low : 0;
}
export function inCaptureRange(site: Territory, x: number, y: number, z: number, human = false): boolean {
  return captureHeightGap(site, y, human) === 0 && Math.hypot(x - site.x, z - site.z) <= site.radius;
}
export const FACTION_COOLDOWN_SECONDS = 30;
export const DISCOVERY_REWARD = 25;
/** A separate contract on each world makes expedition captures worthwhile. */
export const PLANET_CAMPAIGN_REWARD = 150;
