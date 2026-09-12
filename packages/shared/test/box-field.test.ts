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
