import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteReader, Msg, decodeDeath } from '@shared/protocol';
import { TICK_RATE } from '@shared/constants';
import { Game, type ServerPlayer } from '../src/game.js';
import { capturePlayer, restorePlayer } from '../src/persistence.js';

type Internals = {
  events: { bytes: Uint8Array }[];
  damage(v: ServerPlayer, amount: number, a: ServerPlayer, weapon: number, kx: number, ky: number, kz: number): void;
  updateRespawnsAndRegen(): void;
};

test('lethal damage transmits the blast impulse and retains the death marker after respawn and login', () => {
  const game = new Game(1337, { frontier: true }), internals = game as unknown as Internals;
  const victim = game.addPlayer('Victim', null), attacker = game.addPlayer('Attacker', null);
  victim.faction = 1; attacker.faction = 2; victim.spawnProtectedUntil = -1;
  Object.assign(victim.state, { px: 100, py: 400, pz: 200, vx: 3, vy: 0, vz: -2 });
  internals.damage(victim, 150, attacker, 3, 18, 14, 8);
  const bytes = internals.events.find(e => e.bytes[0] === Msg.SDeath)!.bytes;
  const reader = new ByteReader(bytes); reader.u8(); const death = decodeDeath(reader);
  assert.deepEqual(death.motion, { x: 100, y: 400, z: 200, vx: 21, vy: 14, vz: 6, yaw: 0 });
  assert.equal(victim.state.vx, 0, 'the corpse event preserves motion before the dead actor is stopped');
  assert.deepEqual(game.frontier!.snapshot(victim, [], game.tick).death, { x: 100, y: 400, z: 200 });
  game.tick = victim.respawnAtTick; internals.updateRespawnsAndRegen();
  assert.ok(victim.state.alive); assert.deepEqual(victim.lastDeath, { x: 100, y: 400, z: 200 });
  const saved = capturePlayer(game, victim), returning = game.addPlayer('Returning', null);
  restorePlayer(game, returning, saved); assert.deepEqual(returning.lastDeath, victim.lastDeath);
  restorePlayer(game, returning, { ...saved, arrival: true }); assert.equal(returning.lastDeath, undefined);
  restorePlayer(game, returning, { ...saved, lastDeath: { x: NaN, y: 0, z: 0 } }); assert.equal(returning.lastDeath, undefined);
});

test('enemy combat produces fading map reports while friendly fire and spawn protection do not', () => {
  const game = new Game(1337, { frontier: true }), internals = game as unknown as Internals, f = game.frontier!;
  const victim = game.addPlayer('Victim', null), attacker = game.addPlayer('Attacker', null);
  victim.faction = 1; attacker.faction = 1; victim.spawnProtectedUntil = -1;
  Object.assign(victim.state, { px: 300, py: 400, pz: 300 });
  internals.damage(victim, 2, attacker, 1, 0, 0, 0); assert.equal(f.battleReports(game.tick).length, 0);
  attacker.faction = 3; victim.spawnProtectedUntil = game.tick + 100;
  internals.damage(victim, 2, attacker, 1, 0, 0, 0); assert.equal(f.battleReports(game.tick).length, 0);
  victim.spawnProtectedUntil = -1;
  for (let i = 0; i < 12; i++) internals.damage(victim, 2, attacker, 1, 0, 0, 0);
  const report = f.battleReports(game.tick)[0];
  assert.deepEqual(report.factions, [1, 3]); assert.equal(report.intensity, 1);
  assert.notEqual(report.x, victim.state.px, 'reports locate a battle area rather than expose individual players');
  assert.equal(f.battleReports(game.tick + 15 * TICK_RATE)[0].intensity, .5);
  assert.equal(f.battleReports(game.tick + 30 * TICK_RATE).length, 0);
  for (let i = 0; i < 100; i++) f.recordCombat(i * 256, 0, [1, 2], game.tick);
  assert.equal(f.battleReports(game.tick).length, 12, 'map traffic remains bounded during widespread combat');
});
