import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Game, type ServerPlayer } from '../src/game.js';
import { WorldStore, capturePlayer, restorePlayer } from '../src/persistence.js';
import { SpatialIndex } from '../src/spatial-index.js';
import { TICK_RATE } from '@shared/constants';
import { ByteReader, decodeSnapshot, BTN, Msg } from '@shared/index';
import { decodeFrontierState, encodeFrontierState } from '@shared/frontier-wire';

test('neutral explorers and allies are protected; hostile combat and self damage remain', () => {
  const game = new Game(1337, { frontier: true });
  const explorer = game.addPlayer('Explorer', null), a = game.addPlayer('Accord', null), b = game.addPlayer('Helix', null);
  a.faction = 1; b.faction = 2;
  const damage = (victim: ServerPlayer, attacker: ServerPlayer) => (game as unknown as { damage(v: ServerPlayer, n: number, a: ServerPlayer, w: number, x: number, y: number, z: number): void }).damage(victim, 20, attacker, 1, 3, 5, 0);
  assert.equal(game.areEnemies(a, explorer), false);
  damage(explorer, a); damage(a, explorer);
  assert.equal(explorer.health, 100); assert.equal(a.health, 100); assert.equal(explorer.state.vy, 0);
  damage(b, a); assert.equal(b.health, 80);
  b.faction = 1; damage(b, a); assert.equal(b.health, 80);
  damage(a, a); assert.equal(a.health, 80);
});

test('territory capture needs presence; neutral players do not contest; human presence is five times a bot', () => {
  const game = new Game(1337, { frontier: true }), frontier = game.frontier!;
  const player = game.addPlayer('Scout', null), neutral = game.addPlayer('Explorer', null), bot = game.addPlayer('Bot', null, true);
  const site = frontier.territories[1]; site.owner = 0; site.influence = 0;
  for (const p of [player, neutral, bot]) { p.state.px = site.x; p.state.py = site.y; p.state.pz = site.z; }
  player.faction = 1; bot.faction = 2;
  frontier.step([player, neutral, bot], 0, 10); assert.equal(site.influence, 0); assert.equal(site.contested, true);
  frontier.step([player, neutral], 0, 7); assert.ok(Math.abs(site.influence + .2) < 1e-9);
  site.influence = 0;
  frontier.step([bot, neutral], 0, 7); assert.ok(Math.abs(site.influence - .04) < 1e-9);
  frontier.step([player, neutral], 0, 40); assert.equal(site.owner, 1);
  player.state.py += 20;
  const before = site.influence; frontier.step([player], 0, 20); assert.equal(site.influence, before);
});

test('standing down is refused during combat and the allegiance cooldown', () => {
  const game = new Game(1337, { frontier: true }), player = game.addPlayer('Pilot', null);
  assert.equal(game.frontier!.enlist(player, 1, 0), null);
  assert.ok(game.frontier!.enlist(player, 0, 1));
  player.regenBlockUntil = 90 * TICK_RATE;
  assert.ok(game.frontier!.enlist(player, 0, 40 * TICK_RATE));
  assert.equal(game.frontier!.enlist(player, 0, 91 * TICK_RATE), null);
});

test('strategic messages carry full city names and territory lists beyond legacy chat limits', () => {
  const game = new Game(1337, { frontier: true }), p = game.addPlayer('Scout', null);
  const state = game.frontier!.snapshot(p, game.players.values(), 0), bytes = encodeFrontierState(state);
  assert.ok(bytes.length > 1000);
  assert.deepEqual(decodeFrontierState(bytes.buffer as ArrayBuffer), state);
});

test('world and individual progress survive a fresh store without rewriting every player', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-store-'));
  try {
    const game = new Game(1337, { frontier: true }), p = game.addPlayer('Explorer', null), key = 'a'.repeat(64);
    p.faction = 2; p.salvage = 137; p.health = 63; p.discoveries.add('city-2'); p.ammo[1].magazine = 7;
    game.frontier!.territories[1].owner = 2; game.frontier!.territories[1].influence = 1;
    const store = new WorldStore(root);
    await Promise.all([store.savePlayer(key, capturePlayer(game, p)), store.saveWorld(game.frontier!.save())]);
    const next = new WorldStore(root), game2 = new Game(1337, { frontier: true }), p2 = game2.addPlayer('Returning', null);
    restorePlayer(game2, p2, await next.loadPlayer(key)); game2.frontier!.restore(await next.loadWorld());
    assert.equal(p2.faction, 2); assert.equal(p2.salvage, 137); assert.equal(p2.health, 63); assert.equal(p2.ammo[1].magazine, 7);
    assert.ok(p2.discoveries.has('1337:city-2')); assert.equal(game2.frontier!.territories[1].owner, 2);
    await Promise.all([store.savePlayer(key, { ...capturePlayer(game, p), salvage: 20 }), store.savePlayer(key, { ...capturePlayer(game, p), salvage: 40 })]);
    assert.equal((await next.loadPlayer(key) as { salvage: number }).salvage, 40);
  } finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('the-mmofps-store-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('spatial queries ignore distant populations and handle negative coordinates and reuse', () => {
  const index = new SpatialIndex<number>(256);
  for (let i = 0; i < 100_000; i++) index.insert(i, (i % 1000) * 400, Math.floor(i / 1000) * 400);
  assert.deepEqual([...index.query(0, 0, 30)], [0]);
  index.insert(-1, -40, -40); assert.ok([...index.query(-40, -40, 1)].includes(-1));
  index.clear(); index.compact(); assert.equal([...index.query(0, 0, 1000)].length, 0);
});

test('replication still sends nearby players and owned distant artillery', () => {
  const packets: Uint8Array[] = [], game = new Game(1337);
  const local = game.addPlayer('Local', { send: b => packets.push(b) }), near = game.addPlayer('Near', null), distant = game.addPlayer('Distant', null);
  near.state.px = local.state.px + 10; near.state.py = local.state.py; near.state.pz = local.state.pz;
  distant.state.px = local.state.px + 2000;
  game.projectiles.set(5000, { id: 5000, owner: local.id, weapon: 213, x: local.state.px + 3000, y: 200, z: local.state.pz,
    vx: 0, vy: 0, vz: 0, distLeft: 10000, fuseLeft: 120, ageSeconds: 0, sleeping: false });
  game.step(); game.step();
  const bytes = packets.find(b => b[0] === Msg.SSnapshot)!;
  const reader = new ByteReader(bytes); reader.u8(); const snapshot = decodeSnapshot(reader);
  assert.ok(snapshot.ents.some(e => e.id === near.id)); assert.ok(!snapshot.ents.some(e => e.id === distant.id));
  assert.ok(snapshot.ents.some(e => e.id === 5000));
});

test('live frontier stops repeated movement after input has gone stale', () => {
  const game = new Game(1337, { frontier: true }), p = game.addPlayer('Idle tab', null);
  game.queueInput(p, { seq: 1, buttons: BTN.FORWARD, weapon: 1, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 });
  for (let i = 0; i < 75; i++) game.step();
  assert.ok(Math.hypot(p.state.vx, p.state.vz) < .05);
});
