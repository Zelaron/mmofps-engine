export interface CreatureState {
  id: number; species: number;
  x: number; y: number; z: number;
  yaw: number; speed: number; alert: boolean;
  dead?: boolean;
}

export const CREATURE_DEFS = [
  { name: 'Ridge Grazer', health: 45, radius: 0.6, height: 1.45, speed: 5, damage: 0, cave: false, notice: 18, leash: 28, temperament: 'passive' },
  { name: 'Dune Stalker', health: 85, radius: 0.52, height: 1.12, speed: 5.5, damage: 12, cave: false, notice: 30, leash: 48, temperament: 'hunter' },
  { name: 'Cave Skitter', health: 65, radius: 0.6, height: 0.82, speed: 4.8, damage: 9, cave: true, notice: 24, leash: 38, temperament: 'hunter' },
  { name: 'Crest Runner', health: 35, radius: 0.4, height: 1.9, speed: 7.4, damage: 0, cave: false, notice: 25, leash: 42, temperament: 'passive' },
  { name: 'Bristleback', health: 90, radius: 0.62, height: 1.12, speed: 4.3, damage: 10, cave: false, notice: 10, leash: 28, temperament: 'defensive' },
  { name: 'Glow Beetle', health: 30, radius: 0.48, height: 0.7, speed: 2.6, damage: 0, cave: true, notice: 9, leash: 18, temperament: 'passive' },
] as const;
export const MAX_CREATURES = 96;
export const MAX_VISIBLE_CREATURES = 18;
