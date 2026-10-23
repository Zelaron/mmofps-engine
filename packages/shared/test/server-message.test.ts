import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteWriter, ByteReader, Msg, encodeServerMessage } from '@shared/protocol';

test('planet bounty announcements retain attribution and reward details beyond the short name limit', () => {
  const text = 'PLANET BOUNTY: Ossuary Titan defeated by Alice and 2 fellow hunters! 3 hunters rewarded. Nuke Launcher cache at the kill site, reserved for participants for 90 seconds.';
  const reader = new ByteReader(encodeServerMessage(text));
  assert.equal(reader.u8(), Msg.SMessage); assert.equal(reader.str(), text); assert.equal(reader.remaining, 0);
  const short = new ByteReader(new ByteWriter().str('x'.repeat(100)).finish());
  assert.equal(short.str(), 'x'.repeat(60), 'names and existing short fields retain their limit');
});

test('long UTF-8 announcements respect the one-byte wire bound without splitting code points or trailing fields', () => {
  for (const text of ['A'.repeat(500), '€'.repeat(200), '🦴'.repeat(200), 'x'.repeat(254) + '🦴']) {
    const bytes = new ByteWriter().str(text, 255).u8(77).finish(), reader = new ByteReader(bytes);
    const result = reader.str();
    assert.ok(new TextEncoder().encode(result).length <= 255);
    assert.ok(text.startsWith(result)); assert.ok(!result.includes('\ufffd'));
    assert.equal(reader.u8(), 77); assert.equal(reader.remaining, 0);
  }
  const boundary = new ByteReader(new ByteWriter().str('x'.repeat(59) + '🦴').finish());
  assert.equal(boundary.str(), 'x'.repeat(59), 'a short field does not split a surrogate pair either');
});
