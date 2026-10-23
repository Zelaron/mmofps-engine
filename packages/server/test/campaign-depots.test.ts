import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANETS } from '@shared/universe';
import { VEHICLE, vehicleDefinition } from '@shared/vehicles';
import { sphereFieldContact } from '@shared/physics';
import { Game } from '../src/game.js';

type DepotAccess = { initCampaignVehicles(): void; updateVehicles(): void };

test('every city and harbor supplies supported road transports on all three planets', () => {
  for (const planet of PLANETS) {
    const game = new Game(planet.seed, { frontier: true });
    (game as unknown as DepotAccess).initCampaignVehicles();
    for (const base of game.frontier!.bases) {
      const stock = [...game.vehicles.values()].filter(v => v.campaignBaseId === base.id);
      assert.equal(stock.length, base.kind === 'city' ? 4 : base.kind === 'outpost' ? 6 : 1, `${planet.id}: ${base.name}`);
      assert.ok(stock.some(v => v.type === VEHICLE.JEEP));
      for (const hull of stock) {
        const def = vehicleDefinition(hull.type)!;
        assert.equal(hull.campaignFaction, base.owner);
        assert.ok(hull.campaignHome);
        const floor = game.world.trace(hull.x, hull.y + .8, hull.z, 0, -1, 0, 1.6);
        assert.ok(floor.hit && Math.abs(floor.dist - .85) < .15, `${base.name} transport has a street-level floor`);
        const overlap = sphereFieldContact(game.world, hull.x, hull.y + def.radius, hull.z, def.radius);
        assert.ok(!overlap || overlap.depth < .15, `${base.name} transport clears buildings and bridges`);
      }
    }
  }
});

test('captured depots replenish at home for their new owner without converting deployed crews', () => {
  const game = new Game(1337, { frontier: true });
  const access = game as unknown as DepotAccess;
  access.initCampaignVehicles();
  const base = game.frontier!.bases.find(b => b.id === 'base-city-2')!;
  const [parked, deployed, crewed, destroyed] = [...game.vehicles.values()].filter(v => v.campaignBaseId === base.id);
  deployed.x += 200;
  crewed.occupant = 987654;
  destroyed.x += 1200; destroyed.health = 0; destroyed.respawnAtTick = 0;
  base.owner = 1;
  access.updateVehicles();
  assert.equal(parked.campaignFaction, 1);
  assert.equal(destroyed.campaignFaction, 1);
  assert.equal(deployed.campaignFaction, 2);
  assert.equal(crewed.campaignFaction, 2);
  assert.equal(destroyed.respawnAtTick, -1);
  assert.equal(destroyed.x, destroyed.campaignHome!.x);
  assert.equal(destroyed.z, destroyed.campaignHome!.z);
  assert.equal(destroyed.health, vehicleDefinition(destroyed.type)!.maxHealth);
});
