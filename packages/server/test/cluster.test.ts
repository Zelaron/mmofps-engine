import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { startCluster } from '../src/cluster.js';
import { Msg, ByteReader, decodeWelcome, encodeHello, type WelcomeMsg } from '@shared/index';

async function until(check: () => unknown, label: string, timeout = 20_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50)); }
}
async function join(port: number, cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: cookie } }); ws.binaryType = 'arraybuffer';
  const state: { welcome: WelcomeMsg | null; closeCode: number | null } = { welcome: null, closeCode: null };
  ws.on('error', () => {}); ws.on('close', code => { state.closeCode = code; });
  ws.on('message', data => { const r = new ByteReader(data as ArrayBuffer); if (r.u8() === Msg.SWelcome) state.welcome = decodeWelcome(r); });
  ws.on('open', () => ws.send(encodeHello('Returning explorer')));
  await until(() => state.welcome, 'welcome'); return { ws, state };
}

test('three independent worker processes run full worlds and recover character ownership after a worker crash', { timeout: 75_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-cluster-'));
  let cluster: Awaited<ReturnType<typeof startCluster>> | null = null;
  const sockets: WebSocket[] = [];
  try {
    cluster = await startCluster({ dataDir: root, port: 0, host: '127.0.0.1', targetPopulation: 0, maxPlayers: 4, log: false });
    const pids = [...cluster.workers.values()].map(w => w.process.pid);
    assert.equal(new Set(pids).size, 3); assert.ok(pids.every(pid => pid && pid !== process.pid));
    const health = await fetch(`http://127.0.0.1:${cluster.port}/healthz`).then(r => r.json()) as { worlds: { available: boolean }[] };
    assert.equal(health.worlds.filter(w => w.available).length, 3);
    const response = await fetch(`http://127.0.0.1:${cluster.port}/api/session`), cookie = response.headers.get('set-cookie')!.split(';')[0];
    const key = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
    const first = await join(cluster.port, cookie); sockets.push(first.ws);
    first.ws.send(Uint8Array.of(Msg.CFaction, 1));
    await until(() => cluster!.coordinator.locate(key)?.state?.faction === 1, 'durable faction checkpoint');
    // Same-browser duplicate tabs replace their older connection once, with a
    // distinct close code that the browser does not automatically retry.
    const replacement = await join(cluster.port, cookie); sockets.push(replacement.ws);
    await until(() => first.state.closeCode === 4001, 'duplicate tab closes the older session');
    const previous = cluster.workers.get('meridian')!, other = cluster.workers.get('cinder')!;
    const otherBefore = await fetch(`http://127.0.0.1:${other.port}/healthz`).then(r => r.json()) as { tick: number };
    const epoch = cluster.coordinator.locate(key)!.epoch;
    previous.process.kill('SIGKILL');
    await until(() => replacement.state.closeCode !== null, 'gateway detects the stopped worker');
    await until(() => cluster!.workers.get('meridian')?.process.pid && cluster!.workers.get('meridian')!.process.pid !== previous.process.pid, 'supervisor starts a fresh process');
    await until(() => cluster!.coordinator.locate(key)!.leaseUntil < Date.now(), 'previous character lease expires');
    const returning = await join(cluster.port, cookie); sockets.push(returning.ws);
    assert.equal(returning.state.welcome!.seed, 1337);
    const owner = cluster.coordinator.locate(key)!;
    assert.ok(owner.epoch > epoch); assert.equal(owner.state!.faction, 1);
    const otherAfter = await fetch(`http://127.0.0.1:${other.port}/healthz`).then(r => r.json()) as { tick: number };
    assert.ok(otherAfter.tick > otherBefore.tick + 300, 'the other planet kept simulating during recovery');
  } finally {
    for (const ws of sockets) ws.terminate(); await cluster?.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('the-mmofps-cluster-'));
    await rm(root, { recursive: true, force: true });
  }
});
