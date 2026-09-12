export type CityTheme = 'vesper' | 'aurelia';
export interface CityThemeSite { x: number; y: number; z: number; radius: number; theme?: CityTheme }
export interface CityThemeInfluence { vesper: number; aurelia: number }

/** Capitals grade gently into surrounding country. This is a visual query:
 * no terrain sampling, cached world regions, or changes to collision. */
export const CITY_THEME_INNER_SCALE = 1.22;
export const CITY_THEME_FADE_METRES = 560;

export const CITY_THEME_PALETTES = {
  vesper: { skyTop: 0x061d25, horizon: 0x194945, cloudLow: 0x082626, cloudHigh: 0x5aab86,
    sun: 0x91edc5, skyLight: 0x94c9bc, groundLight: 0x143836, sunLight: 0x91d9c1,
    rock: 0x535366, vegetation: 0x47857d, mineral: 0x5fc8ce },
  aurelia: { skyTop: 0x57442e, horizon: 0xc6a26d, cloudLow: 0x665238, cloudHigh: 0xffd79b,
    sun: 0xffc773, skyLight: 0xd4c1a1, groundLight: 0x51412c, sunLight: 0xffd39a,
    rock: 0x626264, vegetation: 0x659046, mineral: 0xc9ac64 },
} as const;

function fade(value: number, inner: number, outer: number): number {
  const t = Math.max(0, Math.min(1, (value - inner) / (outer - inner)));
  return 1 - t * t * (3 - 2 * t);
}

/** Actual view position drives the sky; ordinary cities have no influence.
 * Underground positions retain the exterior sky for visible cave exits. */
export function cityThemeInfluence(cities: readonly CityThemeSite[], x: number, y: number, z: number,
  result: CityThemeInfluence = { vesper: 0, aurelia: 0 }): CityThemeInfluence {
  result.vesper = result.aurelia = 0;
  if (!Number.isFinite(x + y + z)) return result;
  for (const city of cities) {
    if ((city.theme !== 'vesper' && city.theme !== 'aurelia') ||
      !Number.isFinite(city.x + city.y + city.z + city.radius) || city.radius <= 0) continue;
    const inner = city.radius * CITY_THEME_INNER_SCALE;
    const weight = fade(Math.hypot(x - city.x, z - city.z), inner, inner + CITY_THEME_FADE_METRES) *
      fade(y - city.y, city.radius > 1000 ? 1600 : 320, city.radius > 1000 ? 2800 : 1200);
    result[city.theme] = Math.max(result[city.theme], weight);
  }
  const total = result.vesper + result.aurelia;
  if (total > 1) { result.vesper /= total; result.aurelia /= total; }
  return result;
}
