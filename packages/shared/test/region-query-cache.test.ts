import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, type Region } from '@shared/worldgen';
import { mulberry32 } from '@shared/rng';

function originalKey(x: number, z: number): string {
  const tuple: number[] = [];
  for (const [size, margin] of [[256, 58], [36, 5], [64, 4]]) {
    tuple.push(Math.floor((x - margin) / size), Math.floor((x + margin) / size),
      Math.floor((z - margin) / size), Math.floor((z + margin) / size));
  }
  return tuple.join(',');
}

function fixture(): World {
  const world = new World(1337);
  // Keep the original region lookup/cache while replacing expensive terrain
  // generation with an independently calculated membership signature.
  world.collectRegion = (x, _maxX, z) => ({ sites: [], pads: [], solids: [], cuts: [],
    boulders: [], vegetation: [], key: originalKey(x, z) } as Region & { key: string });
  return world;
}

function check(world: World, x: number, z: number): void {
  assert.equal((world.regionAt(x, z) as Region & { key: string }).key, originalKey(x, z), `${x},${z}`);
}

test('region interval memo preserves all lower/upper cell margins and boundary ties', () => {
  const world = fixture();
  for (const [size, margin] of [[256, 58], [36, 5], [64, 4]]) {
    for (const cell of [-400000, -32, -1, 0, 1, 32, 400000]) for (const sign of [-1, 1]) {
      const boundary = cell * size + sign * margin;
      const epsilon = Math.max(Number.EPSILON, Math.abs(boundary) * Number.EPSILON);
      const positions = [boundary - 1, boundary - .12, boundary - epsilon, boundary,
        boundary + epsilon, boundary + .12, boundary + 1];
      for (const values of [positions, [...positions].reverse()]) for (const coordinate of values) {
        check(world, coordinate, 13.375);
        check(world, 13.375, coordinate);
        check(world, coordinate, coordinate);
      }
    }
  }
});

test('nearby and distant region probes retain original membership with bounded cache ownership', () => {
  const world = fixture(), random = mulberry32(173);
  for (let i = 0; i < 3000; i++) {
    const x = (random() - .5) * 20000, z = (random() - .5) * 20000;
    for (const [dx, dz] of [[0, 0], [.12, 0], [-.12, 0], [0, .12], [0, -.12], [.25, -.25]]) check(world, x + dx, z + dz);
  }
  for (let i = 0; i < 17000; i++) check(world, i * 257 + .123, -i * 257 + .456);
  const cache = (world as unknown as { regionCache: Map<string, Region> }).regionCache;
  assert.equal(cache.size, 16384);
  check(world, .123, .456);
  check(world, -.123, -.456);
  assert.equal(cache.size, 16384, 'the memo cannot extend the bounded map');
});

test('an interior repeat reuses its region while a neighboring margin rebuilds membership', () => {
  const world = fixture();
  const at = world.regionAt(10, 10);
  assert.equal(world.regionAt(10.12, 10.12), at);
  const crossed = world.regionAt(31, 10);
  assert.notEqual(crossed, at);
  assert.equal(world.regionAt(10, 10), at, 'existing exact-key regions remain reusable');
});

test('alternating capsule probes reuse two exact rectangles without string-key lookups', () => {
  const world=fixture();
  const left=world.regionAt(30.9,10),right=world.regionAt(31.1,10);
  assert.notEqual(left,right,'the shell straddles a boulder membership boundary');
  const cache=(world as unknown as {regionCache:Map<string,Region>}).regionCache;
  const get=cache.get.bind(cache);let lookups=0;
  cache.get=key=>{lookups++;return get(key);};
  for(let i=0;i<50;i++){
    assert.equal(world.regionAt(30.88,10.12),left);
    assert.equal(world.regionAt(31.12,9.88),right);
  }
  assert.equal(lookups,0,'both proven interiors bypass tuple strings and map lookup');
  // The secondary must not replace the primary pointer without its tuple.
  // Exact ties fall through the rectangles to native floor-based membership.
  for(const x of [31,31-Number.EPSILON*31,31+Number.EPSILON*31,31])check(world,x,10);
  check(world,30.9,10);check(world,31.1,10);
});

test('secondary rectangle hits preserve boundary ownership while the primary changes', () => {
  const world=fixture();
  for(const [size,margin] of [[256,58],[36,5],[64,4]])for(const cell of [-400000,-1,0,1,400000])for(const sign of [-1,1]){
    const edge=cell*size+sign*margin,epsilon=Math.max(1,Math.abs(edge))*Number.EPSILON;
    for(const axis of ['x','z'] as const){
      const probe=(value:number)=>axis==='x'?check(world,value,13.375):check(world,13.375,value);
      // Establish both neighboring open rectangles, revisit the secondary,
      // then force every exact/adjacent tie through canonical floor division.
      probe(edge-.2);probe(edge+.2);probe(edge-.12);
      for(const value of [edge,edge-epsilon,edge+epsilon,edge-.2,edge+.2])probe(value);
      check(world,edge+1000,edge-1000); // Replace the primary pair entirely.
      probe(edge-.12);probe(edge+.12);probe(edge);
    }
  }
});
