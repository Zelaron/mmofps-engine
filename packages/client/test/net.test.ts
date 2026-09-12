import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NetClient, type NetHandlers } from '../src/net.js';
import { encodeWelcome, encodeLeave, Msg, PROTOCOL_VERSION, type WelcomeMsg, type TeleporterPad } from '@shared/index';

test('initial admission and reconnect send no gameplay packets before the world welcome', () => {
  const oldSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket'), oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    static instances: Socket[] = [];
    readyState = 0; binaryType = '';
    onopen = () => {}; onclose = (_: { code: number; reason: string }) => {};
    onmessage = (_: { data: ArrayBuffer }) => {}; onerror = () => {};
    sent: Uint8Array[] = [];
    constructor(_url: string) { Socket.instances.push(this); }
    send(data: Uint8Array) { this.sent.push(data); }
    open() { this.readyState = 1; this.onopen(); }
    close(code = 1013, reason = 'Reconnecting') { this.readyState = 3; this.onclose({ code, reason }); }
    welcome(id: number, seed: number, pads: TeleporterPad[]) {
      this.onmessage({ data: encodeWelcome(id, seed, 10, pads).buffer as ArrayBuffer });
    }
  }
  Object.defineProperty(globalThis, 'WebSocket', { value: Socket, configurable: true });
  Object.defineProperty(globalThis, 'location', { value: { protocol: 'http:', host: '127.0.0.1:8081' }, configurable: true });
  const closes: number[] = [], welcomes: number[] = [], leaves: number[] = [];
  const layouts: WelcomeMsg[] = [], messages: string[] = [];
  const ignore = () => {};
  const handlers: NetHandlers = {
    onWelcome(message) { welcomes.push(message.yourId); layouts.push(message); }, onClose(code) { closes.push(code); },
    onSnapshot: ignore, onFire: ignore, onExplosion: ignore, onDeath: ignore, onSpawn: ignore,
    onHit: ignore, onPickupResult: ignore, onTeleport: ignore, onJoin: ignore, onLeave: id => leaves.push(id),
    onScores: ignore, onMessage: text => messages.push(text),
  };
  const client = new NetClient(handlers);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      client.connect('Explorer'); const socket = Socket.instances.at(-1)!; socket.open();
      for (let i = 0; i < 90; i++) client.send(Uint8Array.of(Msg.CInput));
      assert.equal(socket.sent.length, 1, 'only hello is queued while a world lease is pending');
      assert.equal(socket.sent[0][0], Msg.CHello); assert.equal(client.connected, false);
      const seed = attempt ? 7331 : 1337;
      const pads = [{ x: seed + .123456789, y: -20.999999999, z: 3, cave: true, partner: 1 },
        { x: 4, y: 10.222222222, z: seed, cave: false, partner: 0 }];
      if (attempt) {
        const old = Socket.instances[attempt - 1];
        old.onmessage({ data: encodeWelcome(777, 1, 1, []).buffer as ArrayBuffer });
        old.onclose({ code: 1006, reason: 'late old close' }); old.onopen();
        assert.equal(layouts.length, 1, 'a retired socket cannot install a world layout');
        assert.equal(client.connected, false);
        assert.deepEqual(closes, [1013], 'a late close cannot restart the new admission');
      }
      socket.welcome(100_000, seed, pads); assert.equal(client.connected, true);
      assert.deepEqual(layouts.at(-1), { version: PROTOCOL_VERSION, yourId: 100_000, seed, tick: 10, teleporters: pads });
      socket.onmessage({ data: encodeLeave(0xfffffffe).buffer as ArrayBuffer });
      client.send(Uint8Array.of(Msg.CInput)); assert.equal(socket.sent.length, 2);
      socket.close(attempt ? 4001 : 1013); assert.equal(client.connected, false);
    }
    assert.deepEqual(welcomes, [100_000, 100_000]); assert.deepEqual(closes, [1013, 4001]);
    assert.deepEqual(leaves, [0xfffffffe, 0xfffffffe]);
    client.connect('Explorer'); const incompatible = Socket.instances.at(-1)!; incompatible.open();
    incompatible.onmessage({ data: Uint8Array.of(Msg.SWelcome, PROTOCOL_VERSION - 1).buffer });
    assert.equal(client.connected, false); assert.equal(closes.at(-1), 1002);
    assert.match(messages.at(-1)!, /Protocol mismatch/);
    assert.equal(layouts.length, 2, 'version mismatch is handled before reading a changed packet body');
  } finally {
    for (const socket of Socket.instances) if (socket.readyState !== 3) socket.close();
    if (oldSocket) Object.defineProperty(globalThis, 'WebSocket', oldSocket); else Reflect.deleteProperty(globalThis, 'WebSocket');
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else Reflect.deleteProperty(globalThis, 'location');
  }
});
