import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityRewardSites } from '@shared/cities';
import { PICKUP_WEAPON, PICKUP_AMMO, PICKUP_HEALTH, TICK_RATE, capsuleClearance } from '@shared/index';
import { Game } from '../src/game.js';

test('each city stocks a reachable rooftop weapon cache with ammo and replenishes it', () => {
  const game = new Game(1337, { teleporters: true });
  const stock = () => (game as unknown as { updateCaveLoot(): void }).updateCaveLoot();
  stock();
  const cities = game.world.collectCities();
  const sites = cities.flatMap(city => cityRewardSites(city));
  assert.equal(cities.length, 4);
  for (const city of cities) {
    assert.ok(cityRewardSites(city).length >= (city.theme ? 3 : 1),
      `${city.name} must stock every rooftop route, including the expanded capital caches`);
  }
  assert.equal(new Set(sites.map(site => site.id)).size, sites.length, 'cache identities must remain unique');
  for (const site of sites) {
    const stash = [...game.pickups.values()].filter(p => Math.hypot(p.x - site.x, p.y - site.y, p.z - site.z) < 3);
    assert.equal(stash.length, 2);
    assert.ok(stash.some(p => p.kind === PICKUP_WEAPON && p.weapon === site.weapon));
    assert.ok(stash.some(p => p.kind === PICKUP_AMMO && p.weapon === site.weapon));
    for (const p of stash) {
      assert.ok(p.weapon === 7 || p.weapon === 8, 'cavern-exclusive weapons cannot appear in rooftop caches');
      assert.ok(capsuleClearance(game.world, p.x, site.y + .006, p.z) >= -.01, 'cache has player headroom');
      // Adjacent structural boxes can meet at a zero-valued field seam. Trace
      // the player's footprint to verify a real horizontal deck at this level.
      for (const [dx, dz] of [[0, 0], [.3, 0], [-.3, 0], [0, .3], [0, -.3]]) {
        const floor = game.world.trace(p.x + dx, site.y + 1, p.z + dz, 0, -1, 0, 2);
        assert.ok(floor.hit && Math.abs(floor.dist - 1) < .02 && floor.ny > .9,
          `cache ${site.id} has a supporting roof across its footprint at ${dx},${dz}`);
      }
    }
    const weapon = stash.find(p => p.kind === PICKUP_WEAPON)!;
    game.pickups.delete(weapon.id); stock();
    game.tick += 45 * TICK_RATE - 1; stock();
    assert.ok(![...game.pickups.values()].some(p => p.x === weapon.x && p.z === weapon.z && p.kind === PICKUP_WEAPON));
    game.tick++; stock();
    assert.ok([...game.pickups.values()].some(p => p.x === weapon.x && p.z === weapon.z && p.kind === PICKUP_WEAPON));
  }
});

test('station aid kiosks have reachable health and rockets that can be collected and replenish', () => {
  const game = new Game(1337, { teleporters: true });
  const internal = game as unknown as { updateCaveLoot(): void; updatePickups(): void };
  internal.updateCaveLoot();
  const player = game.addPlayer('Passenger', null);
  const stations = game.world.collectTransportPlan().stations;
  assert.ok(stations.length >= 4);
  for (const station of stations) {
    const supplies = [...game.pickups.values()].filter(p =>
      Math.abs(p.y - station.railY - 1.6) < .01 && p.z === station.z - 32 &&
      p.x >= station.x + 49 && p.x <= station.x + 56);
    assert.equal(supplies.length, 2, `${station.name} has two platform supplies`);
    assert.ok(supplies.some(p => p.kind === PICKUP_HEALTH));
    assert.ok(supplies.some(p => p.kind === PICKUP_AMMO && p.weapon === 3));
    for (const supply of supplies) {
      const floorY = station.railY + 1.2;
      assert.ok(capsuleClearance(game.world, supply.x, floorY + .006, supply.z) >= -.01,
        `${station.name} has clear kiosk headroom`);
      const floor = game.world.trace(supply.x, floorY + 1, supply.z, 0, -1, 0, 2);
      assert.ok(floor.hit && Math.abs(floor.y - floorY) < .02 && floor.ny > .9);
      player.state.px = supply.x; player.state.py = floorY + .006; player.state.pz = supply.z;
      player.health = 40; player.ammo[3].reserve = 0;
      internal.updatePickups();
      assert.ok(!game.pickups.has(supply.id), 'walking to the supply collects it');
      assert.ok(supply.kind === PICKUP_HEALTH ? player.health > 40 : player.ammo[3].reserve > 0);
    }
  }
  internal.updateCaveLoot();
  game.tick += 45 * TICK_RATE;
  internal.updateCaveLoot();
  for (const station of stations) {
    assert.equal([...game.pickups.values()].filter(p => p.z === station.z - 32 &&
      Math.abs(p.y - station.railY - 1.6) < .01 && p.x >= station.x + 49 && p.x <= station.x + 56).length, 2,
    `${station.name} replenishes both supplies after use`);
  }
});
