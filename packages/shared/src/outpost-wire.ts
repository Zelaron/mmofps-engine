import { ByteReader, ByteWriter, Msg } from './protocol.js';
import { OUTPOST_VISIBLE_LIMIT, validOutpostSite, type OutpostSnapshot, type OutpostAction } from './outposts.js';
import { isEntityId } from './entity-id.js';
import { isFaction } from './frontier.js';

export function encodeOutpostAction(action: OutpostAction): Uint8Array {
  const w = new ByteWriter(12).u8(Msg.COutpost);
  return action.action === 'remove' ? w.u8(1).entity(action.id).finish() : w.u8(0).u8(action.type).u8(action.facing).f32(action.x).f32(action.z).finish();
}
export function decodeOutpostAction(r: ByteReader): OutpostAction {
  const action = r.u8();
  if (action === 1) {
    const id = r.entity();
    if (!isEntityId(id) || r.remaining) throw new Error('Invalid construction request');
    return { action: 'remove', id };
  }
  if (action !== 0 || r.remaining !== 10) throw new Error('Invalid construction request');
  const type = r.u8(), facing = r.u8(), x = r.f32(), z = r.f32();
  if (!validOutpostSite({ type, facing, x, y: 0, z })) throw new Error('Invalid construction site');
  return { action: 'build', type, facing, x, z };
}
export function encodeOutposts(state: OutpostSnapshot): Uint8Array {
  if (state.sites.length > OUTPOST_VISIBLE_LIMIT) throw new Error('Construction interest exceeds budget');
  const w = new ByteWriter().u8(Msg.SOutposts).u8(+state.enabled).u8(state.sites.length);
  for (const s of state.sites) w.entity(s.id).entity(s.owner).u8(s.faction).u8(s.type).u8(s.facing).f32(s.x).f32(s.y).f32(s.z);
  return w.finish();
}
export function decodeOutposts(r: ByteReader): OutpostSnapshot {
  const flag = r.u8(), count = r.u8(), sites: OutpostSnapshot['sites'] = [], ids = new Set<number>();
  if (flag > 1 || count > OUTPOST_VISIBLE_LIMIT || r.remaining < count * 17) throw new Error('Invalid construction snapshot');
  for (let i = 0; i < count; i++) {
    const s = { id: r.entity(), owner: r.entity(), faction: r.u8(), type: r.u8(), facing: r.u8(), x: r.f32(), y: r.f32(), z: r.f32() };
    if (!isEntityId(s.id) || !isEntityId(s.owner) || !isFaction(s.faction) || !validOutpostSite(s) || ids.has(s.id)) throw new Error('Invalid construction record');
    ids.add(s.id); sites.push({ ...s, faction: s.faction });
  }
  if (r.remaining) throw new Error('Invalid construction snapshot');
  return { enabled: !!flag, sites };
}
