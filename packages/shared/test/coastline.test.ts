import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { COAST_REACH, ISLAND_SHORE_START, ISLAND_SHORE_END, OFFSHORE_ISLANDS, canReachCoast,
  islandCoastDistance, mainCoastDistance, originalCoastDistance } from '@shared/liquids';

const seed = 1337;

test('no coast reaches its volcano fade band inside the canReachCoast fast path', () => {
  let reach = Infinity;
  for (let a = 0; a < Math.PI * 2; a += .001) {
    let lo = 3000, hi = 11264;
    for (let i = 0; i < 36; i++) {
      const m = (lo + hi) / 2;
      if (mainCoastDistance(seed, Math.cos(a) * m, Math.sin(a) * m) >= ISLAND_SHORE_START - 150) hi = m; else lo = m;
    }
    reach = Math.min(reach, Math.max(Math.abs(Math.cos(a) * hi), Math.abs(Math.sin(a) * hi)));
  }
  assert.ok(reach > COAST_REACH, `the nearest coast band begins at ${reach.toFixed(0)}, inside ${COAST_REACH}`);
  for (const island of OFFSHORE_ISLANDS) assert.ok(canReachCoast(island.x, island.z), 'islands lie on the coast path');
});

test('the coast only recedes, and keeps its old line at harbors, runways and capitals', () => {
  for (let a = 0; a < Math.PI * 2; a += .01) for (const r of [7000, 8000, 8600, 9200]) {
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    assert.ok(mainCoastDistance(seed, x, z) >= originalCoastDistance(seed, x, z) - 1e-9, 'bays only: land never advances');
  }
  const kept = [[0, 9300], [-9300, 0], [0, -9300], [9400, 1100], [-8051, -3979], [-4400, 8382], [1117, 8355], [6995, -7580]];
  for (const [x, z] of kept) for (const scale of [.9, 1, 1.05]) {
    assert.equal(mainCoastDistance(seed, x * scale, z * scale), originalCoastDistance(seed, x * scale, z * scale),
      `kept coast at ${x},${z}`);
  }
  for (const [cx, cz, radius] of [[-5120, -5120, 2000], [6144, 4096, 1800]]) for (let a = 0; a < Math.PI * 2; a += .2) {
    const x = cx + Math.cos(a) * radius * 1.2, z = cz + Math.sin(a) * radius * 1.2;
    assert.equal(mainCoastDistance(seed, x, z), originalCoastDistance(seed, x, z), 'a capital keeps its surroundings');
  }
});

test('offshore islands are land and stay clear of the ocean ferry lanes', () => {
  const plan = new World(seed).collectTransportPlan();
  for (const island of OFFSHORE_ISLANDS) {
    assert.ok(islandCoastDistance(seed, island.x, island.z) < ISLAND_SHORE_START, 'an island center is inland');
    for (const route of plan.routes) if (route.kind === 'ferry') for (const leg of route.legs) for (const p of leg.points) {
      assert.ok(Math.hypot(p.x - island.x, p.z - island.z) > island.radius + 300, `${route.name} passes clear of the island`);
    }
  }
  for (const route of plan.routes) if (route.kind === 'ferry') for (const leg of route.legs) for (const p of leg.points) {
    if (originalCoastDistance(seed, p.x, p.z) >= ISLAND_SHORE_END)
      assert.ok(islandCoastDistance(seed, p.x, p.z) >= ISLAND_SHORE_END, 'ocean ferry lanes stay in open water');
  }
});
