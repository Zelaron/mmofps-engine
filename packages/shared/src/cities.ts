import { clamp } from './math.js';
import { hash2i, mulberry32 } from './rng.js';
import { STRUCTURE_KIND, type StructureSite } from './structures.js';
import type { Box } from './worldgen.js';
import { buildVesperPlan } from './vesper-city.js';
import { buildAureliaPlan } from './aurelia-city.js';
import type { CapitalPlan } from './capital-geometry.js';
import { cityLifePlan } from './city-life.js';
import { planetBySeed } from './universe.js';

export const CITY_RADIUS = 384;
/** Public arcades admit the standard tank's 3.8m collision hull with room
 * for suspension movement. Street floors stay level with their avenues. */
export const CITY_ARCADE_CLEARANCE = 4.6;
export type CityTheme = 'vesper' | 'aurelia';
export interface CityDistrict { id: number; name: string; x: number; y: number; z: number; radius: number; seed: number; theme?: CityTheme }
export interface CityLiftSite { id: number; cityId: number; x: number; z: number; bottom: number; top: number; hx: number; hz: number; phase: number; dwell?: number }
export interface CityVehicleSite { id: number; cityId: number; x: number; y: number; z: number; heading: number; type: 2 | 3; variant: 1 | 2; hx: number; hz: number }
export interface CityRewardSite { id: number; cityId: number; x: number; y: number; z: number; weapon: 7 | 8 }

/** Deck heights are world-space feet/support heights, not platform centers. */
export function cityLiftSites(city: CityDistrict): readonly CityLiftSite[] {
  if (city.theme) return capitalPlan(city)!.lifts;
  const floor = city.y + .06;
  const sites: CityLiftSite[] = [[-128, -128], [128, -128], [128, 128], [-128, 128]].map(([x, z], i) => ({
    id: city.id * 100 + i + 1, cityId: city.id, x: city.x + x, z: city.z + z,
    bottom: floor, top: floor + 24, hx: 2.2, hz: 2.2, phase: i * 3,
  }));
  if (city.theme) sites.push({ id: city.id * 100 + 5, cityId: city.id, x: city.x + 128, z: city.z - 32,
    bottom: floor + 24, top: floor + 70, hx: 2.2, hz: 2.2, phase: 0 });
  return sites;
}

export function cityVehicleSites(city: CityDistrict): readonly CityVehicleSite[] {
  if (city.theme) return capitalPlan(city)!.vehicles;
  if (!city.theme) return [];
  return [{ id: city.id * 100 + 80, cityId: city.id, x: city.x + (city.theme === 'vesper' ? 256 : 192),
    y: city.y + .06, z: city.z + (city.theme === 'vesper' ? -256 : 192), heading: 0,
    type: city.theme === 'vesper' ? 3 : 2, variant: city.theme === 'vesper' ? 1 : 2, hx: 18, hz: 18 }];
}

export function cityRewardSites(city: CityDistrict): readonly CityRewardSite[] {
  if (city.theme) return capitalPlan(city)!.rewards;
  return [{ id: city.id * 100 + 90, cityId: city.id, x: city.x + 96,
    y: city.y + .06 + (city.theme ? 70 : 24), z: city.z + (city.theme ? -10 : 104), weapon: city.id % 2 ? 8 : 7 }];
}
export interface CityBlock { site: StructureSite; pad: Box; solids: Box[]; cuts: Box[] }
export type CityParcelKind = 'square' | 'park' | 'tower' | 'terrace' | 'warehouse' | 'market' | 'civic' | 'roof' | 'route';

/** Sparse outer neighborhoods enlarge the city without multiplying cover. */
export function cityParcelKind(city: CityDistrict, bx: number, bz: number): CityParcelKind {
  const radius = Math.max(Math.abs(bx + .5), Math.abs(bz + .5));
  if (Math.abs(bx + .5) === 1.5 && Math.abs(bz + .5) === 1.5) return 'route';
  if (city.theme && ((bx === 1 && bz === 0) || (bx === 0 && bz === 1))) return 'park';
  const pad = cityVehicleSites(city)[0];
  if (pad && Math.abs(city.x + (bx + .5) * 64 - pad.x) < 48 && Math.abs(city.z + (bz + .5) * 64 - pad.z) < 48) return 'square';
  if (radius < 1) return 'square';
  if (bx === 1 && bz === -1 || bx === -2 && bz === 0) return 'tower';
  const rng = mulberry32(hash2i(city.seed ^ 0x61a83, bx, bz));
  if (radius >= 4 && rng() > .38) return 'park';
  if (radius < 2.6) return bx > 0 && bz > 0 && (bx + bz) % 3 === 0 ? 'civic' : 'tower';
  if ((bx + bz + city.id + 16) % 5 === 0) return 'roof';
  if (bx < 0 && bz >= 0) return 'terrace';
  if (bx >= 0 && bz < 0) return 'warehouse';
  return (bx + bz) % 2 === 0 ? 'market' : 'civic';
}

/** Two ordinary regional cities and two distant capitals preserve wilderness. */
export function generateCities(seed: number, height: (x: number, z: number) => number,
  safe: (x: number, z: number) => boolean): CityDistrict[] {
  const candidates = [[[-2, 2], [-3, 1], [-1, 3], [-3, 3]], [[3, -2], [2, -3], [4, -1], [4, -3]],
    [[-4, -4], [-5, -3], [-3, -5], [-5, -5]], [[5, 5], [4, 6], [6, 4], [6, 6]]];
  return candidates.map((choices, id) => {
    const rng = mulberry32(hash2i(seed ^ 0x6c171, id, 3));
    const offset = Math.floor(rng() * choices.length);
    let picked = choices[offset];
    for (let i = 0; i < choices.length; i++) {
      const next = choices[(i + offset) % choices.length];
      if (safe(next[0] * 1024, next[1] * 1024)) { picked = next; break; }
    }
    const x = picked[0] * 1024, z = picked[1] * 1024;
    const heights = [[0, 0], [-128, 0], [128, 0], [0, -128], [0, 128]].map(([dx, dz]) => height(x + dx, z + dz)).sort((a, b) => a - b);
    return { id, name: planetBySeed(seed).cities[id],
      theme: id === 2 ? 'vesper' : id === 3 ? 'aurelia' : undefined,
      x, z, y: clamp(heights[2], 0, 105), radius: id === 2 ? 2000 : id === 3 ? 1800 : CITY_RADIUS,
      seed: hash2i(seed ^ 0x21d71, id, 7) };
  });
}

/** Every building and its exact paved floor stay inside one streaming cell. */
export function buildCityBlock(city: CityDistrict, cellX: number, cellZ: number): CityBlock | null {
  if (city.theme) return capitalBlock(city, cellX, cellZ);
  const x0 = Math.max(cellX * 256, city.x - city.radius), z0 = Math.max(cellZ * 256, city.z - city.radius);
  const x1 = Math.min((cellX + 1) * 256, city.x + city.radius), z1 = Math.min((cellZ + 1) * 256, city.z + city.radius);
  if (x1 <= x0 || z1 <= z0) return null;
  const floor = city.y + .06;
  const slab: Box = { x: (x0 + x1) * .5, y: floor - .56, z: (z0 + z1) * .5, hx: (x1 - x0) * .5, hy: .56, hz: (z1 - z0) * .5, facade: 5, floorY: floor };
  const solids: Box[] = [slab];
  const add = (x: number, y: number, z: number, hx: number, hy: number, hz: number, facade = 4): void => {
    // Every visual primitive is also reliable authoritative collision cover.
    if (city.theme) facade += city.theme === 'vesper' ? 16 : 32;
    solids.push({ x, y: floor + y, z, hx: Math.max(.19, hx), hy: Math.max(.19, hy), hz: Math.max(.19, hz), facade, floorY: floor });
  };
  // Network pieces are clipped into their canonical generation cells. A
  // bridge crossing a boundary never forces global ownership decomposition.
  const network = (x: number, y: number, z: number, hx: number, hy: number, hz: number, facade = 4): void => {
    const ax = Math.max(x - hx, x0), bx = Math.min(x + hx, x1), az = Math.max(z - hz, z0), bz = Math.min(z + hz, z1);
    if (bx - ax < .38 || bz - az < .38) return;
    add((ax + bx) * .5, y, (az + bz) * .5, (bx - ax) * .5, hy, (bz - az) * .5, facade);
  };
  const ring = (x: number, z: number, top: number): void => {
    for (const side of [-1, 1]) {
      network(x, top - .3, z + side * 4.3, 6, .3, 1.7);
      network(x + side * 4.3, top - .3, z, 1.7, .3, 2.6);
    }
  };
  for (const lift of cityLiftSites(city)) ring(lift.x, lift.z, lift.top - floor);
  for (const side of [-1, 1]) {
    network(city.x, 23.7, city.z + side * 128, 122, .3, 2.5);
    if (side < 0 || !city.theme) network(city.x + side * 128, 23.7, city.z, 2.5, .3, 122);
    else {
      // Leave the high lift shaft open at its lower promenade stop.
      network(city.x + 128, 23.7, city.z - 80, 2.5, .3, 42);
      network(city.x + 128, 23.7, city.z + 48, 2.5, .3, 74);
      ring(city.x + 128, city.z - 32, 24);
    }
    for (const p of [-64, 64]) {
      network(city.x + p, 11.7, city.z + side * 128 + 4.7, .65, 11.7, .65);
      network(city.x + side * 128 + 4.7, 11.7, city.z + p, .65, 11.7, .65);
      // Sidewalk columns meet the deck through overhead crossheads; the
      // street below remains clear for vehicles, including its central axis.
      network(city.x + p, 23.15, city.z + side * 128 + 2.35, .65, .25, 3);
      network(city.x + side * 128 + 2.35, 23.15, city.z + p, 3, .25, .65);
    }
  }
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    network(city.x + sx * 113, 23.7, city.z + sz * 120, 11, .3, 2.5);
    network(city.x + sx * 124, 23.7, city.z + sz * 122, 2.5, .3, 4);
  }
  if (city.theme) {
    // A broad terrace wraps the central tower at the high lift's stop.
    // Its actual floor reaches both the weapon and neighboring ammo pickup.
    network(city.x + 96, 69.7, city.z - 32, 25, .3, 25);
    network(city.x + 122, 69.7, city.z - 32, 2, .3, 3);
    // Secondary high promenade: outside the main shaft and well above the
    // ordinary street. Two overlooks give the capital more vertical routes.
    network(city.x + 96, 69.7, city.z + 28, 3, .3, 35);
    network(city.x + 72, 69.7, city.z + 63, 27, .3, 3);
    network(city.x + 48, 69.7, city.z + 76, 12, .3, 16);
  }
  for (let z = z0 + 32; z < z1; z += 64) for (let x = x0 + 32; x < x1; x += 64) {
    const bx = Math.floor((x - city.x) / 64), bz = Math.floor((z - city.z) / 64);
    const rng = mulberry32(hash2i(city.seed, bx, bz));
    const kind = cityParcelKind(city, bx, bz);
    if (kind === 'route') {
      // A real two-flight staircase climbs through an open roof well.
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(x + sx * 22.5, 11.7, z + sz * 22.5, 1.3, 11.7, 1.3);
      add(x - 8.5, 23.7, z, 15.5, .3, 24);
      add(x + 22, 23.7, z, 2, .3, 24);
      add(x + 13.5, 23.7, z - 20, 6.5, .3, 4);
      add(x + 13.5, 23.7, z + 20, 6.5, .3, 4);
      for (let i = 0; i < 40; i++) {
        add(x + 17, (i + 1) * .15, z + 14 - i * .65, 1.4, (i + 1) * .15, .36);
        const top = 12 + (i + 1) * .3;
        add(x + 11, (top + 12) * .5, z - 12.7 + i * .65, 1.4, (top - 12) * .5, .36);
      }
      // Running up steps carries vertical and forward momentum. A deep
      // turning court catches that hop before the return flight begins.
      add(x + 14, 11.7, z - 15.5, 6, .3, 4.15);
      add(x + 14, 13, z - 20.1, 6.4, 1, .45, 6);
      for (const side of [-1, 1]) add(x + 14 + side * 6.4, 13, z - 16, .4, 1, 4.5, 6);
      add(x + 11, 23.7, z + 15.5, 1.4, .3, 3.3);
      continue;
    }
    // Four central blocks join into a broad public square, with an open
    // crossing and low cover along its edges rather than a blocked center.
    if (kind === 'square') {
      const pad = cityVehicleSites(city)[0];
      if (pad && Math.abs(x - pad.x) < 48 && Math.abs(z - pad.z) < 48) continue;
      const sx = Math.sign(x - city.x), sz = Math.sign(z - city.z);
      add(x + sx * 14, .45, z + sz * 14, 8, .45, 1.1);
      add(x + sx * 14, .68, z + sz * 12, 8, .12, .4);
      add(x - sx * 6, .6, z + sz * 14, 1.5, .6, 1.5);
      continue;
    }
    if (kind === 'park') {
      // Grass is part of the exact pavement mesh. Benches and low planters
      // sit at the edges, leaving a broad crossing through each garden.
      for (const side of [-1, 1]) {
        add(x + side * 17, .43, z + side * 16, 3.6, .43, .65);
        add(x + side * 17, .86, z + side * 16.45, 3.6, .2, .2);
      }
      continue;
    }
    if (city.theme && kind !== 'roof') {
      const dark = city.theme === 'vesper';
      const limit = Math.min(dark ? 206 : 198, 264 - floor);
      const main = bx === 1 && bz === -1;
      const cathedral = bx === -2 && bz === 0;
      const piers = (halfX: number, halfZ: number, top: number): void => {
        for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(x + sx * halfX, top * .5, z + sz * halfZ, 1.5, top * .5, 1.5);
      };
      const taper = (px: number, pz: number, start: number, height: number, radius: number, style = 6): void => {
        for (let level = 0; level < 9; level++) {
          const step = height / 9, width = Math.max(.45, radius * (1 - level / 9));
          add(px, start + (level + .5) * step, pz, width, step * .5, width, style);
        }
      };
      if (main) {
        piers(14, 14, 24);
        add(x, 23.5, z, 19, .5, 19);
        if (dark) {
          const shoulder = limit * .70;
          add(x, (24 + shoulder) * .5, z, 12, (shoulder - 24) * .5, 12, 3);
          taper(x, z, shoulder, limit - shoulder, 12, 6);
          for (const side of [-1, 1]) {
            add(x + side * 17, 47, z + side * 17, 2.8, 23, 2.8, 6);
            taper(x + side * 17, z + side * 17, 70, 28, 3, 6);
          }
        } else {
          add(x, 50, z, 14, 26, 14, 1);
          add(x, 77, z, 19, 1, 19, 7);
          add(x, 104, z, 11, 26, 11, 1);
          add(x, 131, z, 15, 1, 15, 7);
          const upperTop = Math.max(142, limit - 14);
          add(x, (132 + upperTop) * .5, z, 7, (upperTop - 132) * .5, 7, 1);
          // The imperial dome sits on a broad supported drum, not a needle.
          add(x, upperTop + .6, z, 11.5, .6, 11.5, 7);
        }
        continue;
      }
      if (cathedral) {
        piers(20, 18, 12);
        add(x, 12.7, z, 23, .7, 21, 7);
        if (dark) {
          for (const side of [-1, 1]) {
            const top = limit * (side < 0 ? .80 : .66);
            add(x + side * 13, (top + 13.4) * .5, z, 6.5, (top - 13.4) * .5, 14, 3);
            taper(x + side * 13, z, top, 16, 7, 6);
          }
          add(x, 76, z, 19.5, 3, 8, 6);
        } else {
          // A monumental long nave, stepped pitched roof and twin belfries.
          add(x, 28, z, 18, 14.6, 20, 1);
          for (let tier = 0; tier < 5; tier++) add(x, 44 + tier * 2.2, z, 20 - tier * 3.6, 1.1, 23, 7);
          add(x, 55, z, 13, .8, 13, 7);
          for (const side of [-1, 1]) {
            add(x + side * 15, 61, z - 14, 5, 19, 5, 1);
            taper(x + side * 15, z - 14, 80, 27, 6, 7);
          }
        }
        continue;
      }
      const variant = Math.abs(bx * 3 + bz * 5) % 3;
      if (kind === 'tower') {
        const height = 48 + rng() * 44;
        piers(16, 16, 12);
        add(x, 12.6, z, 20, .6, 20);
        if (dark && variant === 1) {
          for (const side of [-1, 1]) {
            add(x + side * 10, (height + 13.2) * .5, z, 5, (height - 13.2) * .5, 12, 3);
            taper(x + side * 10, z, height, 20, 5, 6);
          }
          add(x, height * .6, z, 15, 2, 6, 6);
        } else if (dark) {
          add(x, (height + 13.2) * .5, z, variant ? 10 : 15, (height - 13.2) * .5, variant ? 16 : 10, 3);
          taper(x, z, height, 24, variant ? 11 : 15, 6);
          for (const side of [-1, 1]) add(x + side * 18, 24, z, 1.5, 12, 11, 6);
        } else {
          add(x, (height + 13.2) * .5, z, 17, (height - 13.2) * .5, 17, 1);
          add(x, height + .7, z, 20, .7, 20, 7);
          if ((bx + bz) % 2 === 0) add(x, height + 1.8, z, 18, .4, 18, 7);
          else if (variant === 0) taper(x, z, height + 1.4, 13, 15, 7);
          else for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
            add(x + sx * 14, height + 5, z + sz * 14, 3, 3.6, 3, 1);
            add(x + sx * 14, height + 9, z + sz * 14, 3.7, .5, 3.7, 7);
          }
        }
      } else if (kind === 'warehouse') {
        piers(22, 18, 10);
        add(x, 10.6, z, 24, .6, 20, 6);
        for (const side of [-1, 1]) {
          add(x + side * 18, 16, z - 12, 4, 5, 5, dark ? 3 : 1);
          if (dark) taper(x + side * 18, z - 12, 21, 16, 4, 6);
          else add(x + side * 18, 21.7, z - 12, 5, .7, 6, 7);
        }
      } else if (kind === 'market') {
        for (const side of [-1, 1]) {
          add(x + side * 18, 7, z, 2, 7, 17, dark ? 3 : 1);
          add(x + side * 10, 14.8, z, 10, .8, 18, dark ? 6 : 7);
          if (dark) taper(x + side * 18, z, 15.6, 12, 3, 6);
        }
      } else {
        piers(20, 18, 7);
        add(x, 7.6, z, 22, .6, 20, dark ? 6 : 7);
        add(x - 7, 16, z - 5, 13, 7.8, 13, dark ? 3 : 1);
        add(x - 7, 24.6, z - 5, 15, .8, 15, dark ? 6 : 7);
        if (dark) {
          taper(x - 7, z - 5, 25.4, 22, 11, 6);
          add(x + 15, 13, z + 11, 3, 5, 3, 3);
        } else {
          add(x - 7, 29, z - 5, 10, 3.6, 10, 1);
          taper(x - 7, z - 5, 32.6, 9, 12, 7);
          add(x + 16, 17, z + 10, 4, 8.8, 4, 1);
          add(x + 16, 26.5, z + 10, 5, .7, 5, 7);
        }
      }
      continue;
    }
    const core = Math.max(Math.abs(bx + .5), Math.abs(bz + .5)) < 2.6;
    const landmark = bx === 1 && bz === -1 || bx === -2 && bz === 0;
    const lowRoof = kind === 'roof';
    const height = landmark ? (bx === 1 ? 78 : 61) : lowRoof ? CITY_ARCADE_CLEARANCE + .6 : core ? 22 + Math.floor(rng() * 9) * 3.6 : 8 + Math.floor(rng() * 5) * 3.6;
    const hx = 15 + rng() * 6, hz = 15 + rng() * 6;
    const facade = 1 + Math.floor(rng() * 3);
    const lobby = CITY_ARCADE_CLEARANCE;
    // Four substantial piers support open arcades at street level. Keeping
    // these broad openings also makes the larger city cheaper to collide.
    const piers = (px: number, pz: number, halfX: number, halfZ: number, top: number): void => {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(px + sx * (halfX - 1.1), top * .5, pz + sz * (halfZ - 1.1), 1.1, top * .5, 1.1);
    };
    if (kind === 'market') {
      // Two covered market aisles with a street-to-street central passage.
      for (const side of [-1, 1]) {
        piers(x + side * 11, z, 7, 18, lobby);
        add(x + side * 11, lobby + .3, z, 8, .3, 19, 8);
        add(x + side * 11, .6, z + 12, 4.7, .6, 1);
      }
      continue;
    }
    if (kind === 'warehouse') {
      // Long industrial sheds have broad loading bays, stepped sawtooth
      // roof sections and a chimney, distinct from the glass skyline.
      piers(x, z, 22, 18, 6.4);
      add(x - 21.5, 3.2, z, .5, 3.2, 16, 6);
      add(x + 21.5, 3.2, z, .5, 3.2, 16, 6);
      for (let bay = -1; bay <= 1; bay++) {
        add(x + bay * 14, 6.6, z, 7, .3, 19, 6);
        add(x + bay * 14 - 3, 7.25, z, 4, .35, 18, 6);
      }
      add(x - 17, 9, z - 13, 1.1, 3, 1.1, 6);
      continue;
    }
    if (kind === 'civic') {
      // A low civic hall, colonnade and offset clock/bell tower punctuate
      // neighborhoods without another full-footprint high-rise.
      piers(x, z, 21, 17, lobby);
      add(x, lobby + .3, z, 22, .3, 18);
      add(x, lobby + 2, z - 4, 16, 1.4, 10, 1);
      add(x, lobby + 3.7, z - 4, 17, .3, 11);
      add(x - 15, lobby + 8.8, z - 10, 4, 5, 4, 1);
      add(x - 15, lobby + 14.4, z - 10, 4.8, .6, 4.8, 7);
      continue;
    }
    piers(x, z, hx, hz, lobby);
    if (lowRoof) {
      add(x, lobby + .3, z, hx + .5, .3, hz + .5);
      // The stair rises outside the building and joins its actual roof.
      const steps = 15, rise = height / steps;
      for (let i = 0; i < steps; i++) add(x + hx + 3.2, (i + 1) * rise * .5,
        z + hz - 1 - i * .6, 1.3, (i + 1) * rise * .5, .325);
      add(x + hx + 1.5, height - .2, z + hz - 10.1, 2.1, .2, 1.4);
      add(x - hx, height + .35, z, .2, .35, hz);
      add(x, height + .35, z - hz, hx, .35, .2);
    } else if (kind === 'terrace') {
      const story = 8 + Math.floor(rng() * 3) * 3.3;
      add(x, (story + lobby) * .5, z, hx, (story - lobby) * .5, hz, 2);
      add(x, story + .25, z, hx + .6, .25, hz + .6, 7);
      // Offset upper wings and broad terraces break the box silhouette.
      add(x - hx * .34, story + 2.4, z - hz * .28, hx * .65, 1.9, hz * .7, 2);
      add(x - hx * .34, story + 4.5, z - hz * .28, hx * .68, .25, hz * .73, 7);
      add(x + hx - 1, story + .65, z + hz - 1, .3, .4, 6, 7);
    } else {
      add(x, (height + lobby) * .5, z, hx, (height - lobby) * .5, hz, facade);
      add(x, height + .25, z, hx + .65, .25, hz + .65);
      const upper = landmark || core && rng() > .45;
      if (upper) {
        const cap = landmark ? 8 : 3.6;
        add(x, height + .5 + cap * .5, z, hx * .62, cap * .5, hz * .58, facade);
        add(x, height + .65 + cap, z, hx * .66, .15, hz * .62);
      }
      if (landmark) add(x, height + 12, z, .65, 4, .65);
      add(x - hx + 4, height + 1.2, z + hz - 4, 2, .7, 2);
    }
    // An awning and short bollards distinguish shopfronts without windows
    // made from transparent polygons or additional dynamic lights.
    add(x, lobby + .19, z + hz + 1.1, 5, .19, 1.5);
    for (const side of [-1, 1]) add(x + side * 5, .65, z + hz + 3, .22, .65, .22);
  }
  solids.push(...cityLifePlan(city).solids.filter(box => box.x + box.hx > x0 && box.x - box.hx < x1 &&
    box.z + box.hz > z0 && box.z - box.hz < z1));
  return { site: { kind: STRUCTURE_KIND.CITY_BLOCK, x: slab.x, z: slab.z, top: floor, hx: slab.hx, hz: slab.hz, rotated: false },
    pad: { ...slab, y: slab.y - .02 }, solids, cuts: [] };
}

export function capitalPlan(city: CityDistrict): CapitalPlan | null {
  return city.theme === 'vesper' ? buildVesperPlan(city) : city.theme === 'aurelia' ? buildAureliaPlan(city) : null;
}

const capitalBlocks = new WeakMap<CapitalPlan, Map<string, CityBlock>>();
/** Index full canonical decks in overlapping cells. Clipping collision boxes
 * would introduce zero-distance internal planes at every streaming seam. */
function capitalBlock(city: CityDistrict, cx: number, cz: number): CityBlock | null {
  const plan = capitalPlan(city)!;
  let blocks = capitalBlocks.get(plan);
  if (!blocks) {
    blocks = new Map();
    for (const box of [...plan.solids, ...cityLifePlan(city).solids]) {
      box.capital = true;
      for (let iz = Math.floor((box.z - box.hz) / 256); iz <= Math.floor((box.z + box.hz - .00001) / 256); iz++)
        for (let ix = Math.floor((box.x - box.hx) / 256); ix <= Math.floor((box.x + box.hx - .00001) / 256); ix++) {
          const x0 = Math.max(ix * 256, box.x - box.hx), x1 = Math.min((ix + 1) * 256, box.x + box.hx);
          const z0 = Math.max(iz * 256, box.z - box.hz), z1 = Math.min((iz + 1) * 256, box.z + box.hz);
          const clipped = { ...box, x: (x0 + x1) / 2, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hz: (z1 - z0) / 2 };
          const key = `${ix},${iz}`;
          if (!blocks.has(key)) blocks.set(key, { site: { kind: STRUCTURE_KIND.CITY_BLOCK, x: ix * 256 + 128, z: iz * 256 + 128,
            top: city.y, hx: 128, hz: 128, rotated: false }, pad: { ...clipped, y: -10000 }, solids: [], cuts: [] });
          blocks.get(key)!.solids.push(box);
        }
    }
    capitalBlocks.set(plan, blocks);
  }
  return blocks.get(`${cx},${cz}`) ?? null;
}
