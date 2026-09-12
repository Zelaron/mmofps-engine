import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import WebSocket from 'ws';
import { ByteReader, Msg, encodeHello, decodeWelcome, type WelcomeMsg } from '@shared/protocol';
import { Coordinator } from '../src/coordinator.js';
import { startControlPlane } from '../src/control-plane.js';
import { startServer, type RunningServer } from '../src/server.js';
import { SimulationOverload } from '../src/tick-loop.js';
import { ControlClient, ControlError } from '../src/control-client.js';
import type { AuthorityGrant } from '../src/coordinator.js';

const until = async (condition: () => unknown, message: string, timeout = 12_000) => {
  const end = Date.now() + timeout;
  while (!condition() && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  assert.ok(condition(), message);
};

test('coordinator clock recovery retires live physics safely and a replacement preserves character and planetary time', { timeout: 35_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-clock-recovery-'));
  const file = path.join(root, 'universe.sqlite'), secret = randomBytes(32).toString('hex'), key = 'a'.repeat(64);
  let coordinator = new Coordinator(file);
  let control = await startControlPlane(coordinator, secret);
  const controlPort = control.port, worlds: RunningServer[] = [], sockets: WebSocket[] = [];
  let closedFailure: Error | null = null;
  const start = async (id: string) => {
    const server = await startServer({ port: 0, host: '127.0.0.1', seed: 1337, targetPopulation: 0, log: false,
      onFailure: error => { closedFailure = error; },
      node: { id, planet: 'meridian', secret, url: `http://127.0.0.1:${controlPort}` } });
    worlds.push(server); return server;
  };
  const join = async (server: RunningServer) => {
    let welcome: WelcomeMsg | null = null;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { Authorization: `Bearer ${secret}`, 'x-mmofps-identity': key } });
    sockets.push(ws); ws.binaryType = 'arraybuffer'; ws.on('error', () => {});
    ws.on('message', data => { const r = new ByteReader(data as ArrayBuffer); if (r.u8() === Msg.SWelcome) welcome = decodeWelcome(r); });
    ws.on('open', () => ws.send(encodeHello('Clock explorer')));
    await until(() => welcome, 'world admission');
    return { ws, welcome: welcome as unknown as WelcomeMsg };
  };
  try {
    const first = await start('meridian:first'), initial = await join(first);
    initial.ws.send(Uint8Array.of(Msg.CFaction, 1));
    await until(() => coordinator.locate(key)?.state?.faction === 1, 'character checkpoint before coordinator restart');
    const tickBefore = first.game.tick;
    await control.close(); coordinator.close();
    coordinator = new Coordinator(file);
    control = await startControlPlane(coordinator, secret, { port: controlPort });
    await until(() => closedFailure, 'worker closes after the recovered clock exceeds its catch-up budget');
    assert.ok(first.failure instanceof SimulationOverload);
    assert.ok(first.game.tick < tickBefore + 300, 'the failed worker never jumps through eight seconds of live physics');
    await until(() => initial.ws.readyState === WebSocket.CLOSED, 'client receives restart closure');
    assert.equal(coordinator.route('meridian'), null, 'completed cleanup releases the world authority');
    const replacement = await start('meridian:replacement'), returning = await join(replacement);
    assert.equal(returning.welcome.yourId, initial.welcome.yourId);
    assert.ok(returning.welcome.tick > first.game.tick, 'cold replacement resumes the persistent clock');
    assert.equal(replacement.game.players.get(returning.welcome.yourId)!.faction, 1);
    assert.equal(replacement.game.world.motionTime, replacement.game.tick / 60);
    const health = await fetch(`http://127.0.0.1:${replacement.port}/healthz`).then(r => r.json()) as { authority: { ready: boolean; epoch: number }; clockDebt: number };
    assert.equal(health.authority.ready, true); assert.ok(health.authority.epoch >= 2);
    assert.ok(health.clockDebt < 10, 'replacement is running close to the shared target');
    assert.equal(replacement.failure, null);
  } finally {
    for (const ws of sockets) ws.terminate();
    for (const world of worlds) await world.close();
    await control.close(); coordinator.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('the-mmofps-clock-recovery-'));
    await rm(root, { recursive: true, force: true });
  }
});

test('a lost bootstrap response retries the same namespace and authority without changing its epoch', { timeout: 12_000 }, async () => {
  const coordinator = new Coordinator(':memory:'), secret = randomBytes(32).toString('hex');
  const control = await startControlPlane(coordinator, secret), counts = new Map<string, number>();
  const proxy = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const response = await fetch(`http://127.0.0.1:${control.port}${req.url}`, { method: 'POST', body: Buffer.concat(chunks),
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } });
      const body = await response.text(), count = (counts.get(req.url!) ?? 0) + 1;
      counts.set(req.url!, count);
      if (count === 1 && response.ok) { res.destroy(); return; }
      res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(body);
    } catch { res.destroy(); }
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const client = new ControlClient(`http://127.0.0.1:${(proxy.address() as { port: number }).port}`, secret);
    const namespace = await client.call<{ namespace: number }>('namespace', { planet: 'meridian', region: 'world' });
    assert.equal(namespace.namespace, coordinator.namespace('meridian'));
    assert.equal(counts.get('/namespace'), 2);
    const registration = { id: 'meridian:bootstrap', planet: 'meridian', url: 'ws://127.0.0.1:1234/ws', tick: 0, humans: 0, capacity: 4 };
    const grant = await client.call<AuthorityGrant>('register', registration);
    assert.equal(counts.get('/register'), 2); assert.equal(grant.epoch, 1);
    assert.equal(coordinator.route('meridian')!.epoch, grant.epoch);
    await assert.rejects(client.call('register', { ...registration, epoch: 999 }), error => error instanceof ControlError && error.code === 'fenced');
    assert.equal(counts.get('/register'), 3, 'a durable fencing rejection is not retried');
  } finally {
    await new Promise<void>(resolve => proxy.close(() => resolve())); await control.close(); coordinator.close();
  }
});
