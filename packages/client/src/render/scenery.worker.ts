import { World } from '@shared/worldgen';
import { ScenerySamples } from './scenery-samples.js';
import type { SceneryRequest, SceneryResponse } from './scenery-stream.js';

let samples: ScenerySamples | undefined;
self.onmessage = ({ data: message }: MessageEvent<SceneryRequest>) => {
  if (message.type === 'init') { samples = new ScenerySamples(new World(message.seed)); return; }
  if (!samples) throw new Error('Scenery worker has no world');
  const response: SceneryResponse = { type: 'result', id: message.id, kind: message.kind,
    data: samples.collect(message.kind, message.bounds) };
  self.postMessage(response);
};
