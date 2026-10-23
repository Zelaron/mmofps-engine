import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, PLAYER, VEHICLE, WEAPONS, World, type InputCmd, type WeaponDef } from '@shared/index';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';

function crew(population=48) {
  const game=new Game(1337);
  Object.defineProperty(game,'frontier',{value:{territories:[],order:()=>undefined,recordCombat(){}},writable:true});
  const p=new ServerPlayer(12,'crew',null,true,{x:0,y:0,z:0});p.faction=1;p.vehicleId=800;
  Object.assign(p.state,{vehicle:VEHICLE.JEEP,vehicleId:800,seat:1,grounded:true});
  const hull:ServerVehicle={id:800,type:VEHICLE.JEEP,x:0,y:0,z:0,heading:0,health:1000,occupant:900,gunner:p.id,respawnAtTick:-1};
  game.players.set(p.id,p);game.vehicles.set(hull.id,hull);
  for(let i=1;i<population;i++){
    const ally=new ServerPlayer(100+i,'ally',null,true,{x:10000+i,y:0,z:0});ally.faction=1;game.players.set(ally.id,ally);
  }
  return {game,p,hull};
}
const addHuman=(game:Game,id=5000,x=2000,sink=false)=>{
  const p=new ServerPlayer(id,'observer',sink?{send(){}}:null,false,{x,y:0,z:0});game.reattachPlayer(p);return p;
};

test('remote perception admits only large canonical ground-crew campaigns outside every human candidate radius',()=>{
  const {game,p}=crew();const eligible=()=>game.remoteGroundPerception(p,390);
  assert.equal(eligible(),true);
  const human=addHuman(game);human.state.alive=false;
  human.state.px=1170;assert.equal(eligible(),false,'dead sinkless humans protect the exact expanded boundary');
  human.state.px=1170+1e-7;assert.equal(eligible(),true);
  const second=addHuman(game,5001,100);assert.equal(eligible(),false,'every human is considered');
  second.state.px=2000;assert.equal(eligible(),true);
  for(const state of [{vx:257},{vz:NaN},{py:Infinity},{airlift:{source:1,destination:2,startTick:0,durationTicks:600}}]){
    const old={...human.state};Object.assign(human.state,state);assert.equal(eligible(),false);Object.assign(human.state,old);
  }
  human.airlift={source:1,destination:2,start:0,x:2000,y:0,z:0,health:100};assert.equal(eligible(),false);human.airlift=undefined;
  human.vehicleId=p.vehicleId;assert.equal(eligible(),false,'human crew ownership overrides a stale far pose');human.vehicleId=-1;
  const nativeTrace=game.world.trace,nativeSdf=game.world.sdf;
  game.world.trace=nativeTrace.bind(game.world);assert.equal(eligible(),false);game.world.trace=nativeTrace;
  game.world.sdf=nativeSdf.bind(game.world);assert.equal(eligible(),false);game.world.sdf=nativeSdf;
  delete (game.world as Partial<World>).trace;
  const original=World.prototype.trace;try{World.prototype.trace=function(...args){return original.apply(this,args);};assert.equal(eligible(),false);}finally{World.prototype.trace=original;}
  for(const vehicle of [VEHICLE.NONE,VEHICLE.JET,VEHICLE.GUNBOAT]){p.state.vehicle=vehicle;assert.equal(eligible(),false);}p.state.vehicle=VEHICLE.JEEP;
  p.state.grounded=false;assert.equal(eligible(),false);p.state.grounded=true;
  p.state.vx=101;assert.equal(eligible(),false);p.state.vx=0;
  const small=crew(47);assert.equal(small.game.remoteGroundPerception(small.p,390),false);
  Object.defineProperty(game,'frontier',{value:null});assert.equal(eligible(),false);
});

test('same-tick admission and equal-size roster replacement invalidate prepared observer lists',()=>{
  const {game,p}=crew(),bot=new Bot(p,1337),internal=bot as unknown as Internal;
  assert.equal(game.remoteGroundPerception(p,390),true);
  assert.equal(internal.refreshPerception(game),false);internal.losCheckAt=24;
  const human=addHuman(game,5000,30);assert.equal(game.remoteGroundPerception(p,390),false);
  assert.equal(internal.refreshPerception(game),true);assert.equal(internal.losCheckAt,game.tick,'same-tick observer membership wakes the retained perception');
  game.removePlayer(human.id);assert.equal(game.remoteGroundPerception(p,390),true);
  game.removePlayer(101);
  const watcher=new ServerPlayer(6000,'bot observer',{send(){}},true,{x:20000,y:0,z:0});game.reattachPlayer(watcher);
  assert.equal(game.players.size,48);assert.equal(game.remoteGroundPerception(p,390),false,'custom bot observers retain baseline even at a distance');
});

type Internal={losCheckAt:number;losOk:boolean;enemyId:number;losStarted:boolean;refreshPerception(game:Game):boolean};
function policyFixture(blocked=false) {
  const {game,p,hull}=crew(1),bot=new Bot(p,1337),internal=bot as unknown as Internal;
  const enemy=new ServerPlayer(2,'enemy',null,true,{x:0,y:0,z:-100});enemy.faction=2;game.players.set(enemy.id,enemy);
  // Isolate scheduling against deterministic geometry. Canonical admission
  // and override rejection are independently exercised above.
  let remote=true;game.remoteGroundPerception=()=>remote;
  game.shouldThinkBot=()=>game.tick%6===0;
  const traces:{tick:number;x:number;z:number}[]=[];
  game.world.sdf=()=>1000;
  game.world.trace=(x,y,z,dx,dy,dz,range)=>{
    traces.push({tick:game.tick,x:x+dx*range,z:z+dz*range});
    const dist=blocked?Math.min(10,range):range;
    return {hit:blocked,dist,x:x+dx*dist,y:y+dy*dist,z:z+dz*dist,nx:0,ny:1,nz:0};
  };
  const step=(tick:number)=>{game.tick=tick;const cmd=bot.think(game);p.lastCmd=cmd;return cmd;};
  return {game,p,hull,bot,enemy,internal,traces,step,setRemote:(value:boolean)=>{remote=value;}};
}
type PolicyFixture=ReturnType<typeof policyFixture>;

test('remote repeated LOS uses 24 ticks, preserving initial staggering and existing six-tick thoughts',()=>{
  const remote=policyFixture(),near=policyFixture();near.setRemote(false);
  for(let tick=0;tick<=60;tick++){remote.step(tick);near.step(tick);}
  assert.deepEqual(remote.traces.map(t=>t.tick),[0,6,30,54]);
  assert.deepEqual(near.traces.map(t=>t.tick),[0,6,18,30,42,54]);
  assert.ok(remote.p.lastCmd!.buttons&BTN.FIRE);
  assert.equal(remote.p.lastCmd!.seq,near.p.lastCmd!.seq,'only perception timing changes, not ordinary thought cadence');
});

test('occluded scans keep their original first stagger and two-candidate rotation without starvation',()=>{
  const f=policyFixture(true);
  for(let i=3;i<=5;i++){const q=new ServerPlayer(i,'enemy',null,true,{x:(i-2)*30,y:0,z:-100});q.faction=2;f.game.players.set(i,q);}
  for(let tick=0;tick<=90;tick++)f.step(tick);
  assert.deepEqual(f.traces.map(t=>t.tick),[0,0,18,18,42,42,66,66,90,90]);
  assert.equal(new Set(f.traces.map(t=>Math.round(t.x))).size,4);
  assert.equal(f.p.lastCmd!.buttons&BTN.FIRE,0);
});

test('interest/provider promotion refreshes before a cached command can return',()=>{
  const f=policyFixture();f.step(0);f.step(6);assert.equal(f.internal.losCheckAt,30);
  f.setRemote(false);const before=f.traces.length;f.step(7);
  assert.equal(f.traces.length,before+1);assert.equal(f.internal.losCheckAt,16);
  f.step(8);assert.equal(f.traces.length,before+1,'promotion is consumed once');
});

test('new soldier or hull damage wakes once then uses baseline deadlines until quiet',()=>{
  const changes:((f:PolicyFixture)=>void)[]=[f=>{f.p.health--;},f=>{f.p.regenBlockUntil+=60;},f=>{f.hull.health--;}];
  for(const change of changes){
    const f=policyFixture();f.step(0);f.step(6);const before=f.traces.length;change(f);f.step(7);
    assert.equal(f.traces.length,before+1);assert.equal(f.internal.losCheckAt,16);
    f.step(8);f.step(12);assert.equal(f.traces.length,before+1,'the hurt window does not force repeated scans');
    change(f);f.step(13);assert.equal(f.traces.length,before+1,'continued damage retains the baseline deadline');
    f.step(73);change(f);f.step(74);assert.equal(f.traces.length,before+2,'damage after a quiet second wakes immediately again');
  }
});

test('sustained four-tick damage never drives LOS faster than baseline and observer promotion still wakes',()=>{
  const f=policyFixture();
  for(let tick=0;tick<=126;tick++){
    if(tick>=7&&tick<=31&&(tick-7)%4===0){f.p.health--;f.p.regenBlockUntil=tick+300;}
    f.step(tick);
  }
  assert.deepEqual(f.traces.map(t=>t.tick),[0,6,7,18,30,42,54,66,78,90,102,126]);
  const promoted=policyFixture();promoted.step(0);promoted.step(6);promoted.p.health--;promoted.step(7);
  promoted.setRemote(false);promoted.step(8);
  assert.deepEqual(promoted.traces.map(t=>t.tick),[0,6,7,8],'observer/provider promotion is independent of the damage quiet window');
});

test('a newly acquired target changing hull wakes on its first following tick',()=>{
  const f=policyFixture();f.step(0);assert.equal(f.internal.enemyId,f.enemy.id);
  f.enemy.vehicleId=901;f.enemy.state.vehicle=VEHICLE.JEEP;
  f.step(1);assert.deepEqual(f.traces.map(t=>t.tick),[0,1]);
});

test('dead, changed-faction and out-of-range targets stop retained fire on a deferred tick',()=>{
  const changes:((f:PolicyFixture)=>void)[]=[f=>{f.enemy.state.alive=false;},f=>{f.enemy.faction=1;},f=>{f.enemy.state.pz=-400;}];
  for(const change of changes){
    const f=policyFixture();f.step(0);f.step(6);assert.ok(f.p.lastCmd!.buttons&BTN.FIRE);change(f);
    const result=f.step(7);assert.equal(result.buttons&BTN.FIRE,0);assert.equal(f.internal.enemyId,-1);
  }
});

test('boarding, death and aircraft-target transitions release the extended deadline immediately',()=>{
  const changes:((f:PolicyFixture)=>void)[]=[f=>{f.p.vehicleId=900;},f=>{f.p.state.seat=0;},f=>{f.p.state.alive=false;},f=>{f.enemy.state.vehicle=VEHICLE.JET;}];
  for(const change of changes){
    const f=policyFixture();f.step(0);f.step(6);change(f);f.game.tick=7;
    assert.equal(f.internal.refreshPerception(f.game),true);assert.equal(f.internal.losCheckAt,7);
  }
});

test('held remote LOS never bypasses current cover or newly introduced hull damage',()=>{
  const f=policyFixture();let wall=false;
  f.game.world.trace=World.prototype.trace;
  f.game.world.sdf=(_x,y,z)=>wall?Math.min(y,Math.abs(z+40)-1):y;
  f.step(0);f.step(6);assert.ok(f.internal.losOk);const deadline=f.internal.losCheckAt;
  const fire=f.game as unknown as {fireHitscan(p:ServerPlayer,cmd:InputCmd,def:WeaponDef,attachment?:{x:number;y:number;z:number}):void};
  const command={...f.p.lastCmd!,yaw:0,pitch:0},def={...WEAPONS[1],spread:0,range:150};
  const shoot=()=>fire.fireHitscan(f.p,command,def,{x:0,y:PLAYER.EYE_HEIGHT,z:0});
  wall=true;f.step(7);shoot();assert.equal(f.enemy.health,100);assert.equal(f.internal.losCheckAt,deadline);
  wall=false;
  const movingHull:ServerVehicle={id:901,type:VEHICLE.JEEP,x:0,y:0,z:-40,heading:0,health:1000,occupant:-1,respawnAtTick:-1};
  f.game.vehicles.set(movingHull.id,movingHull);f.step(8);shoot();
  assert.ok(movingHull.health<1000);assert.equal(f.enemy.health,100,'new hull takes the exact hit while LOS remains cached');
  f.game.vehicles.delete(movingHull.id);f.step(9);shoot();assert.ok(f.enemy.health<100,'removing current cover exposes the target without waiting for a LOS scan');
});
