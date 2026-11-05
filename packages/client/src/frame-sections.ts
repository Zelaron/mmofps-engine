/** Where the time went in frames that ran long. The frame loop marks the end
 * of each major section; only frames over the threshold are kept, in a small
 * ring, so the cost is a few clock reads per frame. Exposed through the debug
 * handle for automated hitch checks and for diagnosing reports from players. */
export interface LongFrame { at: number; ms: number; sections: Record<string, number> }

export class FrameSections {
  private readonly names: string[] = [];
  private readonly times = new Float64Array(64);
  private count = 0;
  private start = 0;
  private last = 0;
  private readonly ring: LongFrame[] = [];

  constructor(private readonly threshold = 34, private readonly capacity = 80,
    private readonly now: () => number = () => performance.now()) {}

  begin(): void { this.start = this.last = this.now(); this.count = 0; }

  mark(name: string): void {
    if (this.count >= this.times.length) return;
    const t = this.now();
    this.names[this.count] = name; this.times[this.count++] = t - this.last; this.last = t;
  }

  end(): void {
    const total = this.now() - this.start;
    if (total < this.threshold) return;
    const sections: Record<string, number> = {};
    for (let i = 0; i < this.count; i++) {
      const ms = this.times[i];
      if (ms >= .5) sections[this.names[i]] = Math.round((sections[this.names[i]] ?? 0) + ms);
    }
    const rest = total - (this.last - this.start);
    if (rest >= .5) sections.rest = Math.round(rest);
    this.ring.push({ at: Math.round(this.start), ms: Math.round(total), sections });
    if (this.ring.length > this.capacity) this.ring.shift();
  }

  /** Long frames since `after` (a performance.now() timestamp). */
  since(after = -Infinity): LongFrame[] { return this.ring.filter(frame => frame.at > after); }
}

/** The frame loop's recorder; subsystems may mark finer sections inside it. */
export const frameSections = new FrameSections();
