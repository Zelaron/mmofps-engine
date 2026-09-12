import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VEHICLE } from '@shared/index';
import { vehicleAttitude } from '../src/render/vehicles.js';

// Cosmetic hull attitude: pure function of (velocity, heading), so every
// client tilts a hull identically with zero extra netcode.

test('a hull driving level stays level', () => {
  const att = vehicleAttitude(VEHICLE.JEEP, 0, 0, -15, 0);
  assert.ok(Math.abs(att.pitch) < 1e-9, `pitch ${att.pitch}`);
  assert.ok(Math.abs(att.roll) < 1e-9, `roll ${att.roll}`);
});

test('flying off a cliff noses the hull down; climbing noses it up', () => {
  const falling = vehicleAttitude(VEHICLE.JEEP, 0, -20, -15, 0);
  assert.ok(falling.pitch < -0.4, `expected steep nose-down, got ${falling.pitch}`);

  const climbing = vehicleAttitude(VEHICLE.JEEP, 0, 8, -15, 0);
  assert.ok(climbing.pitch > 0.3, `expected nose-up, got ${climbing.pitch}`);
});

test('a plummeting hull pegs at the nose-down clamp instead of blowing up', () => {
  const plummet = vehicleAttitude(VEHICLE.JEEP, 0, -40, 0.1, 0);
  assert.ok(plummet.pitch < -0.7 && plummet.pitch >= -0.76, `pitch ${plummet.pitch}`);
});

test('lateral slide rolls the body outward, clamped', () => {
  // Heading 0 = forward along -Z; +X is the hull's right side. Sliding
  // right dips the right side (negative roll).
  const slide = vehicleAttitude(VEHICLE.JEEP, 6, 0, -15, 0);
  assert.ok(slide.roll < -0.1, `roll ${slide.roll}`);
  const hard = vehicleAttitude(VEHICLE.JEEP, 25, 0, -15, 0);
  assert.ok(hard.roll >= -0.31, `roll must clamp, got ${hard.roll}`);
});

test('tanks tilt roughly half as much as jeeps', () => {
  const jeep = vehicleAttitude(VEHICLE.JEEP, 0, -20, -15, 0);
  const tank = vehicleAttitude(VEHICLE.TANK, 0, -20, -15, 0);
  assert.ok(Math.abs(tank.pitch) < Math.abs(jeep.pitch) * 0.7);
});

test('a barely-moving hull does not twitch', () => {
  const att = vehicleAttitude(VEHICLE.JEEP, 0.5, -0.5, 0.5, 0);
  assert.equal(att.pitch, 0);
  assert.equal(att.roll, 0);
});
