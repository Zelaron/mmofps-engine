import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { createMoveState, stepMove, BTN, type InputCmd, type MoveState } from '@shared/movement';
import { TICK_DT, PLAYER } from '@shared/constants';
import { mulberry32 } from '@shared/rng';

function cmd(buttons: number, yaw = 0): InputCmd {
  return { seq: 0, buttons, weapon: 0, yaw, pitch: 0, renderTick: 0, renderFrac: 0 };
}

function settled(world: World): MoveState {
  const rng = mulberry32(77);
  const spawn = world.findSpawn(rng);
  const s = createMoveState(spawn.x, spawn.y, spawn.z);
  for (let i = 0; i < 90; i++) stepMove(world, s, cmd(0), TICK_DT);
  return s;
}

test('running reaches (about) run speed', () => {
  const world = new World(1337);
  const s = settled(world);
  for (let i = 0; i < 180; i++) stepMove(world, s, cmd(BTN.FORWARD), TICK_DT);
  const h = Math.hypot(s.vx, s.vz);
  assert.ok(h > PLAYER.RUN_SPEED * 0.6, `too slow: ${h.toFixed(2)} (terrain may slope, but not this much)`);
  assert.ok(h < PLAYER.RUN_SPEED * 1.35, `too fast: ${h.toFixed(2)}`);
});

test('jumping gains roughly the analytic apex height', () => {
  const world = new World(1337);
  const s = settled(world);
  const startY = s.py;
  let maxY = startY;
  let st = stepMove(world, s, cmd(BTN.JUMP), TICK_DT);
  assert.ok(st.jumped, 'jump should trigger from grounded');
  for (let i = 0; i < 60; i++) {
    stepMove(world, s, cmd(0), TICK_DT);
    maxY = Math.max(maxY, s.py);
  }
  const apex = PLAYER.JUMP_SPEED ** 2 / (2 * PLAYER.GRAVITY);
  const gained = maxY - startY;
  assert.ok(Math.abs(gained - apex) < 0.6, `apex ${gained.toFixed(2)} vs analytic ${apex.toFixed(2)}`);
});

test('dodge fires once and honors its cooldown', () => {
  const world = new World(1337);
  const s = settled(world);
  const r1 = stepMove(world, s, cmd(BTN.DODGE | BTN.FORWARD), TICK_DT);
  assert.ok(r1.dodged, 'first dodge fires');
  // land again, then immediately try to dodge - must be blocked by cooldown
  for (let i = 0; i < 30; i++) stepMove(world, s, cmd(0), TICK_DT);
  const r2 = stepMove(world, s, cmd(BTN.DODGE | BTN.FORWARD), TICK_DT);
  assert.ok(!r2.dodged, 'second dodge inside cooldown must not fire');
  assert.ok(s.dodgeCd > 0);
});

test('a long fall always registers its vertical impact speed', () => {
  const world = new World(1337);
  const rng = mulberry32(31);
  // Try several drop sites (flat or sloped - must not matter).
  for (let i = 0; i < 5; i++) {
    const spawn = world.findSpawn(rng);
    const s = createMoveState(spawn.x, spawn.y + 22, spawn.z);
    let maxImpact = 0;
    for (let t = 0; t < 300 && !s.grounded; t++) {
      const r = stepMove(world, s, cmd(0), TICK_DT);
      maxImpact = Math.max(maxImpact, r.impact);
    }
    // ~22m free fall -> sqrt(2*g*h) ≈ 32 m/s; allow slack for partial
    // slope contact on the way down, but it must be well past the
    // fall-damage threshold.
    assert.ok(s.grounded, `drop ${i} never landed`);
    assert.ok(maxImpact > PLAYER.FALL_DMG_MIN + 5,
      `drop ${i}: impact ${maxImpact.toFixed(1)} too small for a 22m fall`);
  }
});

test('dead players do not move', () => {
  const world = new World(1337);
  const s = settled(world);
  s.alive = false;
  const before = { x: s.px, y: s.py, z: s.pz };
  for (let i = 0; i < 30; i++) stepMove(world, s, cmd(BTN.FORWARD | BTN.JUMP), TICK_DT);
  assert.equal(s.px, before.x);
  assert.equal(s.py, before.y);
  assert.equal(s.pz, before.z);
});
