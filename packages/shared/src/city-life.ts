import type { Box } from './worldgen.js';
import type { CityDistrict } from './cities.js';
import { vesperDistricts } from './vesper-city.js';
import { hash2i, unit } from './rng.js';

export type CityVenueKind = 'market' | 'clinic' | 'workshop' | 'canteen' | 'archive' | 'residence' | 'aerodrome';
export interface CityVenue { id: number; cityId: number; kind: CityVenueKind; name: string; x: number; y: number; z: number; hx: number; hz: number; yaw: number; raised: boolean }
export interface CityLifeBox extends Box { venueId: number; surface: 'wall' | 'roof' | 'wood' | 'metal' }
export interface CityLifeReward { id: number; cityId: number; x: number; y: number; z: number; kind: 'health' | 'ammo' | 'weapon'; weapon?: number }
export interface CityLifeMarker { id: number; x: number; y: number; z: number; label: string; targetX: number; targetZ: number; color: number }
export interface CivilianWaypoint { x: number; y: number; z: number; dwell: number }
export interface CityCivilian { id: number; cityId: number; venueId: number; style: number; color: number; speed: number; phase: number; activity: 'browse' | 'talk' | 'repair'; route: CivilianWaypoint[] }
export interface CityCivilianPose { x: number; y: number; z: number; yaw: number; moving: boolean; stride: number; activity: CityCivilian['activity'] }
export interface CityLifePlan { solids: CityLifeBox[]; venues: CityVenue[]; civilians: CityCivilian[]; rewards: CityLifeReward[]; markers: CityLifeMarker[] }
const PLANS = new Map<string, CityLifePlan>();
const TIMETABLES = new WeakMap<CityCivilian, { legs: number[]; distance: number; duration: number }>();
const KINDS: readonly CityVenueKind[] = ['market', 'clinic', 'workshop', 'canteen', 'archive', 'residence'];
const NAMES = { market: 'Exchange', clinic: 'Aid Station', workshop: 'Workshop', canteen: 'Canteen', archive: 'Archive', residence: 'Lodgings', aerodrome: 'NOCTURNE AERODROME' };

export function cityLifePlan(city: CityDistrict): CityLifePlan {
  const key = `${city.id}:${city.seed}:${city.x}:${city.y}:${city.z}`;
  const cached = PLANS.get(key); if (cached) return cached;
  const plan: CityLifePlan = { solids: [], venues: [], civilians: [], rewards: [], markers: [] };
  const floor = city.y + .06;
  const venue = (dx: number, dz: number, level: number, kind: CityVenueKind, yaw = 0, raised = false, hx = 8, hz = 7): void => {
    const id = city.id * 1000 + plan.venues.length + 1;
    plan.venues.push({ id, cityId: city.id, kind, name: NAMES[kind], x: city.x + dx, y: floor + level,
      z: city.z + dz, hx, hz, yaw, raised });
  };
  if (city.theme === 'vesper') {
    for (const d of vesperDistricts(city)) {
      for (const side of [-1, 1]) venue(d.x - city.x + side * 42, d.z - city.z + 36, 0,
        KINDS[(d.id * 2 + (side + 1) / 2) % KINDS.length]);
      if (d.levels.length > 1) venue(d.x - city.x + 35, d.z - city.z + 20,
        d.levels[d.levels.length - 1], KINDS[(d.id + 4) % KINDS.length]);
    }
    venue(-1020, -1090, 0, 'aerodrome', 0, false, 10, 8);
    const points = [[0, 24, -900, 0], [-870, 0, -900, -180], [-875, -180, -900, -1080], [-900, -1045, -950, -1180]];
    for (const [i, [x, z, tx, tz]] of points.entries()) plan.markers.push({ id: 2700 + i,
      x: city.x + x, y: floor, z: city.z + z, label: 'NOCTURNE AERODROME',
      targetX: city.x + tx, targetZ: city.z + tz, color: 0x65e4de });
    plan.markers.push({ id: 2710, x: city.x - 1020, y: floor, z: city.z - 1110,
      label: 'NOCTURNE • BOARD AT RUNWAY', targetX: city.x - 950, targetZ: city.z - 1180, color: 0x65e4de });
  } else if (city.theme === 'aurelia') {
    for (const [i, [x, z]] of [[-88, 70], [88, 70], [-88, -60], [88, -60], [-500, 35], [500, 35], [-1050, 30], [1050, 30]].entries()) venue(x, z, 0, KINDS[i % KINDS.length]);
    for (const level of [48, 120]) for (const side of [-1, 1]) for (const x of [-480, 480])
      venue(x, side * 193, level, KINDS[(plan.venues.length + 1) % KINDS.length], side > 0 ? Math.PI : 0, true, 9, 7);
    for (const x of [-125, 125]) venue(x, -81, 240, x < 0 ? 'archive' : 'clinic', Math.PI, true, 9, 7);
  } else {
    for (const [i, [x, z]] of [[-24, -24], [24, 24], [-24, 24], [24, -24]].entries()) venue(x, z, 0, KINDS[i]);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) venue(sx * 96 - 9, sz * 96 - 7, 24,
      KINDS[plan.venues.length % KINDS.length], 0, false, 7, 6);
  }
  const point = (v: CityVenue, x: number, z: number) => ({ x: v.x + x * Math.cos(v.yaw) + z * Math.sin(v.yaw),
    y: v.y, z: v.z - x * Math.sin(v.yaw) + z * Math.cos(v.yaw) });
  for (const v of plan.venues) {
    const add = (x: number, y: number, z: number, hx: number, hy: number, hz: number, surface: CityLifeBox['surface']): void => {
      const p = point(v, x, z);
      plan.solids.push({ x: p.x, y: v.y + y, z: p.z, hx, hy: Math.max(.19, hy), hz,
        capital: true, facade: 80, floorY: v.y, venueId: v.id, surface });
    };
    if (v.raised) {
      add(0, -.65, 0, v.hx + 6, .65, v.hz + 6, 'metal');
      add(0, -.65, v.hz + 10, 4, .65, 7, 'metal');
    }
    const open = v.kind === 'market' || v.kind === 'aerodrome';
    if (open) {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) add(sx * (v.hx - .4), 2.4, sz * (v.hz - .4), .4, 2.4, .4, 'metal');
      add(0, 1.6, -v.hz, v.hx, 1.6, .4, 'wall');
    } else {
      add(0, 2.2, -v.hz, v.hx, 2.2, .4, 'wall');
      for (const side of [-1, 1]) {
        add(side * v.hx, 2.2, 0, .4, 2.2, v.hz, 'wall');
        add(side * (v.hx + 1.8) / 2, 2.2, v.hz, (v.hx - 1.8) / 2, 2.2, .4, 'wall');
      }
      add(0, 3.85, v.hz, 1.8, .55, .4, 'wall');
    }
    add(0, 4.8, 0, v.hx + .6, .24, v.hz + .6, 'roof');
    // Functional furniture sits at the sides of a clear front-to-back aisle.
    add(-v.hx + 1.2, .65, -2, .8, .65, Math.max(2, v.hz - 2.4), 'wood');
    add(v.hx - 1.3, .9, -v.hz + 1.5, .9, .9, .9, 'metal');
    // Real exterior stairs and a generous top landing make each roof usable.
    for (let i = 0; i < 18; i++) add(-v.hx - 1.8, (i + 1) * .14, v.hz + 1 - i * .58, 1.4, (i + 1) * .14, .34, 'metal');
    // Place the landing after the last riser: extending it back over the
    // approach would turn its underside into a low ceiling halfway up.
    add(-v.hx - 1.4, 4.8, v.hz - 11.5, 1.8, .24, 2.5, 'metal');
    const reward = point(v, 0, -v.hz + 2.8);
    plan.rewards.push({ id: city.id * 1000 + 500 + plan.rewards.length, cityId: city.id, ...reward,
      kind: v.kind === 'clinic' || v.kind === 'canteen' ? 'health' : v.kind === 'workshop' || v.kind === 'aerodrome' ? 'ammo' : 'weapon',
      weapon: v.kind === 'archive' ? 8 : v.kind === 'residence' ? 2 : v.kind === 'workshop' || v.kind === 'market' || v.kind === 'aerodrome' ? 3 : 1 });
    for (let i = 0; i < 6; i++) {
      const salt = hash2i(city.seed, v.id, i), inside = i < 2;
      const points = inside ? [[-2.5, 0], [2.5, 0], [0, -v.hz + 3]]
        : [[-3 + (i - 2) * 2, v.hz + 3], [-3 + (i - 2) * 2, v.hz + 7], [3 - (i - 2) * 2, v.hz + 7]];
      plan.civilians.push({ id: v.id * 8 + i, cityId: city.id, venueId: v.id,
        style: (i + plan.venues.indexOf(v)) % 3, color: salt % 8, speed: 1.05 + unit(salt) * .45,
        phase: unit(hash2i(salt, 3, 7)) * 40, activity: ['browse', 'talk', 'repair'][i % 3] as CityCivilian['activity'],
        route: points.map(([x, z], j) => ({ ...point(v, x, z), dwell: 2 + unit(hash2i(salt, j, 8)) * 5 })) });
    }
  }
  PLANS.set(key, plan); if (PLANS.size > 8) PLANS.delete(PLANS.keys().next().value!);
  return plan;
}

export function cityLifeRewards(city: CityDistrict): readonly CityLifeReward[] { return cityLifePlan(city).rewards; }
export function cityCivilianPose(civilian: CityCivilian, seconds: number): CityCivilianPose {
  const route = civilian.route;
  let schedule = TIMETABLES.get(civilian);
  if (!schedule) {
    const legs = route.map((a, i) => { const b = route[(i + 1) % route.length]; return Math.hypot(b.x - a.x, b.z - a.z); });
    const distance = legs.reduce((a, b) => a + b, 0);
    schedule = { legs, distance, duration: distance / civilian.speed + route.reduce((n, p) => n + p.dwell, 0) }; TIMETABLES.set(civilian, schedule);
  }
  const { legs, distance, duration } = schedule;
  const elapsed = Math.max(0, seconds + civilian.phase), cycles = Math.floor(elapsed / duration);
  let t = elapsed % duration, walked = cycles * distance;
  for (let i = 0; i < route.length; i++) {
    const a = route[i], b = route[(i + 1) % route.length], yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    if (t < a.dwell) return { x: a.x, y: a.y, z: a.z, yaw, moving: false, stride: walked, activity: civilian.activity };
    t -= a.dwell;
    if (t < legs[i] / civilian.speed) {
      const f = t * civilian.speed / legs[i];
      return { x: a.x + (b.x - a.x) * f, y: a.y, z: a.z + (b.z - a.z) * f,
        yaw, moving: true, stride: walked + t * civilian.speed, activity: civilian.activity };
    }
    t -= legs[i] / civilian.speed; walked += legs[i];
  }
  return { ...route[0], yaw: 0, moving: false, stride: walked, activity: civilian.activity };
}
