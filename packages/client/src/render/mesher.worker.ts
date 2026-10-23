import { World } from '@shared/index';
import type { TransportSnapshot } from '@shared/transport';
import { meshColumnWithPortals, meshColumnWithPortalsSteps, type ColumnMeshBundle } from './surfacenets.js';
import { meshTerrainPreview, TerrainPreviewBuilder } from './terrain-preview.js';
import { runWorkerSlices, type WorkerSliceStats, type WorkerSliceTask } from './worker-slices.js';

// Web worker: meshes terrain columns off the main thread so the game never
// hitches while streaming the world in.

interface InitMsg { type: 'init'; seed: number; cooperative?: boolean; transportSnapshot?: TransportSnapshot }
interface MeshMsg {
  type: 'mesh';
  reqId: number;
  cx: number;
  cz: number;
  caveDetail: boolean;
  step: number;
  preview?: boolean;
  urgentCoverage?: boolean;
}
type InMsg = InitMsg | MeshMsg | { type: 'cancel'; reqId: number };

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<InMsg>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

let world: World | null = null;
let cooperative = false;
interface MeshTask {
  key?: string;
  controller: WorkerSliceTask;
  request?: MeshMsg;
  generation: number;
}
let active: MeshTask | undefined;
// One active task and at most two paused canonical iterators. A paused task
// never drains in the background; another exact request must select it.
const paused = new Map<string, MeshTask>();
let generation = 0;
const pacer = { readyAt: 0 };

function pauseActive(): void {
  const task = active;
  if (!task) return;
  active = undefined; task.request = undefined; generation++;
  if (!task.key) { task.controller.cancel(); return; }
  task.controller.pause();
  paused.set(task.key, task);
  while (paused.size > 2) {
    const key = paused.keys().next().value!;
    paused.get(key)!.controller.cancel(); paused.delete(key);
  }
}

function clearTasks(): void {
  active?.controller.cancel(); active = undefined;
  for (const task of paused.values()) task.controller.cancel();
  paused.clear(); generation++;
}

function* previewSteps(source: World, cx: number, cz: number): Generator<void, ColumnMeshBundle, void> {
  const builder = new TerrainPreviewBuilder(source, cx, cz);
  for (;;) {
    const result = builder.advance(Infinity, 1);
    if (result) return result;
    yield;
  }
}

ctx.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    clearTasks();
    cooperative = msg.cooperative === true;
    world = new World(msg.seed, msg.transportSnapshot);
    return;
  }
  if (msg.type === 'cancel') {
    if (msg.reqId === active?.request?.reqId) pauseActive();
    return;
  }
  if (msg.type === 'mesh') {
    if (!world) return;
    pauseActive();
    const requestGeneration = ++generation;
    const complete = (request: MeshMsg, completedGeneration: number, { chunks, portals, authoredSeams }: ColumnMeshBundle,
      timing: Partial<WorkerSliceStats> & { workMs: number }) => {
      if (completedGeneration !== generation) return;
      active = undefined;
      const transfer: Transferable[] = [];
      for (const c of chunks) {
        transfer.push(c.positions.buffer, c.normals.buffer, c.colors.buffer);
        if (c.caveDepth) transfer.push(c.caveDepth.buffer);
        if (c.partOffsets) transfer.push(c.partOffsets.buffer);
      }
      if (authoredSeams) transfer.push(authoredSeams.keys.buffer, authoredSeams.rangeOffsets.buffer,
        authoredSeams.ranges.buffer, authoredSeams.segmentOffsets.buffer, authoredSeams.segments.buffer);
      transfer.push(portals.positions.buffer);
      if (portals.partOffsets) transfer.push(portals.partOffsets.buffer);
      ctx.postMessage(
        {
          type: 'meshed',
          reqId: request.reqId,
          cx: request.cx,
          cz: request.cz,
          caveDetail: request.caveDetail,
          step: request.step,
          preview: request.preview === true,
          ...timing,
          chunks,
          portals,
          authoredSeams,
        },
        transfer,
      );
    };
    if (cooperative) {
      const key = msg.preview ? undefined : `${msg.cx},${msg.cz},${msg.step},${msg.caveDetail}`;
      const retained = key ? paused.get(key) : undefined;
      if (retained) {
        paused.delete(key!);
        retained.request = msg; retained.generation = requestGeneration; active = retained;
        retained.controller.resume(msg.urgentCoverage === true);
        return;
      }
      const steps = msg.preview ? previewSteps(world, msg.cx, msg.cz)
        : meshColumnWithPortalsSteps(world, msg.cx, msg.cz, msg.caveDetail, msg.step);
      const task: MeshTask = { key, request: msg, generation: requestGeneration, controller: undefined! };
      active = task;
      task.controller = runWorkerSlices(steps, { pacer, urgentCoverage: msg.urgentCoverage,
        complete(result, timing) {
          if (active !== task || !task.request || task.generation !== generation) return;
          const request = task.request; task.request = undefined;
          try { complete(request, task.generation, result, timing); }
          catch (error) { clearTasks(); throw error; }
        },
        error(error) { clearTasks(); throw error; },
      });
    } else {
      const started = performance.now();
      const result = msg.preview ? meshTerrainPreview(world, msg.cx, msg.cz)
        : meshColumnWithPortals(world, msg.cx, msg.cz, msg.caveDetail, msg.step);
      complete(msg, requestGeneration, result, { workMs: performance.now() - started });
    }
  }
};
