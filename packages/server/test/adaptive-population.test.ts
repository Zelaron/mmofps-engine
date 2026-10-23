import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePopulation } from '../src/adaptive-population.js';

function telemetry(maximum = 192, initialDebt = 0) {
  const policy = new AdaptivePopulation(maximum);
  let nowMs = 0, workMs = 0, ticks = 0;
  policy.observe({ nowMs, workMs, ticks, debt: initialDebt, population: maximum });
  return { policy, sample(mean: number, debt = 0, milliseconds = 1000, progressedTicks = 60, population = policy.target) {
    nowMs += milliseconds; ticks += progressedTicks; workMs += mean * progressedTicks;
    return policy.observe({ nowMs, workMs, ticks, debt, population });
  } };
}

test('maximum, half-population floor and detached status preserve configured small worlds', () => {
  for (const [maximum, minimum] of [[192,96],[97,49],[64,48],[48,48],[12,12],[0,0]]) {
    const { policy, sample } = telemetry(maximum, 80);
    assert.equal(policy.status.minimum, minimum);
    for (let i = 0; i < 30; i++) sample(30, 80);
    assert.equal(policy.target, minimum);
    const status = policy.status; status.target = -1;
    assert.equal(policy.target, minimum);
  }
  for (const value of [-1, 1.5, NaN, Infinity]) assert.throws(() => new AdaptivePopulation(value), RangeError);
});

test('startup counters are baselined and a brief costly interval does not lower population', () => {
  const policy = new AdaptivePopulation();
  assert.equal(policy.observe({ nowMs: 5000, workMs: 900_000, ticks: 30_000, debt: 0, population: 192 }).changed, false);
  assert.equal(policy.observe({ nowMs: 6000, workMs: 901_080, ticks: 30_060, debt: 0, population: 192 }).changed, false);
  const recovered = policy.observe({ nowMs: 7000, workMs: 901_620, ticks: 30_120, debt: 0, population: 192 });
  assert.equal(recovered.target, 192);
  assert.equal(recovered.meanTickWorkMs, 9);
  assert.equal(recovered.heavyForMs, 0);
});

test('sustained work reduces by24 every2s, independent of observation batch count', () => {
  const { policy, sample } = telemetry();
  for (let i = 0; i < 39; i++) assert.equal(sample(17, 0, 50, 3).changed, false);
  const result = sample(17, 0, 50, 3);
  assert.equal(result.changed, true);
  assert.equal(result.reason, 'sustained-work');
  assert.equal(policy.target, 168);
  assert.equal(sample(17).changed, false);
  assert.equal(sample(17).target, 144);
});

test('sustained debt can shed load even when timed simulation work appears inexpensive', () => {
  const { policy, sample } = telemetry(192, 9);
  assert.equal(sample(10, 15).changed, false);
  const change = sample(10, 24);
  assert.equal(change.reason, 'sustained-debt');
  assert.equal(change.target, 168);
  assert.equal(policy.target, 168);
  const transient = telemetry();
  transient.sample(10, 25);
  transient.sample(10, 0);
  transient.sample(10, 25);
  assert.equal(transient.policy.target, 192, 'brief spikes cannot masquerade as sustained debt');
  const draining = telemetry(192, 40);
  for (const debt of [35,30,25,20,15,10]) draining.sample(10, debt);
  assert.equal(draining.policy.target, 192, 'a backlog already draining does not trigger debt-only retirement');
});

test('emergency debt acts after measured1s and no faster, but no-progress startup cannot trigger cuts', () => {
  const { sample } = telemetry(192, 60);
  assert.equal(sample(17, 65, 500, 25).changed, false);
  const first = sample(17, 70, 500, 25);
  assert.equal(first.reason, 'emergency-debt'); assert.equal(first.target, 168);
  assert.equal(sample(17, 80, 500, 25).changed, false);
  assert.equal(sample(17, 90, 500, 25).target, 144);
  const paused = telemetry(192, 80);
  for (let i = 0; i < 10; i++) assert.equal(paused.sample(0, 80, 1000, 0).changed, false);
  assert.equal(paused.policy.target, 192);
  assert.equal(paused.policy.status.reason, 'no-progress');
});

test('recovery needs20s continuously healthy, adds6 and cannot immediately oscillate', () => {
  const { policy, sample } = telemetry();
  sample(18); sample(18);
  assert.equal(policy.target, 168);
  for (let i = 0; i < 19; i++) assert.equal(sample(10).changed, false);
  const recovery = sample(10);
  assert.equal(recovery.reason, 'recovery'); assert.equal(recovery.target, 174);
  for (let i = 0; i < 19; i++) assert.equal(sample(10).changed, false);
  assert.equal(sample(10).target, 180);
  for (let i = 0; i < 80; i++) sample(10);
  assert.equal(policy.target, 192, 'recovery is capped at requested maximum');
});

test('debt, borderline work and outstanding protected population break recovery evidence', () => {
  const { policy, sample } = telemetry(); sample(18); sample(18);
  for (let i = 0; i < 19; i++) sample(10);
  sample(10, 3);
  assert.equal(policy.status.healthyForMs, 0);
  for (let i = 0; i < 19; i++) sample(10);
  assert.equal(policy.target, 168);
  sample(11.01);
  assert.equal(policy.status.healthyForMs, 0);
  for (let i = 0; i < 25; i++) sample(10, 0, 1000, 60, 180);
  assert.equal(policy.target, 168, 'target changes do not assume protected bots were actually removed');
});

test('counter/clock resets and invalid telemetry never manufacture low-load recovery or immediate cuts', () => {
  const { policy, sample } = telemetry(); sample(18); sample(18);
  assert.equal(policy.target, 168);
  let reset = policy.observe({ nowMs: 0, workMs: 0, ticks: 0, debt: 80, population: 168 });
  assert.equal(reset.changed, false); assert.equal(reset.reason, 'reset');
  reset = policy.observe({ nowMs: 1000, workMs: NaN, ticks: 60, debt: 0, population: 168 });
  assert.equal(reset.changed, false); assert.equal(reset.reason, 'reset');
  assert.equal(policy.observe({ nowMs: 2000, workMs: 1000, ticks: 120, debt: 0, population: 168 }).changed, false);
  assert.equal(policy.status.meanTickWorkMs, null);
  assert.equal(policy.target, 168);
});

test('a long pause or slow cheap clock cannot earn recovery time', () => {
  const { policy, sample } = telemetry(); sample(18); sample(18);
  const resumed = sample(10, 0, 20_000, 1);
  assert.equal(resumed.changed, false);
  assert.equal(resumed.healthyForMs, 0);
  for (let i = 0; i < 25; i++) sample(10, 0, 1000, 49);
  assert.equal(policy.target, 168);
  assert.equal(policy.status.healthyForMs, 0);
  for (let i = 0; i < 19; i++) sample(10, 0, 1000, 50);
  assert.equal(policy.target, 168);
  assert.equal(sample(10, 0, 1000, 50).target, 174, 'sustained normal progress restores eligibility');
});

test('weighted cumulative window uses actual progressed ticks rather than a presumed60Hz', () => {
  const { sample } = telemetry();
  sample(20, 0, 500, 20);
  const window = sample(10, 0, 500, 40);
  assert.equal(window.meanTickWorkMs, 800 / 60);
  assert.equal(window.sampledTicks, 60);
  assert.equal(window.heavyForMs, 0);
});

test('scripted54Hz overload cuts before120debt and stays within its authorized floor', () => {
  const { policy, sample } = telemetry();
  let debt = 0;
  const changes: { second: number; target: number; debt: number }[] = [];
  for (let second = 1; second <= 30; second++) {
    // Fixed capacity model, not a benchmark: reducing the requested actors
    // eventually restores60Hz while accumulated clock debt is drained.
    const mean = policy.target > 144 ? 17 : 10;
    const progressed = policy.target > 144 ? 54 : debt > 0 ? 63 : 60;
    debt = Math.max(0, debt + 60 - progressed);
    const update = sample(mean, debt, 1000, progressed);
    if (update.changed) changes.push({ second, target: update.target, debt });
    assert.ok(debt < 120);
    assert.ok(policy.target >= 96);
  }
  assert.deepEqual(changes.slice(0, 2), [{ second: 2, target: 168, debt: 12 }, { second: 4, target: 144, debt: 24 }]);
  assert.equal(debt, 0);
});
