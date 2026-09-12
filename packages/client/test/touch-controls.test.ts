import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN } from '@shared/index';
import { touchMoveBits } from '../src/touch-controls.js';

test('touch joystick supports independent directions, diagonals and a release dead zone', () => {
  assert.equal(touchMoveBits(0,0),0);
  assert.equal(touchMoveBits(0.18,-0.2),0);
  assert.equal(touchMoveBits(0,-1),BTN.FORWARD);
  assert.equal(touchMoveBits(-1,1),BTN.LEFT | BTN.BACK);
  assert.equal(touchMoveBits(1,-1),BTN.RIGHT | BTN.FORWARD);
  assert.equal(touchMoveBits(NaN,0),0);
});
