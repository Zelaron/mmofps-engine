import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, type ColumnData } from '@shared/worldgen';
import { BTN, createMoveState, stepMove } from '@shared/movement';
import { stepWeaponState } from '@shared/weapons';
import { setVehicleColliders } from '@shared/vehicle-collision';
import { VEHICLE } from '@shared/vehicles';
import type { CampaignOrder, Territory } from '@shared/frontier';
import { connectedGround, GroundDetour, supportedTerrainRise } from '../src/bot-ground-navigation.js';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer } from '../src/game.js';
import type { Frontier } from '../src/frontier.js';

const start={x:0,y:.006,z:0},goal={x:100,z:0};
function fieldWorld(field:(x:number,y:number,z:number)=>number=(_x,y)=>y,height:(x:number,z:number)=>number=()=>0){
  const world=new World(1337);
  world.sdf=world.sdfCol=(x,y,z)=>world.outposts.distance(x,y,z,field(x,y,z));
  world.sampleColumn=world.column=(x,z)=>({h:height(x,z)}) as ColumnData;
  world.liquidAt=()=>undefined;
  return world;
}
const box=(x:number,y:number,z:number,cx:number,cy:number,cz:number,hx:number,hy:number,hz:number)=>
  Math.max(Math.abs(x-cx)-hx,Math.abs(y-cy)-hy,Math.abs(z-cz)-hz);

// Reference the original exhaustive choice using the connector's returned
// coordinates, independently of the new pre-validation endpoint calculation.
function exhaustiveLeg(world:World,origin:typeof start,destination:typeof goal){
  const yaw=Math.atan2(-(destination.x-origin.x),-(destination.z-origin.z));
  const candidates=[0,.7,-.7,1.4,-1.4,2.1,-2.1,Math.PI].map(turn=>{
    const dx=-Math.sin(yaw+turn),dz=-Math.cos(yaw+turn);
    const points=connectedGround(world,origin,{x:origin.x+dx*16,z:origin.z+dz*16},0);
    const end=points?.at(-1);
    return {points,dx,dz,side:Math.sign(turn)||1,score:end?Math.hypot(destination.x-end.x,destination.z-end.z):Infinity};
  });
  let best:typeof candidates[number]|undefined;
  for(const candidate of candidates)if(candidate.score<(best?.score??Infinity))best=candidate;
  return {candidates,leg:best&&{points:best.points!.filter((_,i)=>i%4===3||i===best.points!.length-1),side:best.side,dx:best.dx,dz:best.dz}};
}
function chosenLeg(detour:GroundDetour){
  const current=(detour as unknown as {current?:{points:typeof start[];side:number;dx:number;dz:number}}).current;
  return current&&{points:current.points,side:current.side,dx:current.dx,dz:current.dz};
}

test('endpoint pruning preserves complete exhaustive waypoints and spends no probes on worse flat-ground candidates',()=>{
  for(const [x,z,gx,gz] of [[0,0,100,0],[-0,-0,-100,0],[-2464.0966969682504,1617.900047631592,-6009.6076951545865,-5306],
    [1e12+.3,-1e12+.7,1e12+400,-1e12-800],[.1,.2,31.7,-83.9]]){
    const world=fieldWorld(),origin={x,y:.006,z},destination={x:gx,z:gz},detour=new GroundDetour();
    const expected=exhaustiveLeg(world,origin,destination).leg;
    assert.ok(detour.begin(world,createMoveState(x,.006,z),destination,'rounding',100,0));
    assert.deepEqual(chosenLeg(detour),expected,'coordinates, order, side and heading retain exact floating-point results');
  }
  const world=fieldWorld(),trace=world.trace.bind(world);let calls=0;
  world.trace=(...args)=>{calls++;return trace(...args);};
  connectedGround(world,start,{x:16,z:-Math.cos(-Math.PI/2)*16},0);const winningCalls=calls;calls=0;
  const detour=new GroundDetour();assert.ok(detour.begin(world,createMoveState(0,.006,0),goal,'flat',100,0));
  assert.equal(calls,winningCalls,'only the winning supported route needs full validation');
});

test('a blocked nearest leg cannot prune alternatives, and an equally good later leg retains the first validated choice',()=>{
  const world=fieldWorld((x,y,z)=>Math.min(y,box(x,y,z,2,2,0,.12,2,.2)));
  const expected=exhaustiveLeg(world,start,goal);
  assert.equal(expected.candidates[0].points,null,'the closest endpoint has a wall on its approach');
  assert.ok(expected.candidates[1].points&&expected.candidates[2].points);
  assert.equal(expected.candidates[1].score,expected.candidates[2].score,'the two supported sides are an exact score tie');
  const trace=world.trace.bind(world);let calls=0;world.trace=(...args)=>{calls++;return trace(...args);};
  for(const turn of [0,.7]){
    const yaw=-Math.PI/2+turn;
    connectedGround(world,start,{x:-Math.sin(yaw)*16,z:-Math.cos(yaw)*16},0);
  }
  const necessaryCalls=calls;calls=0;
  const detour=new GroundDetour();assert.ok(detour.begin(world,createMoveState(0,.006,0),goal,'blocked',100,0));
  assert.deepEqual(chosenLeg(detour),expected.leg);
  assert.equal(chosenLeg(detour)?.side,1,'equal scores preserve the earlier side');
  assert.equal(calls,necessaryCalls,'the equal and worse alternatives are pruned only after a valid choice exists');
});

test('support-following feelers admit a mild native-traced grade but not an unsustainable climb or upright wall',()=>{
  const mild=fieldWorld((x,y)=>y-x*.35,x=>x*.35),state=createMoveState(0,.03,0);
  const hit=mild.trace(0,state.py+1.05,0,1,0,0,4,false);
  assert.ok(hit.hit,'the old fixed-height feeler rejects this ordinary rise');
  assert.equal(supportedTerrainRise(mild,state,-Math.PI/2,hit,0),true);
  const steep=fieldWorld((x,y)=>y-x*.9,x=>x*.9);
  assert.equal(connectedGround(steep,start,{x:4,z:0},0),null,'a legal collision normal alone does not prove sustained grounded travel');
  const wall=fieldWorld((x,y,z)=>Math.min(y,box(x,y,z,2,2,0,.12,2,4)));
  assert.equal(connectedGround(wall,start,{x:4,z:0},0),null);
  assert.equal(supportedTerrainRise(wall,state,-Math.PI/2,wall.trace(0,1.05,0,1,0,0,4,false),0),false);
});

test('connected legs reject water, unsupported gaps, narrow ledges and full capsule headroom obstructions',()=>{
  const gap=fieldWorld((x,y)=>y-(x>1.4&&x<2.7?-8:0));
  assert.equal(connectedGround(gap,start,{x:4,z:0},0),null);
  const rail=fieldWorld((_x,y,z)=>y-(Math.abs(z)<.2?0:-8));
  assert.equal(connectedGround(rail,start,{x:4,z:0},0),null,'centre support cannot authorize a narrow unsupported footprint');
  const roof=fieldWorld((x,y,z)=>Math.min(y,box(x,y,z,2,2,0,3,.2,3)));
  assert.equal(connectedGround(roof,start,{x:4,z:0},0),null,'the head probe includes the capsule top, not just eye height');
  const water=fieldWorld();water.liquidAt=(x)=>x>2?{id:1,kind:'water',surfaceY:1,bottomY:-3,distance:-10,flowX:0,flowZ:0}:undefined;
  assert.equal(connectedGround(water,start,{x:4,z:0},0),null);
  const inside=fieldWorld((_x,y)=>y-2,()=>2);
  assert.equal(connectedGround(inside,start,{x:4,z:0},0),null,'a zero-distance hit from inside solid is not support');
});

test('static connector scans are cached for twelve ticks, with immediate vertical, camp and provider invalidation',()=>{
  const world=fieldWorld(),state=createMoveState(0,.006,0),detour=new GroundDetour();
  let traces=0;const trace=world.trace.bind(world);world.trace=(...args)=>{traces++;return trace(...args);};
  assert.ok(detour.begin(world,state,goal,'same',100,0));
  assert.ok(detour.follow(world,state,'same',0));traces=0;
  for(let tick=1;tick<12;tick++)assert.ok(detour.follow(world,state,'same',tick));
  assert.equal(traces,0,'unchanged close decisions must not run the support/body chain again');
  detour.follow(world,state,'same',12);assert.ok(traces>0&&traces<60,'one short bounded connector is refreshed');
  traces=0;state.py+=.6;detour.follow(world,state,'same',13);assert.ok(traces>0,'vertical departure invalidates cached support');

  const campWorld=fieldWorld(),campState=createMoveState(0,.006,0),campDetour=new GroundDetour();
  assert.ok(campDetour.begin(campWorld,campState,goal,'camp',100,0));campDetour.follow(campWorld,campState,'camp',0);
  campWorld.outposts.add({id:5,owner:1,faction:1,type:1,x:2,y:0,z:0,facing:0});
  assert.deepEqual(campDetour.follow(campWorld,campState,'camp',1),{x:0,z:0},'a newly built camp stops the cached route immediately');

  const replaced=fieldWorld(),replacement=new GroundDetour(),p=createMoveState(0,.006,0);
  replacement.begin(replaced,p,goal,'replace',100,0);replacement.follow(replaced,p,'replace',0);
  replaced.sdf=(x,y,z)=>Math.min(y,box(x,y,z,2,2,0,.1,2,4));
  assert.deepEqual(replacement.follow(replaced,p,'replace',1),{x:0,z:0},'a replaced field provider cannot reuse an old proof');
});

test('a hull entering a cached leg stops it before the next support deadline, and bounded retry retains its obstacle side',()=>{
  const world=fieldWorld(),state=createMoveState(0,.006,0),detour=new GroundDetour();
  assert.ok(detour.begin(world,state,goal,'hull',100,0));detour.follow(world,state,'hull',0);
  setVehicleColliders(world,1,[{id:90,type:VEHICLE.TANK,x:4,y:0,z:0,heading:0,health:1000,vx:-3}]);
  assert.deepEqual(detour.follow(world,state,'hull',1),{x:0,z:0});
  let traces=0;const trace=world.trace.bind(world);world.trace=(...args)=>{traces++;return trace(...args);};
  for(let tick=2;tick<60;tick++)assert.deepEqual(detour.follow(world,state,'hull',tick),{x:0,z:0});
  assert.equal(traces,0,'a blocked leg waits; it cannot start a route auction every thought');
  setVehicleColliders(world,61,[]);
  const resumed=detour.follow(world,state,'hull',61);
  assert.ok(resumed&&resumed.x>1,'the original bounded retry deadline resumes after the hull leaves');
  assert.equal(detour.follow(world,state,'hull',3600),undefined,'the fixed recovery deadline expires even behind a blocker');
  assert.equal(detour.active,false);
});

test('a failed unsupported plan waits three seconds before spending its probe budget again',()=>{
  const world=fieldWorld(()=>1),state=createMoveState(0,.006,0),detour=new GroundDetour();
  let traces=0;const trace=world.trace.bind(world);world.trace=(...args)=>{traces++;return trace(...args);};
  assert.equal(detour.begin(world,state,goal,'void',100,0),false);
  assert.equal(traces,8,'all eight candidates retain their support probe when none can be validated');traces=0;
  for(let tick=1;tick<180;tick++)assert.equal(detour.begin(world,state,goal,'void',100,tick),false);
  assert.equal(traces,0,'a missing route cannot trigger an auction on every brain decision');
  assert.equal(detour.begin(world,state,goal,'void',100,180),false);assert.ok(traces>0);
});

test('active surface recovery releases displaced underground and cave walkers, including during a blocked-leg wait',()=>{
  for(const cave of [false,true]){
    const world=fieldWorld(),state=createMoveState(0,.006,0),detour=new GroundDetour();
    let columns=0;
    world.sampleColumn=(x)=>{columns++;return {h:0,...(cave&&x>.5?{cave:{}}:{})} as ColumnData;};
    assert.ok(detour.begin(world,state,goal,'surface',100,0));
    detour.follow(world,state,'surface',0);columns=0;
    for(let tick=1;tick<12;tick++)detour.follow(world,state,'surface',tick);
    assert.equal(columns,0,'unchanged cached legs do not add a column query to every thought');
    setVehicleColliders(world,12,[{id:90,type:VEHICLE.TANK,x:4,y:0,z:0,heading:0,health:1000,vx:-3}]);
    assert.deepEqual(detour.follow(world,state,'surface',12),{x:0,z:0});
    if(cave)state.px=.8;else state.py=-6;
    assert.equal(detour.follow(world,state,'surface',13),undefined,'release before retry or sixty-second expiry');
    assert.equal(detour.active,false);
  }
});

function botFixture(){
  const game=new Game(1337),world=fieldWorld();Object.defineProperty(game,'world',{value:world});
  world.collectRoadSegments=()=>[];world.collectCities=()=>[];
  world.collectTransportPlan=()=>({routes:[],pods:[],stations:[],harbors:[],lifts:[],solids:[],bridges:[],accesses:[]});
  const p=new ServerPlayer(19,'detouring infantry',null,true,start);p.faction=1;p.state.grounded=true;
  game.players.set(p.id,p);game.shouldThinkBot=()=>true;
  const objective:Territory={id:'held',name:'Objective',kind:'relay',x:100,y:0,z:-12,radius:30,owner:1,influence:1,contested:false};
  const order:CampaignOrder={baseId:'base',targetId:objective.id,name:'Travel',x:100,z:-12,phase:'attack',squad:1,staging:{x:100,y:0,z:-12}};
  Object.defineProperty(game,'frontier',{value:{territories:[objective],order:()=>order} as unknown as Frontier});
  const bot=new Bot(p,1337),internal=bot as unknown as {groundDetour:GroundDetour;campaignCourse(g:Game,o:Territory):void;
    campaignState:unknown;routeGoal:string;route:{x:number;y:number;z:number}[];routeIndex:number;navigationAt:number;
    walkProgress:{x:number;z:number;best:number;at:number;seen:number};targetX:number;targetZ:number};
  const activate=()=>{game.tick+=200;internal.groundDetour.begin(world,p.state,goal,'held:attack:100,0',100,game.tick);assert.ok(internal.groundDetour.active);};
  return {game,world,p,bot,internal,objective,order,activate};
}

test('the real quiet input branch reaches short contour points and cancels changed goals, combat, boarding and death',()=>{
  const f=botFixture();f.activate();
  f.p.state.px=2;let command=f.bot.think(f.game);
  assert.ok(command.buttons&BTN.FORWARD,'a two-metre-away contour point must not inherit the ordinary three-metre stop threshold');
  f.objective.x=105;f.game.tick++;f.bot.think(f.game);
  assert.equal(f.internal.groundDetour.active,false,'same-ID effective coordinate changes cancel immediately');
  f.objective.x=100;f.activate();f.order.phase='assemble';f.game.tick++;f.bot.think(f.game);
  assert.equal(f.internal.groundDetour.active,false,'a new staging phase cancels even when its coordinates coincide');
  f.order.phase='attack';
  f.objective.x=100;f.activate();
  const enemy=new ServerPlayer(50,'close attacker',null,true,{x:10,y:.006,z:0});enemy.faction=2;enemy.state.grounded=true;
  f.game.players.set(enemy.id,enemy);f.game.tick++;f.bot.think(f.game);
  assert.equal(f.internal.groundDetour.active,false,'normal close combat releases the walking recovery');
  f.game.players.delete(enemy.id);f.activate();f.p.state.vehicle=VEHICLE.JEEP;f.game.tick++;f.bot.think(f.game);
  assert.equal(f.internal.groundDetour.active,false,'boarding cannot retain a pedestrian detour');
  f.p.state.vehicle=0;f.activate();f.p.state.alive=false;f.game.tick++;f.bot.think(f.game);
  assert.equal(f.internal.groundDetour.active,false);
});

test('recovery keeps the blocked road waypoint and its distance rather than cutting toward the final objective',()=>{
  const f=botFixture();f.objective.x=3000;f.game.tick=240;
  Object.assign(f.internal,{routeGoal:'held:125,0',route:[{x:100,y:0,z:0},{x:200,y:0,z:0}],routeIndex:0,navigationAt:9999,
    walkProgress:{x:100,z:0,best:100,at:60,seen:239}});
  f.internal.campaignCourse(f.game,f.objective);
  const state=(f.internal.groundDetour as unknown as {current:{goal:{x:number;z:number};entryBest:number}}).current;
  assert.deepEqual(state.goal,{x:100,y:0,z:0});assert.equal(state.entryBest,100);
  f.p.state.px=20;f.game.tick+=12;f.internal.campaignCourse(f.game,f.objective);
  assert.equal(f.internal.groundDetour.active,false,'supported progress toward the road point can release recovery even thousands of metres from the final goal');
  assert.equal(f.internal.targetX,100);assert.equal(f.internal.routeIndex,0,'ordinary ordered road travel resumes');
});

test('campaign navigation resumes its cave escape immediately after a surface detour loses surface admission',()=>{
  const f=botFixture();f.activate();
  f.internal.groundDetour.follow(f.world,f.p.state,'held:attack:100,0',f.game.tick);
  const exit={x:8,y:-6,z:4};
  Object.assign(f.internal,{walkEscape:{goal:'held:4,0',points:[exit],index:0,until:f.game.tick+600}});
  f.p.state.py=-6;f.game.tick++;
  f.internal.campaignCourse(f.game,f.objective);
  assert.equal(f.internal.groundDetour.active,false);
  assert.equal(f.internal.targetX,exit.x);
  assert.equal(f.internal.targetZ,exit.z,'the former surface target cannot shadow the cave exit');
});

test('the captured Meridian hillside marcher escapes through normal bot commands and canonical ninety-second movement',()=>{
  const game=new Game(1337),p=new ServerPlayer(4294967872,'captured marcher',null,true,
    {x:-2464.0966969682504,y:34.88953616855902,z:1617.900047631592});
  p.botRosterIndex=132;p.faction=1;p.weapon=1;p.state.grounded=true;
  Object.assign(p.state,{vx:6.2646652123102,vz:-5.016699527019262,simulationTick:8233});
  game.players.set(p.id,p);game.pickups.clear();game.vehicles.clear();game.wildlife.creatures.clear();
  const objective:Territory={id:'city-2--128',name:'Vesper west relay',kind:'city',baseId:'base-city-2',
    x:-6020,y:82.32903637017068,z:-5300,radius:42,owner:2,influence:1,contested:false};
  const order:CampaignOrder={baseId:'base-city-2',targetId:objective.id,name:'Capture Vesper Reach',x:-6020,z:-5300,
    phase:'attack',squad:7,staging:{x:-2832.95207174425,y:39.94917233653645,z:2097.988415764179}};
  Object.defineProperty(game,'frontier',{value:{territories:[objective],order:()=>order} as unknown as Frontier});
  game.shouldThinkBot=()=>!p.state.grounded||(game.tick+132)%12===0;
  const bot=new Bot(p,1337),internal=bot as unknown as {groundDetour:GroundDetour};
  Object.assign(bot,{targetX:-6009.6076951545865,targetZ:-5306,repathAtTick:8352,
    routeGoal:'city-2--128:-250,-221',route:[],routeIndex:0,navigationAt:8508,
    walkProgress:{x:-6009.6076951545865,z:-5306,best:7778.869696155705,at:8160,seen:8232},
    walkAvoidUntil:8264,walkAvoidYaw:1.8732388705987542,
    // Isolate the captured marching order; nearby physical geometry remains
    // native, while unrelated vehicle/pickup/orbital decisions are absent.
    airliftScanAt:Infinity});
  const distance=()=>Math.hypot(-6009.6076951545865-p.state.px,-5306-p.state.pz),initial=distance();
  let entered=false,released=false,air=0,streak=0,maxAir=0;
  for(let frame=1;frame<=5400;frame++){
    game.tick=8233+frame;game.world.motionTime=game.tick/60;
    const command=bot.think(game);entered ||= internal.groundDetour.active;
    if(entered&&!internal.groundDetour.active)released=true;
    stepWeaponState(p,command.weapon,command.buttons,1/60);
    stepMove(game.world,p.state,command,1/60,game.tick);p.lastCmd=command;
    if(!p.state.grounded){air++;maxAir=Math.max(maxAir,++streak);}else streak=0;
    assert.ok(p.state.alive);
  }
  assert.ok(entered&&released,'the brain persists around the obstruction and returns to its original order');
  assert.ok(initial-distance()>250,'ordinary movement makes sustained progress beyond the captured oscillation');
  assert.ok(air<540&&maxAir<90,'the detour must not replace the loop with a long unsupported climb and slide');
});
