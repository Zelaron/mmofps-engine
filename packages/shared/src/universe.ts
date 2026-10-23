import type { World } from './worldgen.js';

export const PLANETS = [
  { id: 'meridian', name: 'Meridian', seed: 1337, color: '#88dfc7', orbit: 1,
    description: 'The inhabited frontier. Great cities, deep forests, and a contested coast.',
    cities: ['Meridian', 'Ironhaven', 'Vesper Reach', 'Aurelia Bastion'] },
  { id: 'cinder', name: 'Cinder', seed: 7331, color: '#f2a17a', orbit: 2,
    description: 'A second frontier of mountain routes, buried passages, and rival settlements.',
    cities: ['Ashwater', 'Furnace Reach', 'Nocturne', 'Sunforge'] },
  { id: 'nacre', name: 'Nacre', seed: 20077, color: '#b6cfff', orbit: 3,
    description: 'The outer colonies. Follow unfamiliar rivers, railways, and ocean crossings.',
    cities: ['Pelagos', 'Icefall', 'Silent Reach', 'Solace'] },
] as const;
export type PlanetId = typeof PLANETS[number]['id'];
export function planetById(id: unknown) { return PLANETS.find(p => p.id === id); }
export function planetBySeed(seed: number) { return PLANETS.find(p => p.seed === seed) ?? PLANETS[0]; }
export interface UniverseStatus {
  system: string; stars: string[];
  planets: { id: PlanetId; available: boolean; players: number; capacity: number;
    /** Shares of control points: unclaimed, Accord, Helix, Vanguard. */
    ownership?: [number, number, number, number];
    campaign?: { botPopulation: [number, number, number, number]; threatenedBases: number; inboundSquads: number } }[];
}
export interface JourneyState {
  phase: 'charging' | 'departing' | 'arriving' | 'cancelled' | 'committed';
  destination: PlanetId; remaining: number; message?: string;
}
export const ORBITAL_CHARGE_SECONDS = 5;
/** Existing physical transit terminals become the orbital network's harbors. */
export function spaceports(world: Pick<World, 'collectTransportPlan'>) { return world.collectTransportPlan().pods; }
export function nearestSpaceport(world: Pick<World, 'collectTransportPlan'>, position: { x: number; y: number; z: number }) {
  let nearest: ReturnType<typeof spaceports>[number] | null = null, distance = Infinity;
  for (const port of spaceports(world)) {
    const d = Math.hypot(position.x - port.x, position.y - port.y, position.z - port.z);
    if (d < distance) { distance = d; nearest = port; }
  }
  return nearest ? { port: nearest, distance } : null;
}
