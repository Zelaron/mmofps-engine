import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameSections } from '../src/frame-sections.js';

test('only long frames are kept, with merged per-section milliseconds and the unmarked rest', () => {
  let now = 0;
  const sections = new FrameSections(34, 3, () => now);
  const frame = (parts: [string, number][], tail = 0) => {
    sections.begin();
    for (const [name, ms] of parts) { now += ms; sections.mark(name); }
    now += tail; sections.end();
  };
  frame([['predict', 2], ['render', 10]]);
  assert.deepEqual(sections.since(), [], 'ordinary frames leave no trace');
  frame([['predict', 1], ['terrain', 30], ['seams', 5], ['terrain', 8]], 2);
  const [long] = sections.since();
  assert.equal(long.ms, 46);
  assert.deepEqual(long.sections, { predict: 1, terrain: 38, seams: 5, rest: 2 });
  for (let i = 0; i < 4; i++) frame([['render', 40 + i]]);
  assert.equal(sections.since().length, 3, 'a bounded ring');
  assert.deepEqual(sections.since(long.at).map(f => f.ms), [41, 42, 43]);
});
