import type { FireEvent } from '@shared/protocol';

const NO_SHOTS: readonly FireEvent[] = [];

/** Defer reports until the current hull pose is installed. Session, camera
 * and player-lifetime resets discard them instead of firing an old hull. */
export class VehicleShotQueue {
  private readonly events: FireEvent[] = [];
  get length(): number { return this.events.length; }

  enqueue(event: FireEvent): void {
    this.events.push(event);
    if (this.events.length > 8) this.events.shift();
  }

  clear(): void { this.events.length = 0; }

  take(): readonly FireEvent[] {
    return this.events.length ? this.events.splice(0) : NO_SHOTS;
  }
}
