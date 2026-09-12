import { mulberry32 } from './rng.js';
import type { Box } from './worldgen.js';
import type { CityDistrict, CityLiftSite, CityRewardSite, CityVehicleSite } from './cities.js';
import type { CapitalPlan, CapitalSweep } from './capital-geometry.js';

export interface VesperDistrict {
  id: number; x: number; z: number; hx: number; hz: number; levels: readonly number[];
}
export interface VesperRoute { ax: number; az: number; bx: number; bz: number; y: number; width: number }
const CACHE = new Map<string, CapitalPlan>();
const INK = 0x222434, INDIGO = 0x30233f, STEEL = 0x334452, GLOW = 0x9257cb;

/** Irregular neighborhoods occupy islands of infrastructure above the void. */
export function vesperDistricts(city: CityDistrict): readonly VesperDistrict[] {
  const entries = [
    [0, 0, 120, 100, 0, 120, 240, 360],
    [-900, -180, 100, 80, 0, 120], [960, 220, 110, 90, 0, 120, 240],
    [-170, -980, 100, 95, 0, 120, 240, 360], [220, 950, 95, 100, 0, 120],
    [-950, -1080, 100, 140, 0], [1000, -1120, 90, 95, 0, 120],
    [-980, 1000, 100, 90, 0, 120], [1100, 1120, 110, 85, 0, 120],
  ];
  return entries.map(([x, z, hx, hz, ...levels], id) => ({ id, x: city.x + x, z: city.z + z, hx, hz, levels }));
}

/** The route list is also a testable description of the playable bridge net. */
export function vesperRoutes(city: CityDistrict): readonly VesperRoute[] {
  const d = vesperDistricts(city), floor = city.y + .06, routes: VesperRoute[] = [];
  const link = (ax: number, az: number, bx: number, bz: number, level: number, width = 18, alternate = false): void => {
    const bendX = alternate ? ax : bx, bendZ = alternate ? bz : az;
    if (Math.abs(ax - bendX) + Math.abs(az - bendZ) > 1) routes.push({ ax, az, bx: bendX, bz: bendZ, y: floor + level, width });
    if (Math.abs(bx - bendX) + Math.abs(bz - bendZ) > 1) routes.push({ ax: bendX, az: bendZ, bx, bz, y: floor + level, width });
  };
  for (const [a, b] of [[0, 1], [0, 2], [0, 3], [0, 4], [1, 5], [3, 5], [3, 6], [1, 7], [4, 7], [2, 8], [4, 8]]) {
    for (const level of d[a].levels.filter(level => d[b].levels.includes(level))) {
      link(d[a].x, d[a].z, d[b].x, d[b].z, level, level ? 14 : 22, (a + b) % 2 === 0);
    }
  }
  for (const [x, z, node] of [[-2000, 0, 1], [2000, 0, 2], [0, -2000, 3], [0, 2000, 4]]) {
    link(city.x + x, city.z + z, d[node].x, d[node].z, 0, 32, x === 0);
  }
  return routes;
}

/** Stable absolute-world geometry shared by collision, rendering and spawns. */
export function buildVesperPlan(city: CityDistrict): CapitalPlan {
  const key = `${city.seed}:${city.x}:${city.y}:${city.z}:${city.radius}`;
  const cached = CACHE.get(key); if (cached) return cached;
  const floor = city.y + .06, rng = mulberry32(city.seed ^ 0x76e513);
  const solids: Box[] = [], sweeps: CapitalSweep[] = [], lifts: CityLiftSite[] = [];
  const vehicles: CityVehicleSite[] = [], rewards: CityRewardSite[] = [];
  const districts = vesperDistricts(city);
  const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number, facade = 22): void => {
    solids.push(Object.assign({ x, y, z, hx, hy, hz, facade, floorY: floor }, { capital: true }));
  };
  const deck = (x: number, y: number, z: number, hx: number, hz: number): void => box(x, y - 2, z, hx, 2, hz, 20);
  const ring = (x: number, y: number, z: number): void => {
    deck(x, y, z - 7, 10, 3); deck(x, y, z + 7, 10, 3);
    deck(x - 7, y, z, 3, 4); deck(x + 7, y, z, 3, 4);
  };
  let liftId = 0;
  for (const d of districts) {
    for (const level of d.levels) {
      deck(d.x, floor + level, d.z, d.hx, d.hz);
      // Raised perimeter galleries provide alternate parkour paths without
      // sealing the public floor in walls or making the silhouette a box.
      for (const side of [-1, 1]) {
        box(d.x + side * (d.hx - 15), floor + level + 1.2, d.z + d.hz - 18, 9, 1.2, 9, 22);
      }
    }
    for (let i = 1; i < d.levels.length; i++) {
      const x = d.x + d.hx + 10, z = d.z - 32 + (i - 1) * 28;
      const bottom = floor + d.levels[i - 1], top = floor + d.levels[i];
      lifts.push({ id: city.id * 100 + ++liftId, cityId: city.id, x, z, bottom, top, hx: 3.6, hz: 3.6, phase: i * 3 });
      ring(x, bottom, z); ring(x, top, z);
    }
    // Broad ribbed porticoes distinguish inhabited suspended quarters from
    // bare bridge junctions. Their center remains a tall open passage.
    for (const side of [-1, 1]) {
      const top = floor + d.levels[d.levels.length - 1];
      const points = Array.from({ length: 17 }, (_, j) => {
        const t = j / 16;
        return { x: d.x + (t * 2 - 1) * d.hx * .74,
          y: top + Math.sin(t * Math.PI) * (d.id === 0 ? 64 : 44),
          z: d.z + side * d.hz * .72, radius: 3.8 + Math.sin(t * Math.PI) * 1.8 };
      });
      sweeps.push({ id: 4000 + d.id * 2 + (side + 1) / 2, kind: 'arch', points, color: STEEL, accent: GLOW });
    }
  }
  const routes = vesperRoutes(city);
  for (let i = 0; i < routes.length; i++) {
    const route = routes[i];
    // A half-width overlap makes turns and terrain handoffs fully supported.
    const hx = (Math.abs(route.bx - route.ax) + route.width) / 2,
      hz = (Math.abs(route.bz - route.az) + route.width) / 2;
    deck((route.ax + route.bx) / 2, route.y, (route.az + route.bz) / 2, hx, hz);
    const length = Math.hypot(route.bx - route.ax, route.bz - route.az);
    const middleX = (route.ax + route.bx) / 2, middleZ = (route.az + route.bz) / 2;
    const junction = routes.some((other, index) => {
      if (index === i || other.y !== route.y) return false;
      const dx = other.bx - other.ax, dz = other.bz - other.az;
      const t = Math.max(0, Math.min(1, ((middleX - other.ax) * dx + (middleZ - other.az) * dz) / (dx * dx + dz * dz)));
      return Math.hypot(middleX - other.ax - dx * t, middleZ - other.az - dz * t) < 48;
    });
    if (length > 300 && !junction) for (const side of [-1, 1]) {
      const alongX = Math.abs(route.bx - route.ax) > 1;
      box(middleX + (alongX ? 0 : side * (route.width / 2 - .6)), route.y + .7,
        middleZ + (alongX ? side * (route.width / 2 - .6) : 0), alongX ? 36 : .4, .7, alongX ? .4 : 36, 22);
    }
    // Slender under-bridge ribs frame the abyss while remaining below the
    // walk surface. Their broad curves replace unsupported floating slabs.
    if (Math.hypot(route.bx - route.ax, route.bz - route.az) > 300) {
      const points = Array.from({ length: 13 }, (_, j) => {
        const t = j / 12;
        return { x: route.ax + (route.bx - route.ax) * t,
          y: route.y - 7.5 - Math.sin(Math.PI * t) * Math.min(route.y > floor + 1 ? 80 : 120,
            Math.hypot(route.bx - route.ax, route.bz - route.az) * .14),
          z: route.az + (route.bz - route.az) * t, radius: 4.5 + Math.sin(Math.PI * t) * 2.5 };
      });
      sweeps.push({ id: 2000 + i, kind: 'rib', points, color: STEEL, accent: GLOW });
    }
  }
  // Northbound runway stays open for the rare interceptor's real takeoff.
  const dock = districts[5];
  deck(dock.x, floor, dock.z - 190, 30, 210);
  vehicles.push({ id: city.id * 100 + 80, cityId: city.id, x: dock.x, y: floor,
    z: dock.z - 100, heading: 0, type: 3, variant: 1, hx: 24, hz: 24 });
  for (const d of [districts[0], districts[1], districts[4]]) {
    const x = d.x - d.hx - 10, z = d.z + 45;
    const bottom = -65 + 5 * Math.sin(x * .008) * Math.cos(z * .009) + .06;
    lifts.push({ id: city.id * 100 + ++liftId, cityId: city.id, x, z, bottom, top: floor, hx: 3.6, hz: 3.6, phase: 0 });
    ring(x, bottom, z); ring(x, floor, z);
  }
  for (const [i, d] of [districts[0], districts[3], districts[6]].entries()) {
    rewards.push({ id: city.id * 100 + 90 + i, cityId: city.id,
      x: d.x - 45, y: floor + d.levels[d.levels.length - 1], z: d.z - 35, weapon: i % 2 ? 8 : 7 });
  }
  const clearVolumes = [...solids, ...lifts.map(lift => ({ x: lift.x, y: (lift.bottom + lift.top) / 2,
    z: lift.z, hx: 12, hy: (lift.top - lift.bottom) / 2 + 4, hz: 12 }))];
  const avoidsDecks = (points: CapitalSweep['points']): boolean => points.slice(1).every((b, i) => {
    const a = points[i];
    return clearVolumes.every(box => {
      const t = Math.abs(b.y - a.y) < .001 ? .5 : Math.max(0, Math.min(1, (box.y - a.y) / (b.y - a.y)));
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t, z = a.z + (b.z - a.z) * t;
      const radius = Math.max(a.radius, b.radius);
      if (Math.abs(y - box.y) > radius + box.hy + 5) return true;
      return Math.hypot(Math.max(0, Math.abs(x - box.x) - box.hx), Math.max(0, Math.abs(z - box.z) - box.hz)) > radius + 12;
    });
  });
  // Sixty-four varied hooked towers. Curvature is baked into shared swept
  // centerlines, so visible shape and collision cannot disagree about height.
  for (let i = 0; i < 64; i++) {
    const ringIndex = Math.floor(i / 16), nominalRadius = [440, 900, 1350, 1740][ringIndex];
    const angle = (i < 4 ? i * Math.PI / 2 + .18 : i % 16 * Math.PI / 8 + ringIndex * .29) + (rng() - .5) * .16;
    const height = i < 4 ? 1400 - i * 63 : 710 + rng() * (ringIndex === 3 ? 380 : 610);
    const family = i % 4;
    const width = i < 4 ? 105 + rng() * 25 : family === 0 ? 68 + rng() * 24 : family === 1 ? 72 + rng() * 28 : 32 + rng() * 31;
    const curl = (100 + rng() * 200) * (i % 2 ? -1 : 1);
    let points: CapitalSweep['points'] = [];
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = angle + attempt * .053, radius = nominalRadius + Math.floor(attempt / 8) * 30;
      const x = city.x + Math.cos(a) * radius, z = city.z + Math.sin(a) * radius;
      points = Array.from({ length: 17 }, (_, j) => {
        const t = j / 16, bend = Math.sin(t * Math.PI) * (i % 3 === 0 ? 110 : 42);
        const profiles = [[.48, .65, .90, 1.13, 1.40, 1.48, 1.20, .50, 0],
          [.42, .56, .84, 1.16, 1.30, 1.10, .76, .26, 0]];
        const profile = profiles[family % 2], u = Math.min(7.999, t * 8), k = Math.floor(u);
        const shape = family < 2 ? profile[k] + (profile[k + 1] - profile[k]) * (u - k)
          : Math.pow(1 - t, .76) * (1 + .18 * Math.sin(t * Math.PI * (i % 3 + 1)));
        return { x: x + Math.cos(a + Math.PI / 2) * curl * t * t + Math.cos(a) * bend,
          y: -78 + (height + 78) * t,
          z: z + Math.sin(a + Math.PI / 2) * curl * t * t + Math.sin(a) * bend,
          radius: t === 1 ? .8 : Math.max(.8, width * shape) };
      });
      if (avoidsDecks(points)) break;
    }
    if (!avoidsDecks(points)) continue;
    sweeps.push({ id: i + 1, kind: 'spire', points, color: i % 3 === 0 ? INDIGO : INK, accent: i % 2 ? GLOW : 0x49aaa4 });
    if (family < 2) {
      // Broad projecting inhabited collars and curved external cages turn
      // the heavier bodies into citadels, rather than enlarged grass blades.
      for (const level of [6, 9, 11]) {
        const p = points[level], radius = p.radius + 13;
        const collar = Array.from({ length: 25 }, (_, j) => {
          const a = j * Math.PI / 12;
          return { x: p.x + Math.cos(a) * radius, y: p.y + Math.sin(a * 3) * 3,
            z: p.z + Math.sin(a) * radius, radius: 4.2 };
        });
        if (avoidsDecks(collar)) sweeps.push({ id: 5000 + i * 4 + level, kind: 'rib', points: collar, color: STEEL, accent: GLOW });
      }
      for (let cage = 0; cage < 3; cage++) {
        const a = cage * Math.PI * 2 / 3 + angle;
        const ribs = points.slice(3, 15).map((p, j, list) => ({
          x: p.x + Math.cos(a + j * .08) * (p.radius + Math.sin(j / (list.length - 1) * Math.PI) * 24),
          y: p.y, z: p.z + Math.sin(a + j * .08) * (p.radius + Math.sin(j / (list.length - 1) * Math.PI) * 24),
          radius: 3.5 + Math.sin(j / (list.length - 1) * Math.PI) * 1.5,
        }));
        if (avoidsDecks(ribs)) sweeps.push({ id: 6000 + i * 3 + cage, kind: 'rib', points: ribs, color: STEEL, accent: 0x49aaa4 });
      }
    }
    // Curved lateral thorns give every third landmark an organic crown.
    if (i % 3 === 0) for (const side of [-1, 1]) {
      const root = points[11], tip = points[15], branch = Array.from({ length: 9 }, (_, j) => {
        const t = j / 8, spread = Math.sin(t * Math.PI * .7) * 95 * side;
        return { x: root.x + (tip.x - root.x) * t + Math.cos(angle) * spread,
          y: root.y + (tip.y - root.y) * t * .8,
          z: root.z + (tip.z - root.z) * t + Math.sin(angle) * spread,
          radius: Math.max(.65, 13 * (1 - t)) };
      });
      if (avoidsDecks(branch)) sweeps.push({ id: 3000 + i * 2 + (side + 1) / 2, kind: 'arch', points: branch, color: STEEL, accent: GLOW });
    }
  }
  const plan: CapitalPlan = { solids, sweeps, lifts, vehicles, rewards };
  CACHE.set(key, plan);
  if (CACHE.size > 8) CACHE.delete(CACHE.keys().next().value!);
  return plan;
}
