import { ByteReader, ByteWriter, Msg } from './protocol.js';
import { RESOURCE_VISIBLE_LIMIT, type ResourceSnapshot } from './resources.js';

export function encodeHarvest(held: boolean): Uint8Array { return new Uint8Array([Msg.CHarvest, +held]); }
export function encodeResources(state: ResourceSnapshot): Uint8Array {
  if (state.nodes.length > RESOURCE_VISIBLE_LIMIT) throw new Error('Resource interest exceeds budget');
  const w = new ByteWriter().u8(Msg.SResources).u8(+state.enabled).u8(+state.saving)
    .u8(Math.round(Math.max(0, Math.min(1, state.progress)) * 255)).str(state.target).str(state.reason).u8(state.nodes.length);
  for (const n of state.nodes) w.str(n.id).f32(n.x).f32(n.y).f32(n.z).u16(Math.max(0, Math.min(65535, Math.ceil(n.remaining))));
  return w.finish();
}
export function decodeResources(r: ByteReader): ResourceSnapshot {
  const enabled = r.u8(), saving = r.u8(), progress = r.u8() / 255, target = r.str(), reason = r.str(), count = r.u8();
  if (enabled > 1 || saving > 1 || count > RESOURCE_VISIBLE_LIMIT || reason.length > 80) throw new Error('Invalid resource snapshot');
  const nodes: ResourceSnapshot['nodes'] = [], ids = new Set<string>();
  for (let i = 0; i < count; i++) {
    const node = { id: r.str(), x: r.f32(), y: r.f32(), z: r.f32(), remaining: r.u16() };
    if (!/^-?\d{1,3},-?\d{1,3}$/.test(node.id) || ids.has(node.id) || !Number.isFinite(node.x + node.y + node.z)) throw new Error('Invalid resource node');
    nodes.push(node); ids.add(node.id);
  }
  if (r.remaining || target && !ids.has(target)) throw new Error('Invalid resource target');
  return { enabled: !!enabled, saving: !!saving, progress, target, reason, nodes };
}
