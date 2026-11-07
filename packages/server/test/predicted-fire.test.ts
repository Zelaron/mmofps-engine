import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BTN, ByteReader, Msg, TICK_DT, WEAPONS, World, decodeFire, decodeSnapshot,
  stepWeaponState, type InputCmd, type Snapshot, type WeaponState,
} from '@shared/index';
import { Game, type PlayerSink, type ServerPlayer } from '../src/game.js';
import { Prediction } from '../../client/src/prediction.js';

// The shooter hears only the shots its client predicts; a reconciliation
// replays pending commands silently. These tests keep the authority firing
// on exactly the commands the client predicted.

function command(seq: number, weapon: number, buttons: number = BTN.FIRE): InputCmd {
  return { seq, weapon, buttons, yaw: 0, pitch: 0.4, renderTick: 0, renderFrac: 0 };
}

function armed(game: Game, weapon: number, isBot = false, sink: PlayerSink | null = null): ServerPlayer {
  const p = game.addPlayer(isBot ? 'Bot' : 'Shooter', sink, isBot);
  p.weapon = weapon;
  p.fireCd = 0;
  p.ammo[weapon] = { magazine: WEAPONS[weapon].magazineSize, reserve: WEAPONS[weapon].reserveSize };
  return p;
}

function weaponTwin(p: ServerPlayer): WeaponState {
  return { weapon: p.weapon, fireCd: p.fireCd, reloadWeapon: p.reloadWeapon, reloadCd: p.reloadCd,
    reloadHeld: p.reloadHeld, ammo: p.ammo.map(a => ({ ...a })) };
}

test('a burst of human commands advances the handheld weapon one full tick per command', () => {
  const game = new Game(4401);
  const p = armed(game, 1);
  p.fireCd = 0.5;
  const twin = weaponTwin(p);
  for (let seq = 1; seq <= 3; seq++) {
    game.queueInput(p, command(seq, 1, 0));
    stepWeaponState(twin, 1, 0, TICK_DT);
  }
  game.step();
  assert.equal(p.lastProcessedSeq, 3, 'the whole burst is consumed in one tick');
  assert.equal(p.fireCd, twin.fireCd, 'each command spends the tick the client predicted for it');
});

test('a repeated command keeps a late human moving but only the late command fires', () => {
  const game = new Game(4402);
  const p = armed(game, 1);
  game.queueInput(p, command(1, 1));
  game.step();
  assert.equal(game.stats.shotsFired, 1);
  for (let seq = 2; seq <= 7; seq++) { game.queueInput(p, command(seq, 1)); game.step(); }
  assert.equal(game.stats.shotsFired, 1, 'the next round is one command away');
  const cooldown = p.fireCd, magazine = p.ammo[1].magazine;

  game.step();
  assert.equal(game.stats.shotsFired, 1, 'a repeated command does not fire');
  assert.equal(p.fireCd, cooldown, 'nor does it spend weapon time');
  assert.equal(p.ammo[1].magazine, magazine);

  game.queueInput(p, command(8, 1));
  game.step();
  assert.equal(game.stats.shotsFired, 2, 'the late command fires the round its client predicted');
});

test('sending human commands faster than the server clock cannot speed up the weapon', () => {
  const game = new Game(4403);
  const p = armed(game, 1);
  p.fireCd = 100; // a long timer measures the weapon time commands are allowed to spend
  let seq = 0;
  const ticks = 240;
  for (let tick = 0; tick < ticks; tick++) {
    for (let i = 0; i < 3; i++) game.queueInput(p, command(++seq, 1, 0));
    game.step();
  }
  assert.equal(p.lastProcessedSeq, seq, 'every command was still applied');
  const spent = (100 - p.fireCd) / TICK_DT;
  assert.ok(spent >= ticks - 1e-6 && spent <= ticks + 30 + 1e-6,
    `a tripled command stream spent ${spent.toFixed(1)} weapon ticks in ${ticks} server ticks`);
});

test('a client that catches up after stalled frames keeps full weapon time for every command', () => {
  const game = new Game(4406);
  const p = armed(game, 1);
  p.fireCd = 1000;
  let seq = 0;
  const send = (n: number) => { for (let i = 0; i < n; i++) game.queueInput(p, command(++seq, 1, 0)); };
  for (let hitch = 0; hitch < 4; hitch++) {
    // A 33-tick frame sends only three commands; the client then predicts at
    // 1.5x until its 30 missed ticks are made up, then runs normally.
    for (let t = 0; t < 33; t++) game.step();
    send(3);
    for (let t = 0; t < 120; t++) { send(t < 60 ? 1 + t % 2 : 1); game.step(); }
  }
  // A growing round trip then raises the client's lead by ten ticks.
  for (let t = 0; t < 10; t++) { send(2); game.step(); }
  assert.equal(p.lastProcessedSeq, seq);
  assert.ok(Math.abs((1000 - p.fireCd) / TICK_DT - seq) < 1e-6, 'no catch-up command lost weapon time');
});

test('bots keep firing through a repeated thought', () => {
  const game = new Game(4404);
  const bot = armed(game, 1, true);
  bot.lastCmd = command(1, 1);
  game.step();
  assert.equal(game.stats.shotsFired, 1, 'a distant bot reuses its last thought instead of thinking every tick');
});

/** Real authority and real client prediction joined by a jittery uplink and a
 * delayed downlink. Returns the commands that fired on each side. */
function predictedAndAuthoritativeShots(weapon: number, uplink: readonly number[]) {
  const seed = 4405;
  const game = new Game(seed);
  const out: Uint8Array[] = [];
  const p = armed(game, weapon, false, { send: bytes => out.push(bytes) });
  p.fireCd = 0.5;
  const pred = new Prediction(new World(seed));
  const predicted: number[] = [], authoritative: number[] = [];
  const inFlight: InputCmd[] = [], downlink: { at: number; snap: Snapshot }[] = [];
  let seq = 0;
  const firingTicks = 520, totalTicks = firingTicks + 30;
  for (let tick = 0; tick < totalTicks; tick++) {
    while (downlink.length && downlink[0].at <= tick) pred.onSnapshot(downlink.shift()!.snap);
    if (pred.initialized && tick < firingTicks) {
      const cmd = command(++seq, weapon);
      if (pred.applyLocal(cmd).weapon.firedWeapon >= 0) predicted.push(cmd.seq);
      inFlight.push(cmd);
    }
    const arriving = tick < firingTicks ? uplink[tick % uplink.length] : 3;
    for (let n = 0; n < arriving && inFlight.length; n++) game.queueInput(p, inFlight.shift()!);
    game.step();
    for (const bytes of out) {
      const r = new ByteReader(bytes);
      const type = r.u8();
      if (type === Msg.SSnapshot) downlink.push({ at: tick + 3, snap: decodeSnapshot(r) });
      else if (type === Msg.SFire) {
        const ev = decodeFire(r);
        if (ev.shooter === p.id && ev.weapon < 200) authoritative.push(ev.seq);
      }
    }
    out.length = 0;
  }
  assert.equal(inFlight.length, 0);
  return { predicted, authoritative, reloads: p.ammo[weapon].reserve < WEAPONS[weapon].reserveSize };
}

// Averages one command per tick, with late commands (repeat ticks) followed
// by bursts of two or three.
const JITTER = [1, 1, 0, 2, 1, 0, 0, 3, 1, 1, 2, 0, 1, 1];

test('the shooter predicts exactly the shots the authority fires through input jitter', () => {
  // The Pulse Rifle's 1.8 s reload and the Flechette's 0.2 s interval end
  // exactly on a tick boundary, so they also need exact replicated timers.
  for (const weapon of [1, 8]) {
    const { predicted, authoritative, reloads } = predictedAndAuthoritativeShots(weapon, JITTER);
    assert.ok(reloads, `${WEAPONS[weapon].name} reloaded during the run`);
    assert.ok(authoritative.length > 25);
    assert.deepEqual(predicted, authoritative,
      `${WEAPONS[weapon].name}: every authoritative shot was predicted (and heard) exactly once`);
  }
});
