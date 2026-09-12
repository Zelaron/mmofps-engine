/** Strategic state travels at 1 Hz, separately from predicted movement. */
export type Faction = 0 | 1 | 2;
export const FACTIONS = [
  { id: 0, name: 'Independent', color: '#d8e6d5', description: 'Explore, salvage, and chart your own route.' },
  { id: 1, name: 'Terran Accord', color: '#68dfd0', description: 'Hold the cities. Keep the frontier connected.' },
  { id: 2, name: 'Helix Combine', color: '#ff9a66', description: 'Break the blockade. Claim a new home.' },
] as const;
export function isFaction(value: unknown): value is Faction { return value === 0 || value === 1 || value === 2; }
export interface Territory {
  id: string; name: string; kind: 'city' | 'relay' | 'harbor';
  x: number; y: number; z: number; radius: number;
  owner: Faction; influence: number; contested: boolean;
}
export interface FrontierState {
  revision: number;
  territories: Territory[];
  you: { faction: Faction; salvage: number; discoveries: string[]; factionCooldown: number };
  nearby: { id: number; faction: Faction }[];
}
export const CAPTURE_SECONDS = 35;
export const FACTION_COOLDOWN_SECONDS = 30;
export const DISCOVERY_REWARD = 25;
