import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER, TICK_DT } from '@shared/constants';
import { BTN, stepMove, type InputCmd } from '@shared/movement';
import { VehicleCollisionField, setVehicleColliders, type VehicleColliderPose } from '@shared/vehicle-collision';
import { VEHICLE, VEHICLE_VARIANT } from '@shared/vehicles';
import { World } from '@shared/worldgen';
import { BotSimulation, BOT_LOD_MIN_POPULATION } from '../src/bot-simulation.js';
import { movingHullCanReach } from '../src/bot-moving-hull.js';
import { ServerPlayer } from '../src/game.js';

const input=(buttons:number=BTN.FORWARD):InputCmd=>({seq:1,buttons,weapon:0,yaw:-Math.PI/2,pitch:0,renderTick:0,renderFrac:0});
const hull=(patch:Partial<VehicleColliderPose>={}):VehicleColliderPose=>({id:900,type:VEHICLE.JEEP,x:10,y:0,z:0,heading:0,health:100,vx:2,...patch});
function roster():ServerPlayer[] {
  return Array.from({length:BOT_LOD_MIN_POPULATION},(_,i)=>{
    const p=new ServerPlayer(i,`bot ${i}`,null,true,{x:i?10000:0,y:.1,z:0});
    p.botRosterIndex=i;p.state.grounded=true;return p;
  });
}
function flatWorld():World {
  const world=new World(1337);
  world.sampleColumn=()=>({h:0}) as ReturnType<World['sampleColumn']>;
  world.collectTransportPlan=()=>({routes:[],pods:[]}) as unknown as ReturnType<World['collectTransportPlan']>;
  world.collectCityLifts=()=>[];world.liquidAt=()=>undefined;
  world.collectRegion=()=>({sites:[],boulders:[],pads:[],solids:[],cuts:[],vegetation:[],foundations:[]});
  world.sdf=(_x,y)=>y;world.gradient=(_x,_y,_z,out)=>{out.x=0;out.y=1;out.z=0;};
  return world;
}

test('moving hull admission uses complete bodies and both motions instead of the broad-phase depot bubble',()=>{
  const field=new VehicleCollisionField(),s=roster()[0].state,dt=4*TICK_DT;
  const check=(pose:VehicleColliderPose)=>{
    field.replace(10,[pose]);const selected=field.select(s,dt,10);
    assert.ok(selected?.hulls.length,'the ordinary controller deliberately selects this wider neighbourhood');
    return movingHullCanReach(selected,s,dt);
  };
  assert.equal(check(hull()),false,'a distant parallel convoy permits bounded pedestrian movement');
  assert.equal(check(hull({x:2})),true,'actual body contact retains immediate shared physics');
  assert.equal(check(hull({x:10,vx:-100})),true,'an incoming fast hull consumes the full relative travel bound');
  s.vx=100;assert.equal(check(hull()),true,'existing fast pedestrian motion is included even without HYPER');s.vx=0;
  assert.equal(check(hull({x:5.5})),true,'the acceleration and contact margin cover newly approaching bodies');
  assert.equal(check(hull({x:9,type:VEHICLE.JET,variant:VEHICLE_VARIANT.NOCTURNE,roll:Math.PI/2,pitch:Math.PI/3})),true,
    'the complete rotating aircraft geometry is covered, not the small controller radius');
  assert.equal(check(hull({x:0,y:20,type:VEHICLE.JET,variant:VEHICLE_VARIANT.NOCTURNE})),false,
    'a vertically separated hull cannot meet the entire capsule during four ticks');
  assert.equal(movingHullCanReach(undefined,s,dt),false);
});

test('moving support and newly received hull poses promote before deferred carry or contact',()=>{
  const field=new VehicleCollisionField(),s=roster()[0].state,dt=4*TICK_DT;
  s.px=-1;s.py=2.055;s.grounded=true;
  field.replace(10,[hull({x:7,vx:120})]);
  const selection=field.select(s,dt,10)!;
  assert.ok(selection.hulls[0].beforeX<s.px+.001);
  assert.equal(movingHullCanReach(selection,s,dt),true,'old roof support may still carry this actor toward an obstruction');
  selection.carry(s);assert.ok(s.px>6.9,'the fixture really is standing on the previous roof');
  s.px=0;s.py=.1;
  field.replace(11,[hull()]);assert.equal(movingHullCanReach(field.select(s,dt,11),s,dt),false);
  field.update(11,hull({x:1}));
  assert.equal(movingHullCanReach(field.select(s,dt,11),s,dt),true,'same-tick live pose updates are never hidden by the admission proof');
});

test('distant moving hulls preserve four-tick elapsed movement and ordinary swept wall collision',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  // A 16 cm wall remains the shared controller's responsibility while a
  // parallel vehicle remains inside its broad phase throughout the run.
  world.sdf=(x,y,z)=>Math.min(y,Math.max(Math.abs(x-2)-.08,Math.abs(y-1)-1,Math.abs(z)-2));
  world.gradient=(x,y,z,out)=>{
    const e=.001,dx=world.sdf(x+e,y,z)-world.sdf(x-e,y,z),dy=world.sdf(x,y+e,z)-world.sdf(x,y-e,z),dz=world.sdf(x,y,z+e)-world.sdf(x,y,z-e);
    const n=Math.hypot(dx,dy,dz)||1;out.x=dx/n;out.y=dy/n;out.z=dz/n;
  };
  let elapsed=0,maxStep=0;
  for(let tick=1;tick<=60;tick++){
    setVehicleColliders(world,tick,[hull({x:p.state.px,z:10})]);
    sim.prepare(tick,players,[]);
    const dt=sim.physicsDt(world,p,input(),TICK_DT,tick);elapsed+=dt;maxStep=Math.max(maxStep,dt);
    if(dt)stepMove(world,p.state,input(),dt,tick);
    assert.ok(p.state.px<2-PLAYER.RADIUS,'complete shared swept collision cannot skip the thin wall');
  }
  assert.ok(p.state.px>1.3);assert.equal(maxStep,4*TICK_DT);
  assert.ok(Math.abs(elapsed-1)<1e-9);assert.equal(p.state.simulationTick,60);
  assert.equal(sim.stats.batchedTicks,45);assert.equal(sim.stats.batchedSteps,15);
});

test('live contact, human interest and HYPER flush all pending movement immediately',()=>{
  for(const promotion of ['hull','human','hyper'] as const){
    const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
    setVehicleColliders(world,1,[hull()]);sim.prepare(1,players,[]);
    assert.equal(sim.physicsDt(world,p,input(),TICK_DT,1),0);
    if(promotion==='hull')setVehicleColliders(world,2,[hull({x:1})]);
    if(promotion==='human')players.push(new ServerPlayer(500,'human',null,false,{x:100,y:0,z:0}));
    sim.prepare(2,players,[]);
    const dt=sim.physicsDt(world,p,input(promotion==='hyper'?BTN.HYPER|BTN.FORWARD:BTN.FORWARD),TICK_DT,2);
    assert.equal(dt,2*TICK_DT,`${promotion} promotion includes the previously deferred tick`);
    sim.prepare(3,players,[]);
    assert.equal(sim.physicsDt(world,p,input(promotion==='hyper'?BTN.HYPER:0),TICK_DT,3),TICK_DT,
      `${promotion} remains immediate and does not duplicate old elapsed time`);
  }
});
