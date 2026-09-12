import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAureliaPlan, AURELIA_RADIUS } from '../src/aurelia-city.js';
import { capitalSegments, capitalSegmentDistance } from '../src/capital-geometry.js';
import { sdBox } from '../src/sdf.js';
import type { CityDistrict } from '../src/cities.js';
import { World } from '../src/worldgen.js';
import { createMoveState, stepMove, BTN } from '../src/movement.js';
import { TICK_DT } from '../src/constants.js';

const city = (seed: number): CityDistrict => ({ id: 3, seed, x: 6144, y: 38, z: 4096, radius: AURELIA_RADIUS, theme: 'aurelia', name: 'Aurelia Bastion' });

test('Aurelia has a bounded irregular colossal skyline with canonical arches and domes', () => {
  for (const seed of [1, 1337, 424242]) {
    const c = city(seed), plan = buildAureliaPlan(c);
    assert.equal(plan, buildAureliaPlan(c));
    assert.ok(plan.solids.length > 500 && plan.solids.length < 1200);
    assert.ok(plan.sweeps.length > 400 && plan.sweeps.length < 850);
    assert.ok(plan.solids.every(b => b.capital && Math.min(b.hx, b.hy, b.hz) >= .2));
    assert.equal(new Set(plan.sweeps.map(s => s.id)).size, plan.sweeps.length);
    const heights = new Set(plan.sweeps.filter(s => s.kind === 'spire').map(s => Math.round(Math.max(...s.points.map(p => p.y)) - c.y)));
    assert.ok(heights.size > 50, 'skyline heights must not collapse into repeated roofs');
    const top = Math.max(...plan.sweeps.flatMap(s => s.points.map(p => p.y + p.radius))) - c.y;
    assert.ok(top > 1350 && top < 1500);
    for (const kind of ['dome', 'arch', 'rib']) assert.ok(plan.sweeps.filter(s => s.kind === kind).length >= 25);
  }
});

test('Aurelia lift shafts, supported rewards and processional tank lanes remain clear', () => {
  for (const seed of [1, 1337, 424242]) {
    const c = city(seed), p = buildAureliaPlan(c), ground = c.y + .06;
    const field = (x: number, y: number, z: number): number => {
      let d = y - ground;
      for (const b of p.solids) d = Math.min(d, sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz));
      for (const s of capitalSegments(p, x, x, z, z)) d = Math.min(d, capitalSegmentDistance(s, x, y, z));
      return d;
    };
    for (const l of p.lifts) {
      for (let y = l.bottom + .8; y < l.top + 2; y += 2)
        assert.ok(field(l.x, y, l.z) >= .38, `seed${seed} lift${l.id} blocked at${y-ground}`);
      // Both stops have nearby continuous ring floor to step off onto.
      for (const y of [l.bottom, l.top]) assert.ok(field(l.x + 6.5, y - .08, l.z) < 0 || field(l.x - 6.5, y - .08, l.z) < 0);
    }
    for (const r of p.rewards) for (const dx of [0, 1.7, -1.7]) {
      assert.ok(field(r.x + dx, r.y - .08, r.z) < 0, 'reward lacks a real floor');
      assert.ok(field(r.x + dx, r.y + 1, r.z) > .5, 'reward approach obstructed');
    }
    const tank = p.vehicles[0]; assert.equal(tank.type, 2); assert.equal(tank.variant, 2);
    for (let x = c.x - 1650; x < c.x + 1650; x += 24) for (const lateral of [-18, 0, 18])
      assert.ok(field(x, ground + 4, c.z + lateral) > 2, 'processional avenue cannot fit the tank');
    for (const dx of [-30, 0, 30]) for (const dz of [-30, 0, 30]) assert.ok(field(tank.x + dx, tank.y + 4, tank.z + dz) > 2);
  }
});

test('a player can stand on and cross the upper reward deck cell seam in both directions', () => {
  const world = new World(1337), c = world.collectCities().find(c => c.theme === 'aurelia')!;
  const reward = buildAureliaPlan(c).rewards[0], state = createMoveState(reward.x, reward.y + .006, reward.z);
  state.grounded = true;
  for (let tick = 0; tick < 120; tick++) stepMove(world, state, { seq: tick, buttons: 0, yaw: 0, pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
  assert.ok(Math.abs(state.py - reward.y - .006) < .025 && state.grounded, 'standing on a generation-cell seam loses support');
  for (const target of [reward.x + 20, reward.x - 20, reward.x]) {
    for (let tick = 0; tick < 500 && Math.abs(state.px - target) > .2; tick++) {
      stepMove(world, state, { seq: tick, buttons: BTN.FORWARD, yaw: target > state.px ? -Math.PI / 2 : Math.PI / 2,
        pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
      assert.ok(Math.abs(state.py - reward.y - .006) < .035, 'crossing a generation-cell seam drops through the deck');
    }
    assert.ok(Math.abs(state.px - target) < .25);
  }
});
