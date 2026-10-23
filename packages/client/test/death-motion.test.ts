import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TraceHit, World } from '@shared/worldgen';
import { createCorpseMotion, stepCorpseMotion } from '../src/death-motion.js';

/** Exact planes isolate corpse collision from generated terrain. */
function room(wallX = Infinity): Pick<World, 'trace'> {
  return { trace(x, y, z, dx, dy, dz, max): TraceHit {
    let distance = max, normal = { nx: 0, ny: 0, nz: 0 }, hit = false;
    const floor = dy < 0 ? -y / dy : Infinity;
    if (floor >= 0 && floor <= distance) { distance = floor; normal = { nx: 0, ny: 1, nz: 0 }; hit = true; }
    const wall = dx > 0 ? (wallX - x) / dx : Infinity;
    if (wall >= 0 && wall <= distance) { distance = wall; normal = { nx: -1, ny: 0, nz: 0 }; hit = true; }
    return { hit, dist: distance, x: x + dx * distance, y: y + dy * distance, z: z + dz * distance, ...normal };
  } };
}
const stationary = { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, yaw: 0 };

test('an ordinary death falls onto the ground and settles without sinking', () => {
  const body = createCorpseMotion(stationary), world = room();
  for (let frame = 0; frame < 300; frame++) {
    stepCorpseMotion(body, world, 1 / 60);
    assert.ok(body.y >= .36, `frame ${frame}: the body remains above the floor`);
  }
  assert.ok(body.grounded); assert.equal(body.vy, 0);
  assert.ok(Math.abs(body.y - .37) < .02); assert.equal(body.x, 0);
});

test('a lethal explosive impulse produces visible airborne motion before the map', () => {
  const normal = createCorpseMotion(stationary);
  const blast = createCorpseMotion({ ...stationary, vx: 18, vy: 14, vz: -8 });
  for (let frame = 0; frame < 60; frame++) {
    stepCorpseMotion(normal, room(), 1 / 60); stepCorpseMotion(blast, room(), 1 / 60);
  }
  assert.equal(normal.airborne, false); assert.equal(blast.airborne, true);
  assert.ok(blast.y > normal.y + 4); assert.ok(Math.hypot(blast.x, blast.z) > 18);
  assert.equal(stationary.y, 0, 'cosmetic simulation does not mutate authoritative state');
});

test('a fast corpse sweep stops at a wall instead of tunneling through it', () => {
  const body = createCorpseMotion({ ...stationary, y: 4, vx: 100, vy: 8 });
  for (let frame = 0; frame < 60; frame++) {
    stepCorpseMotion(body, room(3), .05);
    assert.ok(body.x <= 2.64, 'the body retains clearance from the wall');
    assert.ok(body.y >= .36);
  }
  assert.ok(body.grounded); assert.ok(Math.abs(body.vx) < .01);
});

test('a resting corpse falls when its supporting platform moves away', () => {
  const body = createCorpseMotion(stationary);
  for (let frame = 0; frame < 120; frame++) stepCorpseMotion(body, room(), 1 / 60);
  const before = body.y;
  const open: Pick<World, 'trace'> = { trace: (x, y, z, dx, dy, dz, dist) => ({
    hit: false, dist, x: x + dx * dist, y: y + dy * dist, z: z + dz * dist, nx: 0, ny: 0, nz: 0,
  }) };
  for (let frame = 0; frame < 30; frame++) stepCorpseMotion(body, open, 1 / 60);
  assert.equal(body.grounded, false); assert.ok(body.y < before - 1);
});
