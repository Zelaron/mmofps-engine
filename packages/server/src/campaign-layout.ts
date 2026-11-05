import { capsuleClearance } from '@shared/physics';
import { type CampaignBase, type Faction, type Territory } from '@shared/frontier';
import { FERRY_DECK_HEIGHT, harborDockSide } from '@shared/transport';
import { vesperDistricts } from '@shared/vesper-city';
import type { World } from '@shared/worldgen';

type Point = { x: number; y: number; z: number };
export const CAMPAIGN_CAPTURE_GAP = 40;

/** Keep control circles distinct even when a terrain fallback shifts two
 * requested positions toward the same patch of usable ground. */
function separatedPoint(world: World, desired: Point, radius: number,
  occupied: readonly (Point & { radius: number })[], sample: (x: number, z: number) => Point | null): Point {
  const clear = (point: Point): boolean => occupied.every(other =>
    Math.hypot(point.x - other.x, point.z - other.z) >= radius + other.radius + CAMPAIGN_CAPTURE_GAP);
  if (clear(desired)) return desired;
  for (const offset of [96, 160, 256, 384]) for (let step = 0; step < 16; step++) {
    const point = sample(desired.x + Math.cos(step * Math.PI / 8) * offset,
      desired.z + Math.sin(step * Math.PI / 8) * offset);
    if (point && clear(point)) return point;
  }
  throw new Error(`No separated campaign position at ${world.seed}:${desired.x},${desired.z}`);
}

/** City streets can have many occupied floors above them. Sample the known
 * pedestrian deck directly rather than tracing down from the skyline. */
function findStreetPoint(world: World, x: number, y: number, z: number): Point | null {
  for (const radius of [0, 16, 32, 48, 64, 96, 128]) for (let k = 0; k < (radius ? 16 : 1); k++) {
    const px = x + Math.cos(k * Math.PI / 8) * radius, pz = z + Math.sin(k * Math.PI / 8) * radius;
    if (world.liquidAt(px, y, pz) || capsuleClearance(world, px, y + .02, pz) < -.02 || world.sdf(px, y - .12, pz) > 0) continue;
    return { x: px, y, z: pz };
  }
  return null;
}
export function campaignStreetPoint(world: World, x: number, y: number, z: number): Point {
  const point = findStreetPoint(world, x, y, z);
  if (!point) throw new Error(`No accessible campaign street at ${world.seed}:${x},${z}`);
  return point;
}

/** Campaign placement consumes this planet's generated ground and routes.
 * It does not assume a particular coast, sea level, or city arrangement. */
function findGroundPoint(world: World, x: number, z: number, allowDeck = false): Point | null {
  for (const radius of [0, 12, 24, 48, 80, 128, 192, 256, 384, 512]) for (let k = 0; k < (radius ? 16 : 1); k++) {
    const px = x + Math.cos(k * Math.PI / 8) * radius, pz = z + Math.sin(k * Math.PI / 8) * radius;
    const y = world.groundY(px, pz) + .08;
    if (world.liquidAt(px, y, pz) || (!allowDeck && Math.abs(y - world.column(px, pz).h) > 2)) continue;
    if (capsuleClearance(world, px, y, pz) < -.02 || world.sdf(px, y - .2, pz) > 0) continue;
    return { x: px, y, z: pz };
  }
  return null;
}
export function campaignPoint(world: World, x: number, z: number, allowDeck = false): Point {
  const point = findGroundPoint(world, x, z, allowDeck);
  if (point) return point;
  // The generic spawn helper accepts submerged terrain and may jump to the
  // world origin. A campaign objective must retain a nearby dry support.
  throw new Error(`No dry campaign ground at ${world.seed}:${x},${z}`);
}

type Planar = { x: number; z: number };
const planar = (a: Planar, b: Planar): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Three home regions, one per faction in the first war. Each is a city, the
 * harbor behind it and a forward base facing the shared middle of the map, so
 * factions start apart and meet on front lines instead of all converging on a
 * single neutral city. The choice is geometric and works on every planet. */
export interface CampaignHomes {
  /** City id per faction slot (index 0 = faction 1). */
  cities: [number, number, number];
  /** Harbor index per faction slot. */
  harbors: [number, number, number];
}
export function campaignHomes(cities: readonly (Planar & { id: number; theme?: string })[], harbors: readonly Planar[]): CampaignHomes {
  // Pick the three cities that are farthest apart (largest minimum spacing).
  let bestSet: number[] = [], bestSpread = -1, bestSum = -1;
  for (let a = 0; a < cities.length; a++) for (let b = a + 1; b < cities.length; b++) for (let c = b + 1; c < cities.length; c++) {
    const set = [a, b, c];
    const pairs = [[0, 1], [0, 2], [1, 2]].map(([i, j]) => planar(cities[set[i]], cities[set[j]]));
    const spread = Math.min(...pairs), sum = pairs.reduce((n, d) => n + d, 0);
    if (spread > bestSpread + 1e-6 || Math.abs(spread - bestSpread) <= 1e-6 && sum > bestSum) { bestSet = set; bestSpread = spread; bestSum = sum; }
  }
  if (bestSet.length !== 3) throw new Error('A campaign needs at least three cities');
  // Capitals keep their historical allegiances: Helix holds the suspended
  // capital, Vanguard the fortified one; the Accord takes the remaining city.
  const chosen = bestSet.map(i => cities[i]);
  const vesper = chosen.find(c => c.theme === 'vesper'), aurelia = chosen.find(c => c.theme === 'aurelia');
  const ordered = vesper && aurelia ? [chosen.find(c => c !== vesper && c !== aurelia)!, vesper, aurelia] : [...chosen].sort((a, b) => a.id - b.id);
  const centroid = { x: ordered.reduce((n, c) => n + c.x, 0) / 3, z: ordered.reduce((n, c) => n + c.z, 0) / 3 };
  // A home harbor lies near its city and away from the shared middle.
  const score = (harbor: Planar, city: Planar) => planar(harbor, city) - .5 * planar(harbor, centroid);
  let bestHarbors: number[] = [], bestScore = Infinity;
  for (let a = 0; a < harbors.length; a++) for (let b = 0; b < harbors.length; b++) for (let c = 0; c < harbors.length; c++) {
    if (a === b || b === c || a === c) continue;
    const total = score(harbors[a], ordered[0]) + score(harbors[b], ordered[1]) + score(harbors[c], ordered[2]);
    if (total < bestScore - 1e-6) { bestScore = total; bestHarbors = [a, b, c]; }
  }
  if (bestHarbors.length !== 3) throw new Error('A campaign needs at least three harbors');
  return { cities: ordered.map(c => c.id) as [number, number, number], harbors: bestHarbors as [number, number, number] };
}

/** Front lines: two bases are neighbors when no third base lies inside the
 * circle whose diameter joins them (a Gabriel graph), within a travel limit.
 * Factions may only attack bases adjacent to territory they hold, so wars
 * advance base by base. Disconnected pieces are joined by their shortest link. */
export const CAMPAIGN_LINK_LIMIT = 9_500;
export function campaignLattice(bases: readonly (Planar & { id: string })[]): Map<string, string[]> {
  const links = new Map(bases.map(b => [b.id, new Set<string>()]));
  const join = (a: string, b: string) => { links.get(a)!.add(b); links.get(b)!.add(a); };
  for (let i = 0; i < bases.length; i++) for (let j = i + 1; j < bases.length; j++) {
    const a = bases[i], b = bases[j], d = planar(a, b);
    if (d > CAMPAIGN_LINK_LIMIT) continue;
    const mid = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 };
    if (bases.some((c, k) => k !== i && k !== j && planar(c, mid) < d / 2 - 1e-6)) continue;
    join(a.id, b.id);
  }
  // Union components through their nearest pair until the network connects.
  for (;;) {
    const seen = new Set<string>(), stack = [bases[0]?.id].filter(Boolean) as string[];
    while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); stack.push(...links.get(id)!); }
    if (seen.size >= bases.length) break;
    let best: [string, string, number] | null = null;
    for (const a of bases) if (seen.has(a.id)) for (const b of bases) if (!seen.has(b.id)) {
      const d = planar(a, b); if (!best || d < best[2]) best = [a.id, b.id, d];
    }
    if (!best) break;
    join(best[0], best[1]);
  }
  return new Map([...links].map(([id, set]) => [id, [...set].sort()]));
}

/** The height range of the dry open ground inside a control's ring, when its
 * flag stands on such ground (roofs, decks, rocks and water excluded). On a
 * slope, standing anywhere on that ground then counts toward the capture
 * instead of only near the flag's height. Undefined when the flag stands on a
 * deck or the ground adds nothing beyond the flag's own height band. */
export function captureGround(world: World, site: Pick<Territory, 'x' | 'y' | 'z' | 'radius'>): [number, number] | undefined {
  const open = (x: number, z: number): number | null => {
    const y = world.groundY(x, z);
    return Math.abs(y - world.terrainHeight(x, z)) < .6 && !world.liquidAt(x, y + .5, z) ? y : null;
  };
  const flag = open(site.x, site.z);
  if (flag === null || Math.abs(site.y - flag) > 1) return undefined;
  let low = flag, high = flag;
  for (let r = 4; r < site.radius + 4; r += 4) for (let a = 0; a < 32; a++) {
    const reach = Math.min(r, site.radius), angle = a / 32 * Math.PI * 2;
    const y = open(site.x + Math.cos(angle) * reach, site.z + Math.sin(angle) * reach);
    if (y !== null) { low = Math.min(low, y); high = Math.max(high, y); }
  }
  if (low >= site.y - .5 && high <= site.y + .5) return undefined;
  return [Math.floor(low * 10) / 10, Math.ceil(high * 10) / 10];
}

export function campaignLayout(world: World): { bases: CampaignBase[]; territories: Territory[] } {
  const bases: CampaignBase[] = [], territories: Territory[] = [];
  const cities = world.collectCities(), harbors = world.collectTransportPlan().harbors;
  const homes = campaignHomes(cities, harbors.map(h => ({ x: h.landX, z: h.landZ })));
  const homeOf = (cityId: number) => (homes.cities.indexOf(cityId) + 1) as Faction;
  const reserved: (Point & { radius: number })[] = [];
  const controlPoint = (desired: Point, radius: number, streetY?: number): Point => {
    const sample = streetY !== undefined ? (x: number, z: number) => findStreetPoint(world, x, streetY, z)
      : (x: number, z: number) => findGroundPoint(world, x, z, true);
    const point = separatedPoint(world, desired, radius, reserved, sample);
    reserved.push({ ...point, radius }); return point;
  };
  const add = (base: Omit<CampaignBase, 'controlIds' | 'requiredPoints'>, controls: (Point & { id: string; name: string; radius?: number })[]) => {
    bases.push({ ...base, controlIds: controls.map(c => c.id), requiredPoints: Math.floor(controls.length / 2) + 1 });
    for (const control of controls) territories.push({ ...control, kind: base.kind === 'outpost' ? 'relay' : base.kind,
      radius: control.radius ?? 30, baseId: base.id, owner: base.owner,
      influence: base.owner === 1 ? -1 : base.owner ? 1 : 0, captureFaction: base.owner, captureProgress: base.owner ? 1 : 0, contested: false });
  };
  for (const city of cities) {
    const owner: Faction = homes.cities.includes(city.id) ? homeOf(city.id) : 0;
    const floor = city.y + .06;
    const districts = city.theme === 'vesper' ? vesperDistricts(city) : undefined;
    // A regional city is 768m wide; its objectives span distinct avenues.
    // Capitals use their own districts and supported ground-level networks.
    const desired = districts ? [districts[1], districts[3], districts[2]]
      : city.theme === 'aurelia' ? [{ x: city.x - 640, z: city.z }, { x: city.x, z: city.z + 640 }, { x: city.x + 640, z: city.z }]
      : [{ x: city.x - 288, z: city.z }, { x: city.x, z: city.z - 256 }, { x: city.x + 288, z: city.z }];
    const names = city.theme === 'vesper' ? ['West district relay', 'North district exchange', 'East district relay']
      : city.theme === 'aurelia' ? ['West processional relay', 'South court exchange', 'East processional relay']
      : ['West avenue relay', 'North avenue exchange', 'East avenue relay'];
    const controls = desired.map((point, index) => ({
      ...controlPoint(campaignStreetPoint(world, point.x, floor, point.z), 42, floor),
      // Legacy IDs encode the old offsets and remain stable for saved claims.
      id: `city-${city.id}-${[-128, 0, 128][index]}`, name: `${city.name} · ${names[index]}`, radius: 42 }));
    const command = campaignStreetPoint(world, city.x, floor, city.z);
    add({ id: `base-city-${city.id}`, name: city.name, kind: 'city', ...command, owner, homeFaction: 0 }, controls);
  }
  for (const [i, harbor] of harbors.entries()) {
    const side = harborDockSide(harbor), c = Math.cos(harbor.heading), s = Math.sin(harbor.heading);
    const quay = { x: harbor.x + c * 29 * side + s * 20, y: harbor.y + FERRY_DECK_HEIGHT + .06,
      z: harbor.z - s * 29 * side + c * 20 };
    const shore = campaignPoint(world, harbor.landX, harbor.landZ, true);
    const approach = campaignPoint(world, (quay.x + shore.x) * .5, (quay.z + shore.z) * .5, true);
    const owner: Faction = homes.harbors.includes(i) ? (homes.harbors.indexOf(i) + 1) as Faction : 0;
    const inlandX = shore.x - quay.x, inlandZ = shore.z - quay.z, inlandLength = Math.hypot(inlandX, inlandZ) || 1;
    const command = campaignPoint(world, shore.x + inlandX / inlandLength * 160, shore.z + inlandZ / inlandLength * 160);
    add({ id: `base-harbor-${i}`, name: harbor.name, kind: 'harbor', ...command, owner, homeFaction: owner }, [
      { ...controlPoint(quay, 22, quay.y), id: `harbor-${i}`, name: `${harbor.name} · Quay`, radius: 22 },
      { ...controlPoint(approach, 26), id: `harbor-${i}-approach`, name: `${harbor.name} · Approach`, radius: 26 },
      { ...controlPoint(shore, 30), id: `harbor-${i}-shore`, name: `${harbor.name} · Coast relay`, radius: 30 },
    ]);
  }
  // Each home region's forward base sits on a road beyond its city's edge,
  // facing the middle of the three homes: the faction's first front line.
  const homeCities = homes.cities.map(id => cities.find(c => c.id === id)!);
  const centroid = { x: homeCities.reduce((n, c) => n + c.x, 0) / 3, z: homeCities.reduce((n, c) => n + c.z, 0) / 3 };
  const placed: Planar[] = [];
  for (const faction of [1, 2, 3] as const) {
    const city = homeCities[faction - 1], toward = planar(city, centroid) || 1;
    const ux = (centroid.x - city.x) / toward, uz = (centroid.z - city.z) / toward;
    let reach = Math.min(city.radius + 1400, Math.max(city.radius + 700, toward * .8));
    // Opposing forward bases stay well apart even on a compact planet.
    while (reach > city.radius + 500 && placed.some(p => planar(p, { x: city.x + ux * reach, z: city.z + uz * reach }) < 2600)) reach -= 100;
    const desiredX = city.x + ux * reach, desiredZ = city.z + uz * reach;
    const clear = (p: Planar) => cities.every(c => planar(p, c) > c.radius + 260);
    const roads = world.collectRoadSegments(desiredX - 420, desiredX + 420, desiredZ - 420, desiredZ + 420).filter(r => !r.trail);
    const candidates = roads.flatMap(r => [r.a, r.b]).filter(clear);
    candidates.sort((a, b) => Math.hypot(a.x - desiredX, a.z - desiredZ) - Math.hypot(b.x - desiredX, b.z - desiredZ));
    const point = campaignPoint(world, candidates[0]?.x ?? desiredX, candidates[0]?.z ?? desiredZ);
    placed.push(point);
    const name = `${city.name} Forward Base`;
    const controls = [[-160, 0], [0, -160], [160, 0]].map(([dx, dz], i) => ({
      ...controlPoint(campaignPoint(world, point.x + dx, point.z + dz), 30),
      id: `forward-${faction}-${i}`, name: `${name} · ${['West relay', 'North relay', 'East relay'][i]}`, radius: 30 }));
    add({ id: `base-forward-${faction}`, name, kind: 'outpost', ...point, owner: faction, homeFaction: 0 }, controls);
  }
  // Command markers are reference/rally anchors, not capture flags. A future
  // terrain fallback may move a control, so validate against the final network.
  for (const base of bases) {
    const sample = base.kind === 'city' ? (x: number, z: number) => findStreetPoint(world, x, base.y, z)
      : (x: number, z: number) => findGroundPoint(world, x, z);
    Object.assign(base, separatedPoint(world, base, 0, reserved, sample));
  }
  // City streets are graded level; relays and coast relays can sit on slopes.
  for (const site of territories) if (site.kind !== 'city') {
    const ground = captureGround(world, site);
    if (ground) site.ground = ground;
  }
  return { bases, territories };
}
