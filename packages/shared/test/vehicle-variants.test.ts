import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteReader, ByteWriter, encodeSnapshot, decodeSnapshot, ENT_PLAYER, createFullAmmoLoadout,
  createMoveState, copyMoveState, vehicleDefinition, validVehicleVariant, rotationFromEuler, type Snapshot } from '@shared/index';

test('special hulls roundtrip on owner, remote and parked records for exactly one extra byte each', () => {
  const snap: Snapshot = { tick: 9, lastSeq: 7,
    you: { px: 1, py: 100, pz: 3, vx: 0, vy: 0, vz: 0, grounded: false, alive: true, dodgeCd: 0,
      health: 100, weapon: 0, cooldown: 0, ammo: createFullAmmoLoadout(), reloadWeapon: -1,
      reloadCooldown: 0, reloadHeld: false, vehicle: 3, heading: 0, vehicleRotation: rotationFromEuler(1, 3, 2),
      boostFuel: 1, vehicleHealth: 720, lockState: 0 },
    ents: [{ kind: ENT_PLAYER, id: 11, x: 1, y: 2, z: 3, yaw: 0, pitch: 0, grounded: true,
      dead: false, weapon: 0, vehicle: 2, heading: 0 }],
    vehicles: [{ id: 12, type: 3, x: 4, y: 5, z: 6, heading: 0, health: 720 }],
    creatures: [{ id: 13, species: 5, x: 3, y: -50, z: 8, yaw: 0, speed: 0, alert: false }] };
  const encode = () => { const w = new ByteWriter(); encodeSnapshot(w, snap); return w.finish(); };
  const ordinary = encode(); snap.you.vehicleVariant = 1;
  if (snap.ents[0].kind === ENT_PLAYER) snap.ents[0].vehicleVariant = 2;
  snap.vehicles![0].variant = 1;
  const bytes = encode(), r = new ByteReader(bytes); r.u8(); const decoded = decodeSnapshot(r);
  assert.equal(bytes.length, ordinary.length + 3); assert.equal(r.remaining, 0);
  assert.equal(decoded.you.vehicleVariant, 1); assert.equal(decoded.you.vehicleHealth, 720);
  assert.equal((decoded.ents[0] as { vehicleVariant: number }).vehicleVariant, 2);
  assert.equal(decoded.vehicles![0].variant, 1); assert.equal(decoded.creatures![0].id, 13);
  assert.ok(decoded.you.vehicleRotation);
  snap.you.vehicleVariant = 2; snap.vehicles![0].variant = 2;
  assert.equal(encode().length, ordinary.length + 1, 'invalid type/variant pairs never encode special stats');
});

test('variant identity survives prediction copies and selects distinct handling without changing base types', () => {
  const source = createMoveState(0, 100, 0), copy = createMoveState(0, 0, 0);
  source.vehicle = 3; source.vehicleVariant = 1; source.vehicleRotation = rotationFromEuler(0, 3, 0);
  copyMoveState(source, copy);
  assert.equal(copy.vehicleVariant, 1); assert.deepEqual(copy.vehicleRotation, source.vehicleRotation);
  assert.notEqual(copy.vehicleRotation, source.vehicleRotation);
  assert.equal(vehicleDefinition(3, 1)!.maxSpeed, vehicleDefinition(3)!.maxSpeed * 1.75);
  assert.ok(vehicleDefinition(2, 2)!.maxHealth > vehicleDefinition(2)!.maxHealth);
  assert.ok(vehicleDefinition(2, 2)!.maxSpeed > vehicleDefinition(2)!.maxSpeed * 1.7);
  for (const [type, variant] of [[1, 1], [2, 1], [3, 2], [0, 2], [3, 255]]) assert.equal(validVehicleVariant(type, variant), 0);
});
