import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rainforestAt, rainforestSites } from '@shared/rainforest';
import { World } from '@shared/worldgen';

test('rainforests are contiguous deterministic provinces with soft irregular edges', () => {
  for (const seed of [1, 1337, 424242]) {
    const sites = rainforestSites(seed);
    assert.equal(sites.length, 3);
    for (const site of sites) {
      assert.equal(rainforestAt(seed, site.x, site.z), 1);
      assert.equal(rainforestAt(seed, site.x + 1600, site.z), 0);
      assert.ok(rainforestAt(seed, site.x + site.radius, site.z) > 0);
    }
  }
});

test('rainforest supports dense emergent giants with authoritative large trunks and open roads', () => {
  const world = new World(1337), site = rainforestSites(1337)[0];
  const plants = world.collectVegetation(site.x - 384, site.x + 384, site.z - 384, site.z + 384);
  const giants = plants.filter(p => p.rainforest);
  assert.ok(giants.length > 130, `too few giants: ${giants.length}`);
  assert.ok(Math.max(...giants.map(p => p.height)) > 67);
  assert.ok(new Set(giants.map(p => Math.floor(p.height / 5))).size >= 6);
  for (const plant of giants.slice(0, 30)) {
    assert.ok(plant.radius >= 1.7 && plant.radius <= 3.8);
    assert.ok(plant.canopyRadius >= 10 && plant.height <= 69);
    assert.ok(world.sdf(plant.x, plant.y + plant.height * .5, plant.z) < 0);
    const road = world.column(plant.x, plant.z).road;
    assert.ok(!road || road.distance >= road.width + plant.canopyRadius + 2);
  }
});
