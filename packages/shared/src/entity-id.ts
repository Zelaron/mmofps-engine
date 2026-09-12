/** Durable characters retain their low 31-bit IDs. Coordinated workers reserve
 * never-reissued blocks above the legacy 32-bit space, using safe JS integers.
 * Zero means absent; the legacy all-ones sentinel remains reserved. */
export const MAX_ENTITY_ID = Number.MAX_SAFE_INTEGER;
export const MAX_LEGACY_ENTITY_ID = 0xfffffffe;
export const MAX_CHARACTER_ID = 0x7fffffff;
export const NO_ENTITY_ID = 0xffffffff;
export const ENTITY_NAMESPACE_SIZE = 65536;
export const MAX_ENTITY_NAMESPACES = 32768;
export interface EntityIdRange { first: number; last: number }
export interface EntityAllocator { allocate(active: { has(id: number): boolean; size: number }): number }
export const DYNAMIC_ENTITY_BASE = 0x1_0000_0000;
export const ENTITY_BLOCK_SIZE = 65536;
export const MAX_ENTITY_BLOCK = Math.floor((MAX_ENTITY_ID - DYNAMIC_ENTITY_BASE + 1) / ENTITY_BLOCK_SIZE) - 1;
export function entityBlockRange(block: number): EntityIdRange {
  if (!Number.isSafeInteger(block) || block < 0 || block > MAX_ENTITY_BLOCK) throw new RangeError('Invalid entity block');
  const first = DYNAMIC_ENTITY_BASE + block * ENTITY_BLOCK_SIZE;
  return { first, last: first + ENTITY_BLOCK_SIZE - 1 };
}
export function entityBlockOf(id: number): number | null {
  return isEntityId(id) && id >= DYNAMIC_ENTITY_BASE ? Math.floor((id - DYNAMIC_ENTITY_BASE) / ENTITY_BLOCK_SIZE) : null;
}
export function isEntityId(id: unknown): id is number {
  return typeof id === 'number' && Number.isSafeInteger(id) && id > 0 && id !== NO_ENTITY_ID && id <= MAX_ENTITY_ID;
}
export function namespaceRange(namespace: number): EntityIdRange {
  if (!Number.isInteger(namespace) || namespace < 0 || namespace >= MAX_ENTITY_NAMESPACES) throw new Error('Invalid entity namespace');
  const base = 0x80000000 + namespace * ENTITY_NAMESPACE_SIZE;
  return { first: base + 1, last: Math.min(MAX_LEGACY_ENTITY_ID, base + ENTITY_NAMESPACE_SIZE - 1) };
}
export const LOCAL_ENTITY_RANGE: EntityIdRange = { first: 1, last: MAX_LEGACY_ENTITY_ID };

/** Wrap safely during long-running battles. Search is bounded by active IDs,
 * and exhaustion is explicit; a live entity is never silently replaced. */
export function allocateEntityId(cursor: number, active: { has(id: number): boolean; size: number }, range = LOCAL_ENTITY_RANGE): { id: number; next: number } {
  let id = Number.isInteger(cursor) && cursor >= range.first && cursor <= range.last ? cursor : range.first;
  const capacity = range.last - range.first + 1;
  for (let attempt = 0; attempt < Math.min(capacity, active.size + 1); attempt++) {
    if (!active.has(id)) return { id, next: id === range.last ? range.first : id + 1 };
    id = id === range.last ? range.first : id + 1;
  }
  throw new Error('Entity ID range is exhausted');
}
