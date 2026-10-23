export interface WorkerSliceStats {
  /** Active generation time, excluding every scheduled rest. */
  workMs: number;
  /** Wall time since creation, including any explicit pause. */
  elapsedMs: number;
  maxSliceMs: number;
  slices: number;
  paced: true;
}

export interface WorkerSliceClock {
  now(): number;
  schedule(callback: () => void, delay: number): unknown;
  clear(handle: unknown): void;
}

/** Owned by one worker, so cancelled jobs cannot discard their owed rest. */
export interface WorkerSlicePacer { readyAt: number }

export interface WorkerSliceTask {
  cancel(): void;
  /** Retain the iterator and any completed result without running it. */
  pause(): void;
  resume(urgentCoverage?: boolean): void;
}

interface SliceOptions<T> {
  urgentCoverage?: boolean;
  complete(value: T, stats: WorkerSliceStats): void;
  error(error: unknown): void;
  clock?: WorkerSliceClock;
  pacer?: WorkerSlicePacer;
}

const browserClock: WorkerSliceClock = {
  now: () => performance.now(),
  schedule: (callback, delay) => setTimeout(callback, delay),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const ACTIVE_BUDGET_MS = 4;

/** Cooperative canonical work: one indivisible iterator step may exceed the
 * budget, so report the actual maximum rather than promise a hard deadline.
 * Even the last slice rests before releasing its result; many small jobs
 * therefore cannot bypass the same local worker duty cycle. */
export function runWorkerSlices<T>(steps: Iterator<void, T, void>, options: SliceOptions<T>): WorkerSliceTask {
  const clock = options.clock ?? browserClock, started = clock.now();
  const pacer = options.pacer ?? { readyAt: 0 };
  let timer: unknown, stopped = false, paused = false, workMs = 0, maxSliceMs = 0, slices = 0;
  let urgent = options.urgentCoverage === true;
  let finished: { value: T } | undefined;
  let scheduledDebt = pacer.readyAt, checkDebt = true;
  const schedule = (delay: number, check: boolean) => {
    scheduledDebt = pacer.readyAt; checkDebt = check;
    timer = clock.schedule(run, delay);
  };
  const cancel = () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clock.clear(timer);
    timer = undefined; finished = undefined;
    steps.return?.();
  };
  const run = () => {
    timer = undefined;
    if (stopped || paused) return;
    const wait = pacer.readyAt - clock.now();
    // Ordinary slices retain their original timer-wake behavior. Browser
    // clocks can be coarsened relative to timers: rechecking our own deadline
    // on every wake adds a second rest. Initial/resumed work must still pay
    // inherited debt, and another task can extend a previously scheduled debt.
    if ((checkDebt || pacer.readyAt > scheduledDebt) && wait > 0) { schedule(wait, true); return; }
    if (finished) {
      stopped = true;
      const value = finished.value; finished = undefined;
      options.complete(value, { workMs, elapsedMs: Math.max(0, clock.now() - started), maxSliceMs, slices, paced: true });
      return;
    }
    const begin = clock.now();
    let result: IteratorResult<void, T>;
    try {
      do { result = steps.next(); }
      while (!result.done && clock.now() - begin < ACTIVE_BUDGET_MS);
    } catch (error) {
      stopped = true;
      try { steps.return?.(); } catch { /* Preserve the original generator failure. */ }
      options.error(error); return;
    }
    const active = Math.max(0, clock.now() - begin);
    workMs += active; maxSliceMs = Math.max(maxSliceMs, active); slices++;
    const rest = Math.max(1, active * (urgent ? 1 : 3));
    pacer.readyAt = clock.now() + rest;
    if (result.done) finished = { value: result.value };
    schedule(rest, false);
  };
  // A pending initialization/replacement message can cancel before first work.
  schedule(Math.max(0, pacer.readyAt - clock.now()), true);
  return { cancel,
    pause() {
      if (stopped || paused) return;
      paused = true;
      if (timer !== undefined) clock.clear(timer);
      timer = undefined;
    },
    resume(urgentCoverage = urgent) {
      if (stopped || !paused) return;
      paused = false; urgent = urgentCoverage;
      schedule(Math.max(0, pacer.readyAt - clock.now()), true);
    },
  };
}
