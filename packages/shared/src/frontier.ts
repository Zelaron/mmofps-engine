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
}
export interface CampaignBase {
  id: string; name: string; kind: 'city' | 'harbor' | 'outpost';
  x: number; y: number; z: number; owner: Faction; homeFaction: Faction;
  controlIds: string[]; requiredPoints: number;
}
export interface SpawnOption {
  id: string; name: string; x: number; y: number; z: number; kind: 'base' | 'mobile';
  /** Missing availability means available for older strategic snapshots. */
  available?: boolean; reason?: string; baseId?: string; controlId?: string;
}
export interface CampaignOrder {
  baseId: string; targetId: string; name: string; x: number; z: number;
  phase: 'assemble' | 'attack' | 'defend'; squad: number;
  staging: { x: number; y: number; z: number };
}
export interface FrontierState {
  revision: number;
  territories: Territory[];
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
}
export const CAMPAIGN_SQUAD_SIZE = 6;
export const CAPTURE_SECONDS = 60;
export const CAPTURE_HEIGHT = 6;
export function inCaptureRange(site: Territory, x: number, y: number, z: number): boolean {
  return Math.abs(y - site.y) <= CAPTURE_HEIGHT && Math.hypot(x - site.x, z - site.z) <= site.radius;
}
export const FACTION_COOLDOWN_SECONDS = 30;
export const DISCOVERY_REWARD = 25;
/** A separate contract on each world makes expedition captures worthwhile. */
export const PLANET_CAMPAIGN_REWARD = 150;
