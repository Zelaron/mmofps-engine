import type { TransportSnapshot } from '@shared/transport';
import { isLocalWorldHost } from './render/device-profile.js';
import type { WorkerSliceStats } from './render/worker-slices.js';

export interface WorldMapRequest { type: 'map'; seed: number; transportSnapshot?: TransportSnapshot; cooperative?: boolean }
export interface WorldMapResult extends Partial<WorkerSliceStats> { type: 'map'; seed: number; svg: string }
export interface WorldMapWorker {
  onmessage: ((event: MessageEvent<WorldMapResult>) => unknown) | null;
  onerror: ((event: ErrorEvent) => unknown) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null;
  postMessage(message: WorldMapRequest): void;
  terminate(): void;
}

/** Shared by the atlas and minimap. The inexpensive overview is always usable;
 * whole-world terrain sampling never falls back onto the rendering thread. */
export class WorldMapStream {
  private worker: WorldMapWorker | null = null;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(svg: string) => void>();
  private disposed = false;
  private detail = false;
  private failed = false;
  started = false;
  constructor(readonly seed: number, private current: string,
    private readonly factory: () => WorldMapWorker = () => new Worker('/map.worker.js'),
    private readonly transportSnapshot?: TransportSnapshot) {}

  get stats() { return { started: this.started, ready: this.detail, failed: this.failed }; }
  subscribe(listener: (svg: string) => void): () => void {
    if (!this.disposed) { this.listeners.add(listener); listener(this.current); }
    return () => { this.listeners.delete(listener); };
  }
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    try {
      const worker = this.worker = this.factory();
      worker.onmessage = ({ data }) => {
        if (this.disposed || this.worker !== worker || data.type !== 'map' || data.seed !== this.seed || typeof data.svg !== 'string') return;
        this.current = data.svg; this.detail = true; this.stop();
        for (const listener of this.listeners) listener(this.current);
      };
      worker.onerror = event => { event.preventDefault?.(); this.fail(); };
      worker.onmessageerror = () => this.fail();
      this.timeout = setTimeout(() => this.fail(), 45_000);
      (this.timeout as unknown as { unref?: () => void }).unref?.();
      worker.postMessage({ type: 'map', seed: this.seed,
        ...(isLocalWorldHost() ? { cooperative: true } : {}),
        ...(this.transportSnapshot ? { transportSnapshot: this.transportSnapshot } : {}) });
    } catch { this.fail(); }
  }
  private fail(): void { if (!this.disposed) this.failed = true; this.stop(); }
  private stop(): void {
    clearTimeout(this.timeout); this.timeout = undefined;
    if (!this.worker) return;
    this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
    this.worker.terminate(); this.worker = null;
  }
  dispose(): void { this.disposed = true; this.stop(); this.listeners.clear(); }
}
