import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { Coordinator, type Checkpoint } from '../src/coordinator.js';
import { startControlPlane } from '../src/control-plane.js';
import { WorldNode } from '../src/world-node.js';
import { Game } from '../src/game.js';
import type { SavedPlayer } from '../src/persistence.js';
import type { AuthorityToken } from '../src/region-transfers.js';
import { World } from '@shared/worldgen';
import { OutpostField } from '@shared/outposts';
import { OutpostReplica } from '../src/outpost-replica.js';

const moduleSite = { type: 0, x: -1494, y: 46.97084567183978, z: 1888, facing: 0 };
const layout = { version: 2, xCuts: [-1494.25, 0], zCuts: [1888], entry: { x: -1600, z: 1800 } };
const saved = (x: number, z: number): SavedPlayer => ({ version: 1, seed: 1337, savedAt: 1000,
  faction: 1, salvage: 200, discoveries: [], x, y: 47, z, health: 100, alive: true,
  frags: 0, deaths: 0, factionWait: 0, combatWait: 0, ammo: [] });
function register(c: Coordinator, id: string, region: string): AuthorityToken {
  const grant = c.register({ id, planet: 'meridian', region, url: 'ws://127.0.0.1:1234/ws', capacity: 64, humans: 0, tick: 0 });
  return { id, epoch: grant.epoch };
}
function builder(c: Coordinator, authority: AuthorityToken, digit: string, x: number, z: number): Checkpoint {
  const key = digit.repeat(64), holder = `${authority.id}:${digit}`, state = saved(x, z);
  const grant = c.claim(key, 'meridian', holder, authority.id, state);
  return { key, holder, epoch: grant.epoch, state: grant.state! };
}

test('regional camp views include edge and corner neighbors while distant changes stay out of the payload', () => {
  const c = new Coordinator(':memory:', () => 1000);
  try {
    c.configureRegions('meridian', layout);
    const owner = register(c, 'owner', 'r1:1'), diagonal = register(c, 'diagonal', 'r0:0');
    const south = register(c, 'south', 'r1:0'), far = register(c, 'far', 'r2:1');
    const row = builder(c, owner, 'a', -1487, 1895), remote = builder(c, far, 'b', 3007, 2000);
    const before = c.regionalOutposts(diagonal);
    assert.deepEqual(before.sites, []);
    assert.equal(c.regionalOutposts(diagonal, before.cursor).sites, null);
    const built = c.construct(row, '1'.repeat(32), moduleSite);
    for (const authority of [owner, diagonal, south]) {
      const view = c.regionalOutposts(authority);
      assert.deepEqual(view.sites, [built.site]);
      assert.equal(view.cursor.revision, built.revision);
      assert.equal(view.cursor.authority.id, authority.id);
    }
    const observed = c.regionalOutposts(diagonal);
    assert.deepEqual(c.regionalOutposts(far).sites, []);
    c.construct(remote, '2'.repeat(32), { ...moduleSite, x: 3000, z: 2000 });
    assert.equal(c.regionalOutposts(diagonal, observed.cursor).sites, null, 'a distant cell must not resend the planet');
    assert.equal(c.regionalOutposts(far).sites!.length, 1);
    assert.equal(c.outposts('meridian').length, 2, 'the durable store still contains both regions');
    const packed = c.construct(row, '3'.repeat(32), undefined, built.site!.id);
    assert.ok(packed.revision > built.revision);
    assert.deepEqual(c.regionalOutposts(diagonal, observed.cursor).sites, [], 'packing the last module publishes an empty replacement');
    assert.deepEqual(c.construct(row, '3'.repeat(32), undefined, built.site!.id), packed, 'removal retries keep the same revision and receipt');
    assert.equal(c.locate(row.key)!.state!.salvage, 180);
  } finally { c.close(); }
});

test('a camp has one geographic mutation owner even when the builder changes regions', () => {
  const c = new Coordinator(':memory:', () => 1000);
  try {
    c.configureRegions('meridian', layout);
    const east = register(c, 'east', 'r1:1'), west = register(c, 'west', 'r0:1');
    const row = builder(c, east, 'a', -1487, 1895), outsider = builder(c, west, 'b', -1501, 1895);
    const built = c.construct(row, '1'.repeat(32), moduleSite);
    assert.throws(() => c.construct(outsider, '2'.repeat(32), { ...moduleSite, z: 1900 }), /temporarily unavailable/);
    assert.equal(c.locate(outsider.key)!.state!.salvage, 200);
    assert.equal(c.outposts('meridian').length, 1);
    // Saved-position reconnect routing is already supported independently of
    // the still-unfinished automatic runtime crossing orchestration.
    c.release({ ...row, state: { ...c.locate(row.key)!.state!, x: -1501 } });
    const moved = c.claim(row.key, 'meridian', 'west:returned', west.id);
    const remote = { key: row.key, holder: 'west:returned', epoch: moved.epoch, state: moved.state! };
    assert.deepEqual(c.regionalOutposts(west).sites, [built.site], 'the nearby replica remains readable');
    assert.throws(() => c.construct(remote, '3'.repeat(32), undefined, built.site!.id), /temporarily unavailable/);
    c.release({ ...remote, state: { ...remote.state, x: -1487 } });
    const back = c.claim(row.key, 'meridian', 'east:returned', east.id);
    c.construct({ key: row.key, holder: 'east:returned', epoch: back.epoch, state: back.state! }, '4'.repeat(32), undefined, built.site!.id);
    assert.equal(c.outposts('meridian').length, 0);
    assert.equal(c.locate(row.key)!.state!.salvage, 180, 'region changes cannot refund spending');
  } finally { c.close(); }
});

test('construction receipts publish the complete current cell across an ownership seam', () => {
  const c = new Coordinator(':memory:', () => 1000);
  try {
    c.configureRegions('meridian', { ...layout, zCuts: [] });
    const east = register(c, 'east', 'r1:0'), west = register(c, 'west', 'r0:0');
    const a = builder(c, east, 'a', -1473, 1888), b = builder(c, west, 'b', -1515, 1888);
    const field = new OutpostField(), replica = new OutpostReplica(field, { id: west.id, planet: 'meridian', region: 'r0:0' });
    replica.bind(west.epoch); replica.apply(c.regionalOutposts(west));
    const temporary = c.construct(a, '1'.repeat(32), { ...moduleSite, x: -1480 });
    const delayed = c.regionalOutposts(west);
    c.construct(a, '2'.repeat(32), undefined, temporary.site!.id);
    const built = c.construct(b, '3'.repeat(32), { ...moduleSite, x: -1508 });
    assert.deepEqual(built.cell.sites, [built.site]);
    replica.commit(built.cell, built.site!); replica.apply(delayed);
    assert.deepEqual([...field.sites.values()], [built.site], 'an old snapshot cannot restore the packed neighbor');
    const neighbor = c.construct(a, '4'.repeat(32), { ...moduleSite, x: -1464 });
    const retry = c.construct(b, '3'.repeat(32), { ...moduleSite, x: -1508 });
    assert.equal(retry.revision, built.revision, 'the operation retains its original revision');
    assert.equal(retry.cell.revision, neighbor.cell.revision, 'the attached cell is a fresh atomic read');
    assert.deepEqual(retry.cell.sites, [built.site, neighbor.site]);
    replica.commit(retry.cell, built.site!);
    assert.equal(field.sites.size, 2);
    assert.equal(c.locate(b.key)!.state!.salvage, 180, 'retrying the write cannot pay for another module');
  } finally { c.close(); }
});

test('stale authorities and foreign cursors cannot select another camp scope', () => {
  const c = new Coordinator(':memory:', () => 1000);
  try {
    c.configureRegions('meridian', layout);
    const east = register(c, 'east', 'r1:1'), far = register(c, 'far', 'r2:1');
    const row = builder(c, east, 'a', -1487, 1895);
    const built = c.construct(row, '1'.repeat(32), moduleSite), old = c.regionalOutposts(east);
    assert.deepEqual(c.regionalOutposts(far, old.cursor).sites, [], 'the caller cannot enlarge its authorized view with a cursor');
    assert.throws(() => c.regionalOutposts({ ...east, epoch: east.epoch + 1 }), /authority/);
    assert.throws(() => c.regionalOutposts(east, { ...old.cursor, revision: NaN }), /cursor/);
    c.unregister(east.id, east.epoch);
    const replacement = register(c, 'east-replacement', 'r1:1');
    assert.throws(() => c.regionalOutposts(east), /authority/);
    const fresh = c.regionalOutposts(replacement, old.cursor);
    assert.deepEqual(fresh.sites, [built.site], 'a new incarnation receives a full baseline');
    assert.throws(() => c.construct(row, '2'.repeat(32), moduleSite), /authority/);
  } finally { c.close(); }
});

test('maintenance layout changes reassign camp ownership without changing IDs or salvage', () => {
  let now = 1000;
  const c = new Coordinator(':memory:', () => now);
  try {
    c.configureRegions('meridian', layout);
    const owner = register(c, 'original', 'r1:1'), row = builder(c, owner, 'a', -1487, 1895);
    const built = c.construct(row, '1'.repeat(32), moduleSite), old = c.regionalOutposts(owner);
    assert.throws(() => c.configureRegions('meridian', { version: 3, xCuts: [0], zCuts: [], entry: layout.entry }), /live|active|lease|authority/i);
    now += 60_000;
    c.configureRegions('meridian', { version: 3, xCuts: [0], zCuts: [], entry: layout.entry });
    const merged = register(c, 'merged', 'r0:0'), current = c.regionalOutposts(merged, old.cursor);
    assert.equal(current.cursor.layoutVersion, 3);
    assert.deepEqual(current.sites, [built.site]);
    assert.equal(c.locate(row.key)!.state!.salvage, 180);
  } finally { c.close(); }
});

test('both sides of a region seam use the same camp walls and remove them together', () => {
  const c = new Coordinator(':memory:', () => 1000);
  try {
    c.configureRegions('meridian', layout);
    const owner = register(c, 'owner', 'r1:1'), neighbor = register(c, 'neighbor', 'r0:0');
    const row = builder(c, owner, 'a', -1487, 1895), worlds = [new World(1337), new World(1337)];
    const probes = [[moduleSite.x, moduleSite.y + 1.15, moduleSite.z - 2.8], [moduleSite.x - 2.8, moduleSite.y + .7, moduleSite.z]];
    const empty = probes.map(([x, y, z]) => worlds[0].sdf(x, y, z));
    assert.ok(empty.every(d => d > .1));
    const built = c.construct(row, '1'.repeat(32), moduleSite);
    for (const [i, authority] of [owner, neighbor].entries()) worlds[i].outposts.replace(c.regionalOutposts(authority).sites!);
    for (const [x, y, z] of probes) {
      assert.ok(worlds[0].sdf(x, y, z) < 0);
      assert.equal(worlds[1].sdf(x, y, z), worlds[0].sdf(x, y, z));
    }
    c.construct(row, '2'.repeat(32), undefined, built.site!.id);
    for (const [i, authority] of [owner, neighbor].entries()) worlds[i].outposts.replace(c.regionalOutposts(authority).sites!);
    for (const [i, [x, y, z]] of probes.entries()) for (const world of worlds) assert.equal(world.sdf(x, y, z), empty[i]);
  } finally { c.close(); }
});

test('running regional WorldNodes refresh neighboring camp collision over private HTTP', { timeout: 30_000 }, async () => {
  const c = new Coordinator(':memory:'), secret = randomBytes(32).toString('hex');
  c.configureRegions('meridian', layout);
  const control = await startControlPlane(c, secret), nodes: WorldNode[] = [], games: Game[] = [];
  const until = async (check: () => boolean) => {
    const end = performance.now() + 10_000;
    while (!check() && performance.now() < end) await new Promise(r => setTimeout(r, 25));
    assert.ok(check(), 'regional collision replication completed');
  };
  try {
    for (const [id, region] of [['owner', 'r1:1'], ['neighbor', 'r0:0']]) {
      // Other regional entity controllers remain separate integration work.
      const game = new Game(1337, { vehicles: false, teleporters: false, wildlife: false, frontier: false }); games.push(game);
      const node = new WorldNode(game, { id, region, planet: 'meridian', secret, url: `http://127.0.0.1:${control.port}` }, 64); nodes.push(node);
      await node.start(1234);
    }
    const row = builder(c, { id: 'owner', epoch: nodes[0].status.epoch }, 'a', -1487, 1895);
    const built = c.construct(row, '1'.repeat(32), moduleSite);
    await until(() => games.every(g => g.world.outposts.sites.has(built.site!.id)));
    assert.ok(nodes.every(n => n.status.ready));
    assert.ok(games.every(g => g.world.sdf(moduleSite.x, moduleSite.y + 1.15, moduleSite.z - 2.8) < 0));
    c.construct(row, '2'.repeat(32), undefined, built.site!.id);
    await until(() => games.every(g => !g.world.outposts.sites.has(built.site!.id)));
    assert.ok(nodes.every(n => n.status.ready));
  } finally { await Promise.all(nodes.map(n => n.close())); await control.close(); c.close(); }
});

test('a live authority pauses when its regional camp view expires and resumes with fresh colliders', { timeout: 30_000 }, async () => {
  const c = new Coordinator(':memory:'), secret = randomBytes(32).toString('hex');
  c.configureRegions('meridian', layout);
  const control = await startControlPlane(c, secret);
  let blocked = false, rejectedReads = 0;
  const proxy = createServer(async (req, res) => {
    if (blocked && req.url === '/outposts/region') { rejectedReads++; res.writeHead(503).end(); return; }
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await fetch(`http://127.0.0.1:${control.port}${req.url}`, { method: 'POST', body: Buffer.concat(chunks),
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } });
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(await response.text());
    } catch { res.writeHead(503).end(); }
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const game = new Game(1337, { vehicles: false, teleporters: false, wildlife: false, frontier: false });
  const node = new WorldNode(game, { id: 'neighbor', region: 'r0:0', planet: 'meridian', secret,
    url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` }, 64);
  const until = async (check: () => boolean) => {
    const end = performance.now() + 12_000;
    while (!check() && performance.now() < end) await new Promise(r => setTimeout(r, 25));
    assert.ok(check());
  };
  try {
    await node.start(1234); assert.ok(node.status.ready);
    blocked = true;
    await until(() => !node.status.ready);
    assert.ok(rejectedReads >= 2); assert.ok(c.node('neighbor'), 'the world authority itself is still leased');
    assert.equal(node.step(), false, 'stale neighboring collision must not keep simulating');
    const owner = register(c, 'owner', 'r1:1'), row = builder(c, owner, 'a', -1487, 1895);
    const built = c.construct(row, '1'.repeat(32), moduleSite);
    assert.equal(game.world.outposts.sites.has(built.site!.id), false);
    blocked = false;
    await until(() => node.status.ready && game.world.outposts.sites.has(built.site!.id));
    assert.ok(game.world.sdf(moduleSite.x, moduleSite.y + 1.15, moduleSite.z - 2.8) < 0);
    assert.equal(node.step(), true);
  } finally {
    blocked = false; await node.close();
    await new Promise<void>(r => proxy.close(() => r())); await control.close(); c.close();
  }
});
