import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { capsuleClearance } from '@shared/physics';
import { createMoveState, stepMove, BTN } from '@shared/movement';
import { TICK_DT } from '@shared/constants';
import { PLANETS } from '@shared/universe';
import { vesperRoutes } from '@shared/vesper-city';
import { CAPTURE_HEIGHT, inCaptureRange, type Territory } from '@shared/frontier';
import { campaignLayout, CAMPAIGN_CAPTURE_GAP } from '../src/campaign-layout.js';

type Point = { x: number; z: number };
function streetRoute(world: World, site: Territory): Point[] {
  const city = world.collectCities().find(c => site.baseId === `base-city-${c.id}`)!;
  if (city.theme !== 'vesper') return [city, site];
  const key = (p: Point) => `${p.x},${p.z}`, nodes = new Map<string, { point: Point; neighbors: string[] }>();
  for (const route of vesperRoutes(city).filter(r => Math.abs(r.y - site.y) < .1)) {
    const a = { x: route.ax, z: route.az }, b = { x: route.bx, z: route.bz };
    for (const [from, to] of [[a, b], [b, a]]) {
      const id = key(from);
      if (!nodes.has(id)) nodes.set(id, { point: from, neighbors: [] });
      nodes.get(id)!.neighbors.push(key(to));
    }
  }
  const queue = [key(city)], parent = new Map<string, string | null>([[key(city), null]]);
  for (const id of queue) for (const neighbor of nodes.get(id)?.neighbors ?? []) if (!parent.has(neighbor)) {
    parent.set(neighbor, id); queue.push(neighbor);
  }
  assert.ok(parent.has(key(site)), `${site.id}: objective must belong to the ground-level bridge graph`);
  const path: Point[] = [];
  for (let id: string | null = key(site); id !== null; id = parent.get(id)!) path.push(nodes.get(id)!.point);
  return path.reverse();
}

test('campaign controls have distinct city districts, globally separated circles and independent command anchors', () => {
  for (const seed of [...PLANETS.map(p => p.seed), 1, 27, 424242]) {
    const world = new World(seed), layout = campaignLayout(world);
    assert.equal(layout.bases.length, 12); assert.equal(layout.territories.length, 36);
    for (const city of world.collectCities()) {
      const sites = layout.territories.filter(t => t.baseId === `base-city-${city.id}`);
      assert.deepEqual(sites.map(t => t.id), [-128, 0, 128].map(offset => `city-${city.id}-${offset}`), 'existing saved claims retain their IDs');
      for (const a of sites) for (const b of sites) if (a !== b)
        assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= (city.theme ? 850 : 350), `${seed}: city objectives must occupy distinct approaches`);
    }
    for (const [index, site] of layout.territories.entries()) {
      assert.equal(world.liquidAt(site.x, site.y, site.z), undefined, `${seed}/${site.id}: wet capture point`);
      assert.ok(capsuleClearance(world, site.x, site.y + .02, site.z) >= -.02, `${seed}/${site.id}: obstructed capture point`);
      assert.ok(world.sdf(site.x, site.y - .12, site.z) <= 0, `${seed}/${site.id}: unsupported capture point`);
      for (const other of layout.territories.slice(index + 1))
        assert.ok(Math.hypot(site.x - other.x, site.z - other.z) >= site.radius + other.radius + CAMPAIGN_CAPTURE_GAP - 1e-7,
          `${seed}: capture circles ${site.id} and ${other.id} are too close`);
    }
    for (const base of layout.bases) {
      assert.equal(world.liquidAt(base.x, base.y, base.z), undefined, `${seed}/${base.id}: wet command anchor`);
      assert.ok(capsuleClearance(world, base.x, base.y + .02, base.z) >= -.02);
      assert.ok(world.sdf(base.x, base.y - .2, base.z) <= 0);
      for (const site of layout.territories) assert.ok(Math.hypot(base.x - site.x, base.z - site.z) >= site.radius + CAMPAIGN_CAPTURE_GAP - 1e-7,
        `${seed}/${base.id}: command marker must not be a capture flag`);
    }
  }
});

test('wide city objectives have continuous dry street routes and ordinary walking reaches every flag', () => {
  for (const planet of PLANETS) {
    const world = new World(planet.seed), layout = campaignLayout(world);
    for (const site of layout.territories.filter(t => t.kind === 'city')) {
      const route = streetRoute(world, site);
      for (let i = 1; i < route.length; i++) {
        const a = route[i - 1], b = route[i], distance = Math.hypot(b.x - a.x, b.z - a.z), steps = Math.ceil(distance / 8);
        for (let step = 0; step <= steps; step++) {
          const x = a.x + (b.x - a.x) * step / steps, z = a.z + (b.z - a.z) * step / steps;
          assert.ok(capsuleClearance(world, x, site.y + .02, z) >= -.02, `${planet.id}/${site.id}: blocked street`);
          assert.ok(world.sdf(x, site.y - .12, z) <= 0, `${planet.id}/${site.id}: bridge gap`);
          assert.equal(world.liquidAt(x, site.y, z), undefined, `${planet.id}/${site.id}: flooded route`);
        }
      }
      const a = route[route.length - 2], b = route[route.length - 1], length = Math.hypot(b.x - a.x, b.z - a.z);
      const state = createMoveState(b.x + (a.x - b.x) * 80 / length, site.y + .02, b.z + (a.z - b.z) * 80 / length);
      let tick = 0;
      for (; tick < 1200 && Math.hypot(site.x - state.px, site.z - state.pz) > .3; tick++) stepMove(world, state, {
        seq: tick, buttons: BTN.FORWARD, yaw: Math.atan2(-(site.x - state.px), -(site.z - state.pz)), pitch: 0,
        weapon: 0, renderTick: 0, renderFrac: 0,
      }, TICK_DT);
      assert.ok(tick < 1200, `${planet.id}/${site.id}: ordinary walking cannot enter the capture point`);
      assert.ok(Math.abs(state.py - site.y) < .12, 'arrival stays on the street rather than a roof above it');
    }
  }
});

test('overlapping requested city positions relocate onto distinct supported capture circles', () => {
  const world = new World(1337), cities = world.collectCities();
  // Model an additional future district whose preferred streets collide
  // with an existing network, exercising the separation fallback itself.
  world.collectCities = () => [...cities, { ...cities[0], id: 4, name: 'Neighboring district' }];
  const layout = campaignLayout(world);
  for (const [index, site] of layout.territories.entries()) {
    for (const other of layout.territories.slice(index + 1)) assert.ok(
      Math.hypot(site.x - other.x, site.z - other.z) >= site.radius + other.radius + CAMPAIGN_CAPTURE_GAP - 1e-7,
      `${site.id}/${other.id}: placement fallback reused an occupied control position`);
    assert.equal(world.liquidAt(site.x, site.y, site.z), undefined);
    assert.ok(capsuleClearance(world, site.x, site.y + .02, site.z) >= -.02);
    assert.ok(world.sdf(site.x, site.y - .12, site.z) <= 0);
  }
});

test('on a sloped relay every dry open patch of ground inside the ring counts for a player; bots keep the flag band', () => {
  const world = new World(1337), layout = campaignLayout(world);
  const open = (x: number, z: number) => {
    const y = world.groundY(x, z);
    return Math.abs(y - world.terrainHeight(x, z)) < .6 && !world.liquidAt(x, y + .5, z) ? y : null;
  };
  let sloped = 0, beyondFlag = 0;
  for (const site of layout.territories) {
    if (site.kind === 'city') { assert.equal(site.ground, undefined, `${site.id}: city streets are level`); continue; }
    const flag = open(site.x, site.z);
    if (flag === null || Math.abs(site.y - flag) > 1) { assert.equal(site.ground, undefined, `${site.id}: a deck flag keeps the flag band`); continue; }
    if (site.ground) {
      sloped++;
      assert.ok(!inCaptureRange(site, site.x, site.ground[1] + CAPTURE_HEIGHT + .5, site.z, true), `${site.id}: high roofs do not count`);
      assert.ok(!inCaptureRange(site, site.x, site.ground[0] - CAPTURE_HEIGHT - .5, site.z, true), `${site.id}: deep caves do not count`);
      if (site.ground[1] > site.y + CAPTURE_HEIGHT) {
        beyondFlag++;
        assert.ok(!inCaptureRange(site, site.x, site.ground[1], site.z), `${site.id}: bots keep the flag band`);
      }
    }
    // A finer grid than the layout's own sampling, out to just inside the edge.
    for (let r = 3; r < site.radius + 3; r += 3) for (let a = 0; a < 48; a++) {
      const reach = Math.min(r, site.radius - .01);
      const x = site.x + Math.cos(a / 48 * Math.PI * 2) * reach, z = site.z + Math.sin(a / 48 * Math.PI * 2) * reach, y = open(x, z);
      if (y !== null) assert.ok(inCaptureRange(site, x, y, z, true), `${site.id}: ground at ${x.toFixed(1)},${y.toFixed(1)},${z.toFixed(1)} is dead`);
    }
  }
  assert.ok(sloped >= 5 && beyondFlag >= 1, `Meridian has sloped relays (${sloped}, ${beyondFlag} rising beyond the flag band)`);
});
