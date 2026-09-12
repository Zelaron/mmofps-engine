import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator } from '../src/coordinator.js';
import { Game } from '../src/game.js';
import { capturePlayer, type SavedPlayer } from '../src/persistence.js';
import { OutpostField, planOutpost, outpostCell, type Outpost } from '@shared/outposts';
import { ByteReader, Msg } from '@shared/protocol';
import { encodeOutposts, decodeOutposts, encodeOutpostAction, decodeOutpostAction } from '@shared/outpost-wire';
import { capsuleClearance } from '@shared/physics';
import { WEAPONS } from '@shared/weapons';

const key = 'c'.repeat(64), holder = 'meridian:builder';
const saved = (): SavedPlayer => ({ version: 1, seed: 1337, savedAt: Date.now(), faction: 1, salvage: 200, discoveries: [],
  x: -1487, y: 47, z: 1888, health: 70, alive: true, frags: 0, deaths: 0, factionWait: 0, combatWait: 0, ammo: [] });
const site = { type: 0, x: -1494, y: 46.97084567183978, z: 1888, facing: 0 };
function register(c: Coordinator): void { c.register({ id: 'meridian', planet: 'meridian', url: 'ws://127.0.0.1:1234/ws', capacity: 8, humans: 0, tick: 1 }); }

test('building, spending and idempotency survive stale checkpoints, releases and a database restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mmofps-camps-')), file = path.join(root, 'world.sqlite');
  let c = new Coordinator(file);
  try {
    register(c); const grant = c.claim(key, 'meridian', holder, 'meridian');
    const row = { key, holder, epoch: grant.epoch, state: saved() };
    const built = c.construct(row, 'a'.repeat(32), site);
    assert.equal(built.spent, 20); assert.equal(c.locate(key)!.state!.salvage, 180);
    assert.deepEqual(c.construct(row, 'a'.repeat(32), site), built, 'a lost response never charges twice');
    assert.equal(c.outposts('meridian').length, 1); assert.equal(c.outposts('cinder').length, 0);
    c.checkpoint([row]); assert.equal(c.locate(key)!.state!.salvage, 180, 'a pre-build checkpoint cannot refund construction');
    c.release(row); assert.equal(c.locate(key)!.state!.salvage, 180, 'disconnect racing the response cannot refund it either');
    c.close(); c = new Coordinator(file); register(c);
    const next = c.claim(key, 'meridian', 'meridian:again', 'meridian');
    assert.equal(next.state!.salvage, 180); assert.equal(next.state!.salvageSpent, 20);
    assert.equal(c.outposts('meridian')[0].owner, next.entityId);
    assert.throws(() => c.construct(row, 'b'.repeat(32), { ...site, x: site.x + 20 }), /ownership/);
    const pack = { key, holder: 'meridian:again', epoch: next.epoch, state: next.state! };
    c.construct(pack, 'd'.repeat(32), undefined, built.site!.id);
    c.construct(pack, 'd'.repeat(32), undefined, built.site!.id);
    assert.equal(c.outposts('meridian').length, 0); assert.equal(c.locate(key)!.state!.salvage, 180);
  } finally { c.close(); await rm(root, { recursive: true, force: true }); }
});

test('rejected construction rolls back both cost and geometry; cell and owner budgets bound density', () => {
  const c = new Coordinator(':memory:'); register(c);
  try {
    const grant = c.claim(key, 'meridian', holder, 'meridian');
    let row = { key, holder, epoch: grant.epoch, state: saved() };
    assert.throws(() => c.construct({ ...row, state: { ...row.state, salvage: 2 } }, 'b'.repeat(32), site), /salvage/);
    assert.equal(c.outposts('meridian').length, 0); assert.equal(c.locate(key)!.state, null);
    for (let i = 0; i < 6; i++) {
      const p = { ...site, x: i < 4 ? -1450 + i * 12 : -1200 + (i - 4) * 15, z: 1800 };
      c.construct(row, String(i).repeat(32), p); row = { ...row, state: c.locate(key)!.state! };
      if (i === 3) assert.throws(() => c.construct(row, 'e'.repeat(32), { ...p, x: -1455 }), /four modules/);
    }
    assert.throws(() => c.construct(row, 'f'.repeat(32), { ...site, x: -900 }), /old module/);
    assert.equal(c.outposts('meridian').length, 6); assert.equal(c.locate(key)!.state!.salvage, 80);
    assert.throws(() => c.construct(row, 'a'.repeat(32), { ...site, x: NaN }), /Invalid/);
    assert.equal(c.locate(key)!.state!.salvage, 80);
  } finally { c.close(); }
});

test('authoritative placement keeps cities, occupied sites, distant requests and combat clear', () => {
  const game = new Game(1337), p = game.addPlayer('Builder', null); game.camps.enabled = true;
  Object.assign(p.state, { px: site.x + 7, py: game.world.groundY(site.x + 7, site.z) + .01, pz: site.z, grounded: true });
  p.salvage = 100;
  const prepared = game.camps.prepare(p, 0, site.x, site.z, 0);
  assert.ok(Math.abs(prepared.y - site.y) < .001); game.camps.reservations.delete(prepared);
  assert.throws(() => game.camps.prepare(p, 0, site.x + 50, site.z, 0), /ten metres/);
  p.regenBlockUntil = game.tick + 60; assert.throws(() => game.camps.prepare(p, 0, site.x, site.z, 0), /combat/); p.regenBlockUntil = 0;
  const other = game.addPlayer('Walker', null); Object.assign(other.state, { px: site.x, py: site.y, pz: site.z });
  assert.throws(() => game.camps.prepare(p, 0, site.x, site.z, 0), /people/);
  const city = game.world.collectCities()[0]; assert.match(planOutpost(game.world, 0, city.x, city.z, 0).reason!, /outskirts/);
  assert.equal(capturePlayer(game, p).salvageSpent, 0);
});

test('client/server camp collision matches on a real wilderness floor and disappears when packed', () => {
  const a = new Game(1337).world, b = new Game(1337).world;
  const planned = planOutpost(a, 0, site.x, site.z, 0); assert.equal(planned.reason, null);
  const built: Outpost = { ...planned.site, id: 1, owner: 0x71234567, faction: 0 };
  a.outposts.add(built); b.outposts.add(built);
  const trace = (w: typeof a) => w.trace(site.x, site.y + 1.3, site.z + 5, 0, 0, -1, 9);
  const one = trace(a), two = trace(b); assert.deepEqual(one, two); assert.equal(one.hit, true); assert.ok(one.dist > 7.5 && one.dist < 8);
  assert.ok(capsuleClearance(a, site.x, site.y + .21, site.z) > -.02, 'the roof leaves room for a standing capsule');
  assert.ok(a.sdf(site.x, site.y + 1.2, site.z - 2.8) < 0, 'the shelter wall is authoritative cover');
  a.outposts.remove(1); b.outposts.remove(1); assert.deepEqual(trace(a), trace(b));
  assert.ok(a.sdf(site.x, site.y + 1.2, site.z - 2.8) > 0, 'packing removes the collider');
});

test('camp services respect allegiance, combat and rare-ammunition rules without stacking', () => {
  const game = new Game(1337), owner = game.addPlayer('Owner', null), ally = game.addPlayer('Ally', null), enemy = game.addPlayer('Enemy', null), neutral = game.addPlayer('Explorer', null);
  const point = { x: site.x, y: site.y, z: site.z };
  owner.faction = ally.faction = 1; enemy.faction = 2;
  for (const p of [owner, ally, enemy, neutral]) { Object.assign(p.state, { px: point.x, py: point.y, pz: point.z + 3 }); p.health = 30; p.ammo.forEach(a => a.reserve = 0); }
  for (let i = 1; i <= 3; i++) game.world.outposts.add({ ...point, facing: 0, id: i, owner: owner.id, faction: 1, type: i === 3 ? 2 : 1 });
  game.camps.step(); assert.equal(owner.health, 36); assert.equal(ally.health, 36); assert.equal(enemy.health, 30); assert.equal(neutral.health, 30);
  assert.ok(owner.ammo[1].reserve > 0);
  for (const def of WEAPONS.filter(d => d.spawnEmpty)) assert.equal(owner.ammo[def.id].reserve, 0);
  owner.regenBlockUntil = 100; game.camps.step(); assert.equal(owner.health, 36);
  game.world.outposts.replace([{ ...point, id: 4, owner: neutral.id, faction: 0, type: 1, facing: 0 }]);
  game.camps.step(); assert.equal(neutral.health, 36); assert.equal(enemy.health, 30);
});

test('construction subscriptions are bounded, update on removal and retain high entity IDs', () => {
  const field = new OutpostField(); let id = 0;
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let n = 0; n < 4; n++) field.add({ id: ++id, owner: 0x71234567, faction: 2, type: n % 3, facing: n, x: x * 128 + n * 10, y: 20, z: z * 128 });
  field.add({ id: 101, owner: 1, faction: 0, type: 0, facing: 0, x: 1000, y: 20, z: 1000 });
  const sites = field.nearby(0, 0); assert.equal(sites.length, 100);
  const bytes = encodeOutposts({ enabled: true, sites }), r = new ByteReader(bytes); assert.equal(r.u8(), Msg.SOutposts);
  assert.deepEqual(decodeOutposts(r), { enabled: true, sites }); assert.ok(bytes.length < 2400);
  const stamp = field.stamp(0, 0); field.remove(1); assert.notEqual(field.stamp(0, 0), stamp);
  const next = field.stamp(0, 0); field.remove(101); assert.equal(field.stamp(0, 0), next, 'distant edits do not resend a local subscription');
  assert.throws(() => { const r = new ByteReader(bytes.slice(0, -1)); r.u8(); decodeOutposts(r); });
  for (const action of [{ action: 'build' as const, type: 1, facing: 3, x: -1494, z: 1888 }, { action: 'remove' as const, id: 0x71234567 }]) {
    const r = new ByteReader(encodeOutpostAction(action)); r.u8(); assert.deepEqual(decodeOutpostAction(r), action);
  }
});


test('a superseded world cannot build with a character lease that has not expired yet', () => {
  let now = 1000; const c = new Coordinator(':memory:', () => now); register(c);
  try {
    const grant = c.claim(key, 'meridian', holder, 'meridian');
    now += 8500;
    c.register({ id: 'meridian:new', planet: 'meridian', url: 'ws://127.0.0.1:4321/ws', capacity: 8, humans: 0, tick: 1 });
    assert.ok(c.locate(key)!.leaseUntil > now);
    assert.throws(() => c.construct({ key, holder, epoch: grant.epoch, state: saved() }, 'a'.repeat(32), site), /World authority/);
    assert.equal(c.outposts('meridian').length, 0);
  } finally { c.close(); }
});

test('camp contact neighborhoods update through replacement, removal and distant traversal', () => {
  const field = new OutpostField(), one: Outpost = { id: 1, owner: 1, faction: 0, type: 0, facing: 0, x: 0, y: 20, z: 0 };
  field.add(one); assert.ok(field.distance(0, 21.2, -2.8, 99) < 0);
  field.replace([{ ...one, x: 1000 }]);
  assert.equal(field.distance(0, 21.2, -2.8, 99), 99);
  assert.ok(field.distance(1000, 21.2, -2.8, 99) < 0);
  field.remove(1); assert.equal(field.distance(1000, 21.2, -2.8, 99), 99);
  field.add({ ...one, facing: 1 });
  assert.ok(field.distance(4.1, 19.63, 0, 99) < 0, 'rotated entrance ramp has solid support below its slope');
  assert.ok(field.distance(4.1, 19.73, 0, 99) > 0, 'rotated ramp leaves air above its slope');
  field.replace([]); assert.equal(field.distance(4.1, 19.63, 0, 99), 99);
});
