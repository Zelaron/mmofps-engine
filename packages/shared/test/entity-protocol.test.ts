import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ByteReader, ByteWriter, ENT_PLAYER, ENT_PROJECTILE, PICKUP_AMMO, PICKUP_RESULT_COLLECTED,
  encodeWelcome, decodeWelcome, encodeFire, decodeFire, encodeExplosion, decodeExplosion,
  encodeDeath, decodeDeath, encodeSpawn, decodeSpawn, encodeTeleport, decodeTeleport,
  encodePickupResult, decodePickupResult, encodeJoin, decodeJoin, encodeLeave, encodeScores, decodeScores,
  encodeSnapshot, decodeSnapshot, type Snapshot,
} from '@shared/protocol';
import { encodeChat, decodeChat } from '@shared/chat';
import { createFullAmmoLoadout } from '@shared/weapons';

function body(bytes: Uint8Array): ByteReader { const r = new ByteReader(bytes); r.u8(); return r; }

test('all entity references survive legacy boundaries and the full safe-integer range', () => {
  for (const id of [65535, 65536, 100_000, 0x80000001, 0xfffffffe, 2 ** 32, 2 ** 40 + 13, Number.MAX_SAFE_INTEGER]) {
    assert.equal(decodeWelcome(body(encodeWelcome(id, 1337, 10))).yourId, id);
    assert.equal(decodeFire(body(encodeFire({ shooter: id, weapon: 1, seq: 3, ox: 1, oy: 2, oz: 3, ends: [] }))).shooter, id);
    assert.equal(decodeExplosion(body(encodeExplosion(1, 2, 3, 4, id))).projectileId, id);
    assert.deepEqual(decodeDeath(body(encodeDeath(id, id, 1))), { victim: id, killer: id, weapon: 1 });
    assert.equal(decodeSpawn(body(encodeSpawn(id, 1, 2, 3))).id, id);
    assert.equal(decodeTeleport(body(encodeTeleport({ id, fromX: 1, fromY: 2, fromZ: 3, toX: 4, toY: 5, toZ: 6 }))).id, id);
    assert.equal(decodePickupResult(body(encodePickupResult({ pickupId: id, kind: PICKUP_AMMO, weapon: 1, result: PICKUP_RESULT_COLLECTED, amount: 5 }))).pickupId, id);
    assert.equal(decodeJoin(body(encodeJoin(id, 'Explorer'))).id, id);
    const leave = body(encodeLeave(id)); assert.equal(leave.entity(), id); assert.equal(leave.remaining, 0);
    assert.equal(decodeScores(body(encodeScores([{ id, frags: 2, deaths: 1, ping: 20 }])))[0].id, id);
    assert.equal(decodeChat(body(encodeChat({ id: 2, playerId: id, name: 'Explorer', text: 'At the harbor', time: 100 }))).playerId, id);
    const snapshot: Snapshot = {
      tick: 100, lastSeq: 20,
      you: { px: 1, py: 2, pz: 3, vx: 9.5, vy: 8.6, vz: 0, grounded: false, alive: true,
        health: 87, weapon: 1, cooldown: .2, dodgeCd: .5, ammo: createFullAmmoLoadout(),
        reloadWeapon: 1, reloadCooldown: .8, reloadHeld: true, vehicle: 1, vehicleId: id,
        heading: 0, boostFuel: 1, vehicleHealth: 80, lockState: 0 },
      ents: [
        { kind: ENT_PLAYER, id, x: 1, y: 2, z: 3, yaw: 0, pitch: 0, grounded: false,
          dead: false, weapon: 1, vehicle: 1, vehicleId: id, seat: 1, heading: 0 },
        { kind: ENT_PROJECTILE, id, owner: id, weapon: 4, x: 1, y: 2, z: 3, vx: 10, vy: 20, vz: 30 },
      ],
      pickups: [{ id, kind: PICKUP_AMMO, weapon: 1, x: 1, y: 2, z: 3 }],
      vehicles: [{ id, type: 1, x: 1, y: 2, z: 3, heading: 0, health: 80 }],
      creatures: [{ id, species: 1, x: 1, y: 2, z: 3, yaw: 0, speed: 1, alert: false }],
    };
    const w = new ByteWriter(); encodeSnapshot(w, snapshot);
    const r = body(w.finish()), out = decodeSnapshot(r);
    assert.equal(r.remaining, 0); assert.equal(out.you.vehicleId, id);
    assert.deepEqual(out.ents.map(e => e.id), [id, id]);
    assert.equal(out.ents[0].kind === ENT_PLAYER && out.ents[0].vehicleId, id);
    assert.equal(out.ents[1].kind === ENT_PROJECTILE && out.ents[1].owner, id);
    assert.equal(out.pickups![0].id, id); assert.equal(out.vehicles![0].id, id); assert.equal(out.creatures![0].id, id);
    delete snapshot.you.vehicleId;
    if (snapshot.ents[0].kind === ENT_PLAYER) delete snapshot.ents[0].vehicleId;
    const emptyId = new ByteWriter(); encodeSnapshot(emptyId, snapshot);
    const absent = decodeSnapshot(body(emptyId.finish()));
    assert.equal(absent.you.vehicleId, undefined);
    assert.equal(absent.ents[0].kind === ENT_PLAYER && absent.ents[0].vehicleId, undefined);
  }
});
