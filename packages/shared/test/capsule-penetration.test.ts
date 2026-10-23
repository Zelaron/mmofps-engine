import assert from 'node:assert/strict';
import {test} from 'node:test';
import {World,cavePathPoint,type ColumnData,type Region} from '@shared/worldgen';
import {capsuleClearance,capsulePenetrates} from '@shared/physics';
import {transportPose} from '@shared/transport';
import {transitWorld} from '@shared/transit-motion';

test('capsule penetration keeps the strict depth boundary and leaves numeric clearance unchanged',()=>{
  const world=new World(1337);
  for(const depth of [0,.005,.025])for(const value of [-.1,-depth-1e-12,-depth,-0,0,1e-12,.8,Infinity]){
    let bounded=0,ordinary=0;
    world.sdf=(_x,_y,_z,signOnly=false)=>{
      if(signOnly)bounded++;else ordinary++;
      return signOnly?Math.min(value,1e-9):value;
    };
    assert.equal(capsulePenetrates(world,0,0,0,depth),value < -depth,`${value} < -${depth}`);
    assert.equal(ordinary,0,'the boolean proof needs no complete positive distances');
    if(value < -depth)assert.equal(bounded,1,'one violating shell sample settles the predicate');
    else assert.equal(bounded,70,'clearance requires the entire original shell stencil');
    assert.equal(capsuleClearance(world,0,0,0),value,'public numeric clearance is unchanged');
    assert.equal(ordinary,70);
  }
  for(const invalid of [-1,NaN,Infinity])assert.throws(()=>capsulePenetrates(world,0,0,0,invalid),RangeError);
});

test('capsule penetration equals full clearance through smooth pads, cuts and thin walls',()=>{
  const world=new World(1337);
  const col:ColumnData={h:0,temp:0,moist:0,desert:0,entr:0,entrRaw:0,volc:0,lavaY:-1000};
  const region:Region={sites:[],boulders:[],vegetation:[],
    pads:[{x:0,y:-.3,z:0,hx:2,hy:.3,hz:2}],
    solids:[{x:3,y:1,z:0,hx:.025,hy:1,hz:2}],
    cuts:[{x:1,y:.4,z:0,hx:.35,hy:1,hz:.5}]};
  world.collectCities=()=>[];world.column=()=>col;world.regionAt=()=>region;
  for(const x of [-2.1,-1,0,.65,1,1.35,2.4,2.6,3,3.4])for(const y of [-.03,.005,.1,.3,2.1]){
    const full=capsuleClearance(world,x,y,0);
    for(const depth of [0,.005,.025])assert.equal(capsulePenetrates(world,x,y,0,depth),full < -depth,`${x},${y}/${depth}`);
  }
  world.sdf=(_x,y)=>Math.max(.00001,Math.abs(y-.2));
  assert.equal(capsulePenetrates(world,0,0,0),false,'a positive nonmetric minimum remains empty');
});

test('capsule penetration retains generated city/cave geometry and live camp or train changes',()=>{
  const world=new World(7331);
  const points=world.collectCities().map(c=>({x:c.x+c.radius*.75,z:c.z}));
  const cave=world.collectCaveSites(-960,960,-960,960)[0];
  assert.ok(cave);points.push(cavePathPoint(cave,cave.mouthLength-3));
  for(const point of points){
    const h=world.terrainHeight(point.x,point.z);
    for(const offset of [-.1,0,.005,.1,8]){
      const full=capsuleClearance(world,point.x,h+offset,point.z);
      for(const depth of [0,.005,.025])assert.equal(capsulePenetrates(world,point.x,h+offset,point.z,depth),full < -depth);
    }
  }
  const site={id:1,owner:1,faction:1 as const,type:0,x:200,y:200,z:200,facing:0};
  for(const installed of [false,true,false]){
    if(installed)world.outposts.add(site);else world.outposts.remove(site.id);
    assert.equal(capsulePenetrates(world,site.x,site.y-.4,site.z,.005),installed,'camp edits are visible on the next proof');
    assert.equal(capsulePenetrates(world,site.x,site.y-.4,site.z,.005),capsuleClearance(world,site.x,site.y-.4,site.z)<-.005);
  }
  const route=world.collectTransportPlan().routes.find(r=>r.kind==='train')!;
  for(const seconds of [route.dwell+3,route.dwell+13]){
    world.motionTime=seconds;
    const pose=transportPose(route,seconds);
    for(const y of [-.2,1,3,5]){
      const point=transitWorld(pose,0,y,0);
      assert.equal(capsulePenetrates(world,point.x,point.y,point.z,.005),capsuleClearance(world,point.x,point.y,point.z)<-.005);
    }
  }
});
