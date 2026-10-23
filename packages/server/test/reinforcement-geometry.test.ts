import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { capsuleClearance } from '@shared/physics';
import { createMoveState, stepMove } from '@shared/movement';
import { TICK_DT } from '@shared/constants';
import { PLANETS } from '@shared/universe';
import type { Faction } from '@shared/frontier';
import { campaignLayout } from '../src/campaign-layout.js';
import { ReinforcementPlanner, REINFORCEMENT_ZONE_GAP } from '../src/reinforcements.js';
import { campaignRoadRoute } from '../src/bot-navigation.js';
import type { ServerPlayer } from '../src/game.js';

function actor(id: number, faction: Faction, x: number, y: number, z: number, alive = true): ServerPlayer {
  return { id, faction, state: { px: x, py: y, pz: z, alive } } as ServerPlayer;
}

test('native city reinforcement offers stay outside every flag and remain stable on their pedestrian support', () => {
  for (const planet of PLANETS) {
    const world = new World(planet.seed), layout = campaignLayout(world);
    for (const city of world.collectCities()) {
      const base = layout.bases.find(b => b.id === `base-city-${city.id}`)!;
      const faction = (base.owner || 1) as Faction;
      base.owner = faction;
      for (const control of layout.territories.filter(t => t.baseId === base.id)) control.owner = faction;
      const planner = new ReinforcementPlanner(world, layout.territories);
      const player = actor(1, faction, base.x, base.y, base.z, false), enemies: ServerPlayer[] = [];
      let offers = 0;
      for (let attempt = 0; attempt < 8; attempt++) {
        const option = planner.baseOption(base, player, enemies, attempt * 60);
        if (!option.available) break;
        offers++;
        const label = `${planet.id}/${base.id}/${attempt}`;
        assert.equal(world.liquidAt(option.x, option.y, option.z), undefined, `${label}: wet arrival`);
        assert.ok(capsuleClearance(world, option.x, option.y, option.z) >= -.02, `${label}: blocked capsule`);
        for (const site of layout.territories) assert.ok(Math.hypot(site.x - option.x, site.z - option.z)
          >= site.radius + REINFORCEMENT_ZONE_GAP - 1e-7, `${label}: reinforcements overlap a capture zone`);
        if (Math.max(Math.abs(option.x - city.x), Math.abs(option.z - city.z)) < city.radius)
          assert.ok(Math.abs(option.y - city.y - .08) < .02, `${label}: arrival is on an upper roof instead of the street`);
        const state = createMoveState(option.x, option.y, option.z);
        for (let tick = 0; tick < 120; tick++) stepMove(world, state, {
          seq: tick, buttons: 0, yaw: 0, pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0,
        }, TICK_DT);
        assert.ok(Math.abs(state.py - option.y) < .6 && state.grounded,
          `${label}: arrival falls or slides off its support (${state.py - option.y}m)`);
        if (city.theme === 'vesper') {
          const control = layout.territories.find(t => t.id === option.controlId)!;
          const route = campaignRoadRoute(world, option, control);
          assert.ok(route.length, `${label}: suspended arrival has no bridge route to its quiet control`);
          const path = [option, ...route, control];
          for (let leg = 1; leg < path.length; leg++) {
            const a = path[leg - 1], b = path[leg], steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4));
            for (let step = 0; step <= steps; step++) {
              const x = a.x + (b.x - a.x) * step / steps, y = a.y + (b.y - a.y) * step / steps,
                z = a.z + (b.z - a.z) * step / steps;
              assert.ok(world.sdf(x, y - .12, z) <= 0 && capsuleClearance(world, x, y + .02, z) >= -.02,
                `${label}: quiet-control route leaves the usable bridge at ${x - city.x},${z - city.z}`);
            }
          }
        }
        // Threaten each earlier offer so later iterations exercise actual
        // alternate candidates, not only the central command anchor.
        enemies.push(actor(100 + attempt, (faction % 3 + 1) as Faction, option.x, option.y, option.z));
      }
      assert.ok(offers >= 2, `${planet.id}/${base.id}: a threatened command needs another usable approach`);
    }
  }
});

test('a Vesper bridge lip that drops an idle player is rejected as reinforcement support', () => {
  const world = new World(1337), layout = campaignLayout(world), city = world.collectCities().find(c => c.theme === 'vesper')!;
  const planner = new ReinforcementPlanner(world, layout.territories);
  const lip = { x: city.x - 362.2576396401455, y: city.y + .08, z: city.z - 1091 };
  assert.ok(capsuleClearance(world, lip.x, lip.y, lip.z) >= -.02 && world.sdf(lip.x, lip.y - .2, lip.z) <= 0,
    'the former center-only check incorrectly accepted this location');
  assert.equal(planner.supported(lip), false, 'a supported center is insufficient when the standing footprint overhangs the deck');
});
