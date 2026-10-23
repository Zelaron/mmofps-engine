import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BotSimulation, BOT_LOD_MIN_POPULATION } from '../src/bot-simulation.js';
import { ServerPlayer } from '../src/game.js';
import { BTN, stepMove, type InputCmd } from '@shared/movement';
import { PLAYER, TICK_DT, TICK_RATE } from '@shared/constants';
import { World } from '@shared/worldgen';
import { VEHICLE } from '@shared/vehicles';
import { setVehicleColliders } from '@shared/vehicle-collision';
import type { TransportRoute } from '@shared/transport';

const input=(buttons=0):InputCmd=>({seq:1,buttons,weapon:0,yaw:-Math.PI/2,pitch:0,renderTick:0,renderFrac:0});
function fixture(native=false) {
  const world=new World(1337);
  if(!native) {
    world.sdf=(_x,y)=>y;
    world.sampleColumn=()=>({h:0}) as ReturnType<World['sampleColumn']>;
    world.liquidAt=()=>undefined;
    world.collectRegion=()=>({sites:[],boulders:[],pads:[],solids:[],cuts:[],vegetation:[],foundations:[]});
    world.collectCityLifts=()=>[];
    world.collectTransportPlan=()=>({routes:[],pods:[{id:1,stationId:1,name:'Static pod',x:0,y:0,z:0}]}) as unknown as ReturnType<World['collectTransportPlan']>;
  }
  const players=Array.from({length:BOT_LOD_MIN_POPULATION},(_,i)=>{
    const p=new ServerPlayer(i,`pod bot ${i}`,null,true,{x:i?10000:0,y:.1,z:0});
    p.botRosterIndex=i;p.state.grounded=true;return p;
  });
  const p=players[0],sim=new BotSimulation();let sharedSteps=0;
  const advance=(tick:number,cmd=input())=>{
    sim.prepare(tick,players,[]);
    if(sim.move(world,p,cmd,TICK_DT,tick))return false;
    const dt=sim.physicsDt(world,p,cmd,TICK_DT,tick);
    assert.equal(dt,TICK_DT,'a pod approach keeps the ordinary per-tick movement horizon');
    stepMove(world,p.state,cmd,dt,tick);sharedSteps++;return true;
  };
  const prime=()=>{for(let tick=1;tick<=60;tick++)advance(tick);assert.ok(sim.stats.restTicks>30,'stationary contact must actually qualify');};
  return {world,players,p,sim,advance,prime,sharedSteps:()=>sharedSteps};
}

test('stationary pod contact reuses a bounded pose and movement resumes at full rate',()=>{
  const f=fixture();f.prime();
  assert.ok(f.sharedSteps()>=4&&f.sharedSteps()<25,'12-tick rest expires and refreshes with shared physics');
  const x=f.p.state.px,rest=f.sim.stats.restTicks;
  for(let tick=61;tick<=68;tick++)assert.equal(f.advance(tick,input(BTN.FORWARD)),true);
  assert.ok(f.p.state.px>x+.1,'a new movement command cannot hold the cached pose');
  assert.equal(f.sim.stats.restTicks,rest);
  assert.equal(f.sim.stats.batchedTicks,0,'the separate moving-pod batching veto stays in force');
  assert.equal(f.p.state.simulationTick,68);
});

test('captured Meridian pod gathering contact qualifies on native generated geometry',()=>{
  const f=fixture(true);
  Object.assign(f.p.state,{px:103.69195719682286,py:66.11244682413857,pz:8722.020083101397,vx:0,vy:0,vz:0});
  const plan=f.world.collectTransportPlan();
  assert.ok(plan.pods.some(p=>Math.hypot(p.x-f.p.state.px,p.z-f.p.state.pz)<3.2));
  const start={x:f.p.state.px,y:f.p.state.py,z:f.p.state.pz};f.prime();
  assert.ok(Math.hypot(f.p.state.px-start.x,f.p.state.py-start.y,f.p.state.pz-start.z)<.015);
  assert.equal(f.p.state.alive,true);assert.equal(f.p.state.grounded,true);
  assert.equal(f.p.state.simulationTick,60);
});

test('cached pod rest immediately yields to actions, human interest, hurt and flight states',()=>{
  for(const reason of ['jump','dodge','use','human','damage','charge','flight','boarding'] as const){
    const f=fixture();f.prime();let cmd=input();
    if(reason==='jump')cmd=input(BTN.JUMP);
    if(reason==='dodge')cmd=input(BTN.DODGE);
    if(reason==='use')cmd=input(BTN.USE);
    if(reason==='human')f.players.push(new ServerPlayer(999,'observer',null,false,{x:0,y:0,z:0}));
    if(reason==='damage'){f.p.regenBlockUntil=61+PLAYER.REGEN_DELAY*TICK_RATE;f.p.state.vx=2;}
    if(reason==='charge')f.p.airlift={source:1,destination:2,start:61,x:0,y:.1,z:0,health:100};
    if(reason==='flight')f.p.state.airlift={source:1,destination:2,startTick:61,durationTicks:900};
    if(reason==='boarding'){f.sim.resetMovement(f.p);f.p.state.vehicle=VEHICLE.JEEP;cmd=input(BTN.USE);}
    const rest=f.sim.stats.restTicks;f.sim.prepare(61,f.players,[]);
    assert.equal(f.sim.move(f.world,f.p,cmd,TICK_DT,61),false,reason);
    assert.equal(f.sim.physicsDt(f.world,f.p,cmd,TICK_DT,61),TICK_DT,reason);
    assert.equal(f.sim.stats.restTicks,rest,reason);
  }
});

test('live hull and transit contacts still promote a resting pod actor',()=>{
  for(const kind of ['hull','transit'] as const){
    const f=fixture();f.prime();
    if(kind==='hull')setVehicleColliders(f.world,61,[{id:500,type:VEHICLE.JEEP,x:1,y:0,z:0,heading:0,health:100,vx:12}]);
    else {
      const from={id:1,name:'A',x:0,y:0,z:0},to={id:2,name:'B',x:1000,y:0,z:0};
      const route:TransportRoute={id:1,name:'train',kind:'train',speed:100,dwell:3,phase:0,stops:[from,to],carOffsets:[0],
        legs:[{from,to,reverse:false,points:[from,to],distances:[0,1000],length:1000}]};
      const plan=f.world.collectTransportPlan();f.world.collectTransportPlan=()=>({...plan,routes:[route]});
    }
    const rest=f.sim.stats.restTicks;f.sim.prepare(61,f.players,[]);
    assert.equal(f.sim.move(f.world,f.p,input(),TICK_DT,61),false,kind);
    assert.equal(f.sim.physicsDt(f.world,f.p,input(),TICK_DT,61),TICK_DT,kind);
    assert.equal(f.sim.stats.restTicks,rest,kind);
  }
});

test('nearby lifts remain ineligible for pod rest even at an unchanged observed pose',()=>{
  const f=fixture();
  f.world.collectCityLifts=()=>[{id:7001,cityId:-1,x:0,z:0,bottom:0,top:20,hx:8,hz:12,phase:0,dwell:8}];
  f.sim.prepare(1,f.players,[]);
  assert.equal(f.sim.physicsDt(f.world,f.p,input(),TICK_DT,1),TICK_DT);
  f.sim.prepare(2,f.players,[]);
  assert.equal(f.sim.move(f.world,f.p,input(),TICK_DT,2),false);
  assert.equal(f.sim.stats.restTicks,0);
});
