import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TICK_RATE } from '@shared/constants';
import type { Faction, Territory } from '@shared/frontier';
import { Game, ServerPlayer } from '../src/game.js';
import { REINFORCEMENT_ENEMY_DISTANCE, REINFORCEMENT_QUIET_SECONDS, REINFORCEMENT_ZONE_GAP } from '../src/reinforcements.js';
import { capturePlayer, restorePlayer } from '../src/persistence.js';

type GameInternals = { kill(v: ServerPlayer, a: ServerPlayer, w: number): void; updateRespawnsAndRegen(): void };
function owner(site: Territory, faction: Faction) {
  Object.assign(site, { owner: faction, captureFaction: faction, captureProgress: faction ? 1 : 0, influence: faction === 1 ? -1 : faction ? 1 : 0, contested: false });
}
function fixture() {
  const game = new Game(1337, { frontier: true }), p = game.addPlayer('Defender', null);
  p.faction = 1; const f = game.frontier!, base = f.bases[0], controls = f.territories.filter(t => t.baseId === base.id);
  for (const site of controls) owner(site, 1);
  f.step([], game.tick, 0);
  return { game, p, f, base, controls, internals: game as unknown as GameInternals };
}
function threat(game: Game, site: Territory, id: number) {
  const p = new ServerPlayer(id, 'Attacker', null, true, site); p.faction = 2;
  game.players.set(id, p); return p;
}
function respawn(game: Game, p: ServerPlayer, internals: GameInternals) {
  internals.kill(p, p, 255); game.tick = p.respawnAtTick; internals.updateRespawnsAndRegen();
}

test('G advertises partial and secured bases while alive, and choosing a base only changes the saved preference', () => {
  const { game, p, f, base, controls } = fixture();
  owner(controls[1], 0); owner(controls[2], 0); f.step([], game.tick, 0);
  let state = f.snapshot(p, game.players.values(), game.tick);
  const partial = state.reinforcements!.options.find(o => o.id === base.id)!;
  assert.equal(partial.available, false); assert.match(partial.reason!, /1\/3.*Capture 1 more/);
  assert.equal(game.requestRespawn(p, base.id), false); assert.equal(state.respawn, undefined);
  owner(controls[1], 1); f.step([], game.tick, 0);
  state = f.snapshot(p, game.players.values(), game.tick);
  assert.equal(state.reinforcements!.options.find(o => o.id === base.id)!.available, true);
  const before = { ...p.state }, health = p.health;
  assert.equal(game.requestRespawn(p, base.id), true);
  assert.deepEqual(p.state, before); assert.equal(p.health, health);
  const returning = game.addPlayer('Returning', null); restorePlayer(game, returning, capturePlayer(game, p));
  assert.equal(returning.preferredSpawnId, base.id);
});

test('attacked controls stop reinforcements before neutralization and keep the blocked preference through a safe fallback', () => {
  const { game, p, f, base, controls, internals } = fixture();
  assert.ok(game.requestRespawn(p, base.id));
  const enemies = controls.map((site, i) => threat(game, site, 100 + i));
  f.step(game.players.values(), game.tick, .2);
  assert.equal(base.owner, 1, 'the attackers have not neutralized the base');
  assert.ok(controls.every(t => t.owner === 1));
  const blocked = f.snapshot(p, game.players.values(), game.tick).reinforcements!;
  assert.equal(blocked.selected, base.id); assert.equal(blocked.options.find(o => o.id === base.id)!.available, false);
  assert.match(blocked.options.find(o => o.id === base.id)!.reason!, /Under attack/);
  assert.ok(!f.spawnOptions(p, game.tick).some(o => o.id === base.id));
  respawn(game, p, internals); assert.ok(p.state.alive); assert.equal(p.preferredSpawnId, base.id);
  for (const enemy of enemies) assert.ok(Math.hypot(p.state.px - enemy.state.px, p.state.pz - enemy.state.pz) >= REINFORCEMENT_ENEMY_DISTANCE);
  for (const site of f.territories) assert.ok(Math.hypot(p.state.px - site.x, p.state.pz - site.z) >= site.radius + REINFORCEMENT_ZONE_GAP);
  for (const enemy of enemies) enemy.state.alive = false;
  f.step(game.players.values(), game.tick, .2);
  assert.ok(!f.spawnOptions(p, game.tick).some(o => o.id === base.id), 'clearing the enemy does not instantly reopen the rally');
  game.tick += REINFORCEMENT_QUIET_SECONDS * TICK_RATE + 1; f.step(game.players.values(), game.tick, .2);
  assert.ok(f.spawnOptions(p, game.tick).some(o => o.id === base.id));
  const anchor = f.spawnOptions(p, game.tick).find(o => o.id === base.id)!;
  respawn(game, p, internals);
  assert.ok(Math.hypot(p.state.px - anchor.x, p.state.pz - anchor.z) < 20, 'the remembered base is reused when its approach is quiet');
});

test('one attacked control leaves a quiet approach available and every actual respawn stays out of capture rings', () => {
  const { game, p, f, base, controls, internals } = fixture();
  const enemy = threat(game, controls[0], 100); f.step(game.players.values(), game.tick, .2);
  const option = f.spawnOptions(p, game.tick).find(o => o.id === base.id)!;
  assert.ok(option); assert.notEqual(option.controlId, controls[0].id);
  assert.ok(game.requestRespawn(p, base.id));
  for (let i = 0; i < 8; i++) {
    respawn(game, p, internals);
    assert.ok(p.state.alive);
    assert.ok(Math.hypot(p.state.px - enemy.state.px, p.state.pz - enemy.state.pz) >= REINFORCEMENT_ENEMY_DISTANCE);
    for (const site of f.territories) assert.ok(Math.hypot(p.state.px - site.x, p.state.pz - site.z) >= site.radius + REINFORCEMENT_ZONE_GAP);
    assert.ok(f.reinforcementPlanner.supported({ x: p.state.px, y: p.state.py, z: p.state.pz }));
  }
});

test('recent fighting blocks a rally for twelve seconds even after nearby enemies are gone', () => {
  const { game, p, f, base } = fixture(), anchor = f.spawnOptions(p).find(o => o.id === base.id)!;
  assert.ok(f.reinforcementPlanner.safe(p, anchor, [p], game.tick));
  f.recordCombat(anchor.x, anchor.z, [1, 2], game.tick);
  assert.equal(f.reinforcementPlanner.safe(p, anchor, [p], game.tick), false);
  assert.ok(f.reinforcementPlanner.safe(p, anchor, [p], game.tick + REINFORCEMENT_QUIET_SECONDS * TICK_RATE));
});

test('an unavailable deployment never falls back onto an occupied flag', () => {
  const { game, p, f, internals } = fixture();
  internals.kill(p, p, 255); game.tick = p.respawnAtTick;
  f.spawnOptions = () => [];
  const position = [p.state.px, p.state.py, p.state.pz];
  internals.updateRespawnsAndRegen();
  assert.equal(p.state.alive, false); assert.equal(p.health, 0);
  assert.deepEqual([p.state.px, p.state.py, p.state.pz], position);
  assert.equal(p.respawnAtTick, game.tick + TICK_RATE, 'availability is retried without creating a vulnerable living actor');
});
