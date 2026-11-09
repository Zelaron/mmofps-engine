import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ByteWriter, ByteReader, Msg,
  encodeInput, decodeInput,
  encodeSnapshot, decodeSnapshot,
  encodeFire, decodeFire,
  encodeExplosion, decodeExplosion,
  encodeDeath, decodeDeath,
  encodeSpawn, decodeSpawn,
  encodePickupResult, decodePickupResult,
  encodeJoin, decodeJoin,
  encodeScores, decodeScores,
  encodeWelcome, decodeWelcome, encodePong,
  ENT_PLAYER, ENT_PROJECTILE, PICKUP_AMMO, PICKUP_HEALTH,
  PICKUP_RESULT_COLLECTED, PICKUP_RESULT_FULL,
  type Snapshot,
} from '@shared/protocol';
import { PROTOCOL_VERSION } from '@shared/constants';
import { quantYaw, unquantYaw, quantPitch, unquantPitch } from '@shared/math';
import { mulberry32 } from '@shared/rng';
import { BTN, type InputCmd } from '@shared/movement';
import { WEAPONS } from '@shared/weapons';

function strip(buf: Uint8Array): ByteReader {
  const r = new ByteReader(buf);
  r.u8(); // message id
  return r;
}

test('input roundtrip is exact for pre-quantized values', () => {
  const rng = mulberry32(4);
  for (let i = 0; i < 200; i++) {
    const cmd: InputCmd = {
      seq: Math.floor(rng() * 0xffffffff),
      buttons: Math.floor(rng() * 256),
      weapon: Math.floor(rng() * WEAPONS.length),
      yaw: unquantYaw(quantYaw(rng() * 7 - 3.5)),
      pitch: unquantPitch(quantPitch(rng() * 3 - 1.5)),
      renderTick: Math.floor(rng() * 1e6),
      renderFrac: Math.round(rng() * 255) / 255,
    };
    const out = decodeInput(strip(encodeInput(cmd)));
    assert.deepEqual(out, cmd);
  }

  const reload: InputCmd = {
    seq: 201, buttons: BTN.RELOAD, weapon: 4,
    yaw: 0, pitch: 0, renderTick: 99, renderFrac: 0.5,
  };
  assert.equal(decodeInput(strip(encodeInput(reload))).buttons, BTN.RELOAD);
});

test('snapshot roundtrip preserves entities and player state', () => {
  const f = Math.fround;
  const snap: Snapshot = {
    tick: 0x1_0000_0000 + 123456,
    lastSeq: 9876,
    you: {
      px: f(12.5), py: f(34.25), pz: f(-1000.75),
      vx: f(1.5), vy: f(-9.25), vz: f(0),
      grounded: true, alive: true,
      dodgeCd: 0.5, health: 87, weapon: 3, cooldown: 0.105 - 5 / 60,
      ammo: WEAPONS.map((_, i) => ([
        { magazine: 17, reserve: 123 },
        { magazine: 0, reserve: 32 },
        { magazine: 3, reserve: 12 },
        { magazine: 1, reserve: 7 },
        { magazine: 0, reserve: 9 },
        { magazine: 20, reserve: 6 },
        { magazine: 5, reserve: 2 },
      ][i] ?? { magazine: i + 1, reserve: 12 * i })),
      reloadWeapon: 3,
      reloadCooldown: 1.8 - 61 / 60,
      reloadHeld: true,
      vehicle: 2, heading: unquantYaw(quantYaw(0.75)),
      boostFuel: 128 / 255, vehicleHealth: 640, vehicleFireCd: 2.5, vehicleAltCd: 41.25, lockState: 1,
      vehiclePitch: f(0.73), vehicleRoll: f(-2.4), boosting: true,
      airlift: { source: 0, destination: 1, startTick: 0x1_0000_0000 + 123400, durationTicks: 1800 },
    },
    ents: [
      {
        kind: ENT_PLAYER, id: 7, x: f(1), y: f(2), z: f(3),
        yaw: unquantYaw(quantYaw(1.25)), pitch: 0,
        grounded: false, dead: false, weapon: 2,
        vehicle: 1, heading: unquantYaw(quantYaw(-2.5)),
        vehiclePitch: unquantPitch(quantPitch(-0.4)), vehicleRoll: unquantYaw(quantYaw(2.1)),
      },
      {
        kind: ENT_PROJECTILE, id: 900, x: f(-5), y: f(60), z: f(200),
        vx: 24, vy: -8, vz: 0.5, owner: 7, weapon: 4,
      },
    ],
    pickups: [
      {
        id: 41, kind: PICKUP_HEALTH, weapon: -1,
        x: f(4.5), y: f(-12.25), z: f(80),
      },
      {
        id: 42, kind: PICKUP_AMMO, weapon: 4,
        x: f(-5), y: f(7.75), z: f(2),
      },
    ],
    vehicles: [
      {
        id: 300, type: 3, x: f(120), y: f(30.5), z: f(-42),
        heading: unquantYaw(quantYaw(2.0)), health: 420,
      },
    ],
  };
  const w = new ByteWriter();
  encodeSnapshot(w, snap);
  const buf = w.finish();
  assert.equal(buf[0], Msg.SSnapshot);
  const out = decodeSnapshot(strip(buf));

  assert.equal(out.tick, snap.tick);
  assert.equal(out.lastSeq, snap.lastSeq);
  // Weapon timers arrive exactly so prediction replays shots on the same tick.
  assert.deepEqual({ ...out.you, dodgeCd: 0 }, { ...snap.you, dodgeCd: 0 });
  assert.ok(Math.abs(out.you.dodgeCd - snap.you.dodgeCd) < 0.002);
  assert.ok(Math.abs(out.you.boostFuel - snap.you.boostFuel) < 0.01);
  assert.deepEqual(out.vehicles, snap.vehicles);

  snap.you.jumpAscent = true;
  const jumping = new ByteWriter(); encodeSnapshot(jumping, snap);
  assert.equal(decodeSnapshot(strip(jumping.finish())).you.jumpAscent, true,
    'reconciliation preserves jump ascent even after the jump key is released');
  delete snap.you.jumpAscent;

  assert.equal(out.ents.length, 2);
  const p = out.ents[0];
  assert.equal(p.kind, ENT_PLAYER);
  if (p.kind === ENT_PLAYER) {
    assert.equal(p.id, 7);
    assert.equal(p.x, 1);
    assert.equal(p.yaw, unquantYaw(quantYaw(1.25)));
    assert.equal(p.weapon, 2);
    assert.equal(p.vehiclePitch, unquantPitch(quantPitch(-0.4)));
    assert.equal(p.vehicleRoll, unquantYaw(quantYaw(2.1)));
  }
  const r = out.ents[1];
  assert.equal(r.kind, ENT_PROJECTILE);
  if (r.kind === ENT_PROJECTILE) {
    assert.equal(r.owner, 7);
    assert.equal(r.weapon, 4);
    assert.ok(Math.abs(r.vx - 24) < 0.02);
    assert.ok(Math.abs(r.vy + 8) < 0.02);
  }
  assert.deepEqual(out.pickups, snap.pickups);
});

test('event roundtrips', () => {
  const fire = decodeFire(strip(encodeFire({
    shooter: 3, weapon: 1, seq: 42, ox: 1, oy: 2, oz: 3,
    ends: [
      { x: 10, y: 11, z: 12, hitKind: 0 },
      { x: -5, y: 0.5, z: 9, hitKind: 1 },
    ],
  })));
  assert.equal(fire.shooter, 3);
  assert.equal(fire.ends.length, 2);
  assert.equal(fire.ends[1].hitKind, 1);

  const explosion = decodeExplosion(strip(encodeExplosion(4, 5, 6, 4, 901)));
  assert.deepEqual(explosion, { x: 4, y: 5, z: 6, weapon: 4, projectileId: 901 });

  const death = decodeDeath(strip(encodeDeath(5, 9, 2)));
  assert.deepEqual(death, { victim: 5, killer: 9, weapon: 2 });

  const spawn = decodeSpawn(strip(encodeSpawn(12, 1.5, 20.25, -3)));
  assert.equal(spawn.id, 12);
  assert.equal(spawn.y, 20.25);

  const healthPickup = decodePickupResult(strip(encodePickupResult({
    pickupId: 41,
    kind: PICKUP_HEALTH,
    weapon: -1,
    result: PICKUP_RESULT_COLLECTED,
    amount: 7.75,
  })));
  assert.deepEqual(healthPickup, {
    pickupId: 41,
    kind: PICKUP_HEALTH,
    weapon: -1,
    result: PICKUP_RESULT_COLLECTED,
    amount: 7.75,
  });

  const fullAmmo = encodePickupResult({
    pickupId: 42,
    kind: PICKUP_AMMO,
    weapon: 3,
    result: PICKUP_RESULT_FULL,
    amount: 0,
  });
  assert.equal(fullAmmo[0], Msg.SPickupResult);
  assert.deepEqual(decodePickupResult(strip(fullAmmo)), {
    pickupId: 42,
    kind: PICKUP_AMMO,
    weapon: 3,
    result: PICKUP_RESULT_FULL,
    amount: 0,
  });

  const join = decodeJoin(strip(encodeJoin(4, 'Xan')));
  assert.deepEqual(join, { id: 4, name: 'Xan', bot: false });
  assert.deepEqual(decodeJoin(strip(encodeJoin(5, 'Bot', true))), { id: 5, name: 'Bot', bot: true }, 'roster entries mark bots');
  // Older join payloads without the flag still decode.
  const legacyJoin = new ByteWriter(16).u8(Msg.SJoin).entity(6).str('Old').finish();
  assert.deepEqual(decodeJoin(strip(legacyJoin)), { id: 6, name: 'Old' });

  const scores = decodeScores(strip(encodeScores([
    { id: 1, frags: 10, deaths: 3, ping: 48 },
    { id: 2, frags: -2, deaths: 8, ping: 200 },
  ])));
  assert.equal(scores.length, 2);
  assert.equal(scores[0].frags, 10);
  assert.equal(scores[1].frags, -2);
  assert.equal(scores[0].ping, 48);

  const welcome = decodeWelcome(strip(encodeWelcome(9, 1337, 60000)));
  assert.deepEqual(welcome, {
    version: PROTOCOL_VERSION, yourId: 9, seed: 1337, tick: 60000, teleporters: [],
  });
});

test('welcome preserves exact base-pad coordinates and shared destination indices', () => {
  const pads = [
    { x: -1024.123456789, y: 80.999999999, z: 1500.987654321, cave: false, partner: 1 },
    { x: 900.10000000001, y: -86.123456789, z: -400.432109876, cave: true, partner: 0 },
    { x: 450.0123456789, y: -220.888888888, z: 100.999999999, cave: true, partner: 0 },
  ];
  const encoded = encodeWelcome(0x1_0000_0001, 7331, 0x1_0000_0002, pads), r = strip(encoded);
  assert.deepEqual(decodeWelcome(r), { version: PROTOCOL_VERSION, yourId: 0x1_0000_0001,
    seed: 7331, tick: 0x1_0000_0002, teleporters: pads });
  assert.equal(r.remaining, 0);
  assert.equal(encoded.length - encodeWelcome(0x1_0000_0001, 7331, 0x1_0000_0002).length, pads.length * 27);
});

test('welcome rejects incomplete layouts, nonfinite coordinates and invalid destinations', () => {
  const pad = { x: 1, y: 2, z: 3, cave: false, partner: 0 };
  for (const invalid of [{ ...pad, x: NaN }, { ...pad, y: Infinity }, { ...pad, partner: -1 },
    { ...pad, partner: 1 }, { ...pad, partner: .5 }]) assert.throws(() => encodeWelcome(1, 1337, 1, [invalid]), /Invalid base teleporter/);
  assert.throws(() => encodeWelcome(1, 1337, 1, Array(256).fill(pad)), /Too many base teleporters/);
  const valid = encodeWelcome(1, 1337, 1, [pad]);
  for (let length = 1; length < valid.length; length++) assert.throws(() => decodeWelcome(strip(valid.slice(0, length))));
  assert.throws(() => decodeWelcome(strip(Uint8Array.from([...valid, 0]))), /payload length/);
  const header = strip(valid); header.u8(); header.entity(); header.u32(); header.tick(); header.u8();
  const start = header.off;
  const badCoordinate = valid.slice(); new DataView(badCoordinate.buffer).setFloat64(start, Infinity, true);
  assert.throws(() => decodeWelcome(strip(badCoordinate)), /Invalid base teleporter/);
  const badFlag = valid.slice(); badFlag[start + 24] = 2;
  assert.throws(() => decodeWelcome(strip(badFlag)), /cave flag/);
  const badPartner = valid.slice(); new DataView(badPartner.buffer).setUint16(start + 25, 1, true);
  assert.throws(() => decodeWelcome(strip(badPartner)), /Invalid base teleporter/);
});


test('persistent ticks survive the former 32-bit wrap in input, welcome and ping', () => {
  for (const tick of [0, 0xffffffff, 0x1_0000_0000, 60 * 60 * 24 * 365 * 60, Number.MAX_SAFE_INTEGER]) {
    assert.equal(decodeWelcome(strip(encodeWelcome(123, 1337, tick))).tick, tick);
    const input = { seq: 9, buttons: 0, weapon: 0, yaw: 0, pitch: 0, renderTick: tick, renderFrac: 0 };
    assert.equal(decodeInput(strip(encodeInput(input))).renderTick, tick);
    const pong = strip(encodePong(1234.5, tick));
    assert.equal(pong.f64(), 1234.5); assert.equal(pong.tick(), tick); assert.equal(pong.remaining, 0);
  }
});

test('invalid fractional, negative and non-finite wire clocks are rejected', () => {
  for (const tick of [-1, .5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => encodeWelcome(1, 1337, tick), /Invalid simulation tick/);
    assert.throws(() => new ByteReader(new ByteWriter().f64(tick).finish()).tick(), /Invalid simulation tick/);
  }
});
