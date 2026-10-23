import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAPTURE_SECONDS, PLANET_CAMPAIGN_REWARD } from '@shared/frontier';
import { PLANETS } from '@shared/universe';
import { Game } from '../src/game.js';
import { capturePlayer, restorePlayer } from '../src/persistence.js';

test('conquest contracts reward participating humans once on each planet and survive travel', () => {
  let saved: ReturnType<typeof capturePlayer> | undefined;
  for (const planet of PLANETS) {
    const game = new Game(planet.seed, { frontier: true });
    const player = game.addPlayer('Expedition leader', null);
    if (saved) restorePlayer(game, player, { ...saved, seed: planet.seed, arrival: true });
    player.faction = 1;
    const controls = game.frontier!.territories.filter(t => t.baseId === 'base-city-0');
    const baseline = player.salvage;
    // Discovery credit is independent of the conquest reward being checked.
    for (const city of game.world.collectCities()) player.discoveries.add(`${planet.seed}:city-${city.id}`);
    for (const site of controls) {
      Object.assign(site, { owner: 0, influence: 0, captureFaction: 0, captureProgress: 0 });
      Object.assign(player.state, { px: site.x, py: site.y, pz: site.z, alive: true, vehicle: 0 });
      game.frontier!.step([player], game.tick, CAPTURE_SECONDS + .01);
    }
    assert.equal(player.salvage - baseline, PLANET_CAMPAIGN_REWARD);
    assert.ok(player.campaignRewards.includes(planet.seed));
    assert.equal(player.salvageEarned, 0, 'conquests never forge resource-ledger watermarks');
    assert.deepEqual(game.frontier!.snapshot(player, [], 0).you.campaignRewards, player.campaignRewards);
    saved = capturePlayer(game, player);
    const restored = game.addPlayer('Restored leader', null);
    restorePlayer(game, restored, saved);
    assert.deepEqual(restored.campaignRewards, player.campaignRewards);
    assert.equal(restored.salvage, player.salvage);
  }
  assert.deepEqual(saved!.campaignRewards, PLANETS.map(planet => planet.seed));
});

test('spectators and bots do not receive the human conquest contract', () => {
  const game = new Game(1337, { frontier: true });
  const bot = game.addPlayer('Attacker', null, true), spectator = game.addPlayer('Observer', null);
  bot.faction = spectator.faction = 1;
  const site = game.frontier!.territories[0];
  Object.assign(site, { owner: 0, influence: 0, captureFaction: 0, captureProgress: 0 });
  Object.assign(bot.state, { px: site.x, py: site.y, pz: site.z, vehicle: 0 });
  Object.assign(spectator.state, { px: site.x + 500, py: site.y, pz: site.z });
  game.frontier!.step([bot, spectator], 0, CAPTURE_SECONDS * 5 + .01);
  assert.equal(site.owner, 1);
  assert.deepEqual(bot.campaignRewards, []);
  assert.deepEqual(spectator.campaignRewards, []);
});
