import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkerSlices, type WorkerSliceClock, type WorkerSliceStats } from '../src/render/worker-slices.js';
const unexpected = (value: unknown): never => assert.fail(String(value));

class Clock implements WorkerSliceClock {
  time = 0;
  private nextId = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now() { return this.time; }
  schedule(callback: () => void, delay: number) {
    const id = ++this.nextId; this.pending.set(id, { at: this.time + delay, callback }); return id;
  }
  clear(handle: unknown) { this.pending.delete(handle as number); }
  next() {
    const entry = [...this.pending].sort((a, b) => a[1].at - b[1].at)[0];
    assert(entry); this.pending.delete(entry[0]); this.time = Math.max(this.time, entry[1].at); entry[1].callback();
  }
  drain() { for (let i = 0; this.pending.size; i++) { assert(i < 1000, 'bounded scheduled work'); this.next(); } }
}

test('cooperative slices preserve order and atomic output, with separate active/background rest accounting', () => {
  const clock = new Clock(), visited: number[] = [], value = { complete: true };
  let finished: { value: typeof value; stats: WorkerSliceStats } | undefined;
  function* steps() { for (const cost of [1, 1, 1, 1, 1, 2]) { clock.time += cost; visited.push(cost); yield; } return value; }
  runWorkerSlices(steps(), { clock, complete: (value, stats) => { finished = { value, stats }; }, error: unexpected });
  assert.deepEqual(visited, [], 'first work waits for the actual event loop');
  clock.next();
  assert.deepEqual(visited, [1, 1, 1, 1]); assert.equal(finished, undefined);
  assert.equal([...clock.pending.values()][0].at, 16, 'four active milliseconds rest twelve');
  clock.next();
  assert.equal(finished, undefined, 'even complete work pays its final rest before releasing the job');
  clock.drain();
  assert.equal(finished!.value, value);
  assert.deepEqual(finished!.stats, { workMs: 7, elapsedMs: 28, maxSliceMs: 4, slices: 2, paced: true });
});

test('urgent coverage rests one active duration and reports an indivisible cold overrun honestly', () => {
  for (const urgentCoverage of [false, true]) {
    const clock = new Clock(); let stats: WorkerSliceStats | undefined;
    function* steps(): Generator<void, number, void> { clock.time += 23; return 42; }
    runWorkerSlices(steps(), { clock, urgentCoverage,
      complete(value, timing) { assert.equal(value, 42); stats = timing; }, error: unexpected });
    clock.drain();
    assert.equal(stats!.workMs, 23); assert.equal(stats!.maxSliceMs, 23);
    assert.equal(stats!.elapsedMs, urgentCoverage ? 46 : 92);
  }
});

test('tiny completed jobs still yield a real timer before another request can run', () => {
  const clock = new Clock(); let complete = false;
  function* steps(): Generator<void, number, void> { clock.time += .25; return 1; }
  runWorkerSlices(steps(), { clock, complete() { complete = true; }, error: unexpected });
  clock.next(); assert.equal(complete, false);
  assert.equal([...clock.pending.values()][0].at, 1.25);
  clock.next(); assert.equal(complete, true);
});

test('cancellation closes paused work and suppresses both later slices and completed-but-resting delivery', () => {
  for (const done of [false, true]) {
    const clock = new Clock(); let closed = false, completed = false;
    function* steps(): Generator<void, number, void> {
      try { clock.time += 4; if (!done) yield; return 1; } finally { closed = true; }
    }
    const job = runWorkerSlices(steps(), { clock, complete() { completed = true; }, error: unexpected });
    clock.next(); job.cancel(); job.cancel(); clock.drain();
    assert.equal(closed, true); assert.equal(completed, false); assert.equal(clock.pending.size, 0);
  }
  const clock = new Clock(); let ran = false;
  function* never(): Generator<void, number, void> { ran = true; return 1; }
  const job = runWorkerSlices(never(), { clock, complete: unexpected, error: unexpected });
  job.cancel(); clock.drain(); assert.equal(ran, false);
});

test('iterator errors report once without a stale completion or a remaining wake', () => {
  const clock = new Clock(), expected = new Error('failed native cell'); let received: unknown;
  function* steps(): Generator<void, number, void> { clock.time += 5; yield; throw expected; }
  runWorkerSlices(steps(), { clock, complete: unexpected, error(error) { received = error; } });
  clock.drain(); assert.equal(received, expected); assert.equal(clock.pending.size, 0);
});

test('replacement work retains the cancelled slice rest even when newly marked urgent', () => {
  const clock = new Clock(), pacer = { readyAt: 0 }; let replacementStarted = -1;
  function* old(): Generator<void, number, void> { clock.time += 7; yield; return 0; }
  const first = runWorkerSlices(old(), { clock, pacer, complete: unexpected, error: unexpected });
  clock.next(); assert.equal(pacer.readyAt, 28); first.cancel();
  function* next(): Generator<void, number, void> { replacementStarted = clock.now(); return 1; }
  runWorkerSlices(next(), { clock, pacer, urgentCoverage: true, complete() {}, error: unexpected });
  assert.equal([...clock.pending.values()][0].at, 28);
  clock.next(); assert.equal(replacementStarted, 28, 'new urgency cannot erase previously owed background rest');
  clock.drain();
});

test('paused slices resume accumulated work behind the shared worker rest without background draining', () => {
  const clock = new Clock(), pacer = { readyAt: 0 }, visited: string[] = [];
  let stats: WorkerSliceStats | undefined;
  function* a() { visited.push('a1'); clock.time += 5; yield;
    visited.push('a2'); clock.time += 3; return 'a'; }
  const first = runWorkerSlices(a(), { clock, pacer,
    complete(value, timing) { assert.equal(value, 'a'); stats = timing; }, error: unexpected });
  clock.next(); first.pause(); assert.equal(pacer.readyAt, 20); assert.equal(clock.pending.size, 0);
  function* b(): Generator<void, string, void> { visited.push('b'); clock.time += 7; return 'b'; }
  runWorkerSlices(b(), { clock, pacer, urgentCoverage: true, complete() {}, error: unexpected });
  clock.drain(); assert.deepEqual(visited, ['a1', 'b']); assert.equal(clock.time, 34);
  first.resume(true); clock.drain();
  assert.deepEqual(visited, ['a1', 'b', 'a2']);
  assert.deepEqual(stats, { workMs: 8, elapsedMs: 40, maxSliceMs: 5, slices: 2, paced: true });
});

test('a paused completed result survives final rest and can never bypass later worker debt', () => {
  for (const value of [undefined, { retained: true }]) {
    const clock = new Clock(), pacer = { readyAt: 0 }; let runs = 0, delivered = false;
    function* done(): Generator<void, typeof value, void> { runs++; clock.time += 7; return value; }
    const first = runWorkerSlices(done(), { clock, pacer,
      complete(result, stats) { assert.equal(result, value); assert.equal(stats.workMs, 7); delivered = true; }, error: unexpected });
    clock.next(); first.pause(); assert.equal(pacer.readyAt, 28);
    function* other(): Generator<void, number, void> { clock.time += 2; return 2; }
    runWorkerSlices(other(), { clock, pacer, complete() {}, error: unexpected });
    clock.next(); assert.equal(clock.time, 30); assert.equal(pacer.readyAt, 36);
    first.resume(true);
    assert.equal(delivered, false); assert.equal(runs, 1);
    clock.drain(); assert.equal(clock.time, 36); assert.equal(delivered, true); assert.equal(runs, 1);
  }
});

test('discarding paused work closes its iterator and cannot be resumed', () => {
  const clock = new Clock(); let closed = 0;
  function* steps(): Generator<void, number, void> { try { clock.time += 5; yield; return 1; } finally { closed++; } }
  const job = runWorkerSlices(steps(), { clock, complete: unexpected, error: unexpected });
  clock.next(); job.pause(); job.cancel(); job.resume(); job.cancel(); clock.drain();
  assert.equal(closed, 1); assert.equal(clock.pending.size, 0);
});

test('ordinary own-timer wakes do not add a second rest for clock quantization', () => {
  const clock = new Clock(), pacer = { readyAt: 0 }; let advanced = 0;
  function* steps() { advanced++; clock.time += 4; yield; advanced++; clock.time += 1; return 1; }
  runWorkerSlices(steps(), { clock, pacer, complete() {}, error: unexpected });
  clock.next(); assert.equal(advanced, 1); assert.equal(pacer.readyAt, 16);
  const [id, wake] = [...clock.pending][0]; clock.pending.delete(id);
  clock.time = wake.at - .25; wake.callback();
  assert.equal(advanced, 2, 'a slightly early/coarsened own-clock reading must not schedule another rest');
  assert.equal(pacer.readyAt, 19.75);
  clock.drain();
});

test('initial, resumed and externally extended debt still wait despite an early timer', () => {
  const clock = new Clock(), pacer = { readyAt: 10 }; let advanced = 0;
  function* steps() { advanced++; clock.time += 4; yield; advanced++; clock.time += 1; return 1; }
  const job = runWorkerSlices(steps(), { clock, pacer, complete() {}, error: unexpected });
  const early = () => { const [id, wake] = [...clock.pending][0]; clock.pending.delete(id);
    clock.time = wake.at - .25; wake.callback(); };
  early(); assert.equal(advanced, 0, 'initial work cannot ignore inherited rest');
  clock.next(); assert.equal(advanced, 1);
  // A different job has increased this worker's rest since the own wake was
  // scheduled. That is distinct from clock quantization of our own deadline.
  pacer.readyAt += 7;
  clock.next(); assert.equal(advanced, 1);
  job.pause(); job.resume(true); early();
  assert.equal(advanced, 1, 'resuming with higher urgency cannot erase the retained rest');
  clock.drain(); assert.equal(advanced, 2);
});
