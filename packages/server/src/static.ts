import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.ttf': 'font/ttf',
  '.woff2': 'font/woff2', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream',
};
export function acceptedEncodings(header = ''): string[] {
  const entries = header.split(',').map(item => {
    const [name, ...params] = item.trim().split(';');
    const q = params.find(p => p.trim().startsWith('q='));
    return { name: name.trim().toLowerCase(), q: q ? Number(q.trim().slice(2)) : 1 };
  });
  return ['br', 'gzip'].map(name => ({ name, q: entries.find(e => e.name === name)?.q ?? entries.find(e => e.name === '*')?.q ?? 0 }))
    .filter(e => e.q > 0 && e.q <= 1).sort((a, b) => b.q - a.q).map(e => e.name);
}
export function serveStatic(root: string, req: IncomingMessage, res: ServerResponse): void {
  void serve(root, req, res).catch(() => { if (!res.headersSent) res.writeHead(500); res.end(); });
}
async function serve(root: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  let url: string;
  try { url = decodeURIComponent((req.url ?? '/').split('?')[0]); } catch { res.writeHead(400).end(); return; }
  if (url === '/') url = '/index.html';
  const directory = path.resolve(root), file = path.resolve(directory, `.${url}`);
  const relative = path.relative(directory, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) { res.writeHead(403).end(); return; }
  let selected = file, encoding = '';
  try {
    const source = await stat(file);
    if (!source.isFile()) { res.writeHead(404).end(); return; }
    for (const candidate of acceptedEncodings(req.headers['accept-encoding'])) {
      const variant = `${file}.${candidate === 'br' ? 'br' : 'gz'}`;
      try {
        if ((await stat(variant)).mtimeMs >= source.mtimeMs) { selected = variant; encoding = candidate; break; }
      } catch { /* Uncompressed dev builds are valid. */ }
    }
    const info = await stat(selected), etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}-${encoding}"`;
    res.setHeader('Vary', 'Accept-Encoding'); res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (encoding) res.setHeader('Content-Encoding', encoding);
    if (req.headers['if-none-match'] === etag) { res.writeHead(304).end(); return; }
    const bytes = req.method === 'HEAD' ? undefined : await readFile(selected);
    res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
    res.setHeader('Content-Length', info.size); res.writeHead(200).end(bytes);
  } catch (error) {
    res.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).end();
  }
}