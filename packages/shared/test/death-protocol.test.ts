import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteReader, Msg, decodeDeath, encodeDeath } from '@shared/protocol';

function read(bytes: Uint8Array) {
  const reader = new ByteReader(bytes); assert.equal(reader.u8(), Msg.SDeath);
  const event = decodeDeath(reader); assert.equal(reader.remaining, 0); return event;
}

test('death events carry the lethal pose and impulse with large entity IDs', () => {
  const motion = { x: -4200.125, y: 105.75, z: 6980.5, vx: -18.25, vy: 14, vz: 6.5, yaw: 1.25 };
  assert.deepEqual(read(encodeDeath(2 ** 40, 2 ** 40 + 1, 3, motion)), {
    victim: 2 ** 40, killer: 2 ** 40 + 1, weapon: 3, motion,
  });
  assert.deepEqual(read(encodeDeath(4, 9, 255)), { victim: 4, killer: 9, weapon: 255 });
});

test('death motion rejects incomplete, trailing and nonfinite pose data', () => {
  const motion = { x: 0, y: 0, z: 0, vx: 12, vy: 9, vz: -4, yaw: 0 };
  const packet = encodeDeath(4, 9, 3, motion);
  assert.throws(() => read(packet.slice(0, -1)), /death motion length/);
  const trailing = new Uint8Array(packet.length + 1); trailing.set(packet);
  assert.throws(() => read(trailing), /death motion length/);
  assert.throws(() => encodeDeath(4, 9, 3, { ...motion, vx: NaN }), /death motion/);
  new DataView(packet.buffer, packet.byteOffset, packet.byteLength).setFloat32(packet.length - 4, Infinity, true);
  assert.throws(() => read(packet), /death motion/);
});
