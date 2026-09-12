import {test} from 'node:test';
import assert from 'node:assert/strict';
import {World,MAT,type RoadSegment} from '@shared/worldgen';
import {RoadField,rasterRoadSegment,type RoadGrid} from '../src/render/road-field.js';

function sample(data:Uint8Array,grid:RoadGrid,x:number,z:number):number {
  const px=(x-grid.x)/grid.step-.5,pz=(z-grid.z)/grid.step-.5,ix=Math.floor(px),iz=Math.floor(pz),tx=px-ix,tz=pz-iz;
  const at=(x:number,z:number)=>data[(z*grid.size+x)*4]/255*64-32;
  return (at(ix,iz)*(1-tx)+at(ix+1,iz)*tx)*(1-tz)+(at(ix,iz+1)*(1-tx)+at(ix+1,iz+1)*tx)*tz;
}
test('diagonal roads remain continuous across independent terrain LODs and map boundaries',()=>{
  const road:RoadSegment={a:{x:-40,y:30,z:18},b:{x:180,y:31,z:164},width:5.8,trail:false,id:'road'};
  for(const step of [2,6]) {
    const grids:RoadGrid[]=[{x:-64,z:-64,size:128,step},{x:-32,z:-64,size:128,step}];
    const data=grids.map(g=>{const d=new Uint8Array(g.size*g.size*4);d.fill(255);rasterRoadSegment(d,g,road);return d;});
    for(let t=.2;t<=.7;t+=.01) {
      const x=road.a.x+(road.b.x-road.a.x)*t,z=road.a.z+(road.b.z-road.a.z)*t;
      for(let i=0;i<grids.length;i++)assert.ok(sample(data[i],grids[i],x,z)<-2,'lane must not become disconnected triangles');
    }
  }
});
test('terrain previews and final meshes can use the same base palette without baked road triangles',()=>{
  const world=new World(1337),base=world.column(0,0),a=new Float32Array(3),b=new Float32Array(3);
  const col={...base,city:undefined,road:{distance:0,height:0,width:5.8,trail:false,dx:1,dz:0,gradeWeight:1}};
  world.vertexColor(MAT.ROAD,0,0,0,col,a,0,1,false);
  world.vertexColor(MAT.SNOW,0,0,0,{...col,road:{...col.road,distance:40}},b,0,1,false);
  assert.deepEqual(a,b,'worker LOD and temporary coverage leave road width to the fragment field');
});

test('volcanic road triangles retain basalt before and outside the continuous gravel field',()=>{
  const world=new World(1337),x=2102.495,z=-658.759,col=world.column(x,z);
  const empty={sites:[],solids:[],pads:[],cuts:[],vegetation:[],boulders:[]};
  assert.ok(col.volc>.4 && col.road && col.road.distance<1);
  assert.equal(world.material(x,col.h,z,col,1,empty),MAT.ROAD,'gameplay retains road footsteps');
  assert.equal(world.material(x,col.h,z,col,1,empty,false),MAT.BASALT,
    'rendering must not expose snow-colored triangles underneath the gravel');
  const withoutRoad={...col,road:undefined};
  assert.equal(world.material(x,col.h,z,withoutRoad,1,empty,false),MAT.BASALT,
    'interpolated mesh columns need no additional road lookup');
});

test('fast travel across recenter boundaries cannot starve the far road map',()=>{
  const roads=new RoadField(new World(1337));
  try {
    for(let i=0;i<500&&roads.uniforms.roadFarBounds.value.z===1;i++)roads.update(i%2?2000:0,0);
    assert.ok(roads.uniforms.roadFarBounds.value.z>10000,'a complete map must become visible while moving');
    const retained=roads.uniforms.roadFarMap.value;
    roads.update(6000,0);
    assert.equal(roads.uniforms.roadFarMap.value,retained,'old roads remain visible while the next map is prepared');
  }finally{roads.dispose();}
});
