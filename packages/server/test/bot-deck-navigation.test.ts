import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DeckNavigation,deckUnionCovers,type DeckRect} from '../src/bot-deck-navigation.js';
import {Bot} from '../src/bots.js';
import {Game,ServerPlayer} from '../src/game.js';
import {World,type Box} from '@shared/worldgen';
import {BTN,stepMove,type InputCmd} from '@shared/movement';
import {PLAYER,TICK_DT} from '@shared/constants';
import {PICKUP_HEALTH} from '@shared/protocol';
import {VEHICLE,vehicleDefinition} from '@shared/vehicles';

type TestBrain={walkSafety:DeckNavigation;walkCourse(game:Game,yaw:number):number;walkAvoidYaw:number;walkAvoidUntil:number;walkScanAt:number;
 failedPickupId:number;pickupId:number;failedVehicleId:number;campaign(game:Game):unknown};
const brain=(bot:Bot)=>bot as unknown as TestBrain;
const box=(x:number,z:number,hx:number,hz:number,y=0):Box=>({x,y:y-1,z,hx,hy:1,hz,capital:true});

test('deck support requires complete coplanar rectangle union, including gaps and cuts',()=>{
 const r:DeckRect={x0:-3,x1:3,z0:-2,z1:2};
 assert.equal(deckUnionCovers([box(-2,0,2,3),box(2,0,2,3)],[],0,r),true);
 assert.equal(deckUnionCovers([box(-2.000000001,0,2,3),box(2,0,2,3)],[],0,r),false);
 assert.equal(deckUnionCovers([box(-2,0,2,3),box(2,0,2,3,-.001)],[],0,r),false);
 const bend=[box(-2,0,3,1),box(0,2,1,3)];
 assert.equal(deckUnionCovers(bend,[],0,{x0:-.9,x1:.9,z0:-.9,z1:4}),true);
 assert.equal(deckUnionCovers(bend,[],0,{x0:-4,x1:.5,z0:-.5,z1:4}),false,'endpoint membership cannot bridge the inner void');
 assert.equal(deckUnionCovers([box(0,0,5,5)],[box(0,0,.1,.1)],0,r),false);
 assert.equal(deckUnionCovers(Array.from({length:25},()=>box(0,0,5,5)),[],0,r),false,'support work stays bounded');
});

function fixture(seed=7331,margin=5) {
 const game=new Game(seed,{frontier:true});
 game.players.clear();game.vehicles.clear();game.pickups.clear();game.wildlife.creatures.clear();game.projectiles.clear();
 const city=game.world.collectCities().find(c=>c.theme==='vesper')!,floor=city.y+.06,edge=city.z-100,x=city.x+82;
 const p=new ServerPlayer(19,'Deck walker',null,true,{x,y:floor+.1,z:edge+margin});p.faction=2;p.botRosterIndex=19;p.state.grounded=true;game.players.set(p.id,p);
 for(let i=0;i<47;i++){
  const q=new ServerPlayer(200+i,'Inactive peer',null,true,{x:city.x,y:floor+.1,z:city.z});
  q.faction=2;q.health=0;q.state.alive=false;q.respawnAtTick=Infinity;game.players.set(q.id,q);
 }
 game.tick=12000;
 const bot=new Bot(p,seed),goal={id:'native-deck-test',x,y:floor,z:edge-35,radius:1};
 // Only the assignment is fixed. World, transport, scheduler and controller stay native.
 brain(bot).campaign=()=>({objective:goal});
 return{game,p,bot,goal,city,floor,edge,x};
}
function run(f:ReturnType<typeof fixture>,frames:number) {
 let maxPending=0,maxStepTicks=0,previous=f.p.state.simulationTick;
 const before=f.game.botSimulation.stats.batchedSteps;
 for(let frame=0;frame<frames;frame++){
  f.game.queueInput(f.p,f.bot.think(f.game));
  const sim=f.game.botSimulation as unknown as {slots:WeakMap<ServerPlayer,{elapsed:number}>};
  maxPending=Math.max(maxPending,sim.slots.get(f.p)?.elapsed??0);f.game.step(2);
  const s=f.p.state;
  if(previous!==undefined&&s.simulationTick!==undefined&&s.simulationTick!==previous)maxStepTicks=Math.max(maxStepTicks,s.simulationTick-previous);
  previous=s.simulationTick;assert.ok(s.alive&&s.py>f.floor-1,'ordinary commands must remain on native authored support');
 }
 return{maxPending,maxStepTicks,batchedSteps:f.game.botSimulation.stats.batchedSteps-before};
}

test('fresh and retained Nocturne steering brakes before the native lip, including quiet thoughts',()=>{
 const game=new Game(7331),city=game.world.collectCities().find(c=>c.name==='Nocturne')!,floor=city.y+.06,edge=city.z-100,x=city.x+82;
 for(const c of [{margin:3,speed:9.5},{margin:5,speed:9.5},{margin:5,speed:9.5,retained:true},
  {margin:5,speed:9.5,retained:true,cadence:12},{margin:5,speed:0}]){
  const p=new ServerPlayer(19,'Lip',null,true,{x,y:floor+.1,z:edge+c.margin});p.state.grounded=true;p.state.vz=-c.speed;
  const bot=new Bot(p,7331),b=brain(bot);b.walkSafety.target('course','edge',x,edge-50);
  if(c.retained){b.walkAvoidYaw=0;b.walkAvoidUntil=12032;b.walkScanAt=12028;}
  let cmd:InputCmd|undefined;
  for(let frame=0;frame<180;frame++){
   game.tick=12000+frame;const wake=b.walkSafety.wake(p.state,game.tick,undefined,game.world);
   if(!cmd||frame%(c.cadence??1)===0||wake){const yaw=b.walkCourse(game,0);cmd={seq:frame+1,buttons:b.walkSafety.hold?0:BTN.FORWARD,weapon:1,yaw,pitch:0,renderTick:game.tick-6,renderFrac:0};}
   stepMove(game.world,p.state,cmd,TICK_DT,game.tick);assert.ok(p.state.py>floor-1,JSON.stringify(c));
  }
  assert.ok(p.state.pz>edge+.5,'the corrected path retains a margin inside the lip');
 }
});

test('deck leases retain native/provider, live hull, target and four-tick stopping guards',()=>{
 const f=fixture(),s={px:f.city.x+60,py:f.floor+.1,pz:f.city.z-50,vx:0,vy:0,vz:0,grounded:true},g=new DeckNavigation();
 assert.equal(g.wake(s,1,undefined,f.game.world),false);g.target('course','clear',s.px,s.pz-20);
 assert.equal(g.steer(f.game.world,s,0,1,1),0);assert.equal(g.wake(s,100,undefined,f.game.world),false,'deadline alone cannot add early thought work');
 f.game.vehicles.set(800,{id:800,type:VEHICLE.JEEP,x:s.px,y:f.floor+.05,z:s.pz-2.5,heading:0,health:vehicleDefinition(VEHICLE.JEEP)!.maxHealth,occupant:-1,gunner:-1,respawnAtTick:-1});
 f.game.step(2);const yaw=g.steer(f.game.world,s,0,2,1);assert.ok(g.hold||Math.abs(yaw!)>.1);
 f.game.vehicles.clear();f.game.step(2);g.reset();g.target('course','fast',s.px,s.pz-20);s.vz=-18;
 g.steer(f.game.world,s,0,3,1);assert.equal(g.wake({...s,pz:s.pz-5.2},4,undefined,f.game.world),true);
 s.vz=0;g.target('pickup',9,s.px,s.pz-20);g.steer(f.game.world,s,0,5,1);
 assert.equal(g.wake(s,6,{x:s.px+2,z:s.pz-20},f.game.world),true);
 g.target('course','provider',s.px,s.pz-20);g.steer(f.game.world,s,0,7,1);
 const original=f.game.world.trace;f.game.world.trace=function(...args){return original.apply(this,args);};
 assert.equal(g.wake(s,8,undefined,f.game.world),true);assert.equal(g.steer(f.game.world,s,0,8,1),undefined);assert.equal(g.hold,false);
 f.game.world.trace=original;
 const pad=PLAYER.RADIUS+.12+1e-6;
 g.lease={x:s.px,y:s.py,z:s.pz,yaw:0,tick:9,mode:'wall',x0:s.px-5,x1:s.px+5,z0:s.pz-4-pad,z1:s.pz+pad};
 assert.equal(g.wake({...s,pz:s.pz-.9,vz:-20},10,undefined,f.game.world),true,'wall intent uses the same stopping envelope');
 g.reset();assert.equal(g.lease,undefined);assert.equal(g.goal,undefined);
});

test('native edge safety covers real four-tick pending remote physics from rest and motion',()=>{
 for(const speed of [0,9.5]){
  const f=fixture();f.p.state.vz=-speed;const b=brain(f.bot);b.walkAvoidYaw=0;b.walkAvoidUntil=12032;b.walkScanAt=12028;
  const r=run(f,180);assert.ok(r.batchedSteps>0);assert.ok(r.maxPending>.03);assert.equal(r.maxStepTicks,4);
 }
});

test('native deck pickup approach collects reachable health and abandons an unsupported target',()=>{
 for(const reachable of [false,true]){
  const f=fixture(7331,reachable?12:5);f.p.health=40;f.p.regenBlockUntil=Infinity;
  const id=reachable?902:901;f.game.pickups.set(id,{id,kind:PICKUP_HEALTH,weapon:-1,x:reachable?f.x+4:f.x,y:f.floor+.4,z:reachable?f.edge+12:f.edge-12,availableAtTick:0,expiresAtTick:Infinity});
  run(f,reachable?100:360);
  if(reachable){assert.equal(f.game.pickups.has(id),false);assert.equal(f.p.health,75);}
  else{assert.equal(brain(f.bot).failedPickupId,id);assert.notEqual(brain(f.bot).pickupId,id);}
 }
});

test('native deck vehicle approach boards normally or abandons an unsupported diagonal',()=>{
 for(const reachable of [true,false]){
  const f=fixture(7331,reachable?20:5);f.goal.z=f.edge-1000;
  if(!reachable)f.p.state.px=f.city.x-118;
  const id=reachable?903:904,x=reachable?f.x+7:f.city.x-170,z=reachable?f.edge+20:f.edge-40;
  const support=f.game.world.trace(x,f.floor+2,z,0,-1,0,7);assert.ok(support.hit&&Math.abs(support.y-f.floor)<.1);
  f.game.vehicles.set(id,{id,type:VEHICLE.JEEP,x,y:f.floor+.05,z,heading:0,health:vehicleDefinition(VEHICLE.JEEP)!.maxHealth,occupant:-1,gunner:-1,respawnAtTick:-1,campaignFaction:2});
  run(f,reachable?120:420);
  if(reachable)assert.equal(f.p.vehicleId,id);
  else assert.ok(f.p.vehicleId===id||brain(f.bot).failedVehicleId===id);
 }
});

test('native deck navigation crosses a supported bridge bend and reaches its objective',()=>{
 const f=fixture(1337),turn={x:f.city.x-900,z:f.city.z};Object.assign(f.p.state,{px:turn.x+80,pz:turn.z});
 Object.assign(f.goal,{x:turn.x,z:f.city.z-100,radius:12});let reached=false,visited=false,active=0;
 for(let frame=0;frame<2400;frame++){
  f.game.queueInput(f.p,f.bot.think(f.game));f.game.step(2);const s=f.p.state;
  assert.ok(s.alive&&s.py>f.floor-1);if(brain(f.bot).walkSafety.active)active++;
  visited ||= Math.hypot(s.px-turn.x,s.pz-turn.z)<9;
  if(Math.hypot(s.px-f.goal.x,s.pz-f.goal.z)<f.goal.radius){reached=true;break;}
 }
 assert.equal(visited,true);assert.equal(reached,true,'safe inactivity is not successful navigation');assert.ok(active>0);
});
