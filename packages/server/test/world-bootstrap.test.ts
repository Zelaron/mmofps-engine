import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { Game } from '../src/game.js';
import { PlayerConn } from '../src/conn.js';
import { World, generateTeleporters, encodeHello, ByteReader, decodeWelcome, Msg } from '@shared/index';

class ProbeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  binaryType = '';
  frames: Uint8Array[] = [];
  send(bytes: Uint8Array): void { this.frames.push(bytes.slice()); }
  close(): void { this.readyState = 3; this.emit('close'); }
}

test('admission and reconnect receive the canonical static network despite changing active districts and planetary time', { timeout: 45000 }, () => {
  for (const seed of [1337, 7331, 20077]) {
    const expected = generateTeleporters(new World(seed)), game = new Game(seed, { teleporters: true });
    assert.deepEqual(game.baseTeleporterPads, expected);
    assert.ok(expected.some(pad => pad.cave) && expected.some(pad => !pad.cave));
    for (const attempt of [0, 1]) {
      if (attempt) {
        // This is the rolling regional list, which must never become the
        // bootstrap layout or change its shared destination indices.
        game.teleporterPads = [
          { x: 8192, y: 60, z: 8192, cave: false, partner: 1 },
          { x: 8200, y: -80, z: 8200, cave: true, partner: 0 },
        ];
        game.world.motionTime = 7200;
      }
      const socket = new ProbeSocket();
      new PlayerConn(socket as unknown as WebSocket, game, 4);
      try {
        socket.emit('message', encodeHello('BootstrapProbe'));
        const packet = socket.frames.find(bytes => bytes[0] === Msg.SWelcome);
        assert.ok(packet, 'the real admission path emits the bootstrap');
        const r = new ByteReader(packet); r.u8(); const welcome = decodeWelcome(r);
        assert.equal(welcome.seed, seed); assert.equal(r.remaining, 0);
        assert.deepEqual(welcome.teleporters, expected, 'coordinates and partner indices match the static generator exactly');
        assert.ok(packet.length < 1100, 'the base network adds about 1 KB once per join');
        assert.equal(socket.readyState, socket.OPEN);
      } finally { socket.close(); }
    }
  }
});
