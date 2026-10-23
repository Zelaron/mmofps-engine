import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, type Box } from '@shared/worldgen';
import { BTN, stepMove } from '@shared/movement';
import { TICK_DT } from '@shared/constants';
import { VEHICLE, GUNBOAT_DRAFT, vehicleDefinition } from '@shared/vehicles';
import type { CampaignOrder, Territory } from '@shared/frontier';
import type { TransportRoute } from '@shared/transport';
import { Bot } from '../src/bots.js';
import { ServerPlayer, type Game, type ServerVehicle } from '../src/game.js';

function fixture(type:ServerVehicle['type']){
  const water=type===VEHICLE.GUNBOAT,world=new World(1337),floor=water?-20:0;
  const wall:Box={x:0,y:2,z:-8,hx:4,hy:4,hz:1};
  world.sampleColumn=world.column=()=>({h:floor}) as ReturnType<World['sampleColumn']>;
  world.collectRegion=()=>({sites:[],boulders:[],pads:[],solids:[wall],cuts:[],vegetation:[],foundations:[]});
  world.sdf=world.sdfCol=(x,y,z)=>Math.min(y-floor,Math.max(Math.abs(x-wall.x)-wall.hx,Math.abs(y-wall.y)-wall.hy,Math.abs(z-wall.z)-wall.hz));
  world.gradient=(x,y,z,out)=>{const e=.001,dx=world.sdf(x+e,y,z)-world.sdf(x-e,y,z),dy=world.sdf(x,y+e,z)-world.sdf(x,y-e,z),dz=world.sdf(x,y,z+e)-world.sdf(x,y,z-e),n=Math.hypot(dx,dy,dz)||1;out.x=dx/n;out.y=dy/n;out.z=dz/n;};
  world.groundY=()=>floor;world.terrainHeight=()=>floor;
  world.liquidAt=(_x,y)=>water&&y<0?{id:1,kind:'water',surfaceY:0,bottomY:-20,distance:-100,flowX:0,flowZ:0}:undefined;
  world.collectCityLifts=()=>[];world.collectRoadSegments=()=>[];world.collectCities=()=>[];
  const start={id:1,name:'Start',x:0,y:0,z:0},end={id:2,name:'Goal',x:0,y:0,z:-1200};
  const route:TransportRoute={id:1,name:'Water lane',kind:'ferry',speed:20,dwell:5,phase:0,stops:[start,end],
    legs:[{from:start,to:end,points:[start,end],distances:[0,1200],length:1200,reverse:false}],carOffsets:[]};
  const plan={routes:water?[route]:[],stations:[],harbors:[],pods:[],lifts:[],solids:[],bridges:[],accesses:[]};
  world.collectTransportPlan=()=>plan;
  const p=new ServerPlayer(13,'Driver',null,true,{x:0,y:water?-GUNBOAT_DRAFT:.006,z:0});p.faction=1;p.vehicleId=800;
  Object.assign(p.state,{vehicle:type,vehicleId:800,seat:0,heading:0,grounded:!water});
  const hull:ServerVehicle={id:800,type,x:0,y:p.state.py,z:0,heading:0,health:vehicleDefinition(type)!.maxHealth,occupant:p.id,gunner:99,respawnAtTick:-1};
  const objective:Territory={id:'north',name:'North',kind:'relay',x:0,y:0,z:-1200,radius:20,owner:0,influence:0,contested:false};
  const order:CampaignOrder={baseId:'north-base',targetId:'north',name:'Advance',x:0,z:-1200,phase:'attack',squad:0,staging:{x:0,y:0,z:0}};
  const game={tick:0,world,players:new Map([[p.id,p]]),vehicles:new Map([[hull.id,hull]]),
    frontier:{territories:[objective],order:()=>order},areEnemies:()=>false,shouldThinkBot:()=>true} as unknown as Game;
  return{game,world,p,hull,bot:new Bot(p,1337),wall};
}

test('persistent obstacle probes cannot restart backing before the full turn and reassessment',()=>{
  for(const type of [VEHICLE.JEEP,VEHICLE.TANK,VEHICLE.GUNBOAT]){
    const{game,world,p,bot}=fixture(type);let scans=0;
    world.trace=(x,y,z,dx,dy,dz,maxDist)=>{scans++;return{hit:true,dist:1,x:x+dx,y:y+dy,z:z+dz,nx:0,ny:dy<0?1:0,nz:1};};
    let first=0,backing=0,turning=0;
    for(let tick=0;tick<85;tick++){
      game.tick=tick;const buttons=bot.think(game).buttons;
      if(tick===0)first=buttons&(BTN.LEFT|BTN.RIGHT);
      assert.equal(buttons&(BTN.LEFT|BTN.RIGHT),first,'one maneuver retains its chosen escape side');
      if(buttons&BTN.BACK)backing++;else if(buttons&BTN.FORWARD)turning++;
    }
    assert.ok(first,'the hull turns while recovering');assert.equal(backing,24);
    assert.equal(turning,61,'periodic obstruction and stuck scans cannot erase the forward turn phase');
    assert.equal(scans,1,'solid probes cannot affect an active recovery maneuver');
  }
});

test('active recovery keeps live water and ground support checks, then resumes solid probes after expiry',()=>{
  for(const type of [VEHICLE.JEEP,VEHICLE.TANK,VEHICLE.GUNBOAT]){
    const{game,world,bot}=fixture(type);let solidScans=0,supportChecks=0,supported=true;
    const sdf=world.sdf.bind(world),liquid=world.liquidAt.bind(world);
    world.trace=(x,y,z,dx,dy,dz)=>{solidScans++;return{hit:true,dist:1,x:x+dx,y:y+dy,z:z+dz,nx:0,ny:0,nz:1};};
    world.sdf=(x,y,z)=>{supportChecks++;return supported?sdf(x,y,z):10;};
    world.liquidAt=(x,y,z)=>{supportChecks++;return supported?liquid(x,y,z):undefined;};
    for(let tick=0;tick<=90;tick++){
      // The same held maneuver must observe newly unsafe support and later
      // safe support without renewing its reverse/turn deadline.
      if(tick===36)supported=false;
      if(tick===54)supported=true;
      const before=supportChecks;game.tick=tick;
      const command=bot.think(game);
      assert.equal(solidScans,tick<90?1:2,'only a fresh maneuver needs solid obstacle probes');
      if(tick%18===0)assert.ok(supportChecks>before,'water/ground support is still refreshed at every scan');
      if(tick>=36&&tick<54)assert.equal(command.buttons&BTN.FORWARD,0,'new dry shore or unsupported ground suppresses propulsion');
      if(tick===54)assert.ok(command.buttons&BTN.FORWARD,'fresh safe support restores the existing turn');
      if(tick===90)assert.ok(command.buttons&BTN.BACK,'expiry allows a newly observed solid obstacle to start recovery');
    }
  }
});

test('reverse steering accounts for ground yaw inversion and the boat rudder convention',()=>{
  for(const type of [VEHICLE.JEEP,VEHICLE.TANK,VEHICLE.GUNBOAT]){
    const{game,p,bot}=fixture(type);
    const initial=bot.think(game).buttons&(BTN.LEFT|BTN.RIGHT);
    assert.ok(initial);p.state.vz=2;game.tick=1;
    const reversing=bot.think(game).buttons;
    assert.ok(reversing&BTN.BACK);
    assert.equal(reversing&(BTN.LEFT|BTN.RIGHT),type===VEHICLE.GUNBOAT?initial:initial===BTN.LEFT?BTN.RIGHT:BTN.LEFT);
  }
});

test('ordinary ground and boat physics let a recovering convoy round a finite obstruction and resume its route',()=>{
  for(const type of [VEHICLE.JEEP,VEHICLE.TANK,VEHICLE.GUNBOAT]){
    const{game,world,p,bot,wall}=fixture(type);let widest=0;
    game.shouldThinkBot=()=>game.tick%12===0;
    for(let tick=0;tick<1200&&p.state.pz>-35;tick++){
      game.tick=tick;const command=bot.think(game);
      stepMove(world,p.state,command,TICK_DT,tick);
      widest=Math.max(widest,Math.abs(p.state.px));
      assert.ok(world.sdf(p.state.px,p.state.py+vehicleDefinition(type)!.radius,p.state.pz)>=-.01,'the real collision solver keeps the hull outside the obstacle');
    }
    assert.ok(widest>wall.hx,`vehicle ${type} steers around the obstacle footprint: ${JSON.stringify({widest,x:p.state.px,z:p.state.pz,heading:p.state.heading})}`);
    assert.ok(p.state.pz<-35,`vehicle ${type} resumes its northern route: ${JSON.stringify({x:p.state.px,z:p.state.pz,heading:p.state.heading})}`);
  }
});

function edgeFixture(type:ServerVehicle['type']){
  const f=fixture(type),water=type===VEHICLE.GUNBOAT;
  f.world.collectRegion=()=>({sites:[],boulders:[],pads:[],solids:[],cuts:[],vegetation:[],foundations:[]});
  // A boat approaches a solid bank from deep water; ground vehicles approach
  // the inverse geometry: a supported deck ending above a deep drop.
  const height=(z:number)=>water?(z<=-5?2:-20):(z<=-5?-30:0);
  f.world.sdf=f.world.sdfCol=(_x,y,z)=>y-height(z);
  f.world.groundY=(_x,z)=>height(z);
  f.world.sampleColumn=f.world.column=(_x,z)=>({h:height(z)}) as ReturnType<World['sampleColumn']>;
  f.world.liquidAt=(_x,y,z)=>water&&z>-5&&y<0?{id:1,kind:'water',surfaceY:0,bottomY:-20,distance:-100,flowX:0,flowZ:0}:undefined;
  return f;
}

test('known dry shoreline and unsupported ground suppress forward thrust throughout the bounded turn',()=>{
  for(const type of [VEHICLE.JEEP,VEHICLE.TANK,VEHICLE.GUNBOAT]){
    const{game,bot}=edgeFixture(type);
    for(let tick=0;tick<85;tick++){
      game.tick=tick;const command=bot.think(game);
      assert.equal(command.buttons&BTN.FORWARD,0,'an active turn cannot override the latest unsafe support probe');
      assert.ok(command.buttons&(BTN.LEFT|BTN.RIGHT),'steering remains active while waiting for a safe heading');
      assert.equal(!!(command.buttons&BTN.BACK),tick<24,'dry/unsupported probes cannot keep extending reverse');
    }
  }
});

test('a real shoreline or deck edge permits turning until fresh support restores forward travel',()=>{
  for(const type of [VEHICLE.JEEP,VEHICLE.TANK,VEHICLE.GUNBOAT]){
    const{game,world,p,bot}=edgeFixture(type);let turned=0,resumed=false;
    game.shouldThinkBot=()=>game.tick%12===0;
    for(let tick=0;tick<600;tick++){
      game.tick=tick;const command=bot.think(game);
      stepMove(world,p.state,command,TICK_DT,tick);
      turned=Math.max(turned,Math.abs(p.state.heading));
      if(tick>=24&&(command.buttons&BTN.FORWARD))resumed=true;
      assert.ok(p.state.pz>-5,`vehicle ${type} must stay on its safe side of the shoreline/deck edge`);
      assert.ok(p.state.py>-1,`vehicle ${type} cannot drive into the unsupported drop`);
    }
    assert.ok(turned>1,`vehicle ${type} can keep steering without unsafe forward propulsion`);
    assert.ok(resumed,`vehicle ${type} resumes forward travel after facing safe water/ground`);
  }
});
