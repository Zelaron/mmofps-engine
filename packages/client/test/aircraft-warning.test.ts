import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aircraftWarningView, AircraftWarningCadence } from '../src/aircraft-warning.js';

test('cockpit warnings distinguish tracking, lock and inbound missiles with airframe-relative directions', () => {
  const tracking = aircraftWarningView({stage:1,bearing:-Math.PI/2,eta:0},0);
  assert.equal(tracking.title,'RADAR TRACKING YOU');
  assert.match(tracking.detail,/3 O'CLOCK.*RIGHT/);assert.ok(tracking.pan>0);
  const locked = aircraftWarningView({stage:2,bearing:0,eta:0},Math.PI/2);
  assert.equal(locked.title,'ENEMY MISSILE LOCK');assert.match(locked.detail,/3 O'CLOCK/);
  const behind = aircraftWarningView({stage:3,bearing:Math.PI,eta:2.2},0);
  assert.equal(behind.title,'MISSILE INCOMING');assert.match(behind.detail,/6 O'CLOCK.*BEHIND.*~3s/);
  assert.match(behind.instruction,/BANK.*PULL UP/);
  const left = aircraftWarningView({stage:3,bearing:Math.PI/2,eta:.6},0);
  assert.match(left.detail,/9 O'CLOCK.*LEFT.*IMPACT IMMINENT/);assert.ok(left.pan<0);
});

test('warning cadence escalates immediately, repeats urgently and resets when the threat disappears', () => {
  const cadence=new AircraftWarningCadence();
  assert.equal(cadence.pulse({stage:1,bearing:0,eta:0},0),true);
  assert.equal(cadence.pulse({stage:1,bearing:0,eta:0},.1),false);
  assert.equal(cadence.pulse({stage:2,bearing:0,eta:0},.2),true);
  assert.equal(cadence.pulse({stage:3,bearing:0,eta:1},.3),true);
  assert.equal(cadence.pulse({stage:3,bearing:0,eta:.8},.4),false);
  assert.equal(cadence.pulse({stage:3,bearing:0,eta:.6},.61),true);
  assert.equal(cadence.pulse(undefined,.62),false);
  assert.equal(cadence.pulse({stage:1,bearing:0,eta:0},.63),true);
});
