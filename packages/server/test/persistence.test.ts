import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { capturePlayer, restorePlayer } from '../src/persistence.js';
import { PLAYER, TICK_RATE } from '@shared/constants';

test('all legacy Independent saves migrate to the login faction without losing health, position or inventory', () => {
  const game = new Game(1337), original = game.addPlayer('Original', null);
  Object.assign(original.state, { px: 30, py: 400, pz: 40 }); original.health = 67; original.salvage = 123;
  original.ammo[1].magazine = 7; original.ammo[1].reserve = 29;
  const saved = capturePlayer(game, original);
  for (const factionAssigned of [undefined, false, true]) {
    const returning = game.addPlayer('Returning', null); returning.faction = 2;
    restorePlayer(game, returning, { ...saved, faction: 0, factionAssigned });
    assert.equal(returning.faction, 2); assert.equal(returning.health, 67); assert.equal(returning.salvage, 123);
    assert.deepEqual([returning.state.px, returning.state.py, returning.state.pz], [30, 400, 40]);
    assert.deepEqual(returning.ammo[1], { magazine: 7, reserve: 29 });
  }
  const noPriorAssignment = game.addPlayer('Fallback', null); noPriorAssignment.faction = 0;
  restorePlayer(game, noPriorAssignment, { ...saved, faction: 0, factionAssigned: true });
  assert.ok([1, 2, 3].includes(noPriorAssignment.faction));
  for (const faction of [1, 2, 3]) {
    restorePlayer(game, noPriorAssignment, { ...saved, faction });
    assert.equal(noPriorAssignment.faction, faction, 'each fighting faction survives a version-one save');
  }
});

test('respawn preference survives login and a dead save receives the full selection window', () => {
  const game = new Game(1337), original = game.addPlayer('Original', null); original.faction = 1;
  original.preferredSpawnId = 'base-city-2'; original.state.alive = false; original.health = 0;
  const saved = capturePlayer(game, original); assert.equal(saved.version, 1); assert.equal(saved.preferredSpawnId, 'base-city-2');
  game.tick = 1200; const returning = game.addPlayer('Returning', null);
  restorePlayer(game, returning, saved);
  assert.equal(returning.preferredSpawnId, original.preferredSpawnId); assert.equal(returning.state.alive, false);
  assert.equal(returning.respawnAtTick, game.tick + PLAYER.RESPAWN_SECONDS * TICK_RATE);
  assert.equal(PLAYER.RESPAWN_SECONDS, 10);
  restorePlayer(game, returning, { ...saved, preferredSpawnId: '../invalid base' }); assert.equal(returning.preferredSpawnId, '');
  restorePlayer(game, returning, { ...saved, arrival: true }); assert.equal(returning.preferredSpawnId, '', 'another planet starts with its own spawn choices');
});
