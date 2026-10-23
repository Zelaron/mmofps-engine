import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rainforestAt, rainforestSites } from '@shared/rainforest';
import { World } from '@shared/worldgen';
import { smoothstep } from '@shared/math';

test('rainforest constant-region bounds preserve exact original edge values', () => {
  const original = (seed: number, x: number, z: number) => {
    let weight = 0;
    for (const site of rainforestSites(seed)) {
      const dx = x - site.x, dz = z - site.z;
      if (Math.abs(dx) > site.radius + 150 || Math.abs(dz) > site.radius + 150) continue;
      const angle = Math.atan2(dz, dx);
      const boundary = site.radius * (.92 + .065 * Math.sin(angle * 3) + .035 * Math.cos(angle * 7));
      weight = Math.max(weight, smoothstep(boundary + 100, boundary - 160, Math.hypot(dx, dz)));
    }
    return weight;
  };
  for (const seed of [1, 1337, 7331, 20077, 424242]) {
    for (const site of rainforestSites(seed)) for (let angle = 0; angle < 64; angle++) {
      const theta = angle * Math.PI / 32;
      const edge = site.radius * (.92 + .065 * Math.sin(theta * 3) + .035 * Math.cos(theta * 7));
      for (const radius of [0, site.radius * .82 - 160, site.radius * 1.02 + 100, edge - 160, edge - 30, edge + 100, site.radius + 150]) {
        for (const offset of [-1e-6, -1e-10, 0, 1e-10, 1e-6]) {
          const x = site.x + Math.cos(theta) * (radius + offset), z = site.z + Math.sin(theta) * (radius + offset);
          assert.equal(rainforestAt(seed, x, z), original(seed, x, z), `seed ${seed}, angle ${angle}, radius ${radius}, offset ${offset}`);
        }
      }
    }
    for (const [x, z] of [[Infinity, 0], [0, -Infinity], [NaN, 0]])
      assert.equal(rainforestAt(seed, x, z), original(seed, x, z));
  }
});

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
