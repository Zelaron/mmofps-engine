import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BotSimulation,BOT_LOD_MIN_POPULATION} from '../src/bot-simulation.js';
import {ServerPlayer} from '../src/game.js';
import {World} from '@shared/worldgen';
import {BTN,type InputCmd} from '@shared/movement';
import {PLAYER,TICK_DT,TICK_RATE} from '@shared/constants';
import {capsuleClearance,capsuleHasGroundSupport} from '@shared/physics';
import {setVehicleColliders} from '@shared/vehicle-collision';
import {VEHICLE} from '@shared/vehicles';

interface Proof {
  x:number;z:number;dx:number;dz:number;length:number;authored?:boolean;plane?:boolean;expires:number;
  rectangle?:{x0:number;x1:number;z0:number;z1:number;y0:number;y1:number};
}
function fixture(kind:'deck'|'plane'='deck',world=new World(7331)) {
  const city=world.collectCities().find(c=>c.theme==='aurelia')!;
  const origin=kind==='deck'?{x:city.x+30,y:city.y+.06+48+.1,z:city.z+160}:{x:5355.7,y:city.y+.1,z:4882.9};
  const players=Array.from({length:BOT_LOD_MIN_POPULATION},(_,i)=>{
    const p=new ServerPlayer(i,'rectangle',null,true,i?{x:0,y:.1,z:0}:origin);
    p.botRosterIndex=i;p.faction=1;p.state.grounded=true;return p;
  });
  const sim=new BotSimulation(),p=players[0];p.state.vx=p.state.vz=4;
  const input:InputCmd={seq:1,buttons:BTN.FORWARD,weapon:1,yaw:-Math.PI*.75,pitch:0,renderTick:0,renderFrac:0};
  const move=(tick:number)=>{world.motionTime=tick/TICK_RATE;sim.prepare(tick,players,[]);return sim.move(world,p,input,TICK_DT,tick);};
  const proof=()=>((sim as unknown as {slots:WeakMap<ServerPlayer,{path?:Proof}>}).slots.get(p)?.path);
  const lateral=()=>{p.state.px=origin.x+1.5;p.state.pz=origin.z+.35;};
  return{world,sim,p,players,input,origin,move,proof,lateral};
}

test('native deck and city-plane rectangles retain safe movement after a small heading change',()=>{
  for(const kind of ['deck','plane'] as const){
    const f=fixture(kind);assert.equal(f.move(1),true);
    const proof=f.proof()!,checks=f.sim.stats.pathChecks;
    assert.ok(proof.rectangle);assert.equal(!!proof.plane,kind==='plane');
    f.lateral();
    const before={...f.p.state};
    assert.ok(Math.abs((before.px-proof.x)*proof.dz-(before.pz-proof.z)*proof.dx)>.035);
    assert.equal(f.move(2),true);
    assert.equal(f.proof(),proof);assert.equal(f.sim.stats.pathChecks,checks,'the existing complete support proof is reused');
    assert.equal(f.p.state.py,f.origin.y);assert.equal(f.p.state.simulationTick,2);
    const limit=PLAYER.ACCEL*TICK_DT,wx=Math.SQRT1_2*PLAYER.RUN_SPEED;
    const dx=wx-before.vx,dz=wx-before.vz,length=Math.hypot(dx,dz);
    const vx=before.vx+dx*Math.min(1,limit/length),vz=before.vz+dz*Math.min(1,limit/length);
    assert.ok(Math.abs(f.p.state.px-(before.px+vx*TICK_DT))<1e-10);
    assert.ok(Math.abs(f.p.state.pz-(before.pz+vz*TICK_DT))<1e-10);
    assert.ok(capsuleClearance(f.world,f.p.state.px,f.p.state.py,f.p.state.pz)>=-.005);
    assert.ok(capsuleHasGroundSupport(f.world,f.p.state.px,f.p.state.py,f.p.state.pz));
  }
});

test('rectangle reuse checks both full footprints, the original height envelope, along range and expiry',()=>{
  const world=new World(7331);
  for(const kind of ['current outside','next outside','above','below','along','expired'] as const){
    const f=fixture('deck',world);assert.equal(f.move(1),true);
    const proof=f.proof()!,b=proof.rectangle!,pad=PLAYER.RADIUS+.12;f.lateral();
    if(kind==='current outside'){f.p.state.px=b.x0+pad-.02;f.p.state.pz=f.origin.z+.8;}
    if(kind==='next outside'){f.p.state.px=b.x1-pad-.02;f.p.state.pz=f.origin.z+.8;}
    if(kind==='above')f.p.state.py+=.02;
    if(kind==='below')f.p.state.py=b.y0-.01;
    if(kind==='along'){f.p.state.px=f.origin.x+2.72;f.p.state.pz=f.origin.z+2.72;}
    const checks=f.sim.stats.pathChecks;f.move(kind==='expired'?proof.expires+1:2);
    assert.equal(f.sim.stats.pathChecks,checks+1,`${kind} must obtain a new proof or retain shared physics`);
    assert.notEqual(f.proof(),proof,kind);
  }
});

test('changed native providers and an overridden public guard cannot extend an authored rectangle',()=>{
  const world=new World(7331);
  for(const kind of ['column','field','public guard','landscape'] as const){
    const f=fixture('deck',world);assert.equal(f.move(1),true);f.lateral();
    const proof=f.proof(),checks=f.sim.stats.pathChecks;
    const savedColumn=world.sampleColumn,savedField=world.sdf,savedGuard=world.hasNativeTerrainProviders;
    const landscape=(world as unknown as {landscape:{base:(...args:unknown[])=>unknown}}).landscape,savedBase=landscape.base;
    try{
      if(kind==='column')world.sampleColumn=savedColumn.bind(world);
      if(kind==='field')world.sdf=savedField.bind(world);
      if(kind==='public guard')world.hasNativeTerrainProviders=()=>true;
      if(kind==='landscape')landscape.base=savedBase.bind(landscape);
      assert.equal(World.prototype.hasNativeTerrainProviders.call(world),false,kind);
      f.move(2);
      assert.equal(f.sim.stats.pathChecks,checks+1,kind);
      assert.notEqual(f.proof(),proof,kind);
      assert.equal(f.proof()?.rectangle,undefined,'an injected provider cannot issue another extended certificate');
    }finally{
      world.sampleColumn=savedColumn;world.sdf=savedField;world.hasNativeTerrainProviders=savedGuard;landscape.base=savedBase;
    }
  }
});

test('live camps and incoming hulls interrupt off-center reuse before another static proof is needed',()=>{
  for(const kind of ['camp','hull'] as const){
    const f=fixture();assert.equal(f.move(1),true);f.lateral();
    const checks=f.sim.stats.pathChecks,before={...f.p.state};
    if(kind==='camp')f.world.outposts.add({id:99,owner:1,faction:1,type:1,x:before.px,y:before.py,z:before.pz,facing:0});
    else setVehicleColliders(f.world,2,[{id:500,type:VEHICLE.JEEP,x:before.px+1,y:before.py,z:before.pz,heading:0,health:100,vx:-10}]);
    assert.equal(f.move(2),false,kind);assert.deepEqual(f.p.state,before,kind);
    assert.equal(f.sim.stats.pathChecks,checks,'the live check precedes another support proof');
    assert.equal(World.prototype.hasNativeTerrainProviders.call(f.world),true,'static provider identity does not certify the absence of dynamic hazards');
  }
});
