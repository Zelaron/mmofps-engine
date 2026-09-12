import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RegionGrid } from '../src/regions.js';
import { WORLD } from '../src/constants.js';

test('region cells cover the connected surface with one owner at every seam', () => {
  const grid = new RegionGrid({ version: 2, xCuts: [-3000, 0, 3000], zCuts: [-4000, 1000], entry: { x: -10, z: -10 } });
  assert.equal(grid.at(-.001, 0).id, 'r1:1'); assert.equal(grid.at(0, 0).id, 'r2:1');
  assert.equal(grid.at(0, 1000).id, 'r2:2');
  assert.equal(grid.at(-WORLD.BORDER - 1, WORLD.BORDER + 1).id, 'r0:2');
  for (let x = -WORLD.BORDER; x < WORLD.BORDER; x += 271) for (let z = -WORLD.BORDER; z < WORLD.BORDER; z += 293) {
    const b = grid.at(x, z); assert.ok(x >= b.minX && x < b.maxX && z >= b.minZ && z < b.maxZ);
    assert.deepEqual(grid.get(b.id), b);
  }
  assert.equal(grid.get('r02:1'), null); assert.equal(grid.get('r4:1'), null); assert.equal(grid.get('world'), null);
});

test('region neighborhoods include touching cells and bounded views across narrow cells', () => {
  const grid = new RegionGrid({ version: 2, xCuts: [-512, 0, 512], zCuts: [-512, 0, 512], entry: { x: 0, z: 0 } });
  assert.equal(grid.neighbors('r1:1', 0).length, 8);
  assert.equal(grid.neighbors('r1:1', 600).length, 15);
  assert.equal(new RegionGrid().neighbors('world', 500).length, 0);
  assert.throws(() => grid.neighbors('r1:1', Infinity));
});

test('layout definitions reject overlaps, tiny cells and mutable external input', () => {
  const input = { version: 2, xCuts: [0], zCuts: [], entry: { x: 1, z: 1 } };
  const grid = new RegionGrid(input); input.xCuts[0] = 1000; input.entry.x = -1000;
  assert.equal(grid.at(1, 1).id, 'r1:0'); assert.equal(grid.layout.entry.x, 1);
  for (const cuts of [[0, 0], [10, 0], [0, 100], [WORLD.BORDER], [NaN]]) assert.throws(() => new RegionGrid({ ...input, xCuts: cuts }));
  assert.throws(() => grid.at(NaN, 0)); assert.equal(new RegionGrid().at(100, 100).id, 'world');
});
