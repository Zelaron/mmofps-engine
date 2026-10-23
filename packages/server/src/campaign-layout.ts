import { capsuleClearance } from '@shared/physics';
import { FACTIONS, type CampaignBase, type Faction, type Territory } from '@shared/frontier';
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

export function campaignLayout(world: World): { bases: CampaignBase[]; territories: Territory[] } {
  const bases: CampaignBase[] = [], territories: Territory[] = [];
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
  for (const city of world.collectCities()) {
    const owner: Faction = city.id >= 2 ? city.id === 2 ? 2 : 3 : 0;
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
  for (const [i, harbor] of world.collectTransportPlan().harbors.entries()) {
    const side = harborDockSide(harbor), c = Math.cos(harbor.heading), s = Math.sin(harbor.heading);
    const quay = { x: harbor.x + c * 29 * side + s * 20, y: harbor.y + FERRY_DECK_HEIGHT + .06,
      z: harbor.z - s * 29 * side + c * 20 };
    const shore = campaignPoint(world, harbor.landX, harbor.landZ, true);
    const approach = campaignPoint(world, (quay.x + shore.x) * .5, (quay.z + shore.z) * .5, true);
    const owner: Faction = i < 3 ? (i + 1) as Faction : 0;
    const inlandX = shore.x - quay.x, inlandZ = shore.z - quay.z, inlandLength = Math.hypot(inlandX, inlandZ) || 1;
    const command = campaignPoint(world, shore.x + inlandX / inlandLength * 160, shore.z + inlandZ / inlandLength * 160);
    add({ id: `base-harbor-${i}`, name: harbor.name, kind: 'harbor', ...command, owner, homeFaction: owner }, [
      { ...controlPoint(quay, 22, quay.y), id: `harbor-${i}`, name: `${harbor.name} · Quay`, radius: 22 },
      { ...controlPoint(approach, 26), id: `harbor-${i}-approach`, name: `${harbor.name} · Approach`, radius: 26 },
      { ...controlPoint(shore, 30), id: `harbor-${i}-shore`, name: `${harbor.name} · Coast relay`, radius: 30 },
    ]);
  }
  const front = world.collectCities()[0];
  if (front) for (const faction of [1, 2, 3] as const) {
    const side = faction === 1 ? -1 : 1, desiredX = front.x + (faction === 3 ? 0 : side * 760), desiredZ = front.z + (faction === 3 ? 820 : 0);
    const roads = world.collectRoadSegments(desiredX - 360, desiredX + 360, desiredZ - 360, desiredZ + 360).filter(r => !r.trail);
    const candidates = roads.flatMap(r => [r.a, r.b]).filter(p => (faction === 3 ? p.z - front.z > 510 : (p.x - front.x) * side > 510) && Math.hypot(p.x - front.x, p.z - front.z) < 1300);
    candidates.sort((a, b) => Math.hypot(a.x - desiredX, a.z - desiredZ) - Math.hypot(b.x - desiredX, b.z - desiredZ));
    const point = campaignPoint(world, candidates[0]?.x ?? desiredX, candidates[0]?.z ?? desiredZ);
    const controls = [[-160, 0], [0, -160], [160, 0]].map(([dx, dz], i) => ({
      ...controlPoint(campaignPoint(world, point.x + dx, point.z + dz), 30),
      id: `forward-${faction}-${i}`, name: `${FACTIONS[faction].name} staging · ${['West relay', 'North relay', 'East relay'][i]}`, radius: 30 }));
    add({ id: `base-forward-${faction}`, name: `${FACTIONS[faction].name} Forward Base`, kind: 'outpost', ...point, owner: faction, homeFaction: 0 }, controls);
  }
  // Command markers are reference/rally anchors, not capture flags. A future
  // terrain fallback may move a control, so validate against the final network.
  for (const base of bases) {
    const sample = base.kind === 'city' ? (x: number, z: number) => findStreetPoint(world, x, base.y, z)
      : (x: number, z: number) => findGroundPoint(world, x, z);
    Object.assign(base, separatedPoint(world, base, 0, reserved, sample));
  }
  return { bases, territories };
}
