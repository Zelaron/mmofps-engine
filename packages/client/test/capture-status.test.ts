import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureStatus, type CaptureObserver } from '../src/capture-status.js';
import { CAPTURE_SECONDS, inCaptureRange, type Territory } from '@shared/frontier';

const observer: CaptureObserver = { x: 0, y: 10, z: 0, alive: true, onFoot: true };
const site = (changes: Partial<Territory> = {}): Territory => ({ id: 'test', name: 'Exchange', kind: 'city',
  x: 0, y: 10, z: 0, radius: 42, owner: 2, influence: 1, contested: false, captureRate: -1 / CAPTURE_SECONDS, ...changes });

test('capture HUD distinguishes neutralization, claiming and secured ownership with server timing', () => {
  const enemy = captureStatus(site(), 1, observer);
  assert.equal(enemy.phase, 'NEUTRALIZING'); assert.equal(enemy.progress, 0); assert.match(enemy.detail, /60s/);
  const halfway = captureStatus(site({ influence: .5 }), 1, observer);
  assert.equal(halfway.progress, 50); assert.match(halfway.detail, /30s/);
  const neutral = captureStatus(site({ influence: 0, owner: 0 }), 1, observer);
  assert.equal(neutral.phase, 'CAPTURING'); assert.equal(neutral.progress, 0);
  const claim = captureStatus(site({ influence: -.5, owner: 0, captureRate: -2 / CAPTURE_SECONDS }), 1, observer);
  assert.equal(claim.progress, 50); assert.match(claim.detail, /15s/);
  const secured = captureStatus(site({ influence: -1, owner: 1, captureRate: 0 }), 1, observer);
  assert.equal(secured.kind, 'secured'); assert.equal(secured.progress, 100);
  const mirrored = captureStatus(site({ influence: .5, owner: 0, captureRate: 1 / CAPTURE_SECONDS }), 2, observer);
  assert.equal(mirrored.phase, 'CAPTURING'); assert.equal(mirrored.progress, 50);
});

test('capture HUD explains contested, vehicle, height and neutral-player restrictions', () => {
  const contested = captureStatus(site({ contested: true, captureRate: 0 }), 1, observer);
  assert.equal(contested.kind, 'contested'); assert.match(contested.detail, /Clear enemy/); assert.doesNotMatch(contested.detail, /remaining/);
  assert.match(captureStatus(site(), 1, { ...observer, onFoot: false }).phase, /DISEMBARK/);
  const above = captureStatus(site(), 1, { ...observer, y: 18 });
  assert.match(above.phase, /FLAG LEVEL/); assert.match(above.detail, /8 m above the flag/);
  assert.match(captureStatus(site(), 1, { ...observer, y: 1 }).detail, /9 m below the flag/);
  assert.equal(captureStatus(site(), 1, { ...observer, y: 15 }).kind, 'capturing', 'within the band counts');
  assert.equal(captureStatus(site(), 0, observer).phase, 'AWAITING FACTION');
  assert.match(captureStatus(site(), 1, { ...observer, alive: false }).detail, /Respawn/);
});

test('on a sloped relay the whole ground in the ring counts for a player, and the HUD agrees with the server rule', () => {
  // Flag at 10 m on a hillside whose dry ground in the ring spans 4..30 m.
  const slope = site({ kind: 'relay', radius: 30, ground: [4, 30] });
  assert.equal(captureStatus(slope, 1, { ...observer, y: 30 }).kind, 'capturing', 'the top of the slope counts');
  assert.equal(captureStatus(slope, 1, { ...observer, y: 4 }).kind, 'capturing', 'the bottom of the slope counts');
  const roof = captureStatus(slope, 1, { ...observer, y: 40 });
  assert.equal(roof.phase, 'TOO HIGH TO CAPTURE'); assert.match(roof.detail, /4 m above the ground in this ring/);
  const cave = captureStatus(slope, 1, { ...observer, y: -5 });
  assert.equal(cave.phase, 'TOO LOW TO CAPTURE'); assert.match(cave.detail, /3 m below the ground/);
  for (let y = -20; y <= 60; y += .5) for (const s of [slope, site()]) {
    assert.equal(captureStatus(s, 1, { ...observer, y }).kind !== 'blocked', inCaptureRange(s, 0, y, 0, true), `height ${y}`);
  }
  assert.equal(inCaptureRange(slope, 0, 30, 0), false, 'bots keep the flag band');
  assert.equal(inCaptureRange(slope, 0, 15, 0), true, 'bots still count near the flag');
});

test('capture HUD gives distance to the zone boundary and does not invent timing for idle progress', () => {
  const outside = captureStatus(site(), 1, { ...observer, x: -100 });
  assert.equal(outside.kind, 'approach'); assert.match(outside.detail, /58 m E/);
  const idle = captureStatus(site({ owner: 0, influence: 0, captureRate: 0 }), 1, observer);
  assert.doesNotMatch(idle.detail, /remaining/);
});

test('three factions see neutralization, capture and enemy pressure from explicit control strength', () => {
  const enemy = site({ owner: 2, captureFaction: 2, captureProgress: .6, pressureFaction: 3, progressRate: -1 / 35 });
  const neutralizing = captureStatus(enemy, 3, observer);
  assert.equal(neutralizing.phase, 'NEUTRALIZING'); assert.equal(neutralizing.progress, 40);
  assert.match(neutralizing.detail, /21s/);
  assert.equal(captureStatus(enemy, 2, observer).phase, 'ENEMY CAPTURING');
  const claiming = captureStatus(site({ owner: 0, captureFaction: 3, captureProgress: .4, pressureFaction: 3, progressRate: 1 / 35 }), 3, observer);
  assert.equal(claiming.phase, 'CAPTURING'); assert.equal(claiming.progress, 40);
  const held = captureStatus(site({ owner: 3, captureFaction: 3, captureProgress: 1, pressureFaction: 0, progressRate: 0 }), 3, observer);
  assert.equal(held.phase, 'CONTROL POINT SECURED');
  // Majority capture: the faction that out-numbers the others keeps progressing
  // through a contested ring, and everyone else sees why they are losing it.
  const outnumbered = captureStatus({ ...enemy, contested: true }, 1, observer);
  assert.equal(outnumbered.kind, 'blocked'); assert.equal(outnumbered.phase, 'CONTESTED — OUTNUMBERED');
  const pushing = captureStatus({ ...enemy, contested: true }, 3, observer);
  assert.equal(pushing.kind, 'capturing'); assert.equal(pushing.phase, 'CONTESTED — YOU OUTNUMBER THEM'); assert.match(pushing.detail, /21s/);
  const stalemate = captureStatus({ ...enemy, contested: true, pressureFaction: 0, progressRate: 0 }, 1, observer);
  assert.equal(stalemate.kind, 'contested'); assert.equal(stalemate.phase, 'CONTESTED — STALEMATE');
  const holding = captureStatus(site({ owner: 3, captureFaction: 3, captureProgress: 1, pressureFaction: 3, progressRate: 0, contested: true }), 3, observer);
  assert.equal(holding.phase, 'CONTESTED — HOLDING');
});
