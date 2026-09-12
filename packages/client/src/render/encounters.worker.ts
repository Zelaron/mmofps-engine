import { World } from '@shared/worldgen';
import { EncounterField } from '@shared/encounters';
import type { EncounterWorkerRequest, EncounterWorkerState } from './encounter-stream.js';

const ctx = self as unknown as {
  onmessage: ((event: MessageEvent<EncounterWorkerRequest>) => void) | null;
  postMessage(message: EncounterWorkerState): void;
};
let field: EncounterField | null = null;
let points: readonly { x: number; z: number }[] = [];
let request = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
let sentRevision = -1;
let sentAt = -Infinity;

function schedule(): void {
  if (timer === null) timer = setTimeout(run, 8);
}

function run(): void {
  timer = null;
  if (!field) return;
  // One cold generator step can exceed this soft slice. It now does so in
  // the worker; twelve-step and 4ms ceilings still yield regularly to new
  // positions rather than filling a long synchronous generation queue.
  field.update(points, 4, 12);
  const stats = field.stats;
  const complete = stats.pending === null && field.regions.length >= stats.wanted;
  const now = performance.now();
  if (field.revision !== sentRevision || complete || now - sentAt >= 100) {
    ctx.postMessage({ type: 'state', request, revision: field.revision, stats,
      ...(field.revision !== sentRevision ? { pads: field.pads, pois: field.pois } : {}) });
    sentRevision = field.revision; sentAt = now;
  }
  if (!complete) schedule();
}

ctx.onmessage = event => {
  const msg = event.data;
  if (msg.type === 'init') {
    if (timer !== null) clearTimeout(timer);
    timer = null; points = []; request = 0; sentRevision = -1; sentAt = -Infinity;
    field = new EncounterField(new World(msg.seed), msg.base);
  } else if (msg.type === 'select' && field && msg.request >= request) {
    request = msg.request; points = msg.points;
    // A completed district can wake again, and several rapid movements
    // coalesce into the newest position before the next bounded slice.
    schedule();
  }
};
