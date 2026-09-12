import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SceneryScheduler } from '../src/render/scenery-scheduler.js';

test('expensive scenery rebuilds use separate frames without starving later pools', () => {
  let time = 0;
  const calls: { pool: number; x: number }[] = [];
  const scheduler = new SceneryScheduler(Array.from({ length: 4 }, (_, pool) => (x: number) => {
    calls.push({ pool, x }); time += 8;
  }), 3, () => time);
  for (let frame = 0; frame < 8; frame++) {
    scheduler.update(frame * 2.2, 0);
    assert.equal(calls.length, frame + 1, 'a costly cell crossing must not rebuild multiple scenery pools together');
    assert.deepEqual(calls[frame], { pool: frame % 4, x: frame * 2.2 },
      'deferred pools receive the latest camera position and run within four frames');
  }
});

test('stationary or inexpensive updates keep every scenery pool current in one frame', () => {
  let time = 0;
  const calls: number[] = [];
  const scheduler = new SceneryScheduler([0, 1, 2, 3].map(pool => () => {
    calls.push(pool); time += 0.1;
  }), 3, () => time);
  scheduler.update(4, 12);
  assert.deepEqual(calls, [0, 1, 2, 3]);
  scheduler.update(NaN, 12);
  assert.equal(calls.length, 4);
});
