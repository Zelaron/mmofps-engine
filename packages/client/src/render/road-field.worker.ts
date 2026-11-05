import { World, type RoadSegment } from '@shared/worldgen';
import { WORLD } from '@shared/index';
import { rasterRoadSteps, type RoadFieldRequest, type RoadFieldResponse, type RoadGrid } from './road-raster.js';

// Builds the terrain shader's road maps off the main thread. Route searches
// for a cold 12 km far map take seconds and some single links take tens of
// milliseconds, which used to show up as frame hitches during fast travel.
// Work runs in slices so a near-map request never waits behind a far map.
// On a local world host each slice rests three times its work (a quarter
// duty cycle, like the other generation workers) to leave the planetary
// simulations their CPU.
//
// After the first maps, an idle worker routes the rest of the island once
// and sends the network to the main thread, whose Worlds adopt it: physics,
// streaming and water sampling then never run a cold route search there
// (the first sample near an unrouted link used to cost up to ~250 ms). The
// links behind the first near and far maps are sent as soon as each is done,
// so the surroundings are covered within a second or two of joining.

interface Job { id: number; layer: number; grid: RoadGrid; steps: Generator<void, Uint8Array<ArrayBuffer>, void>; workMs: number }
const SLICE_MS = 12;
let world: World | undefined;
let cooperative = false;
const jobs: Job[] = [];
let network: { steps: Generator<void, RoadSegment[], void>; workMs: number } | null = null;
const sharedLayers = new Set<number>();

function shareNetwork(workMs: number): void {
  const snapshot = world!.exportRoadNetwork();
  const response: RoadFieldResponse = { type: 'network', snapshot, workMs };
  (self as unknown as Worker).postMessage(response, [snapshot.offsets.buffer, snapshot.points.buffer, snapshot.flags.buffer]);
}
let scheduled = false;

function schedule(rest = 0): void {
  if (scheduled || (!jobs.length && !network)) return;
  scheduled = true;
  setTimeout(pump, rest);
}

function pump(): void {
  scheduled = false;
  let job: Job | undefined;
  for (const candidate of jobs) if (!job || candidate.layer < job.layer) job = candidate;
  if (!job) { if (network) routeNetwork(); return; }
  const begin = performance.now(), end = begin + SLICE_MS;
  try {
    for (;;) {
      const next = job.steps.next();
      if (next.done) {
        jobs.splice(jobs.indexOf(job), 1);
        const response: RoadFieldResponse = { type: 'raster', id: job.id, layer: job.layer, grid: job.grid, data: next.value,
          workMs: job.workMs + performance.now() - begin };
        (self as unknown as Worker).postMessage(response, [next.value.buffer]);
        // The first near and far maps route the soldier's surroundings.
        if (network && !sharedLayers.has(job.layer)) { sharedLayers.add(job.layer); shareNetwork(0); }
        break;
      }
      if (performance.now() >= end) { job.workMs += performance.now() - begin; break; }
    }
  } catch (error) {
    jobs.length = 0;
    throw error;
  }
  schedule(cooperative ? Math.min(750, (performance.now() - begin) * 3) : 0);
}

/** Background island routing, only while no map is waiting. */
function routeNetwork(): void {
  const task = network!, begin = performance.now(), end = begin + SLICE_MS;
  try {
    for (;;) {
      if (task.steps.next().done) {
        network = null;
        shareNetwork(task.workMs + performance.now() - begin);
        break;
      }
      if (performance.now() >= end) { task.workMs += performance.now() - begin; break; }
    }
  } catch (error) {
    network = null;
    throw error;
  }
  schedule(cooperative ? Math.min(750, (performance.now() - begin) * 3) : 0);
}

self.onmessage = ({ data: message }: MessageEvent<RoadFieldRequest>) => {
  if (message.type === 'init') {
    jobs.length = 0; sharedLayers.clear();
    cooperative = message.cooperative === true;
    world = new World(message.seed, message.transportSnapshot);
    network = message.network ? { steps: world.collectRoadSegmentSteps(-WORLD.BORDER, WORLD.BORDER, -WORLD.BORDER, WORLD.BORDER), workMs: 0 } : null;
    return;
  }
  if (!world) throw new Error('Road field worker has no world');
  jobs.push({ id: message.id, layer: message.layer, grid: message.grid, steps: rasterRoadSteps(world, message.grid), workMs: 0 });
  schedule();
};
