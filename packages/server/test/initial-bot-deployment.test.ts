import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerPlayer } from '../src/game.js';
import { PLAYER, TICK_RATE } from '@shared/constants';
import type { CampaignBase, Territory } from '@shared/frontier';

/** Real director, reinforcement planner and Game spawn path on a controlled
 * flat field. Equal-value fronts make the temporary Meridian position's
 * influence distinguishable from the faction's distant home and supply. */
function twoFrontCampaign(): Game {
  const game = new Game(1337, { frontier: true }), frontier = game.frontier!;
  game.world.groundY = () => 0;
  game.world.column = () => ({ h: 0 } as ReturnType<typeof game.world.column>);
  game.world.sdf = (_x, y) => y;
  game.world.liquidAt = () => undefined;
  game.world.collectCities = () => [];
  const bases: CampaignBase[] = [
    { id: 'meridian', name: 'Meridian', kind: 'city', x: -2048, z: 2048, owner: 2, homeFaction: 0 },
    { id: 'near-supply', name: 'Near supply', kind: 'outpost', x: -2548, z: 2048, owner: 1, homeFaction: 0 },
    { id: 'far-home', name: 'Far home', kind: 'outpost', x: 6000, z: 4096, owner: 1, homeFaction: 1 },
    { id: 'far-target', name: 'Far city', kind: 'city', x: 6500, z: 4096, owner: 2, homeFaction: 0 },
  ].map(base => ({ ...base, y: .08, requiredPoints: 2,
    controlIds: [0, 1, 2].map(i => `${base.id}-${i}`) })) as CampaignBase[];
  const controls: Territory[] = bases.flatMap(base => base.controlIds.map((id, i) => ({
    id, name: id, baseId: base.id, kind: 'city' as const,
    x: base.x, y: 0, z: base.z + 200 + i * 150, radius: 30,
    owner: base.owner, influence: 1, contested: false,
    captureFaction: base.owner, captureProgress: 1,
  })));
  // Both planners retain these arrays, so replace their contents, not the fields.
  frontier.bases.splice(0, frontier.bases.length, ...bases);
  frontier.territories.splice(0, frontier.territories.length, ...controls);
  const internals = frontier as unknown as { reserves: Map<number, unknown>; director: { reset(): void } };
  internals.reserves.clear(); internals.director.reset();
  return game;
}

function observeInitialPlacement(game: Game) {
  const seen: { alive: boolean; faction: number; ordinal?: number; registered: boolean; x: number; z: number }[] = [];
  const frontier = game.frontier!, original = frontier.spawnOptions;
  frontier.spawnOptions = function (player, tick) {
    seen.push({ alive: player.state.alive, faction: player.faction, ordinal: player.botRosterIndex,
      registered: game.players.get(player.id) === player, x: player.state.px, z: player.state.pz });
    return original.call(this, player, tick);
  };
  return seen;
}

test('an unplaced campaign bot does not select Meridian because of its temporary first-base position', () => {
  const game = twoFrontCampaign(), seen = observeInitialPlacement(game);
  const player = game.addPlayer('New soldier', null, true), frontier = game.frontier!;
  assert.deepEqual(seen, [{ alive: false, faction: 1, ordinal: 0, registered: true, x: -2048, z: 2048 }]);
  assert.equal(frontier.order(player)?.baseId, 'far-target', 'the squad uses its home-side front, not placeholder presence');
  assert.ok(Math.hypot(player.state.px - 6000, player.state.pz - 4096) <= 17, 'deploy at the safe owned supply near that order');
  assert.equal(player.state.alive, true); assert.equal(player.health, PLAYER.MAX_HEALTH); assert.equal(player.respawnAtTick, -1);
  const point = { x: player.state.px, y: player.state.py, z: player.state.pz };
  assert.equal(frontier.reinforcementPlanner.supported(point), true);
  assert.equal(frontier.reinforcementPlanner.outsideControls(point), true);
});

test('native-terrain admissions assign faction and ordinal before placement and restore life before crew staging', () => {
  const game = new Game(1337, { frontier: true }), seen = observeInitialPlacement(game);
  const staged: { alive: boolean; ordinal?: number }[] = [];
  const internals = game as unknown as { stageVehicleCrew(player: ServerPlayer): void };
  const stage = internals.stageVehicleCrew;
  internals.stageVehicleCrew = function (player) {
    staged.push({ alive: player.state.alive, ordinal: player.botRosterIndex });
    stage.call(game, player);
  };
  for (let i = 0; i < 6; i++) {
    const player = game.addPlayer(`Soldier ${i}`, null, true);
    assert.equal(player.botRosterIndex, i); assert.equal(player.faction, i % 3 + 1);
    assert.equal(seen[i].alive, false); assert.equal(seen[i].registered, true);
    assert.equal(seen[i].ordinal, i); assert.equal(seen[i].faction, i % 3 + 1);
    assert.equal(player.state.alive, true); assert.equal(player.health, PLAYER.MAX_HEALTH);
    assert.deepEqual(staged[i], { alive: true, ordinal: i });
  }
});

test('blocked bot placement retains the one-second retry and later respawns through normal selection', () => {
  const game = twoFrontCampaign(), frontier = game.frontier!, native = frontier.spawnOptions;
  const retry = () => (game as unknown as { updateRespawnsAndRegen(): void }).updateRespawnsAndRegen();
  game.tick = 37; frontier.spawnOptions = () => [];
  const player = game.addPlayer('Waiting soldier', null, true);
  assert.equal(player.state.alive, false); assert.equal(player.health, 0); assert.equal(player.respawnAtTick, 37 + TICK_RATE);
  game.tick = player.respawnAtTick; retry();
  assert.equal(player.state.alive, false); assert.equal(player.respawnAtTick, 37 + 2 * TICK_RATE);
  frontier.spawnOptions = native; game.tick = player.respawnAtTick; retry();
  assert.equal(player.state.alive, true); assert.equal(player.health, PLAYER.MAX_HEALTH); assert.equal(player.respawnAtTick, -1);
  assert.equal(player.faction, 1); assert.equal(player.botRosterIndex, 0);
  assert.equal(frontier.order(player)?.baseId, 'far-target');
});

test('human campaign and arena bot admissions retain their ordinary living spawn behavior', () => {
  const game = twoFrontCampaign(), seen = observeInitialPlacement(game);
  const human = game.addPlayer('Explorer', null);
  assert.equal(seen[0].alive, true); assert.equal(seen[0].registered, true);
  assert.equal(human.botRosterIndex, undefined); assert.ok(human.faction >= 1 && human.faction <= 3);
  assert.equal(human.state.alive, true); assert.equal(human.health, PLAYER.MAX_HEALTH); assert.equal(human.respawnAtTick, -1);
  const point = { x: human.state.px, y: human.state.py, z: human.state.pz };
  assert.equal(game.frontier!.reinforcementPlanner.supported(point), true);
  assert.equal(game.frontier!.reinforcementPlanner.outsideControls(point), true);
  const arena = new Game(1337); arena.world.findSpawn = () => ({ x: 8, y: 3, z: 4 });
  const bot = arena.addPlayer('Arena bot', null, true);
  assert.equal(bot.state.alive, true); assert.equal(bot.botRosterIndex, undefined); assert.equal(bot.faction, 0);
  assert.deepEqual([bot.state.px, bot.state.py, bot.state.pz], [8, 3, 4]);
  assert.equal(bot.health, PLAYER.MAX_HEALTH); assert.equal(bot.respawnAtTick, -1);
});
