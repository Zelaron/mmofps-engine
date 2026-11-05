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
import { BOT_CAPTURE_WEIGHT, CAPTURE_SECONDS, inCaptureRange } from '@shared/frontier';
import { PLANETS } from '@shared/universe';
import { capsuleClearance } from '@shared/physics';

function damage(game: Game, victim: ServerPlayer, attacker: ServerPlayer): void {
  victim.spawnProtectedUntil = -1;
  (game as unknown as { damage(v: ServerPlayer, n: number, a: ServerPlayer, w: number, x: number, y: number, z: number): void })
    .damage(victim, 20, attacker, 1, 3, 5, 0);
}

test('new arrivals join either combat faction and exchange damage with enemy bots without enlisting', () => {
  const game = new Game(1337, { frontier: true });
  const bots = ['Accord', 'Helix', 'Vanguard'].map(name => game.addPlayer(name, null, true));
  const factions = new Set<number>();
  for (let i = 0; i < 24; i++) {
    const player = game.addPlayer(`Arrival ${i}`, null);
    assert.ok(player.faction >= 1 && player.faction <= 3);
    factions.add(player.faction);
    const enemy = bots.find(bot => bot.faction !== player.faction)!;
    const ally = bots.find(bot => bot.faction === player.faction)!;
    enemy.health = ally.health = 100;
    assert.equal(game.areEnemies(enemy, player), true, 'enemy AI can acquire the new arrival');
    damage(game, enemy, player); damage(game, player, enemy);
    assert.equal(enemy.health, 80); assert.equal(player.health, 80);
    damage(game, ally, player); damage(game, player, ally);
    assert.equal(ally.health, 100); assert.equal(player.health, 80);
    const state = game.frontier!.snapshot(player, game.players.values(), game.tick);
    assert.equal(state.you.faction, player.faction, 'the initial HUD receives the assigned allegiance');
  }
  assert.deepEqual(factions, new Set([1, 2, 3]));
});

test('old neutral saves receive a combat faction once and retain their progress', () => {
  const game = new Game(1337, { frontier: true }), old = game.addPlayer('Old explorer', null);
  old.faction = 0; old.salvage = 137; old.health = 63; old.ammo[1].magazine = 7;
  old.discoveries.add('1337:city-2');
  const saved = capturePlayer(game, old); delete saved.factionAssigned;
  const returning = game.addPlayer('Returning', null), assigned = returning.faction;
  restorePlayer(game, returning, saved);
  assert.ok(assigned >= 1 && assigned <= 3); assert.equal(returning.faction, assigned);
  assert.equal(returning.salvage, 137); assert.equal(returning.health, 63); assert.equal(returning.ammo[1].magazine, 7);
  assert.deepEqual(returning.discoveries, old.discoveries);
  assert.deepEqual([returning.state.px, returning.state.py, returning.state.pz], [old.state.px, old.state.py, old.state.pz]);
  const nextSave = capturePlayer(game, returning), next = game.addPlayer('Next login', null);
  next.faction = assigned === 1 ? 2 : 1;
  restorePlayer(game, next, nextSave);
  assert.equal(next.faction, assigned, 'reconnect keeps the assigned faction');
  for (const faction of [1, 2, 3] as const) {
    restorePlayer(game, next, { ...saved, faction });
    assert.equal(next.faction, faction, 'legacy combat allegiance is preserved too');
  }
});

test('players cannot enlist as unclaimed and all three combat allegiances persist', () => {
  const game = new Game(1337, { frontier: true }), player = game.addPlayer('Soldier', null);
  const original = player.faction;
  assert.ok(game.frontier!.enlist(player, 0, game.tick)); assert.equal(player.faction, original);
  for (const faction of [1, 2, 3] as const) {
    player.faction = faction;
    const saved = capturePlayer(game, player), returning = game.addPlayer('Returning', null);
    restorePlayer(game, returning, saved); assert.equal(returning.faction, faction);
    const destination = new Game(7331, { frontier: true }), arriving = destination.addPlayer('Arriving', null);
    restorePlayer(destination, arriving, { ...saved, seed: destination.seed, arrival: true });
    assert.equal(arriving.faction, faction);
  }
});

test('all three opposing factions exchange damage while allies remain protected', () => {
  const game = new Game(1337, { frontier: true });
  const actors = [1, 2, 3].map((faction, i) => { const p = game.addPlayer(`Soldier ${i}`, null); p.faction = faction as 1 | 2 | 3; return p; });
  for (const a of actors) for (const b of actors) if (a !== b) {
    b.health = 100; assert.equal(game.areEnemies(a, b), true); damage(game, b, a); assert.equal(b.health, 80);
  }
  actors[1].faction = actors[0].faction; actors[1].health = 100;
  damage(game, actors[1], actors[0]); assert.equal(actors[1].health, 100);
  actors[0].health = 100; damage(game, actors[0], actors[0]); assert.equal(actors[0].health, 80);
});

test('territory capture needs presence; neutral players do not contest; a human outweighs four bots', () => {
  const game = new Game(1337, { frontier: true }), frontier = game.frontier!;
  const player = game.addPlayer('Scout', null), neutral = game.addPlayer('Explorer', null), bot = game.addPlayer('Bot', null, true);
  const site = frontier.territories[1]; site.owner = 0; site.influence = 0;
  for (const p of [player, neutral, bot]) { p.state.px = site.x; p.state.py = site.y; p.state.pz = site.z; }
  player.faction = 1; neutral.faction = 0; bot.faction = 2;
  // Majority capture: the contested ring still advances for the side with the
  // clearly larger capture weight, at the rate of its margin.
  frontier.step([player, neutral, bot], 0, 10); assert.equal(site.contested, true);
  assert.ok(Math.abs(site.influence + (1 - BOT_CAPTURE_WEIGHT) * 10 / CAPTURE_SECONDS) < 1e-9);
  site.influence = 0;
  frontier.step([player, neutral], 0, CAPTURE_SECONDS * .2); assert.ok(Math.abs(site.influence + .2) < 1e-9);
  site.influence = 0;
  frontier.step([bot, neutral], 0, CAPTURE_SECONDS * .2); assert.ok(Math.abs(site.influence - .2 * BOT_CAPTURE_WEIGHT) < 1e-9);
  frontier.step([player, neutral], 0, CAPTURE_SECONDS * 1.1); assert.equal(site.owner, 1);
  player.state.py += 20;
  const before = site.influence; frontier.step([player], 0, 20); assert.equal(site.influence, before);
});

test('every city and harbor flag is supported, dry, reachable and capturable on all planets', () => {
  for (const { seed } of PLANETS) {
    const game = new Game(seed, { frontier: true }), frontier = game.frontier!, player = game.addPlayer('Captor', null);
    player.faction = 1;
    for (const site of frontier.territories) {
      const label = `${seed}: ${site.id}`;
      assert.ok(capsuleClearance(game.world, site.x, site.y + .02, site.z) >= -.02, `${label}: room to stand`);
      assert.ok(game.world.sdf(site.x, site.y - .12, site.z) <= 0, `${label}: supported floor`);
      assert.equal(game.world.liquidAt(site.x, site.y, site.z), undefined, `${label}: dry flag`);
      Object.assign(player.state, { px: site.x, py: site.y, pz: site.z });
      assert.ok(inCaptureRange(site, player.state.px, player.state.py, player.state.pz));
      site.owner = 0; site.influence = 0;
      frontier.step([player], 0, CAPTURE_SECONDS + .01);
      assert.equal(site.owner, 1, `${label}: standing beside the flag captures it`);
    }
  }
});

test('enemy territory neutralizes, pauses while contested, captures and persists with clear announcements', () => {
  const packets: Uint8Array[] = [], game = new Game(1337, { frontier: true }), frontier = game.frontier!;
  const p = game.addPlayer('Captor', { send: bytes => packets.push(bytes) }), enemy = game.addPlayer('Defender', null);
  p.faction = 1; enemy.faction = 2;
  const site = frontier.territories[1]; site.owner = 2; site.influence = 1; site.captureFaction = 2; site.captureProgress = 1;
  for (const actor of [p, enemy]) Object.assign(actor.state, { px: site.x, py: site.y, pz: site.z });
  frontier.step([p], 0, CAPTURE_SECONDS / 2);
  assert.equal(site.influence, .5); assert.equal(site.owner, 2);
  assert.ok(Math.abs(site.captureRate! + 1 / CAPTURE_SECONDS) < 1e-10);
  frontier.step([p, enemy], 1, 60);
  assert.equal(site.contested, true); assert.equal(site.influence, .5); assert.equal(site.captureRate, 0);
  frontier.step([p], 2, CAPTURE_SECONDS / 2);
  assert.equal(site.owner, 0); assert.equal(site.influence, 0);
  frontier.step([p], 3, CAPTURE_SECONDS / 2);
  assert.equal(site.influence, -.5);
  frontier.step([], 4, 60); assert.equal(site.influence, -.5); assert.equal(site.captureRate, 0);
  frontier.step([p], 5, CAPTURE_SECONDS / 2);
  assert.equal(site.owner, 1); assert.equal(site.influence, -1);
  const messages = packets.filter(bytes => bytes[0] === Msg.SMessage).map(bytes => { const r = new ByteReader(bytes); r.u8(); return r.str(); });
  assert.ok(messages.some(message => message.includes('neutralized')));
  assert.ok(messages.some(message => message.includes('captured')));
  const next = new Game(1337, { frontier: true }); next.frontier!.restore(frontier.save());
  assert.equal(next.frontier!.territories.find(t => t.id === site.id)!.owner, 1);
  assert.equal(next.frontier!.territories.find(t => t.id === site.id)!.influence, -1);
});

test('faction changes are refused during combat and the allegiance cooldown', () => {
  const game = new Game(1337, { frontier: true }), player = game.addPlayer('Pilot', null);
  assert.equal(game.frontier!.enlist(player, player.faction === 1 ? 2 : 1, 0), null);
  assert.ok(game.frontier!.enlist(player, 3, 1));
  player.regenBlockUntil = 90 * TICK_RATE;
  assert.ok(game.frontier!.enlist(player, 3, 40 * TICK_RATE));
  assert.equal(game.frontier!.enlist(player, 3, 91 * TICK_RATE), null);
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
  // A flat city street, so any remaining motion would come from repeated input.
  const street = game.frontier!.bases.find(b => b.id === 'base-city-0')!;
  Object.assign(p.state, { px: street.x, py: street.y, pz: street.z, vx: 0, vy: 0, vz: 0 });
  game.queueInput(p, { seq: 1, buttons: BTN.FORWARD, weapon: 1, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 });
  for (let i = 0; i < 75; i++) game.step();
  assert.ok(Math.hypot(p.state.vx, p.state.vz) < .05);
});
