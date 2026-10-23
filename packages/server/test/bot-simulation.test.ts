import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOT_FULL_SIM_RADIUS, BOT_SUPPORTED_GROUND_RADIUS, BOT_LOD_MIN_POPULATION, BotSimulation } from '../src/bot-simulation.js';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';
import { BTN, stepMove, type InputCmd } from '@shared/movement';
import { PLAYER, TICK_DT, TICK_RATE } from '@shared/constants';
import { CAPTURE_SECONDS } from '@shared/frontier';
import { World, type Box, type Region } from '@shared/worldgen';
import { setVehicleColliders } from '@shared/vehicle-collision';
import { VEHICLE } from '@shared/vehicles';
import type { TransportRoute } from '@shared/transport';
import { SWIMMING } from '@shared/liquids';
import { capitalSegmentDistance } from '@shared/capital-geometry';
import { vesperRoutes } from '@shared/vesper-city';
import type { CityDistrict } from '@shared/cities';

const cmd=(buttons:number=BTN.FORWARD,seq=1):InputCmd=>({seq,buttons,weapon:0,yaw:-Math.PI/2,pitch:0,renderTick:0,renderFrac:0});
function roster():ServerPlayer[] {
  return Array.from({length:BOT_LOD_MIN_POPULATION},(_,i)=>{
    const p=new ServerPlayer(i,`bot ${i}`,null,true,{x:i?10000:0,y:.1,z:0});
    p.state.grounded=true;p.botRosterIndex=i;return p;
  });
}
function flatWorld(wall?:Box):World {
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
function advance(sim:BotSimulation,world:World,p:ServerPlayer,players:ServerPlayer[],input:InputCmd,tick:number):number {
  sim.prepare(tick,players,[]);
  if(sim.move(world,p,input,TICK_DT,tick))return TICK_DT;
  const dt=sim.physicsDt(world,p,input,TICK_DT,tick);
  if(dt)stepMove(world,p.state,input,dt,tick);
  return dt;
}

function deckWorld(floor=10):{world:World;region:Region;deck:Box} {
  const world=flatWorld(),deck:Box={x:0,y:floor-1,z:0,hx:30,hy:1,hz:4,capital:true,floorY:0};
  const region:Region={sites:[],boulders:[],pads:[],solids:[deck],cuts:[],vegetation:[],foundations:[],capitalArea:true,capitalSegments:[]};
  world.sampleColumn=()=>({h:-20,city:{id:2,name:'Vesper',x:0,y:0,z:0,radius:100,seed:1,theme:'vesper'}}) as ReturnType<World['sampleColumn']>;
  world.collectRegion=()=>region;
  world.sdf=(x,y,z)=>{
    let d=y+20;
    for(const box of region.solids)d=Math.min(d,Math.max(Math.abs(x-box.x)-box.hx,Math.abs(y-box.y)-box.hy,Math.abs(z-box.z)-box.hz));
    for(const segment of region.capitalSegments??[])d=Math.min(d,capitalSegmentDistance(segment,x,y,z));
    return d;
  };
  return{world,region,deck};
}

function cityPlaneWorld(theme:CityDistrict['theme']):{world:World;city:CityDistrict;region:Region} {
  const world=flatWorld(),city:CityDistrict={id:3,name:'Plane',x:0,y:0,z:0,radius:100,seed:1,theme};
  const region:Region={sites:[],boulders:[],pads:[],solids:[],cuts:[],vegetation:[],foundations:[],capitalArea:!!theme,capitalSegments:[]};
  world.collectCities=()=>[city];world.collectCaveSites=()=>[];world.collectJungleTemples=()=>[];
  world.sampleColumn=()=>({h:0,city}) as ReturnType<World['sampleColumn']>;
  world.collectRegion=()=>region;
  return{world,city,region};
}

test('flat-city support advances on the exact canonical plane without inferring an elevated deck',()=>{
  for(const theme of ['aurelia',undefined] as const){
    const {world,city}=cityPlaneWorld(theme),players=roster(),p=players[0],sim=new BotSimulation();
    if(!theme)p.state.px=90; // A square city's exact corner region exceeds .85r.
    const input=theme?cmd():{...cmd(),yaw:0};
    for(let tick=1;tick<=60;tick++){
      sim.prepare(tick,players,[]);assert.equal(sim.move(world,p,input,TICK_DT,tick),true);
      assert.equal(p.state.py,city.y+.1);assert.equal(p.state.simulationTick,tick);
    }
    assert.equal(sim.stats.planeTicks,60);
    sim.resetMovement(p);p.state.py=city.y+10.1;sim.prepare(61,players,[]);
    assert.equal(sim.move(world,p,cmd(),TICK_DT,61),false,'an elevated actor cannot inherit distant ground support');
  }
});

test('city-plane proof covers the whole footprint and rejects boundaries, geometry and exceptional grading',()=>{
  const length=PLAYER.RUN_SPEED*24/TICK_RATE+.08;
  for(const kind of ['round edge','square edge','vesper','wall','shell','height','cave','station','access','temple','foundation','underground foundation'] as const){
    const {world,city,region}=cityPlaneWorld(kind==='square edge'?undefined:kind==='vesper'?'vesper':'aurelia'),sim=new BotSimulation();
    const proof=(sim as unknown as {authoredPath(w:World,x:number,y:number,z:number,dx:number,dz:number,length:number,tick:number):unknown}).authoredPath.bind(sim);
    let x=0,dx=1,dz=0;
    if(kind==='round edge'){x=84.7;dx=0;dz=1;assert.ok(Math.hypot(x,length)<85,'both centerline endpoints remain inside the conservative core');}
    if(kind==='square edge'){x=99.7;dx=0;dz=1;}
    if(kind==='wall')region.solids.push({x:1.013,y:1,z:0,hx:.025,hy:1,hz:2});
    if(kind==='shell')region.capitalSegments!.push({a:{x:1.013,y:.3,z:-2,radius:.025},b:{x:1.013,y:.3,z:2,radius:.4}});
    if(kind==='height')world.sampleColumn=(px)=>({h:px>1&&px<3?.01:0,city}) as ReturnType<World['sampleColumn']>;
    if(kind==='cave')world.collectCaveSites=()=>[{}] as ReturnType<World['collectCaveSites']>;
    if(kind==='station')world.collectTransportPlan=()=>({routes:[],pods:[],stations:[{x:-78,z:-80}]}) as unknown as ReturnType<World['collectTransportPlan']>;
    if(kind==='access')world.collectTransportPlan=()=>({routes:[],pods:[],accesses:[{x:2,startZ:-1,endZ:1}]}) as unknown as ReturnType<World['collectTransportPlan']>;
    if(kind==='temple')world.collectJungleTemples=()=>[{id:1,kind:'sun-shrine',x:2,y:0,z:0,radius:1,forestId:1}];
    if(kind==='foundation'||kind==='underground foundation'){
      const f={x:1.5,y:-.2,z:0,hx:.025,hy:.1,hz:1,underground:kind==='underground foundation'};
      region.foundations!.push(f);
      world.sdf=(x,y,z)=>Math.abs(x-f.x)<=f.hx&&Math.abs(z-f.z)<=f.hz&&y>=f.y-f.hy&&(!f.underground||y<=f.y+f.hy+.6)?Math.max(y,y-f.y-f.hy):y;
      assert.ok(world.sdf(f.x,0,0)>0,'the lower plinth carves a real unsupported strip in the city plane');
    }
    assert.equal(proof(world,x,.1,0,dx,dz,length,1),null,kind);
  }
});

test('one authored deck supports remote movement at its actual elevated top with ordinary acceleration',()=>{
  const {world,deck}=deckWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  p.state.py=deck.y+deck.hy+.1;
  let expected=0,velocity=0;
  for(let tick=1;tick<=60;tick++){
    sim.prepare(tick,players,[]);
    assert.equal(sim.move(world,p,cmd(),TICK_DT,tick),true);
    velocity=Math.min(PLAYER.RUN_SPEED,velocity+PLAYER.ACCEL*TICK_DT);expected+=velocity*TICK_DT;
    assert.ok(Math.abs(p.state.px-expected)<1e-9);assert.equal(p.state.py,10.1,'floorY=0 cannot pull an elevated actor down');
    assert.equal(p.state.simulationTick,tick);assert.equal(p.state.grounded,true);
  }
  assert.equal(sim.stats.authoredTicks,60);
  // An editor/test changes authoritative cover at the same coordinates.
  world.collectRegion=()=>({sites:[],boulders:[],pads:[],solids:[],cuts:[],vegetation:[],foundations:[]});
  sim.prepare(61,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,61),false);
});

test('authored corridors reject thin walls, tapered shells, deck edges and separated support',()=>{
  for(const kind of ['wall','shell','reversed shell','edge','gap','pad','cut','tree','terrain'] as const){
    const {world,region,deck}=deckWorld(),players=roster(),p=players[0],sim=new BotSimulation();p.state.py=10.1;
    if(kind==='wall')region.solids.push({x:1.013,y:11,z:0,hx:.025,hy:1,hz:3});
    if(kind==='shell'||kind==='reversed shell'){
      const a={x:1.013,y:10.3,z:-2,radius:.025},b={x:1.013,y:10.3,z:2,radius:.4};
      region.capitalSegments!.push(kind==='shell'?{a,b}:{a:b,b:a});
    }
    if(kind==='edge'){deck.hx=1;deck.x=-.1;}
    if(kind==='gap')region.solids=[{...deck,x:-1.5,hx:2},{...deck,x:3,hx:2}];
    if(kind==='pad')region.pads.push({x:2,y:9.5,z:0,hx:.2,hy:.1,hz:.2});
    if(kind==='cut')region.cuts.push({x:2,y:9.8,z:0,hx:.025,hy:.5,hz:1});
    if(kind==='tree')region.vegetation.push({x:2,y:10,z:0,radius:.025,height:5,canopyRadius:2,kind:0,yaw:0});
    if(kind==='terrain')world.sampleColumn=()=>({h:9}) as ReturnType<World['sampleColumn']>;
    sim.prepare(1,players,[]);const before={...p.state};
    assert.equal(sim.move(world,p,cmd(),TICK_DT,1),false,kind);
    assert.deepEqual(p.state,before,`${kind} must leave the ordinary swept controller in charge`);
  }
});

test('authored corridors preserve lift gaps and live camp, hull and transit hazards',()=>{
  const {world,region}=deckWorld(),players=roster(),p=players[0],sim=new BotSimulation();p.state.py=10.1;
  sim.prepare(1,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,1),true);
  world.collectCityLifts=()=>[{id:1,cityId:2,x:2,z:0,bottom:0,top:30,hx:.5,hz:.5,phase:0}];
  sim.prepare(2,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,2),false,'lift opening cannot be treated as a floor');
  world.collectCityLifts=()=>[];sim.resetMovement(p);
  world.outposts.distance=()=>-1;
  sim.prepare(3,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,3),false,'new camp collision remains live');
  world.outposts.distance=(_x,_y,_z,best)=>best;sim.resetMovement(p);
  setVehicleColliders(world,4,[{id:500,type:VEHICLE.JEEP,x:1,y:10,z:0,heading:0,health:100,vx:10}]);
  sim.prepare(4,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,4),false,'incoming hull promotes immediately');
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,4),TICK_DT);
  setVehicleColliders(world,5,[]);sim.resetMovement(p);
  region.transportBridges={distance:()=>-1} as unknown as Region['transportBridges'];
  sim.prepare(5,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,5),false,'bridge analytic cover is never omitted');
});

test('canonical city streets and upper decks admit support while edges, lift gaps and new camps retain shared physics',()=>{
  const world=new World(7331),sim=new BotSimulation();
  const proof=(sim as unknown as {authoredPath(w:World,x:number,y:number,z:number,dx:number,dz:number,length:number,tick:number):{plane?:boolean}|null}).authoredPath.bind(sim);
  const cities=world.collectCities(),vesper=cities.find(c=>c.theme==='vesper')!,aurelia=cities.find(c=>c.theme==='aurelia')!;
  let bridge=false;
  for(const route of vesperRoutes(vesper).filter(r=>Math.hypot(r.bx-r.ax,r.bz-r.az)>300)){
    const length=Math.hypot(route.bx-route.ax,route.bz-route.az),dx=(route.bx-route.ax)/length,dz=(route.bz-route.az)/length;
    const x=route.ax+(route.bx-route.ax)*.25,z=route.az+(route.bz-route.az)*.25;
    if(proof(world,x,route.y+.1,z,dx,dz,4,1)){bridge=true;break;}
  }
  assert.ok(bridge,'an actual Vesper route interior must use its continuous authored deck');
  const floor=aurelia.y+.06+48,x=aurelia.x+30,z=aurelia.z+160;
  assert.ok(proof(world,x,floor+.1,z,1,0,4,1),'an actual Aurelia upper promenade must be supported');
  assert.equal(proof(world,x,floor+.1,z+10.9,1,0,4,1),null,'the capsule footprint must fit inside the real deck edge');
  assert.equal(proof(world,aurelia.x+639,floor+.1,z,1,0,4,1),null,'a canonical lift gap cannot inherit nearby deck support');
  const city=cities.find(c=>!c.theme)!;
  assert.ok(proof(world,city.x+80,city.y+.16,city.z+80,1,0,4,1),
    'a real city plinth must retain its exact clamp over smoothed paving');
  assert.equal(proof(world,5355.7,aurelia.y+.1,4882.9,1,0,4,1)?.plane,true,
    'the actual Aurelia ground-level approach uses the canonical plane without a box');
  const players=roster(),p=players[0];Object.assign(p.state,{px:x,py:floor+.1,pz:z});
  sim.prepare(2,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,2),true);
  const checks=sim.stats.pathChecks;
  sim.prepare(3,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,3),true);
  assert.equal(sim.stats.pathChecks,checks,'canonical support should reuse its proven corridor');
  world.outposts.distance=()=>-1;
  sim.prepare(4,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,4),false,'new camp collision invalidates a cached authored corridor');
  assert.equal(sim.stats.pathChecks,checks,'the live hazard check must run even without rebuilding static support');
  world.outposts.distance=(_x,_y,_z,best)=>best;
  for(const method of ['collectRegion','sampleColumn'] as const){
    world.collectRegion=World.prototype.collectRegion;world.sampleColumn=World.prototype.sampleColumn;
    sim.resetMovement(p);Object.assign(p.state,{px:x,py:floor+.1,pz:z,vx:0,vy:0,vz:0});
    sim.prepare(10,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,10),true);
    const previous=sim.stats.pathChecks;
    if(method==='collectRegion')world.collectRegion=()=>({sites:[],boulders:[],pads:[],solids:[],cuts:[],vegetation:[],foundations:[]});
    else world.sampleColumn=()=>({h:floor+.9}) as ReturnType<World['sampleColumn']>;
    sim.prepare(11,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,11),false,`${method} replacement invalidates an existing canonical proof`);
    assert.equal(sim.stats.pathChecks,previous+1);
  }
  world.collectRegion=World.prototype.collectRegion;world.sampleColumn=World.prototype.sampleColumn;
  const px=5355.7,pz=4882.9,py=aurelia.y+.1;
  for(const method of ['collectCities','collectCaveSites','collectTransportPlan','collectJungleTemples','column'] as const){
    sim.resetMovement(p);Object.assign(p.state,{px,py,pz,vx:0,vy:0,vz:0});
    sim.prepare(20,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,20),true);
    const previous=sim.stats.pathChecks,original=world[method];
    if(method==='collectCities')world.collectCities=()=>[];
    else if(method==='collectCaveSites')world.collectCaveSites=()=>[{}] as ReturnType<World['collectCaveSites']>;
    else if(method==='collectTransportPlan'){
      const plan=world.collectTransportPlan();
      world.collectTransportPlan=()=>({...plan,stations:[{...plan.stations[0],x:px-80,z:pz-80}]});
    }else if(method==='collectJungleTemples')world.collectJungleTemples=()=>[{id:1,kind:'sun-shrine',x:px,y:py,z:pz,radius:1,forestId:1}];
    else world.column=()=>({h:py+1,city:aurelia}) as ReturnType<World['column']>;
    sim.prepare(21,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,21),false,`${method} replacement invalidates cached flat-plane support`);
    assert.equal(sim.stats.pathChecks,previous+1);
    Object.assign(world,{[method]:original});
  }
});

test('remote supported travel advances every authority tick with ordinary acceleration and five quiet thoughts per second',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  let thoughts=0;
  for(let tick=1;tick<=TICK_RATE;tick++){
    sim.prepare(tick,players,[]);if(sim.shouldThink(p))thoughts++;
    assert.equal(sim.move(world,p,cmd(),TICK_DT,tick),true);
    assert.equal(p.state.simulationTick,tick);
  }
  let expected=0,v=0;
  for(let i=0;i<TICK_RATE;i++){v=Math.min(PLAYER.RUN_SPEED,v+PLAYER.ACCEL*TICK_DT);expected+=v*TICK_DT;}
  assert.ok(Math.abs(p.state.px-expected)<1e-9);
  assert.equal(thoughts,5);assert.equal(p.state.alive,true);assert.equal(p.state.grounded,true);
  assert.ok(sim.stats.pathChecks<5,'clear routes reuse the complete swept corridor');
});

test('remote firing and recent damage retain ten thoughts per second while action edges promote immediately',()=>{
  const players=roster(),p=players[0],sim=new BotSimulation();
  for(const mode of ['firing','hurt','use'] as const){
    p.lastCmd=cmd(mode==='firing'?BTN.FIRE:mode==='use'?BTN.USE:0);
    p.regenBlockUntil=mode==='hurt'?60+PLAYER.REGEN_DELAY*TICK_RATE:0;
    let thoughts=0;
    for(let tick=1;tick<=60;tick++){sim.prepare(tick,players,[]);if(sim.shouldThink(p))thoughts++;}
    assert.equal(thoughts,mode==='use'?60:10,mode);
  }
});

test('human interest promotes immediately and invalidates a previously clear remote corridor',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  advance(sim,world,p,players,cmd(),1);
  const human=new ServerPlayer(100,'human',null,false,{x:p.state.px+BOT_SUPPORTED_GROUND_RADIUS-1,y:0,z:0});
  players.push(human);sim.prepare(2,players,[]);const before={...p.state};
  assert.equal(sim.shouldThink(p),true);
  assert.equal(sim.move(world,p,cmd(),TICK_DT,2),false);
  assert.deepEqual(p.state,before,'promotion leaves the shared controller in charge immediately');
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,2),TICK_DT);
  sim.prepare(3,players.slice(0,8),[]);
  assert.equal(sim.move(world,p,cmd(),TICK_DT,3),false,'small games retain ordinary simulation');
});

test('urban fallback accumulates elapsed movement, preserves a fixed clock, and cannot tunnel through a thin wall',()=>{
  const world=flatWorld({x:2,y:1,z:0,hx:.15,hy:1,hz:2}),players=roster(),p=players[0],sim=new BotSimulation();
  let elapsed=0,maxStep=0;
  for(let tick=1;tick<=60;tick++){
    const dt=advance(sim,world,p,players,cmd(),tick);elapsed+=dt;maxStep=Math.max(maxStep,dt);
    assert.ok(p.state.px<2-PLAYER.RADIUS,'swept shared collision catches a wall thinner than a coarse step');
    assert.equal(p.state.alive,true);
  }
  assert.ok(p.state.px>1.3);assert.ok(Math.abs(elapsed-1)<1e-9);
  assert.ok(maxStep<=4*TICK_DT+.000001);assert.ok(sim.stats.batchedTicks>0&&maxStep>=2*TICK_DT);
  assert.equal(p.state.simulationTick,60);
});

test('remote blocked infantry reuse static contact but release it immediately when their movement command changes',()=>{
  const world=flatWorld({x:2,y:1,z:0,hx:.15,hy:1,hz:2}),players=roster(),p=players[0],sim=new BotSimulation();
  for(let tick=1;tick<=120;tick++)advance(sim,world,p,players,cmd(),tick);
  assert.ok(sim.stats.restTicks>30,'an unchanged blocked pose does not repeatedly resolve the same wall');
  const stopped=p.state.px;
  for(let tick=121;tick<=150;tick++)advance(sim,world,p,players,cmd(BTN.BACK),tick);
  assert.ok(p.state.px<stopped-1,'the cache cannot hold a bot after its steering changes');
  assert.equal(p.state.simulationTick,150);
});

test('bounded remote contact creep is treated as rest without advancing or hiding fresh damage',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  p.botRosterIndex=3;sim.prepare(1,players,[]);
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,1),TICK_DT);
  // A supported shared-physics contact resolved a tiny slide along a wall.
  p.state.px+=.004;p.state.vx=.11;p.state.vz=.08;
  const x=p.state.px;
  sim.prepare(2,players,[]);
  assert.equal(sim.move(world,p,cmd(),TICK_DT,2),true);
  assert.equal(p.state.px,x);assert.equal(p.state.vx,0);assert.equal(sim.stats.restTicks,1);
  p.regenBlockUntil=3+PLAYER.REGEN_DELAY*TICK_RATE;sim.prepare(3,players,[]);
  assert.equal(sim.move(world,p,cmd(),TICK_DT,3),false,'fresh damage immediately releases cached contact');
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,3),TICK_DT);
});

test('cached static regions retain every exact corridor primitive and custom collectors remain live',()=>{
  const world=new World(7331),sim=new BotSimulation();
  const collect=(sim as unknown as {staticRegion(w:World,x0:number,x1:number,z0:number,z1:number):Region}).staticRegion.bind(sim);
  const cached=collect(world,1001,1005,2001,2005);
  assert.equal(collect(world,1002,1006,2002,2006),cached);
  assert.equal(sim.stats.regionBuilds,1);assert.equal(sim.stats.regionHits,1);
  const canonical=world.collectRegion(1001,1005,2001,2005);
  for(const kind of ['boulders','pads','solids','cuts','foundations','vegetation'] as const){
    const superset=new Set<unknown>(cached[kind]);
    for(const primitive of canonical[kind]??[])assert.ok(superset.has(primitive),`${kind} omitted a canonical primitive`);
  }
  let changed=false;
  world.collectRegion=()=>({...canonical,solids:changed?[{x:1003,y:1,z:2003,hx:.1,hy:1,hz:1}]:[]});
  assert.equal(collect(world,1001,1005,2001,2005).solids.length,0);
  changed=true;assert.equal(collect(world,1001,1005,2001,2005).solids.length,1);
});

test('distant swimmers think at five Hz and retain elapsed shared movement, current and air time',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  world.sampleColumn=()=>({h:-10}) as ReturnType<World['sampleColumn']>;
  world.sdf=(_x,y)=>y+10;
  world.liquidAt=()=>({id:1,kind:'water',surfaceY:4,bottomY:-10,distance:0,flowX:1,flowZ:0});
  p.state.py=-1;p.state.grounded=false;p.state.swimming=true;p.state.submerged=true;p.state.airSeconds=18;
  let elapsed=0,thoughts=0,held=0;
  for(let tick=1;tick<=60;tick++){
    sim.prepare(tick,players,[]);if(sim.shouldThink(p))thoughts++;
    assert.equal(sim.move(world,p,cmd(),TICK_DT,tick),false,'water never takes the terrain corridor shortcut');
    const dt=sim.physicsDt(world,p,cmd(),TICK_DT,tick);elapsed+=dt;
    if(dt)stepMove(world,p.state,cmd(),dt,tick);else held++;
  }
  assert.equal(thoughts,5);assert.equal(held,45);
  assert.ok(Math.abs(elapsed-1)<1e-9);assert.equal(p.state.simulationTick,60);
  assert.ok(p.state.px>5&&p.state.px<7,'coarse movement still swims forward with the shared current');
  assert.ok(Math.abs(p.state.airSeconds!-17)<1e-8);
  const human=new ServerPlayer(100,'human',null,false,{x:p.state.px,y:0,z:0});
  players.push(human);sim.prepare(61,players,[]);
  assert.equal(sim.shouldThink(p),true);assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,61),TICK_DT);
});

test('clear remote water retains ordinary per-tick buoyancy, current, ascent and breathing',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  world.sampleColumn=()=>({h:-12}) as ReturnType<World['sampleColumn']>;
  world.sdf=(_x,y)=>y+12;
  world.liquidAt=(x,y)=>y<=4&&y>=-12?{id:1,kind:'water',surfaceY:4,bottomY:-12,distance:-100,flowX:.3+x*.01,flowZ:.15}:undefined;
  Object.assign(p.state,{py:-1,grounded:false,swimming:true,submerged:true,airSeconds:18});
  const ordinary={...p.state};
  for(let tick=1;tick<=60;tick++){
    const input=cmd(BTN.FORWARD|(tick>=31&&tick<=42?BTN.JUMP:0),tick);
    sim.prepare(tick,players,[]);
    assert.equal(sim.move(world,p,input,TICK_DT,tick),true);
    stepMove(world,ordinary,input,TICK_DT,tick);
    for(const field of ['px','py','pz','vx','vy','vz','airSeconds'] as const)
      assert.ok(Math.abs(p.state[field]!-ordinary[field]!)<1e-9,`${field} diverged at tick ${tick}`);
    assert.equal(p.state.submerged,ordinary.submerged);
    assert.equal(p.state.jumpHeld,ordinary.jumpHeld);
    assert.equal(p.state.simulationTick,tick);assert.equal(p.state.grounded,false);
  }
  assert.equal(sim.stats.waterTicks,60);
  players.push(new ServerPlayer(100,'human',null,false,{x:p.state.px,y:0,z:p.state.pz}));
  sim.prepare(61,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,61),false);
});

test('water clearance rejects thin submerged walls, shallow beds and newly arriving hulls',()=>{
  const wall={x:1,y:0,z:0,hx:.025,hy:4,hz:2};
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  world.sampleColumn=()=>({h:-12}) as ReturnType<World['sampleColumn']>;
  world.sdf=(_x,y)=>y+12;
  world.liquidAt=()=>({id:1,kind:'water',surfaceY:4,bottomY:-12,distance:-100,flowX:0,flowZ:0});
  Object.assign(p.state,{py:-1,grounded:false,swimming:true});
  sim.prepare(1,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,1),true);
  // Both endpoints are clear; the complete swept prism still contains this
  // five-centimetre wall. An injected geometry edit must invalidate reuse.
  world.collectRegion=()=>({sites:[],boulders:[],pads:[],solids:[wall],cuts:[],vegetation:[],foundations:[]});
  sim.prepare(2,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,2),false);
  assert.ok(p.state.px<wall.x-PLAYER.RADIUS);
  world.collectRegion=()=>({sites:[],boulders:[],pads:[],solids:[],cuts:[],vegetation:[],foundations:[]});
  sim.resetMovement(p);world.sampleColumn=()=>({h:-1.5}) as ReturnType<World['sampleColumn']>;
  sim.prepare(3,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,3),false,'shallow beds retain swept contacts');
  sim.resetMovement(p);world.sampleColumn=()=>({h:-12}) as ReturnType<World['sampleColumn']>;
  sim.prepare(4,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,4),true);
  setVehicleColliders(world,5,[{id:500,type:VEHICLE.JEEP,x:1,y:-1,z:0,heading:0,health:100,vx:10}]);
  sim.prepare(5,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,5),false);
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,5),TICK_DT,'an incoming hull promotes the next contact immediately');
});

test('surface swimming sizes its clear prism to vertical movement and rechecks a dive before approaching the bed',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  world.sampleColumn=()=>({h:.8}) as ReturnType<World['sampleColumn']>;
  world.sdf=(_x,y)=>y-.8;
  world.liquidAt=(_x,y)=>y<=6&&y>=.8?{id:1,kind:'water',surfaceY:6,bottomY:.8,distance:-100,flowX:0,flowZ:0}:undefined;
  Object.assign(p.state,{py:4.95,grounded:false,swimming:true,airSeconds:18});
  sim.prepare(1,players,[]);
  assert.equal(sim.move(world,p,cmd(0),TICK_DT,1),true,'surface clearance does not require an unused 1.5m descent');
  let diveFallback=false;
  for(let tick=2;tick<=90;tick++){
    sim.prepare(tick,players,[]);
    const fast=sim.move(world,p,cmd(BTN.BRAKE),TICK_DT,tick);
    if(!fast){diveFallback=true;break;}
    assert.ok(p.state.py>.8+3,'a reused prism never reduces the terrain safety margin');
  }
  assert.ok(diveFallback,'diving outside the small surface prism requires a new clearance proof');
  assert.ok(p.state.py>.8+3,'shared swept contacts resume before the swimmer reaches the bed');
});

test('promotion flushes deferred time, while boarding cannot turn old walking time into driving',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  sim.prepare(1,players,[]);assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,1),0);
  const human=new ServerPlayer(100,'human',null,false,{x:0,y:0,z:0});players.push(human);
  sim.prepare(2,players,[]);assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,2),2*TICK_DT);
  players.pop();sim.prepare(5,players,[]);assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,5),0);
  sim.resetMovement(p);p.state.vehicle=VEHICLE.JEEP;
  assert.equal(sim.physicsDt(world,p,cmd(BTN.USE),TICK_DT,5),TICK_DT);
});

test('movement edges, airborne actors, close hulls and orbital pods retain full movement',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  sim.prepare(1,players,[]);
  for(const buttons of [BTN.JUMP,BTN.DODGE,BTN.USE]){
    assert.equal(sim.move(world,p,cmd(buttons),TICK_DT,1),false);
    assert.equal(sim.physicsDt(world,p,cmd(buttons),TICK_DT,1),TICK_DT);
  }
  p.state.grounded=false;
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,1),TICK_DT);p.state.grounded=true;
  setVehicleColliders(world,1,[{id:500,type:VEHICLE.JEEP,x:1,y:0,z:0,heading:0,health:100,vx:10}]);
  assert.equal(sim.move(world,p,cmd(),TICK_DT,1),false);
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,1),TICK_DT);
  setVehicleColliders(world,1,[{id:500,type:VEHICLE.JEEP,x:15,y:0,z:0,heading:0,health:100}]);
  assert.equal(sim.move(world,p,cmd(),TICK_DT,1),true,'a distant parked hull does not exclude a whole depot');
  sim.resetMovement(p);world.collectTransportPlan=()=>({routes:[],pods:[{x:0,z:0}]}) as unknown as ReturnType<World['collectTransportPlan']>;
  assert.equal(sim.move(world,p,cmd(),TICK_DT,1),false);
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,1),TICK_DT,'orbital gathering and charging remain precise');
});

test('an approaching train invalidates a cached corridor before the next movement tick',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  assert.equal(advance(sim,world,p,players,cmd(),1),TICK_DT);
  const from={id:1,name:'A',x:0,y:0,z:0},to={id:2,name:'B',x:1000,y:0,z:0};
  const route:TransportRoute={id:1,name:'train',kind:'train',speed:100,dwell:3,phase:0,stops:[from,to],carOffsets:[0],
    legs:[{from,to,reverse:false,points:[from,to],distances:[0,1000],length:1000}]};
  world.collectTransportPlan=()=>({routes:[route],pods:[]}) as unknown as ReturnType<World['collectTransportPlan']>;
  sim.prepare(2,players,[]);
  assert.equal(sim.move(world,p,cmd(),TICK_DT,2),false,'dynamic transit is checked even when the static route is cached');
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,2),TICK_DT);
});

test('Game repeats cached bot input at fixed ticks, keeps combat timers and capture presence active',()=>{
  const game=new Game(1337,{frontier:true}),players=roster(),p=players[0],world=flatWorld();
  // Keep real Game input, timers and Frontier capture, with a deterministic
  // flat collision fixture; unrelated dynamic world systems are not stepped.
  Object.assign(game.world,{sampleColumn:world.sampleColumn,liquidAt:world.liquidAt,collectTransportPlan:world.collectTransportPlan,
    collectCityLifts:world.collectCityLifts,collectRegion:world.collectRegion,sdf:world.sdf,gradient:world.gradient});
  game.world.outposts.distance=world.outposts.distance;
  for(const bot of players)game.players.set(bot.id,bot);
  const site=game.frontier!.territories[0];
  site.owner=0;site.influence=0;site.captureFaction=0;site.captureProgress=0;
  p.state.px=site.x;p.state.pz=site.z;p.state.py=.1;site.y=0;p.faction=1;
  p.fireCd=.7;p.vehFireCd=.9;p.state.airSeconds=2;
  const internals=game as unknown as {processPlayer(p:ServerPlayer):void;fire(...args:unknown[]):void};
  let input=cmd(0);
  for(let tick=1;tick<=60;tick++){
    game.tick=tick;game.botSimulation.prepare(tick,game.players.values(),[]);
    if(tick%6===1)input=cmd(0,tick);
    game.queueInput(p,input);internals.processPlayer(p);
    game.frontier!.step([p],tick,TICK_DT);
    assert.equal(p.state.alive,true);
  }
  assert.equal(game.tick,60);assert.equal(p.state.simulationTick,60);
  assert.equal(p.fireCd,0);assert.equal(p.vehFireCd,0);
  assert.ok(Math.abs(p.state.airSeconds!-7)<1e-8);
  assert.ok(Math.abs(site.captureProgress!-.2/CAPTURE_SECONDS)<1e-8,'all sixty ticks contribute living capture pressure');
  assert.equal(p.inputQueue.length,0);assert.equal(p.lastProcessedSeq,55);
  // Force the static urban fallback so two movement ticks are deferred;
  // weapon cooldown and a live shot must still execute on those ticks.
  game.botSimulation.resetMovement(p);
  game.world.sampleColumn=()=>({h:0,city:{theme:'fixture'}}) as unknown as ReturnType<World['sampleColumn']>;
  let shots=0;internals.fire=()=>{shots++;};p.fireCd=TICK_DT*1.5;
  const beforeX=p.state.px;
  for(const tick of [61,62]){
    game.tick=tick;game.botSimulation.prepare(tick,game.players.values(),[]);
    game.queueInput(p,cmd(BTN.FORWARD|BTN.FIRE,tick));internals.processPlayer(p);
  }
  assert.equal(p.state.px,beforeX,'the remote urban movement accumulator has not reached its fourth tick');
  assert.equal(shots,1,'weapons execute between coarse movement steps');
  // Oxygen and drowning also run between movement steps. A swimmer with
  // 40 ms of air must begin drowning on tick65, even though its next movement
  // would otherwise be tick68. Damage then promotes and flushes movement.
  game.botSimulation.resetMovement(p);
  game.world.sampleColumn=()=>({h:-10}) as ReturnType<World['sampleColumn']>;
  game.world.sdf=(_x,y)=>y+10;
  game.world.liquidAt=()=>({id:1,kind:'water',surfaceY:4,bottomY:-10,distance:0,flowX:0,flowZ:0});
  Object.assign(p.state,{px:0,py:-1,pz:0,vx:0,vy:0,vz:0,grounded:false,swimming:true,submerged:true,airSeconds:.04});
  for(const tick of [63,64,65,66]){
    game.tick=tick;game.botSimulation.prepare(tick,game.players.values(),[]);
    game.queueInput(p,cmd(BTN.FORWARD,tick));internals.processPlayer(p);
    assert.ok(Math.abs(p.state.airSeconds!-Math.max(0,.04-(tick-62)*TICK_DT))<1e-9);
    assert.ok(Math.abs(p.health-(100-Math.max(0,tick-64)*SWIMMING.DROWN_DPS*TICK_DT))<1e-9);
    if(tick===65)assert.equal(p.state.simulationTick,64,'drowning damage is immediate on a deferred movement tick');
  }
  assert.equal(p.state.simulationTick,66,'damage promotes the swimmer and flushes pending movement time');
  game.world.liquidAt=()=>undefined;game.tick=67;game.botSimulation.prepare(67,game.players.values(),[]);
  game.queueInput(p,cmd(BTN.FORWARD,67));internals.processPlayer(p);
  assert.ok(Math.abs(p.state.airSeconds!-5*TICK_DT)<1e-9,'breathing recovery is counted once after promotion');
  // The clear-water shortcut must retain the same per-tick hazard timing.
  game.botSimulation.resetMovement(p);p.regenBlockUntil=0;p.health=100;
  Object.assign(p.state,{px:0,py:-1,pz:0,vx:0,vy:0,vz:0,grounded:false,swimming:true,submerged:true,airSeconds:.025});
  game.world.liquidAt=()=>({id:1,kind:'water',surfaceY:4,bottomY:-10,distance:-100,flowX:0,flowZ:0});
  for(const tick of [68,69]){
    game.tick=tick;game.botSimulation.prepare(tick,game.players.values(),[]);
    game.queueInput(p,cmd(0,tick));internals.processPlayer(p);
    assert.equal(p.state.simulationTick,tick);
    assert.ok(Math.abs(p.state.airSeconds!-Math.max(0,.025-(tick-67)*TICK_DT))<1e-9);
  }
  assert.equal(game.botSimulation.stats.waterTicks,2);
  assert.ok(Math.abs(p.health-(100-SWIMMING.DROWN_DPS*TICK_DT))<1e-9,'drowning executes on a clear-water movement tick');
});

function supportedBandFixture(distance=250){
  const world=new World(7331),city=world.collectCities().find(c=>c.theme==='aurelia')!;
  const origin={x:city.x+30,y:city.y+.06+48+.1,z:city.z+160};
  const players=roster(),p=players[0],sim=new BotSimulation();
  Object.assign(p.state,{px:origin.x,py:origin.y,pz:origin.z});
  const human=new ServerPlayer(100,'observer',null,false,{x:origin.x+distance,y:origin.y,z:origin.z});players.push(human);
  assert.equal(World.prototype.hasNativeTerrainProviders.call(world),true);
  return{world,players,p,sim,human,origin};
}

test('supported ground in the 200-300 m band advances every tick with full-rate thoughts',()=>{
  const {world,players,p,sim,origin}=supportedBandFixture();
  let expected=0,velocity=0;
  for(let tick=1;tick<=TICK_RATE;tick++){
    sim.prepare(tick,players,[]);assert.equal(sim.shouldThink(p),true);
    assert.equal(sim.move(world,p,cmd(),TICK_DT,tick),true);
    velocity=Math.min(PLAYER.RUN_SPEED,velocity+PLAYER.ACCEL*TICK_DT);expected+=velocity*TICK_DT;
    assert.ok(Math.abs(p.state.px-origin.x-expected)<1e-9);assert.equal(p.state.simulationTick,tick);
  }
  assert.equal(sim.stats.groundTicks,60);assert.equal(sim.stats.restTicks,0);
  assert.equal(sim.stats.batchedTicks,0);assert.equal(sim.stats.batchedSteps,0);
});

test('supported-ground boundaries do not move the 300 m thought and shared-dt boundary',()=>{
  assert.equal(BOT_FULL_SIM_RADIUS,300);assert.equal(BOT_SUPPORTED_GROUND_RADIUS,200);
  for(const distance of [199.999,200,200.001,299.999,300,300.001]){
    const {world,players,p,sim}=supportedBandFixture(distance);
    sim.prepare(1,players,[]);const before={...p.state};
    assert.equal(sim.shouldThink(p),distance<300,`thoughts at ${distance}`);
    assert.equal(sim.move(world,p,cmd(0),TICK_DT,1),distance>=200,`supported ground at ${distance}`);
    if(distance<200)assert.deepEqual(p.state,before);
    assert.equal(sim.physicsDt(world,p,cmd(0),TICK_DT,1),distance<300?TICK_DT:0,`shared dt at ${distance}`);
  }
});

test('every registered human protects the supported-ground boundary, including a dead observer',()=>{
  const {world,players,p,sim,origin}=supportedBandFixture();
  const near=new ServerPlayer(101,'near',null,false,{x:origin.x,y:500,z:origin.z+199.999});
  players.push(near);near.state.alive=false;
  sim.prepare(1,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,1),false);
  near.state.pz=origin.z+200;sim.prepare(2,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,2),true);
  near.state.pz=origin.z+199;sim.prepare(3,players,[]);const before={...p.state};
  assert.equal(sim.move(world,p,cmd(),TICK_DT,3),false);assert.deepEqual(p.state,before);
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,3),TICK_DT);
});

test('supported-ground band admission preserves actor, water, damage and immediate-input exclusions',()=>{
  for(const kind of ['human','dead','small game','airlift','state airlift','swimming','submerged','airborne',
    'jump ascent','dodge cooldown','vertical speed','hurt','jump','dodge','use','hyper','burst'] as const){
    const {world,players,p,sim}=supportedBandFixture();
    let input=cmd(),dt=TICK_DT;
    if(kind==='human')Object.assign(p,{isBot:false});
    if(kind==='dead')p.state.alive=false;
    if(kind==='small game')players.splice(1,1);
    if(kind==='airlift')Object.assign(p,{airlift:{source:1,destination:2,start:0,x:0,y:0,z:0,health:100}});
    if(kind==='state airlift')Object.assign(p.state,{airlift:{source:1,destination:2,start:0}});
    if(kind==='swimming')p.state.swimming=true;
    if(kind==='submerged')p.state.submerged=true;
    if(kind==='airborne')p.state.grounded=false;
    if(kind==='jump ascent')p.state.jumpAscent=true;
    if(kind==='dodge cooldown')p.state.dodgeCd=.1;
    if(kind==='vertical speed')p.state.vy=3.01;
    if(kind==='hurt')p.regenBlockUntil=1+PLAYER.REGEN_DELAY*TICK_RATE;
    if(kind==='jump')input=cmd(BTN.JUMP);
    if(kind==='dodge')input=cmd(BTN.DODGE);
    if(kind==='use')input=cmd(BTN.USE);
    if(kind==='hyper')input=cmd(BTN.HYPER);
    if(kind==='burst')dt=2*TICK_DT;
    sim.prepare(1,players,[]);const before={...p.state};
    assert.equal(sim.move(world,p,input,dt,1),false,kind);assert.deepEqual(p.state,before,kind);
    assert.equal(sim.physicsDt(world,p,input,dt,1),dt,`${kind} does not batch inside 300 m`);
    assert.equal(sim.stats.waterTicks,0);assert.equal(sim.stats.restTicks,0);
  }
});

test('vehicles in the supported-ground band keep full-rate thought and shared movement',()=>{
  const world=flatWorld(),players=roster(),p=players[0],sim=new BotSimulation();
  players.push(new ServerPlayer(100,'observer',null,false,{x:250,y:0,z:0}));
  const hull:ServerVehicle={id:500,type:VEHICLE.JEEP,x:0,y:.1,z:0,heading:0,health:1000,occupant:p.id,respawnAtTick:-1};
  p.vehicleId=hull.id;Object.assign(p.state,{vehicle:VEHICLE.JEEP,vehicleId:hull.id,seat:0});
  for(let tick=1;tick<=12;tick++){
    sim.prepare(tick,players,[hull]);assert.equal(sim.shouldThink(p),true);
    assert.equal(sim.move(world,p,cmd(),TICK_DT,tick),false);
    assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,tick),TICK_DT);
  }
  assert.equal(sim.stats.batchedTicks,0);
});

test('injected-field band movement uses shared physics every tick without remote rest creation',()=>{
  for(const halfWidth of [.025,.15]){
    const wall={x:2,y:1,z:0,hx:halfWidth,hy:1,hz:2};
    const world=flatWorld(wall),ordinaryWorld=flatWorld(wall),players=roster(),p=players[0],sim=new BotSimulation();
    const ordinary={...p.state};
    players.push(new ServerPlayer(100,'observer',null,false,{x:250,y:0,z:0}));
    for(let tick=1;tick<=90;tick++){
      const input=cmd(BTN.FORWARD,tick);
      sim.prepare(tick,players,[]);assert.equal(sim.shouldThink(p),true);
      assert.equal(sim.move(world,p,input,TICK_DT,tick),false);
      assert.deepEqual(p.state,ordinary,'rejected support does not modify the shared starting state');
      const dt=sim.physicsDt(world,p,input,TICK_DT,tick);assert.equal(dt,TICK_DT);
      assert.deepEqual(stepMove(world,p.state,input,dt,tick),stepMove(ordinaryWorld,ordinary,input,TICK_DT,tick));
      assert.deepEqual(p.state,ordinary,`ordinary shared trajectory at tick ${tick}, wall half-width ${halfWidth}`);
      // The 5 cm injected slab is below the shared solver's designed feature
      // scale. Preserve its exact fallback trajectory without inventing a
      // stronger collision guarantee. The .15 witness is already qualified
      // by the existing urban fallback test above.
      if(halfWidth===.15)assert.ok(p.state.px<2-PLAYER.RADIUS,'qualified wall contact remains with shared physics');
      assert.equal(p.state.simulationTick,tick);
    }
    if(halfWidth===.15)assert.ok(p.state.px>1.3,'the actor reaches the qualified wall');
    assert.equal(sim.stats.restTicks,0);assert.equal(sim.stats.batchedTicks,0);
    assert.ok(sim.stats.reasons.providers>0,'a custom field cannot borrow a generated-ground certificate');
  }
});

test('entering the supported-ground band flushes pending remote time before any fast step',()=>{
  const {world,players,p,sim,human,origin}=supportedBandFixture(301);
  sim.prepare(1,players,[]);assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,1),0);
  human.state.px=origin.x+250;sim.prepare(2,players,[]);const before={...p.state};
  assert.equal(sim.shouldThink(p),true);assert.equal(sim.move(world,p,cmd(),TICK_DT,2),false);
  assert.deepEqual(p.state,before);assert.equal(sim.stats.reasons.pending,1);
  const dt=sim.physicsDt(world,p,cmd(),TICK_DT,2);assert.equal(dt,2*TICK_DT);
  stepMove(world,p.state,cmd(),dt,2);
  sim.prepare(3,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,3),true);
  human.state.px=p.state.px+199;sim.prepare(4,players,[]);
  assert.equal(sim.move(world,p,cmd(),TICK_DT,4),false);
  assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,4),TICK_DT);
});

test('entering the supported-ground band clears both remote rest and its pending observation',()=>{
  for(const cached of [false,true]){
    const {world,players,p,sim,human,origin}=supportedBandFixture(301);p.botRosterIndex=3;
    sim.prepare(1,players,[]);assert.equal(sim.physicsDt(world,p,cmd(),TICK_DT,1),TICK_DT);
    p.state.px+=.004;p.state.vx=.11;p.state.vz=.08;
    if(cached){sim.prepare(2,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,2),true);assert.equal(sim.stats.restTicks,1);}
    const tick=cached?3:2,x=p.state.px,rest=sim.stats.restTicks;
    human.state.px=origin.x+250;sim.prepare(tick,players,[]);
    assert.equal(sim.move(world,p,cmd(),TICK_DT,tick),true);
    assert.ok(p.state.px>x,'supported acceleration resumes instead of holding the old contact');
    assert.equal(sim.stats.restTicks,rest);
  }
});

test('a proven corridor survives the 300 m transition but releases immediately inside 200 m',()=>{
  const {world,players,p,sim,human,origin}=supportedBandFixture(301);
  sim.prepare(1,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,1),true);const checks=sim.stats.pathChecks;
  human.state.px=origin.x+250;sim.prepare(2,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,2),true);
  assert.equal(sim.stats.pathChecks,checks,'only the unchanged corridor proof is reused');
  human.state.px=origin.x+199;sim.prepare(3,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,3),false);
  human.state.px=origin.x+250;sim.prepare(4,players,[]);assert.equal(sim.move(world,p,cmd(),TICK_DT,4),true);
  assert.equal(sim.stats.pathChecks,checks+1,'the inner promotion discarded the old path');
});

function naturalBandFixture(){
  const world=new World(1337),players=roster(),p=players[0],sim=new BotSimulation();
  Object.assign(p.state,{px:8099.963859451707,py:79.49807336383007,pz:4377.507626967795,
    vx:-9.347892812736763,vy:0,vz:1.6931922399964983});
  const input={...cmd(),yaw:1.749984457579788};
  players.push(new ServerPlayer(100,'observer',null,false,{x:p.state.px+250,y:p.state.py,z:p.state.pz}));
  assert.equal(world.sampleColumn(p.state.px,p.state.pz).city,undefined,'the fixed witness uses natural ground');
  assert.equal(World.prototype.hasNativeTerrainProviders.call(world),true);
  return{world,players,p,sim,input};
}

test('natural supported-ground band paths recheck live camps, lifts, hulls and transit before reuse',()=>{
  for(const kind of ['camp','lift','hull','train'] as const){
    const {world,players,p,sim,input}=naturalBandFixture();
    sim.prepare(1,players,[]);assert.equal(sim.move(world,p,input,TICK_DT,1),true);
    assert.equal(sim.stats.authoredTicks,0,'this is the natural path whose live checks expand');
    const checks=sim.stats.pathChecks,x=p.state.px,y=p.state.py,z=p.state.pz;
    if(kind==='camp')world.outposts.add({id:1,owner:1,faction:0,type:1,x,y,z,facing:0});
    if(kind==='lift'){
      const lifts=world.collectCityLifts() as Array<ReturnType<World['collectCityLifts']>[number]>;
      lifts.push({id:999,cityId:2,x,z,bottom:y-10,top:y+20,hx:.5,hz:.5,phase:0});
    }
    if(kind==='hull')setVehicleColliders(world,2,[{id:500,type:VEHICLE.JEEP,x,y,z,heading:0,health:100,vx:10}]);
    if(kind==='train'){
      const from={id:991,name:'A',x,y,z},to={id:992,name:'B',x:x+1000,y,z};
      const route:TransportRoute={id:999,name:'train',kind:'train',speed:100,dwell:3,phase:0,stops:[from,to],carOffsets:[0],
        legs:[{from,to,reverse:false,points:[from,to],distances:[0,1000],length:1000}]};
      world.collectTransportPlan().routes.push(route);
    }
    assert.equal(World.prototype.hasNativeTerrainProviders.call(world),true,'live fixture data keeps the native provider contract');
    sim.prepare(2,players,[]);const before={...p.state};
    assert.equal(sim.move(world,p,input,TICK_DT,2),false,kind);assert.deepEqual(p.state,before,kind);
    assert.equal(sim.stats.pathChecks,checks,'live hazards must be checked without a new path');
    assert.equal(sim.physicsDt(world,p,input,TICK_DT,2),TICK_DT,kind);
    assert.equal(sim.stats.authoredTicks,0);
  }
});

test('band movement rejects replacement providers before reusing natural or authored paths',()=>{
  for(const kind of ['natural','authored'] as const){
    const f=kind==='natural'?naturalBandFixture():{...supportedBandFixture(),input:cmd()};
    const {world,p,players,sim,input}=f,saved={...p.state};
    for(const method of ['sdf','sdfCol','sampleColumn','column','collectRegion','collectCities','collectCityLifts','hasNativeTerrainProviders'] as const){
      sim.resetMovement(p);Object.assign(p.state,saved);
      sim.prepare(1,players,[]);assert.equal(sim.move(world,p,input,TICK_DT,1),true,kind+' native admission');
      const checks=sim.stats.pathChecks,original=world[method],record=world as unknown as Record<string,unknown>;
      record[method]=method==='hasNativeTerrainProviders'?()=>true:(...args:unknown[])=>Reflect.apply(original,world,args);
      try{
        sim.prepare(2,players,[]);const before={...p.state};
        assert.equal(sim.move(world,p,input,TICK_DT,2),false,kind+' '+method);assert.deepEqual(p.state,before);
        assert.equal(sim.stats.pathChecks,checks,'the captured native guard rejects before old proof reuse');
        assert.equal(sim.physicsDt(world,p,input,TICK_DT,2),TICK_DT);
      }finally{record[method]=original;}
    }
  }
});
