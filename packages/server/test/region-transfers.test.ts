import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator, OwnershipError, NODE_TIMEOUT_MS } from '../src/coordinator.js';
import { startControlPlane } from '../src/control-plane.js';
import { ControlClient, ControlError } from '../src/control-client.js';
import { Game, type ServerPlayer } from '../src/game.js';
import { capturePlayer } from '../src/persistence.js';
import { captureActors, prepareArrival, type RuntimeHandoff } from '../src/runtime-handoff.js';
import type { RegionalHandoffRequest, RegionalOutcome } from '../src/region-transfers.js';
import { BTN, VEHICLE, rotationFromEuler } from '@shared/index';
import { namespaceRange } from '@shared/entity-id';

const code = (expected: string) => (error: unknown) => error instanceof OwnershipError && error.code === expected;
const sinks = (record: RuntimeHandoff) => new Map(record.players.map(p => [p.id, null]));
function fixture(file = ':memory:', capacity = 4) {
  const time = { value: 10_000 }, c = new Coordinator(file, () => time.value);
  c.configureRegions('meridian', { version: 2, xCuts: [0], zCuts: [], entry: { x: -1, z: 0 } });
  const west = { id: 'west', planet: 'meridian' as const, region: 'r0:0', url: 'ws://127.0.0.1:1000/ws', capacity: 8, humans: 0, tick: 0 };
  const east = { ...west, id: 'east', region: 'r1:0', capacity };
  const source = { id: west.id, epoch: c.register(west).epoch }, destination = { id: east.id, epoch: c.register(east).epoch };
  const namespace = c.namespace('meridian', 'r0:0'), otherNamespace = c.namespace('meridian', 'r1:0');
  const game = new Game(1337, { entityNamespace: namespace }), other = new Game(1337, { entityNamespace: otherNamespace });
  for (const g of [game, other]) (g as unknown as { pickSpawn(): { x: number; y: number; z: number } }).pickSpawn = () => ({ x: -1, y: 600, z: 0 });
  const keys = new Map<number, string>(); let serial = 0;
  const human = () => {
    const key = (++serial).toString(16).repeat(64), holder = `west:player-${serial}`;
    const grant = c.claim(key, 'meridian', holder, 'west');
    const p = game.addPlayer(`Explorer-${serial}`, null, false, grant.entityId); keys.set(p.id, key);
    c.checkpoint([{ key, holder, epoch: grant.epoch, state: capturePlayer(game, p) }]); return p;
  };
  const request = (record: RuntimeHandoff, reverse = false): RegionalHandoffRequest => ({ id: randomUUID(),
    source: reverse ? destination : source, destination: reverse ? source : destination, layoutVersion: 2, record,
    members: record.players.map(p => { const o = c.locate(keys.get(p.id)!)!; return { key: o.key, entityId: o.entityId, holder: o.holder!, epoch: o.epoch }; }) });
  const crew = () => {
    const pilot = human(), passenger = human(), id = namespaceRange(namespace).first;
    const hull = { id, type: VEHICLE.JET, variant: 0, x: 1, y: 600, z: 0, heading: .4, health: 173,
      occupant: pilot.id, gunner: passenger.id, respawnAtTick: -1 };
    game.vehicles.set(id, hull);
    for (const [p, seat] of [[pilot, 0], [passenger, 1]] as const) {
      p.vehicleId = id; p.vehFireCd = .4 + seat; p.useHeld = true;
      Object.assign(p.state, { px: 1, vehicle: VEHICLE.JET, vehicleId: id, seat, heading: .4, vx: 35, vy: 3, vz: -45,
        vehicleRotation: rotationFromEuler(.4, .2, -.3), vehiclePitch: .2, vehicleRoll: -.3, boostFuel: .61 });
    }
    game.projectiles.set(id, { id, owner: passenger.id, weapon: 4, x: 1, y: 580, z: 3,
      vx: 1, vy: -50, vz: 3, ageSeconds: .2, fuseLeft: 3, distLeft: 500, sleeping: false });
    return { pilot, passenger, hull };
  };
  const commit = (req: RegionalHandoffRequest) => {
    const stage = c.prepareRegional(req);
    c.readyRegional(req.id, req.destination, stage.hash, req.record.tick);
    return c.commitRegional(req.id, req.source, stage.hash);
  };
  return { c, time, west, east, source, destination, game, other, keys, human, crew, request, commit };
}

test('a physical movement tick crosses regions through private HTTP, with a lost commit response and preserved queued input', async () => {
  const f = fixture(), secret = randomBytes(32).toString('hex');
  const control = await startControlPlane(f.c, secret); let lost = false;
  const proxy = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const upstream = await fetch(`http://127.0.0.1:${control.port}${req.url}`, { method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: Buffer.concat(chunks) });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (req.url === '/regions/commit' && upstream.ok && !lost) { lost = true; res.destroy(); return; }
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(body);
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const client = new ControlClient(`http://127.0.0.1:${(proxy.address() as { port: number }).port}`, secret);
  try {
    const p = f.human(); Object.assign(p.state, { px: -.03, vx: 9.5, vy: 8.6, dodgeCd: .4 });
    p.reloadWeapon = 1; p.reloadCd = .8; p.ammo[1].magazine = 0;
    f.game.queueInput(p, { seq: 31, buttons: BTN.RIGHT | BTN.JUMP, weapon: 1, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 });
    f.time.value += 1000 / 60; f.game.step(); f.other.step();
    assert.ok(p.state.px > 0, 'the shared movement code crosses the geographic seam');
    f.game.queueInput(p, { seq: 32, buttons: BTN.RIGHT, weapon: 1, yaw: 0, pitch: 0, renderTick: 1, renderFrac: 0 });
    const detached = f.game.takeHandoff([p.id]), request = f.request(detached.record);
    const prepared = await client.call<RegionalOutcome>('regions/prepare', request);
    assert.equal(f.c.locate(request.members[0].key)!.nodeId, 'west');
    assert.equal(f.game.players.size, 0); assert.equal(f.other.players.size, 0);
    await assert.rejects(client.call('regions/commit', { id: request.id, source: request.source, hash: prepared.hash }),
      error => error instanceof ControlError && error.code === 'busy');
    assert.equal(lost, false);
    const incoming = await client.call<RuntimeHandoff>('regions/payload', { id: request.id, destination: request.destination });
    prepareArrival(f.other, incoming, sinks(incoming));
    await client.call('regions/ready', { id: request.id, destination: request.destination, hash: prepared.hash, tick: f.other.tick });
    await assert.rejects(client.call('regions/commit', { id: request.id, source: request.source, hash: prepared.hash }));
    const final = await client.call<RegionalOutcome>('regions/commit', { id: request.id, source: request.source, hash: prepared.hash });
    assert.equal(final.status, 'committed'); assert.equal(lost, true);
    assert.equal(f.c.locate(request.members[0].key)!.nodeId, 'east');
    assert.equal(f.c.routeCharacter(request.members[0].key)!.id, 'east');
    const record = await client.call<RuntimeHandoff>('regions/payload', { id: request.id, destination: request.destination });
    const [arrived] = f.other.acceptHandoff(record, sinks(record));
    assert.equal(arrived.state.vx, p.state.vx); assert.equal(arrived.state.vy, p.state.vy);
    assert.equal(arrived.reloadCd, p.reloadCd); assert.deepEqual(arrived.inputQueue, p.inputQueue);
    assert.equal(arrived.lastProcessedSeq, 31);
    f.time.value += 1000 / 60; f.other.step(); f.game.step();
    assert.equal(arrived.lastProcessedSeq, 32); assert.ok(arrived.state.px > p.state.px);
    assert.throws(() => f.other.acceptHandoff(record, sinks(record)), /occupied/);
    assert.equal(f.c.abortRegional(request.id, request.source).status, 'committed', 'a late abort cannot reverse the durable decision');
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve())); await control.close(); f.c.close();
  }
});

test('a whole aircraft crew and its hull commit atomically, reserve capacity, fence old writes, and can return', () => {
  const f = fixture(':memory:', 2);
  try {
    const { pilot, passenger, hull } = f.crew(), detached = f.game.takeHandoff([passenger.id]), req = f.request(detached.record);
    const before = req.members.map(m => f.c.locate(m.key));
    assert.throws(() => f.c.prepareRegional({ ...req, members: [req.members[0]] }), code('invalid'));
    assert.throws(() => f.c.prepareRegional({ ...req, members: req.members.map((m, i) => i ? { ...m, epoch: m.epoch + 1 } : m) }), code('fenced'));
    assert.deepEqual(req.members.map(m => f.c.locate(m.key)), before, 'partial validation cannot checkpoint only half a crew');
    const stage = f.c.prepareRegional(req); assert.equal(stage.status, 'prepared');
    assert.deepEqual(f.c.prepareRegional(req), stage);
    assert.throws(() => f.c.prepareRegional({ ...req, layoutVersion: 3 }), code('invalid'));
    const lateRows = req.members.map(m => ({ ...m, state: capturePlayer(detached.record, detached.record.players.find(p => p.id === m.entityId)!) }));
    assert.deepEqual(f.c.checkpoint(lateRows).accepted, []);
    assert.equal(f.c.release(lateRows[0]), false); assert.equal(f.c.vacate(req.members[0].key, req.members[0].epoch, req.members[0].holder), false);
    assert.throws(() => f.c.claim('f'.repeat(64), 'meridian', 'east:other', 'east', { ...lateRows[0].state, x: 1 }), code('full'));
    assert.throws(() => f.c.readyRegional(req.id, req.destination, 'wrong', 0), code('invalid'));
    const staged = f.c.regionalPayload(req.id, req.destination); prepareArrival(f.other, staged, sinks(staged));
    f.c.readyRegional(req.id, req.destination, stage.hash, 0);
    const outcome = f.c.commitRegional(req.id, req.source, stage.hash);
    for (const m of outcome.receipt!.members) {
      const owner = f.c.locate(m.key)!; assert.equal(owner.nodeId, 'east'); assert.equal(owner.epoch, m.epoch); assert.equal(owner.holder, m.holder);
    }
    assert.equal(f.c.regionalHullOwner(hull.id)!.node_id, 'east');
    assert.deepEqual(f.c.commitRegional(req.id, req.source, stage.hash), outcome);
    assert.deepEqual(f.c.checkpoint(lateRows).accepted, []);
    f.other.acceptHandoff(f.c.regionalPayload(req.id, req.destination), sinks(staged));
    assert.equal(f.other.players.size, 2); assert.equal(f.other.vehicles.size, 1); assert.equal(f.other.projectiles.size, 1);
    assert.deepEqual(f.other.players.get(pilot.id)!.state.vehicleRotation, pilot.state.vehicleRotation);
    assert.equal(f.other.players.get(passenger.id)!.vehFireCd, passenger.vehFireCd);
    f.other.vehicles.get(hull.id)!.x = -1;
    for (const p of f.other.players.values()) p.state.px = -1;
    const returning = f.other.takeHandoff([pilot.id]), reverse = f.request(returning.record, true);
    const back = f.commit(reverse); assert.equal(back.status, 'committed');
    f.game.acceptHandoff(f.c.regionalPayload(reverse.id, reverse.destination), sinks(returning.record));
    assert.equal(f.c.regionalHullOwner(hull.id)!.node_id, 'west');
    assert.equal(f.game.players.size, 2); assert.equal(f.game.projectiles.size, 1);
    assert.deepEqual(f.c.checkpoint(outcome.receipt!.members.map(m => ({ ...m, state: lateRows[0].state }))).accepted, []);
  } finally { f.c.close(); }
});

test('destination replacement and expired preparations allow rollback but never partial ownership', () => {
  const f = fixture();
  try {
    const { passenger } = f.crew(), detached = f.game.takeHandoff([passenger.id]), req = f.request(detached.record);
    const stage = f.c.prepareRegional(req); f.c.readyRegional(req.id, req.destination, stage.hash, 0);
    f.c.unregister(f.destination.id, f.destination.epoch);
    f.c.register({ ...f.east, id: 'east-replacement' });
    assert.throws(() => f.c.commitRegional(req.id, req.source, stage.hash), code('fenced'));
    assert.equal(f.c.abortRegional(req.id, req.source).status, 'aborted');
    f.game.restoreHandoff(detached); assert.equal(f.game.players.size, 2);
    for (const m of req.members) assert.equal(f.c.locate(m.key)!.nodeId, 'west');
    assert.equal(f.c.regionalHullOwner(detached.record.vehicles[0].id), null);
    const next = f.request(f.game.takeHandoff([passenger.id]).record);
    next.destination = { id: 'east-replacement', epoch: f.c.node('east-replacement')!.epoch };
    const prepared = f.c.prepareRegional(next); f.time.value += 5001;
    assert.equal(f.c.inspectRegional(next.id, next.source).status, 'aborted');
    assert.equal(f.c.commitRegional(next.id, next.source, prepared.hash).status, 'aborted');
    assert.equal(f.c.prepareRegional(next).status, 'aborted', 'an expired ID cannot create a second preparation');
    assert.equal(f.c.checkpoint(next.members.map(m => ({ ...m, state: capturePlayer(next.record, next.record.players.find(p => p.id === m.entityId)!) }))).accepted.length, 2);
  } finally { f.c.close(); }
});

test('committed outcomes survive a coordinator restart; uncommitted destination readiness does not', async () => {
  for (const commit of [false, true]) {
    const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-region-recovery-')), file = path.join(root, 'world.sqlite');
    const f = fixture(file); let coordinator = f.c;
    try {
      const { passenger } = f.crew(), req = f.request(f.game.takeHandoff([passenger.id]).record);
      const stage = coordinator.prepareRegional(req); coordinator.readyRegional(req.id, req.destination, stage.hash, 0);
      const result = commit ? coordinator.commitRegional(req.id, req.source, stage.hash) : null;
      coordinator.close(); coordinator = new Coordinator(file, () => f.time.value);
      const recovered = coordinator.inspectRegional(req.id, req.source);
      assert.equal(recovered.status, commit ? 'committed' : 'aborted');
      if (commit) {
        assert.deepEqual(recovered, result); assert.deepEqual(coordinator.commitRegional(req.id, req.source, stage.hash), result);
        assert.equal(coordinator.regionalHullOwner(req.record.vehicles[0].id)!.node_id, 'east');
        assert.throws(() => coordinator.regionalPayload(req.id, req.destination), code('fenced'), 'recovered planetary time is too old for live simulation import');
      } else assert.equal(coordinator.commitRegional(req.id, req.source, stage.hash).status, 'aborted');
      f.time.value += NODE_TIMEOUT_MS + 1;
      const target = commit ? { ...f.east, id: 'east-replacement' } : { ...f.west, id: 'west-replacement' };
      // Recovery routes by the saved crossing position. An aborted crossing
      // is allowed to recover there once the old source has fully expired.
      const regionalTarget = commit ? target : { ...f.east, id: 'east-replacement' };
      coordinator.register(regionalTarget);
      for (const m of req.members) {
        const recoveredPlayer = coordinator.claim(m.key, 'meridian', `${regionalTarget.id}:${m.entityId}`, regionalTarget.id);
        assert.equal(recoveredPlayer.entityId, m.entityId); assert.equal(recoveredPlayer.state!.x, 1);
      }
    } finally {
      coordinator.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
      assert.ok(path.basename(root).startsWith('the-mmofps-region-recovery-')); await rm(root, { recursive: true, force: true });
    }
  }
});
