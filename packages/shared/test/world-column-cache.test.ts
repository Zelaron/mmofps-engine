import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, type ColumnData } from '@shared/worldgen';
import { mulberry32 } from '@shared/rng';

test('simulation column reuse leaves injected mutable terrain live', () => {
  const world = new World(1337);
  const generated = world.sampleColumn(1.25, 2.5);
  assert.equal(world.sampleColumn(1.25, 2.5), generated);
  let height = 12;
  world.column = () => ({ h: height, temp: .5, moist: .5, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 });
  assert.equal(world.sampleColumn(1.25, 2.5).h, 12);
  height = 18;
  assert.equal(world.sampleColumn(1.25, 2.5).h, 18);
});

test('public terrain queries reflect mutable generators even after collision columns were cached', () => {
  const world = new World(1337), x = 1.25, z = 2.5;
  let height = 12;
  world.column = () => ({ h: height, temp: .5, moist: .5, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: 20 });
  const internals = world as unknown as {
    cachedColumn(x: number, z: number): ColumnData;
    terrainSdf(x: number, y: number, z: number): number;
    terrainGroundY(x: number, z: number): number | null;
  };
  internals.cachedColumn(x, z);
  for (const nextHeight of [12, 18, 12]) {
    height = nextHeight;
    assert.equal(world.sampleColumn(x, z).h, height);
    assert.equal(world.terrainHeight(x, z), height);
    assert.equal(world.liquidAt(x, 15, z)?.kind, height < 15 ? 'lava' : undefined);
    assert.equal(world.roofedAbove(x, 15, z), height > 15);
    assert.equal(internals.terrainSdf(x, 15, z), 15 - height);
    assert.ok(Math.abs(internals.terrainGroundY(x, z)! - height) < .01);
  }
  // Replacing the generator at the same coordinates also must take effect.
  world.column = () => ({ h: 14, temp: .5, moist: .5, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 });
  assert.equal(world.terrainHeight(x, z), 14);
  assert.equal(world.liquidAt(x, 15, z), undefined);
  assert.equal(world.roofedAbove(x, 15, z), false);
});

test('shared contact/liquid columns retain exact terrain through reuse and eviction', () => {
  for (const seed of [1337, 7331, 20077]) {
    const world = new World(seed), reference = new World(seed);
    // Use the unchanged public generator as the uncached reference, including
    // actual caves, roads, lakes, city borders and fractional world positions.
    const internals = reference as unknown as { cachedColumn(x: number, z: number): ColumnData };
    internals.cachedColumn = (x, z) => reference.column(x, z);
    const random = mulberry32(seed);
    const points = world.collectCities().flatMap(city => [-1, 0, 1].map(side => ({
      x: city.x + side * (city.radius + .123), z: city.z + .456,
    })));
    for (let i = 0; i < 64; i++) points.push({ x: (random() - .5) * 14000, z: (random() - .5) * 14000 });
    for (const { x, z } of points) {
      const expected = reference.column(x, z);
      for (const y of [expected.h - 12, expected.h - .2, expected.h + .2, expected.h + 4]) {
        assert.equal(world.terrainHeight(x, z), expected.h);
        assert.deepEqual(world.liquidAt(x, y, z), reference.liquidAt(x, y, z));
        assert.equal(world.sdf(x, y, z), reference.sdf(x, y, z));
        assert.equal(world.roofedAbove(x, y, z), reference.roofedAbove(x, y, z));
      }
      // A consumer's editable public column cannot poison internal probes.
      const edited = world.column(x, z);
      edited.h += 100; edited.lavaY = expected.h + 200;
      if (edited.road) edited.road.height += 100;
      assert.equal(world.terrainHeight(x, z), expected.h);
      assert.deepEqual(world.column(x, z), expected);
    }
    // More than one cache capacity, with no grid rounding or growth forever.
    for (let i = 0; i < 33000; i++) {
      const x = 2100 + i * .000123, z = -1700 + i * .000457;
      assert.equal(world.terrainHeight(x, z), reference.column(x, z).h);
    }
    for (const { x, z } of points.slice(0, 4)) {
      assert.equal(world.terrainHeight(x, z), reference.column(x, z).h);
    }
    const cache = (world as unknown as { sdfColumns: (ColumnData | undefined)[] }).sdfColumns;
    assert.equal(cache.length, 32768);
    assert.ok(cache.filter(Boolean).length <= 32768);
  }
});
