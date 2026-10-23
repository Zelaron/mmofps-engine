import { World } from '@shared/worldgen';
import { ScenerySamples } from './scenery-samples.js';
import type { SceneryRequest, SceneryResponse } from './scenery-stream.js';
import { runWorkerSlices } from './worker-slices.js';

let samples: ScenerySamples | undefined;
let cooperative = false;
let active: { cancel(): void } | undefined;
let generation = 0;
const pacer = { readyAt: 0 };
self.onmessage = ({ data: message }: MessageEvent<SceneryRequest>) => {
  if (message.type === 'init') {
    active?.cancel(); active = undefined; generation++;
    cooperative = message.cooperative === true;
    samples = new ScenerySamples(new World(message.seed, message.transportSnapshot)); return;
  }
  if (!samples) throw new Error('Scenery worker has no world');
  active?.cancel(); active = undefined;
  const requestGeneration = ++generation;
  if (cooperative) {
    active = runWorkerSlices(samples.collectSteps(message.kind, message.bounds), {
      pacer,
      complete(data, timing) {
        if (requestGeneration !== generation) return;
        active = undefined;
        const response: SceneryResponse = { type: 'result', id: message.id, kind: message.kind, data, ...timing };
        self.postMessage(response);
      },
      error: error => { if (requestGeneration === generation) throw error; },
    });
    return;
  }
  const started = performance.now();
  const data = samples.collect(message.kind, message.bounds);
  const response: SceneryResponse = { type: 'result', id: message.id, kind: message.kind,
    data, workMs: performance.now() - started };
  self.postMessage(response);
};
