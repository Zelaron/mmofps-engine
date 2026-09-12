import type { CityDistrict } from './cities.js';
import type { CapitalPlan, CapitalSweep } from './capital-geometry.js';
import { capitalBoundary } from './capital-geometry.js';
import { hash2i, mulberry32 } from './rng.js';

export const AURELIA_RADIUS = 1800;
export const AURELIA_STONE = [0xa59172, 0x786b58, 0xc0aa80, 0x554a3b, 0x918473, 0xb59a5e] as const;
const plans = new Map<string, CapitalPlan>();

/** A shrine metropolis, built from the same exact decks and swept stone ribs
 * used by both collision and rendering. No world queries or recursive cells. */
export function buildAureliaPlan(city: CityDistrict): CapitalPlan {
  const key = `${city.id}:${city.seed}:${city.x}:${city.y}:${city.z}:${city.radius}`;
  const cached = plans.get(key); if (cached) return cached;
  const plan: CapitalPlan = { solids: [], sweeps: [], lifts: [], vehicles: [], rewards: [] };
  const floor = city.y + .06, rng = mulberry32(city.seed ^ 0x6a91ef);
  let sweepId = city.id * 100000;
  const box = (x: number, bottom: number, z: number, hx: number, height: number, hz: number, shade = 0): void => {
    if (Math.min(hx, height, hz) < .2) return;
    plan.solids.push({ x: city.x + x, y: floor + bottom + height / 2, z: city.z + z,
      hx, hy: height / 2, hz, facade: 64 + shade, floorY: floor, capital: true });
  };
  const sweep = (kind: CapitalSweep['kind'], points: number[][], shade = 2, accent = 0xbfa664): void => {
    plan.sweeps.push({ id: ++sweepId, kind, color: AURELIA_STONE[shade % AURELIA_STONE.length], accent,
      points: points.map(([x, y, z, radius]) => ({ x: city.x + x, y: floor + y, z: city.z + z, radius })) });
  };
  const needle = (x: number, z: number, base: number, height: number, radius: number, shade = 2): void =>
    sweep('spire', [[x, base, z, radius], [x, base + height * .18, z, radius * .83],
      [x, base + height * .69, z, radius * .34], [x, base + height, z, .45]], shade);
  const dome = (x: number, z: number, base: number, radius: number, rise: number, shade = 5): void => {
    const points: number[][] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      points.push([x, base + rise * t, z, Math.max(.5, radius * Math.sqrt(1 - t * t))]);
    }
    sweep('dome', points, shade);
    needle(x, z, base + rise, radius * .8, radius * .045, 5);
  };
  const arch = (x: number, z: number, base: number, width: number, rise: number, radius: number, alongX = true, shade = 2): void => {
    const points: number[][] = [];
    for (let i = 0; i <= 16; i++) {
      const t = i / 16, offset = (t - .5) * width;
      // Two intersecting circular arcs make a true pointed Gothic opening:
      // nearly vertical at the springing, curved shoulders, a sharp crown.
      const shoulder = (Math.abs(t * 2 - 1) + 1) * .5;
      points.push([x + (alongX ? offset : 0), base + rise * Math.sqrt(Math.max(0, 1 - shoulder * shoulder)) / Math.sqrt(.75),
        z + (alongX ? 0 : offset), radius * (1 - .2 * Math.sin(Math.PI * t))]);
    }
    sweep('arch', points, shade);
  };
  const buttress = (x: number, z: number, dx: number, dz: number, top: number, radius: number): void => {
    const points: number[][] = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14;
      points.push([x + dx * (1 - t) ** 1.35, radius * .75 + (top - radius * .75) * t, z + dz * (1 - t) ** 1.35,
        radius * (1 - t * .56)]);
    }
    sweep('rib', points, 2);
  };
  const liftedBody = (x: number, z: number, width: number, depth: number, height: number, shade: number): void => {
    // Huge clear arcades, sculpted vertical piers and a recessed nave.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(x + sx * (width - 8), 0, z + sz * (depth - 8), 8, 35, 8, 1);
    box(x, 35, z, width, height * .64 - 35, depth, shade);
    box(x, height * .64, z, width * .76, height * .24, depth * .79, shade);
    box(x, height * .88, z, width * .54, height * .12, depth * .58, 1);
    for (const side of [-1, 1]) {
      box(x + side * width * .72, 22, z - depth - 3.2, 3.2, height * .9, 4.5, 2);
      arch(x, z + side * (depth + 3), height * .30, width * 1.4, height * .24, 2.4, true, 2);
      arch(x, z + side * (depth + 3.5), height * .60, width * 1.03, height * .18, 2.0, true, 2);
    }
    needle(x, z, height - 3, height * .25, width * .55, 2);
  };

  // Irregular urban rings leave cardinal processional avenues, open courts
  // and the complete elevated route spine. They are not a repeated grid.
  const reserved = (x: number, z: number, radius: number): boolean =>
    Math.abs(x) < radius + 72 || Math.abs(z) < radius + 65 ||
    Math.abs(x) < 770 + radius && Math.abs(Math.abs(z) - 160) < 48 + radius ||
    Math.abs(x) < 470 + radius && z < -160 + radius && z > -760 - radius;
  for (const [ring, count] of [[590, 15], [970, 25], [1340, 33], [1610, 39]]) {
    for (let i = 0; i < count; i++) {
      const angle = (i + .18 + rng() * .28) * Math.PI * 2 / count;
      const radius = ring + (rng() - .5) * 80, x = Math.cos(angle) * radius, z = Math.sin(angle) * radius;
      const width = 35 + rng() * 34, depth = 34 + rng() * 27;
      if (reserved(x, z, Math.max(width, depth) + 25) || capitalBoundary(city, city.x + x, city.z + z) > -110) continue;
      const shade = Math.floor(rng() * 3), kind = hash2i(city.seed, i, ring) % 4;
      const height = (210 + rng() * 360) * (1.18 - ring / 8500);
      if (kind === 0 || kind === 3) {
        liftedBody(x, z, width, depth, height, shade);
        for (const side of [-1, 1]) {
          buttress(x + side * width * .7, z, side * 31, side * depth * .55, height * .73, 4.5);
          needle(x + side * width * .86, z - depth * .7, height * .78, height * .42, 10, 2);
        }
      } else if (kind === 1) {
        // Twin choir towers frame a long nave with genuine open arches.
        liftedBody(x, z, width, depth, height * .59, shade);
        for (const side of [-1, 1]) {
          box(x + side * (width + 8), 0, z + depth * .55, 13, height, 15, 1);
          needle(x + side * (width + 8), z + depth * .55, height, height * .34, 15, 2);
        }
        dome(x, z, height * .57, width * .72, width * 1.03);
      } else {
        // Round reliquaries contrast with the cathedral blades.
        box(x, 0, z, width, height * .3, depth, 1);
        sweep('spire', [[x, height * .24, z, width * .8], [x, height * .62, z, width * .75],
          [x, height * .8, z, width * .61]], shade);
        dome(x, z, height * .80, width * .65, width * .84);
        for (const side of [-1, 1]) needle(x + side * width * .8, z, height * .38, height * .6, 8, 2);
      }
    }
  }

  // The palace is a single monumental composition: deep recessed masses,
  // giant pointed openings, paired bell towers and a 1.4 km choir pinnacle.
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(sx * 215, 0, -410 + sz * 140, 32, 150, 32, 1);
  box(0, 150, -410, 255, 360, 185, 1);
  box(0, 510, -410, 211, 265, 152, 0);
  box(0, 775, -410, 168, 135, 118, 1);
  dome(0, -410, 910, 150, 180, 5);
  needle(0, -410, 1060, 334, 49, 2);
  for (const side of [-1, 1]) {
    liftedBody(side * 282, -415, 38, 52, 980 + (side > 0 ? 90 : 0), 1);
    needle(side * 282, -415, side > 0 ? 1070 : 980, 235, 24, 2);
    liftedBody(side * 167, -205, 31, 34, 780, 0);
    needle(side * 167, -205, 780, 207, 23, 2);
    buttress(side * 235, -450, side * 170, 35, 790, 12);
    buttress(side * 188, -240, side * 172, 82, 595, 10);
    for (const y of [275, 540, 785]) {
      arch(side * 132, -219, y, 148, 144, 6.5, true, 2);
      for (const edge of [-1, 1]) box(side * 132 + edge * 74, y - 115, -219, 6.5, 116, 6.5, 2);
    }
    // Thin flying galleries join the palace to its outer bell towers.
    for (const y of [355, 655]) {
      box(side * 266, y - 5, -325, 45, 10, 11, 1);
      arch(side * 266, -325, y - 70, 84, 60, 4.5, true, 2);
    }
  }
  arch(0, -226, 0, 220, 148, 13, true, 2);
  arch(0, -217, 272, 172, 213, 8, true, 2);
  arch(0, -213, 520, 135, 226, 6.5, true, 2);
  for (const x of [-210, -105, 0, 105, 210]) {
    box(x, 151, -219, 5, 610, 9, 2);
    buttress(x, -243, 0, 101, 727, 6);
    needle(x, -219, 750, 140, 7, 2);
  }

  // Colossal guardians are architectural silhouettes, not floating props.
  for (const side of [-1, 1]) {
    const x = side * 258, z = 78;
    box(x, 0, z, 24, 16, 24, 1);
    box(x, 16, z, 15, 42, 14, 3);
    sweep('spire', [[x, 45, z, 22], [x, 94, z, 16], [x, 120, z - 2, 6]], 3);
    dome(x, z - 1, 119, 11, 15, 3);
    sweep('rib', [[x - side * 11, 96, z, 7], [x - side * 35, 83, z + 4, 6], [x - side * 48, 109, z + 4, 4]], 3);
    needle(x - side * 48, z + 4, 62, 124, 2.2, 5);
  }

  // Ten broad lifts and connected three-tier promenades. Every shaft is
  // subtracted from these exact decks, including its lower landing.
  const lift = (x: number, z: number, bottom: number, top: number): void => {
    plan.lifts.push({ id: city.id * 10000 + plan.lifts.length + 1, cityId: city.id,
      x: city.x + x, z: city.z + z, bottom: floor + bottom, top: floor + top, hx: 4.5, hz: 4.5, phase: plan.lifts.length * 4 });
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    lift(sx * 640, sz * 160, 0, 48);
    lift(sx * 360, sz * 160, 48, 120);
  }
  for (const side of [-1, 1]) lift(side * 240, -120, 120, 240);
  const deck = (x: number, z: number, top: number, hx: number, hz: number): void => {
    let pieces = [{ x, z, hx, hz }];
    for (const l of plan.lifts) {
      if (floor + top < l.bottom - .1 || floor + top > l.top + .1) continue;
      const lx = l.x - city.x, lz = l.z - city.z, r = 5.4;
      pieces = pieces.flatMap(p => {
        const ax = Math.max(p.x - p.hx, lx - r), bx = Math.min(p.x + p.hx, lx + r);
        const az = Math.max(p.z - p.hz, lz - r), bz = Math.min(p.z + p.hz, lz + r);
        if (ax >= bx || az >= bz) return [p];
        const out: typeof pieces = [];
        const add = (a: number, b: number, c: number, d: number): void => { if (b - a > .4 && d - c > .4) out.push({ x: (a + b) / 2, z: (c + d) / 2, hx: (b - a) / 2, hz: (d - c) / 2 }); };
        add(p.x - p.hx, ax, p.z - p.hz, p.z + p.hz); add(bx, p.x + p.hx, p.z - p.hz, p.z + p.hz);
        add(ax, bx, p.z - p.hz, az); add(ax, bx, bz, p.z + p.hz); return out;
      });
    }
    for (const p of pieces) box(p.x, top - 1.3, p.z, p.hx, 1.3, p.hz, 4);
  };
  for (const top of [48, 120]) for (const side of [-1, 1]) {
    deck(0, side * 160, top, 660, 11);
    deck(side * 640, 0, top, 11, 149);
    for (const x of [-510, -130, 130, 510]) {
      box(x, 0, side * 178, 4.5, top - 1.3, 4.5, 1);
      arch(x, side * 160, top - 28, 68, 25, 2.1, true, 2);
    }
  }
  for (const side of [-1, 1]) deck(side * 240, -136, 120, 11, 35);
  deck(0, -120, 240, 278, 17);
  for (const side of [-1, 1]) {
    box(side * 278, 120, -120, 4.5, 118.7, 9, 1);
    arch(side * 120, -120, 148, 215, 87, 3.2, true, 2);
  }
  const railing = (a: number, b: number, fixed: number, top: number, alongX: boolean): void => {
    let ranges = [[a, b]];
    // Side galleries enter real shops through open gangways. Keep the
    // original promenade and lift openings clear while opening these bays.
    const entries = !alongX ? [] : top === 240 && fixed === -104 ? [-125, 125]
      : Math.abs(fixed) === 170 && (top === 48 || top === 120) ? [-480, 480] : [];
    for (const center of entries) {
      ranges = ranges.flatMap(([lo, hi]) => hi <= center - 6 || lo >= center + 6 ? [[lo, hi]]
        : [[lo, Math.max(lo, center - 6)], [Math.min(hi, center + 6), hi]].filter(([x, y]) => y - x > .4));
    }
    for (const [lo, hi] of ranges) {
      for (const rise of [.45, 1.32]) box(alongX ? (lo + hi) / 2 : fixed, top + rise,
        alongX ? fixed : (lo + hi) / 2, alongX ? (hi - lo) / 2 : .42, .42, alongX ? .42 : (hi - lo) / 2, 3);
      for (let p = lo + 2; p < hi; p += 38) box(alongX ? p : fixed, top,
        alongX ? fixed : p, .65, 1.8, .65, 2);
    }
  };
  for (const top of [48, 120]) for (const side of [-1, 1]) {
    for (const edge of [-1, 1]) {
      const z = side * 160 + edge * 10;
      const ranges = top === 120 && z === -150 ? [[-622, -254], [-226, 226], [254, 622]] : [[-622, 622]];
      for (const [a, b] of ranges) railing(a, b, z, top, true);
      railing(-144, 144, side * 640 + edge * 10, top, false);
    }
  }
  for (const z of [-136, -104]) railing(-272, 272, z, 240, true);
  for (const [x, z, y, weapon] of [[0, -120, 240, 8], [610, 160, 48, 7], [-390, -160, 120, 8]]) {
    plan.rewards.push({ id: city.id * 10000 + 900 + plan.rewards.length, cityId: city.id,
      x: city.x + x, y: floor + y, z: city.z + z, weapon: weapon as 7 | 8 });
  }
  plan.vehicles.push({ id: city.id * 10000 + 800, cityId: city.id, x: city.x + 1080, y: floor,
    z: city.z, heading: Math.PI / 2, type: 2, variant: 2, hx: 36, hz: 36 });
  // Bounded cache: worlds are immutable, but test/server seed rotation should
  // not retain every previously generated city for the lifetime of a process.
  if (plans.size >= 12) plans.delete(plans.keys().next().value!);
  plans.set(key, plan);
  return plan;
}
