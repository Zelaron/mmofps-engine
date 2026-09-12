/** Bound each callback so sockets, pings and browser input remain serviceable
 * even if world generation or one unusually expensive tick runs over budget. */
export function advanceTicks(nextAt: number, tickMs: number, step: () => void,
  now: () => number = () => performance.now()): number {
  const started = now();
  let steps = 0;
  while (now() >= nextAt && steps < 4) {
    step(); nextAt += tickMs; steps++;
    if (now() - started >= 8) break;
  }
  const ended = now();
  // Preserve simulation tick order; discard old wall-clock debt only.
  return ended - nextAt > tickMs * 4 ? ended : nextAt;
}

export const MAX_CLOCK_DEBT_TICKS = 5 * 60;
export class SimulationOverload extends Error {
  constructor(readonly debt: number) { super(`Simulation fell ${debt} ticks behind the planetary clock`); }
}

/** Universe workers share a target clock. Yield after four ticks or eight ms,
 * retaining all outstanding work. A worker that cannot catch up must restart
 * from durable state; jumping its clock would skip collisions and combat. */
export function advanceSynchronizedTicks(current: () => number, target: () => number,
  step: () => boolean, now: () => number = () => performance.now()): number {
  const started = now();
  for (let steps = 0; steps < 4; steps++) {
    const debt = target() - current();
    if (debt > MAX_CLOCK_DEBT_TICKS) throw new SimulationOverload(debt);
    if (debt <= 0 || !step()) break;
    if (now() - started >= 8) break;
  }
  return Math.max(0, target() - current());
}

/** null requests an event-loop yield, not another timer. A nominal 1 ms
 * timer can take most of a tick on some hosts and prevent otherwise viable
 * simulation work from draining its backlog. Paused authorities still sleep
 * so they cannot spin while waiting for coordinator/camp recovery. */
export function synchronizedWakeup(debt: number, progressed: boolean, untilNextTick: number): number | null {
  if (debt > 0) return progressed ? null : 1000 / 60;
  return Math.max(1, Math.ceil(Math.min(1000 / 60, untilNextTick)));
}
