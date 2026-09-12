import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import WebSocket from 'ws';
import { Coordinator } from '../src/coordinator.js';
import { startControlPlane } from '../src/control-plane.js';
import { startServer } from '../src/server.js';
import { startGateway } from '../src/gateway.js';
import { ByteReader, Msg, encodeHello, decodeWelcome } from '@shared/protocol';
import { encodeOutpostAction } from '@shared/outpost-wire';

const until = async (condition: () => unknown, message: string) => {
  const end = Date.now() + 12_000;
  while (!condition() && Date.now() < end) await new Promise(r => setTimeout(r, 25));
  assert.ok(condition(), message);
};
for (const released of [false, true]) test(`lost construction responses reconcile payment and colliders${released ? ' when the character lease closes between retries' : ''}`, { timeout: 30_000 }, async () => {
  const c = new Coordinator(':memory:'), secret = randomBytes(32).toString('hex');
  const control = await startControlPlane(c, secret), requests: string[] = [];
  const proxy = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const upstream = await fetch(`http://127.0.0.1:${control.port}${req.url}`, { method: 'POST', body, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' } });
      const response = await upstream.text();
      if (req.url === '/construct' && upstream.ok) { requests.push(JSON.parse(body.toString()).id); if (released) c.release(JSON.parse(body.toString()).row); res.destroy(); return; }
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(response);
    } catch { res.writeHead(503).end(); }
  });
  await new Promise<void>(r => proxy.listen(0, '127.0.0.1', r));
  const server = await startServer({ port: 0, host: '127.0.0.1', seed: 1337, targetPopulation: 0, log: false, node: {
    id: 'meridian', planet: 'meridian', secret, url: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` } });
  const gateway = await startGateway(c, { port: 0, host: '127.0.0.1', clientDir: '.', secret }), clients: WebSocket[] = [];
  try {
    const response = await fetch(`http://127.0.0.1:${gateway.port}/api/session`), cookie = response.headers.get('set-cookie')!.split(';')[0];
    const key = createHash('sha256').update(cookie.split('=')[1]).digest('hex');
    const connect = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${gateway.port}/ws`, { headers: { Cookie: cookie } }); clients.push(ws); ws.binaryType = 'arraybuffer';
      let id = 0; ws.on('error', () => {});
      ws.on('message', data => { const r = new ByteReader(data as ArrayBuffer); if (r.u8() === Msg.SWelcome) id = decodeWelcome(r).yourId; });
      ws.on('open', () => ws.send(encodeHello('Camp explorer'))); await until(() => id, 'admission'); return { ws, id };
    };
    const first = await connect(), p = server.game.players.get(first.id)!;
    Object.assign(p.state, { px: -1494, py: server.game.world.groundY(-1494, 1895) + .01, pz: 1895, grounded: true, vx: 0, vy: 0, vz: 0 });
    const before = p.salvage;
    first.ws.send(encodeOutpostAction({ action: 'build', type: 0, x: -1494, z: 1888, facing: 0 }));
    await until(() => requests.length === (released ? 1 : 3), 'response-loss recovery was exercised');
    assert.equal(new Set(requests).size, 1); assert.equal(c.outposts('meridian').length, 1);
    await until(() => first.ws.readyState === WebSocket.CLOSED && !c.locate(key)!.holder, 'uncertain client returns to durable authority');
    await until(() => server.game.world.outposts.sites.size === 1, 'heartbeat reloads the committed collision field');
    const next = await connect(); assert.equal(next.id, first.id);
    assert.equal(server.game.players.get(next.id)!.salvage, before - 20);
    assert.equal(server.game.players.get(next.id)!.salvageSpent, 20);
    assert.ok(server.game.world.sdf(-1494, c.outposts('meridian')[0].y + 1.2, 1888 - 2.8) < 0);
  } finally {
    for (const ws of clients) ws.terminate();
    await gateway.close(); await server.close(); await new Promise<void>(r => proxy.close(() => r())); await control.close(); c.close();
  }
});
