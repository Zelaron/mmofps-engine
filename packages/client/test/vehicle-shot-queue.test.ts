import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FireEvent } from '@shared/protocol';
import { JEEP_MG } from '@shared/vehicles';
import { VehicleShotQueue } from '../src/vehicle-shot-queue.js';

function shot(seq: number): FireEvent {
  return { shooter: 4, weapon: JEEP_MG.id, seq, ox: seq, oy: 3, oz: -100,
    ends: [{ x: 20, y: 2, z: -200, hitKind: 0 }] };
}

test('vehicle reports wait for the current frame pose and cannot replay on later frames', () => {
  const queue = new VehicleShotQueue();
  for (let seq = 1; seq <= 20; seq++) queue.enqueue(shot(seq));
  assert.equal(queue.length, 8, 'a delayed frame cannot build an unlimited effect backlog');
  assert.deepEqual(queue.take().map(event => event.seq), [13, 14, 15, 16, 17, 18, 19, 20]);
  assert.equal(queue.length, 0);
  assert.deepEqual(queue.take(), [], 'rendering a second frame must not duplicate the shots');
  assert.equal(queue.take(), queue.take(), 'idle frames reuse the empty result');
});

test('lifecycle reset discards prior hull reports and accepts fresh shots after resuming', () => {
  const queue = new VehicleShotQueue();
  queue.enqueue(shot(1)); queue.enqueue(shot(2));
  queue.clear();
  assert.equal(queue.length, 0);
  assert.deepEqual(queue.take(), [], 'a focus, respawn or teleport reset must never fire at old endpoints');
  const resumed = shot(3);
  resumed.ox = 4000;
  queue.enqueue(resumed);
  const fresh = queue.take();
  assert.deepEqual(fresh, [resumed]);
  assert.equal(fresh[0].ox, 4000);
  queue.clear(); queue.clear();
  assert.deepEqual(queue.take(), []);
});
