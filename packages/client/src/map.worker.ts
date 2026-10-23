import { World } from '@shared/worldgen';
import { worldMapSvg, worldMapSvgSteps } from './world-map.js';
import type { WorldMapRequest, WorldMapResult } from './world-map-stream.js';
import { runWorkerSlices } from './render/worker-slices.js';

let active: { cancel(): void } | undefined;
let generation = 0;
const pacer = { readyAt: 0 };
function* mapSteps(world: World): Generator<void, string, void> {
  // Snapshot clone/index restoration is also charged to the actual slice.
  const plan = world.collectTransportPlan(); yield;
  return yield* worldMapSvgSteps(world, plan);
}

self.onmessage = ({ data }: MessageEvent<WorldMapRequest>) => {
  if (data.type !== 'map' || !Number.isSafeInteger(data.seed)) return;
  active?.cancel(); active = undefined;
  const requestGeneration = ++generation;
  const world = new World(data.seed, data.transportSnapshot);
  if (data.cooperative === true) {
    active = runWorkerSlices(mapSteps(world), { pacer,
      complete(svg, timing) {
        if (requestGeneration !== generation) return;
        active = undefined;
        const response: WorldMapResult = { type: 'map', seed: data.seed, svg, ...timing };
        self.postMessage(response);
      },
      error: error => { if (requestGeneration === generation) throw error; },
    });
    return;
  }
  const response: WorldMapResult = { type: 'map', seed: data.seed, svg: worldMapSvg(world, world.collectTransportPlan()) };
  self.postMessage(response);
};
