import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { planetById, type PlanetId } from '@shared/universe';
import { entityBlockRange } from '@shared/entity-id';
import type { CampaignReport, CampaignWarAlert } from '@shared/campaign-war';
import { Coordinator, OwnershipError } from '../src/coordinator.js';
import { ServerPlayer, type Game } from '../src/game.js';
import { captureActors, type RuntimeHandoff } from '../src/runtime-handoff.js';
import { startControlPlane } from '../src/control-plane.js';
import { ControlClient } from '../src/control-client.js';

function report(planet: PlanetId, tick = 1): CampaignReport {
  return { planet, tick, ownership: [.25, .25, .25, .25], botPopulation: [0, 64, 64, 64],
    bases: [{ id: 'base-city-2', name: 'Distant city', owner: 1, held: [0, 2, 1, 0], attackers: [2], x: 6000, z: -2000 }] };
}
function register(c: Coordinator, planet: PlanetId, id: string = planet) {
  const block = c.reserveEntities({ request: `bootstrap-campaign-${id}`, node: id, planet, region: 'world', count: 1 });
  const row = { id, planet, url: 'ws://localhost:12345/ws', capacity: 64, humans: 0, tick: 1 };
  const grant = c.register(row);
  const authority = { id, epoch: grant.epoch };
  c.campaignExchange({ authority, report: report(planet) });
  return { authority, row, first: entityBlockRange(block.firstBlock).first };
}
function payload(first: number, seed = 1337, count = 6): RuntimeHandoff {
  const players = new Map<number, ServerPlayer>();
  for (let i = 0; i < count; i++) {
    const p = new ServerPlayer(first + i, `Expedition ${i}`, null, true, { x: 40 + i, y: 0, z: 50 });
    p.faction = 1; p.botRosterIndex = i * 3; p.salvage = 17;
    players.set(p.id, p);
  }
  return captureActors({ seed, tick: 1, players, vehicles: new Map(), projectiles: new Map() } as unknown as Game, [...players.keys()]).record;
}
const code = (expected: string) => (error: unknown) => error instanceof OwnershipError && error.code === expected;

test('campaign reports expire, reject retired authorities and exchange bounded deduplicated remote alerts', () => {
  let now = 10_000;
  const c = new Coordinator(':memory:', () => now);
  try {
    const meridian = register(c, 'meridian'), cinder = register(c, 'cinder');
    const alert: CampaignWarAlert = { id: 'campaign-alert-0001', planet: 'meridian', baseId: 'base-city-2', baseName: 'Vesper Reach',
      attacker: 2, defender: 1, message: 'Vesper Reach on Meridian is under attack by Helix Combine.' };
    c.campaignExchange({ authority: meridian.authority, report: report('meridian'), alerts: [alert, alert] });
    const view = c.campaignExchange({ authority: cinder.authority, report: report('cinder') });
    assert.equal(view.alerts.length, 1); assert.equal(view.alerts[0].message, alert.message);
    assert.equal(view.reports.length, 2);
    assert.equal(c.status().planets.find(p => p.id === 'meridian')!.campaign!.threatenedBases, 1);
    for (let i = 0; i < 4; i++) {
      now += 6000;
      c.register({ ...meridian.row, epoch: meridian.authority.epoch });
      c.register({ ...cinder.row, epoch: cinder.authority.epoch });
    }
    const expired = c.campaignExchange({ authority: cinder.authority, report: report('cinder', 2) });
    assert.ok(!expired.reports.some(r => r.planet === 'meridian'), 'a live authority cannot keep an old report relevant forever');
    assert.equal(c.status().planets.find(p => p.id === 'meridian')!.campaign, undefined);
    c.unregister(meridian.authority.id, meridian.authority.epoch);
    register(c, 'meridian', 'replacement');
    assert.throws(() => c.campaignExchange({ authority: meridian.authority, report: report('meridian') }), code('fenced'));
  } finally { c.close(); }
});

test('a squad departure commits once, arrives until acknowledged and cannot depart twice from its source', () => {
  const c = new Coordinator(':memory:');
  try {
    const source = register(c, 'meridian'), destination = register(c, 'cinder');
    const departure = { authority: source.authority, id: 'campaign-transfer-0001', destination: 'cinder' as const,
      targetBaseId: 'base-city-2', faction: 1 as const, payload: payload(source.first) };
    const committed = c.departCampaign(departure);
    assert.deepEqual(c.departCampaign(departure), committed, 'a lost HTTP reply is safe to retry');
    assert.deepEqual(c.inspectCampaign(departure.id, source.authority), committed);
    assert.throws(() => c.departCampaign({ ...departure, targetBaseId: 'different' }), code('invalid'));
    assert.throws(() => c.departCampaign({ ...departure, id: 'campaign-transfer-duplicate' }), code('fenced'));
    const get = () => c.campaignExchange({ authority: destination.authority, report: report('cinder') });
    assert.equal(get().arrivals.length, 1); assert.equal(get().arrivals[0].payload.players.length, 6);
    assert.equal(c.status().planets.find(p => p.id === 'cinder')!.campaign!.inboundSquads, 1);
    assert.equal(c.campaignExchange({ authority: destination.authority, report: report('cinder'), acknowledged: [committed.id] }).arrivals.length, 0);
    assert.equal(get().arrivals.length, 0);
    assert.throws(() => c.campaignExchange({ authority: source.authority, report: report('meridian'), acknowledged: [committed.id] }), code('invalid'));
    const human = payload(source.first + 20); human.players[0] = { ...human.players[0], isBot: false };
    assert.throws(() => c.departCampaign({ ...departure, id: 'campaign-transfer-human', payload: human }), code('invalid'));
    assert.throws(() => c.departCampaign({ ...departure, id: 'campaign-transfer-forged', payload: payload(destination.first) }), code('fenced'));
  } finally { c.close(); }
});

test('a restarted destination replays only bots it still owns after part of a squad travels onward', () => {
  const c = new Coordinator(':memory:');
  try {
    const source = register(c, 'meridian'), middle = register(c, 'cinder'), final = register(c, 'nacre');
    const first = c.departCampaign({ authority: source.authority, id: 'campaign-transfer-to-middle', destination: 'cinder',
      targetBaseId: 'base-city-2', faction: 1, payload: payload(source.first) });
    c.campaignExchange({ authority: middle.authority, report: report('cinder'), acknowledged: [first.id] });
    const continuing = { ...first.payload, seed: planetById('cinder')!.seed, players: first.payload.players.slice(0, 3) };
    c.departCampaign({ authority: middle.authority, id: 'campaign-transfer-onward', destination: 'nacre',
      targetBaseId: 'base-city-2', faction: 1, payload: continuing });
    c.unregister(middle.authority.id, middle.authority.epoch);
    const replacement = register(c, 'cinder', 'cinder-replacement');
    const replay = c.campaignExchange({ authority: replacement.authority, report: report('cinder') }).arrivals;
    assert.equal(replay.length, 1);
    assert.deepEqual(replay[0].payload.players.map(p => p.id), first.payload.players.slice(3).map(p => p.id), 'old tickets never recreate the onward group');
    const arrived = c.campaignExchange({ authority: final.authority, report: report('nacre') }).arrivals;
    assert.deepEqual(arrived[0].payload.players.map(p => p.id), continuing.players.map(p => p.id));
  } finally { c.close(); }
});

test('durable cancellation resolves a missing departure without racing a delayed commit', () => {
  const c = new Coordinator(':memory:');
  try {
    const source = register(c, 'meridian'), destination = register(c, 'cinder');
    const request = { authority: source.authority, id: 'campaign-transfer-cancelled', destination: 'cinder' as const,
      targetBaseId: 'base-city-2', faction: 1 as const, payload: payload(source.first) };
    assert.equal(c.inspectCampaign(request.id, source.authority), null);
    assert.deepEqual(c.cancelCampaign(request), { id: request.id, state: 'cancelled' });
    assert.deepEqual(c.cancelCampaign(request), { id: request.id, state: 'cancelled' }, 'a lost cancellation reply is idempotent');
    assert.throws(() => c.departCampaign(request), code('invalid'), 'the original delayed request cannot commit after cancellation');
    assert.equal(c.campaignExchange({ authority: destination.authority, report: report('cinder') }).arrivals.length, 0);
    assert.throws(() => c.cancelCampaign({ ...request, targetBaseId: 'different' }), code('invalid'));
    const next = { ...request, id: 'campaign-transfer-next-wave' };
    c.departCampaign(next);
    assert.deepEqual(c.cancelCampaign(next), { id: next.id, state: 'committed' }, 'a commit winning the race remains authoritative');
    assert.equal(c.campaignExchange({ authority: destination.authority, report: report('cinder') }).arrivals.length, 1);
  } finally { c.close(); }
});

test('an unavailable or full destination rejects an expedition without consuming its soldiers', () => {
  const c = new Coordinator(':memory:');
  try {
    const source = register(c, 'meridian'), destination = register(c, 'cinder');
    const request = { authority: source.authority, id: 'campaign-transfer-overflow', destination: 'cinder' as const,
      targetBaseId: 'base-city-2', faction: 1 as const, payload: payload(source.first + 100) };
    for (let squad = 0; squad < 4; squad++) c.departCampaign({ ...request, id: `campaign-transfer-capacity-${squad}`,
      payload: payload(source.first + squad * 6) });
    assert.throws(() => c.departCampaign(request), code('full'));
    assert.equal(c.inspectCampaign(request.id, source.authority), null, 'a definite rejection creates no durable ownership');
    c.campaignExchange({ authority: destination.authority, report: report('cinder'), acknowledged: ['campaign-transfer-capacity-0'] });
    assert.equal(c.departCampaign(request).payload.players.length, 6, 'the same source group can retry when a slot opens');
    c.unregister(destination.authority.id, destination.authority.epoch);
    const absent = { ...request, id: 'campaign-transfer-unavailable', payload: payload(source.first + 120) };
    assert.throws(() => c.departCampaign(absent), code('unavailable'));
    assert.equal(c.inspectCampaign(absent.id, source.authority), null);
  } finally { c.close(); }
});

test('permanently retired expedition soldiers never replay and old payloads compact without reviving a retry', () => {
  let now = 10_000;
  const c = new Coordinator(':memory:', () => now);
  try {
    const source = register(c, 'meridian'), destination = register(c, 'cinder');
    const request = { authority: source.authority, id: 'campaign-transfer-retired', destination: 'cinder' as const,
      targetBaseId: 'base-city-2', faction: 1 as const, payload: payload(source.first) };
    c.departCampaign(request);
    const retired = request.payload.players.map(p => p.id);
    assert.throws(() => c.campaignExchange({ authority: source.authority, report: report('meridian'), retired }), code('fenced'));
    c.campaignExchange({ authority: destination.authority, report: report('cinder'), acknowledged: [request.id], retired });
    now += 86400_001;
    const sourceEpoch = c.register(source.row).epoch, destinationEpoch = c.register(destination.row).epoch;
    const view = c.campaignExchange({ authority: { ...destination.authority, epoch: destinationEpoch }, report: report('cinder', 2) });
    assert.equal(view.arrivals.length, 0, 'a cold worker never restores permanently evicted expedition bots');
    const receipt = c.inspectCampaign(request.id, source.authority)!;
    assert.equal(receipt.state, 'committed'); assert.equal(receipt.payload.players.length, 0, 'a one-day-old obsolete payload becomes a small durable receipt');
    assert.deepEqual(c.departCampaign(request), receipt, 'an arbitrarily late identical retry stays committed without creating another arrival');
    assert.throws(() => c.departCampaign({ ...request, id: 'campaign-transfer-retired-reuse',
      authority: { ...source.authority, epoch: sourceEpoch } }), code('fenced'));
  } finally { c.close(); }
});

test('durable campaign ownership and unknown-submit inspection survive coordinator restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-campaign-'));
  let c: Coordinator | undefined;
  try {
    const file = path.join(root, 'universe.sqlite'); c = new Coordinator(file);
    const source = register(c, 'meridian'), destination = register(c, 'cinder');
    const request = { authority: source.authority, id: 'campaign-transfer-durable', destination: 'cinder' as const,
      targetBaseId: 'base-city-2', faction: 1 as const, payload: payload(source.first) };
    const cancelled = { ...request, id: 'campaign-transfer-durable-cancel', payload: payload(source.first + 10) };
    c.cancelCampaign(cancelled);
    const committed = c.departCampaign(request); c.close(); c = new Coordinator(file);
    assert.deepEqual(c.inspectCampaign(request.id, source.authority), committed);
    assert.deepEqual(c.departCampaign(request), committed);
    assert.equal(c.cancelCampaign(cancelled).state, 'cancelled');
    assert.throws(() => c!.departCampaign(cancelled), code('invalid'), 'coordinator restart preserves the delayed-submit fence');
    c.register({ ...destination.row, epoch: destination.authority.epoch });
    const view = c.campaignExchange({ authority: destination.authority, report: report('cinder') });
    assert.equal(view.arrivals[0].id, request.id);
    assert.equal(view.arrivals[0].payload.players[0].salvage, 17, 'loadout and identity survive the durable queue');
  } finally {
    c?.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('the-mmofps-campaign-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('campaign exchange and transfer inspection are available through the authenticated control plane', async () => {
  const c = new Coordinator(':memory:'), secret = 'c'.repeat(32);
  const node = register(c, 'meridian');
  const server = await startControlPlane(c, secret);
  try {
    const client = new ControlClient(`http://127.0.0.1:${server.port}`, secret);
    const result = await client.call<{ reports: CampaignReport[] }>('campaign/exchange', { authority: node.authority, report: report('meridian') });
    assert.equal(result.reports[0].planet, 'meridian');
    assert.equal(await client.call('campaign/transfer', { authority: node.authority, id: 'campaign-transfer-unknown' }), null);
    const cancellation = await client.call<{ state: string }>('campaign/cancel', { authority: node.authority,
      id: 'campaign-http-cancellation', destination: 'cinder', targetBaseId: 'base-city-2', faction: 1, payload: payload(node.first) });
    assert.equal(cancellation.state, 'cancelled', 'cancellation remains available even while the destination is offline');
  } finally { await server.close(); c.close(); }
});
