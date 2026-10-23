/** Fixed aim point: moving after the warning, or taking cover, avoids the blast. */
export interface CreatureRangedAttack {
  x: number; y: number; z: number;
  originX: number; originY: number; originZ: number;
  radius: number; fireTick: number; impactTick: number;
}

export interface CreatureState {
  id: number; species: number;
  x: number; y: number; z: number;
  yaw: number; speed: number; alert: boolean;
  dead?: boolean;
  /** Normalized health and a visible, dodgeable attack warning. */
  health?: number;
  windingUp?: boolean;
  rangedAttack?: CreatureRangedAttack;
}

export interface CreatureDef {
  name: string; health: number; radius: number; height: number; speed: number; damage: number;
  cave: boolean; notice: number; leash: number; temperament: 'passive' | 'hunter' | 'defensive';
  boss?: boolean; undead?: boolean; reach?: number; windup?: number; cooldown?: number;
  /** Only damage provokes this longer pursuit; ordinary detection stays local. */
  pursuit?: { range: number; seconds: number; speed: number };
  ranged?: { range: number; minRange: number; damage: number; radius: number;
    windup: number; speed: number; cooldown: number };
  bossReward?: { salvage: number; weapon: number; ammoCrates: number };
}
/** Stable species IDs are shared by snapshots, combat and procedural models. */
export const CREATURE = {
  GRAZER: 0, STALKER: 1, SKITTER: 2, RUNNER: 3, BRISTLEBACK: 4, BEETLE: 5,
  SHAMBLER: 6, REVENANT: 7, BRUTE: 8, OSSUARY_TITAN: 9,
  ASH_CRAWLER: 10, CINDER_COLOSSUS: 11, REEF_PROWLER: 12, TIDE_BEHEMOTH: 13,
} as const;
export const CREATURE_DEFS: readonly CreatureDef[] = [
  { name: 'Ridge Grazer', health: 45, radius: 0.6, height: 1.45, speed: 5, damage: 0, cave: false, notice: 18, leash: 28, temperament: 'passive' },
  { name: 'Dune Stalker', health: 85, radius: 0.52, height: 1.12, speed: 5.5, damage: 12, cave: false, notice: 30, leash: 48, temperament: 'hunter' },
  { name: 'Cave Skitter', health: 65, radius: 0.6, height: 0.82, speed: 4.8, damage: 9, cave: true, notice: 24, leash: 38, temperament: 'hunter' },
  { name: 'Crest Runner', health: 35, radius: 0.4, height: 1.9, speed: 7.4, damage: 0, cave: false, notice: 25, leash: 42, temperament: 'passive' },
  { name: 'Bristleback', health: 90, radius: 0.62, height: 1.12, speed: 4.3, damage: 10, cave: false, notice: 10, leash: 28, temperament: 'defensive' },
  { name: 'Glow Beetle', health: 30, radius: 0.48, height: 0.7, speed: 2.6, damage: 0, cave: true, notice: 9, leash: 18, temperament: 'passive' },
  { name: 'Hollow Shambler', health: 115, radius: .42, height: 1.85, speed: 2.6, damage: 17, cave: false, notice: 38, leash: 74, temperament: 'hunter', undead: true },
  { name: 'Feral Revenant', health: 80, radius: .38, height: 1.6, speed: 6.3, damage: 13, cave: false, notice: 44, leash: 86, temperament: 'hunter', undead: true, cooldown: 1 },
  { name: 'Plague Brute', health: 460, radius: .86, height: 2.85, speed: 3.1, damage: 36, cave: false, notice: 34, leash: 70, temperament: 'hunter', undead: true, reach: 2.8, windup: .65, cooldown: 2.6 },
  { name: 'Ossuary Titan', health: 12000, radius: 3.3, height: 10.4, speed: 3.8, damage: 64, cave: false, notice: 76, leash: 135, temperament: 'defensive', undead: true, boss: true, reach: 11, windup: 1.5, cooldown: 5,
    pursuit: { range: 1200, seconds: 45, speed: 7.6 },
    ranged: { range: 1000, minRange: 22, damage: 72, radius: 9, windup: 1.5, speed: 210, cooldown: 8.5 },
    bossReward: { salvage: 500, weapon: 6, ammoCrates: 2 } },
  { name: 'Ash Crawler', health: 150, radius: .73, height: 1.15, speed: 5.4, damage: 21, cave: false, notice: 38, leash: 72, temperament: 'hunter' },
  { name: 'Cinder Colossus', health: 15000, radius: 3.7, height: 11.8, speed: 3.3, damage: 74, cave: false, notice: 80, leash: 140, temperament: 'defensive', boss: true, reach: 12, windup: 1.8, cooldown: 5.5,
    pursuit: { range: 1200, seconds: 45, speed: 6.8 },
    ranged: { range: 1100, minRange: 25, damage: 84, radius: 11, windup: 1.8, speed: 190, cooldown: 10 },
    bossReward: { salvage: 650, weapon: 6, ammoCrates: 2 } },
  { name: 'Reef Prowler', health: 170, radius: .78, height: 1.3, speed: 5.8, damage: 20, cave: false, notice: 35, leash: 76, temperament: 'hunter' },
  { name: 'Tide Behemoth', health: 13500, radius: 4.2, height: 8.6, speed: 3.5, damage: 68, cave: false, notice: 78, leash: 145, temperament: 'defensive', boss: true, reach: 12, windup: 1.6, cooldown: 5.2,
    pursuit: { range: 1200, seconds: 45, speed: 7.2 },
    ranged: { range: 950, minRange: 24, damage: 78, radius: 10, windup: 1.6, speed: 230, cooldown: 9 },
    bossReward: { salvage: 600, weapon: 6, ammoCrates: 2 } },
];
export const MAX_CREATURES = 96;
export const MAX_VISIBLE_CREATURES = 24;

/** Rosters describe ecology independently of terrain generators or faction AI.
 * New ocean worlds can add aquatic movement without treating water as land. */
export type CreatureHabitat = 'surface' | 'cave' | 'shore';
export interface EcologyEntry {
  species: number; weight: number; group: readonly [number, number]; habitat: CreatureHabitat;
  minTemperature?: number; maxTemperature?: number; minVolcanic?: number; maxElevation?: number;
}
export interface PlanetEcology { id: string; roster: readonly EcologyEntry[] }
const nativeSurface: readonly EcologyEntry[] = [
  { species: 0, weight: 17, group: [2, 3], habitat: 'surface' },
  { species: 3, weight: 16, group: [2, 3], habitat: 'surface' },
  { species: 4, weight: 10, group: [2, 2], habitat: 'surface' },
  { species: 1, weight: 7, group: [2, 2], habitat: 'surface' },
];
const nativeCaves: readonly EcologyEntry[] = [
  { species: 2, weight: 1, group: [2, 2], habitat: 'cave' },
  { species: 5, weight: 1, group: [2, 3], habitat: 'cave' },
];
export const PLANET_ECOLOGIES: Readonly<Record<string, PlanetEcology>> = {
  meridian: { id: 'meridian', roster: [...nativeSurface, ...nativeCaves,
    { species: 6, weight: 32, group: [3, 5], habitat: 'surface' },
    { species: 7, weight: 14, group: [2, 3], habitat: 'surface' },
    { species: 8, weight: 8, group: [1, 2], habitat: 'surface' },
    { species: 9, weight: 1.3, group: [1, 1], habitat: 'surface', minTemperature: .12 },
  ] },
  cinder: { id: 'cinder', roster: [...nativeSurface, ...nativeCaves,
    { species: 10, weight: 40, group: [3, 4], habitat: 'surface' },
    { species: 11, weight: 3, group: [1, 1], habitat: 'surface', minVolcanic: .3 },
  ] },
  nacre: { id: 'nacre', roster: [...nativeSurface, ...nativeCaves,
    { species: 12, weight: 44, group: [2, 4], habitat: 'surface' },
    { species: 13, weight: 3, group: [1, 1], habitat: 'shore', maxElevation: 35 },
  ] },
  native: { id: 'native', roster: [...nativeSurface, ...nativeCaves] },
};

/** Unknown worlds never inherit Meridian's undead accidentally. */
export function ecologyForWorld(seed: number, planetId?: string): PlanetEcology {
  if (planetId && PLANET_ECOLOGIES[planetId]) return PLANET_ECOLOGIES[planetId];
  return PLANET_ECOLOGIES[seed === 1337 ? 'meridian' : seed === 7331 ? 'cinder' : seed === 20077 ? 'nacre' : 'native'];
}
export function ecologyCandidates(profile: PlanetEcology, habitat: 'surface' | 'cave',
  column: { h: number; temp: number; volc: number }, nearShore = false): readonly EcologyEntry[] {
  return profile.roster.filter(entry => (entry.habitat === habitat || habitat === 'surface' && entry.habitat === 'shore' && nearShore) &&
    column.temp >= (entry.minTemperature ?? -Infinity) && column.temp <= (entry.maxTemperature ?? Infinity) &&
    column.volc >= (entry.minVolcanic ?? -Infinity) && column.h <= (entry.maxElevation ?? Infinity));
}
export function chooseEcologyEntry(entries: readonly EcologyEntry[], roll: number): EcologyEntry | undefined {
  let remaining = Math.max(0, Math.min(.999999, roll)) * entries.reduce((sum, entry) => sum + entry.weight, 0);
  for (const entry of entries) { remaining -= entry.weight; if (remaining < 0) return entry; }
  return undefined;
}
