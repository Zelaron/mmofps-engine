import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { Coordinator, OwnershipError, NODE_TIMEOUT_MS } from '../src/coordinator.js';
import { startControlPlane } from '../src/control-plane.js';
import { ControlClient, ControlError } from '../src/control-client.js';
import type { EntityReservation, EntityGrant } from '../src/entity-ledger.js';
import { MAX_ENTITY_BLOCK, MAX_ENTITY_ID, entityBlockRange } from '@shared/entity-id';

const code = (value: string) => (error: unknown) => error instanceof OwnershipError && error.code === value;
const registration = (id: string) => ({ id, planet: 'meridian' as const, region: 'world', url: 'ws://127.0.0.1:1000/ws', capacity: 8, humans: 0, tick: 0 });
const request = (node: string, count = 2): EntityReservation => ({ node, planet: 'meridian', region: 'world', count, request: randomUUID() });

test('bootstrap and refill reservations are durable, disjoint, idempotent and fenced by process/authority', () => {
  const c = new Coordinator(':memory:', () => 10_000);
  try {
    const boot = request('first'), grant = c.reserveEntities(boot);
    assert.equal(grant.firstBlock, 0); assert.deepEqual(c.reserveEntities(boot), grant);
    assert.throws(() => c.reserveEntities({ ...boot, count: 3 }), code('invalid'));
    assert.throws(() => c.reserveEntities({ ...boot, request: randomUUID() }), code('fenced'));
    assert.throws(() => c.reserveEntities({ ...boot, planet: 'cinder' }), code('fenced'));
    assert.throws(() => c.register({ ...registration('first'), planet: 'cinder' }), code('fenced'));
    const authority = c.register(registration('first'));
    assert.throws(() => c.reserveEntities(boot), code('fenced'), 'bootstrap reply cannot reset a registered process');
    const refill = { ...request('first'), epoch: authority.epoch }, more = c.reserveEntities(refill);
    assert.equal(more.firstBlock, 2); assert.deepEqual(c.reserveEntities(refill), more);
    assert.throws(() => c.reserveEntities({ ...refill, epoch: authority.epoch + 1 }), code('fenced'));
    assert.equal(c.unregister('first', authority.epoch), true);
    assert.throws(() => c.reserveEntities(refill), code('fenced'), 'cached refill requires live authority');
    const fresh = c.reserveEntities(request('replacement'));
    assert.equal(fresh.firstBlock, 4); c.register(registration('replacement'));
    assert.throws(() => c.reserveEntities(boot), code('fenced'));
    assert.throws(() => c.reserveEntities({ ...refill, request: randomUUID() }), code('fenced'));
  } finally { c.close(); }
});

test('coordinator restart never reissues old blocks, including recovery of a lagging sequence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mmofps-entity-ledger-')), file = path.join(directory, 'universe.sqlite');
  let now = 10_000, c: Coordinator | null = new Coordinator(file, () => now);
  try {
    const boot = request('first', 8), first = c.reserveEntities(boot);
    const epoch = c.register(registration('first')).epoch;
    const refill = { ...request('first', 8), epoch }, second = c.reserveEntities(refill);
    c.close(); c = null;
    const db = new DatabaseSync(file);
    try { db.prepare("UPDATE sequences SET next=0 WHERE name='entity_block'").run(); } finally { db.close(); }
    now += NODE_TIMEOUT_MS * 3; c = new Coordinator(file, () => now);
    assert.throws(() => c!.reserveEntities(boot), code('fenced'));
    const next = c.reserveEntities(request('new-process'));
    assert.equal(first.firstBlock, 0); assert.equal(second.firstBlock, 8); assert.equal(next.firstBlock, 16);
    c.close(); c = new Coordinator(file, () => now);
    assert.deepEqual(c.reserveEntities({ ...next }), next, 'unregistered lost bootstrap reply survives restart');
    assert.equal(c.reserveEntities(request('another-process')).firstBlock, 18);
  } finally {
    c?.close();
    assert.ok(path.resolve(directory).startsWith(path.join(path.resolve(tmpdir()), 'mmofps-entity-ledger-')));
    await rm(directory, { recursive: true, force: true });
  }
});

test('the final safe-integer block can be issued exactly once; exhaustion never wraps', () => {
  const c = new Coordinator(':memory:', () => 10_000);
  try {
    const db = (c as unknown as { db: DatabaseSync }).db;
    db.prepare("UPDATE sequences SET next=? WHERE name='entity_block'").run(MAX_ENTITY_BLOCK);
    assert.throws(() => c.reserveEntities(request('too-large', 2)), code('full'));
    const last = c.reserveEntities(request('last', 1));
    assert.equal(entityBlockRange(last.firstBlock).last, MAX_ENTITY_ID);
    assert.deepEqual(c.reserveEntities(last), last);
    assert.throws(() => c.reserveEntities(request('overflow', 1)), code('full'));
    assert.equal((db.prepare('SELECT COUNT(*) n FROM entity_blocks').get() as { n: number }).n, 1);
    for (const count of [0, -1, .5, 33, NaN]) assert.throws(() => c.reserveEntities(request('invalid', count)), code('invalid'));
  } finally { c.close(); }
});

test('private HTTP retries a lost committed allocation reply without burning or replaying another batch', async () => {
  const c = new Coordinator(':memory:', () => 10_000), secret = randomBytes(32).toString('hex');
  const control = await startControlPlane(c, secret); let dropped = false;
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const upstream = await fetch(`http://127.0.0.1:${control.port}${req.url}`, { method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: Buffer.concat(chunks) });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (req.url === '/entities/reserve' && upstream.ok && !dropped) { dropped = true; res.destroy(); return; }
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(body);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const client = new ControlClient(`http://127.0.0.1:${(proxy.address() as { port: number }).port}`, secret);
  try {
    const boot = request('http-worker', 8), grant = await client.call<EntityGrant>('entities/reserve', boot);
    assert.ok(dropped); assert.equal(grant.firstBlock, 0); assert.deepEqual(c.reserveEntities(boot), grant);
    await client.call('register', registration(boot.node));
    await assert.rejects(client.call('entities/reserve', boot), (error: unknown) => error instanceof ControlError && error.code === 'fenced');
    assert.equal(c.reserveEntities(request('next')).firstBlock, 8);
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve())); await control.close(); c.close();
  }
});
