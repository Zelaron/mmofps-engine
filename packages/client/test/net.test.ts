import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { NetClient, type NetHandlers } from '../src/net.js';
import { ByteWriter, createFullAmmoLoadout, encodeSnapshot, encodePong, encodeWelcome, encodeLeave,
  ENT_PROJECTILE, Msg, NET, PROTOCOL_VERSION, TANK_CANNON, TICK_RATE,
  type Snapshot, type WelcomeMsg, type TeleporterPad } from '@shared/index';
import { Interp } from '../src/interp.js';

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

function clockFixture(t: TestContext, onSnapshot: (snapshot: Snapshot) => void = () => {}) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const oldSocket = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  const oldLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  class Socket {
    static OPEN = 1; static CONNECTING = 0;
    static instances: Socket[] = [];
    readyState = 0; binaryType = '';
    onopen = () => {}; onclose = (_: { code: number; reason: string }) => {};
    onmessage = (_: { data: ArrayBuffer }) => {}; onerror = () => {};
    constructor(_url: string) { Socket.instances.push(this); }
    send(_data: Uint8Array) {}
    open() { this.readyState = 1; this.onopen(); }
    close() { this.readyState = 3; this.onclose({ code: 1013, reason: 'Test reconnect' }); }
    receive(bytes: Uint8Array) { this.onmessage({ data: bytes.slice().buffer as ArrayBuffer }); }
  }
  Object.defineProperty(globalThis, 'WebSocket', { value: Socket, configurable: true });
  Object.defineProperty(globalThis, 'location', { value: { protocol: 'http:', host: 'localhost' }, configurable: true });
  t.after(() => {
    for (const socket of Socket.instances) if (socket.readyState !== 3) socket.close();
    if (oldSocket) Object.defineProperty(globalThis, 'WebSocket', oldSocket); else Reflect.deleteProperty(globalThis, 'WebSocket');
    if (oldLocation) Object.defineProperty(globalThis, 'location', oldLocation); else Reflect.deleteProperty(globalThis, 'location');
  });
  const ignore = () => {};
  const client = new NetClient({ onSnapshot, onWelcome: ignore, onClose: ignore,
    onFire: ignore, onExplosion: ignore, onDeath: ignore, onSpawn: ignore,
    onHit: ignore, onPickupResult: ignore, onTeleport: ignore, onJoin: ignore,
    onLeave: ignore, onScores: ignore, onMessage: ignore });
  let socket: Socket;
  const connect = (tick: number) => {
    socket?.close(); client.connect('Clock test'); socket = Socket.instances.at(-1)!;
    socket.open(); socket.receive(encodeWelcome(48, 1337, tick, []));
  };
  return { client, connect, at: (ms: number) => { now = ms; },
    pong: (tick: number) => socket.receive(encodePong(now, tick)),
    snapshot: (snapshot: Snapshot) => {
      const writer = new ByteWriter(); encodeSnapshot(writer, snapshot); socket.receive(writer.finish());
    } };
}

function shellSnapshot(tick: number): Snapshot {
  const age = (tick - 100) / TICK_RATE, speed = TANK_CANNON.speed!, gravity = TANK_CANNON.gravity!;
  return { tick, lastSeq: 0, you: {
    px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, grounded: true, alive: true,
    dodgeCd: 0, health: 100, weapon: 0, cooldown: 0, ammo: createFullAmmoLoadout(),
    reloadWeapon: -1, reloadCooldown: 0, reloadHeld: false,
    vehicle: 0, heading: 0, boostFuel: 1, vehicleHealth: 0, lockState: 0,
  }, ents: [{ kind: ENT_PROJECTILE, id: 17, owner: 9, weapon: TANK_CANNON.id,
    x: speed * age, y: 100 - .5 * gravity * age * age, z: 0,
    vx: speed, vy: -gravity * age, vz: 0 }] };
}

test('a delayed snapshot holds the clock and tank shell instead of replaying its flight backward', t => {
  const interp = new Interp(), f = clockFixture(t, snap => interp.push(snap));
  f.connect(100); f.snapshot(shellSnapshot(100));
  f.at(1000 / 30); f.snapshot(shellSnapshot(102));
  f.at(200);
  const before = f.client.estServerTick(), shell = interp.sampleProjectiles(before - NET.INTERP_TICKS)[0];
  assert.ok(shell, 'the shell is visible just before the delayed packet');
  f.at(220); f.snapshot(shellSnapshot(104)); // More than eight ticks behind the old estimate.
  let previousTick = before, previousX = shell.x;
  for (let tick = 104; tick <= 132; tick += 2) {
    if (tick > 104) { f.at(220 + (tick - 104) * 10); f.snapshot(shellSnapshot(tick)); }
    const estimated = f.client.estServerTick();
    assert.ok(estimated >= previousTick, `clock rewound from ${previousTick} to ${estimated}`);
    assert.ok(estimated <= tick + TICK_RATE * .25, 'clock retains its bounded prediction horizon');
    const rendered = interp.sampleProjectiles(estimated - NET.INTERP_TICKS)[0];
    assert.ok(rendered, 'a brief recovery does not hide an existing shell');
    assert.ok(rendered.x >= previousX - 1e-6, `shell moved backward from ${previousX} to ${rendered.x}`);
    previousTick = estimated; previousX = rendered.x;
  }
  assert.ok(previousTick > before + 10, 'the held clock resumes as snapshots catch up');
});

test('small packet corrections cannot rewind the display and a long stall remains bounded', t => {
  const f = clockFixture(t); f.connect(100);
  f.at(2); const displayed = f.client.estServerTick();
  f.pong(100);
  assert.equal(f.client.estServerTick(), displayed, 'even a small smoothed correction holds already displayed time');
  f.at(60_000);
  assert.equal(f.client.estServerTick(), 115, 'a full minute without snapshots cannot extrapolate beyond 250 ms');
  f.pong(102);
  assert.equal(f.client.estServerTick(), 115, 'a delayed response cannot replay old time after the stall');
  f.at(120_000);
  assert.equal(f.client.estServerTick(), 117, 'the bound advances only with authoritative progress');
});

test('explicit tab resync and a fresh welcome discard the old visual clock', t => {
  const f = clockFixture(t); f.connect(10_000);
  assert.equal(f.client.estServerTick(), 10_000, 'the welcome anchors time before the first snapshot');
  f.at(250); assert.equal(f.client.estServerTick(), 10_015);
  f.client.resync(); f.pong(10_002);
  assert.equal(f.client.estServerTick(), 10_002, 'tab resync may reset after interpolation history was cleared');
  f.at(10_000); f.connect(20);
  assert.equal(f.client.estServerTick(), 20, 'reconnecting to a different world cannot inherit the old high-water mark');
  f.at(10_100); f.pong(26);
  assert.equal(f.client.estServerTick(), 26);
});
