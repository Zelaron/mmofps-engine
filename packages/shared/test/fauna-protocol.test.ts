import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ByteReader, ByteWriter, Msg, decodeSnapshot, encodeSnapshot,
  ENT_PLAYER, ENT_PROJECTILE, PICKUP_WEAPON, type Snapshot,
} from '@shared/protocol';
import { quantYaw, unquantYaw } from '@shared/math';
import { WEAPONS } from '@shared/weapons';
import { CREATURE_DEFS, MAX_VISIBLE_CREATURES, type CreatureState } from '@shared/wildlife';
import { DYNAMIC_ENTITY_BASE, MAX_ENTITY_ID } from '@shared/entity-id';

function snapshot(creatures?: readonly CreatureState[]): Snapshot {
  return {
    tick: 54321, lastSeq: 43210,
    you: {
      px: 10, py: -80, pz: -6000, vx: 3, vy: 0, vz: -7,
      grounded: true, alive: true, dodgeCd: 0, health: 83,
      weapon: 9, cooldown: 0.4,
      ammo: WEAPONS.map((_, i) => ({ magazine: i + 1, reserve: 20 + i })),
      reloadWeapon: 9, reloadCooldown: 1.25, reloadHeld: true,
      vehicle: 0, heading: 0, boostFuel: 1, vehicleHealth: 0, lockState: 0,
    },
    ents: [
      { kind: ENT_PLAYER, id: 300, x: 5, y: -82, z: -6007, yaw: 0, pitch: 0,
        grounded: true, dead: false, weapon: 8, vehicle: 0, heading: 0 },
      { kind: ENT_PROJECTILE, id: 301, x: 7, y: -78, z: -6005, vx: 12, vy: 3, vz: -64,
        owner: 300, weapon: 9 },
    ],
    pickups: [{ id: 400, kind: PICKUP_WEAPON, weapon: 9, x: 16, y: -80, z: -6010 }],
    vehicles: [{ id: 500, type: 2, x: 38, y: 14, z: -5900, heading: 0, health: 520 }],
    creatures,
  };
}

function roundtrip(snap: Snapshot): { decoded: Snapshot; bytes: Uint8Array } {
  const writer = new ByteWriter(32);
  encodeSnapshot(writer, snap);
  const bytes = writer.finish(), reader = new ByteReader(bytes);
  assert.equal(reader.u8(), Msg.SSnapshot);
  const decoded = decodeSnapshot(reader);
  assert.equal(reader.remaining, 0, 'the fauna tail must neither consume preceding fields nor leave unread bytes');
  return { decoded, bytes };
}

test('creature snapshot tail preserves all species, coordinates and independent alert/death flags', () => {
  const creatures = Array.from({ length: 6 }, (_, i) => ({
    id: 61000 + i, species: i % CREATURE_DEFS.length,
    x: -6321.125 + i, y: -113.75 + i * 0.01, z: 8271.25 - i,
    yaw: -6.9 + i * 2.3, speed: [0, 0.87, 5.5, -1, 18, 4.8][i],
    alert: (i & 1) !== 0, dead: (i & 2) !== 0,
  }));
  const source = snapshot(creatures), { decoded } = roundtrip(source);
  assert.deepEqual(decoded.creatures, creatures.map(c => ({ ...c,
    x: Math.fround(c.x), y: Math.fround(c.y), z: Math.fround(c.z),
    yaw: unquantYaw(quantYaw(c.yaw)),
    speed: Math.max(0, Math.min(255, Math.round(c.speed * 20))) / 20,
  })));
  assert.equal(decoded.you.ammo.length, WEAPONS.length);
  assert.deepEqual(decoded.you.ammo, source.you.ammo, 'all ten weapons precede fauna without changing packet alignment');
  assert.equal(decoded.you.weapon, 9);
  assert.equal(decoded.you.reloadWeapon, 9);
  assert.equal(decoded.you.reloadCooldown, 1.25);
  assert.equal(decoded.ents[0].weapon, 8);
  assert.deepEqual(decoded.ents[1], source.ents[1]);
  assert.deepEqual(decoded.pickups, source.pickups);
  assert.deepEqual(decoded.vehicles, source.vehicles);
});

test('fauna replication caps 18 creatures at 450 bytes even with maximum-width safe-integer IDs', () => {
  const creatures: CreatureState[] = Array.from({ length: MAX_VISIBLE_CREATURES + 30 }, (_, i) => ({
    id: i + 1, species: i % CREATURE_DEFS.length, x: i, y: -40, z: -i,
    yaw: 0, speed: 1, alert: false,
  }));
  const empty = roundtrip(snapshot());
  assert.deepEqual(empty.decoded.creatures, []);
  for (const [firstId, bytesPerCreature] of [[1, 18], [DYNAMIC_ENTITY_BASE, 22], [MAX_ENTITY_ID - creatures.length, 25]]) {
    const large = creatures.map((c, i) => ({ ...c, id: firstId + i }));
    const result = roundtrip(snapshot(large));
    assert.equal(result.decoded.creatures!.length, MAX_VISIBLE_CREATURES);
    assert.deepEqual(result.decoded.creatures!.map(c => c.id), large.slice(0, MAX_VISIBLE_CREATURES).map(c => c.id));
    assert.equal(result.bytes.length - empty.bytes.length, MAX_VISIBLE_CREATURES * bytesPerCreature);
    assert.ok(result.bytes.length - empty.bytes.length <= 450);
  }
  assert.equal(creatures.length, MAX_VISIBLE_CREATURES + 30, 'encoding must not mutate server interest state');
  assert.deepEqual(roundtrip(snapshot([])).bytes, empty.bytes);
});
