import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dailyLine } from '../src/progress-hud.js';

test('the HUD shows how many are done and the next order, or when new ones arrive', () => {
  const orders = [{ id: 'a', label: 'Eliminate 10 enemies', goal: 10, progress: 4, xp: 500, done: false },
    { id: 'b', label: 'Capture 2 control points', goal: 2, progress: 2, xp: 600, done: true },
    { id: 'c', label: 'Assist 4 eliminations', goal: 4, progress: 0, xp: 400, done: false }];
  assert.deepEqual(dailyLine({ orders, resetsIn: 5000 }), { count: 'DAILY 1/3', next: 'Eliminate 10 enemies · 4/10' });
  assert.deepEqual(dailyLine({ orders: orders.map(o => ({ ...o, done: true })), resetsIn: 3 * 3600 + 120 }),
    { count: 'DAILY 3/3', next: 'All done · new orders in 3h 02m' });
});

test('the war debrief card states the result, this soldier\'s war and its top soldier', async () => {
  const { debriefLines } = await import('../src/progress-hud.js');
  const lines = debriefLines({ war: 4, victor: 1, faction: 1, kills: 12, deaths: 5, captures: 2, xp: 3450,
    best: { name: 'Ace', faction: 2, kills: 31, you: false } });
  assert.equal(lines.title, 'WAR 4 DEBRIEF');
  assert.equal(lines.result, 'Victory with Terran Accord');
  assert.equal(lines.stats, `12 eliminations · 5 deaths (K/D 2.4) · 2 captures · +${(3450).toLocaleString()} XP`, 'formatted in the player locale');
  assert.equal(lines.best, 'Top soldier: Ace (Helix Combine) · 31 eliminations');
  const lost = debriefLines({ war: 5, victor: 3, faction: 2, kills: 0, deaths: 0, captures: 0, xp: 400, best: { name: 'You', faction: 2, kills: 9, you: true } });
  assert.equal(lost.result, 'Vanguard Pact won · Helix Combine fought on');
  assert.equal(lost.best, 'Top soldier of the war: you, with 9 eliminations');
});

test('DEPLOY NOW goes to the current order\'s staging unless the soldier chose a point', async () => {
  const { deployNowTarget } = await import('../src/respawn-status.js');
  const options = [
    { id: 'base-home', name: 'Home rally', x: 0, y: 0, z: 0, kind: 'base' as const, baseId: 'base-home', available: true },
    { id: 'air-1', name: 'Fighter jet', x: 0, y: 300, z: 0, kind: 'air' as const, available: true },
    { id: 'assault-ironhaven-0', name: 'Assault · Ironhaven', x: 4500, y: 0, z: 0, kind: 'base' as const, baseId: 'base-ironhaven', controlId: 'ironhaven-0', available: true },
    { id: 'base-quay', name: 'Quay rally', x: 3000, y: 0, z: 0, kind: 'base' as const, baseId: 'base-quay', available: false },
  ];
  const order = { baseId: 'base-ironhaven', targetId: 'ironhaven-0', name: 'Capture Ironhaven', x: 4600, z: 0,
    phase: 'attack' as const, squad: 0, staging: { x: 4500, y: 0, z: 0 } };
  assert.equal(deployNowTarget(options, null, order), 'assault-ironhaven-0', 'the hint "HOLD Q: DEPLOY NOW" means: to the fight');
  assert.equal(deployNowTarget(options, 'base-home', order), 'base-home', 'an explicit choice wins');
  assert.equal(deployNowTarget(options, 'base-quay', order), 'assault-ironhaven-0', 'an unavailable choice falls back');
  // Without a usable point at the order, the usable point nearest to it, never
  // an unavailable or airborne one, and only if it brings the soldier closer.
  const quayOrder = { ...order, baseId: 'base-quay', targetId: 'quay-1', x: 3000, z: 0 };
  assert.equal(deployNowTarget(options, null, quayOrder), 'assault-ironhaven-0');
  assert.equal(deployNowTarget(options, null, quayOrder, { x: -2000, z: 0 }), 'assault-ironhaven-0', '1.5 km from the order beats 5 km');
  assert.equal(deployNowTarget(options, null, quayOrder, { x: 3200, z: 300 }), undefined, 'already nearer than any point: no pointless deployment');
  assert.equal(deployNowTarget(options, null, order, { x: 4400, z: 0 }), 'assault-ironhaven-0', 'the order staging is always offered');
  assert.equal(deployNowTarget(options, null, undefined), 'base-home');
});
