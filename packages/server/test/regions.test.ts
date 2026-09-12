import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Coordinator, OwnershipError, NODE_TIMEOUT_MS } from '../src/coordinator.js';
import type { SavedPlayer } from '../src/persistence.js';

const layout = { version: 2, xCuts: [0], zCuts: [], entry: { x: -10, z: 0 } };
const saved = (x: number): SavedPlayer => ({ version: 1, seed: 1337, savedAt: 10_000, faction: 0,
  salvage: 30, discoveries: [], x, y: 600, z: 0, health: 100, alive: true, frags: 0, deaths: 0,
  factionWait: 0, combatWait: 0, ammo: [{ magazine: 7, reserve: 81 }] });
const code = (expected: string) => (error: unknown) => error instanceof OwnershipError && error.code === expected;
const worker = (id: string, region: string) => ({ id, region, planet: 'meridian' as const,
  url: 'ws://127.0.0.1:1000/ws', capacity: 1, humans: 0, tick: 0 });

test('multiple regional authorities share a clock while routing and capacity remain geographic', () => {
  let now = 10_000; const c = new Coordinator(':memory:', () => now);
  try {
    c.configureRegions('meridian', layout);
    const west = c.register(worker('west', 'r0:0')), east = c.register(worker('east', 'r1:0'));
    assert.equal(west.clockTick, east.clockTick);
    assert.equal(c.route('meridian')!.id, 'west');
    assert.equal(c.region('meridian', { x: 0, z: 0 }).id, 'r1:0');
    assert.equal(c.neighbors('meridian', 'r0:0')[0].node!.id, 'east');
    assert.throws(() => c.register(worker('overlap', 'r0:0')), code('busy'));
    assert.throws(() => c.register(worker('unconfigured', 'world')), code('invalid'));
    assert.throws(() => c.register(worker('west', 'r1:0')), code('busy'));
    c.claim('a'.repeat(64), 'meridian', 'west:a', 'west', saved(-1));
    c.claim('b'.repeat(64), 'meridian', 'east:b', 'east', saved(1));
    assert.equal(c.routeCharacter('b'.repeat(64))!.id, 'east');
    assert.throws(() => c.claim('c'.repeat(64), 'meridian', 'east:c', 'east', saved(-1)), code('moved'));
    assert.throws(() => c.claim('c'.repeat(64), 'meridian', 'west:c', 'west', saved(-1)), code('full'));
    assert.equal(c.status().planets[0].capacity, 2);
    assert.throws(() => c.configureRegions('meridian', { ...layout, version: 3, xCuts: [1000] }), code('busy'));
    assert.deepEqual(c.configureRegions('meridian', layout), layout, 'exact layout retries are safe while running');
    now += NODE_TIMEOUT_MS + 1;
    c.register(worker('west2', 'r0:0'));
    assert.equal(c.route('meridian', 'r1:0'), null);
    assert.throws(() => c.register({ ...worker('west', 'r0:0'), epoch: west.epoch }), code('fenced'));
    assert.throws(() => c.register(worker('west', 'r1:0')), code('fenced'), 'retired process IDs cannot claim another region');
    assert.equal(c.routeCharacter('b'.repeat(64)), null, 'a missing region is not replaced with the nearest available worker');
  } finally { c.close(); }
});

test('regional layout and independent authority epochs survive a coordinator restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-regions-')); let now = 10_000;
  const file = path.join(root, 'world.sqlite'); let c = new Coordinator(file, () => now);
  try {
    c.configureRegions('meridian', layout);
    const a = c.register(worker('west', 'r0:0')), b = c.register(worker('east', 'r1:0'));
    const westNamespace = c.namespace('meridian', 'r0:0');
    c.claim('a'.repeat(64), 'meridian', 'west:a', 'west', saved(-1));
    c.close(); now -= 5000; c = new Coordinator(file, () => now);
    assert.deepEqual(c.layout('meridian'), layout);
    assert.equal(c.namespace('meridian', 'r0:0'), westNamespace);
    assert.equal(c.locate('a'.repeat(64))!.region, 'r0:0');
    assert.throws(() => c.register(worker('west2', 'r0:0')), code('busy'));
    c.register({ ...worker('east', 'r1:0'), epoch: b.epoch });
    now += NODE_TIMEOUT_MS + 1;
    assert.equal(c.register(worker('west2', 'r0:0')).epoch, a.epoch + 1);
    assert.equal(c.register(worker('east2', 'r1:0')).epoch, b.epoch + 1);
    assert.equal(c.claim('a'.repeat(64), 'meridian', 'west2:a', 'west2').entityId, 1);
  } finally {
    c.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('the-mmofps-regions-')); await rm(root, { recursive: true, force: true });
  }
});

test('old whole-planet SQLite authorities migrate without losing their fencing epoch', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-region-migration-')), file = path.join(root, 'world.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE world_authorities (planet TEXT PRIMARY KEY,id TEXT NOT NULL,epoch INTEGER NOT NULL,lease_until INTEGER NOT NULL,
    url TEXT NOT NULL,capacity INTEGER NOT NULL,humans INTEGER NOT NULL,tick INTEGER NOT NULL) STRICT;
    INSERT INTO world_authorities VALUES('meridian','old-world',17,20000,'ws://127.0.0.1:1000/ws',64,0,100);
    CREATE TABLE world_incarnations(id TEXT PRIMARY KEY,planet TEXT NOT NULL) STRICT;
    INSERT INTO world_incarnations VALUES('old-world','meridian');`); db.close();
  const c = new Coordinator(file, () => 10_000);
  try {
    assert.equal(c.route('meridian')!.region, 'world'); assert.equal(c.route('meridian')!.epoch, 17);
    assert.throws(() => c.register(worker('replacement', 'world')), code('busy'));
    assert.equal(c.register({ ...worker('old-world', 'world'), epoch: 17 }).epoch, 17);
  } finally {
    c.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('the-mmofps-region-migration-')); await rm(root, { recursive: true, force: true });
  }
});
