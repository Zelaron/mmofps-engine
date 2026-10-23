import { smoothstep } from './math.js';

interface ClimateColumn { h: number; temp: number }

// World relief is compressed into a few hundred metres. Ordinary hills must
// remain in their regional climate; only the upper ranges receive snowcaps.
export const ALPINE_ROCK_START = 135;
export const ALPINE_ROCK_END = 195;

export function surfaceTemperature(col: ClimateColumn, y = col.h): number {
  return col.temp - Math.max(0, y - 80) * .0025;
}

/** Shared frost line for terrain color, footsteps, trees and ground cover. */
export function snowCover(col: ClimateColumn, y = col.h, normalY = 1): number {
  return (1 - smoothstep(.12, .24, surfaceTemperature(col, y))) * smoothstep(.3, .65, normalY);
}
