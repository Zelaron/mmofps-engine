import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator, OwnershipError, NODE_TIMEOUT_MS } from '../src/coordinator.js';
import { SimulationClock } from '../src/planet-clock.js';
import { advanceSynchronizedTicks, SimulationOverload } from '../src/tick-loop.js';
import type { SavedPlayer } from '../src/persistence.js';

const registration = (id = 'meridian:one') => ({ id, planet: 'meridian' as const, url: 'ws://127.0.0.1:1234/ws', capacity: 4, humans: 0, tick: 0 });
const errorCode = (code: string) => (error: unknown) => error instanceof OwnershipError && error.code === code;

test('tick wakeup deadlines retain phase and respect a backwards clock hold', () => {
  let now = 100;
  const clock = new SimulationClock(() => now);
  assert.throws(() => clock.millisecondsUntil(1), /not been synchronized/);
  clock.observe(6000.25, now);
  assert.equal(clock.target(), 6000);
  assert.ok(Math.abs(clock.millisecondsUntil(6001) - 12.5) < 1e-8);
  now += 8;
  assert.ok(Math.abs(clock.millisecondsUntil(6001) - 4.5) < 1e-8);
  now += 5;
  assert.equal(clock.target(), 6001); assert.equal(clock.millisecondsUntil(6001), 0);
  clock.observe(5995, now);
  assert.equal(clock.target(), 6001, 'correction cannot rewind already observed time');
  assert.ok(Math.abs(clock.millisecondsUntil(6002) - 7 / .06) < 1e-8, 'future deadlines include the hold interval');
  assert.equal(clock.millisecondsUntil(6000), 0, 'already issued ticks stay available during a hold');
  for (const tick of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => clock.millisecondsUntil(tick), /deadline/);
});

test('shared clock samples converge across worker monotonic origins and never rewind', () => {
  let a = 1010, b = 70;
  const first = new SimulationClock(() => a), second = new SimulationClock(() => b);
  assert.throws(() => first.target(), /not been synchronized/);
  first.observe(6000, 990); second.observe(6000, 50);
  assert.equal(first.target(), second.target()); assert.equal(first.uncertaintyMs, 10);
  a += 1000; b += 1000;
  assert.equal(first.target(), 6060); assert.equal(first.target(), second.target());
  first.observe(6050, a); assert.equal(first.target(), 6060, 'backward correction holds the clock');
  a += 1000; assert.equal(first.target(), 6110, 'the corrected clock eventually catches up');
  for (const value of [-1, NaN, Infinity]) assert.throws(() => first.observe(value, a));
  assert.throws(() => first.observe(1, a + 1, a));
});

test('bounded catch-up retains every tick of debt while yielding to network work', () => {
  let tick = 1000, wall = 0, target = 1009;
  const simulated: number[] = [];
  const step = () => { simulated.push(++tick); return true; };
  assert.equal(advanceSynchronizedTicks(() => tick, () => target, step, () => wall), 5);
  assert.equal(tick, 1004);
  assert.equal(advanceSynchronizedTicks(() => tick, () => target, () => { wall += 20; return step(); }, () => wall), 4);
  assert.equal(tick, 1005, 'one expensive step yields without deleting four owed ticks');
  assert.equal(advanceSynchronizedTicks(() => tick, () => target, () => false, () => wall), 4);
  assert.equal(tick, 1005, 'paused authority consumes no simulation time');
  advanceSynchronizedTicks(() => tick, () => target, step, () => wall);
  assert.deepEqual(simulated, Array.from({ length: 9 }, (_, i) => 1001 + i));
  target = tick + 301;
  assert.throws(() => advanceSynchronizedTicks(() => tick, () => target, step), SimulationOverload);
  assert.equal(tick, 1009, 'unrecoverable overload does not skip any live actor physics');
});

test('host wall time changes cannot shorten authority or jump a running planetary clock', () => {
  let wall = 100_000, mono = 100;
  const c = new Coordinator(':memory:', () => wall, () => mono);
  try {
    const first = c.register(registration());
    mono += 1000; wall += 365 * 24 * 3600 * 1000;
    assert.throws(() => c.register(registration('meridian:other')), errorCode('busy'));
    const second = c.register({ ...registration(), epoch: first.epoch });
    assert.equal(second.epoch, first.epoch); assert.equal(second.clockTick - first.clockTick, 60);
    mono += 1000; wall -= 2 * 365 * 24 * 3600 * 1000;
    const third = c.register({ ...registration(), epoch: first.epoch });
    assert.equal(third.clockTick - second.clockTick, 60);
    assert.throws(() => c.register({ ...registration(), humans: 5 }), errorCode('invalid'));
    assert.throws(() => c.register({ ...registration(), tick: .5 }), errorCode('invalid'));
  } finally { c.close(); }
});

test('durable authority survives coordinator restart and fences a retired world even while its character lease lives', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-clock-'));
  const file = path.join(root, 'universe.sqlite');
  let wall = 100_000, mono = 0;
  let c = new Coordinator(file, () => wall, () => mono);
  const key = 'a'.repeat(64);
  const state: SavedPlayer = { version: 1, seed: 1337, savedAt: wall, faction: 1, salvage: 137,
    discoveries: [], x: 0, y: 30, z: 0, health: 77, alive: true, frags: 2, deaths: 1,
    factionWait: 0, combatWait: 0, ammo: [{ magazine: 7, reserve: 81 }] };
  try {
    const first = c.register(registration());
    const holder = 'meridian:one:character', character = c.claim(key, 'meridian', holder, 'meridian:one', state);
    const row = { key, holder, epoch: character.epoch, state };
    c.close(); wall -= 60_000; mono += 250;
    c = new Coordinator(file, () => wall, () => mono);
    assert.equal(c.route('meridian')!.epoch, first.epoch);
    assert.throws(() => c.register(registration('meridian:two')), errorCode('busy'), 'restart cannot forget an outstanding world lease');
    const renewed = c.register({ ...registration(), epoch: first.epoch });
    assert.ok(renewed.clockTick >= first.clockTick + NODE_TIMEOUT_MS * 60 / 1000, 'recovered time is beyond every issued simulation horizon');
    mono += NODE_TIMEOUT_MS + 1;
    const next = c.register(registration('meridian:two'));
    assert.ok(next.epoch > first.epoch);
    assert.ok(c.locate(key)!.leaseUntil > c.route('meridian')!.leaseUntil - NODE_TIMEOUT_MS, 'old character lease has not expired');
    assert.deepEqual(c.checkpoint([{ ...row, state: { ...state, salvage: 999 } }]).accepted, []);
    assert.equal(c.release(row), false);
    assert.throws(() => c.construct(row, 'a'.repeat(32), { type: 0, x: 500, y: 30, z: 500, facing: 0 }), errorCode('fenced'));
    assert.throws(() => c.register({ ...registration(), epoch: first.epoch }), errorCode('fenced'));
    assert.equal(c.unregister('meridian:one', first.epoch), false);
    assert.equal(c.locate(key)!.state!.salvage, 137);
    const recovered = c.claim(key, 'meridian', 'meridian:two:character', 'meridian:two');
    assert.equal(recovered.entityId, character.entityId); assert.ok(recovered.epoch > character.epoch);
    c.unregister('meridian:two', next.epoch); mono += NODE_TIMEOUT_MS + 1;
    assert.throws(() => c.register(registration()), errorCode('fenced'), 'a delayed initial registration cannot resurrect a retired process');
  } finally {
    c.close(); assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('the-mmofps-clock-'));
    await rm(root, { recursive: true, force: true });
  }
});


test('expired incarnations cannot renew with an old epoch or occupy a replacement world capacity', () => {
  let now = 100_000;
  const c = new Coordinator(':memory:', () => now);
  try {
    const first = c.register({ ...registration(), capacity: 1 });
    c.claim('a'.repeat(64), 'meridian', 'meridian:one:old', 'meridian:one');
    now += NODE_TIMEOUT_MS + 1;
    assert.throws(() => c.register({ ...registration(), epoch: first.epoch }), errorCode('fenced'));
    const next = c.register({ ...registration('meridian:two'), capacity: 1 });
    assert.ok(next.epoch > first.epoch);
    assert.ok(c.claim('b'.repeat(64), 'meridian', 'meridian:two:new', 'meridian:two'));
    assert.throws(() => c.claim('c'.repeat(64), 'meridian', 'meridian:two:extra', 'meridian:two'), errorCode('full'));
  } finally { c.close(); }
});
