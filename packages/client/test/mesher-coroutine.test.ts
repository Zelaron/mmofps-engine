import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { meshColumnWithPortals, meshColumnWithPortalsSteps } from '../src/render/surfacenets.js';
import { bundleHash, mesherFixture } from './fixtures/mesher-coroutine.js';

// Captured from the pre-coroutine implementation. Hashes cover every byte of
// every output array, metadata and the ordered field/material query sequence.
const fixtures = [
  ['surface-1', false, false, 1,
    '4936198be445a63db9c128d35d8689ad6c91932bb67a101e9c3ecbbe2e00ca5e',
    'fd428d0295da55d4390347283e41ef4578c77974c6e09dfa8731926f3d98e238'],
  ['cave-1', true, false, 1,
    'a21f520453282cce416ddd4b4561e9fa882a56578951528dd739cb75f1695392',
    '46f9e034ecef14ffe605402323a2ab64ebe289cf96d490065fa9637170479605'],
  ['cave-4', true, false, 4,
    'd7e47adc70df114f7581de92732f28c6574ac96a1d9d74a3bc2cf75be2831f2d',
    '1dfef2fbc24c6ab61709c8020abb7239152acb20b5ea265802f2c759a08d03a3'],
  ['foundations-4', true, true, 4,
    'e6f36267956d106f3de686ee53b7c5e5c89494420ce97f0721d37e3c60d1b6de',
    '19882e2b811a30a0950502859f1d6aada9b8d9a7fd4915328c0e0df8072d7428'],
  ['foundations-16', false, true, 16,
    'c2789a8129d17a7d02443a97dd1dbcb3e5173a6ee9b21b91c986bf31b61c39d5',
    'd09093595f89fc20ff37bad4c04c429f076a72a8def54d5eb613e4f4ce6dc129'],
  ['city-16', false, true, 16,
    'a404ce160c636a52471898b8b7d3334581a013cd8aad97a1f984eb5f69dc74de',
    '6593112448bae55eeb86c715097fbc186d56ccdef8a30a8cbbdf0ae11c160461'],
] as const;

for (const [name, cave, foundations, step, expectedMesh, expectedQueries] of fixtures) {
  test(`mesher coroutine preserves frozen ${name} buffers and query order`, () => {
    const incremental = mesherFixture(cave, foundations, name === 'city-16'),
      synchronous = mesherFixture(cave, foundations, name === 'city-16');
    const steps = meshColumnWithPortalsSteps(incremental.world, 0, 0, cave, step);
    assert.equal(incremental.calls.column, 0, 'creating work must not perform the cold query');
    let result = steps.next(), pauses = 0;
    while (!result.done) {
      assert.equal(result.value, undefined, 'partial meshes must never be published');
      const before = { ...incremental.calls };
      result = steps.next();
      assert.ok(incremental.calls.sdf - before.sdf <= 35 * 35,
        'one step must not sample a complete 35-cubed slab');
      assert.ok(incremental.calls.material - before.material <= 68,
        'face construction must yield within each row');
      pauses++;
    }
    assert.ok(pauses > 100, 'the caller can interleave work inside the mesh, not only after completion');
    assert.equal(bundleHash(result.value), expectedMesh);
    assert.equal(incremental.queryHash(), expectedQueries);
    const direct = meshColumnWithPortals(synchronous.world, 0, 0, cave, step);
    assert.deepEqual(direct, result.value);
    assert.equal(synchronous.queryHash(), expectedQueries);
    assert.deepEqual(steps.next(), { value: undefined, done: true });
  });
}

test('closing paused meshing abandons remaining computation without publishing buffers', () => {
  const fixture = mesherFixture(true, true);
  const steps = meshColumnWithPortalsSteps(fixture.world, 0, 0, true, 4);
  assert.equal(steps.next().done, false);
  assert.equal(steps.next().done, false);
  assert.equal(fixture.calls.column, 8, 'first footprint work is bounded before another checkpoint');
  const before = { ...fixture.calls };
  steps.return(undefined as never);
  assert.deepEqual(steps.next(), { value: undefined, done: true });
  assert.deepEqual(fixture.calls, before, 'cancellation cannot continue field or packing work');
});

test('interleaving native surface and cave iterators preserves every final mesh byte on a shared World', () => {
  const specs = [
    { cx: -16, cz: -43, cave: true, step: 4 },
    { cx: -15, cz: -44, cave: false, step: 4 },
  ];
  const directWorld = new World(1337), interleavedWorld = new World(1337);
  const expected = specs.map(s => bundleHash(meshColumnWithPortals(directWorld, s.cx, s.cz, s.cave, s.step)));
  const jobs = specs.map(s => meshColumnWithPortalsSteps(interleavedWorld, s.cx, s.cz, s.cave, s.step));
  const completed = new Map<number, string>();
  // Each iterator retains sampled columns, region references and its own
  // in-progress slab while another native job churns the same World caches.
  for (let round = 0; completed.size < jobs.length; round++) {
    assert.ok(round < 100_000, 'bounded native interleaving');
    for (const i of round % 2 ? [1, 0] : [0, 1]) {
      if (completed.has(i)) continue;
      for (let step = 0; step < 7 + i * 6; step++) {
        const result = jobs[i].next();
        if (result.done) { completed.set(i, bundleHash(result.value)); break; }
      }
    }
  }
  assert.deepEqual(specs.map((_, i) => completed.get(i)), expected);
});
