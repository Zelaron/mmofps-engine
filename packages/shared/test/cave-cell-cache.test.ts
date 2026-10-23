import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { CAVE_CELL, type CaveSite } from '@shared/caves';

interface CaveInternals {
  caveCache: Map<string, CaveSite | null>;
  caveFor(ix: number, iz: number): CaveSite | null;
  resolveCaveCell(ix: number, iz: number): CaveSite | null;
}
const internal = (world: World) => world as unknown as CaveInternals;
const site = (ix: number, iz: number): CaveSite => ({ x: ix * CAVE_CELL + 20, y: 30, z: iz * CAVE_CELL + 20,
  dx: 1, dz: 0, length: 72, depth: 18, width: 8, mouthLength: 28, chamberRadius: 22, height: 14, bend: 0, seed: 1 });

test('repeated cave-cell queries retain both generated references and cached absence without map lookup', () => {
  const world = new World(1337), internals = internal(world), cave = site(0, 0);
  internals.caveCache.set('0,0', cave); internals.caveCache.set('-1,0', null);
  const get = internals.caveCache.get.bind(internals.caveCache);
  const has = internals.caveCache.has.bind(internals.caveCache);
  let lookups = 0;
  internals.caveCache.get = key => { lookups++; return get(key); };
  internals.caveCache.has = key => { lookups++; return has(key); };
  assert.equal(internals.caveFor(0, 0), cave, 'uninitialized tuple cannot masquerade as cell zero');
  lookups = 0;
  for (let i = 0; i < 100; i++) assert.equal(internals.caveFor(0, 0), cave);
  assert.equal(lookups, 0);
  assert.equal(internals.caveFor(-1, 0), null);
  lookups = 0;
  for (let i = 0; i < 100; i++) assert.equal(internals.caveFor(-1, 0), null);
  assert.equal(lookups, 0, 'absent caves are reusable results');
  assert.equal(internals.caveFor(0, 0), cave, 'revisiting a prior cell retains its original map-owned object');
  assert.deepEqual([...internals.caveCache.keys()], ['0,0', '-1,0'], 'hits retain the existing FIFO order');
});

test('cave memo retains native floor membership at negative, zero and large cell boundaries', () => {
  const world = new World(1337), internals = internal(world);
  for (const cell of [-400000, -2, -1, 0, 1, 2, 400000]) {
    const edge = cell * CAVE_CELL, epsilon = Math.max(1, Math.abs(edge)) * Number.EPSILON;
    const positions = [edge - .1, edge - epsilon, edge, edge + epsilon, edge + .1];
    for (const axis of ['x', 'z']) for (const value of [...positions, ...positions.slice().reverse()]) {
      const x = axis === 'x' ? value : 13.375, z = axis === 'z' ? value : 13.375;
      const ix = Math.floor(x / CAVE_CELL), iz = Math.floor(z / CAVE_CELL), key = `${ix},${iz}`;
      if (!internals.caveCache.has(key)) internals.caveCache.set(key, site(ix, iz));
      assert.deepEqual(world.collectCaveSites(x, x, z, z), [internals.caveCache.get(key)], `${x},${z}`);
    }
  }
  assert.equal(internals.caveFor(-0, 0), internals.caveFor(0, -0), 'signed zero aliases retain native cell keys');
});

test('nested cave resolution commits the outer tuple together with its own result', () => {
  const world = new World(1337), internals = internal(world), outer = site(1, 2), nested = site(9, -4);
  let calls = 0;
  internals.resolveCaveCell = (ix, iz) => {
    calls++;
    if (ix === 1 && iz === 2) {
      assert.equal(internals.caveFor(9, -4), nested);
      return outer;
    }
    return nested;
  };
  assert.equal(internals.caveFor(1, 2), outer);
  assert.equal(internals.caveFor(1, 2), outer);
  assert.equal(calls, 2);
  assert.equal(internals.caveFor(9, -4), nested);
  assert.equal(calls, 3, 'the nested lookup cannot poison the completed outer memo');
});

test('last cave memo preserves generated caves, empty cells and complete public column values', () => {
  const world = new World(1337), reference = new World(1337), expected = internal(reference);
  expected.caveFor = expected.resolveCaveCell.bind(reference);
  const cells: [number, number][] = [];
  for (let z = -2; z <= 2; z++) for (let x = -2; x <= 2; x++) cells.push([x, z]);
  let caves = 0, empty = 0;
  for (const [ix, iz] of [...cells, ...cells.slice().reverse()]) {
    const value = internal(world).caveFor(ix, iz), original = expected.caveFor(ix, iz);
    assert.deepEqual(value, original);
    assert.equal(internal(world).caveFor(ix, iz), value);
    if (value) caves++; else empty++;
    for (const offset of [.125, CAVE_CELL - .125]) {
      const x = ix * CAVE_CELL + offset, z = iz * CAVE_CELL + 13.375;
      assert.deepEqual(world.column(x, z), reference.column(x, z));
    }
  }
  assert.ok(caves > 0 && empty > 0, 'exercise actual cave generation and canonical null results');
});
