import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ShaderPreparation } from '../src/render/shader-preparation.js';

test('first draw waits for compilation and for variants added while the first batch was pending', () => {
  let submissions = 0, ready = false;
  const gate = new ShaderPreparation(() => { if (++submissions === 2) ready = false; }, () => ready);
  assert.equal(gate.poll(), false);
  assert.equal(gate.poll(), false);
  assert.equal(submissions, 1, 'pending work is polled without resubmitting it each frame');
  ready = true;
  assert.equal(gate.poll(), false, 'a newly submitted variant must also finish');
  ready = true;
  assert.equal(gate.poll(), true);
  assert.equal(gate.pending, false);
  const settled = submissions;
  assert.equal(gate.poll(), true); assert.equal(submissions, settled);
});

test('a new world supersedes pending preparation and synchronous completion has no extra frame delay', () => {
  let submissions = 0, ready = false;
  const gate = new ShaderPreparation(() => { submissions++; }, () => ready);
  assert.equal(gate.poll(), false);
  gate.invalidate();
  assert.equal(gate.poll(), false); assert.equal(submissions, 2);
  ready = true;
  assert.equal(gate.poll(), true);
  gate.invalidate();
  const before = submissions;
  assert.equal(gate.poll(), true); assert.equal(submissions, before + 1);
});

test('invalidation during a submission cannot present the superseded world', () => {
  let first = true;
  const gate = new ShaderPreparation(() => { if (first) { first = false; gate.invalidate(); } }, () => true);
  assert.equal(gate.poll(), false);
  assert.equal(gate.pending, true);
  assert.equal(gate.poll(), true);
});
