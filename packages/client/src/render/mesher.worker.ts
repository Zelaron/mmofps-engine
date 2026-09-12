import { World } from '@shared/index';
import { meshColumnWithPortals } from './surfacenets.js';
import { meshTerrainPreview } from './terrain-preview.js';

// Web worker: meshes terrain columns off the main thread so the game never
// hitches while streaming the world in.

interface InitMsg { type: 'init'; seed: number }
interface MeshMsg {
  type: 'mesh';
  reqId: number;
  cx: number;
  cz: number;
  caveDetail: boolean;
  step: number;
  preview?: boolean;
}
type InMsg = InitMsg | MeshMsg;

const ctx = self as unknown as {
  onmessage: ((ev: MessageEvent<InMsg>) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

let world: World | null = null;

ctx.onmessage = (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  if (msg.type === 'init') {
    world = new World(msg.seed);
    return;
  }
  if (msg.type === 'mesh') {
    if (!world) return;
    const { chunks, portals } = msg.preview
      ? meshTerrainPreview(world, msg.cx, msg.cz)
      : meshColumnWithPortals(world, msg.cx, msg.cz, msg.caveDetail, msg.step);
    const transfer: Transferable[] = [];
    for (const c of chunks) {
      transfer.push(c.positions.buffer, c.normals.buffer, c.colors.buffer);
      if (c.caveDepth) transfer.push(c.caveDepth.buffer);
      if (c.partOffsets) transfer.push(c.partOffsets.buffer);
    }
    transfer.push(portals.positions.buffer);
    if (portals.partOffsets) transfer.push(portals.partOffsets.buffer);
    ctx.postMessage(
      {
        type: 'meshed',
        reqId: msg.reqId,
        cx: msg.cx,
        cz: msg.cz,
        caveDetail: msg.caveDetail,
        step: msg.step,
        preview: msg.preview === true,
        chunks,
        portals,
      },
      transfer,
    );
  }
};
