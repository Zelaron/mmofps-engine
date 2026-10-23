import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, VEGETATION_KIND, type Box, type RBox, type VegetationPlacement } from '@shared/index';
import { ScenerySamples, StructureSamples } from '../src/render/scenery-samples.js';
import type { SceneryBounds, SceneryKind } from '../src/render/scenery-stream.js';

function finish<T>(iterator: Generator<void, T, void>): T {
  for (let advances = 0; advances < 10_000; advances++) {
    const next = iterator.next();
    if (next.done) return next.value;
    assert.equal(next.value, undefined, 'only the final result may publish scenery');
  }
  throw new Error('bounded scenery request did not finish');
}

test('cooperative World collectors preserve canonical cell order, including empty cells and negative boundaries', () => {
  for (const kind of ['vegetation', 'boulders'] as const) {
    const worlds = [new World(1337), new World(1337)];
    const calls: string[][] = [[], []];
    const privateName = kind === 'vegetation' ? 'vegetationFor' : 'bouldersFor';
    for (let n = 0; n < worlds.length; n++) {
      const internal = worlds[n] as unknown as Record<string, unknown>;
      internal[privateName] = (i: number, j: number) => {
        calls[n].push(`${i},${j}`);
        return (i + j) % 2 === 0 ? null : [{ x: i, z: j }];
      };
    }
    const bounds: [number, number, number, number] = [-73, 67, -41, 79];
    const expected = kind === 'vegetation' ? worlds[0].collectVegetation(...bounds) : worlds[0].collectBoulders(...bounds);
    const iterator = kind === 'vegetation' ? worlds[1].collectVegetationCells(...bounds) : worlds[1].collectBoulderCells(...bounds);
    assert.equal(calls[1].length, 0, 'constructing an iterator performs no cold work');
    const actual: unknown[] = [];
    for (let advance = 0; advance < calls[0].length; advance++) {
      const next = iterator.next();
      assert.equal(next.done, false);
      assert.equal(calls[1].length, advance + 1, 'one advance resolves exactly one canonical cell');
      if (next.value) actual.push(...next.value);
    }
    assert.equal(iterator.next().done, true);
    assert.deepEqual(actual, expected);
    assert.deepEqual(calls[1], calls[0]);
  }
});

test('cancelled cell collection stops cold work and injected collectors retain their semantics', () => {
  const world = new World(1337);
  let cells = 0;
  (world as unknown as { vegetationFor(): null }).vegetationFor = () => { cells++; return null; };
  const iterator = world.collectVegetationCells(-500, 500, -500, 500);
  assert.equal(iterator.next().done, false); assert.equal(cells, 1);
  iterator.return(); assert.equal(iterator.next().done, true); assert.equal(cells, 1);
  const plants: VegetationPlacement[] = [{ x: 0, y: 1, z: 2, radius: 1, height: 3,
    canopyRadius: 2, kind: VEGETATION_KIND.BROADLEAF, yaw: 0 }];
  const rock: RBox = { x: 1, y: 2, z: 3, hx: 1, hy: 2, hz: 3, r: .2 };
  world.collectVegetation = () => plants;
  world.collectBoulders = () => [rock];
  assert.deepEqual([...world.collectVegetationCells(0, 0, 0, 0)].flat(), plants);
  assert.deepEqual([...world.collectBoulderCells(0, 0, 0, 0)].flat(), [rock]);
});

function structures() {
  const calls: string[] = [];
  const common: Box = { x: 7, y: 3, z: 8, hx: 1, hy: 2, hz: 3 };
  const floor: Box = { ...common, y: -.5, hy: .5 };
  const world: Pick<World, 'collectStructures'> = {
    collectStructures(x, _maxX, z) {
      calls.push(`${x},${z}`);
      return { sites: [], pads: [], cuts: [], foundations: [floor],
        solids: [common, { ...common, x, z, facade: calls.length }, floor, { ...common, capital: true }] };
    },
  };
  return { samples: new StructureSamples(world), calls };
}

test('structure pauses preserve floor filtering, deduplication, LRU order and prefetch across eviction', () => {
  const sync = structures(), cooperative = structures();
  const queries: SceneryBounds[] = [
    { minX: -1, maxX: 257, minZ: -129, maxZ: 128 },
    { minX: 0, maxX: 64, minZ: 0, maxZ: 64 },
    { minX: -2048, maxX: 2048, minZ: -2048, maxZ: 2048 },
    { minX: -1, maxX: 257, minZ: -129, maxZ: 128 },
  ];
  for (const query of queries) {
    assert.deepEqual(finish(cooperative.samples.collectSteps(query)), sync.samples.collect(query));
    assert.deepEqual(cooperative.calls, sync.calls);
    assert.deepEqual([...cooperative.samples.cells], [...sync.samples.cells]);
    assert.deepEqual(cooperative.samples.prefetch, sync.samples.prefetch);
    assert.ok(cooperative.samples.cells.size <= 256);
  }
  const job = cooperative.samples.collectSteps({ minX: 10_000, maxX: 12_000, minZ: 10_000, maxZ: 12_000 });
  const before = cooperative.calls.length;
  assert.equal(job.next().done, false); assert.equal(cooperative.calls.length, before + 1);
  job.return([]); assert.equal(cooperative.calls.length, before + 1);
});

test('cooperative rocks retain all-cell generation before biome sampling and publish only complete arrays', () => {
  const make = () => {
    const world = new World(1337), events: string[] = [];
    (world as unknown as { bouldersFor(i: number, j: number): RBox[] }).bouldersFor = (i, j) => {
      events.push(`cell:${i},${j}`);
      return [{ x: i * 36, y: 0, z: j * 36, hx: 1, hy: 1, hz: 1, r: .2 }];
    };
    world.column = (x, z) => {
      events.push(`color:${x},${z}`);
      return { desert: x < 0 ? .7 : .1 } as ReturnType<World['column']>;
    };
    return { samples: new ScenerySamples(world), events };
  };
  const sync = make(), cooperative = make(), bounds = { minX: -36, maxX: 36, minZ: -36, maxZ: 36 };
  assert.deepEqual(finish(cooperative.samples.collectSteps('rocks', bounds)), sync.samples.collect('rocks', bounds));
  assert.deepEqual(cooperative.events, sync.events);
});

test('native scenery coroutine equals synchronous complete geometry across cold and repeated footprints', () => {
  for (const seed of [1337, 7331]) {
    const sync = new ScenerySamples(new World(seed)), cooperative = new ScenerySamples(new World(seed));
    const queries: SceneryBounds[] = [
      { minX: -65, maxX: 1, minZ: -33, maxZ: 33 },
      { minX: 5095, maxX: 5165, minZ: 1135, maxZ: 1205 },
      { minX: -65, maxX: 1, minZ: -33, maxZ: 33 },
    ];
    for (const bounds of queries) for (const kind of ['vegetation', 'structures', 'rocks'] as SceneryKind[])
      assert.deepEqual(finish(cooperative.collectSteps(kind, bounds)), sync.collect(kind, bounds), `${seed} ${kind}`);
  }
});
