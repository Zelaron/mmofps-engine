import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Noise } from '@shared/noise';
import { mulberry32 } from '@shared/rng';

test('noise is deterministic across instances', () => {
  const a = new Noise(42);
  const b = new Noise(42);
  const rng = mulberry32(7);
  for (let i = 0; i < 500; i++) {
    const x = (rng() - 0.5) * 4000;
    const y = (rng() - 0.5) * 4000;
    const z = (rng() - 0.5) * 200;
    assert.equal(a.value2(x, y), b.value2(x, y));
    assert.equal(a.fbm2(x, y, 4), b.fbm2(x, y, 4));
    assert.equal(a.fbm3(x, z, y, 3), b.fbm3(x, z, y, 3));
    assert.equal(a.ridge2(x, y, 4), b.ridge2(x, y, 4));
  }
});

test('noise stays within bounds', () => {
  const n = new Noise(1337);
  const rng = mulberry32(3);
  for (let i = 0; i < 2000; i++) {
    const x = (rng() - 0.5) * 9000;
    const y = (rng() - 0.5) * 9000;
    const v2 = n.value2(x, y);
    assert.ok(v2 >= 0 && v2 <= 1, `value2 out of range: ${v2}`);
    const f2 = n.fbm2(x, y, 5);
    assert.ok(f2 >= -1.001 && f2 <= 1.001, `fbm2 out of range: ${f2}`);
    const r2 = n.ridge2(x, y, 4);
    assert.ok(r2 >= 0 && r2 <= 1.001, `ridge2 out of range: ${r2}`);
    const f3 = n.fbm3(x, y * 0.1, y, 3);
    assert.ok(f3 >= -1.001 && f3 <= 1.001, `fbm3 out of range: ${f3}`);
  }
});

test('different seeds produce different fields', () => {
  const a = new Noise(1);
  const b = new Noise(2);
  let differ = 0;
  for (let i = 0; i < 50; i++) {
    if (a.value2(i * 13.7, i * 7.3) !== b.value2(i * 13.7, i * 7.3)) differ++;
  }
  assert.ok(differ > 45);
});
