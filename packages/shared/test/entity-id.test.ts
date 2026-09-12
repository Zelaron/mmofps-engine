import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allocateEntityId, namespaceRange, MAX_LEGACY_ENTITY_ID, MAX_CHARACTER_ID, MAX_ENTITY_NAMESPACES, isEntityId } from '@shared/entity-id';

test('allocation crosses the old 16-bit limit and never overwrites a live ID on wrap', () => {
  const active = new Set<number>(); let cursor = 1;
  for (let i = 0; i < 100_000; i++) {
    const allocation = allocateEntityId(cursor, active);
    active.add(allocation.id); cursor = allocation.next;
  }
  assert.equal(active.size, 100_000); assert.ok(active.has(65536));
  active.add(MAX_LEGACY_ENTITY_ID);
  assert.deepEqual(allocateEntityId(MAX_LEGACY_ENTITY_ID, active), { id: 100_001, next: 100_002 });
  assert.deepEqual(allocateEntityId(0, new Set()), { id: 1, next: 2 });
  assert.throws(() => allocateEntityId(1, new Set([1, 2, 3]), { first: 1, last: 3 }), /exhausted/);
});

test('authority namespaces are disjoint, unsigned and exclude character IDs and wire sentinels', () => {
  let previous = MAX_CHARACTER_ID;
  for (let i = 0; i < MAX_ENTITY_NAMESPACES; i++) {
    const range = namespaceRange(i);
    assert.ok(range.first > previous && isEntityId(range.first) && isEntityId(range.last));
    assert.equal(allocateEntityId(range.last, new Set([range.last]), range).id, range.first);
    previous = range.last;
  }
  assert.equal(previous, MAX_LEGACY_ENTITY_ID);
  for (const id of [-1, 0, 0xffffffff, 1.5, NaN]) assert.equal(isEntityId(id), false);
  for (const n of [-1, .5, MAX_ENTITY_NAMESPACES]) assert.throws(() => namespaceRange(n));
});
