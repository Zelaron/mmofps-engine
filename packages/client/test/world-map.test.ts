import {test} from 'node:test';
import assert from 'node:assert/strict';
import {World} from '@shared/worldgen';
import {worldMapSvg,mapPoint,separateMapPins} from '../src/world-map.js';
test('map covers every terminal and keeps nearby destinations separately clickable',()=>{
  for(const seed of [1,1337,424242]) {
    const world=new World(seed),plan=world.collectTransportPlan(),points=plan.pods.map(mapPoint);
    const svg=worldMapSvg(world,plan);assert.equal(svg,worldMapSvg(world,plan));
    for(const width of [320,560]) {
      const gap=48*600/width,positions=separateMapPins(points,gap);
      for(let i=0;i<positions.length;i++) {
        const p=positions[i];assert.ok(p.x>=28&&p.y>=28&&p.x<=572&&p.y<=572);
        for(let j=0;j<i;j++)assert.ok(Math.hypot(p.x-positions[j].x,p.y-positions[j].y)>=gap,'click targets overlap');
      }
    }
  }
});
