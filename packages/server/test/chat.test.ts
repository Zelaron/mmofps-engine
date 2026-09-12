import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { ChatRoom } from '../src/chat.js';
import { ByteReader, Msg, decodeChat, CHAT_HISTORY_LIMIT } from '@shared/index';

test('world chat relays authoritative names globally, retains history and bounds bursts', () => {
  const game = new Game(1337), a: Uint8Array[] = [], b: Uint8Array[] = [];
  const first = game.addPlayer('First', { send: bytes => a.push(bytes) }), second = game.addPlayer('Second', { send: bytes => b.push(bytes) });
  second.state.px = 9500; second.state.pz = 9500;
  let now = 1000; const room = new ChatRoom(game, () => now);
  assert.equal(room.receive(first, '  Hello 🌴  '), true);
  const read = (bytes: Uint8Array) => { const r = new ByteReader(bytes); assert.equal(r.u8(), Msg.SChat); return decodeChat(r); };
  assert.equal(read(b.at(-1)!).name, first.name); assert.equal(read(b.at(-1)!).text, 'Hello 🌴');
  assert.deepEqual(a.at(-1), b.at(-1));
  assert.equal(room.receive(first, '\n\t'), false);
  assert.equal(room.receive(first, 'two'), true); assert.equal(room.receive(first, 'three'), true);
  assert.equal(room.receive(first, 'too soon'), false);
  now += 1300; assert.equal(room.receive(first, 'again'), true);
  for (let i = 0; i < CHAT_HISTORY_LIMIT + 10; i++) { now += 1300; room.receive(first, `message ${i}`); }
  assert.equal(room.history.length, CHAT_HISTORY_LIMIT);
  const newcomer: Uint8Array[] = [], third = game.addPlayer('Third', { send: bytes => newcomer.push(bytes) });
  newcomer.length = 0; room.join(third);
  assert.equal(newcomer.length, CHAT_HISTORY_LIMIT);
  assert.ok(newcomer.map(read).every(m => m.history));
  assert.equal(read(newcomer.at(-1)!).text, room.history.at(-1)!.text);
  game.removePlayer(first.id); assert.equal(room.receive(first, 'departed'), false);
});
