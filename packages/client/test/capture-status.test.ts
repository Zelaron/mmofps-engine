import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureStatus, type CaptureObserver } from '../src/capture-status.js';
import { CAPTURE_SECONDS, type Territory } from '@shared/frontier';

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
  assert.match(captureStatus(site(), 1, { ...observer, y: 18 }).phase, /FLAG LEVEL/);
  assert.equal(captureStatus(site(), 0, observer).phase, 'AWAITING FACTION');
  assert.match(captureStatus(site(), 1, { ...observer, alive: false }).detail, /Respawn/);
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
  assert.equal(captureStatus({ ...enemy, contested: true }, 1, observer).kind, 'contested');
});
