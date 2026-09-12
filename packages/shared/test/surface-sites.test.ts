import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, STRUCTURE_KIND } from '@shared/worldgen';

test('surface-only and runway-filtered queries retain canonical structure placements', () => {
  const world = new World(1337);
  const expected = world.collectStructures(-1024, 1024, -1024, 1024).sites;
  const fresh = new World(1337);
  assert.deepEqual(fresh.collectSurfaceSites(-1024, 1024, -1024, 1024), expected,
    'surface descriptors must match the full authoritative region query');
  assert.deepEqual(new World(1337).collectSurfaceSites(-1024, 1024, -1024, 1024, STRUCTURE_KIND.RUNWAY),
    expected.filter((site) => site.kind === STRUCTURE_KIND.RUNWAY),
    'cheap runway filtering must not invent or omit canonical runways');
});
