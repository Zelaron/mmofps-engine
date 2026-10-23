import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CreatureState } from '@shared/wildlife';
import { incomingBossAttack } from '../src/boss-warning.js';

const boss = (id: number, impactTick: number): CreatureState => ({ id, species: 9, x: -600, y: 0, z: 0,
  yaw: 0, speed: 0, alert: true, rangedAttack: { originX: -600, originY: 8, originZ: 0,
    x: 0, y: 1, z: 0, radius: 9, fireTick: 90, impactTick } });

test('distant committed attacks warn the threatened player until they move clear or the attack ends', () => {
  const threat = boss(1, 180), point = { x: 0, y: 1.6, z: 0 };
  assert.equal(incomingBossAttack([threat], point, 100), threat);
  assert.equal(incomingBossAttack([threat], { ...point, x: 20 }, 100), undefined);
  assert.equal(incomingBossAttack([threat], point, 180), undefined);
  assert.equal(incomingBossAttack([{ ...threat, dead: true }], point, 100), undefined);
  assert.equal(incomingBossAttack([{ ...threat, rangedAttack: undefined }], point, 100), undefined);
});

test('earliest impact takes priority and the warning includes a nearby vehicle hull but not unrelated altitude', () => {
  const soon = boss(1, 160), later = boss(2, 200), point = { x: 0, y: 1, z: 0 };
  assert.equal(incomingBossAttack([later, soon], point, 100), soon);
  assert.equal(incomingBossAttack([soon], { ...point, x: 14 }, 100), undefined);
  assert.equal(incomingBossAttack([soon], { ...point, x: 14 }, 100, 4), soon);
  assert.equal(incomingBossAttack([soon], { ...point, y: 80 }, 100, 4), undefined);
});
