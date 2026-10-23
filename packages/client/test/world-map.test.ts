import {test} from 'node:test';
import assert from 'node:assert/strict';
import {World} from '@shared/worldgen';
import {worldMapSvg,mapPoint,separateMapPins,roadMapPaths,mapViewport} from '../src/world-map.js';
test('map covers every terminal and keeps nearby destinations separately clickable',()=>{
  for(const seed of [1,1337,424242]) {
    const world=new World(seed),plan=world.collectTransportPlan(),points=plan.pods.map(mapPoint);
    const svg=worldMapSvg(world,plan);assert.equal(svg,worldMapSvg(world,plan));
    assert.ok(svg.length<80000,'tactical basemap must stay compact enough for cheap SVG repainting');
    assert.doesNotMatch(svg,/terrain-contours|terrain-soft|feGaussianBlur/,'relief never competes with objectives');
    for(const width of [320,560]) {
      const gap=48*600/width,positions=separateMapPins(points,gap);
      for(let i=0;i<positions.length;i++) {
        const p=positions[i];assert.ok(p.x>=28&&p.y>=28&&p.x<=572&&p.y<=572);
        for(let j=0;j<i;j++)assert.ok(Math.hypot(p.x-positions[j].x,p.y-positions[j].y)>=gap,'click targets overlap');
      }
    }
  }
});

test('cartography retains road detours and does not join sections removed by city or lava grading',()=>{
  const p=(x:number,z:number)=>({x,y:20,z});
  const roads=roadMapPaths([
    {id:'road',a:p(0,0),b:p(100,100),width:6,trail:false},
    {id:'road',a:p(100,100),b:p(200,0),width:6,trail:false},
    {id:'road',a:p(400,0),b:p(500,0),width:6,trail:false},
    {id:'trail',a:p(500,0),b:p(520,50),width:2,trail:true},
  ]);
  assert.equal((roads.roads.match(/M/g)??[]).length,2,'the gap must remain a new path');
  assert.ok(roads.roads.includes('L302.44,302.44'),'the bend must remain on the map');
  assert.equal((roads.trails.match(/M/g)??[]).length,1);
});

test('map focus keeps coast locations visible at full zoom and returns to the whole planet',()=>{
  assert.deepEqual(mapViewport({x:590,y:12},4),{x:450,y:0,size:150});
  assert.deepEqual(mapViewport({x:590,y:12},1),{x:0,y:0,size:600});
  assert.deepEqual(mapViewport({x:300,y:300},2),{x:150,y:150,size:300});
});
