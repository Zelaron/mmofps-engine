import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ByteReader, Msg, decodePickupResult, decodeSnapshot,
  NET, PLAYER, TICK_DT, TICK_RATE, WEAPONS,
  PICKUP_AMMO, PICKUP_HEALTH,
  PICKUP_RESULT_COLLECTED, PICKUP_RESULT_FULL,
  type PickupResultEvent,
} from '@shared/index';
import {
  Game,
  BOT_AMMO_REGEN_TICKS,
  HEALTH_PICKUP_AMOUNT,
  MAX_LIVE_PICKUPS,
  PICKUP_GRACE_TICKS,
  PICKUP_LIFETIME_TICKS,
  ammoPickupAmount,
  type ServerPickup,
} from '../src/game.js';

type Player = ReturnType<Game['addPlayer']>;
type GameInternals = {
  spawnPickup(
    kind: typeof PICKUP_HEALTH | typeof PICKUP_AMMO,
    weapon: number,
    victim: Player,
  ): ServerPickup | null;
  updatePickups(): void;
  kill(victim: Player, attacker: Player, weapon: number): void;
  damage(
    victim: Player,
    amount: number,
    attacker: Player,
    weapon: number,
    kx: number,
    ky: number,
    kz: number,
  ): void;
  buildSnapshotFor(player: Player): Uint8Array;
};

function internal(game: Game): GameInternals {
  return game as unknown as GameInternals;
}

function pickupResults(packets: readonly Uint8Array[]): PickupResultEvent[] {
  return packets
    .filter((packet) => packet[0] === Msg.SPickupResult)
    .map((packet) => {
      const reader = new ByteReader(packet);
      assert.equal(reader.u8(), Msg.SPickupResult);
      return decodePickupResult(reader);
    });
}

function localPickup(
  game: Game,
  p: Player,
  id: number,
  kind: typeof PICKUP_HEALTH | typeof PICKUP_AMMO,
  weapon: number,
): ServerPickup {
  const pickup: ServerPickup = {
    id, kind, weapon,
    x: p.state.px,
    y: p.state.py + PLAYER.RADIUS,
    z: p.state.pz,
    availableAtTick: game.tick,
    expiresAtTick: game.tick + PICKUP_LIFETIME_TICKS,
  };
  game.pickups.set(id, pickup);
  return pickup;
}

test('health pickups are capped and remain for a full-health collector', () => {
  const game = new Game(601);
  const received: Uint8Array[] = [];
  const p = game.addPlayer('Collector', { send: (bytes) => received.push(bytes) });
  localPickup(game, p, 1, PICKUP_HEALTH, -1);

  internal(game).updatePickups();
  assert.equal(game.pickups.size, 1, 'a player who cannot benefit leaves the crate');
  assert.deepEqual(pickupResults(received), [{
    pickupId: 1,
    kind: PICKUP_HEALTH,
    weapon: -1,
    result: PICKUP_RESULT_FULL,
    amount: 0,
  }]);
  internal(game).updatePickups();
  assert.equal(pickupResults(received).length, 1, 'continuous contact emits only once');

  p.health = PLAYER.MAX_HEALTH - 10.75;
  internal(game).updatePickups();
  assert.equal(p.health, PLAYER.MAX_HEALTH);
  assert.equal(game.pickups.size, 0);
  assert.deepEqual(pickupResults(received)[1], {
    pickupId: 1,
    kind: PICKUP_HEALTH,
    weapon: -1,
    result: PICKUP_RESULT_COLLECTED,
    amount: 10.75,
  });
  assert.equal(HEALTH_PICKUP_AMOUNT, 35);
});

test('full pickup feedback is contact-edge triggered with release hysteresis', () => {
  const game = new Game(6010);
  const received: Uint8Array[] = [];
  const p = game.addPlayer('Full', { send: (bytes) => received.push(bytes) });
  const originX = p.state.px;
  localPickup(game, p, 1, PICKUP_HEALTH, -1);

  internal(game).updatePickups();
  for (let i = 0; i < TICK_RATE * 2; i++) internal(game).updatePickups();
  assert.equal(pickupResults(received).length, 1);

  // Leaving collection range but not the larger release radius keeps the
  // contact latched, so small boundary oscillations cannot retrigger it.
  p.state.px = originX + 1.4;
  internal(game).updatePickups();
  p.state.px = originX;
  internal(game).updatePickups();
  assert.equal(pickupResults(received).length, 1);

  p.state.px = originX + 1.6;
  internal(game).updatePickups();
  p.state.px = originX;
  internal(game).updatePickups();
  assert.equal(pickupResults(received).length, 2, 'genuine exit permits a new notice');

  p.state.alive = false;
  internal(game).updatePickups();
  p.state.alive = true;
  internal(game).updatePickups();
  assert.equal(pickupResults(received).length, 3, 'death clears the contact latch');
  for (const result of pickupResults(received)) {
    assert.equal(result.result, PICKUP_RESULT_FULL);
    assert.equal(result.amount, 0);
  }
});

test('the nearest eligible collector wins regardless of insertion order', () => {
  const game = new Game(6011);
  const earlierReceived: Uint8Array[] = [];
  const laterReceived: Uint8Array[] = [];
  const earlier = game.addPlayer('Earlier', {
    send: (bytes) => earlierReceived.push(bytes),
  });
  const later = game.addPlayer('Later', {
    send: (bytes) => laterReceived.push(bytes),
  });
  const y = game.world.groundY(0, 0) + 0.12;
  for (const p of [earlier, later]) {
    p.state.py = y;
    p.state.pz = 0;
    p.health = 50;
  }
  earlier.state.px = 0.9;
  later.state.px = 0.2;
  localPickup(game, earlier, 1, PICKUP_HEALTH, -1).x = 0;

  internal(game).updatePickups();
  assert.equal(earlier.health, 50);
  assert.equal(later.health, 50 + HEALTH_PICKUP_AMOUNT);
  assert.equal(game.pickups.size, 0);
  assert.equal(pickupResults(earlierReceived).length, 0);
  assert.equal(pickupResults(laterReceived).length, 1);

  // A closer full-health player is ineligible and cannot block someone who
  // can actually benefit.
  earlierReceived.length = 0;
  laterReceived.length = 0;
  earlier.state.px = 0.1;
  earlier.health = PLAYER.MAX_HEALTH;
  later.state.px = 0.6;
  later.health = 40;
  localPickup(game, earlier, 2, PICKUP_HEALTH, -1).x = 0;
  internal(game).updatePickups();
  assert.equal(earlier.health, PLAYER.MAX_HEALTH);
  assert.equal(later.health, 40 + HEALTH_PICKUP_AMOUNT);
  assert.equal(
    pickupResults(earlierReceived).length,
    0,
    'a crate consumed by an eligible player emits no stale full notice',
  );
  assert.equal(pickupResults(laterReceived)[0]?.result, PICKUP_RESULT_COLLECTED);

  // Equal capsule distances resolve by stable player ID.
  earlierReceived.length = 0;
  laterReceived.length = 0;
  earlier.state.px = -0.4;
  earlier.health = 30;
  later.state.px = 0.4;
  later.health = 30;
  localPickup(game, earlier, 3, PICKUP_HEALTH, -1).x = 0;
  internal(game).updatePickups();
  assert.equal(earlier.health, 30 + HEALTH_PICKUP_AMOUNT);
  assert.equal(later.health, 30);
});

test('distant players outside pickup hash buckets cannot affect collection', () => {
  const game = new Game(6012);
  const farReceived: Uint8Array[] = [];
  const nearReceived: Uint8Array[] = [];
  const far = game.addPlayer('Far', { send: (bytes) => farReceived.push(bytes) });
  const near = game.addPlayer('Near', { send: (bytes) => nearReceived.push(bytes) });
  far.state.px = near.state.px + 100;
  far.state.py = near.state.py;
  far.state.pz = near.state.pz;
  far.health = 20;
  near.health = 20;
  localPickup(game, near, 1, PICKUP_HEALTH, -1);

  internal(game).updatePickups();

  assert.equal(far.health, 20);
  assert.equal(near.health, 20 + HEALTH_PICKUP_AMOUNT);
  assert.equal(pickupResults(farReceived).length, 0);
  assert.equal(pickupResults(nearReceived)[0]?.result, PICKUP_RESULT_COLLECTED);
});

test('pickup hash preserves overlaps across positive and negative cell corners', () => {
  const cases = [
    { playerX: 3.95, playerZ: 3.95, pickupX: 4.65, pickupZ: 4.65 },
    { playerX: -4.05, playerZ: -4.05, pickupX: -3.35, pickupZ: -3.35 },
  ];

  for (const [index, positions] of cases.entries()) {
    const game = new Game(6013 + index);
    const received: Uint8Array[] = [];
    const p = game.addPlayer('Boundary', {
      send: (bytes) => received.push(bytes),
    });
    p.state.px = positions.playerX;
    p.state.pz = positions.playerZ;
    p.health = 50;
    const pickup = localPickup(game, p, 1, PICKUP_HEALTH, -1);
    pickup.x = positions.pickupX;
    pickup.z = positions.pickupZ;

    internal(game).updatePickups();

    assert.equal(p.health, 50 + HEALTH_PICKUP_AMOUNT);
    assert.equal(game.pickups.size, 0);
    assert.equal(
      pickupResults(received)[0]?.result,
      PICKUP_RESULT_COLLECTED,
    );
  }
});

test('ammo pickups cap total rounds and may temporarily exceed spawn reserve', () => {
  const game = new Game(602);
  const received: Uint8Array[] = [];
  const p = game.addPlayer('Collector', { send: (bytes) => received.push(bytes) });
  const weapon = 3;
  const def = WEAPONS[weapon];

  p.ammo[weapon] = {
    magazine: def.magazineSize - 1,
    reserve: def.reserveSize,
  };
  localPickup(game, p, 1, PICKUP_AMMO, weapon);
  internal(game).updatePickups();
  assert.equal(p.ammo[weapon].reserve, def.reserveSize + 1);
  assert.equal(
    p.ammo[weapon].magazine + p.ammo[weapon].reserve,
    def.magazineSize + def.reserveSize,
  );
  assert.equal(game.pickups.size, 0);
  assert.deepEqual(pickupResults(received)[0], {
    pickupId: 1,
    kind: PICKUP_AMMO,
    weapon,
    result: PICKUP_RESULT_COLLECTED,
    amount: 1,
  });

  localPickup(game, p, 2, PICKUP_AMMO, weapon);
  internal(game).updatePickups();
  assert.equal(game.pickups.size, 1, 'a full loadout does not consume the crate');
  assert.deepEqual(pickupResults(received)[1], {
    pickupId: 2,
    kind: PICKUP_AMMO,
    weapon,
    result: PICKUP_RESULT_FULL,
    amount: 0,
  });
  assert.ok(ammoPickupAmount(weapon) > 0);
});

test('infinite-reserve weapons never receive or consume finite ammo drops', () => {
  const game = new Game(603);
  const received: Uint8Array[] = [];
  const p = game.addPlayer('Sidearm', { send: (bytes) => received.push(bytes) });
  assert.equal(WEAPONS[0].infiniteReserve, true);
  p.ammo[0].magazine = 0;
  localPickup(game, p, 1, PICKUP_AMMO, 0);

  internal(game).updatePickups();
  assert.equal(p.ammo[0].reserve, 0);
  assert.equal(game.pickups.size, 1);
  assert.equal(ammoPickupAmount(0), 0);
  assert.equal(pickupResults(received).length, 0);

  localPickup(game, p, 2, PICKUP_AMMO, WEAPONS.length + 10);
  internal(game).updatePickups();
  assert.equal(game.pickups.size, 2);
  assert.equal(
    pickupResults(received).length,
    0,
    'malformed ammo crates are ignored rather than reported as full',
  );
});

test('kill drops are deterministic and only choose finite ammo weapons', () => {
  const simulate = (): Omit<ServerPickup, 'availableAtTick' | 'expiresAtTick'>[] => {
    const game = new Game(604);
    const killer = game.addPlayer('Killer', null);
    const victim = game.addPlayer('Victim', null);
    internal(game).kill(victim, killer, 3);
    return [...game.pickups.values()].map(({
      availableAtTick: _available,
      expiresAtTick: _expires,
      ...pickup
    }) => pickup);
  };

  const first = simulate();
  const second = simulate();
  assert.deepEqual(first, second);
  assert.ok(first.length > 0, 'the fixed seed exercises a successful drop');
  for (const pickup of first) {
    if (pickup.kind === PICKUP_AMMO) {
      assert.equal(WEAPONS[pickup.weapon].infiniteReserve, undefined);
    }
  }
});

test('loot RNG never perturbs the independent deterministic spawn stream', () => {
  const withLoot = new Game(6041);
  const withoutLoot = new Game(6041);
  const killer = withLoot.addPlayer('Killer', null);
  const victim = withLoot.addPlayer('Victim', null);
  withoutLoot.addPlayer('Killer', null);
  withoutLoot.addPlayer('Victim', null);

  internal(withLoot).kill(victim, killer, 3);
  const afterLoot = withLoot.addPlayer('Next', null).state;
  const withoutDropRolls = withoutLoot.addPlayer('Next', null).state;
  assert.deepEqual(
    { x: afterLoot.px, y: afterLoot.py, z: afterLoot.pz },
    { x: withoutDropRolls.px, y: withoutDropRolls.py, z: withoutDropRolls.pz },
  );
});

test('fresh drops replicate during a short same-location collection grace', () => {
  const game = new Game(6042);
  const p = game.addPlayer('Nearby', null);
  const pickup = internal(game).spawnPickup(PICKUP_HEALTH, -1, p);
  assert.ok(pickup);
  p.health = 50;

  internal(game).updatePickups();
  assert.equal(game.pickups.size, 1);
  game.tick = pickup.availableAtTick - 1;
  internal(game).updatePickups();
  assert.equal(game.pickups.size, 1);
  game.tick++;
  internal(game).updatePickups();
  assert.equal(game.pickups.size, 0);
  assert.equal(p.health, 50 + HEALTH_PICKUP_AMOUNT);
  assert.equal(PICKUP_GRACE_TICKS, Math.round(0.25 * TICK_RATE));
});

test('pickup placement follows the local cavern floor instead of the exterior roof', () => {
  const game = new Game(1337);
  const victim = game.addPlayer('Cavern', null);
  // A deterministic enclosed cave witness: exterior height is about +22m,
  // while the local cavern floor is around -32m.
  victim.state.px = -513;
  victim.state.py = -30;
  victim.state.pz = -337;
  assert.ok(game.world.sdf(-513, -30, -337) > 0);

  const pickup = internal(game).spawnPickup(PICKUP_HEALTH, -1, victim);
  assert.ok(pickup);
  assert.ok(pickup.y < -20, `pickup escaped to exterior terrain: ${pickup.y}`);
  assert.ok(game.world.sdf(pickup.x, pickup.y, pickup.z) > 0.08);
  const support = game.world.trace(pickup.x, pickup.y, pickup.z, 0, -1, 0, 2);
  assert.ok(support.hit && support.dist < 1, 'pickup hovers immediately above real terrain');
});

test('live pickups are bounded and expire after thirty seconds', () => {
  const game = new Game(605);
  const victim = game.addPlayer('Drops', null);
  for (let i = 0; i < MAX_LIVE_PICKUPS + 7; i++) {
    assert.ok(internal(game).spawnPickup(PICKUP_HEALTH, -1, victim));
  }
  assert.equal(game.pickups.size, MAX_LIVE_PICKUPS);

  for (const pickup of game.pickups.values()) pickup.expiresAtTick = game.tick + 1;
  game.step();
  assert.equal(game.pickups.size, 0);
});

test('pickup snapshots are interest-filtered and preserve stationary identity', () => {
  const game = new Game(606);
  const p = game.addPlayer('Viewer', null);
  const near = localPickup(game, p, 11, PICKUP_HEALTH, -1);
  const far: ServerPickup = {
    ...near,
    id: 12,
    x: p.state.px + NET.INTEREST_RADIUS + 2,
  };
  game.pickups.set(far.id, far);

  const reader = new ByteReader(internal(game).buildSnapshotFor(p));
  assert.equal(reader.u8(), Msg.SSnapshot);
  const snapshot = decodeSnapshot(reader);
  assert.deepEqual(snapshot.pickups?.map((pickup) => pickup.id), [near.id]);
});

test('bots slowly regenerate only finite reserve ammunition', () => {
  const game = new Game(607);
  const bot = game.addPlayer('Bot', null, true);
  for (const ammo of bot.ammo) {
    ammo.magazine = 0;
    ammo.reserve = 0;
  }

  game.tick = (bot.id % BOT_AMMO_REGEN_TICKS) - 1;
  game.step();
  assert.equal(bot.ammo[0].reserve, 0, 'infinite sidearm has no finite reserve');
  for (let weapon = 1; weapon < WEAPONS.length; weapon++) {
    const expected = WEAPONS[weapon].spawnEmpty ? 0 : 1;
    assert.equal(bot.ammo[weapon].reserve, expected,
      'cave-exclusive weapons never regenerate for bots');
  }
  game.step();
  for (let weapon = 1; weapon < WEAPONS.length; weapon++) {
    const expected = WEAPONS[weapon].spawnEmpty ? 0 : 1;
    assert.equal(bot.ammo[weapon].reserve, expected, 'regeneration is periodic, not per tick');
  }
  assert.equal(BOT_AMMO_REGEN_TICKS, 8 * TICK_RATE);
});

test('health recovery waits fifteen seconds and restores only 1.2 HP per second', () => {
  const game = new Game(608);
  const p = game.addPlayer('Patient', null);
  internal(game).damage(p, 10, p, 0, 0, 0, 0);
  assert.equal(p.health, 90);
  assert.equal(p.regenBlockUntil, 15 * TICK_RATE);

  game.tick = p.regenBlockUntil - 2;
  game.step();
  assert.equal(p.health, 90, 'no recovery before the complete delay');

  for (let i = 0; i < TICK_RATE; i++) game.step();
  assert.ok(
    Math.abs(p.health - (90 + 1.2)) < TICK_DT,
    `one second restored ${p.health - 90} HP`,
  );
  assert.equal(PLAYER.REGEN_DELAY, 15);
  assert.equal(PLAYER.REGEN_RATE, 1.2);
});
