import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ControlClient } from '../src/control-client.js';

test('startup region layout reads recover after a pooled HTTP connection closes', async () => {
  let requests = 0;
  const layout = { version: 2, xCuts: [0], zCuts: [], entry: { x: -1, z: 0 } };
  const server = createServer((request, response) => {
    requests++;
    if (requests === 1) { request.socket.destroy(); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(layout));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const client = new ControlClient('http://127.0.0.1:' + port, 'fixture-secret');
    assert.deepEqual(await client.call('regions/layout', { planet: 'meridian' }), layout);
    assert.equal(requests, 2, 'the read succeeds on one retry without losing the configured regional bounds');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
