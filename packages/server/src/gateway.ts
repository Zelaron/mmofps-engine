import { createServer } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';
import type { Coordinator } from './coordinator.js';
import { ensureSession, sessionKey } from './persistence.js';
import { serveStatic } from './static.js';

interface GatewayOptions { port: number; host: string; clientDir: string; secret: string; capacity?: number }
interface Link { downstream: WebSocket; upstream: WebSocket; key: string; closed: boolean; alive: boolean }
export async function startGateway(coordinator: Coordinator, options: GatewayOptions) {
  const links = new Set<Link>(), identities = new Map<string, Link>();
  const http = createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname === '/api/session') {
      const key = sessionKey(req), owner = key ? coordinator.locate(key) : null;
      ensureSession(req, res, { planet: owner?.planet ?? 'meridian' }); return;
    }
    if (pathname === '/api/universe') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(coordinator.status())); return;
    }
    if (pathname === '/healthz') {
      const universe = coordinator.status();
      res.writeHead(universe.planets.some(p => p.available) ? 200 : 503, { 'Content-Type': 'application/json' })
        .end(JSON.stringify({ ok: universe.planets.some(p => p.available), game: 'THE MMOFPS', role: 'gateway', connections: links.size, worlds: universe.planets })); return;
    }
    serveStatic(options.clientDir, req, res);
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: false });
  http.on('upgrade', (req, socket, head) => {
    const pathname = (req.url ?? '/').split('?')[0], key = sessionKey(req);
    let originOK = true;
    try { if (req.headers.origin) originOK = new URL(req.headers.origin).host === req.headers.host; } catch { originOK = false; }
    if (pathname !== '/ws' || !key || !originOK || links.size >= (options.capacity ?? 4096)) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return;
    }
    const target = coordinator.routeCharacter(key);
    if (!target) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    const previous = identities.get(key);
    previous?.downstream.close(4001, 'Session opened in another tab');
    wss.handleUpgrade(req, socket, head, downstream => {
      const upstream = new WebSocket(target.url, { maxPayload: 256 * 1024, perMessageDeflate: false, handshakeTimeout: 7000,
        headers: { Authorization: `Bearer ${options.secret}`, 'x-mmofps-identity': key } });
      const link: Link = { downstream, upstream, key, closed: false, alive: true };
      identities.set(key, link); links.add(link);
      const pending: Buffer[] = []; let messages = 0, windowStart = performance.now();
      const finish = (code = 1013, reason = 'World connection interrupted') => {
        if (link.closed) return; link.closed = true;
        links.delete(link); if (identities.get(key) === link) identities.delete(key);
        if (downstream.readyState === WebSocket.OPEN) downstream.close(code, reason);
        if (upstream.readyState === WebSocket.OPEN) upstream.close();
        else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
      };
      downstream.on('message', (data, binary) => {
        if (!binary) { finish(1003, 'Binary protocol required'); return; }
        if (performance.now() - windowStart >= 1000) { windowStart = performance.now(); messages = 0; }
        if (++messages > 150) { finish(1008, 'Input rate exceeded'); return; }
        if (upstream.readyState === WebSocket.OPEN) {
          if (upstream.bufferedAmount > 65536) { finish(); return; }
          upstream.send(data, { binary: true });
        } else if (pending.length < 8) pending.push(Buffer.from(data as Buffer));
        else finish(1013, 'World admission is still pending');
      });
      upstream.on('open', () => { for (const message of pending) upstream.send(message, { binary: true }); pending.length = 0; });
      upstream.on('message', (data, binary) => {
        if (downstream.readyState !== WebSocket.OPEN) return;
        if (downstream.bufferedAmount > 512 * 1024) { finish(1013, 'Connection cannot keep up'); return; }
        downstream.send(data, { binary });
      });
      downstream.on('pong', () => { link.alive = true; });
      downstream.on('close', () => finish()); downstream.on('error', () => finish());
      upstream.on('close', (code, reason) => finish(code === 4001 ? 4001 : 1013, reason.toString().slice(0, 100) || 'World connection interrupted'));
      upstream.on('error', () => finish());
    });
  });
  const heartbeat = setInterval(() => {
    for (const link of links) {
      if (!link.alive) { link.downstream.terminate(); continue; }
      link.alive = false; link.downstream.ping();
    }
  }, 15000);
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(options.port, options.host, resolve); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No gateway address');
  return { port: address.port, async close() {
    clearInterval(heartbeat);
    for (const link of links) link.downstream.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => http.close(() => resolve()));
  } };
}
