import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResourceField, resourceCandidate, type ResourceSnapshot } from '../src/resources.js';
import type { World } from '../src/worldgen.js';
import { encodeResources, decodeResources, encodeHarvest } from '../src/resource-wire.js';
import { ByteReader, Msg } from '../src/protocol.js';

test('resource candidates have stable negative-cell ownership and bounded surface caching', () => {
  const world = { seed: 1337, groundY: () => 10, liquidAt: () => null, sdf: () => 100, trace: () => ({ hit: true, y: 10, ny: 1 }) } as unknown as World;
  const field = new ResourceField(world), original = field.get('-1,-1');
  assert.ok(original && original.x < 0 && original.z < 0);
  for (let x = -20; x < 20; x++) for (let z = -20; z < 20; z++) field.get(`${x},${z}`);
  assert.equal(field.cacheSize, 1024); assert.deepEqual(field.get('-1,-1'), original);
  assert.ok(field.near(-.1, -.1).every(n => n.id.startsWith('-') || n.x >= 0));
  for (const id of ['-0,0', '01,0', '88,0', '0,88', '0,0/1', 'NaN,0']) assert.throws(() => resourceCandidate(1337, id));
  assert.notDeepEqual(resourceCandidate(1337, '0,0'), resourceCandidate(7331, '0,0'));
});

test('resource deposits avoid water, steep terrain and occupied solid space', () => {
  const node = resourceCandidate(1337, '0,0');
  const world = { seed: 1337, groundY: () => 10, liquidAt: () => null, sdf: () => 100, trace: () => ({ hit: true, y: 10, ny: 1 }) };
  assert.ok(new ResourceField(world as unknown as World).get(node.id));
  assert.equal(new ResourceField({ ...world, liquidAt: () => ({}) } as unknown as World).get(node.id), null);
  assert.equal(new ResourceField({ ...world, sdf: () => 0 } as unknown as World).get(node.id), null);
  assert.equal(new ResourceField({ ...world, groundY: (x: number) => x } as unknown as World).get(node.id), null);
  assert.equal(new ResourceField({ ...world, trace: () => ({ hit: true, y: 10, ny: .7 }) } as unknown as World).get(node.id), null);
  assert.equal(new ResourceField({ ...world, trace: () => ({ hit: false, y: 10, ny: 1 }) } as unknown as World).get(node.id), null);
});

test('resource wire is bounded and rejects truncated, duplicate and invalid target records', () => {
  const state: ResourceSnapshot = { enabled: true, saving: false, target: '-1,2', progress: .5, reason: '', nodes: [{ id: '-1,2', x: -40, y: 11, z: 275, remaining: 0 }] };
  const packet = encodeResources(state), decode = (bytes: Uint8Array) => { const r = new ByteReader(bytes); assert.equal(r.u8(), Msg.SResources); return decodeResources(r); };
  const result = decode(packet); assert.equal(result.target, state.target); assert.deepEqual(result.nodes, state.nodes); assert.ok(Math.abs(result.progress - .5) < .004);
  assert.deepEqual([...encodeHarvest(true)], [Msg.CHarvest, 1]);
  assert.throws(() => decode(packet.slice(0, -1)));
  assert.throws(() => decode(new Uint8Array([...packet, 0])));
  assert.throws(() => decode(encodeResources({ ...state, target: '4,4' })));
  assert.throws(() => decode(encodeResources({ ...state, nodes: [state.nodes[0], state.nodes[0]] })));
  assert.throws(() => encodeResources({ ...state, nodes: Array(10).fill(state.nodes[0]) }));
});
