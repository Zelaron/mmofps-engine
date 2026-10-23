import { ENCOUNTER_REGION_SIZE, ENCOUNTER_CACHE_LIMIT, type CavePOI } from '@shared/encounters';
import type { TeleporterPad } from '@shared/teleporters';
import type { TransportSnapshot } from '@shared/transport';

export interface EncounterStats { cached: number; wanted: number; pending: string | null }
export interface EncounterSource {
  readonly pads: readonly TeleporterPad[];
  readonly revision: number;
  readonly stats: EncounterStats;
  readonly pois?: readonly CavePOI[];
  update(points: readonly { x: number; z: number }[], budgetMs?: number, maxSteps?: number): boolean;
  dispose?(): void;
}
export type EncounterWorkerRequest =
  | { type: 'init'; seed: number; base: readonly TeleporterPad[]; transportSnapshot?: TransportSnapshot }
  | { type: 'select'; request: number; points: readonly { x: number; z: number }[] };
export interface EncounterWorkerState {
  type: 'state'; request: number; revision: number; stats: EncounterStats;
  pads?: readonly TeleporterPad[];
  pois?: readonly CavePOI[];
}
export interface EncounterWorkerEndpoint {
  onmessage: ((event: MessageEvent<EncounterWorkerState>) => unknown) | null;
  onerror: ((event: ErrorEvent) => unknown) | null;
  onmessageerror: ((event: MessageEvent<unknown>) => unknown) | null;
  postMessage(message: EncounterWorkerRequest): void;
  terminate(): void;
}

/** Regional world queries stay in a dedicated worker. Frame updates only
 * compare district selections and install already-generated small pad lists. */
export class EncounterStream implements EncounterSource {
  private worker: EncounterWorkerEndpoint | null = null;
  private flat: readonly TeleporterPad[];
  private landmarks: readonly CavePOI[] = [];
  private state: EncounterStats = { cached: 0, wanted: 0, pending: null };
  private selection: string | null = null;
  private request = 0;
  private acceptedRevision = -1;
  private observedRevision = 0;
  private disposed = false;
  private failed = false;
  revision = 0;

  constructor(seed: number, base: readonly TeleporterPad[],
    factory: () => EncounterWorkerEndpoint = () => new Worker('encounters.worker.js'),
    private readonly canGenerate: () => boolean = () => true, transportSnapshot?: TransportSnapshot) {
    this.flat = base.slice();
    try {
      const worker = this.worker = factory();
      worker.onmessage = event => {
        const msg = event.data;
        if (this.disposed || msg.type !== 'state' || msg.request !== this.request || msg.revision < this.acceptedRevision) return;
        this.state = msg.stats;
        if (msg.pads && msg.revision !== this.acceptedRevision) {
          this.flat = msg.pads;
          if (msg.pois) this.landmarks = msg.pois;
          this.acceptedRevision = msg.revision; this.revision++;
        }
      };
      worker.onerror = () => this.stopFailedWorker();
      worker.onmessageerror = () => this.stopFailedWorker();
      worker.postMessage({ type: 'init', seed, base, ...(transportSnapshot ? { transportSnapshot } : {}) });
    } catch { this.stopFailedWorker(); }
  }

  get pads(): readonly TeleporterPad[] { return this.flat; }
  get pois(): readonly CavePOI[] { return this.landmarks; }
  get stats(): EncounterStats & { worker: boolean; failed: boolean } {
    return { ...this.state, worker: this.worker !== null, failed: this.failed };
  }

  update(points: readonly { x: number; z: number }[], _budgetMs?: number, _maxSteps?: number): boolean {
    if (this.disposed || !this.canGenerate()) return false;
    const cells = [...new Set(points.filter(p => Number.isFinite(p.x + p.z)).map(p =>
      `${Math.floor(p.x / ENCOUNTER_REGION_SIZE)},${Math.floor(p.z / ENCOUNTER_REGION_SIZE)}`))].sort().slice(0, ENCOUNTER_CACHE_LIMIT);
    const selection = cells.join(';');
    if (selection !== this.selection) {
      this.selection = selection;
      const quantized = cells.map(key => {
        const [x, z] = key.split(',').map(Number);
        return { x: (x + 0.5) * ENCOUNTER_REGION_SIZE, z: (z + 0.5) * ENCOUNTER_REGION_SIZE };
      });
      this.request++;
      try { this.worker?.postMessage({ type: 'select', request: this.request, points: quantized }); }
      catch { this.stopFailedWorker(); }
    }
    const changed = this.revision !== this.observedRevision;
    this.observedRevision = this.revision;
    return changed;
  }

  private stopFailedWorker(): void {
    this.failed = true;
    this.state = { ...this.state, pending: null };
    this.stopWorker();
    // Existing/base pads remain usable. A failed worker must never move the
    // expensive cold-world queries onto the game's render thread.
  }

  private stopWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = null; this.worker.onerror = null; this.worker.onmessageerror = null;
    this.worker.terminate(); this.worker = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.stopWorker();
  }
}
