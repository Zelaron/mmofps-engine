import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { namespaceRange, MAX_LEGACY_ENTITY_ID } from '@shared/entity-id';

test('admission honors stable character IDs, separates authority bots and rejects duplicate actors', () => {
  const game = new Game(1337, { entityNamespace: 7 });
  (game as unknown as { pickSpawn: () => { x: number; y: number; z: number } }).pickSpawn = () => ({ x: 0, y: 100, z: 0 });
  const human = game.addPlayer('Explorer', null, false, 100_000);
  const bot = game.addPlayer('Ally', null, true);
  assert.equal(human.id, 100_000); assert.equal(bot.id, namespaceRange(7).first);
  for (const id of [human.id, bot.id, 0, -1, 0xffffffff, 1.1]) assert.throws(() => game.addPlayer('Duplicate', null, false, id));
  assert.equal(game.players.size, 2); assert.equal(game.players.get(human.id), human);
  game.removePlayer(human.id);
  assert.equal(game.addPlayer('Returning explorer', null, false, human.id).id, human.id);
});

test('long-lived standalone allocation wraps without replacing the first player', () => {
  const game = new Game(1337); (game as unknown as { pickSpawn: () => { x: number; y: number; z: number } }).pickSpawn = () => ({ x: 0, y: 100, z: 0 });
  const first = game.addPlayer('First', null);
  (game as unknown as { nextPlayerId: number }).nextPlayerId = MAX_LEGACY_ENTITY_ID;
  assert.equal(game.addPlayer('Last ID', null).id, MAX_LEGACY_ENTITY_ID);
  assert.equal(game.addPlayer('After wrap', null).id, 2);
  assert.equal(game.players.get(first.id), first);
});
