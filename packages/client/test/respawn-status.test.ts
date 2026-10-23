import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseControlStatus, localCampaignBase, orderedReinforcements, reinforcementStatus, respawnStatus } from '../src/respawn-status.js';
import type { CampaignBase, FrontierState, Territory } from '@shared/frontier';

const state: NonNullable<FrontierState['respawn']> = { remaining: 10, selected: 'port', options: [
  { id: 'port', name: 'West Quay', x: -100, y: 8, z: 50, kind: 'base' },
  { id: 'convoy', name: 'Forward Carrier', x: 150, y: 12, z: 200, kind: 'mobile' },
] };

test('respawn countdown follows server timing without deploying early on the client', () => {
  assert.equal(respawnStatus(state, 1.7).remaining, 8.3);
  assert.equal(respawnStatus(state, 15).remaining, 0);
  assert.equal(respawnStatus({ ...state, remaining: 6 }, 0).remaining, 6);
  assert.equal(respawnStatus(state).selected?.name, 'West Quay');
  assert.match(respawnStatus({ ...state, selected: 'convoy' }).detail, /Forward Carrier/);
});

test('lost bases and destroyed mobile spawns fall back to automatic deployment', () => {
  const removed = respawnStatus({ ...state, options: state.options.slice(1) });
  assert.equal(removed.selected, null);
  assert.match(removed.detail, /automatically/);
  assert.equal(respawnStatus({ ...state, selected: null }).selected, null);
  assert.match(respawnStatus({ ...state, options: [] }).detail, /safe deployment/);
});

test('campaign UI counts a base surrounding controls and explains the spawn unlock', () => {
  const base: CampaignBase = { id: 'base', name: 'Port', kind: 'harbor', x: 0, y: 10, z: 0,
    owner: 2, homeFaction: 2, controlIds: ['a', 'b', 'c'], requiredPoints: 2 };
  const territories: Territory[] = ['a', 'b', 'c', 'unrelated'].map((id, index) => ({ id, name: id,
    kind: 'relay', x: index * 20, y: 10, z: 0, radius: 20, owner: index === 2 ? 2 : 1, influence: 0, contested: false }));
  const attack = baseControlStatus(base, territories, 1);
  assert.equal(attack.held, 2); assert.equal(attack.total, 3); assert.equal(attack.required, 2);
  assert.match(attack.detail, /2\/3 controls.*Securing base ownership/);
  assert.match(baseControlStatus({ ...base, owner: 1 }, territories, 1).detail, /Reinforcements available/);
  assert.equal(baseControlStatus(base, territories, 0).held, 0);
  const partial = baseControlStatus(base, territories.map(site => site.id === 'b' ? { ...site, owner: 2 } : site), 1);
  assert.equal(partial.kind, 'partial'); assert.match(partial.detail, /1\/3 controls.*Capture 1 more.*2 of 3 controls/);
  const threatened = baseControlStatus({ ...base, owner: 1 }, territories, 1,
    { ...state.options[0], available: false, reason: 'Enemy troops near the rally.' });
  assert.equal(threatened.kind, 'threatened'); assert.match(threatened.detail, /Base secured, rally unavailable.*Enemy troops/);
});

test('living reinforcements describe a remembered preference rather than immediate deployment', () => {
  const status = reinforcementStatus(state, true);
  assert.equal(status.selected?.id, 'port'); assert.match(status.detail, /Next respawn: West Quay/);
  assert.match(status.detail, /does not move you now/); assert.doesNotMatch(status.detail, /Deploying near/);
  const blocked = { ...state, options: state.options.map(option => option.id === 'port'
    ? { ...option, available: false, reason: 'Rally under attack.' } : option) };
  assert.equal(respawnStatus(blocked).selected, null);
  assert.match(respawnStatus(blocked).detail, /Rally under attack.*safe fallback.*preference is remembered/);
  assert.match(reinforcementStatus(blocked, true).detail, /Rally under attack/);
});

test('the control being captured prioritizes its city over a closer forward base center', () => {
  const city: CampaignBase = { id: 'city', name: 'Meridian', kind: 'city', x: 0, y: 0, z: 0, owner: 0, homeFaction: 0,
    controlIds: ['west', 'center', 'east'], requiredPoints: 2 };
  const forward: CampaignBase = { ...city, id: 'forward', name: 'Forward Base', kind: 'outpost', x: 380, controlIds: ['forward-control'], owner: 1 };
  const controls: Territory[] = [
    { id: 'west', baseId: 'city', name: 'City west', kind: 'city', x: 400, y: 0, z: 0, radius: 40, owner: 1, influence: 1, contested: false },
    { id: 'forward-control', baseId: 'forward', name: 'Forward control', kind: 'relay', x: 800, y: 0, z: 0, radius: 40, owner: 1, influence: 1, contested: false },
  ];
  assert.equal(localCampaignBase([city, forward], 400, 0, controls)?.id, 'city');
  const sorted = orderedReinforcements([
    { ...state.options[0], id: 'forward', baseId: 'forward', x: 380, z: 0, available: true },
    { ...state.options[0], id: 'city', baseId: 'city', x: 0, z: 0, available: false, reason: 'Capture 2 of 3 controls.' },
  ], [city, forward], 400, 0, controls);
  assert.equal(sorted[0].id, 'city'); assert.equal(sorted[0].available, false);
});
