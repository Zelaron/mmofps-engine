import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ByteWriter, ByteReader, encodeSnapshot, decodeSnapshot, ENT_PLAYER, ENT_PROJECTILE, VEHICLE,
  createFullAmmoLoadout, rotationFromEuler, rotateVector, vehicleQuaternion, type Snapshot,
} from '@shared/index';

function roundtrip(snap: Snapshot): { decoded: Snapshot; bytes: number } {
  const writer = new ByteWriter(); encodeSnapshot(writer, snap);
  const bytes = writer.finish(), reader = new ByteReader(bytes); reader.u8();
  const decoded = decodeSnapshot(reader);
  assert.equal(reader.remaining, 0, 'conditional jet fields must preserve the following packet sections');
  return { decoded, bytes: bytes.length };
}

test('jet snapshots preserve full rotations past vertical and upside down at a bounded per-jet wire cost', () => {
  for (const pitch of [-Math.PI * 2.3, -Math.PI, -Math.PI / 2, Math.PI / 2, Math.PI, Math.PI * 2.7]) {
    const q = rotationFromEuler(.83, pitch, 1.37);
    const snapshot: Snapshot = {
      tick: 200, lastSeq: 100,
      you: { px: 2, py: 1000, pz: -15, vx: 20, vy: -30, vz: -40, grounded: false, alive: true,
        dodgeCd: 0, health: 100, weapon: 9, cooldown: 0, ammo: createFullAmmoLoadout(),
        reloadWeapon: -1, reloadCooldown: 0, reloadHeld: false, vehicle: VEHICLE.JET, heading: 0,
        vehiclePitch: 0, vehicleRoll: 0, vehicleRotation: q, boostFuel: 1, vehicleHealth: 420, lockState: 0 },
      ents: [
        { kind: ENT_PLAYER, id: 5, x: 3, y: 1001, z: -14, yaw: 0, pitch: 0, grounded: false,
          dead: false, weapon: 2, vehicle: VEHICLE.JET, heading: 0, vehicleRotation: q },
        { kind: ENT_PROJECTILE, id: 31, owner: 5, weapon: 9, x: 10, y: 980, z: -25, vx: 30, vy: -20, vz: -40 },
      ],
      pickups: [{ id: 42, kind: 2, weapon: 9, x: 3, y: -70, z: -8 }],
      vehicles: [{ id: 81, type: VEHICLE.TANK, x: 40, y: 2, z: 10, heading: 0, health: 4000 }],
      creatures: [{ id: 19, species: 2, x: 15, y: -75, z: 3, yaw: 0, speed: 2, alert: true }],
    };
    const result = roundtrip(snapshot), remote = result.decoded.ents[0];
    assert.equal(remote.kind, ENT_PLAYER);
    if (remote.kind !== ENT_PLAYER) continue;
    for (const [orientation, tolerance] of [[result.decoded.you, 1e-6], [remote, 1e-4]] as const) {
      const rotation = vehicleQuaternion(orientation);
      assert.ok(Math.abs(Math.hypot(rotation.x, rotation.y, rotation.z, rotation.w) - 1) < 1e-12);
      for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, -1]]) {
        const expected = rotateVector(q, ...axis as [number, number, number]);
        const actual = rotateVector(rotation, ...axis as [number, number, number]);
        assert.ok(Math.hypot(expected.x - actual.x, expected.y - actual.y, expected.z - actual.z) < tolerance);
      }
    }
    assert.deepEqual(result.decoded.ents[1], snapshot.ents[1]);
    assert.deepEqual(result.decoded.pickups, snapshot.pickups);
    assert.deepEqual(result.decoded.vehicles, snapshot.vehicles);
    assert.equal(result.decoded.creatures![0].id, 19);
    const ground = roundtrip({ ...snapshot, you: { ...snapshot.you, vehicle: VEHICLE.TANK },
      ents: snapshot.ents.map(e => e.kind === ENT_PLAYER ? { ...e, vehicle: VEHICLE.TANK } : e) });
    assert.equal(result.bytes - ground.bytes, 16 + 8,
      'only jets add16 owner bytes and8 remote bytes; ordinary player/ground snapshots stay unchanged');
    assert.equal(ground.decoded.you.vehicleRotation, undefined);
  }
});
