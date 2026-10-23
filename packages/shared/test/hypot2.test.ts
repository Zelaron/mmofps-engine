import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hypot2 } from '@shared/math';

test('numeric hypot2 preserves zero signs, nonfinite precedence and extreme finite scaling', () => {
  const values = [0, -0, Number.MIN_VALUE, -Number.MIN_VALUE, Number.MIN_VALUE * 2,
    2 ** -1022, -(2 ** -1022), Number.MAX_VALUE, -Number.MAX_VALUE,
    Number.MAX_SAFE_INTEGER, 1, -1, 1 + Number.EPSILON, 1 - Number.EPSILON,
    1e-150, -1e-150, 1e150, -1e150, Infinity, -Infinity, NaN];
  for (const x of values) for (const y of values) {
    assert.ok(Object.is(hypot2(x, y), Math.hypot(x, y)), `hypot2(${x}, ${y})`);
  }
  assert.ok(Object.is(hypot2(-0, -0), 0));
  assert.equal(hypot2(NaN, -Infinity), Infinity);
  assert.equal(hypot2(Infinity, NaN), Infinity);
  assert.ok(Number.isFinite(hypot2(1e308, 1e308)), 'squaring finite large inputs must not overflow prematurely');
  assert.notEqual(hypot2(1e-300, 1e-300), 0, 'squaring tiny inputs must not underflow prematurely');
});

test('numeric hypot2 matches native ordered arithmetic across binary64 exponents and mantissas', () => {
  const compare = (x: number, y: number) =>
    assert.ok(Object.is(hypot2(x, y), Math.hypot(x, y)), `hypot2(${x}, ${y})`);
  for (let exponent = -1074; exponent <= 1023; exponent++) {
    const x = 2 ** exponent;
    compare(x, x); compare(x, x * (1 + Number.EPSILON));
    compare(x, x * (1 - Number.EPSILON)); compare(-x, x);
  }
  let state = 0x43fdc923;
  const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
  const view = new DataView(new ArrayBuffer(8));
  const random = () => {
    view.setUint32(0, next(), true); view.setUint32(4, next(), true);
    return view.getFloat64(0, true);
  };
  for (let i = 0; i < 20_000; i++) compare(random(), random());
});
