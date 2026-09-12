type SceneryUpdate = (x: number, z: number) => unknown;

/** Nearby instance sets overlap generously. Split their rebuilds over frames
 * so crossing a shared spatial boundary cannot rebuild every pool at once. */
export class SceneryScheduler {
  private next = 0;

  constructor(private readonly updates: readonly SceneryUpdate[], private readonly budgetMs = 3,
    private readonly now: () => number = () => performance.now()) {}

  update(x: number, z: number): void {
    if (!Number.isFinite(x + z) || this.updates.length === 0) return;
    const start = this.now();
    for (let i = 0; i < this.updates.length; i++) {
      const index = this.next;
      this.next = (index + 1) % this.updates.length;
      this.updates[index](x, z);
      if (this.now() - start >= this.budgetMs) break;
    }
  }
}
