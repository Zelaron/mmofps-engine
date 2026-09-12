import { createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

/** A real loopback HTTP origin for comparing archived clients against the
 * same development gateway. Browser interception classifies a fulfilled
 * document differently for local-network access and can block its socket. */
export async function startupFixture(upstream, clientDir) {
  assert.equal(upstream.protocol, 'http:');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(upstream.hostname));
  const host = upstream.hostname.replace(/^\[|\]$/g, ''), port = Number(upstream.port || 80);
  const root = path.resolve(clientDir), sockets = new Set();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.woff2': 'font/woff2', '.json': 'application/json', '.png': 'image/png' };
  const server = createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname.startsWith('/api/') || pathname === '/healthz') {
      // Preserve the public Host/Origin pair as a conventional reverse proxy.
      const forwarded = httpRequest({ host, port, path: req.url, method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode ?? 502, response.headers); response.pipe(res);
      });
      forwarded.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.on('error', () => forwarded.destroy()); req.pipe(forwarded);
      return;
    }
    void (async () => {
      let decoded;
      try { decoded = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
      catch { res.writeHead(400).end(); return; }
      const file = path.resolve(root, '.' + decoded), relative = path.relative(root, file);
      if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(404).end(); return; }
      let body, encoding;
      if (req.headers['accept-encoding']?.includes('br')) {
        try { body = await readFile(file + '.br'); encoding = 'br'; } catch {}
      }
      if (!body) body = await readFile(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store', 'Content-Length': body.length, ...(encoding ? { 'Content-Encoding': encoding } : {}) });
      res.end(req.method === 'HEAD' ? undefined : body);
    })().catch(() => { if (!res.headersSent) res.writeHead(404); res.end(); });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
    const remote = connect({ host, port }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      remote.write(lines.join('\r\n') + '\r\n\r\n');
      if (head.length) remote.write(head);
      remote.pipe(socket); socket.pipe(remote);
    });
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy());
    remote.on('close', () => socket.destroy()); socket.on('close', () => remote.destroy());
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const url = new URL(upstream); url.hostname = '127.0.0.1'; url.port = String(server.address().port);
  return { url, close: () => new Promise((resolve, reject) => {
    for (const socket of sockets) socket.destroy();
    server.close(error => error ? reject(error) : resolve());
  }) };
}
