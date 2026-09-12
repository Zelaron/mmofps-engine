import type { DatabaseSync } from 'node:sqlite';
import { TICK_RATE } from '@shared/constants';
import type { PlanetId } from '@shared/universe';
import { NODE_TIMEOUT_MS } from './ownership-constants.js';

const RATE = TICK_RATE / 1000;
interface ClockRow { planet: PlanetId; tick: number; sampled_at: number; issued_until: number }

/** A clock reservation is committed before a worker receives its authority.
 * Recovery starts beyond every previously issued lease's clock horizon, even
 * after a host clock rollback. No old worker may simulate beyond that horizon.
 * The deliberate recovery gap is downtime, never skipped live physics ticks. */
export class PlanetClocks {
  private readonly origins = new Map<PlanetId, { tick: number; at: number }>();
  constructor(private readonly db: DatabaseSync, private readonly wall: () => number,
    private readonly monotonic: () => number) {
    db.exec(`CREATE TABLE IF NOT EXISTS planet_clocks (
      planet TEXT PRIMARY KEY, tick REAL NOT NULL, sampled_at REAL NOT NULL, issued_until REAL NOT NULL
    ) STRICT`);
    const at = monotonic(), wallNow = wall();
    for (const row of db.prepare('SELECT * FROM planet_clocks').all() as unknown as ClockRow[]) {
      this.origins.set(row.planet, { tick: Math.max(row.issued_until, row.tick + Math.max(0, wallNow - row.sampled_at) * RATE), at });
    }
  }
  reserve(planet: PlanetId): number {
    const at = this.monotonic();
    let origin = this.origins.get(planet);
    if (!origin) { origin = { tick: 0, at }; this.origins.set(planet, origin); }
    const tick = origin.tick + Math.max(0, at - origin.at) * RATE;
    this.db.prepare(`INSERT INTO planet_clocks(planet,tick,sampled_at,issued_until) VALUES(?,?,?,?)
      ON CONFLICT(planet) DO UPDATE SET tick=excluded.tick,sampled_at=excluded.sampled_at,
      issued_until=MAX(planet_clocks.issued_until,excluded.issued_until)`)
      .run(planet, tick, this.wall(), tick + NODE_TIMEOUT_MS * RATE);
    return tick;
  }
  sample(planet: PlanetId): number {
    const origin = this.origins.get(planet);
    return origin ? origin.tick + Math.max(0, this.monotonic() - origin.at) * RATE : 0;
  }
}

/** Midpoint clock sampling has RTT/2 uncertainty. Corrections can hold time
 * briefly but never rewind it; the scheduler consumes every intervening tick. */
export class SimulationClock {
  private originTick = 0;
  private originAt = 0;
  private latest = 0;
  private sampled = false;
  uncertaintyMs = Infinity;
  constructor(private readonly now: () => number = () => performance.now()) {}
  observe(tick: number, sentAt: number, receivedAt = this.now()): void {
    if (!Number.isFinite(tick) || tick < 0 || tick > Number.MAX_SAFE_INTEGER - TICK_RATE * 60 ||
      !Number.isFinite(sentAt) || !Number.isFinite(receivedAt) || receivedAt < sentAt) throw new Error('Invalid planetary clock sample');
    if (this.sampled) this.target();
    this.uncertaintyMs = (receivedAt - sentAt) / 2;
    this.originTick = tick + this.uncertaintyMs * RATE;
    this.originAt = receivedAt;
    this.sampled = true;
  }
  target(): number {
    this.estimate();
    return Math.floor(this.latest);
  }
  /** Schedule against the remaining fraction of the shared tick, including
   * a hold after backward correction, rather than sleeping a whole tick
   * after simulation work has already consumed part of that interval. */
  millisecondsUntil(tick: number): number {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new Error('Invalid planetary tick deadline');
    const projected = this.estimate();
    return tick <= this.latest ? 0 : (tick - projected) / RATE;
  }
  private estimate(): number {
    if (!this.sampled) throw new Error('Planetary clock has not been synchronized');
    const projected = this.originTick + Math.max(0, this.now() - this.originAt) * RATE;
    this.latest = Math.max(this.latest, projected);
    return projected;
  }
}
