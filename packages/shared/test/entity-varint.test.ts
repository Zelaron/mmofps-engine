import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteReader, ByteWriter } from '@shared/protocol';
import { DYNAMIC_ENTITY_BASE, ENTITY_BLOCK_SIZE, MAX_ENTITY_ID, MAX_ENTITY_BLOCK, NO_ENTITY_ID, entityBlockOf, entityBlockRange, isEntityId } from '@shared/entity-id';
import { encodeOutposts, decodeOutposts, encodeOutpostAction, decodeOutpostAction } from '@shared/outpost-wire';

test('canonical entity integers preserve all 53 bits and occupy only their required bytes', () => {
  const values = new Set([0, 1, NO_ENTITY_ID, DYNAMIC_ENTITY_BASE, MAX_ENTITY_ID]);
  for (let bit = 7; bit <= 49; bit += 7) for (const d of [-1, 0, 1]) values.add(2 ** bit + d);
  for (const value of values) {
    const bytes = new ByteWriter(1).entity(value).finish(), reader = new ByteReader(bytes);
    assert.equal(reader.entity(), value); assert.equal(reader.remaining, 0);
  }
  for (const [value, bytes] of [[0, [0]], [127, [127]], [128, [128, 1]], [16383, [255, 127]], [16384, [128, 128, 1]],
    [DYNAMIC_ENTITY_BASE, [128, 128, 128, 128, 16]], [MAX_ENTITY_ID, [255, 255, 255, 255, 255, 255, 255, 15]]] as const) {
    assert.deepEqual([...new ByteWriter().entity(value).finish()], bytes);
  }
  assert.equal(new ByteReader(new ByteWriter().entity(-1).finish()).entity(), NO_ENTITY_ID);
  assert.equal(new ByteWriter().entity(1).finish().length, 1);
  assert.equal(new ByteWriter().entity(DYNAMIC_ENTITY_BASE).finish().length, 5);
  assert.equal(new ByteWriter().entity(MAX_ENTITY_ID).finish().length, 8);
});

test('malformed, truncated and unsafe entity integers are rejected', () => {
  for (const value of [-2, .1, NaN, Infinity, MAX_ENTITY_ID + 1]) assert.throws(() => new ByteWriter().entity(value), RangeError);
  const invalid = [[], [128], [128, 0], [129, 0], Array(8).fill(255), [...Array(7).fill(255), 16], [...Array(8).fill(128), 1]];
  for (const bytes of invalid) assert.throws(() => new ByteReader(Uint8Array.from(bytes)).entity(), RangeError);
  assert.equal(isEntityId(MAX_ENTITY_ID), true);
  assert.equal(isEntityId(MAX_ENTITY_ID + 1), false);
});

test('reserved block arithmetic covers the safe-integer range without sentinels, gaps or overflow', () => {
  assert.equal(entityBlockRange(0).first, DYNAMIC_ENTITY_BASE);
  assert.equal(entityBlockRange(MAX_ENTITY_BLOCK).last, MAX_ENTITY_ID);
  for (const block of [0, 1, 65535, 2 ** 32, MAX_ENTITY_BLOCK]) {
    const range = entityBlockRange(block);
    assert.equal(range.last - range.first + 1, ENTITY_BLOCK_SIZE);
    assert.equal(entityBlockOf(range.first), block); assert.equal(entityBlockOf(range.last), block);
  }
  for (const block of [-1, .1, MAX_ENTITY_BLOCK + 1, NaN]) assert.throws(() => entityBlockRange(block));
  for (const id of [0, NO_ENTITY_ID, DYNAMIC_ENTITY_BASE - 2, MAX_ENTITY_ID + 1]) assert.equal(entityBlockOf(id), null);
});

test('construction IDs and owners use the same safe-integer wire format and reject trailing data', () => {
  const body = (bytes: Uint8Array) => { const reader = new ByteReader(bytes); reader.u8(); return reader; };
  for (const id of [1, 2 ** 32, MAX_ENTITY_ID]) {
    const action = { action: 'remove' as const, id };
    assert.deepEqual(decodeOutpostAction(body(encodeOutpostAction(action))), action);
    const state = { enabled: true, sites: [{ id, owner: MAX_ENTITY_ID, faction: 1 as const, type: 0, facing: 1, x: 1, y: 600, z: 1 }] };
    assert.deepEqual(decodeOutposts(body(encodeOutposts(state))), state);
    for (const bytes of [encodeOutpostAction(action), encodeOutposts(state)]) {
      const appended = Uint8Array.from([...bytes, 0]);
      assert.throws(() => bytes[0] === encodeOutpostAction(action)[0] ? decodeOutpostAction(body(appended)) : decodeOutposts(body(appended)));
    }
  }
  assert.throws(() => decodeOutpostAction(body(encodeOutpostAction({ action: 'remove', id: NO_ENTITY_ID }))));
});
