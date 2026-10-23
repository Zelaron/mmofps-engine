import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderProfile, workerJobRestMs } from '../src/render/device-profile.js';

function environment<T>(hostname: string | undefined, concurrency: number | undefined, action: () => T): T {
  const previous = new Map(['location', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    if (hostname === undefined) Reflect.deleteProperty(globalThis, 'location');
    else Object.defineProperty(globalThis, 'location', { configurable: true, value: { hostname, search: '' } });
    if (concurrency === undefined) Reflect.deleteProperty(globalThis, 'navigator');
    else Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { hardwareConcurrency: concurrency } });
    return action();
  } finally {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}

test('eligible loopback desktop sessions allow two paced workers without lowering visible quality', () => {
  const expected = { touch: false, nearChunks: 7, farRadius: 4800, fogFar: 4600,
    workers: 2, pixelBudget: 2_500_000, maxPixelRatio: 1.5 };
  for (const hostname of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]']) {
    environment(hostname, 16, () => assert.deepEqual(renderProfile(false), expected));
  }
});

test('remote hosts retain four-worker desktop quality and hostname matching is exact', () => {
  const expected = { touch: false, nearChunks: 7, farRadius: 4800, fogFar: 4600,
    workers: 4, pixelBudget: 2_500_000, maxPixelRatio: 1.5 };
  for (const hostname of ['game.example', 'localhost.example', 'notlocalhost', '127.0.0.1.example', '192.168.1.1', '2001:db8::1']) {
    environment(hostname, 16, () => assert.deepEqual(renderProfile(false), expected));
  }
});

test('local second worker requires at least twelve reported threads while remote reservation stays unchanged', () => {
  const cases = [[1, 1, 1], [2, 1, 1], [3, 1, 1], [4, 1, 2], [5, 1, 3], [6, 1, 4], [8, 1, 4],
    [11, 1, 4], [11.999, 1, 4], [12, 2, 4], [12.5, 2, 4], [16, 2, 4], [64, 2, 4]];
  for (const [concurrency, local, remote] of cases) {
    environment('localhost', concurrency, () => assert.equal(renderProfile(false).workers, local));
    environment('game.example', concurrency, () => assert.equal(renderProfile(false).workers, remote));
  }
  environment('game.example', 3.5, () => assert.equal(renderProfile(false).workers, 1));
});

test('touch quality stays unchanged while local hosts reserve CPU for simulation', () => {
  const expected = { touch: true, nearChunks: 5, farRadius: 2800, fogFar: 2500,
    workers: 2, pixelBudget: 1_000_000, maxPixelRatio: 1.25 };
  for (const hostname of ['localhost', 'game.example']) {
    for (const concurrency of [12, 16, 64])
      environment(hostname, concurrency, () => assert.deepEqual(renderProfile(true),
        { ...expected, workers: hostname === 'localhost' ? 1 : 2 }));
    environment(hostname, 2, () => assert.deepEqual(renderProfile(true), { ...expected, workers: 1 }));
  }
  environment('game.example', 4, () => assert.deepEqual(renderProfile(true), expected));
});

test('missing browser globals and invalid concurrency keep safe bounded defaults', () => {
  environment(undefined, undefined, () => {
    assert.equal(renderProfile().touch, false);
    assert.equal(renderProfile().workers, 4);
    assert.equal(renderProfile(false).workers, 4);
    assert.equal(renderProfile(true).workers, 2);
  });
  for (const concurrency of [undefined, NaN, Infinity, -Infinity, 0, -1]) {
    environment('localhost', concurrency, () => assert.equal(renderProfile(false).workers, 1));
    environment('game.example', concurrency, () => assert.equal(renderProfile(false).workers, 4));
  }
});

test('local background jobs rest proportionally while urgent coverage keeps its earlier bounded deadline', () => {
  environment('localhost', 16, () => {
    assert.equal(workerJobRestMs(40), 120);
    assert.equal(workerJobRestMs(.25), .75);
    assert.equal(workerJobRestMs(1000), 750);
    assert.equal(workerJobRestMs(40, true), 40);
    assert.equal(workerJobRestMs(.25, true), .25);
    assert.equal(workerJobRestMs(1000, true), 250);
    for (const invalid of [undefined, null, '100', NaN, Infinity, -Infinity, -1, 0]) {
      assert.equal(workerJobRestMs(invalid), 0);
      assert.equal(workerJobRestMs(invalid, true), 0);
    }
  });
  for (const hostname of ['game.example', undefined])
    environment(hostname, 16, () => {
      assert.equal(workerJobRestMs(1000), 0);
      assert.equal(workerJobRestMs(1000, true), 0);
    });
});
