import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator, OwnershipError, LEASE_MS, NODE_TIMEOUT_MS, type NodeRegistration } from '../src/coordinator.js';
import type { SavedPlayer } from '../src/persistence.js';
import { PLANETS } from '@shared/universe';
import { DatabaseSync } from 'node:sqlite';
import { namespaceRange } from '@shared/entity-id';

const key = 'a'.repeat(64), key2 = 'b'.repeat(64);
const saved = (seed = 1337, salvage = 137): SavedPlayer => ({ version: 1, seed, savedAt: 10_000, faction: 1,
  salvage, discoveries: ['1337:city-2'], x: 0, y: 30, z: 0, health: 77, alive: true, frags: 2, deaths: 1,
  factionWait: 12, combatWait: 4, ammo: [{ magazine: 7, reserve: 81 }] });
const register = (c: Coordinator, capacity = 4): void => {
  for (const p of PLANETS) c.register({ id: p.id, planet: p.id, url: `ws://127.0.0.1:1000/ws`, capacity, humans: 0, tick: 1 });
};
const code = (expected: string) => (error: unknown) => error instanceof OwnershipError && error.code === expected;

test('exclusive leases and epochs fence delayed writes, releases and abandoned handshakes', () => {
  let now = 10_000; const c = new Coordinator(':memory:', () => now); register(c);
  try {
    const first = c.claim(key, 'meridian', 'meridian:one', 'meridian', saved());
    assert.equal(c.claim(key, 'meridian', 'meridian:one', 'meridian').epoch, first.epoch);
    assert.throws(() => c.claim(key, 'meridian', 'meridian:two', 'meridian'), code('busy'));
    const old = { key, epoch: first.epoch, holder: 'meridian:one', state: saved() };
    now += LEASE_MS + 1; register(c);
    const next = c.claim(key, 'meridian', 'meridian:two', 'meridian');
    assert.equal(next.entityId, first.entityId, 'ownership epochs change without changing the actor ID');
    assert.equal(next.epoch, first.epoch + 1);
    assert.deepEqual(c.checkpoint([old]).accepted, []);
    assert.equal(c.release(old), false); assert.equal(c.vacate(key, first.epoch, old.holder), false);
    assert.equal(c.locate(key)!.holder, 'meridian:two');
    assert.equal(c.vacate(key, next.epoch, 'meridian:two'), true);
    assert.equal(c.locate(key)!.state!.salvage, 137, 'abandoning an uninitialized socket preserves the saved character');
  } finally { c.close(); }
});

test('travel commits the destination, cargo and fencing epoch atomically and is idempotent', () => {
  const c = new Coordinator(':memory:'); register(c);
  try {
    const grant = c.claim(key, 'meridian', 'meridian:one', 'meridian');
    const row = { key, epoch: grant.epoch, holder: 'meridian:one', state: saved() }, id = 'a'.repeat(32);
    assert.deepEqual(c.checkpoint([{ ...row, state: saved(7331) }]).accepted, [], 'a snapshot from the wrong world cannot replace the saved character');
    assert.throws(() => c.transfer({ ...row, state: saved(7331) }, 'cinder', id), code('invalid'));
    const result = c.transfer(row, 'cinder', id);
    assert.deepEqual(c.transfer(row, 'cinder', id), result, 'retry after a lost response does not transfer twice');
    assert.equal(result.epoch, grant.epoch + 1);
    assert.throws(() => c.transfer(row, 'nacre', id), code('invalid'));
    assert.throws(() => c.claim(key, 'meridian', 'meridian:two', 'meridian'), code('moved'));
    assert.deepEqual(c.checkpoint([{ ...row, state: saved(1337, 999) }]).accepted, []);
    assert.equal(c.release(row), false);
    const arrival = c.claim(key, 'cinder', 'cinder:arrival', 'cinder');
    assert.equal(arrival.entityId, grant.entityId);
    assert.equal(arrival.state!.seed, 7331); assert.equal(arrival.state!.arrival, true);
    assert.equal(arrival.state!.salvage, 137); assert.equal(arrival.state!.ammo[0].magazine, 7);
    assert.deepEqual(arrival.state!.discoveries, ['1337:city-2']);
  } finally { c.close(); }
});

test('capacity includes pending arrivals; a refused launch leaves the source record unchanged', () => {
  const c = new Coordinator(':memory:'); register(c, 1);
  try {
    const first = c.claim(key, 'meridian', 'meridian:first', 'meridian');
    c.transfer({ key, epoch: first.epoch, holder: 'meridian:first', state: saved() }, 'cinder', 'c'.repeat(32));
    const second = c.claim(key2, 'meridian', 'meridian:second', 'meridian');
    const before = c.locate(key2);
    assert.throws(() => c.transfer({ key: key2, epoch: second.epoch, holder: 'meridian:second', state: saved() }, 'cinder', 'd'.repeat(32)), code('full'));
    assert.deepEqual(c.locate(key2), before);
    assert.throws(() => c.claim(key2, 'cinder', 'cinder:other', 'cinder'), code('moved'));
    assert.equal(c.claim(key, 'cinder', 'cinder:reserved', 'cinder').state!.seed, 7331, 'the reserved player can claim the last slot');
  } finally { c.close(); }
});

test('unavailable destinations reject transfer, and two live authorities cannot register for a planet', () => {
  let now = 10_000; const c = new Coordinator(':memory:', () => now); register(c);
  try {
    const grant = c.claim(key, 'meridian', 'meridian:one', 'meridian', saved());
    assert.throws(() => c.register({ id: 'other', planet: 'meridian', url: 'ws://127.0.0.1:2000/ws', capacity: 4, humans: 0, tick: 1 }), code('busy'));
    now += 8100;
    assert.throws(() => c.transfer({ key, epoch: grant.epoch, holder: 'meridian:one', state: saved() }, 'cinder', 'e'.repeat(32)), code('unavailable'));
    assert.equal(c.locate(key)!.planet, 'meridian');
    assert.ok(c.status().planets.every(p => !p.available));
  } finally { c.close(); }
});

test('ownership and an unacknowledged committed journey survive coordinator restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-authority-'));
  let c: Coordinator | null = null;
  try {
    const file = path.join(root, 'universe.sqlite'); c = new Coordinator(file); register(c);
    const grant = c.claim(key, 'meridian', 'meridian:one', 'meridian');
    const row = { key, epoch: grant.epoch, holder: 'meridian:one', state: saved() }, id = 'f'.repeat(32);
    const committed = c.transfer(row, 'nacre', id); c.close(); c = new Coordinator(file); register(c);
    assert.deepEqual(c.transfer(row, 'nacre', id), committed);
    const arrival = c.claim(key, 'nacre', 'nacre:arrival', 'nacre');
    assert.equal(arrival.entityId, grant.entityId);
    assert.equal(arrival.state!.salvage, 137); assert.equal(arrival.state!.seed, 20077);
    assert.equal(c.release(row), false);
  } finally {
    c?.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('the-mmofps-authority-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('legacy characters migrate once and region namespaces remain disjoint across coordinator restarts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-identity-'));
  let c: Coordinator | null = null;
  try {
    const file = path.join(root, 'universe.sqlite'), legacy = new DatabaseSync(file);
    legacy.exec('CREATE TABLE players (key TEXT PRIMARY KEY, planet TEXT NOT NULL, epoch INTEGER NOT NULL, holder TEXT, lease_until INTEGER NOT NULL, state TEXT) STRICT');
    legacy.prepare('INSERT INTO players(rowid,key,planet,epoch,holder,lease_until,state) VALUES(100000,?,?,1,NULL,0,?)').run(key, 'meridian', JSON.stringify(saved()));
    legacy.close();
    c = new Coordinator(file); register(c);
    const first = c.claim(key, 'meridian', 'meridian:one', 'meridian');
    assert.equal(first.entityId, 100_000); assert.equal(first.state!.salvage, 137);
    const second = c.claim(key2, 'meridian', 'meridian:two', 'meridian');
    assert.equal(second.entityId, 100_001);
    const namespaces = [c.namespace('meridian'), c.namespace('meridian', '4:2'), c.namespace('cinder')];
    assert.equal(new Set(namespaces).size, 3);
    assert.equal(c.namespace('meridian'), namespaces[0]);
    c.close(); c = new Coordinator(file); register(c);
    assert.equal(c.locate(key)!.entityId, first.entityId);
    assert.deepEqual([c.namespace('meridian'), c.namespace('meridian', '4:2'), c.namespace('cinder')], namespaces);
    const next = c.namespace('nacre');
    assert.ok(namespaceRange(next).first > namespaceRange(namespaces[2]).last);
    assert.throws(() => c!.namespace('meridian', '../bad'), code('invalid'));
    assert.equal(c.locate(key2)!.entityId, second.entityId);
  } finally {
    c?.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('the-mmofps-identity-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('planet ownership follows the newest live heartbeat without retaining mutable caller arrays', () => {
  let now = 10000; const c = new Coordinator(':memory:', () => now);
  const ownership: [number, number, number, number] = [.1, .2, .3, .4];
  const registration: NodeRegistration = { id: 'meridian', planet: 'meridian', url: 'ws://127.0.0.1:1000/ws',
    capacity: 64, humans: 3, tick: 0, ownership, ownershipPoints: 10 };
  try {
    const grant = c.register(registration); ownership[0] = 1;
    assert.deepEqual(c.status().planets[0].ownership, [.1, .2, .3, .4]);
    c.route('meridian')!.ownership![0] = 1; c.node('meridian')!.ownership![1] = 1;
    assert.deepEqual(c.status().planets[0].ownership, [.1, .2, .3, .4], 'status and route consumers cannot mutate the cached report');
    now += 2000; c.register({ ...registration, ownership: [0, .25, .25, .5], epoch: grant.epoch, tick: 120 });
    assert.deepEqual(c.status().planets[0].ownership, [0, .25, .25, .5]);
    c.register({ ...registration, ownership: [1, 0, 0, 0], epoch: grant.epoch, tick: 60 });
    assert.deepEqual(c.status().planets[0].ownership, [0, .25, .25, .5], 'a delayed heartbeat cannot roll the map back');
    now += NODE_TIMEOUT_MS + 1;
    assert.equal(c.status().planets[0].ownership, undefined, 'a lost authority cannot publish stale ownership indefinitely');
    c.register({ ...registration, id: 'replacement', ownership: [0, 0, 0, 1], tick: 121 });
    assert.deepEqual(c.status().planets[0].ownership, [0, 0, 0, 1]);
    assert.equal(c.status().planets[0].players, 3, 'retired workers are not counted again');
    assert.throws(() => c.register({ ...registration, ownership: [.1, .2, .3, .4], epoch: grant.epoch }), code('fenced'));
  } finally { c.close(); }
});

test('ownership registration rejects malformed or unnormalized fractions without changing the authority', () => {
  const c = new Coordinator(':memory:'), registration: NodeRegistration = { id: 'meridian', planet: 'meridian',
    url: 'ws://127.0.0.1:1000/ws', capacity: 64, humans: 0, tick: 0, ownership: [1, 0, 0, 0], ownershipPoints: 10 };
  try {
    const grant = c.register(registration);
    for (const invalid of [
      { ownership: [0, 0, 0] }, { ownership: [0, 0, 0, 0] }, { ownership: [1, 1, 0, 0] },
      { ownership: [-.1, 1.1, 0, 0] }, { ownership: [NaN, 0, 0, 0] }, { ownership: [Infinity, 0, 0, 0] },
      { ownership: ['1', 0, 0, 0] }, { ownershipPoints: -1 }, { ownershipPoints: 1.5 }, { ownershipPoints: 100001 },
      { ownership: undefined, ownershipPoints: 10 },
    ]) assert.throws(() => c.register({ ...registration, ...invalid, epoch: grant.epoch } as NodeRegistration), code('invalid'));
    assert.deepEqual(c.status().planets[0].ownership, [1, 0, 0, 0]);
  } finally { c.close(); }
});

test('regional ownership is weighted by control point counts and incomplete reports remain unknown', () => {
  let now = 10000; const c = new Coordinator(':memory:', () => now);
  c.configureRegions('meridian', { version: 2, xCuts: [0], zCuts: [], entry: { x: -1, z: 0 } });
  const registration = (id: string, region: string): NodeRegistration => ({ id, planet: 'meridian', region,
    url: 'ws://127.0.0.1:1000/ws', capacity: 10, humans: 1, tick: 0 });
  try {
    const west = c.register({ ...registration('west', 'r0:0'), ownership: [.5, .5, 0, 0], ownershipPoints: 6 });
    assert.equal(c.status().planets[0].ownership, undefined, 'the missing half of the world is not labeled neutral');
    c.register({ ...registration('east', 'r1:0'), ownership: [0, 0, .25, .75], ownershipPoints: 2 });
    assert.deepEqual(c.status().planets[0].ownership, [.375, .375, .0625, .1875]);
    assert.throws(() => c.register({ ...registration('duplicate', 'r1:0'), ownership: [0, 1, 0, 0], ownershipPoints: 999 }), code('busy'));
    assert.deepEqual(c.status().planets[0].ownership, [.375, .375, .0625, .1875]);
    now += 4000; c.register({ ...registration('west', 'r0:0'), epoch: west.epoch, ownership: [.5, .5, 0, 0], ownershipPoints: 6 });
    now += 4100;
    assert.equal(c.status().planets[0].ownership, undefined, 'one stale region invalidates the whole-planet percentage');
    c.register({ ...registration('east-new', 'r1:0'), ownership: [0, 0, 0, 1], ownershipPoints: 2 });
    assert.deepEqual(c.status().planets[0].ownership, [.375, .375, 0, .25]);
    assert.equal(c.status().planets[0].capacity, 20);
  } finally { c.close(); }
});
