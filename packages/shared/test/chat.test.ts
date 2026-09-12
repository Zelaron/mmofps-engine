import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteReader, ByteWriter, Msg, CHAT_MAX_LENGTH, cleanChat, encodeClientChat, decodeClientChat, encodeChat, decodeChat } from '../src/index.js';
test('chat preserves Unicode and punctuation within a strict character and byte budget', () => {
  const text = 'Hello jungle 🌴 <b>friends</b> åäö';
  const wire = encodeClientChat(text), r = new ByteReader(wire);
  assert.equal(r.u8(), Msg.CChat); assert.equal(decodeClientChat(r), text);
  const long = encodeClientChat('🌊'.repeat(500)), lr = new ByteReader(long); lr.u8();
  assert.equal([...decodeClientChat(lr)].length, CHAT_MAX_LENGTH); assert.ok(long.length <= 643);
  assert.equal(cleanChat('  hello\n\tworld\u202e  '), 'hello world');
  const message = { id: 4, playerId: 7, name: 'Ada', text, time: 1000, history: true };
  const sr = new ByteReader(encodeChat(message)); assert.equal(sr.u8(), Msg.SChat);
  assert.deepEqual(decodeChat(sr), message);
});
test('chat decoder rejects truncated, oversized and trailing payloads', () => {
  for (const bytes of [new ByteWriter().u16(5).u8(65).finish(), new ByteWriter().u16(900).finish(), new ByteWriter().u16(1).u8(65).u8(9).finish()])
    assert.throws(() => decodeClientChat(new ByteReader(bytes)));
});
