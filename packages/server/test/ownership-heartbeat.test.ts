import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { WorldNode, regionalOwnership } from '../src/world-node.js';
import { Coordinator } from '../src/coordinator.js';
import { startControlPlane } from '../src/control-plane.js';
import { Game } from '../src/game.js';
import { RegionGrid } from '@shared/regions';
import type { Faction } from '@shared/frontier';

test('regional summaries assign each shared boundary point to exactly one authority', () => {
  const grid = new RegionGrid({ version: 2, xCuts: [0], zCuts: [], entry: { x: -1, z: 0 } });
  const points = [{ x: -1, z: 0, owner: 1 }, { x: 0, z: 0, owner: 2 }, { x: 1, z: 0, owner: 3 }] as const;
  assert.deepEqual(regionalOwnership(points, grid.get('r0:0')!), { ownership: [0, 1, 0, 0], ownershipPoints: 1 });
  assert.deepEqual(regionalOwnership(points, grid.get('r1:0')!), { ownership: [0, 0, .5, .5], ownershipPoints: 2 });
  assert.deepEqual(regionalOwnership([], grid.get('r0:0')!), { ownership: [1, 0, 0, 0], ownershipPoints: 0 });
});

test('a real worker heartbeat updates the remote planet ownership summary over the control plane', async () => {
  const c = new Coordinator(':memory:'), secret = randomBytes(32).toString('hex'), control = await startControlPlane(c, secret);
  const game = new Game(1337, { frontier: true });
  const node = new WorldNode(game, { id: 'ownership-fixture', planet: 'meridian', secret,
    url: 'http://127.0.0.1:' + control.port }, 64);
  try {
    for (const point of game.frontier!.territories) point.owner = 3;
    await node.start(1234);
    assert.deepEqual(c.status().planets[0].ownership, [0, 0, 0, 1]);
    const counts = [0, 0, 0, 0];
    game.frontier!.territories.forEach((point, i) => { point.owner = (i % 4) as Faction; counts[point.owner]++; });
    await (node as unknown as { heartbeat(): Promise<void> }).heartbeat();
    assert.deepEqual(c.status().planets[0].ownership, counts.map(count => count / game.frontier!.territories.length));
    assert.equal(c.status().planets[1].ownership, undefined, 'a different planet has its own independent report');
  } finally {
    await node.close(); await control.close();
    assert.equal(c.status().planets[0].ownership, undefined, 'clean shutdown also expires the public report');
    c.close();
  }
});
