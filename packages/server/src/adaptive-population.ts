/** Population is a load control, never a change to the fixed simulation clock.
 * Counters are cumulative loop work/ticks; observe may be called every batch. */
export interface PopulationObservation {
  nowMs: number;
  workMs: number;
  ticks: number;
  debt: number;
  population: number;
}

export type PopulationReason = 'warming' | 'stable' | 'reset' | 'no-progress' |
  'sustained-work' | 'sustained-debt' | 'emergency-debt' | 'recovery';

export interface AdaptivePopulationStatus {
  maximum: number;
  minimum: number;
  target: number;
  population: number;
  reason: PopulationReason;
  meanTickWorkMs: number | null;
  windowMs: number;
  sampledTicks: number;
  debt: number;
  heavyForMs: number;
  debtForMs: number;
  healthyForMs: number;
  lastChangeAtMs: number | null;
}

export interface AdaptivePopulationUpdate extends AdaptivePopulationStatus { changed: boolean }

const WINDOW_MS = 1000;
const DECREASE_INTERVAL_MS = 2000;
const RECOVERY_MS = 20_000;

/** Independent per-world controller. Actual retirement/admission remains with
 * the server, which may temporarily retain protected bots above this target. */
export class AdaptivePopulation {
  readonly maximum: number;
  readonly minimum: number;
  private readonly decrease: number;
  private readonly increase: number;
  private previous?: PopulationObservation;
  private windowStart?: PopulationObservation;
  private minimumDebt = Infinity;
  private maximumDebt = 0;
  private state: AdaptivePopulationStatus;

  constructor(maximum = 192) {
    if (!Number.isSafeInteger(maximum) || maximum < 0) throw new RangeError('Invalid population maximum');
    this.maximum = maximum;
    this.minimum = Math.min(maximum, Math.max(48, Math.ceil(maximum / 2)));
    this.decrease = Math.max(1, Math.ceil(maximum / 8));
    this.increase = Math.max(1, Math.ceil(maximum / 32));
    this.state = { maximum, minimum: this.minimum, target: maximum, population: 0,
      reason: 'warming', meanTickWorkMs: null, windowMs: 0, sampledTicks: 0, debt: 0,
      heavyForMs: 0, debtForMs: 0, healthyForMs: 0, lastChangeAtMs: null };
  }

  get target(): number { return this.state.target; }
  /** A detached snapshot: health/log consumers cannot change controller state. */
  get status(): AdaptivePopulationStatus { return { ...this.state }; }

  observe(sample: PopulationObservation): AdaptivePopulationUpdate {
    const valid = Number.isFinite(sample.nowMs) && sample.nowMs >= 0 &&
      Number.isFinite(sample.workMs) && sample.workMs >= 0 &&
      Number.isSafeInteger(sample.ticks) && sample.ticks >= 0 &&
      Number.isSafeInteger(sample.debt) && sample.debt >= 0 &&
      Number.isSafeInteger(sample.population) && sample.population >= 0;
    if (!valid) {
      this.previous = this.windowStart = undefined;
      this.clearEvidence();
      this.state.reason = 'reset';
      this.state.meanTickWorkMs = null;
      this.state.windowMs = this.state.sampledTicks = 0;
      return this.result(false);
    }

    this.state.population = sample.population;
    this.state.debt = sample.debt;
    const previous = this.previous;
    if (!previous || sample.nowMs < previous.nowMs || sample.workMs < previous.workMs || sample.ticks < previous.ticks) {
      this.previous = this.windowStart = { ...sample };
      this.minimumDebt = this.maximumDebt = sample.debt;
      this.clearEvidence();
      this.state.reason = previous ? 'reset' : 'warming';
      this.state.meanTickWorkMs = null;
      this.state.windowMs = this.state.sampledTicks = 0;
      // A restarted clock must not preserve a cooldown timestamp in its future.
      if (this.state.lastChangeAtMs !== null && sample.nowMs < this.state.lastChangeAtMs)
        this.state.lastChangeAtMs = sample.nowMs;
      return this.result(false);
    }
    this.previous = { ...sample };
    this.minimumDebt = Math.min(this.minimumDebt, sample.debt);
    this.maximumDebt = Math.max(this.maximumDebt, sample.debt);
    const start = this.windowStart!;
    const elapsed = sample.nowMs - start.nowMs;
    if (elapsed < WINDOW_MS) return this.result(false);

    const ticks = sample.ticks - start.ticks;
    const mean = ticks > 0 ? (sample.workMs - start.workMs) / ticks : null;
    const minimumDebt = this.minimumDebt, maximumDebt = this.maximumDebt;
    this.windowStart = { ...sample };
    this.minimumDebt = this.maximumDebt = sample.debt;
    this.state.windowMs = elapsed;
    this.state.sampledTicks = ticks;
    this.state.meanTickWorkMs = mean;
    if (mean === null) {
      this.clearEvidence();
      this.state.reason = 'no-progress';
      return this.result(false);
    }

    this.state.heavyForMs = mean > 14 ? this.state.heavyForMs + elapsed : 0;
    // An end-of-window spike is not sustained debt. A falling backlog also
    // breaks this run: a worker already catching up needs no debt-only cut.
    this.state.debtForMs = minimumDebt > 8 && sample.debt >= start.debt ? this.state.debtForMs + elapsed : 0;
    // Cheap but rarely advancing ticks are not spare capacity (for example
    // after an authority pause). Only normal progress can earn recovery time.
    this.state.healthyForMs = mean <= 11 && maximumDebt <= 2 && ticks * 1000 / elapsed >= 50 && sample.population <= this.target
      ? this.state.healthyForMs + elapsed : 0;
    const sinceChange = this.state.lastChangeAtMs === null ? Infinity : sample.nowMs - this.state.lastChangeAtMs;
    const emergency = sample.debt >= 60;
    const work = this.state.heavyForMs >= DECREASE_INTERVAL_MS;
    const debt = this.state.debtForMs >= DECREASE_INTERVAL_MS;
    this.state.reason = 'stable';
    if ((emergency && sinceChange >= WINDOW_MS) || ((work || debt) && sinceChange >= DECREASE_INTERVAL_MS)) {
      this.state.reason = emergency ? 'emergency-debt' : work ? 'sustained-work' : 'sustained-debt';
      const target = Math.max(this.minimum, this.target - this.decrease);
      if (target !== this.target) return this.change(target, sample.nowMs);
    } else if (this.state.healthyForMs >= RECOVERY_MS && sinceChange >= RECOVERY_MS && this.target < this.maximum) {
      this.state.reason = 'recovery';
      return this.change(Math.min(this.maximum, this.target + this.increase), sample.nowMs);
    }
    return this.result(false);
  }

  private clearEvidence(): void {
    this.state.heavyForMs = this.state.debtForMs = this.state.healthyForMs = 0;
  }
  private change(target: number, nowMs: number): AdaptivePopulationUpdate {
    this.state.target = target;
    this.state.lastChangeAtMs = nowMs;
    this.clearEvidence();
    return this.result(true);
  }
  private result(changed: boolean): AdaptivePopulationUpdate { return { ...this.state, changed }; }
}
