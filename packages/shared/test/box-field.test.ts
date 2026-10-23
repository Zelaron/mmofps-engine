import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SolidBoxIndex } from '../src/box-field.js';
import { World, type Box } from '../src/worldgen.js';
import { sdBox } from '../src/sdf.js';
import { mulberry32 } from '../src/rng.js';

test('box hierarchy preserves exact field distances inside, outside and between overlapping solids', () => {
  const rng=mulberry32(1429), boxes:Box[]=[];
  for(let i=0;i<200;i++) boxes.push({x:rng()*100,y:rng()*80,z:rng()*100,hx:.2+rng()*8,hy:.2+rng()*12,hz:.2+rng()*8});
  const index=new SolidBoxIndex(boxes);
  for(let i=0;i<6000;i++) {
    const x=rng()*140-20,y=rng()*120-20,z=rng()*140-20,best=i%3?Infinity:rng()*20-10;
    const expected=boxes.reduce((d,b)=>Math.min(d,sdBox(x,y,z,b.x,b.y,b.z,b.hx,b.hy,b.hz)),best);
    assert.equal(index.distance(x,y,z,best),expected);
  }
});

test('plaza collision visits a bounded fraction of city pieces and shares their index between prop cells', () => {
  const world=new World(1337),city=world.collectCities()[0];
  const region=world.regionAt(city.x,city.z), index=new SolidBoxIndex(region.solids);
  assert.ok(region.solids.length>400);
  for(const [dx,dz] of [[0,0],[8,12],[-18,16],[30,-8]]) {
    const x=city.x+dx,z=city.z+dz,y=city.y+1;
    const expected=region.solids.reduce((d,b)=>Math.min(d,sdBox(x,y,z,b.x,b.y,b.z,b.hx,b.hy,b.hz)),1);
    assert.equal(index.distance(x,y,z,1),expected);
    assert.ok(index.boxTests < region.solids.length/4,`${index.boxTests} of ${region.solids.length} pieces`);
  }
  assert.equal(world.regionAt(city.x+2,city.z+2).solids,region.solids,
    'plant/boulder cache boundaries must not rebuild the same city hierarchy');
});

test('thin walls and decks retain exact face, corner and penetration distances far from the world origin', () => {
  assert.equal(new SolidBoxIndex([]).distance(0, -245, 8192, .01), .01);
  for (const origin of [-8192, 8192]) {
    const boxes: Box[] = [];
    for (let i = 0; i < 48; i++) {
      const x = origin + (i % 8) * 16 + .012345, z = -origin + Math.floor(i / 8) * 24 + .006789;
      boxes.push({ x, y: -240.013, z, hx: .1273, hy: 5.018, hz: 8.00341 });
      boxes.push({ x: x + 4, y: -245.017, z, hx: 8.00341, hy: .1273, hz: 8.00341 });
    }
    const index = new SolidBoxIndex(boxes);
    for (const b of boxes) for (const epsilon of [-1e-6, 0, 1e-6, .02, .4]) {
      const probes = [
        [b.x + b.hx + epsilon, b.y, b.z],
        [b.x, b.y + b.hy + epsilon, b.z],
        [b.x - b.hx - epsilon, b.y, b.z - b.hz - epsilon],
        [b.x + b.hx + epsilon, b.y + b.hy + epsilon, b.z + b.hz + epsilon],
      ];
      for (const [x, y, z] of probes) for (const limit of [Infinity, 2, .01, 0, -.01, -5]) {
        const expected = boxes.reduce((d, p) => Math.min(d, sdBox(x, y, z, p.x, p.y, p.z, p.hx, p.hy, p.hz)), limit);
        assert.equal(index.distance(x, y, z, limit), expected, `origin ${origin}, epsilon ${epsilon}, limit ${limit}`);
      }
    }
  }
});

test('threshold pruning preserves signed limits and exact tangencies beyond current world coordinates', () => {
  for (const origin of [-100_000_000, 100_000_000]) {
    const boxes: Box[] = Array.from({ length: 64 }, (_, i) => ({
      x: origin + (i % 8) * 19.125 + .013579, y: 143.0123 + (i % 3) * 2.17,
      z: -origin + Math.floor(i / 8) * 23.375 + .019753,
      hx: i % 2 ? .137 : 7.375, hy: i % 2 ? 8.125 : .163, hz: 6.517,
    }));
    const index = new SolidBoxIndex(boxes);
    for (const box of boxes) for (const epsilon of [-1e-7, 0, 1e-7, .015, 1.5]) {
      for (const [x, y, z] of [[box.x, box.y, box.z],
        [box.x + box.hx + epsilon, box.y, box.z],
        [box.x, box.y + box.hy + epsilon, box.z],
        [box.x + box.hx + epsilon, box.y + box.hy + epsilon, box.z - box.hz - epsilon]]) {
        const exact = boxes.reduce((d, b) => Math.min(d, sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz)), Infinity);
        for (const limit of [-Infinity, -8, -.01, -0, 0, .01, 8, Infinity, exact]) {
          const expected = boxes.reduce((d, b) => Math.min(d, sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz)), limit);
          assert.equal(index.distance(x, y, z, limit), expected,
            `origin ${origin}, epsilon ${epsilon}, incoming limit ${limit}`);
        }
      }
    }
  }
});

test('hierarchy traversal preserves right-first ties, deferred pruning and resets each query', () => {
  // Both child bounds tie at the origin. Visiting the right child first finds
  // distance 1 and rejects every left leaf; left-first would test two boxes.
  const tied = new SolidBoxIndex(Array.from({ length: 16 }, (_, i) => ({
    x: i < 8 ? -2 : 2, y: i < 8 ? 2 : 0, z: 0, hx: 1, hy: 1, hz: 1,
  })));
  for (let pass = 0; pass < 3; pass++) {
    assert.equal(tied.distance(0, 0, 0), 1); assert.equal(tied.boxTests, 1);
    assert.equal(tied.distance(0, 0, 0, 1), 1); assert.equal(tied.boxTests, 0);
    assert.equal(tied.distance(-2, 2, 0), -1); assert.equal(tied.boxTests, 1);
    assert.equal(tied.distance(0, 0, 0, -0), -0); assert.equal(tied.boxTests, 0);
  }
  const boxes = Array.from({ length: 257 }, (_, i) => ({
    x: (i * 41) % 101, y: (i * 17) % 79, z: (i * 67) % 103,
    hx: .25 + i % 7, hy: .125 + i % 11, hz: .5 + i % 5,
  }));
  // Pruning counts frozen from the prior recursive traversal. These queries
  // require several winning leaves and pending siblings across many levels.
  const probes = [[33, 27, 19, 3], [76, 64, 48, 5], [35, 35, 106, 8],
    [78, 72, 4, 5], [37, 43, 62, 3], [80, 80, 91, 4], [39, 51, 18, 6],
    [41, 59, 105, 7], [86, 1, 90, 3], [45, 75, 17, 3]];
  const index = new SolidBoxIndex(boxes);
  for (const order of [probes, [...probes].reverse(), probes]) for (const [x, y, z, count] of order) {
    const expected = boxes.reduce((d, b) => Math.min(d, sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz)), Infinity);
    assert.equal(index.distance(x, y, z), expected);
    assert.equal(index.boxTests, count, `historical pruning at ${x},${y},${z}`);
  }
});

test('hierarchy leaf and branch queries retain nonfinite inputs and signed incoming limits', () => {
  const box = { x: -2, y: 2, z: 0, hx: 1, hy: 1, hz: 1 };
  const leaf = new SolidBoxIndex([box]);
  const branch = new SolidBoxIndex(Array.from({ length: 16 }, () => ({ ...box })));
  for (const index of [leaf, branch]) {
    assert.equal(index.distance(0, 0, 0, NaN), NaN);
    assert.equal(index.boxTests, index === leaf ? 1 : 0);
    assert.equal(index.distance(NaN, 0, 0), Infinity);
    assert.equal(index.boxTests, index === leaf ? 1 : 0);
    for (const [x, best] of [[Infinity, Infinity], [-Infinity, Infinity], [0, -Infinity], [0, -0], [0, 0]]) {
      assert.equal(index.distance(x, 0, 0, best), best);
      assert.equal(index.boxTests, 0);
    }
    assert.equal(index.distance(-2, 2, 0), -1);
    assert.equal(index.boxTests, 1, 'an invalid query must not leak a deferred branch into the next call');
  }
  const empty = new SolidBoxIndex([]);
  for (const best of [-Infinity, -0, 0, Infinity, NaN]) {
    assert.equal(empty.distance(NaN, Infinity, -Infinity, best), best);
    assert.equal(empty.boxTests, 0);
  }
});

test('cached cell candidates preserve thin faces and negative minima across a whole cell at large coordinates', () => {
  for (const origin of [0, -8192, 8192, -(1e12 - 512), 1e12 - 512]) {
    const boxes: Box[] = [
      { x: origin + 2, y: origin - .125, z: -origin + 2, hx: 6, hy: .125, hz: 6 },
      { x: origin + 4.125, y: origin + 2, z: -origin + 2, hx: .125, hy: 4, hz: 6 },
      { x: origin + 2, y: origin + 2, z: -origin + 2, hx: .75, hy: .75, hz: .75 },
      ...Array.from({ length: 32 }, (_, i) => ({ x: origin + 12 + (i % 8) * 8,
        y: origin + 8, z: -origin + Math.floor(i / 8) * 8, hx: .125, hy: 3, hz: 3 })),
    ];
    const index = new SolidBoxIndex(boxes);
    const epsilon = Math.max(1, Math.abs(origin)) * Number.EPSILON;
    const probes = [
      [.125, .125, .125], [3.875, 3.875, 3.875], [.125, .125, .125],
      [2, 2, 2], [2, 0, 2], [4 - epsilon, 2, 2], [4, 2, 2], [4 + epsilon, 2, 2],
      [2, -epsilon, 2], [2, epsilon, 2],
    ];
    for (const order of [probes, [...probes].reverse()]) for (const [dx, dy, dz] of order) {
      const x = origin + dx, y = origin + dy, z = -origin + dz;
      for (const limit of [2, -.005, -0, 0, .005, -2, Infinity]) {
        const expected = boxes.reduce((best, b) => Math.min(best,
          sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz)), limit);
        assert.ok(Object.is(index.distance(x, y, z, limit), expected),
          `origin ${origin}, offset ${dx},${dy},${dz}, limit ${limit}`);
      }
    }
    assert.ok((index as unknown as { cells: Map<string, unknown> }).cells.size > 0,
      'large-coordinate probes must exercise eligible cached cells, not only fallback');
  }
});

test('candidate cache bounds storage, revisits evicted cells and falls back for dense overlapping geometry', () => {
  const boxes: Box[] = Array.from({ length: 100 }, (_, i) => ({
    x: (i % 10) * 8 + 2, y: 2, z: Math.floor(i / 10) * 8 + 2, hx: .125, hy: 3, hz: .125,
  }));
  const index = new SolidBoxIndex(boxes);
  const cells = (index as unknown as { cells: Map<string, Uint32Array | null> }).cells;
  for (const order of [boxes, [...boxes].reverse(), boxes]) for (const box of order) {
    const x = box.x + .0625, y = box.y, z = box.z;
    const expected = boxes.reduce((best, b) => Math.min(best,
      sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz)), 2);
    assert.equal(index.distance(x, y, z, 2), expected);
    assert.ok(cells.size <= 64, 'long travel cannot retain unbounded candidate cells');
  }
  assert.equal(cells.size, 64, 'the fixture must exceed the bounded cache capacity');
  const dense: Box[] = Array.from({ length: 160 }, (_, i) => ({
    x: i * .001, y: 0, z: 0, hx: 4, hy: 4, hz: 4,
  }));
  const denseIndex = new SolidBoxIndex(dense);
  for (const limit of [2, -.005, -0, -5, 2]) {
    const expected = dense.reduce((best, b) => Math.min(best,
      sdBox(.5, .5, .5, b.x, b.y, b.z, b.hx, b.hy, b.hz)), limit);
    assert.equal(denseIndex.distance(.5, .5, .5, limit), expected);
  }
  const denseCells = (denseIndex as unknown as { cells: Map<string, Uint32Array | null> }).cells;
  assert.deepEqual([...denseCells.values()], [null], 'dense cells retain only a fallback marker, not a large offset array');
});

test('a warm candidate cache honors replaced instance and prototype visitors', () => {
  const index = new SolidBoxIndex(Array.from({ length: 16 }, (_, i) => ({
    x: i - 8, y: 0, z: 0, hx: 1, hy: 1, hz: 1,
  })));
  const originalDistance = index.distance(0, 0, 0, 2);
  type Visitor = { visit: (...args: unknown[]) => number };
  const instance = index as unknown as Visitor, prototype = SolidBoxIndex.prototype as unknown as Visitor;
  const originalVisit = prototype.visit;
  instance.visit = () => -123;
  assert.equal(index.distance(0, 0, 0, 2), -123);
  Reflect.deleteProperty(instance, 'visit');
  try {
    prototype.visit = () => -456;
    assert.equal(index.distance(0, 0, 0, 2), -456);
  } finally { prototype.visit = originalVisit; }
  assert.equal(index.distance(0, 0, 0, 2), originalDistance, 'restoring the native visitor can reuse its unchanged candidates');
});
