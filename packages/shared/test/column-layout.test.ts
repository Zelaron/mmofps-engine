// Permanent source proposal: copy unchanged to packages/shared/test/column-layout.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, createColumnData, cavePathPoint, type ColumnData } from '@shared/worldgen';

const RAW_KEYS = ['h', 'temp', 'moist', 'desert', 'entr', 'entrRaw', 'volc', 'lavaY', 'lavaBasin'];
const OPTIONAL_KEYS = ['rainforest', 'city', 'road', 'templeSite', 'temple',
  'transport', 'deepRock', 'cave', 'caveBranches'] as const;
const KEYS = [...RAW_KEYS, ...OPTIONAL_KEYS];

test('native column factory preserves numeric bits, references and serialized raw data', () => {
  const basin = { level: -0, channel: .75 };
  const values = [-0, NaN, Infinity, -Infinity, Number.MIN_VALUE, 0, .25, -1000] as const;
  const column = createColumnData(...values, basin);
  for (let i = 0; i < values.length; i++) {
    assert.ok(Object.is(column[RAW_KEYS[i] as keyof ColumnData], values[i]), RAW_KEYS[i]);
  }
  assert.equal(column.lavaBasin, basin);
  assert.equal(Object.getPrototypeOf(column), Object.prototype);
  assert.deepEqual(Object.keys(column), KEYS);
  for (const key of OPTIONAL_KEYS) {
    assert.equal(Object.hasOwn(column, key), true, key);
    assert.equal(column[key], undefined, key);
  }
  // Undefined deepRock and caveBranches are semantic defaults, not 0 or [].
  const legacy = { h: -0, temp: NaN, moist: Infinity, desert: -Infinity,
    entr: Number.MIN_VALUE, entrRaw: 0, volc: .25, lavaY: -1000, lavaBasin: basin };
  assert.equal(JSON.stringify(column), JSON.stringify(legacy));
  const other = createColumnData(...values, basin);
  assert.notEqual(other, column);
  column.h = 27;
  column.transport = true;
  assert.ok(Object.is(other.h, -0));
  assert.equal(other.transport, undefined);
  assert.equal(other.lavaBasin, basin, 'Nested input references are intentionally retained');
  assert.deepEqual(Object.keys(column), KEYS, 'Populating an optional value retains its slot');
});

test('native biome, city, transport and cave columns keep field semantics with explicit empty slots', () => {
  const world = new World(1337);
  const points = [{ x: -2835.6, z: 2095.5 }, { x: -3936, z: 2464 }, { x: 17.25, z: -31.5 }];
  for (const city of world.collectCities().slice(0, 4)) points.push({ x: city.x, z: city.z });
  for (const temple of world.collectJungleTemples().slice(0, 1)) points.push({ x: temple.x, z: temple.z });
  for (const pod of world.collectTransportPlan().pods.slice(0, 2)) points.push({ x: pod.x, z: pod.z });
  for (const site of world.collectCaveSites(-960, 960, -960, 960).slice(0, 2)) {
    points.push(cavePathPoint(site, site.mouthLength), cavePathPoint(site, site.length));
  }
  assert.ok(points.length <= 16);
  for (const { x, z } of points) {
    const column = world.column(x, z);
    assert.deepEqual(Object.keys(column), KEYS);
    const withoutEmptySlots = Object.fromEntries(Object.entries(column)
      .filter(([, value]) => value !== undefined)) as unknown as ColumnData;
    assert.equal(JSON.stringify(column), JSON.stringify(withoutEmptySlots));
    const region = world.collectRegion(x, x, z, z);
    for (const y of [column.h - 12, column.h - .01, column.h + .01, column.h + 3]) {
      for (const signOnly of [false, true]) {
        assert.ok(Object.is(world.sdfCol(x, y, z, column, region, signOnly),
          world.sdfCol(x, y, z, withoutEmptySlots, region, signOnly)), `${x},${y},${z}`);
      }
    }
    if (column.city) assert.ok(world.collectCities().includes(column.city));
    if (column.templeSite) assert.ok(world.collectJungleTemples().includes(column.templeSite));
    if (column.caveBranches) assert.ok(column.caveBranches.includes(column.cave!));
  }
  assert.equal(world.hasNativeTerrainProviders(), true);
});

test('public columns remain fresh while native query and private flat-city records retain their contracts', () => {
  const world = new World(1337), x = 1.25, z = 2.5;
  const cached = world.sampleColumn(x, z), first = world.column(x, z), second = world.column(x, z);
  assert.equal(world.sampleColumn(x, z), cached);
  assert.notEqual(first, second);
  assert.notEqual(first, cached);
  assert.deepEqual(first, cached);
  const originalHeight = cached.h, originalRoadHeight = cached.road?.height;
  first.h += 100;
  if (first.road) first.road.height += 100;
  assert.equal(world.sampleColumn(x, z).h, originalHeight);
  assert.equal(world.sampleColumn(x, z).road?.height, originalRoadHeight);
  assert.deepEqual(world.column(x, z), second);

  // Exercise normal staticSdf initialization; do not replace any provider.
  world.sdf(x, originalHeight + .5, z);
  const flats = (world as unknown as { flatCityColumns: readonly ColumnData[] }).flatCityColumns;
  const cities = world.collectCities().filter(city => city.theme !== 'vesper');
  assert.ok(cities.length > 0);
  assert.equal(flats.length, cities.length);
  for (let i = 0; i < flats.length; i++) {
    const flat = flats[i];
    assert.deepEqual(Object.keys(flat), KEYS);
    assert.equal(flat.city, cities[i]);
    assert.equal(flat.h, cities[i].y);
    assert.equal(flat.lavaY, -1000);
    for (const key of ['temp', 'moist', 'desert', 'entr', 'entrRaw', 'volc'] as const) assert.equal(flat[key], 0);
    for (const key of ['lavaBasin', ...OPTIONAL_KEYS.filter(key => key !== 'city')] as const) {
      assert.equal(flat[key], undefined, key);
    }
  }
  assert.equal(world.hasNativeTerrainProviders(), true);
});

test('injected instance, subclass and prototype columns keep their own object representation', () => {
  const supplied: ColumnData = { h: 12, temp: .5, moist: .5, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 };
  const originalKeys = Reflect.ownKeys(supplied), world = new World(1337);
  world.sampleColumn(1, 2);
  const native = world.column;
  world.column = () => supplied;
  assert.equal(world.sampleColumn(1, 2), supplied);
  supplied.h = 18;
  assert.equal(world.terrainHeight(1, 2), 18);
  assert.equal(world.hasNativeTerrainProviders(), false);
  assert.deepEqual(Reflect.ownKeys(supplied), originalKeys);
  world.column = native;
  assert.equal(world.hasNativeTerrainProviders(), true);

  class InjectedWorld extends World { override column() { return supplied; } }
  const subclass = new InjectedWorld(1337);
  assert.equal(subclass.sampleColumn(1, 2), supplied);
  assert.equal(subclass.hasNativeTerrainProviders(), false);
  const prototypeColumn = World.prototype.column;
  try {
    World.prototype.column = () => supplied;
    const prototypeWorld = new World(1337);
    assert.equal(prototypeWorld.column(1, 2), supplied);
    assert.equal(prototypeWorld.sampleColumn(1, 2), supplied);
    assert.equal(prototypeWorld.hasNativeTerrainProviders(), false);
    assert.deepEqual(Reflect.ownKeys(supplied), originalKeys);
  } finally {
    World.prototype.column = prototypeColumn;
  }
});
