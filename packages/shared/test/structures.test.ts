import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, STRUCTURE_KIND } from '@shared/worldgen';
import { capsuleClearance } from '@shared/physics';
import { disjointStructureBoxes } from '@shared/structures';

test('deep research outposts are deterministic, roofed and open across a supported central route', () => {
  const a = new World(1337), b = new World(1337);
  const sites = a.collectUndergroundSites(-900, 900, -900, 900);
  assert.deepEqual(sites, b.collectUndergroundSites(-900, 900, -900, 900));
  assert.ok(sites.length >= 6 && sites.length < 40, `unexpected deep site density ${sites.length}`);
  for (const site of sites.slice(0, 8)) {
    assert.equal(site.underground, true);
    assert.equal(site.kind, STRUCTURE_KIND.RESEARCH_STATION);
    assert.ok(site.top < -15 && site.top > -44, 'an underground site must occupy the deep cave layer');
    assert.equal(a.roofedAbove(site.x, site.top + 1.7, site.z), true);
    const region = a.collectStructures(site.x - 10, site.x + 10, site.z - 10, site.z + 10);
    const floor = region.foundations?.find((f) => f.underground && f.x === site.x && f.z === site.z);
    assert.ok(floor, 'the authoritative deep floor must reach the renderer');
    assert.ok(Math.abs(floor.y + floor.hy - site.top) < 1e-8);
    for (let z = -8; z <= 8; z += 0.5) for (const x of [-1.5, 0, 1.5]) {
      const wx = site.x + x, wz = site.z + z;
      assert.ok(capsuleClearance(a, wx, site.top + 0.02, wz) >= 0,
        `deep outpost route is blocked at ${wx},${wz}`);
      assert.ok(a.sdf(wx, site.top - 0.05, wz) < 0, 'deep route has unsupported flooring');
    }
    for (const sign of [-1, 1]) {
      const z = site.z + sign * 10;
      const hit = a.trace(site.x, site.top + 2, z, 0, -1, 0, 5);
      assert.ok(hit.hit && Math.abs(hit.y - site.top) < 1.25,
        'deep outpost must meet the surrounding cave floor at its open ends');
      assert.ok(capsuleClearance(a, site.x, Math.max(hit.y, site.top) + 0.04, z) >= 0,
        'cave approach must retain full player headroom');
    }
  }
});

test('large installations preserve road lanes and bounded exact solid unions', () => {
  const world = new World(1);
  const region = world.collectStructures(-1900, 1900, -1900, 1900);
  const compounds = region.sites.filter((s) => s.kind === STRUCTURE_KIND.MILITARY_BASE);
  assert.ok(compounds.length > 0, 'the world must occasionally supply a large military base');
  for (const site of compounds) {
    assert.ok(site.hx * site.hz >= 1500, 'a large installation needs a substantial footprint');
    for (let z = -site.hz; z <= site.hz; z += 2) for (let x = -site.hx; x <= site.hx; x += 2) {
      const road = world.roadAt(site.x + x, site.z + z);
      assert.ok(!road || road.distance > road.width, 'a compound foundation obstructs a connected road');
    }
  }
  const near = world.collectStructures(-768, 768, -768, 768);
  const exact = disjointStructureBoxes(near.solids);
  assert.ok(exact.length < 8192, `a representative view overflows its solid pool: ${exact.length}`);
  assert.ok(exact.length < near.solids.length * 4, 'box union decomposition expands excessively');
});
