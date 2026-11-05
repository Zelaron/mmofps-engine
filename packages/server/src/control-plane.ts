import { createServer } from 'node:http';
import type { Coordinator, Checkpoint, NodeRegistration } from './coordinator.js';
import { OwnershipError } from './coordinator.js';
import type { SavedPlayer, WorldStore } from './persistence.js';
import { trustedNode } from './control-client.js';

export async function startControlPlane(coordinator: Coordinator, secret: string, options: { host?: string; port?: number; legacy?: WorldStore } = {}) {
  if (secret.length < 32) throw new Error('A control-plane secret must contain at least 32 characters');
  const http = createServer(async (req, res) => {
    if (!trustedNode(req, secret)) { res.writeHead(401).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 2_000_000) { res.writeHead(413).end(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      let result: unknown;
      switch (req.url) {
        case '/campaign/exchange': result = coordinator.campaignExchange(body); break;
        case '/campaign/depart': result = coordinator.departCampaign(body); break;
        case '/campaign/cancel': result = coordinator.cancelCampaign(body); break;
        case '/campaign/transfer': result = coordinator.inspectCampaign(body.id, body.authority); break;
        case '/regions/configure': result = coordinator.configureRegions(body.planet, body.layout); break;
        case '/regions/layout': result = coordinator.layout(body.planet); break;
        case '/regions/route': result = coordinator.route(body.planet, body.region ?? coordinator.region(body.planet, body.position).id); break;
        case '/regions/neighbors': result = coordinator.neighbors(body.planet, body.region, body.reach); break;
        case '/regions/prepare': result = coordinator.prepareRegional(body); break;
        case '/regions/inspect': result = coordinator.inspectRegional(body.id, body.authority); break;
        case '/regions/payload': result = coordinator.regionalPayload(body.id, body.destination); break;
        case '/regions/ready': result = coordinator.readyRegional(body.id, body.destination, body.hash, body.tick); break;
        case '/regions/commit': result = coordinator.commitRegional(body.id, body.source, body.hash); break;
        case '/regions/abort': result = coordinator.abortRegional(body.id, body.authority); break;
        case '/outposts': result = coordinator.outposts(body.planet); break;
        case '/outposts/region': result = coordinator.regionalOutposts(body.authority, body.since); break;
        case '/construct': result = coordinator.construct(body.row, body.id, body.site, body.remove); break;
        case '/resources/view': result = coordinator.resourceView(body.authority, body.ids); break;
        case '/resources/harvest': result = coordinator.harvest(body.row, body.request, body.id, body.expected); break;
        case '/entities/reserve': result = coordinator.reserveEntities(body); break;
        case '/namespace': result = { namespace: coordinator.namespace(body.planet, body.region) }; break;
        case '/register': result = coordinator.register(body as NodeRegistration); break;
        case '/unregister': result = { released: coordinator.unregister(body.id, body.epoch) }; break;
        case '/claim': {
          let imported: SavedPlayer | null = null;
          if (!coordinator.locate(body.key) && options.legacy && body.planet === 'meridian') imported = await options.legacy.loadPlayer(body.key) as SavedPlayer | null;
          result = coordinator.claim(body.key, body.planet, body.holder, body.node, imported); break;
        }
        case '/checkpoint': result = coordinator.checkpoint(body.rows); break;
        case '/release': result = { released: coordinator.release(body as Checkpoint) }; break;
        case '/vacate': result = { released: coordinator.vacate(body.key, body.epoch, body.holder) }; break;
        case '/transfer': result = coordinator.transfer(body.row, body.destination, body.id); break;
        case '/locate': result = coordinator.locate(body.key); break;
        default: res.writeHead(404).end(); return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(result));
    } catch (error) {
      const known = error instanceof OwnershipError;
      res.writeHead(known ? 409 : 500, { 'Content-Type': 'application/json' }).end(JSON.stringify({
        code: known ? error.code : 'unavailable', message: known ? error.message : 'Coordinator request failed', planet: known ? error.planet : undefined,
      }));
      if (!known) console.error('Coordinator request failed:', error);
    }
  });
  http.requestTimeout = 5000;
  // Workers reuse pooled connections. With Node's default 5 s idle timeout, a
  // worker whose event loop was briefly busy (world generation, a large
  // spawn wave) can send its next request on a socket the server already
  // closed and get ECONNRESET. Internal, authenticated clients may idle longer.
  http.keepAliveTimeout = 65_000; http.headersTimeout = 66_000;
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No coordinator address');
  return { port: address.port, async close() { await new Promise<void>(resolve => http.close(() => resolve())); } };
}
