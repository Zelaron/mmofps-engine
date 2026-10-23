import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER, TICK_DT, TICK_RATE } from '@shared/constants';
import { BTN, stepMove, type InputCmd } from '@shared/movement';
import { VEHICLE, vehicleDefinition } from '@shared/vehicles';
import { World, type Box } from '@shared/worldgen';
import { BotSimulation } from '../src/bot-simulation.js';
import { BotVehicleSimulation, stepBotGroundVehicle } from '../src/bot-vehicle-simulation.js';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';

const input=(buttons:number=BTN.FORWARD,seq=1):InputCmd=>({seq,buttons,weapon:0,yaw:-Math.PI/2,pitch:0,renderTick:0,renderFrac:0});
function crew(){
  const players=Array.from({length:48},(_,i)=>{
    const p=new ServerPlayer(i,`bot ${i}`,null,true,{x:i?10000:0,y:.05,z:0});
    p.faction=1;p.botRosterIndex=i;p.state.grounded=true;return p;
  });
  const driver=players[0],hull:ServerVehicle={id:500,type:VEHICLE.JEEP,x:0,y:.05,z:0,heading:-Math.PI/2,health:1000,occupant:0,respawnAtTick:-1};
  driver.vehicleId=hull.id;Object.assign(driver.state,{vehicle:VEHICLE.JEEP,vehicleId:hull.id,heading:hull.heading,seat:0});
  return{players,driver,hull};
}
function flatWorld(wall?:Box):World{
  const world=new World(1337);
  world.sampleColumn=()=>({h:0}) as ReturnType<World['sampleColumn']>;
  world.liquidAt=()=>undefined;
  world.collectTransportPlan=()=>({routes:[],pods:[]}) as unknown as ReturnType<World['collectTransportPlan']>;
  world.collectCityLifts=()=>[];
  world.collectRegion=()=>({sites:[],boulders:[],pads:[],solids:wall?[wall]:[],cuts:[],vegetation:[],foundations:[]});
  world.outposts.distance=(_x,_y,_z,best)=>best;
  world.sdf=(x,y,z)=>wall?Math.min(y,Math.max(Math.abs(x-wall.x)-wall.hx,Math.abs(y-wall.y)-wall.hy,Math.abs(z-wall.z)-wall.hz)):y;
  world.gradient=(x,y,z,out)=>{
    const e=.001,dx=world.sdf(x+e,y,z)-world.sdf(x-e,y,z),dy=world.sdf(x,y+e,z)-world.sdf(x,y-e,z),dz=world.sdf(x,y,z+e)-world.sdf(x,y,z-e);
    const n=Math.hypot(dx,dy,dz)||1;out.x=dx/n;out.y=dy/n;out.z=dz/n;
  };
  return world;
}

function crestWorld(){
  const world=flatWorld();let groundQueries=0;
  const height=(z:number)=>Math.max(0,z>=0?24-z*.34:24+z*.3);
  const slope=(z:number)=>height(z)<=0?0:z>=0?-.34:.3;
  world.sdf=(_x,y,z)=>(y-height(z))/Math.hypot(1,slope(z));
  world.sdfCol=(x,y,z)=>world.sdf(x,y,z);
  world.groundY=(_x,z)=>{groundQueries++;return height(z);};
  world.gradient=(_x,_y,z,out)=>{const n=Math.hypot(1,slope(z));out.x=0;out.y=1/n;out.z=-slope(z)/n;};
  return{world,height,queries:()=>groundQueries};
}

test('admitted remote convoys retain slope contact while omitting only the arcade crest impulse',()=>{
  const{players,driver,hull}=crew(),policy=new BotVehicleSimulation(),{world,height,queries}=crestWorld();
  Object.assign(driver.state,{px:0,py:height(.5)+.1,pz:.5,vx:0,vy:0,vz:-10,heading:0});
  const original={...driver.state},explicit={...original},command=input();
  // The original/default public controller and explicit opt-in agree exactly.
  stepMove(world,original,command,TICK_DT,1);
  stepMove(world,explicit,command,TICK_DT,1,true);
  assert.deepEqual(explicit,original);assert.ok(original.vy>2,'the fixture reaches a real assisted crest');
  assert.ok(queries()>=6,'ordinary crest assistance retains its three height probes');

  policy.prepare(0,true,players,[],[hull]);policy.movementEligible(driver,command,TICK_DT,300);
  policy.prepare(1,true,players,[],[hull]);assert.equal(policy.movementEligible(driver,command,TICK_DT,300),true);
  const count=queries();stepBotGroundVehicle(world,driver.state,command,TICK_DT,1);
  assert.equal(queries(),count,'an admitted remote step performs no sky-to-ground crest probes');
  assert.ok(driver.state.vy<original.vy-2);
  assert.deepEqual({...driver.state,vy:original.vy},original,'only the post-contact arcade upward impulse changes');

  for(let tick=2;tick<=180;tick++){
    policy.prepare(tick,true,players,[],[hull]);policy.movementEligible(driver,command,TICK_DT,300);
    stepBotGroundVehicle(world,driver.state,command,TICK_DT,tick);
    assert.ok(driver.state.py>=height(driver.state.pz)-.2,'ordinary sphere contact supports both sides of the crest');
  }
  assert.ok(driver.state.pz<-10,'the convoy proceeds down the far slope');
  assert.ok(driver.state.py<20,'gravity and descending contact remain active');
});

test('crest assistance remains canonical on human, crew, damage, boost and airborne promotion',()=>{
  for(const promotion of ['human','crew','damage','boost','airborne','unadmitted'] as const){
    const{players,driver,hull}=crew(),policy=new BotVehicleSimulation(),{world,height}=crestWorld();
    Object.assign(driver.state,{px:0,py:height(.5)+.1,pz:.5,vx:0,vy:0,vz:-10,heading:0});
    const command=input(promotion==='boost'?BTN.FORWARD|BTN.ALTFIRE:BTN.FORWARD);
    policy.prepare(0,true,players,[],[hull]);policy.movementEligible(driver,input(),TICK_DT,300);
    policy.prepare(1,true,players,[],[hull]);assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),true);
    const humans:ServerPlayer[]=[];
    if(promotion==='human'||promotion==='crew'){
      const human=new ServerPlayer(100,'human',null,false,{x:promotion==='human'?100:10000,y:0,z:0});
      if(promotion==='crew')human.vehicleId=hull.id;humans.push(human);
    }
    if(promotion==='damage')hull.health--;
    if(promotion==='airborne'){driver.state.grounded=false;driver.state.py+=10;}
    if(promotion==='unadmitted')policy.reset(driver);
    policy.prepare(2,true,[...players,...humans],humans,[hull]);
    assert.equal(policy.movementEligible(driver,command,TICK_DT,300),false,promotion);
    const expected={...driver.state};
    stepMove(world,expected,command,TICK_DT,2);
    stepBotGroundVehicle(world,driver.state,command,TICK_DT,2);
    assert.deepEqual(driver.state,expected,`${promotion} cannot retain an old convoy opt-out`);
  }
});

test('quiet remote crews think five times per second and promote immediately for humans, close enemies or hull damage',()=>{
  const{players,driver,hull}=crew(),policy=new BotVehicleSimulation();
  let thoughts=0;
  for(let tick=0;tick<60;tick++){
    policy.prepare(tick,true,players,[],[hull]);if(policy.shouldThink(driver,300))thoughts++;
  }
  assert.equal(thoughts,5);
  const human=new ServerPlayer(100,'human',null,false,{x:10000,y:0,z:0});
  human.vehicleId=hull.id;
  policy.prepare(61,true,[...players,human],[human],[hull]);
  assert.equal(policy.shouldThink(driver,300),true,'human gunner promotes even before crew pose is copied');
  assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false);
  human.vehicleId=-1;human.state.px=299;
  policy.prepare(62,true,[...players,human],[human],[hull]);
  assert.equal(policy.shouldThink(driver,300),true,'human interest is immediate');
  const enemy=players[1];enemy.faction=2;enemy.state.px=19;
  policy.prepare(63,true,players,[],[hull]);assert.equal(policy.shouldThink(driver,300),true);
  assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false,'close enemy interactions retain full motion');
  enemy.state.px=10000;hull.health-=1;
  policy.prepare(64,true,players,[],[hull]);assert.equal(policy.shouldThink(driver,300),true,'fresh hull damage promotes decisions');
  assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false);
  policy.prepare(125,true,players,[],[hull]);assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),true);
});

test('distant bot enemies raise aiming to ten Hz while bounded ground movement remains active',()=>{
  const{players,driver,hull}=crew(),policy=new BotVehicleSimulation(),enemy=players[1];
  enemy.faction=2;enemy.state.px=100;
  policy.prepare(0,true,players,[],[hull]);policy.shouldThink(driver,300);
  let thoughts=0;
  for(let tick=1;tick<=60;tick++){
    policy.prepare(tick,true,players,[],[hull]);
    if(policy.shouldThink(driver,300))thoughts++;
    assert.equal(policy.movementCadence(driver,input(BTN.FORWARD|BTN.FIRE),TICK_DT,300),4);
  }
  assert.equal(thoughts,10,'the approaching enemy raises decisions before the driver fires');
  driver.state.vx=17;
  assert.equal(policy.movementCadence(driver,input(BTN.FORWARD|BTN.FIRE),TICK_DT,300),3,'cruise keeps the existing hull displacement bound');
  enemy.state.px=19;
  policy.prepare(61,true,players,[],[hull]);
  assert.equal(policy.shouldThink(driver,300),true);
  assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false);
});

test('grouped crew queries retain live enemy poses, deaths, hull damage and refreshed allegiance',()=>{
  const{players,driver,hull}=crew(),policy=new BotVehicleSimulation(),other=players[1];
  other.state.px=10;
  policy.prepare(0,true,players,[],[hull]);policy.shouldThink(driver,300);
  policy.prepare(1,true,players,[],[hull]);
  assert.equal(policy.movementCadence(driver,input(),TICK_DT,300),4,'nearby allies retain the convoy policy');
  other.faction=2;
  policy.prepare(1,true,players,[],[hull]);
  assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false,'explicit same-tick preparation rebuilds allegiance groups');
  other.state.px=100;
  assert.equal(policy.movementCadence(driver,input(),TICK_DT,300),4,'positions are live references, not cached distances');
  other.state.px=10;other.state.alive=false;
  assert.equal(policy.movementCadence(driver,input(),TICK_DT,300),4,'death is observed within the current pass');
  other.state.alive=true;
  assert.equal(policy.shouldThink(driver,300),true,'a live close opponent promotes without rebuilding');
  other.state.px=100;hull.health-=1;
  assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false,'hull lookup retains the current mutable health');
});

test('remote crew promotion preserves exact horizontal and vertical boundaries',()=>{
  const{players,driver,hull}=crew(),policy=new BotVehicleSimulation(),enemy=players[1];
  driver.botRosterIndex=5;enemy.faction=2;
  policy.prepare(0,true,players,[],[hull]);policy.shouldThink(driver,300);
  policy.prepare(1,true,players,[],[hull]);
  // At tick one this roster phase distinguishes quiet (12 ticks), combat
  // (six ticks), and full promotion without exposing the private classifier.
  for(const [distance,height,cadence,think] of [
    [20-1e-9,0,0,true],[20,0,4,true],[150-1e-9,0,4,true],[150,0,4,false],
    [100,80-1e-9,4,true],[100,80,4,false],[100,-80,4,false],
    [NaN,0,4,false],[Infinity,0,4,false],[-0,0,0,true],
  ] as const){
    enemy.state.px=distance;enemy.state.pz=driver.state.pz;enemy.state.py=driver.state.py+height;
    assert.equal(policy.movementCadence(driver,input(),TICK_DT,300),cadence,`distance ${distance}, height ${height}`);
    assert.equal(policy.shouldThink(driver,300),think,`thought at distance ${distance}, height ${height}`);
  }
});

test('human query passes observe current membership and promote before reading hull health',()=>{
  const{players,driver,hull}=crew(),policy=new BotVehicleSimulation();
  const human=new ServerPlayer(100,'human',null,false,{x:300,y:0,z:0}),humans:ServerPlayer[]=[];
  policy.prepare(0,true,players,humans,[hull]);policy.shouldThink(driver,300);
  policy.prepare(1,true,players,humans,[hull]);
  let reads=0,health=hull.health;
  Object.defineProperty(hull,'health',{get(){reads++;return health;}});
  humans.push(human);
  assert.equal(policy.movementCadence(driver,input(),TICK_DT,300),4,'exactly300m retains existing admission');
  const before=reads;health--;
  human.state.px=300-1e-9;
  assert.equal(policy.movementCadence(driver,input(),TICK_DT,300),0,'same-pass live position immediately promotes');
  assert.equal(reads,before,'human proximity still short-circuits the hull query');
  human.state.px=10000;human.vehicleId=hull.id;
  assert.equal(policy.movementCadence(driver,input(),TICK_DT,300),0,'distant stale crew pose still promotes');
  assert.equal(reads,before,'crew interest also precedes hull health');
  human.vehicleId=-1;humans.length=0;
  assert.equal(policy.movementCadence(driver,input(),TICK_DT,300),0,'fresh damage is detected as soon as human interest clears');
  assert.ok(reads>before);
});

test('firing and alternate actions retain ten-Hz thoughts while boost promotes immediately',()=>{
  const{players,driver,hull}=crew(),policy=new BotVehicleSimulation();
  policy.prepare(0,true,players,[],[hull]);policy.shouldThink(driver,300);
  for(const mode of ['fire','alternate','boost'] as const){
    driver.lastCmd=input(mode==='fire'?BTN.FIRE:mode==='alternate'?BTN.ALTFIRE:0);
    driver.state.boosting=mode==='boost';let thoughts=0;
    for(let tick=1;tick<=60;tick++){
      policy.prepare(tick,true,players,[],[hull]);if(policy.shouldThink(driver,300))thoughts++;
    }
    assert.equal(thoughts,mode==='boost'?60:10,`${mode} keeps its required decision cadence`);
  }
});

test('ground cadence excludes fast boosts, aircraft, airborne motion, input transitions and passenger physics',()=>{
  const{players,driver,hull}=crew(),policy=new BotVehicleSimulation();
  policy.prepare(0,true,players,[],[hull]);assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false);
  policy.prepare(1,true,players,[],[hull]);assert.equal(policy.movementCadence(driver,input(),TICK_DT,300),4);
  driver.state.vx=17;assert.equal(policy.movementCadence(driver,input(),TICK_DT,300),3,'ordinary jeep cruise retains its safe existing cadence');
  driver.state.vx=30;assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false);
  driver.state.vx=0;
  for(const buttons of [BTN.USE,BTN.ALTFIRE])assert.equal(policy.movementEligible(driver,input(buttons),TICK_DT,300),false);
  driver.state.boosting=true;assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false);driver.state.boosting=false;
  driver.state.grounded=false;assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false);driver.state.grounded=true;
  driver.state.vehicle=VEHICLE.JET;assert.equal(policy.shouldThink(driver,300),true);assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false);
  driver.state.vehicle=VEHICLE.JEEP;driver.state.seat=1;assert.equal(policy.movementEligible(driver,input(),TICK_DT,300),false);
  driver.state.seat=0;policy.reset(driver);assert.equal(policy.shouldThink(driver,300),true,'new driver never inherits stale steering');
});

test('batched ground travel uses all elapsed time and collides with a thin wall',()=>{
  const{players,driver,hull}=crew(),sim=new BotSimulation(),world=flatWorld({x:8,y:3,z:0,hx:.08,hy:3,hz:10}),baseline={...driver.state};
  let elapsed=0,steps=0,maxDt=0;
  for(let tick=0;tick<=180;tick++){
    sim.prepare(tick,players,[hull]);
    const dt=sim.physicsDt(world,driver,input(),TICK_DT,tick);elapsed+=dt;maxDt=Math.max(maxDt,dt);
    if(dt){steps++;stepBotGroundVehicle(world,driver.state,input(),dt,tick);}
    stepMove(world,baseline,input(),TICK_DT,tick);
    assert.ok(driver.state.px<8,`a thin wall remains solid across the larger movement step at tick ${tick}: x=${driver.state.px}`);
  }
  assert.ok(driver.state.px>5,'the convoy advances before reaching the wall');
  assert.ok(baseline.px<8,'the same wall is solid in the ordinary 60 Hz controller');
  assert.ok(Math.abs(driver.state.px-baseline.px)<.4,'the batched collision resolves near the ordinary contact pose');
  assert.ok(steps<100,'remote hull physics is actually deferred');
  assert.equal(maxDt,4*TICK_DT,'slow travel uses the new bounded four-tick step');
  assert.ok(Math.abs(elapsed-181*TICK_DT)<1e-9,'deferred ticks preserve the complete elapsed time');
});

test('a boost promotion resolves a pending remainder with ordinary shared-physics substeps',()=>{
  const{driver}=crew(),world=flatWorld(),expected={...driver.state};
  driver.state.vx=40;expected.vx=40;
  const command=input(BTN.FORWARD|BTN.ALTFIRE);
  stepBotGroundVehicle(world,driver.state,command,4*TICK_DT,4);
  for(let tick=1;tick<=4;tick++)stepMove(world,expected,command,TICK_DT,tick);
  assert.deepEqual(driver.state,expected);
});

test('proven stationary hull contact is reused briefly while timers advance and input or human interest releases it',()=>{
  const{players,driver,hull}=crew(),sim=new BotSimulation(),world=flatWorld();
  driver.state.airSeconds=2;driver.state.boostFuel=.2;driver.state.dodgeCd=.8;
  const reusedBefore=sim.stats.vehicles.steps.reusedContact;
  for(let tick=0;tick<=120;tick++){
    sim.prepare(tick,players,[hull]);const dt=sim.physicsDt(world,driver,input(0),TICK_DT,tick);
    if(dt)stepBotGroundVehicle(world,driver.state,input(0),dt,tick);
  }
  assert.ok(sim.stats.vehicles.steps.reusedContact-reusedBefore>20,'a supported waiting convoy reuses its unchanged contact');
  assert.ok(Math.abs(driver.state.airSeconds!-(2+121*TICK_DT*5))<1e-8);
  assert.ok(Math.abs(driver.state.boostFuel-(.2+121*TICK_DT*.055))<1e-8);
  assert.equal(driver.state.dodgeCd,0);assert.equal(driver.state.px,0);
  for(let tick=121;tick<=150;tick++){
    sim.prepare(tick,players,[hull]);const dt=sim.physicsDt(world,driver,input(),TICK_DT,tick);
    if(dt)stepBotGroundVehicle(world,driver.state,input(),dt,tick);
  }
  assert.ok(driver.state.px>1,'a new drive command releases the stationary contact');
  const human=new ServerPlayer(100,'human',null,false,{x:driver.state.px,y:0,z:0});players.push(human);
  sim.prepare(151,players,[hull]);
  assert.equal(sim.physicsDt(world,driver,input(0),TICK_DT,151),3*TICK_DT,'human interest immediately flushes both deferred ticks plus the current tick');
  assert.equal(sim.shouldThink(driver),true);
});

test('Game keeps crew poses and weapon timers synchronized between deferred driver movements',()=>{
  const game=new Game(1337,{frontier:true}),{players,driver,hull}=crew(),world=flatWorld(),gunner=players[1];
  Object.assign(game.world,{sampleColumn:world.sampleColumn,liquidAt:world.liquidAt,collectTransportPlan:world.collectTransportPlan,
    collectCityLifts:world.collectCityLifts,collectRegion:world.collectRegion,sdf:world.sdf,gradient:world.gradient});
  game.world.outposts.distance=world.outposts.distance;game.vehicles.clear();game.vehicles.set(hull.id,hull);
  for(const p of players)game.players.set(p.id,p);
  gunner.vehicleId=hull.id;Object.assign(gunner.state,driver.state,{seat:1});hull.gunner=gunner.id;
  players[2].faction=2;players[2].state.px=100;
  const internals=game as unknown as {processPlayer(p:ServerPlayer):void;fireVehicleWeapons(p:ServerPlayer,cmd:InputCmd):void};
  let calls=0,shots=0;
  internals.fireVehicleWeapons=(p)=>{calls++;if(p===driver&&p.vehFireCd<=0){shots++;p.vehFireCd=.1;}};
  driver.vehFireCd=TICK_DT*1.5;driver.vehAltCd=.9;
  let stationaryTicks=0;
  for(let tick=0;tick<60;tick++){
    game.tick=tick;game.botSimulation.prepare(tick,players,[hull]);const x=driver.state.px;
    game.queueInput(driver,input(BTN.FORWARD|BTN.FIRE,tick+1));internals.processPlayer(driver);
    game.queueInput(gunner,input(0,tick+1));internals.processPlayer(gunner);
    if(driver.state.px===x)stationaryTicks++;
    assert.deepEqual([gunner.state.px,gunner.state.py,gunner.state.pz],[driver.state.px,driver.state.py,driver.state.pz]);
    assert.deepEqual([hull.x,hull.y,hull.z],[driver.state.px,driver.state.py,driver.state.pz]);
  }
  assert.ok(stationaryTicks>30);assert.ok(driver.state.px>3);
  assert.equal(calls,120,'both crew weapons run on all sixty authority ticks');
  assert.ok(shots>=8);assert.equal(driver.vehAltCd,0);
});

test('runover checks the whole batched movement segment without affecting mounted crew',()=>{
  const game=new Game(1337,{frontier:true}),{players,driver,hull}=crew(),pedestrian=players[1],gunner=players[2];
  for(const p of players)game.players.set(p.id,p);game.vehicles.set(hull.id,hull);
  const rr=vehicleDefinition(VEHICLE.JEEP)!.radius+PLAYER.RADIUS+.35;
  Object.assign(driver.state,{px:.5,vx:17});
  Object.assign(pedestrian.state,{px:0,py:0,pz:rr-.01});
  Object.assign(gunner.state,pedestrian.state,{vehicle:VEHICLE.JEEP,seat:1});gunner.vehicleId=hull.id;
  const internals=game as unknown as {sweepRunOver(p:ServerPlayer,from:{x:number;y:number;z:number}):void;damage(p:ServerPlayer,...args:unknown[]):void};
  const hit:number[]=[];internals.damage=p=>{hit.push(p.id);};
  internals.sweepRunOver(driver,{x:-.5,y:0,z:0});
  assert.deepEqual(hit,[pedestrian.id],'grazing contact between endpoints is detected and occupants stay exempt');
});
