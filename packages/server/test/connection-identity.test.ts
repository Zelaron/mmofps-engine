import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { WebSocket } from 'ws';
import { Game } from '../src/game.js';
import { PlayerConn } from '../src/conn.js';
import { ChatRoom } from '../src/chat.js';
import { encodeHello } from '@shared/protocol';
import { WorldNode } from '../src/world-node.js';
import type { ControlClient } from '../src/control-client.js';

class Socket extends EventEmitter {
  readyState = 1; OPEN = 1; bufferedAmount = 0;
  send(_bytes: Uint8Array) {}
  close() { this.readyState = 3; this.emit('close'); }
}
function fixture() {
  const game = new Game(1337);
  (game as unknown as { pickSpawn(): { x: number; y: number; z: number } }).pickSpawn = () => ({ x: 0, y: 600, z: 0 });
  const socket = new Socket(), chat = new ChatRoom(game, () => 1000); let leaves = 0;
  const connection = new PlayerConn(socket as unknown as WebSocket, game, 64, chat, { entityId: 1, leaving: () => { leaves++; } });
  socket.emit('message', encodeHello('Explorer'));
  return { game, socket, chat, connection, leaves: () => leaves };
}

test('a delayed old connection close cannot remove a returned actor or reset its chat limiter', () => {
  const f = fixture(), original = f.connection.player!;
  const departed = f.game.takeHandoff([original.id]);
  const [returned] = f.game.acceptHandoff(departed.record, new Map([[original.id, { send() {} }]]));
  assert.notEqual(returned, original);
  for (let i = 0; i < 3; i++) assert.equal(f.chat.receive(returned, `message ${i}`), true);
  f.socket.close();
  assert.equal(f.game.players.get(returned.id), returned);
  assert.equal(f.chat.receive(returned, 'too soon'), false);
  assert.equal(f.leaves(), 1); f.socket.emit('close'); assert.equal(f.leaves(), 1);
});

test('closing the connection still removes its own actor, including a locally restored rollback', () => {
  for (const rollback of [false, true]) {
    const f = fixture(), original = f.connection.player!;
    if (rollback) { f.connection.pauseForTransfer(); f.connection.resumeAfterTransfer(); }
    assert.equal(f.game.players.get(original.id), original);
    f.socket.close(); assert.equal(f.game.players.size, 0); assert.equal(f.leaves(), 1);
  }
});

test('a departing lease callback cannot cancel a returned character\'s new lease or pod launch', async () => {
  const f = fixture(), original = f.connection.player!;
  const detached = f.game.takeHandoff([original.id]);
  const [returned] = f.game.acceptHandoff(detached.record, new Map([[original.id, null]]));
  const node = new WorldNode(f.game, { id: 'world', planet: 'meridian', url: 'http://unused', secret: 'unused' }, 64);
  type Lease = Parameters<WorldNode['lifecycle']>[0];
  const oldLease: Lease = { key: 'a'.repeat(64), entityId: original.id, holder: 'world:before', epoch: 1, validUntil: Infinity,
    state: null, player: original, conn: null, transferring: false };
  const newLease: Lease = { ...oldLease, holder: 'world:return', epoch: 3, player: returned };
  const intern = node as unknown as { control: ControlClient; leases: Map<string, Lease>; launches: Map<string, unknown> };
  const releases: unknown[] = [];
  intern.control.call = async <T>(method: string, body: unknown): Promise<T> => { releases.push({ method, body }); return { released: false } as T; };
  const launch = { lease: newLease, destination: 'cinder', tick: 100, x: 0, y: 600, z: 0, health: 100 };
  intern.leases.set(newLease.key, newLease); intern.launches.set(newLease.key, launch);
  node.lifecycle(oldLease).leaving!(original);
  assert.equal(intern.leases.get(newLease.key), newLease); assert.equal(intern.launches.get(newLease.key), launch);
  assert.equal(newLease.player, returned); assert.equal(oldLease.player, null);
  assert.equal((releases[0] as { body: { epoch: number; holder: string } }).body.epoch, 1);
  assert.equal((releases[0] as { body: { epoch: number; holder: string } }).body.holder, oldLease.holder);
  await node.close();
});
