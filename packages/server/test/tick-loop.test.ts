import { test } from 'node:test';
import assert from 'node:assert/strict';
import { advanceTicks, advanceSynchronizedTicks, synchronizedWakeup } from '../src/tick-loop.js';

test('overloaded simulation yields after one expensive tick and discards old wall-clock debt', () => {
  let clock=2000,steps=0;
  const next=advanceTicks(0,1000/60,()=>{steps++;clock+=40;},()=>clock);
  assert.equal(steps,1);assert.equal(next,clock);
  assert.equal(advanceTicks(next,1000/60,()=>{steps++;clock+=2;},()=>clock),next+1000/60);
  assert.equal(steps,2,'socket event loop gets a turn between expensive batches');
});

test('healthy simulation retains exact fixed tick order with bounded catch-up', () => {
  let clock=50,steps=0;
  const next=advanceTicks(0,1000/60,()=>{steps++;},()=>clock);
  assert.equal(steps,4);assert.equal(next,1000/60*4);
  assert.equal(advanceTicks(next,1000/60,()=>{steps++;},()=>clock),next);
  assert.equal(steps,4);
});

test('a viable worker drains a pause backlog despite coarse host timers and yields between batches', () => {
  let clock = 0, tick = 0, recoveredAt = Infinity, ioTurns = 0;
  const simulated: number[] = [];
  const target = () => 120 + Math.floor(clock * .06);
  while (clock < 8000) {
    const before = tick;
    const debt = advanceSynchronizedTicks(() => tick, target, () => {
      simulated.push(++tick); clock += 9; return true;
    }, () => clock);
    if (debt === 0) recoveredAt = Math.min(recoveredAt, clock);
    const wait = synchronizedWakeup(debt, tick > before, (tick + 1 - (120 + clock * .06)) / .06);
    // Each callback gives queued I/O a turn. Host timers round up to 16ms;
    // an immediate does not impose that quantum on overdue work.
    ioTurns++;
    clock += wait === null ? 1 : Math.ceil(wait / 16) * 16;
  }
  assert.ok(recoveredAt < 4000, 'the 120-tick pause must be recovered with spare CPU capacity');
  assert.ok(target() - tick < 5);
  assert.ok(ioTurns > 400, 'catch-up does not become a synchronous unbounded loop');
  assert.deepEqual(simulated, Array.from({ length: tick }, (_, i) => i + 1), 'physics advances once per owed tick');
});

test('a paused authority sleeps until it can make progress and caught-up workers use the tick phase', () => {
  let tick = 40;
  const debt = advanceSynchronizedTicks(() => tick, () => 80, () => false);
  assert.equal(tick, 40);
  assert.equal(synchronizedWakeup(debt, false, 0), 1000 / 60, 'unavailable authority cannot spin on immediates');
  assert.equal(synchronizedWakeup(0, true, 3.25), 4, 'only the remaining fraction is slept');
  assert.equal(synchronizedWakeup(0, false, .01), 1, 'fractional deadlines avoid an early zero-delay loop');
  assert.equal(synchronizedWakeup(0, false, 1000), 17, 'a clock hold still polls within one frame');
});
