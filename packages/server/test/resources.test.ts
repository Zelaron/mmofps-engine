import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator } from '../src/coordinator.js';
import { ResourceLedger } from '../src/resource-ledger.js';
import { OutpostLedger } from '../src/outpost-ledger.js';
import { Gathering } from '../src/gathering.js';
import { Game, ServerPlayer } from '../src/game.js';
import { resourceCandidate, RESOURCE_YIELD, RESOURCE_RENEW_SECONDS } from '@shared/resources';
import { TICK_RATE } from '@shared/constants';
import type { SavedPlayer } from '../src/persistence.js';

const key = 'a'.repeat(64), other = 'b'.repeat(64), candidate = resourceCandidate(1337, '0,0');
const saved = (): SavedPlayer => ({ version: 1, seed: 1337, savedAt: 10000, faction: 0, salvage: 30, discoveries: [],
  x: candidate.x, y: 10, z: candidate.z, health: 100, alive: true, frags: 0, deaths: 0, factionWait: 0, combatWait: 0, ammo: [] });

test('extraction commits one shared depletion and credit, reconciles delayed spending/checkpoints, and survives coordinator restart', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'mmofps-resources-')), file = path.join(directory, 'universe.sqlite');
  let now = 10000, coordinator = new Coordinator(file, () => now, () => now);
  try {
    const authority = coordinator.register({ id: 'source', planet: 'meridian', url: 'ws://127.0.0.1:1/ws', capacity: 4, humans: 0, tick: 0 });
    const grant = coordinator.claim(key, 'meridian', 'source:one', 'source', saved());
    const row = { key, holder: 'source:one', epoch: grant.epoch, state: saved() };
    const rival = coordinator.claim(other, 'meridian', 'source:two', 'source', saved());
    const receipt = coordinator.harvest(row, 'a'.repeat(16), candidate.id, 0);
    assert.equal(receipt.earned, RESOURCE_YIELD);
    assert.deepEqual(coordinator.harvest(row, 'a'.repeat(16), candidate.id, 0), receipt);
    assert.throws(() => coordinator.harvest({ ...row, key: other, holder: 'source:two', epoch: rival.epoch }, 'b'.repeat(16), candidate.id, 0), /regrowing/);
    assert.equal(coordinator.locate(other)!.state!.salvage, 30);
    coordinator.checkpoint([row]); coordinator.checkpoint([row]);
    assert.equal(coordinator.locate(key)!.state!.salvage, 42);
    coordinator.construct(row, 'c'.repeat(16), { type: 0, x: candidate.x + 8, y: 10, z: candidate.z, facing: 0 });
    coordinator.checkpoint([row]);
    assert.equal(coordinator.locate(key)!.state!.salvage, 22);
    assert.equal(coordinator.locate(key)!.state!.salvageEarned, 12);
    assert.throws(() => coordinator.resourceView({ id: 'source', epoch: authority.epoch + 1 }, [candidate.id]), /authority/);
    coordinator.release(row); coordinator.close(); now += 9000;
    coordinator = new Coordinator(file, () => now, () => now);
    now += 9000; // Cold coordinator recovery retains an additional authority fence.
    const next = coordinator.register({ id: 'replacement', planet: 'meridian', url: 'ws://127.0.0.1:2/ws', capacity: 4, humans: 0, tick: 0 });
    const restored = coordinator.claim(key, 'meridian', 'replacement:one', 'replacement');
    assert.equal(restored.entityId, grant.entityId); assert.equal(restored.state!.salvage, 22);
    assert.equal(coordinator.resourceView({ id: 'replacement', epoch: next.epoch }, [candidate.id])[0].readyAt, receipt.readyAt);
    assert.throws(() => coordinator.harvest(row, 'a'.repeat(16), candidate.id, 0), /ownership/);
  } finally {
    coordinator.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir())); rmSync(directory, { recursive: true, force: true });
  }
});

test('renewal permits a new extraction cycle while expired receipts cannot replay old credits', () => {
  const db = new DatabaseSync(':memory:'), camps = new OutpostLedger(db), ledger = new ResourceLedger(db);
  try {
    const first = ledger.harvest(key, 'meridian', 'a'.repeat(16), candidate.id, 0, saved(), 0, 0);
    const ready = RESOURCE_RENEW_SECONDS * TICK_RATE; assert.equal(first.receipt.readyAt, ready);
    assert.throws(() => ledger.harvest(key, 'meridian', 'b'.repeat(16), candidate.id, ready, camps.reconcile(key, saved()), ready - 1, 1000), /regrowing/);
    const second = ledger.harvest(key, 'meridian', 'b'.repeat(16), candidate.id, ready, camps.reconcile(key, saved()), ready, 86400_001);
    assert.equal(second.state.salvage, 54); assert.equal(second.receipt.earned, 24);
    assert.throws(() => ledger.harvest(key, 'meridian', 'a'.repeat(16), candidate.id, 0, camps.reconcile(key, saved()), ready * 3, 86400_002), /regrowing/);
    const foreign = ledger.harvest(key, 'cinder', 'c'.repeat(16), candidate.id, 0, camps.reconcile(key, saved()), ready, 86400_003);
    assert.equal(foreign.receipt.earned, 36, 'another planet has an independent growth cycle');
  } finally { db.close(); }
});

function gatheringFixture() {
  const game = new Game(1337); let wall = 1000, blocked = false, awards = 0;
  game.world.groundY = () => 10; game.world.sdf = () => 100; game.world.liquidAt = () => undefined;
  game.world.trace = (_x, _y, _z, _dx, dy) => ({ hit: dy === -1 || blocked, dist: 1, x: 0, y: 10, z: 0, nx: 0, ny: 1, nz: 0 });
  const p = new ServerPlayer(1, 'Miner', null, false, { x: candidate.x + 2, y: 10, z: candidate.z });
  const gathering = new Gathering(game, async (_p, node) => { awards++; return { id: node.id, readyAt: game.tick + 10800, earned: awards * 12, spent: 0 }; }, () => wall);
  const sync = () => gathering.applyView(gathering.viewIds([p]).map(id => ({ id, readyAt: 0 })), wall);
  sync();
  const run = (ticks: number, held = true, refresh = true) => {
    for (let i = 0; i < ticks; i++) {
      if (held && game.tick % 15 === 0) gathering.hold(p, true);
      if (refresh && game.tick % 60 === 0) sync();
      gathering.step(p); game.tick++; wall += 1000 / TICK_RATE;
    }
  };
  return { game, p, gathering, run, sync, awards: () => awards, block: () => { blocked = true; }, advanceWall: (ms: number) => { wall += ms; } };
}

test('gathering requires sustained live input and a fresh resource view; committed depletion beats a delayed view', async () => {
  const f = gatheringFixture();
  f.gathering.hold(f.p, true); f.run(200, false); assert.equal(f.awards(), 0, 'lost key-up or disconnected input cannot finish extraction');
  f.run(195); await Promise.resolve(); await Promise.resolve(); assert.equal(f.awards(), 1);
  f.sync(); f.run(240); assert.equal(f.awards(), 1, 'a read from before the commit cannot reset depletion');
  const stale = gatheringFixture(); stale.advanceWall(5100); stale.run(220, true, false); assert.equal(stale.awards(), 0);
  stale.sync(); stale.run(195); assert.equal(stale.awards(), 1);
});

test('movement, damage, walls and release cancel extraction before a reward', () => {
  const moving = gatheringFixture(); moving.run(90); moving.p.state.px += 2; moving.run(100); assert.equal(moving.awards(), 0);
  const hurt = gatheringFixture(); hurt.run(90); hurt.p.health -= 10; hurt.p.regenBlockUntil = 1000; hurt.run(200); assert.equal(hurt.awards(), 0);
  const wall = gatheringFixture(); wall.run(90); wall.block(); wall.run(200); assert.equal(wall.awards(), 0);
  const release = gatheringFixture(); release.run(90); release.gathering.hold(release.p, false); release.run(200, false); assert.equal(release.awards(), 0);
});

test('small passive ground corrections are tolerated while movement input cancels even against an obstacle', () => {
  const drifting = gatheringFixture(); drifting.run(90); drifting.p.state.px += .8; drifting.run(100); assert.equal(drifting.awards(), 1);
  const moving = gatheringFixture(); moving.run(90);
  moving.p.lastCmd = { seq: 1, buttons: 1, weapon: 1, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 };
  moving.run(200); assert.equal(moving.awards(), 0);
});

test('geographic ownership permits nearby resource views but prevents harvesting across the region seam', () => {
  const c = new Coordinator(':memory:');
  try {
    c.configureRegions('meridian', { version: 2, xCuts: [0], zCuts: [], entry: { x: -100, z: 0 } });
    const authority = c.register({ id: 'left', planet: 'meridian', region: 'r0:0', url: 'ws://127.0.0.1:1/ws', humans: 0, capacity: 4, tick: 0 });
    const own = resourceCandidate(1337, '-1,0'), state = { ...saved(), x: own.x, z: own.z };
    const lease = c.claim(key, 'meridian', 'left:one', 'left', state);
    const row = { key, holder: 'left:one', epoch: lease.epoch, state };
    assert.equal(c.harvest(row, 'a'.repeat(16), own.id, 0).earned, 12);
    assert.equal(c.resourceView({ id: 'left', epoch: authority.epoch }, [candidate.id]).length, 1);
    assert.throws(() => c.resourceView({ id: 'left', epoch: authority.epoch }, ['3,0']), /outside this region/);
    assert.throws(() => c.harvest({ ...row, state: saved() }, 'b'.repeat(16), candidate.id, 0), /boundary/);
  } finally { c.close(); }
});

test('earned salvage survives planetary transfer and subsequent camp spending with delayed checkpoints', () => {
  const c = new Coordinator(':memory:');
  try {
    for (const planet of ['meridian', 'cinder'] as const) c.register({ id: planet, planet, url: 'ws://127.0.0.1:1/ws', capacity: 4, humans: 0, tick: 0 });
    const grant = c.claim(key, 'meridian', 'meridian:one', 'meridian', saved());
    const row = { key, holder: 'meridian:one', epoch: grant.epoch, state: saved() };
    c.harvest(row, 'a'.repeat(16), candidate.id, 0); c.transfer(row, 'cinder', 'b'.repeat(16));
    const arrival = c.claim(key, 'cinder', 'cinder:one', 'cinder');
    assert.equal(arrival.state!.salvage, 42); assert.equal(arrival.state!.salvageEarned, 12);
    const nextSite = resourceCandidate(7331, candidate.id), next = { key, holder: 'cinder:one', epoch: arrival.epoch,
      state: { ...arrival.state!, x: nextSite.x, z: nextSite.z, arrival: false } };
    c.harvest(next, 'c'.repeat(16), nextSite.id, 0);
    c.construct(next, 'd'.repeat(16), { type: 0, x: nextSite.x + 8, y: 10, z: nextSite.z, facing: 0 });
    c.checkpoint([next]); assert.deepEqual(c.checkpoint([row]).accepted, []);
    assert.equal(c.locate(key)!.state!.salvage, 34); assert.equal(c.locate(key)!.state!.salvageEarned, 24);
  } finally { c.close(); }
});
