import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { Coordinator } from '../src/coordinator.js';
import { startControlPlane } from '../src/control-plane.js';
import { startGateway } from '../src/gateway.js';
import type { RunningServer } from '../src/server.js';
import { startWorldFixtures } from './world-fixture.js';
import { PLANETS, type JourneyState } from '@shared/universe';
import { decodeJourney } from '@shared/journey-wire';
import { ByteReader, Msg, decodeWelcome, decodeSnapshot, encodeHello, type Snapshot, type WelcomeMsg } from '@shared/index';

async function until(check: () => unknown, label: string, timeout = 10_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 25)); }
}
async function client(port: number, cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?planet=nacre`, { headers: { Cookie: cookie } }); ws.binaryType = 'arraybuffer';
  const state: { welcome: WelcomeMsg | null; snapshot: Snapshot | null; journeys: JourneyState[]; closed: boolean } = { welcome: null, snapshot: null, journeys: [], closed: false };
  ws.on('message', data => {
    const r = new ByteReader(data as ArrayBuffer), type = r.u8();
    if (type === Msg.SWelcome) state.welcome = decodeWelcome(r);
    if (type === Msg.SSnapshot) state.snapshot = decodeSnapshot(r);
    if (type === Msg.SJourney) state.journeys.push(decodeJourney(data as ArrayBuffer));
  });
  ws.on('close', () => { state.closed = true; }); ws.on('error', () => {});
  await new Promise<void>((resolve, reject) => { ws.once('open', () => { ws.send(encodeHello('Planet traveller')); resolve(); }); ws.once('error', reject); });
  await until(() => state.welcome && state.snapshot, 'world admission');
  return { ws, state };
}

test('physical launches, unavailable destinations and lost transfer responses preserve one character through gateway handoff', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-planets-'));
  const coordinator = new Coordinator(path.join(root, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
  const control = await startControlPlane(coordinator, secret);
  const droppedTransfers: string[] = [];
  // This private fixture deliberately drops every transfer response after the
  // real coordinator commits it. No production endpoint gains a fault switch.
  const interruptedLink = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const upstream = await fetch(`http://127.0.0.1:${control.port}${req.url}`, { method: 'POST', body,
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } });
      const response = await upstream.text();
      if (req.url === '/transfer' && upstream.ok) { droppedTransfers.push(JSON.parse(body.toString()).id); res.destroy(); return; }
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(response);
    } catch { res.writeHead(503).end(); }
  });
  await new Promise<void>(resolve => interruptedLink.listen(0, '127.0.0.1', resolve));
  const proxyPort = (interruptedLink.address() as { port: number }).port;
  const worlds: RunningServer[] = [], clients: WebSocket[] = [];
  let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
  try {
    worlds.push(...await startWorldFixtures(PLANETS.slice(0, 2).map(planet => ({ port: 0, host: '127.0.0.1', seed: planet.seed, log: false, targetPopulation: 0, maxPlayers: 4, clientDir: '.', dataDir: path.join(root, planet.id),
      node: { url: `http://127.0.0.1:${proxyPort}`, secret, planet: planet.id, id: planet.id } }))));
    for (const world of worlds) assert.equal(world.failure, null, 'fixture clock is live after generation');
    gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', clientDir: '.', secret });
    const session = await fetch(`http://127.0.0.1:${gateway.port}/api/session`), cookie = session.headers.get('set-cookie')!.split(';')[0];
    const key = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
    const source = await client(gateway.port, cookie); clients.push(source.ws);
    assert.equal(source.state.welcome!.seed, 1337, 'the gateway uses the saved location regardless of the URL');
    const p = worlds[0].game.players.get(source.state.welcome!.yourId)!;
    source.ws.send(Uint8Array.of(Msg.CPlanet, 1));
    await until(() => source.state.journeys.some(j => j.phase === 'cancelled'), 'launch refused away from pod');
    const pod = worlds[0].game.world.collectTransportPlan().pods[0];
    const placeAtPod = () => { Object.assign(p.state, { px: pod.x, py: pod.y + .12, pz: pod.z, vx: 0, vy: 0, vz: 0 }); };
    placeAtPod(); source.state.journeys.length = 0; source.ws.send(Uint8Array.of(Msg.CPlanet, 1));
    await until(() => source.state.journeys.some(j => j.phase === 'charging'), 'pod charge');
    p.state.px += 3;
    await until(() => source.state.journeys.some(j => j.phase === 'cancelled'), 'movement cancels charge');
    placeAtPod(); source.state.journeys.length = 0; source.ws.send(Uint8Array.of(Msg.CPlanet, 1));
    await until(() => source.state.journeys.some(j => j.phase === 'charging'), 'second charge');
    p.health -= 5;
    await until(() => source.state.journeys.some(j => j.phase === 'cancelled'), 'damage cancels charge');
    const retainedProjectileId = worlds[0].game.idRange.last - 17;
    worlds[0].game.projectiles.set(retainedProjectileId, { id: retainedProjectileId, owner: p.id, weapon: 3,
      x: pod.x + 40, y: 400, z: pod.z, vx: 0, vy: 0, vz: 0,
      ageSeconds: .2, fuseLeft: Infinity, distLeft: 500, sleeping: true });
    placeAtPod(); source.state.journeys.length = 0; source.ws.send(Uint8Array.of(Msg.CPlanet, 2));
    await until(() => source.state.journeys.some(j => j.phase === 'cancelled' && j.message?.includes('unavailable')), 'unavailable destination rolls back safely', 12_000);
    assert.equal(coordinator.locate(key)!.planet, 'meridian');
    assert.equal(worlds[0].game.players.get(p.id), p, 'a refused transfer restores the same source actor');
    assert.equal(worlds[0].game.projectiles.get(retainedProjectileId)?.owner, p.id, 'a refused launch restores owned explosives too');
    placeAtPod(); p.faction = 1; p.salvage = 137; p.ammo[1].magazine = 7; p.discoveries.add('1337:city-2');
    source.state.journeys.length = 0; source.ws.send(Uint8Array.of(Msg.CPlanet, 1));
    // Drop the client before it can acknowledge the result. The database is
    // the evidence of arrival; no client-provided destination is trusted.
    source.ws.on('message', data => { if (new Uint8Array(data as ArrayBuffer)[0] === Msg.SJourney && decodeJourney(data as ArrayBuffer).phase === 'committed') source.ws.terminate(); });
    await until(() => coordinator.locate(key)?.planet === 'cinder', 'durable transfer', 12_000);
    await until(() => source.state.journeys.some(j => j.phase === 'committed'), 'source recovers the committed destination after response loss');
    assert.equal(droppedTransfers.length, 3); assert.equal(new Set(droppedTransfers).size, 1, 'all retries use the same transfer ID');
    assert.equal(worlds[0].game.players.has(p.id), false, 'source actor removed before destination admission');
    const destination = await client(gateway.port, cookie); clients.push(destination.ws);
    assert.equal(destination.state.welcome!.seed, 7331);
    assert.equal(destination.state.welcome!.yourId, p.id);
    const arrived = worlds[1].game.players.get(destination.state.welcome!.yourId)!;
    assert.equal(arrived.faction, 1); assert.equal(arrived.ammo[1].magazine, 7); assert.ok(arrived.salvage >= 137);
    assert.ok(arrived.discoveries.has('1337:city-2'));
    const arrivalPod = worlds[1].game.world.collectTransportPlan().pods[0];
    assert.ok(Math.hypot(arrived.state.px - arrivalPod.x, arrived.state.pz - arrivalPod.z) < 1, 'arrival at a physical destination terminal');
    const savedSession = await fetch(`http://127.0.0.1:${gateway.port}/api/session`, { headers: { Cookie: cookie } });
    assert.equal((await savedSession.json() as { planet: string }).planet, 'cinder');
    destination.ws.close(); await until(() => !coordinator.locate(key)?.holder, 'disconnect saves and releases');
    const returning = await client(gateway.port, cookie); clients.push(returning.ws);
    assert.equal(returning.state.welcome!.seed, 7331);
    assert.equal(returning.state.welcome!.yourId, p.id);
    assert.equal(worlds[1].game.players.get(returning.state.welcome!.yourId)!.ammo[1].magazine, 7);
    const heights = PLANETS.slice(0, 2).map((_, i) => [-7200, -3200, 2800, 7200].map(x => worlds[i].game.world.terrainHeight(x, 1600)));
    assert.notDeepEqual(heights[0], heights[1], 'destinations have different terrain, beyond map colors');
    assert.equal(worlds[1].game.world.collectCities()[0].name, 'Ashwater');
  } finally {
    for (const ws of clients) ws.terminate();
    await gateway?.close(); for (const world of worlds) await world.close();
    await new Promise<void>(resolve => interruptedLink.close(() => resolve()));
    await control.close(); coordinator.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('the-mmofps-planets-'));
    await rm(root, { recursive: true, force: true });
  }
});
