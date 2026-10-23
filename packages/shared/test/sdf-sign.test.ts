import assert from 'node:assert/strict';
import {test} from 'node:test';
import {World,cavePathPoint,type ColumnData,type Region} from '@shared/worldgen';
import {capsuleClearance,sphereFieldContact} from '@shared/physics';
import {BTN,createMoveState,stepMove} from '@shared/movement';
import {transportBoxes,transportPose} from '@shared/transport';
import {transitWorld} from '@shared/transit-motion';

function canonicalWorld(seed:number):World {
  const world=new World(seed);
  // Injected fields remain authoritative, even when an internal caller asks
  // for a sign bound. This instance deliberately supplies full magnitudes.
  world.sdf=function(x,y,z){return World.prototype.sdf.call(this,x,y,z,false);};
  return world;
}
function assertSign(world:World,x:number,y:number,z:number):void {
  const canonical=world.sdf(x,y,z),bounded=world.sdf(x,y,z,true);
  assert.equal(bounded>0,canonical>0,`sign at ${x},${y},${z}`);
  if(canonical<=0)assert.equal(bounded,canonical,'solid depth and zero stay exact');
}

test('sign bounds preserve smooth-pad solid, cuts, boundaries and injected fields',()=>{
  const world=new World(1337);
  const col:ColumnData={h:0,temp:0,moist:0,desert:0,entr:0,entrRaw:0,volc:0,lavaY:-1000};
  const region:Region={sites:[],boulders:[],vegetation:[],
    pads:[{x:0,y:-.3,z:0,hx:2,hy:.3,hz:2}],
    solids:[{x:3,y:1,z:0,hx:.08,hy:1,hz:2}],
    cuts:[{x:1,y:.4,z:0,hx:.35,hy:1,hz:.5}],
  };
  world.collectCities=()=>[];world.column=()=>col;world.regionAt=()=>region;
  assert.ok(world.sdf(0,.1,0)<0,'two positive fields smooth into actual solid');
  assert.ok(world.sdf(1,.1,0)>0,'cut removes the blended solid');
  for(const x of [-2.2,-2,-1,0,.65,1,1.35,1.9,2,2.2,2.92,3,3.08,3.2])
    for(const y of [-.3,0,1e-12,.1,.3,1,2,2.1])for(const z of [-2.1,-2,-.5,0,.5,2,2.1])assertSign(world,x,y,z);
  region.pads.length=0;
  for(const x of [2.92,3,3.08])for(const y of [0,1,2])assertSign(world,x,y,0);
  world.sdf=(_x,y,_z)=>Math.max(.00001,Math.abs(y-.2));
  assert.equal(sphereFieldContact(world,0,.2,0,.42),null,'positive nonmetric minimum stays air');
});

test('sign bounds observe camp edits and exact moving transport surfaces',()=>{
  const world=new World(7331),site={id:1,owner:1,faction:1 as const,type:0,x:200,y:200,z:200,facing:0};
  for(const installed of [true,false,true]){
    if(installed)world.outposts.add(site);else world.outposts.remove(site.id);
    for(const dx of [-3,-2.8,0,2.8,3])for(const dy of [-.64,-.22,.2,1.65,3,3.3,4])
      for(const dz of [-3,-2.8,0,2.8,3])assertSign(world,site.x+dx,site.y+dy,site.z+dz);
    assert.equal(world.sdf(site.x,site.y-.2,site.z,true)<=0,installed);
  }
  const route=world.collectTransportPlan().routes.find(r=>r.kind==='train')!;
  for(const seconds of [0,route.dwell+3,route.dwell+13]){
    world.motionTime=seconds;
    const pose=transportPose(route,seconds);
    for(const box of transportBoxes(route,0))for(const dx of [-box.hx,0,box.hx])for(const dy of [-box.hy,0,box.hy]){
      const p=transitWorld(pose,box.x+dx,box.y+dy,box.z);
      assertSign(world,p.x,p.y,p.z);
    }
  }
});

test('generated cave and city contacts, traces and complete movement remain exact',()=>{
  for(const seed of [1337,7331,20077]){
    const a=canonicalWorld(seed),b=new World(seed);
    const points=a.collectCities().map(c=>({x:c.x+c.radius*.75,z:c.z}));
    for(const cave of a.collectCaveSites(-960,960,-960,960).slice(0,3))points.push(cavePathPoint(cave,cave.mouthLength-3));
    for(const p of points){
      const height=a.terrainHeight(p.x,p.z);
      for(const radius of [.42,1.35,2.35])for(const offset of [-.1,.006,.1,1]){
        const before=sphereFieldContact(a,p.x,height+radius+offset,p.z,radius);
        const saved=before?{...before}:null;
        assert.deepEqual(sphereFieldContact(b,p.x,height+radius+offset,p.z,radius),saved);
      }
      // Keep public numeric clearance intact: LOD proof callers use >1.
      assert.equal(capsuleClearance(b,p.x,height+8,p.z),capsuleClearance(a,p.x,height+8,p.z));
      for(const [dx,dy,dz] of [[0,-1,0],[.6,-.8,0],[0,-.8,.6]])
        assert.deepEqual(b.trace(p.x,height+9,p.z,dx,dy,dz,25),a.trace(p.x,height+9,p.z,dx,dy,dz,25));
      const states=[createMoveState(p.x,height+1,p.z),createMoveState(p.x,height+1,p.z)];
      for(let tick=1;tick<=75;tick++){
        const cmd={seq:tick,buttons:BTN.FORWARD|(tick===40?BTN.JUMP:0),yaw:.4,pitch:0,weapon:0,renderTick:0,renderFrac:0};
        assert.deepEqual(stepMove(b,states[1],cmd,1/60,tick),stepMove(a,states[0],cmd,1/60,tick));
        assert.deepEqual(states[1],states[0]);
      }
    }
  }
});
