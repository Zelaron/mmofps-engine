import type { Box, RockBounds, VegetationPlacement } from '@shared/index';

export interface SceneryBounds { minX: number; maxX: number; minZ: number; maxZ: number }
export interface SceneryData {
  vegetation: VegetationPlacement[];
  structures: Box[];
  rocks: { rock: RockBounds; desert: boolean }[];
}
export type SceneryKind = keyof SceneryData;
export interface ScenerySource {
  readonly failed: boolean;
  read<K extends SceneryKind>(kind: K, bounds: SceneryBounds): SceneryData[K] | null;
}
export type SceneryQuery = { type: 'query'; id: number; kind: SceneryKind; bounds: SceneryBounds };
export type SceneryRequest = { type: 'init'; seed: number } | SceneryQuery;
export type SceneryResponse = { type: 'result'; id: number; kind: SceneryKind; data: SceneryData[SceneryKind] };
export interface SceneryEndpoint {
  onmessage: ((event: MessageEvent<SceneryResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: SceneryRequest): void;
  terminate(): void;
}
const boundsKey = (b: SceneryBounds) => `${b.minX},${b.maxX},${b.minZ},${b.maxZ}`;

/** One query in flight and one latest request per pool. Existing instances
 * stay visible until their replacement arrives; travel cannot grow a queue. */
export class SceneryStream implements ScenerySource {
  private worker: SceneryEndpoint | null = null;
  private readonly wanted = new Map<SceneryKind, SceneryQuery>();
  private readonly ready = new Map<SceneryKind, { key: string; data: SceneryData[SceneryKind] }>();
  private busy: SceneryQuery | null = null;
  private timeout: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;
  private disposed = false;
  failed = false;

  constructor(seed: number, factory: () => SceneryEndpoint = () => new Worker('scenery.worker.js')) {
    try {
      const worker = this.worker = factory();
      worker.onmessage = ({ data: msg }) => {
        if (this.disposed || this.failed || msg.type !== 'result' ||
            msg.id !== this.busy?.id || msg.kind !== this.busy.kind) return;
        clearTimeout(this.timeout);
        const query = this.busy; this.busy = null;
        if (this.wanted.get(msg.kind)?.id === msg.id) {
          this.ready.set(msg.kind, { key: boundsKey(query.bounds), data: msg.data });
          this.wanted.delete(msg.kind);
        }
        this.pump();
      };
      worker.onerror = () => this.fail();
      worker.onmessageerror = () => this.fail();
      worker.postMessage({ type: 'init', seed });
    } catch { this.fail(); }
  }

  get stats() { return { worker: !!this.worker, failed: this.failed, pending: this.wanted.size, ready: this.ready.size }; }

  read<K extends SceneryKind>(kind: K, bounds: SceneryBounds): SceneryData[K] | null {
    if (this.disposed || this.failed || !Object.values(bounds).every(Number.isFinite)) return null;
    const key = boundsKey(bounds), ready = this.ready.get(kind);
    if (ready?.key === key) {
      // Returning to a cached footprint also cancels an obsolete replacement.
      this.wanted.delete(kind);
      return ready.data as SceneryData[K];
    }
    const wanted = this.wanted.get(kind);
    if (!wanted || boundsKey(wanted.bounds) !== key) {
      this.wanted.delete(kind);
      this.wanted.set(kind, { type: 'query', id: ++this.sequence, kind, bounds: { ...bounds } });
    }
    this.pump();
    return null;
  }

  private pump(): void {
    if (!this.worker || this.busy || this.disposed) return;
    const next = this.wanted.values().next().value;
    if (!next) return;
    this.busy = next;
    this.timeout = setTimeout(() => this.fail(), 15_000);
    try { this.worker.postMessage(next); } catch { this.fail(); }
  }

  private fail(): void {
    if (this.disposed) return;
    this.failed = true; this.stop();
  }
  private stop(): void {
    clearTimeout(this.timeout); this.worker?.terminate(); this.worker = null;
    this.busy = null; this.wanted.clear(); this.ready.clear();
  }
  dispose(): void { this.disposed = true; this.stop(); }
}
