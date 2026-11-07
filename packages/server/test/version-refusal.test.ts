import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';
import { startServer } from '../src/server.js';
import { startGateway } from '../src/gateway.js';
import type { Coordinator } from '../src/coordinator.js';
import { ByteWriter, Msg, PROTOCOL_VERSION, encodeVersionNotice } from '@shared/index';

// A tab left open across an update runs the previous client. It must learn
// that it is outdated (and reload) instead of retrying the connection forever.

interface Outcome { messages: Uint8Array[]; code: number; reason: string }

function attempt(url: string, hello: Uint8Array, headers: Record<string, string> = {}): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers }), messages: Uint8Array[] = [];
    ws.on('open', () => ws.send(hello));
    ws.on('message', data => messages.push(new Uint8Array(data as Buffer)));
    ws.on('close', (code, reason) => resolve({ messages, code, reason: reason.toString() }));
    ws.on('error', reject);
  });
}
const outdatedHello = () => new ByteWriter(32).u8(Msg.CHello).u8(PROTOCOL_VERSION - 1).str('Old tab').finish();

test('a world tells an outdated client its protocol before refusing it', async () => {
  const server = await startServer({ port: 0, targetPopulation: 0, log: false, clientDir: '.' });
  try {
    const outcome = await attempt(`ws://127.0.0.1:${server.port}/ws`, outdatedHello());
    assert.deepEqual(outcome.messages, [encodeVersionNotice()]);
    assert.deepEqual([outcome.code, outcome.reason], [1002, `protocol v${PROTOCOL_VERSION} required`]);
    assert.equal([...server.game.players.values()].filter(p => !p.isBot).length, 0, 'no character joins');
  } finally { await server.close(); }
});

test('the gateway passes a protocol refusal through but retries other world closes', async () => {
  let close: [number, string] = [1002, `protocol v${PROTOCOL_VERSION} required`];
  const world = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  world.on('connection', ws => ws.once('message', () => { ws.send(encodeVersionNotice()); ws.close(...close); }));
  await new Promise(resolve => world.once('listening', resolve));
  const worldPort = (world.address() as { port: number }).port;
  const coordinator = {
    entryPlanet: 'meridian', locate: () => null, planetEnabled: () => true, status: () => ({ planets: [] }),
    routeCharacter: () => ({ url: `ws://127.0.0.1:${worldPort}/ws` }),
  } as unknown as Coordinator;
  const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', clientDir: '.', secret: 'x'.repeat(32) });
  try {
    const session = await fetch(`http://127.0.0.1:${gateway.port}/api/session`);
    const cookie = session.headers.get('set-cookie')!.split(';')[0], url = `ws://127.0.0.1:${gateway.port}/ws`;
    const refused = await attempt(url, outdatedHello(), { Cookie: cookie });
    assert.deepEqual(refused.messages, [encodeVersionNotice()], 'the version notice reaches the browser');
    assert.deepEqual([refused.code, refused.reason], close, 'an outdated client stops instead of reconnecting');
    close = [1011, 'world restarting'];
    const interrupted = await attempt(url, outdatedHello(), { Cookie: cookie });
    assert.equal(interrupted.code, 1013, 'an ordinary world interruption is still retried');
  } finally {
    await gateway.close();
    await new Promise(resolve => world.close(resolve));
  }
});
