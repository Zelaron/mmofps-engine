import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  BTN, ByteReader, Msg, CREATURE, CREATURE_DEFS, NUKE_LAUNCHER_ID, NUKE_MARKER,
  PICKUP_AMMO, PICKUP_HEALTH, PICKUP_WEAPON, TANK_CANNON, TICK_RATE,
  VEHICLE, WEAPONS, stepWeaponState, type InputCmd, type PickupKind, type WeaponDef,
} from '@shared/index';
import {
  Game, ServerPlayer, BOSS_CONTRIBUTION_WINDOW_TICKS, BOSS_REWARD_LIFETIME_TICKS,
  BOSS_REWARD_RESERVATION_TICKS, MAX_LIVE_PICKUPS, PICKUP_GRACE_TICKS,
  type ServerPickup,
} from '../src/game.js';
import type { Creature } from '../src/wildlife.js';
import { capturePlayer, restorePlayer } from '../src/persistence.js';
import { OutpostLedger } from '../src/outpost-ledger.js';

interface Internals {
  events: { bytes: Uint8Array; radius?: number }[];
  dropCreatureLoot(creature: Creature, attacker: number): void;
  spawnPickup(kind: PickupKind, weapon: number, victim: ServerPlayer): ServerPickup | null;
  updatePickups(): void;
  broadcast(): void;
  buildSnapshotFor(player: ServerPlayer): Uint8Array;
  fire(player: ServerPlayer, cmd: InputCmd, weapon: number): void;
  explode(x: number, y: number, z: number, owner: ServerPlayer | null, def: WeaponDef,
    directVictimId: number, projectileId: number): void;
}
const internals = (game: Game) => game as unknown as Internals;
const messages = (packets: Uint8Array[]) => packets.filter(bytes => bytes[0] === Msg.SMessage)
  .map(bytes => { const r = new ByteReader(bytes); r.u8(); return r.str(); });

function fixture() {
  const game = new Game(1337);
  game.tick = 10 * TICK_RATE;
  game.world.groundY = () => 0;
  game.world.liquidAt = () => undefined;
  game.world.roofedAbove = () => false;
  game.world.sdf = (_x, y) => y;
  game.world.trace = (x, y, z, dx, dy, dz, max) => {
    const floor = dy < 0 ? -y / dy : Infinity;
    const hit = floor >= 0 && floor <= max, dist = hit ? floor : max;
    return { hit, x: x + dx * dist, y: y + dy * dist, z: z + dz * dist,
      nx: 0, ny: hit ? 1 : 0, nz: 0, dist };
  };
  function player(name: string, isBot = false) {
    const packets: Uint8Array[] = [];
    const p = new ServerPlayer(game.players.size + 1, name, { send: bytes => packets.push(bytes) }, isBot,
      { x: 100, y: 0, z: 0 });
    p.faction = 1; game.players.set(p.id, p);
    return { p, packets };
  }
  const boss = (species = CREATURE.OSSUARY_TITAN as number) => {
    const c = game.wildlife.spawn(species, { x: 0, y: .03, z: 0 });
    assert.ok(c); return c;
  };
  return { game, player, boss };
}

test('boss rewards credit recent human contributors, including dead players, across factions and bot last hits', () => {
  const { game, player, boss } = fixture();
  const alice = player('Alice'), bob = player('Bob'), bystander = player('Bystander'), bot = player('Bot', true);
  const c = boss();
  game.wildlife.damage(c, 1200, alice.p.id, game.tick);
  game.wildlife.damage(c, 300, bob.p.id, game.tick);
  bob.p.state.alive = false; bob.p.health = 0; bob.p.faction = 3;
  assert.equal(game.wildlife.damage(c, c.health + 100_000, bot.p.id, game.tick), true);
  assert.equal(alice.p.salvage, 530);
  assert.equal(bob.p.salvage, 530, 'a death or a faction change does not erase earned participation');
  assert.equal(bystander.p.salvage, 30);
  assert.equal(bot.p.salvage, 30);
  assert.equal(c.damageContributors.get(bot.p.id)?.damage, 10_500, 'overkill does not inflate contribution');
  assert.equal(messages(alice.packets).length, 1);
  assert.match(messages(bob.packets)[0], /\+500 salvage/);
  const announcement = internals(game).events.filter(e => messages([e.bytes])[0]?.startsWith('PLANET BOUNTY:'));
  assert.equal(announcement.length, 1);
  assert.equal(announcement[0].radius, undefined, 'the announcement has planet-wide delivery');
  assert.match(messages([announcement[0].bytes])[0], /Alice and 1 fellow hunter.*2 hunters rewarded/);
  assert.equal(game.pickups.size, 4, 'the party shares one cache instead of multiplying weapon drops');
  assert.ok([...game.pickups.values()].every(p => p.expiresAtTick === game.tick + BOSS_REWARD_LIFETIME_TICKS));

  const before = [...game.pickups.keys()];
  assert.equal(game.wildlife.damage(c, 1000, alice.p.id, game.tick), false);
  internals(game).dropCreatureLoot(c, alice.p.id);
  assert.equal(alice.p.salvage, 530);
  assert.equal(bob.p.salvage, 530);
  assert.deepEqual([...game.pickups.keys()], before, 'repeated death delivery cannot mint another cache');
  assert.equal(internals(game).events.filter(e => messages([e.bytes])[0]?.startsWith('PLANET BOUNTY:')).length, 1);

  // A distant living client and a dead participant receive the same public event.
  bystander.p.state.px = 12_000;
  internals(game).buildSnapshotFor = () => new Uint8Array();
  internals(game).broadcast();
  for (const receiver of [alice, bob, bystander])
    assert.equal(messages(receiver.packets).filter(s => s.startsWith('PLANET BOUNTY:')).length, 1);
});

test('boss cache supplies a usable nuke launcher and ammo, reserved against bots and nonparticipants', () => {
  const { game, player, boss } = fixture();
  const hunter = player('Hunter'), rival = player('Rival'), bot = player('Bot', true), c = boss();
  game.wildlife.damage(c, c.health, hunter.p.id, game.tick);
  const drop = [...game.pickups.values()].find(p => p.kind === PICKUP_WEAPON)!;
  assert.equal(drop.weapon, NUKE_LAUNCHER_ID);
  rival.p.state.px = bot.p.state.px = 0;
  game.tick += PICKUP_GRACE_TICKS;
  internals(game).updatePickups();
  assert.equal(game.pickups.size, 4, 'unqualified humans and bots cannot take a reserved cache');
  assert.deepEqual(rival.p.ammo[NUKE_LAUNCHER_ID], { magazine: 0, reserve: 0 });
  assert.deepEqual(bot.p.ammo[NUKE_LAUNCHER_ID], { magazine: 0, reserve: 0 });

  hunter.p.state.px = 0;
  internals(game).updatePickups();
  assert.deepEqual(hunter.p.ammo[NUKE_LAUNCHER_ID], { magazine: 5, reserve: 4 });
  assert.ok(!game.pickups.has(drop.id));
  const shot = stepWeaponState(hunter.p, NUKE_LAUNCHER_ID, BTN.FIRE, 1);
  assert.equal(shot.firedWeapon, NUKE_LAUNCHER_ID, 'weapon is selectable and loaded immediately');
  const cmd: InputCmd = { seq: 1, buttons: BTN.FIRE, weapon: NUKE_LAUNCHER_ID, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 };
  internals(game).fire(hunter.p, cmd, shot.firedWeapon);
  assert.ok([...game.projectiles.values()].some(p => p.weapon === NUKE_MARKER.id && p.owner === hunter.p.id));
});

test('shared cache becomes public after the reservation and expires without respawning', () => {
  const { game, player, boss } = fixture();
  const hunter = player('Hunter'), visitor = player('Visitor'), c = boss();
  game.wildlife.damage(c, c.health, hunter.p.id, game.tick);
  const deathTick = game.tick;
  visitor.p.state.px = 0;
  game.tick = deathTick + BOSS_REWARD_RESERVATION_TICKS - 1;
  internals(game).updatePickups(); assert.equal(visitor.p.ammo[NUKE_LAUNCHER_ID].magazine, 0);
  game.tick++;
  internals(game).updatePickups(); assert.equal(visitor.p.ammo[NUKE_LAUNCHER_ID].magazine, 5);
  assert.equal(hunter.p.salvage, 530, 'public collection never awards additional bounty');
  game.tick = deathTick + BOSS_REWARD_LIFETIME_TICKS;
  internals(game).updatePickups(); assert.equal(game.pickups.size, 0);
  game.tick += BOSS_REWARD_LIFETIME_TICKS;
  internals(game).updatePickups(); assert.equal(game.pickups.size, 0);
});

test('stale and token damage do not earn bounties, while a vehicle gunner keeps credit after leaving the seat', () => {
  const { game, player, boss } = fixture();
  const stale = player('Stale'), token = player('Token'), driver = player('Driver'), gunner = player('Gunner'), bot = player('Bot', true);
  const c = boss();
  game.wildlife.damage(c, 500, stale.p.id, game.tick);
  game.tick += BOSS_CONTRIBUTION_WINDOW_TICKS + 1;
  game.wildlife.damage(c, 1, token.p.id, game.tick);
  gunner.p.state.vehicle = VEHICLE.TANK; gunner.p.state.seat = 1; gunner.p.vehicleId = 99;
  driver.p.state.vehicle = VEHICLE.TANK; driver.p.vehicleId = 99;
  internals(game).explode(c.x, c.y + CREATURE_DEFS[c.species].height * .5, c.z, gunner.p,
    { ...TANK_CANNON, splashRadius: 20, splashMax: 300 }, -1, -1);
  assert.ok((c.damageContributors.get(gunner.p.id)?.damage ?? 0) >= 300);
  gunner.p.state.vehicle = VEHICLE.NONE; gunner.p.vehicleId = -1;
  game.wildlife.damage(c, c.health, bot.p.id, game.tick);
  assert.equal(gunner.p.salvage, 530);
  for (const p of [stale.p, token.p, driver.p, bot.p]) assert.equal(p.salvage, 30);
});

test('boss salvage survives ordinary checkpoints without forging extraction ledger watermarks', () => {
  const { game, player, boss } = fixture();
  const hunter = player('Hunter').p, c = boss();
  const db = new DatabaseSync(':memory:');
  try {
    const ledger = new OutpostLedger(db), key = 'a'.repeat(64);
    hunter.salvageSpent = 20; hunter.salvageEarned = 12;
    db.prepare('INSERT INTO salvage_spending(key,total) VALUES(?,?)').run(key, 20);
    db.prepare('INSERT INTO salvage_earnings(key,total) VALUES(?,?)').run(key, 12);
    game.wildlife.damage(c, c.health, hunter.id, game.tick);
    const saved = capturePlayer(game, hunter);
    const reconciled = ledger.reconcile(key, saved);
    assert.equal(reconciled.salvage, 530);
    assert.equal(reconciled.salvageSpent, 20);
    assert.equal(reconciled.salvageEarned, 12);
    assert.deepEqual(ledger.reconcile(key, reconciled), reconciled, 'replayed checkpoint is balance-neutral');
    const restored = player('Restored').p;
    restorePlayer(game, restored, reconciled);
    assert.equal(restored.salvage, 530);
    assert.equal(restored.salvageEarned, 12);
  } finally { db.close(); }
});

test('species rewards are data-driven and salvage and ammunition respect storage caps', () => {
  for (const [species, salvage] of [[CREATURE.OSSUARY_TITAN, 500], [CREATURE.CINDER_COLOSSUS, 650], [CREATURE.TIDE_BEHEMOTH, 600]]) {
    const { game, player, boss } = fixture();
    const hunter = player('Hunter').p, capped = player('Full storage').p, c = boss(species);
    capped.salvage = 999_999;
    game.wildlife.damage(c, 300, capped.id, game.tick);
    game.wildlife.damage(c, c.health, hunter.id, game.tick);
    assert.equal(hunter.salvage, 30 + salvage);
    assert.equal(capped.salvage, 1_000_000);
    // Ammo crates may leave reserve above its spawn value. A later weapon
    // crate must not add another full magazine beyond the total-round cap.
    const def = WEAPONS[NUKE_LAUNCHER_ID];
    hunter.ammo[NUKE_LAUNCHER_ID] = { magazine: 0, reserve: def.magazineSize + def.reserveSize - 1 };
    hunter.state.px = 0; game.tick += PICKUP_GRACE_TICKS;
    internals(game).updatePickups();
    const ammo = hunter.ammo[NUKE_LAUNCHER_ID];
    assert.equal(ammo.magazine, 1);
    assert.equal(ammo.magazine + ammo.reserve, def.magazineSize + def.reserveSize);
  }
});

test('boss drops keep the transient cap and permanent loot while ordinary drops retire first', () => {
  const { game, player, boss } = fixture();
  const hunter = player('Hunter').p, c = boss();
  const permanent: ServerPickup = { id: 9000, kind: PICKUP_HEALTH, weapon: -1, x: 1000, y: .5, z: 0,
    availableAtTick: 0, expiresAtTick: Number.MAX_SAFE_INTEGER, permanent: true };
  game.pickups.set(permanent.id, permanent);
  for (let i = 0; i < MAX_LIVE_PICKUPS; i++) internals(game).spawnPickup(PICKUP_HEALTH, -1, hunter);
  game.wildlife.damage(c, c.health, hunter.id, game.tick);
  const reserved = [...game.pickups.values()].filter(p => p.rewardFor).map(p => p.id);
  for (let i = 0; i < MAX_LIVE_PICKUPS * 2; i++) internals(game).spawnPickup(PICKUP_HEALTH, -1, hunter);
  assert.equal(game.pickups.size, MAX_LIVE_PICKUPS + 1);
  assert.equal(game.pickups.get(permanent.id), permanent);
  for (const id of reserved) assert.ok(game.pickups.has(id), 'normal combat must not evict a reserved reward');
});

test('ordinary creatures retain their modest loot and never emit boss bounties', () => {
  const { game, player, boss } = fixture();
  const hunter = player('Hunter'), c = boss(CREATURE.SHAMBLER);
  internals(game).dropCreatureLoot(c, hunter.p.id);
  assert.equal(hunter.p.salvage, 30);
  assert.deepEqual([...game.pickups.values()].map(p => p.kind).sort(), [PICKUP_HEALTH, PICKUP_AMMO].sort());
  assert.ok([...game.pickups.values()].every(p => !p.rewardFor && p.weapon !== NUKE_LAUNCHER_ID));
  assert.deepEqual(messages(hunter.packets), []);
  assert.equal(internals(game).events.length, 0);
});
