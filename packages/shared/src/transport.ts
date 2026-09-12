import type { Box } from './worldgen.js';
import type { CityDistrict, CityLiftSite } from './cities.js';
import type { JungleTempleSite } from './jungle-temples.js';
import { rainforestSites } from './rainforest.js';
import { clamp, lerp, smoothstep } from './math.js';
import type { TransportPrism } from './transport-geometry.js';
import { PLAYER } from './constants.js';

export interface TransportPoint { x: number; y: number; z: number }
export interface TransportStation extends TransportPoint { id: number; name: string; kind: 'city' | 'forest' | 'temple' | 'port'; railY: number; airlift: boolean }
export interface TransportHarbor extends TransportPoint { id: number; name: string; landX: number; landZ: number; heading: number }
export interface TransportStop extends TransportPoint { id: number; name: string }
export interface TransportLeg { points: TransportPoint[]; distances: number[]; length: number; from: TransportStop; to: TransportStop; reverse: boolean }
export interface TransportRoute {
  id: number; name: string; kind: 'ferry' | 'train'; speed: number; dwell: number; phase: number;
  stops: TransportStop[]; legs: TransportLeg[]; carOffsets: readonly number[]; artilleryCar?: number;
}
export interface TransportPose extends TransportPoint {
  yaw: number; vx: number; vy: number; vz: number; docked: boolean; departureIn: number; nextStop: number; arrivalIn: number;
}
export interface TransportPlan {
  stations: TransportStation[]; harbors: TransportHarbor[]; routes: TransportRoute[]; solids: Box[]; lifts: CityLiftSite[];
  pods: { id: number; stationId: number; name: string; x: number; y: number; z: number }[];
  bridges: TransportPrism[];
  accesses: StationAccess[];
}
export interface StationAccess { stationId: number; x: number; startZ: number; endZ: number; startY: number; endY: number; profile: { z: number; y: number }[] }
export interface TransportInputs { seed: number; cities: readonly CityDistrict[]; temples: readonly JungleTempleSite[]; sampleHeight: (x: number, z: number) => number }
export const RAIL_HEIGHT = 320;
export const TRAIN_CAR_OFFSETS = [0, 28, 56, 84] as const;
export const TRAIN_ARTILLERY_MOUNT = { car: 3, x: 0, y: 1.2, z: 0 } as const;
export const FERRY_DECK_HEIGHT = 2;
export function harborDockSide(harbor: TransportHarbor): number {
  return (harbor.landX - harbor.x) * Math.cos(harbor.heading) - (harbor.landZ - harbor.z) * Math.sin(harbor.heading) < 0 ? -1 : 1;
}
/** A dedicated berth at the quay's long edge avoids its land approach ramp. */
export function harborBoatSite(harbor: TransportHarbor): TransportPoint & { heading: number } {
  const side = harborDockSide(harbor);
  return { x: harbor.x + Math.cos(harbor.heading) * 29 * side - Math.sin(harbor.heading) * 41,
    y: harbor.y, z: harbor.z - Math.sin(harbor.heading) * 29 * side - Math.cos(harbor.heading) * 41,
    heading: harbor.heading + Math.PI / 2 };
}

/** Fixed intervals, shared clock and reversible consists avoid entity packets
 * and prevent a train flipping its cars through passengers at a terminus. */
export function transportRoutes(plan: TransportPlan): readonly TransportRoute[] { return plan.routes; }
/** Arrival clearings are queried after the pre-transport base column. The
 * plan samples that base only, keeping station grading recursion-free. */
export function transportGroundAt(plan: TransportPlan, x: number, z: number, baseHeight: number): { height: number; weight: number } | undefined {
  let result: { height: number; weight: number } | undefined;
  const blend = (height: number, weight: number): void => {
    if (weight <= 0) return;
    if (!result) { result = { height, weight }; return; }
    const inherited = result.weight * (1 - weight), combined = inherited + weight;
    result = { height: (result.height * inherited + height * weight) / combined, weight: combined };
  };
  for (const s of plan.stations) {
    const dx = Math.max(0, Math.abs(x - s.x - 80) - 42), dz = Math.max(0, Math.abs(z - s.z - 80) - 42);
    if (dx > 72 || dz > 72) continue;
    blend(s.y - .06, 1 - smoothstep(0, 72, Math.hypot(dx, dz)));
  }
  let height = result ? lerp(baseHeight, result.height, result.weight) : baseHeight;
  let changed = !!result;
  for (const a of plan.accesses ?? []) {
    const dx = Math.max(0, Math.abs(x - a.x) - 14), dz = Math.max(a.startZ - z, z - a.endZ, 0);
    if (dx >= 256 || dz >= 256) continue;
    const distance = Math.hypot(dx, dz); if (distance >= 256) continue;
    let i = 1; while (i < a.profile.length - 1 && a.profile[i].z < z) i++;
    const p = a.profile[i - 1], q = a.profile[i];
    const floor = lerp(p.y, q.y, clamp((z - p.z) / Math.max(.001, q.z - p.z), 0, 1)) - .35;
    // A fixed-width lerp makes steep banks when a long stair cuts a tall
    // hillside. This smooth envelope bounds its own grade at1.45 and lets
    // existing terrain/hall height take over as soon as it fits inside.
    // The path's longitudinal grade stays below .3; their vector sum remains
    // inside the conservative field-march limit, regardless of cut depth.
    const reach = 1.45 * (Math.sqrt(distance * distance + 100) - 10);
    const graded = clamp(height, floor - reach, floor + reach);
    if (graded !== height || distance === 0) changed = true;
    height = graded;
  }
  return changed ? { height, weight: 1 } : undefined;
}
function distance(a: TransportPoint, b: TransportPoint): number { return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z); }
function linePoint(a: TransportPoint, b: TransportPoint, t: number): TransportPoint { return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) }; }
function roundedPath(points: TransportPoint[], radius: number): TransportPoint[] {
  const result = [points[0]];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1], b = points[i], c = points[i + 1], r = Math.min(radius, distance(a, b) * .44, distance(b, c) * .44);
    const entry = linePoint(b, a, r / distance(a, b)), exit = linePoint(b, c, r / distance(b, c));
    result.push(entry);
    for (let step = 1; step <= 12; step++) { const t = step / 12; result.push(linePoint(linePoint(entry, b, t), linePoint(b, exit, t), t)); }
  }
  result.push(points[points.length - 1]); return result;
}
function leg(from: TransportStop, to: TransportStop, via: TransportPoint[], reverse = false, radius = 140): TransportLeg {
  const points = roundedPath([from, ...via, to], radius), distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + distance(points[i - 1], points[i]));
  return { points, distances, length: distances[distances.length - 1], from, to, reverse };
}
function travelTime(route: TransportRoute, part: TransportLeg): number { return part.length / route.speed + 3; }
function motion(route: TransportRoute, part: TransportLeg, time: number): { distance: number; speed: number } {
  const duration = travelTime(route, part), t = clamp(time, 0, duration), acceleration = route.speed / 3;
  if (t < 3) return { distance: .5 * acceleration * t * t, speed: acceleration * t };
  if (t > duration - 3) { const remaining = duration - t; return { distance: part.length - .5 * acceleration * remaining * remaining, speed: acceleration * remaining }; }
  return { distance: route.speed * (t - 1.5), speed: route.speed };
}
function onLeg(part: TransportLeg, along: number): TransportPoint & { dx: number; dy: number; dz: number } {
  let i = 1; while (i < part.distances.length - 1 && part.distances[i] < along) i++;
  const a = part.points[i - 1], b = part.points[i], length = part.distances[i] - part.distances[i - 1];
  const t = (along - part.distances[i - 1]) / Math.max(.001, length);
  const tangent = (start: number, end: number) => {
    const a = part.points[start], b = part.points[end], length = distance(a, b);
    return { x: (b.x - a.x) / length, y: (b.y - a.y) / length, z: (b.z - a.z) / length };
  };
  const current = tangent(i - 1, i), previous = i > 1 ? tangent(i - 2, i - 1) : current, next = i + 1 < part.points.length ? tangent(i, i + 1) : current;
  const f = clamp(t, 0, 1), dx = current.x + lerp(previous.x, next.x, f), dy = current.y + lerp(previous.y, next.y, f), dz = current.z + lerp(previous.z, next.z, f);
  const norm = Math.hypot(dx, dy, dz);
  return { ...linePoint(a, b, t), dx: dx / norm, dy: dy / norm, dz: dz / norm };
}
export function transportPose(route: TransportRoute, seconds: number, carOffset = 0): TransportPose {
  const duration = route.legs.reduce((n, p) => n + route.dwell + travelTime(route, p), 0);
  let time = ((seconds + route.phase) % duration + duration) % duration;
  for (const part of route.legs) {
    const travel = travelTime(route, part);
    if (time < route.dwell + travel) {
      const docked = time < route.dwell, m = motion(route, part, time - route.dwell);
      const p = onLeg(part, m.distance + (part.reverse ? carOffset : -carOffset));
      return { x: p.x, y: p.y, z: p.z, yaw: Math.atan2(-p.dx, -p.dz) + (part.reverse ? Math.PI : 0),
        vx: docked ? 0 : p.dx * m.speed, vy: docked ? 0 : p.dy * m.speed, vz: docked ? 0 : p.dz * m.speed,
        docked, departureIn: docked ? route.dwell - time : 0, nextStop: part.to.id,
        arrivalIn: docked ? route.dwell - time + travel : route.dwell + travel - time };
    }
    time -= route.dwell + travel;
  }
  throw new Error('invalid empty transport route');
}

const movingBoxes = new Map<string, readonly Box[]>();
/** Local boxes for one body. Trains call this once per car, with each car's
 * transportPose. Both hulls and every visible floor are genuine collision. */
export function transportBoxes(route: TransportRoute, car = 0): readonly Box[] {
  const key = `${route.kind}:${car}`; const cached = movingBoxes.get(key); if (cached) return cached;
  const boxes: Box[] = [];
  const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number, facade = 120) => boxes.push({ x, y, z, hx, hy, hz, facade, capital: true });
  if (route.kind === 'ferry') {
    box(0, .9, 0, 13, 1.1, 29); // Main vehicle deck at water +2m.
    for (const x of [-12.6, 12.6]) {
      for (const z of [-17.5, 17.5]) box(x, 4.7, z, .4, 2.7, 8.5);
      box(x, 9.7, 0, .4, 1.7, 20);
    }
    // Wide end portals and clear cargo lane; upper passenger deck stays open
    // beneath its saloon roof and has a second external promenade above it.
    box(-1.55, 7.7, 0, 10.85, .3, 20);
    box(10.85, 7.7, -3.9, 1.55, .3, 16.1);
    box(0, 11.7, -1, 10.3, .3, 14);
    box(-9.9, 9.7, -1, .4, 1.7, 14);
    box(9.9, 9.7, -3.5, .4, 1.7, 11.5);
    box(9.9, 11.1, 10.5, .4, .3, 2.5);
    box(0, 9.7, -14.7, 10.3, 1.7, .3);
    for (const side of [-1, 1]) box(side * 6.5, 9.7, 12.7, 3.8, 1.7, .3);
    // Exterior staircases are outside the vehicle lane, plus a roof stair.
    for (let i = 0; i < 24; i++) box(10.85, 2 + (i + 1) * .125, 28 - i * .66, 1.25, (i + 1) * .125, .35);
    for (let i = 0; i < 16; i++) box(-11.2, 8 + (i + 1) * .125, 19 - i * .65, 1.1, (i + 1) * .125, .35);
    box(-10.9, 11.7, 7.8, 1.4, .3, 1.0);
    for (const side of [-1, 1]) for (let z = -10; z <= 10; z += 4.5) box(side * 7.2, 8.32, z, .7, .3, .9);
    // Side ramp halves are level with shore quays; end aprons remain usable.
    for (const side of [-1, 1]) box(side * 14.2, 1.8, 0, 1.2, .2, 8.5);
  } else {
    box(0, .3, 0, 4.9, .9, 12.5); // 9.8m deck accepts even the supertank.
    if (car === 0) { box(0, 3, -6.5, 3.5, 1.8, 5); box(0, 5.2, -7, 3.8, .4, 5.5); }
    if (car === 1) {
      for (const side of [-1, 1]) {
        box(side * 4.5, 3.2, 0, .4, 2, 12.5);
        box(side * 3.4, 2, side > 0 ? 7 : 2, .75, .8, side > 0 ? 3 : 6);
      }
      box(-1.25, 5.2, 0, 3.65, .3, 12.5);
      box(3.65, 5.2, 6, 1.25, .3, 6.5);
      for (let i = 0; i < 16; i++) box(3.2, 1.2 + (i + 1) * .125, -11.5 + i * .65, 1.2, (i + 1) * .125, .35);
    }
    for (const side of [-1, 1]) for (const z of [-10, 10]) box(side * 4.65, 1.55, z, .25, .35, 2.5);
    for (const side of [-1, 1]) {
      box(0, 1, side * 13.65, 2.6, .2, 1.15);
      for (const x of [-2.85, 2.85]) box(x, 1.8, side * 13.2, .2, .6, .7);
    }
    if (car === 1) {
      // Protect the open stairwell and roof edges without closing its top exit.
      box(2.2, 6.05, -7.1, .2, .55, 5.4);
      box(-4.7, 6.05, 0, .2, .55, 12.5);
      box(4.7, 6.05, 6, .2, .55, 6.5);
      box(-1.25, 6.05, -12.3, 3.45, .55, .2);
      box(0, 6.05, 12.3, 4.5, .55, .2);
    }
    if (car !== 1) for (const side of [-1, 1]) box(side * 5.1, 1.02, 0, .3, .18, 5.5);
  }
  movingBoxes.set(key, boxes); return boxes;
}

export function buildTransportPlan(input: TransportInputs): TransportPlan {
  const plan: TransportPlan = { stations: [], harbors: [], routes: [], solids: [], lifts: [], pods: [], bridges: [], accesses: [] };
  // Layout construction is completed below; these public shapes are consumed
  // directly by static spatial indexing and moving-platform collision.
  populateHarbors(plan, input);
  populateStations(plan, input);
  populateRoutes(plan, input);
  populateStructures(plan, input);
  return plan;
}

function populateHarbors(plan: TransportPlan, _input: TransportInputs): void {
  plan.harbors.push(
    { id: 101, name: 'Southwatch Harbor', x: 0, y: 0, z: 9300, landX: 0, landZ: 8640, heading: -Math.PI / 2 },
    { id: 102, name: 'Westgate Harbor', x: -9300, y: 0, z: 0, landX: -8640, landZ: 0, heading: 0 },
    { id: 103, name: 'Northstar Harbor', x: 0, y: 0, z: -9300, landX: 0, landZ: -8640, heading: -Math.PI / 2 },
    { id: 104, name: 'Estuary Harbor', x: 9400, y: 0, z: 1100, landX: 8650, landZ: 820, heading: 0 },
    { id: 105, name: 'Halcyon Quay', x: 5200, y: 6, z: 1200, landX: 5300, landZ: 620, heading: -Math.PI / 2 },
  );
}
function populateStations(plan: TransportPlan, input: TransportInputs): void {
  for (const city of input.cities) plan.stations.push({ id: city.id + 1, name: city.name, kind: 'city',
    x: city.x + city.radius + 260, y: input.sampleHeight(city.x + city.radius + 340, city.z + 160) + .5,
    z: city.z + 80, railY: RAIL_HEIGHT, airlift: true });
  const forest = rainforestSites(input.seed)[0], temple = input.temples.find(t => t.kind === 'great-pyramid');
  const add = (id: number, name: string, kind: TransportStation['kind'], x: number, z: number) =>
    plan.stations.push({ id, name, kind, x, y: input.sampleHeight(x, z) + .5, z, railY: RAIL_HEIGHT, airlift: true });
  add(5, 'Emerald Forest', 'forest', forest.x - 350, forest.z + 340);
  if (temple) add(6, 'Sun Pyramid', 'temple', temple.x + 260, temple.z + 230);
  else add(6, 'Sun Pyramid', 'temple', forest.x + 340, forest.z + 190);
  add(7, 'Southwatch Harbor', 'port', 0, 8640);
  add(8, 'Halcyon Quay', 'port', 5300, 620);
}
function populateRoutes(plan: TransportPlan, input: TransportInputs): void {
  const p = (x: number, z: number, y = 0): TransportPoint => ({ x, y, z });
  const route = (id: number, name: string, kind: TransportRoute['kind'], a: TransportStop, b: TransportStop, via: TransportPoint[]) => {
    const outward = leg(a, b, via, false, kind === 'train' ? 220 : 140), backward: TransportLeg = { points: [...outward.points].reverse(),
      distances: outward.distances.map(d => outward.length - d).reverse(), length: outward.length, from: b, to: a, reverse: true };
    plan.routes.push({ id, name, kind, speed: kind === 'train' ? 62 : 38, dwell: kind === 'train' ? 22 : 28, phase: 0,
      stops: [a, b], legs: [outward, backward], carOffsets: kind === 'train' ? TRAIN_CAR_OFFSETS : [0], artilleryCar: kind === 'train' ? 3 : undefined });
  };
  const [south, west, north, east, lake] = plan.harbors;
  route(1, 'Southern Ocean Line', 'ferry', south, east, [p(180, 9300), p(600, 9800), p(6500, 9800), p(9800, 8900), p(9800, 1350), p(9400, 1280)]);
  route(2, 'Northern Ocean Line', 'ferry', east, north, [p(9400, 920), p(9800, 600), p(9800, -8800), p(8800, -9800), p(-300, -9800), p(-180, -9300)]);
  route(3, 'Western Ocean Line', 'ferry', north, west, [p(180, -9300), p(500, -9800), p(-8800, -9800), p(-9800, -8800), p(-9800, 300), p(-9300, 180)]);
  route(4, 'Halcyon River Ferry', 'ferry', lake, east,
    [p(5260, 1200, 5.94), p(5400, 1220, 5.8), p(6200, 1300, 5), p(7200, 1500, 3.5), p(8300, 1100, 1.5),
      // Approach from the open-water side of the quay. A straight crossing
      // of the river mouth drove through the harbor's land access bridge.
      p(8900, 1100, .6), p(9140, 1190, .2), p(9700, 1190, 0), p(9700, 1460, 0), p(9400, 1460, 0), p(9400, 1280, 0)]);
  const station = (id: number, track: number): TransportStop => { const s = plan.stations.find(s => s.id === id)!; return { id: s.id, name: s.name, x: s.x + track * 12, y: RAIL_HEIGHT, z: s.z }; };
  const pairs = [[3, 1], [1, 5], [5, 6], [6, 2], [2, 8], [8, 4], [4, 7]];
  for (const [index, [aId, bId]] of pairs.entries()) {
    const a = station(aId, 1), b = station(bId, -1), direction = Math.sign(b.z - a.z) || 1;
    const start = p(a.x, a.z + direction * 400, RAIL_HEIGHT), end = p(b.x, b.z - direction * 400, RAIL_HEIGHT);
    let detour: TransportPoint[];
    if (Math.abs(b.z - a.z) < 800) {
      // Nearby east/west destinations need a wide balloon loop, not a
      // 180-degree reversal immediately beyond the loading platform.
      const outsideX = b.x > a.x ? Math.max(a.x, b.x) + 650 : Math.min(a.x, b.x) - 650;
      detour = [p(outsideX, start.z, RAIL_HEIGHT), p(outsideX, end.z, RAIL_HEIGHT)];
    } else detour = railDetour(start, end, input.cities);
    route(11 + index, `${a.name} — ${b.name}`, 'train', a, b, [start, ...detour, end]);
  }
}

/** Visibility graph skirts capital/city footprints before rounding corners.
 * The margin remains after curve rounding, so elevated tracks never slice a
 * palace or a 1400m spire merely because ordinary terrain is below the rail. */
function railDetour(a: TransportPoint, b: TransportPoint, cities: readonly CityDistrict[]): TransportPoint[] {
  const rectangles = cities.map(c => ({ x: c.x, z: c.z, r: c.radius + 100 }));
  const clear = (a: TransportPoint, b: TransportPoint) => rectangles.every(r => {
    let low = 0, high = 1;
    for (const axis of ['x', 'z'] as const) {
      const d = b[axis] - a[axis], min = r[axis] - r.r, max = r[axis] + r.r;
      if (Math.abs(d) < 1e-9) { if (a[axis] < min || a[axis] > max) return true; }
      else { const t0 = (min - a[axis]) / d, t1 = (max - a[axis]) / d; low = Math.max(low, Math.min(t0, t1)); high = Math.min(high, Math.max(t0, t1)); }
    }
    return low > high;
  });
  if (clear(a, b)) return [];
  const nodes = [a, b];
  for (const r of rectangles) for (const sx of [-1, 1]) for (const sz of [-1, 1]) nodes.push({ x: r.x + sx * (r.r + 200), y: RAIL_HEIGHT, z: r.z + sz * (r.r + 200) });
  const cost = nodes.map(() => Infinity), previous = nodes.map(() => -1), visited = new Set<number>(); cost[0] = 0;
  for (let count = 0; count < nodes.length; count++) {
    let current = -1;
    for (let i = 0; i < nodes.length; i++) if (!visited.has(i) && (current < 0 || cost[i] < cost[current])) current = i;
    if (current < 0 || !Number.isFinite(cost[current])) break;
    if (current === 1) break; visited.add(current);
    for (let i = 0; i < nodes.length; i++) if (!visited.has(i) && clear(nodes[current], nodes[i])) {
      const next = cost[current] + distance(nodes[current], nodes[i]);
      if (next < cost[i]) { cost[i] = next; previous[i] = current; }
    }
  }
  if (!Number.isFinite(cost[1])) throw new Error('rail route cannot avoid a city');
  const result: TransportPoint[] = []; let current = previous[1];
  while (current > 0) { result.unshift(nodes[current]); current = previous[current]; }
  return result;
}

function populateStructures(plan: TransportPlan, input: TransportInputs): void {
  const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number, facade = 120) => plan.solids.push({ x, y, z, hx, hy, hz, facade, capital: true });
  const pierGroups: Box[][] = [];
  // Continuous mitered ribbons use the same corners for rendering and field
  // collision. They replace the oversized world-axis grid under diagonal rails.
  for (const route of plan.routes.filter(r => r.kind === 'train')) {
    const path = route.legs[0];
    const points: TransportPoint[] = [path.points[0]];
    for (let i = 1; i < path.points.length; i++) {
      const a = path.points[i - 1], b = path.points[i], count = Math.ceil(distance(a, b) / 64);
      for (let n = 1; n <= count; n++) points.push(linePoint(a, b, n / count));
    }
    const normals = points.map((p, i) => {
      const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i + 1)];
      const ax = p.x - a.x, az = p.z - a.z, bx = b.x - p.x, bz = b.z - p.z;
      const al = Math.hypot(ax, az), bl = Math.hypot(bx, bz);
      const nx = (al ? az / al : bz / bl) + (bl ? bz / bl : az / al), nz = -(al ? ax / al : bx / bl) - (bl ? bx / bl : ax / al);
      const length = Math.hypot(nx, nz), dot = Math.max(.7, (nx / length) * (bl ? bz / bl : az / al) - (nz / length) * (bl ? bx / bl : ax / al));
      return { x: nx / length / dot, z: nz / length / dot };
    });
    const edge = (i: number, offset: number) => ({ x: points[i].x + normals[i].x * offset, z: points[i].z + normals[i].z * offset });
    for (let i = 1; i < points.length; i++) {
      plan.bridges.push({ corners: [edge(i - 1, -8), edge(i, -8), edge(i, 8), edge(i - 1, 8)], bottom: RAIL_HEIGHT - 2.8, top: RAIL_HEIGHT - 1.2, rail: false });
      const middle = linePoint(points[i - 1], points[i], .5);
      if (!plan.stations.some(s => Math.abs(s.x - middle.x) < 124 && Math.abs(s.z - middle.z) < 164)) {
        for (const side of [-1, 1]) plan.bridges.push({ corners: [edge(i - 1, side * 7.6), edge(i, side * 7.6), edge(i, side * 8), edge(i - 1, side * 8)],
          bottom: RAIL_HEIGHT - 1.2, top: RAIL_HEIGHT + .15, rail: true });
      }
    }
    for (let d = 100; d < path.length; d += 200) {
      const p = onLeg(path, d);
      if (plan.stations.some(s => Math.abs(s.x - p.x) < 124 && Math.abs(s.z - p.z) < 164)) continue;
      const bottom = input.sampleHeight(p.x, p.z) - 2;
      const capTop = RAIL_HEIGHT - 2.8, shaftTop = capTop - 20;
      const firstPiece = plan.solids.length;
      // Broad footings and flared corbels give the very tall piers credible
      // proportions. Every visible support remains a canonical solid.
      box(p.x, (bottom + shaftTop) / 2, p.z, 4.8, (shaftTop - bottom) / 2, 4.8, 122);
      box(p.x, bottom + 4, p.z, 8, 4, 8, 122);
      box(p.x, shaftTop + 4, p.z, 6, 4, 6, 122);
      box(p.x, shaftTop + 11, p.z, 7.5, 3, 7.5, 122);
      box(p.x, capTop - 3, p.z, 9, 3, 9, 122);
      box(p.x, lerp(bottom, shaftTop, .55), p.z, 5.5, 1.2, 5.5, 121);
      pierGroups.push(plan.solids.slice(firstPiece));
    }
  }
  for (const s of plan.stations) {
    const top = RAIL_HEIGHT + 1.2, lx = s.x + 72, lz = s.z + 68;
    const holes = [{ x0: lx - 8.2, x1: lx + 8.2, z0: lz - 12.2, z1: lz + 12.2 }];
    // The pod launches vertically through its own guarded well, clear of
    // the passenger platform overhead and the neighboring vehicle lift.
    holes.push({x0:s.x+98,x1:s.x+110,z0:s.z+76,z1:s.z+88});
    for(const dx of [97.6,110.4]) box(s.x+dx,top+.7,s.z+82,.2,.7,6.6,122);
    for(const dz of [75.6,88.4]) box(s.x+104,top+.7,s.z+dz,6.6,.7,.2,122);
    for (const side of [-1, 1]) for (const z of [-100, 100]) holes.push({ x0: s.x + (side < 0 ? -27.5 : 17.5), x1: s.x + (side < 0 ? -17.5 : 27.5), z0: s.z + z - 3.5, z1: s.z + z + 3.5 });
    const slab = (x0: number, x1: number, z0: number, z1: number): void => {
      let pieces = [{ x0, x1, z0, z1 }];
      for (const hole of holes) pieces = pieces.flatMap(p => {
        const a = Math.max(p.x0, hole.x0), b = Math.min(p.x1, hole.x1), c = Math.max(p.z0, hole.z0), d = Math.min(p.z1, hole.z1);
        if (a >= b || c >= d) return [p];
        return [{ x0: p.x0, x1: a, z0: p.z0, z1: p.z1 }, { x0: b, x1: p.x1, z0: p.z0, z1: p.z1 },
          { x0: a, x1: b, z0: p.z0, z1: c }, { x0: a, x1: b, z0: d, z1: p.z1 }].filter(q => q.x1 - q.x0 > .01 && q.z1 - q.z0 > .01);
      });
      for (const p of pieces) box((p.x0 + p.x1) / 2, top - .8, (p.z0 + p.z1) / 2, (p.x1 - p.x0) / 2, .8, (p.z1 - p.z0) / 2, 123);
    };
    // Two loading platforms leave the 11m central track channel open.
    for (const side of [-1, 1]) {
      const minX = side < 0 ? s.x - 112 : s.x + 17.5, maxX = side < 0 ? s.x - 17.5 : s.x + 112;
      slab(minX, maxX, s.z - 130, s.z + 130);
    }
    box(s.x, top - .8, s.z, 6.5, .8, 130, 123);
    for (const track of [-12, 12]) box(s.x + track, RAIL_HEIGHT - 2, s.z, 5.5, .8, 130, 121);
    for (const side of [-1, 1]) for (const z of [-100, 100]) {
      for (let i = 0; i < 10; i++) box(s.x + side * (17.5 + (i + .5)), RAIL_HEIGHT - 1.2 + (i + 1) * .12, s.z + z,
        .5, (i + 1) * .12, 3.5, 125);
    }
    for (const dx of [-92, 92]) for (const dz of [-108, 108]) {
      const bottom = input.sampleHeight(s.x + dx, s.z + dz) - 2;
      box(s.x + dx, (bottom + top - 1.6) / 2, s.z + dz, 4, (top - 1.6 - bottom) / 2, 4, 122);
    }
    // Sheltered waiting rooms, benches and planted courts leave wide routes
    // between the vehicle lift, flatcar boarding zones and emergency stairs.
    for (const side of [-1, 1]) for (const dz of [-62, 44]) {
      const cx = s.x + side * 65, cz = s.z + dz;
      for (const dx of [-14, 14]) for (const z of [-8, 8]) box(cx + dx, top + 2.9, cz + z, .4, 2.9, .4, 122);
      box(cx, top + 5.95, cz, 15, .25, 9, 124);
      for (const dx of [-8, 8]) {
        box(cx + dx, top + .45, cz - 3, 3.3, .45, .9, 126);
        box(cx + dx, top + 1.15, cz - 3.8, 3.3, .7, .22, 124);
      }
      box(cx + side * 19, top + .6, cz, 2.6, .6, 3.2, 122);
    }
    // Open-front kiosk; root's replenishing health/ammo live just south of it.
    box(s.x + 52.5, top + 2.3, s.z - 44, 8.5, 2.3, .4, 124);
    for (const x of [44, 61]) box(s.x + x, top + 2.3, s.z - 41, .4, 2.3, 3.4, 124);
    box(s.x + 52.5, top + 4.85, s.z - 41, 9, .25, 4, 126);
    // Edge protection is open at the lift, stair bays and rail corridors.
    for (const side of [-1, 1]) box(s.x + side * 111.5, top + .65, s.z, .35, .65, 129, 122);
    for (const side of [-1, 1]) for (const z of [-129.5, 129.5]) box(s.x + side * 65, top + .65, s.z + z, 46, .65, .35, 122);
    // Ground hall, vehicle lift, and a separate visibly marked airlift pod.
    box(s.x + 80, s.y - .7, s.z + 80, 40, .7, 40, 123);
    for (const dx of [48, 112]) box(s.x + dx, s.y + 5, s.z + 105, 1.5, 5, 1.5, 122);
    box(s.x + 80, s.y + 10.3, s.z + 105, 34, .5, 10, 124);
    plan.lifts.push({ id: 7000 + s.id, cityId: -1, x: lx, z: lz, bottom: s.y, top, hx: 8, hz: 12, phase: 0, dwell: 8 });
    plan.pods.push({ id: s.id, stationId: s.id, name: s.name, x: s.x + 104, y: s.y, z: s.z + 82 });
    // Ground-contact volumes for the open orbital gantry and control stand.
    // The vertical launch axis and the route out through its arch stay clear.
    for (const side of [-1, 1]) box(s.x + 104 + side * 6.2, s.y + .9, s.z + 73, .65, .9, 1, 121);
    box(s.x + 112, s.y + .8, s.z + 84, .5, .8, .5, 124);
    box(s.x + 104, s.y + 8.3, s.z + 72.55, 5.05, .4, .6, 121);
    for (const side of [-1, 1]) for (let i = 0; i < 5; i++) {
      const height = 2.4 + i * 1.14, t = (height - 1.8) / 6.3;
      box(s.x + 104 + side * (6.2 - 1.4 * t), s.y + height, s.z + 73 - .4 * t, .35, .57, .5, 123);
    }
    // Number of steps follows elevation, with a broad rest landing every16
    // risers. A matching graded corridor prevents floating steps/buried ramps.
    const landward = s.kind === 'port';
    let length = 160, endY = s.y, steps = 1, landings = 0;
    for (let tries = 0; tries < 12; tries++) {
      endY = input.sampleHeight(s.x + 80, landward ? s.z + 40 - length : s.z + 120 + length) + .08;
      steps = Math.max(1, Math.ceil(Math.abs(endY - s.y) / .24)); landings = Math.floor((steps - 1) / 16);
      const needed = steps * .8 + landings * 2.4;
      if (length >= needed) break;
      length = Math.max(length * 1.2, needed + 16);
    }
    const access: StationAccess = { stationId: s.id, x: s.x + 80, startZ: landward ? s.z + 40 - length : s.z + 120,
      endZ: landward ? s.z + 40 : s.z + 120 + length, startY: landward ? endY : s.y, endY: landward ? s.y : endY, profile: [] };
    access.profile.push({ z: access.startZ, y: access.startY });
    const tread = (length - landings * 2.4) / steps;
    let az = access.startZ;
    for (let i = 0; i < steps; i++) {
      const a = lerp(access.startY, access.endY, i / steps), b = lerp(access.startY, access.endY, (i + 1) / steps), height = Math.max(a, b) + .04;
      box(access.x, height - .4, az + tread / 2, 12, .4, tread / 2, 123);
      az += tread; access.profile.push({ z: az, y: b });
      if (i < steps - 1 && (i + 1) % 16 === 0) { box(access.x, b - .36, az + 1.2, 12, .4, 1.2, 125); az += 2.4; access.profile.push({ z: az, y: b }); }
    }
    plan.accesses.push(access);
  }
  // Access lengths depend on their sampled endpoint heights, so reserve their
  // full walking width after all paths are known. Test every pier piece: its
  // footing and flared cap are wider than the shaft. Remove the whole support
  // together so no orphan corbel floats above a stair lane.
  const blockedPiers = new Set<Box>();
  for (const group of pierGroups) if (plan.accesses.some(a => group.some(b =>
    Math.abs(b.x - a.x) < b.hx + 12 + PLAYER.RADIUS &&
    b.z + b.hz > a.startZ - PLAYER.RADIUS && b.z - b.hz < a.endZ + PLAYER.RADIUS))) {
    for (const b of group) blockedPiers.add(b);
  }
  if (blockedPiers.size) plan.solids = plan.solids.filter(b => !blockedPiers.has(b));
  for (const h of plan.harbors) {
    const c = Math.cos(h.heading), sn = Math.sin(h.heading), side = harborDockSide(h), dock = { x: h.x + c * 29 * side, y: h.y + FERRY_DECK_HEIGHT, z: h.z - sn * 29 * side };
    // Side-loading quays match the ferry's open cargo portals, with no gate
    // placed across the driving lane when the vessel is at its berth.
    box(dock.x, dock.y - 1, dock.z, Math.abs(c) * 15 + Math.abs(sn) * 34, 1, Math.abs(sn) * 15 + Math.abs(c) * 34, 123);
    const start = { x: h.landX, y: input.sampleHeight(h.landX, h.landZ) + .1, z: h.landZ }, length = distance(start, dock);
    const count = Math.ceil(length / 2);
    for (let i = 0; i < count; i++) {
      const a = linePoint(start, dock, i / count), b = linePoint(start, dock, (i + 1) / count), m = linePoint(a, b, .5);
      box(m.x, m.y - .45, m.z, Math.abs(b.x - a.x) / 2 + 9, .45, Math.abs(b.z - a.z) / 2 + 9, 125);
      if (i % 40 === 0) box(m.x, (m.y - 60) / 2, m.z, 2.5, (m.y + 60) / 2 - .5, 2.5, 122);
    }
  }
}
