import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator } from '../src/coordinator.js';
import type { SavedPlayer } from '../src/persistence.js';
import { outpostCell, type Outpost } from '@shared/outposts';

const key = 'a'.repeat(64);
const legacySite: Outpost = { id: 1, owner: 1, faction: 1, type: 0, x: -1494, y: 47, z: 1888, facing: 0 };
const saved: SavedPlayer = { version: 1, seed: 1337, savedAt: 1000, faction: 1, salvage: 200, discoveries: [],
  x: -1487, y: 47, z: 1895, health: 100, alive: true, frags: 0, deaths: 0, factionWait: 0, combatWait: 0, ammo: [] };
async function fixture(run: (file: string) => Promise<void> | void): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), 'mmofps-outpost-migration-'));
  try { await run(path.join(root, 'universe.sqlite')); }
  finally {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('mmofps-outpost-migration-'));
    await rm(root, { recursive: true, force: true });
  }
}
function legacy(file: string, bad = false): void {
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE outposts (id INTEGER PRIMARY KEY AUTOINCREMENT, request TEXT NOT NULL UNIQUE,
      key TEXT NOT NULL, planet TEXT NOT NULL, cell TEXT NOT NULL, site TEXT NOT NULL, removed INTEGER NOT NULL DEFAULT 0) STRICT;
      CREATE TABLE salvage_spending (key TEXT PRIMARY KEY, total INTEGER NOT NULL) STRICT;`);
    db.prepare('INSERT INTO salvage_spending(key,total) VALUES(?,?)').run(key, 20);
    const insert = db.prepare('INSERT INTO outposts(id,request,key,planet,cell,site,removed) VALUES(?,?,?,?,?,?,?)');
    insert.run(1, '1'.repeat(32), key, 'meridian', outpostCell(legacySite.x, legacySite.z), JSON.stringify(bad ? {} : legacySite), 0);
    const packed = { ...legacySite, id: 2, x: 2500 };
    insert.run(2, '2'.repeat(32), key, 'meridian', outpostCell(packed.x, packed.z), JSON.stringify(packed), 1);
  } finally { db.close(); }
}
function register(c: Coordinator, id = 'world') {
  return { id, epoch: c.register({ id, planet: 'meridian', region: 'world', url: 'ws://127.0.0.1:1234/ws', capacity: 64, humans: 0, tick: 0 }).epoch };
}

test('legacy camps acquire indexed positions and durable revisions without changing IDs or payments', async () => fixture(file => {
  legacy(file);
  let c = new Coordinator(file, () => 1000);
  const first = register(c), view = c.regionalOutposts(first);
  try {
    assert.deepEqual(view.sites, [legacySite]);
    assert.ok(view.cursor.revision > 0);
    const db = new DatabaseSync(file);
    try {
      assert.equal((db.prepare('SELECT total FROM salvage_spending WHERE key=?').get(key) as { total: number }).total, 20);
      const rows = db.prepare('SELECT id,x,z,revision,removed FROM outposts ORDER BY id').all() as { id: number; x: number; z: number; revision: number; removed: number }[];
      assert.equal(rows.length, 2); assert.equal(rows[0].x, legacySite.x); assert.equal(rows[0].z, legacySite.z);
      assert.equal(rows[1].removed, 1); assert.ok(rows.every(r => r.revision > 0));
    } finally { db.close(); }
    c.unregister(first.id, first.epoch); c.close();
    c = new Coordinator(file, () => 60_000);
    const current = c.regionalOutposts(register(c, 'replacement'));
    assert.equal(current.cursor.revision, view.cursor.revision, 'startup does not manufacture new camp changes');
    assert.deepEqual(current.sites, [legacySite]);
  } finally { c.close(); }
}));

test('a failed camp migration rolls back schema changes and closes its database handle', async () => fixture(file => {
  legacy(file, true);
  assert.throws(() => new Coordinator(file), /persisted camp geometry/);
  const db = new DatabaseSync(file);
  try {
    const columns = db.prepare('PRAGMA table_info(outposts)').all() as { name: string }[];
    assert.equal(columns.some(c => c.name === 'x' || c.name === 'z' || c.name === 'revision'), false);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='outpost_clock'").get(), undefined);
    db.prepare('UPDATE outposts SET site=? WHERE id=1').run(JSON.stringify(legacySite));
  } finally { db.close(); }
  const c = new Coordinator(file);
  try { assert.deepEqual(c.regionalOutposts(register(c)).sites, [legacySite]); } finally { c.close(); }
}));

test('legacy migration crosses bounded pages without skipping packed modules', async () => fixture(file => {
  legacy(file);
  const db = new DatabaseSync(file);
  try {
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO outposts(id,request,key,planet,cell,site,removed) VALUES(?,?,?,?,?,?,1)');
    for (let id = 3; id <= 1202; id++) {
      const packed = { ...legacySite, id, x: legacySite.x - id * .01 };
      insert.run(id, id.toString(16).padStart(32, '0'), key, 'meridian', outpostCell(packed.x, packed.z), JSON.stringify(packed));
    }
    db.exec('COMMIT');
  } finally { db.close(); }
  const c = new Coordinator(file);
  try {
    assert.deepEqual(c.regionalOutposts(register(c)).sites, [legacySite]);
    const check = new DatabaseSync(file);
    try {
      const counts = check.prepare('SELECT count(*) n, count(DISTINCT revision) revisions, min(revision) first FROM outposts').get() as { n: number; revisions: number; first: number };
      assert.equal(counts.n, 1202); assert.equal(counts.revisions, 1); assert.ok(counts.first > 0);
      const last = check.prepare('SELECT x,z,revision FROM outposts WHERE id=1202').get() as { x: number; z: number; revision: number };
      assert.equal(last.x, legacySite.x - 1202 * .01); assert.equal(last.z, legacySite.z); assert.equal(last.revision, counts.first);
    } finally { check.close(); }
  } finally { c.close(); }
}));

test('camp revision exhaustion rolls back spending, geometry and removals', () => {
  const c = new Coordinator(':memory:', () => 1000), authority = register(c);
  try {
    const grant = c.claim(key, 'meridian', 'world:builder', authority.id, saved);
    const row = { key, holder: 'world:builder', epoch: grant.epoch, state: grant.state! };
    const built = c.construct(row, '1'.repeat(32), legacySite), db = (c as unknown as { db: DatabaseSync }).db;
    db.prepare('UPDATE outpost_clock SET revision=? WHERE id=1').run(Number.MAX_SAFE_INTEGER);
    assert.throws(() => c.construct(row, '2'.repeat(32), { ...legacySite, x: -1300 }), /revision space/);
    assert.throws(() => c.construct(row, '3'.repeat(32), undefined, built.site!.id), /revision space/);
    assert.equal(c.locate(key)!.state!.salvage, 180);
    assert.equal(c.outposts('meridian').length, 1);
    assert.equal(c.regionalOutposts(authority).cursor.revision, built.revision);
    assert.deepEqual(c.construct(row, '1'.repeat(32), legacySite), built, 'an existing receipt needs no new revision');
  } finally { c.close(); }
});

test('restart repairs a lowered revision counter before allocating another change', async () => fixture(file => {
  let c = new Coordinator(file, () => 1000);
  let before = 0;
  try {
    const a = register(c), grant = c.claim(key, 'meridian', 'world:builder', a.id, saved);
    const row = { key, holder: 'world:builder', epoch: grant.epoch, state: grant.state! };
    const built = c.construct(row, '1'.repeat(32), legacySite);
    before = c.construct(row, '2'.repeat(32), undefined, built.site!.id).revision;
    c.release({ ...row, state: c.locate(key)!.state! }); c.unregister(a.id, a.epoch); c.close();
    const db = new DatabaseSync(file);
    try { db.exec('UPDATE outpost_clock SET revision=0'); } finally { db.close(); }
    c = new Coordinator(file, () => 60_000);
    const next = register(c, 'replacement'), arrival = c.claim(key, 'meridian', 'replacement:builder', next.id);
    const result = c.construct({ key, holder: 'replacement:builder', epoch: arrival.epoch, state: arrival.state! }, '3'.repeat(32), legacySite);
    assert.ok(result.revision > before);
    assert.equal(c.locate(key)!.state!.salvage, 160);
  } finally { c.close(); }
}));
