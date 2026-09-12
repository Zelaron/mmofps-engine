import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EntityPool, ENTITY_REFILL_AT } from '../src/entity-pool.js';
import { ControlError } from '../src/control-client.js';
import type { EntityGrant, EntityReservation } from '../src/entity-ledger.js';
import { ENTITY_BLOCK_SIZE, MAX_ENTITY_ID, MAX_ENTITY_BLOCK, entityBlockRange } from '@shared/entity-id';

const initial = (firstBlock = 0, count = 1): EntityGrant => ({ request: randomUUID(), node: 'worker', planet: 'meridian', region: 'world', firstBlock, count });
const empty = new Set<number>();
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

test('one pool allocates disjoint IDs across kinds and prefetches only below its low watermark', async () => {
  let requests = 0;
  const pool = new EntityPool(initial(0, 8), async request => { requests++; return { ...request, firstBlock: 20 }; });
  const player = pool.allocate(empty), hull = pool.allocate(empty), bullet = pool.allocate(empty);
  assert.equal(new Set([player, hull, bullet]).size, 3);
  assert.equal(player, entityBlockRange(0).first);
  pool.pump(); assert.equal(requests, 0, 'bootstrap cannot refill before registration');
  pool.bind(7); pool.pump(); await flush(); assert.equal(requests, 0);
  while (pool.remaining > ENTITY_REFILL_AT) pool.allocate(empty);
  pool.pump(); pool.pump(); await flush(); assert.equal(requests, 1);
  assert.equal(pool.remaining, ENTITY_REFILL_AT + 8 * ENTITY_BLOCK_SIZE);
  for (let i = 0; i < ENTITY_REFILL_AT; i++) pool.allocate(empty);
  assert.equal(pool.allocate(empty), entityBlockRange(20).first, 'noncontiguous batches are consumed without filling unowned gaps');
  await pool.close(); assert.throws(() => pool.allocate(empty), /closed/);
});

test('a transient lost refill reply retries the same request while buffered IDs keep simulation synchronous', async () => {
  let now = 0, calls = 0, saved: EntityReservation | undefined;
  const pool = new EntityPool(initial(), async request => {
    calls++; if (!saved) { saved = structuredClone(request); throw new Error('response lost after commit'); }
    assert.deepEqual(request, saved); return { ...request, firstBlock: 10 };
  }, () => now);
  pool.bind(1); pool.pump(); await flush(); assert.equal(calls, 1);
  const before = pool.allocate(empty); pool.pump(); await flush(); assert.equal(calls, 1);
  now = 250; pool.pump(); await flush(); assert.equal(calls, 2);
  assert.equal(pool.allocate(empty), before + 1); assert.equal(pool.remaining, 9 * ENTITY_BLOCK_SIZE - 2);
  await pool.close();
});

test('reservation replay, invalid replies and stale authority fail closed instead of recycling IDs', async () => {
  const cases = [
    async (r: EntityReservation) => ({ ...r, firstBlock: 0 }),
    async (r: EntityReservation) => ({ ...r, firstBlock: 2, node: 'different-worker' }),
    async (_r: EntityReservation): Promise<EntityGrant> => { throw new ControlError('fenced', 'authority expired'); },
    async (_r: EntityReservation): Promise<EntityGrant> => { throw new ControlError('full', 'ID space exhausted'); },
  ];
  for (const reserve of cases) {
    const pool = new EntityPool(initial(), reserve); pool.bind(2); pool.pump(); await flush();
    assert.ok(pool.status.failed); assert.throws(() => pool.allocate(empty)); assert.throws(() => pool.pump()); await pool.close();
  }
});

test('the final ID stays precise and local exhaustion is explicit even with a refill in flight', async () => {
  let resolve!: (grant: EntityGrant) => void, pendingRequest: EntityReservation | undefined;
  const pool = new EntityPool(initial(MAX_ENTITY_BLOCK), request => { pendingRequest = request; return new Promise(r => { resolve = r; }); });
  pool.bind(3); pool.pump(); await flush();
  let last = 0; for (let i = 0; i < ENTITY_BLOCK_SIZE; i++) last = pool.allocate(empty);
  assert.equal(last, MAX_ENTITY_ID); assert.equal(pool.remaining, 0); assert.throws(() => pool.allocate(empty), /exhausted/);
  const closing = pool.close(); resolve({ ...pendingRequest!, firstBlock: 1 }); await closing;
  assert.equal(pool.remaining, 0, 'a late reply to a closed pool is discarded');
});

test('an unexpected occupied ID cannot overwrite an imported object or advance the pool', async () => {
  const grant = initial(), pool = new EntityPool(grant, async () => { throw new Error('unused'); });
  assert.throws(() => pool.allocate(new Set([entityBlockRange(grant.firstBlock).first])), /collides/);
  assert.equal(pool.remaining, ENTITY_BLOCK_SIZE);
  assert.equal(pool.allocate(empty), entityBlockRange(grant.firstBlock).first);
  pool.bind(1); assert.throws(() => pool.bind(2), /authority changed/); await pool.close();
});
