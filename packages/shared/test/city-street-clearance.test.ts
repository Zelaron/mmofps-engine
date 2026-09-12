import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, createMoveState, stepMove, TICK_DT, BTN, capsuleClearance } from '@shared/index';

test('bridge supports join their decks while every central avenue crossing admits the largest ground hull', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed);
    for (const city of world.collectCities().filter(c => !c.theme)) {
      const floor = city.y + .06;
      for (const axis of ['x', 'z'] as const) for (const side of [-1, 1]) {
        const x = city.x + (axis === 'x' ? side * 128 : 0);
        const z = city.z + (axis === 'z' ? side * 128 : 0);
        // Half-metre sampling catches narrow posts that a4m grid can skip.
        for (let p = -14; p <= 14; p += .5) for (const lane of [-3, 0, 3]) {
          assert.ok(capsuleClearance(world, x + (axis === 'x' ? p : lane), floor + .03,
            z + (axis === 'z' ? p : lane)) > 0, `${city.name} main avenue has a support obstruction`);
        }
        const state = createMoveState(x - (axis === 'x' ? 18 : 0), floor + .1,
          z - (axis === 'z' ? 18 : 0));
        state.vehicle = 2; state.vehicleVariant = 2;
        state.heading = axis === 'x' ? -Math.PI / 2 : Math.PI;
        for (let tick = 0; tick < 480; tick++) stepMove(world, state, {
          seq: tick, buttons: BTN.FORWARD, yaw: state.heading, pitch: 0,
          weapon: 0, renderTick: 0, renderFrac: 0,
        }, TICK_DT);
        assert.ok((axis === 'x' ? state.px - x : state.pz - z) > 18,
          `${seed} ${city.name} siege hull could not cross beneath a bridge`);
        assert.ok(Math.abs(state.py - floor) < .12);
        for (const p of [-64, 64]) for (let arm = 0; arm <= 4.7; arm += .2) {
          const sx = city.x + (axis === 'x' ? side * 128 + arm : p);
          const sz = city.z + (axis === 'z' ? side * 128 + arm : p);
          assert.ok(world.sdf(sx, floor + 23.39, sz) < 0, 'sidewalk support fails to meet bridge underside');
        }
      }
    }
  }
});
