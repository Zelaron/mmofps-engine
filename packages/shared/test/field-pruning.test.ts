import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, type ColumnData, type Region } from '@shared/worldgen';
import { Landscape } from '@shared/landscape';
import { capitalBoundary } from '@shared/capital-geometry';
import { sdBoulder } from '@shared/rock-shape';
import { sdBox, sdCylinderY, smin } from '@shared/sdf';
import { WORLD } from '@shared/constants';
import { mulberry32 } from '@shared/rng';

test('primitive rejection preserves the exact complete field inside and outside props, pads and cuts',()=>{
  const world=new World(1337),random=mulberry32(81);
  const col:ColumnData={h:3,temp:.5,moist:.5,desert:0,entr:0,entrRaw:0,volc:0,lavaY:-1000};
  // Isolate the unchanged composition order from the expensive terrain model.
  (world as unknown as {terrainSdfCol:(x:number,y:number,z:number,col:ColumnData)=>number}).terrainSdfCol=(_x,y)=>y-3;
  const region:Region={boulders:Array.from({length:35},()=>({x:(random()-.5)*80,y:random()*6,z:(random()-.5)*80,hx:1+random()*5,hy:1+random()*4,hz:1+random()*5,r:0})),
    vegetation:Array.from({length:45},()=>({x:(random()-.5)*80,y:3,z:(random()-.5)*80,radius:.2+random(),height:4+random()*15,canopyRadius:4,kind:0,yaw:0})),
    pads:[{x:0,y:2,z:0,hx:10,hy:1,hz:7},{x:17,y:4,z:-8,hx:6,hy:2,hz:4}],cuts:[{x:2,y:3,z:1,hx:3,hy:4,hz:2}],solids:[],sites:[]};
  const reference=(x:number,y:number,z:number)=>{
    let d=y-3;
    for(const b of region.boulders)d=Math.min(d,sdBoulder(x,y,z,b));
    for(const p of region.pads)d=smin(d,sdBox(x,y,z,p.x,p.y,p.z,p.hx,p.hy,p.hz),.6);
    for(const b of region.cuts)d=Math.max(d,-sdBox(x,y,z,b.x,b.y,b.z,b.hx,b.hy,b.hz));
    for(const p of region.vegetation)d=Math.min(d,sdCylinderY(x,y,z,p.x,p.y+p.height*.5,p.z,p.radius,p.height*.5));
    return Math.min(d,WORLD.BORDER-Math.max(Math.abs(x),Math.abs(z)));
  };
  const points=region.boulders.flatMap(b=>[-1,0,1].flatMap(s=>[-1e-10,0,1e-10].map(e=>({x:b.x+(b.hx+e)*s,y:b.y,z:b.z}))));
  for(let i=0;i<4000;i++)points.push({x:(random()-.5)*100,y:-8+random()*40,z:(random()-.5)*100});
  for(const p of points)assert.equal(world.sdfCol(p.x,p.y,p.z,col,region),reference(p.x,p.y,p.z),`field changed at ${JSON.stringify(p)}`);
});

test('city broad phase keeps authored boundaries and positive or negative margins exact',()=>{
  const world=new World(1337),landscape=(world as unknown as {landscape:Landscape}).landscape,cities=world.collectCities(),random=mulberry32(37);
  const points:{x:number;z:number}[]=[];
  for(const city of cities)for(let i=0;i<100;i++){
    const angle=i/100*Math.PI*2,ux=Math.cos(angle),uz=Math.sin(angle);
    for(const ratio of [.849999999,.85,.850000001,.94,1.029999999,1.03,1.030000001])points.push({x:city.x+ux*city.radius*ratio,z:city.z+uz*city.radius*ratio});
  }
  for(let i=0;i<1500;i++)points.push({x:(random()-.5)*20000,z:(random()-.5)*20000});
  for(const p of points)for(const margin of [-10000,-300,-1,0,1,100,192,500])
    assert.strictEqual(landscape.cityAt(p.x,p.z,margin),cities.find(city=>capitalBoundary(city,p.x,p.z)<=margin));
});
