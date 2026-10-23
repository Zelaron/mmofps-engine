import { World } from '@shared/worldgen';
import { EncounterField } from '@shared/encounters';
import type { EncounterWorkerRequest, EncounterWorkerState } from './encounter-stream.js';
import { workerJobRestMs } from './device-profile.js';

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
let readyAt = 0;

function schedule(): void {
  if (timer === null) timer = setTimeout(run, Math.max(8, readyAt - performance.now()));
}

function run(): void {
  timer = null;
  if (!field) return;
  const started = performance.now();
  if (started < readyAt) { schedule(); return; }
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
  // The 4ms slice is a soft ceiling: a cold generator step can overrun it.
  // Local worlds repay that actual work before the next slice, even when a
  // newer district selection arrives. Remote workers keep their 8ms rest.
  const completed = performance.now();
  readyAt = completed + Math.max(8, workerJobRestMs(completed - started));
  if (!complete) schedule();
}

ctx.onmessage = event => {
  const msg = event.data;
  if (msg.type === 'init') {
    if (timer !== null) clearTimeout(timer);
    timer = null; points = []; request = 0; sentRevision = -1; sentAt = -Infinity; readyAt = 0;
    field = new EncounterField(new World(msg.seed, msg.transportSnapshot), msg.base);
  } else if (msg.type === 'select' && field && msg.request >= request) {
    request = msg.request; points = msg.points;
    // A completed district can wake again, and several rapid movements
    // coalesce into the newest position before the next bounded slice.
    schedule();
  }
};
