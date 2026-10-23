import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkingHullClearance } from '../src/bot-walk-clearance.js';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer } from '../src/game.js';
import { setVehicleColliders, updateVehicleCollider } from '@shared/vehicle-collision';
import { VEHICLE, VEHICLE_VARIANT } from '@shared/vehicles';
import { BTN, createMoveState, stepMove, type InputCmd } from '@shared/movement';
import { TICK_DT } from '@shared/constants';
import { World } from '@shared/worldgen';

function flat(game:Game){
  const world=game.world;
  world.sampleColumn=world.column=()=>({h:0}) as ReturnType<World['column']>;
  world.sdf=world.sdfCol=(x,y,z)=>world.pedestrianCollisions?.distance(x,y,z,y)??y;
  world.liquidAt=()=>undefined;world.collectCityLifts=()=>[];
  world.collectTransportPlan=()=>({routes:[],pods:[]}) as unknown as ReturnType<World['collectTransportPlan']>;
  world.collectRegion=()=>({sites:[],boulders:[],pads:[],solids:[],cuts:[],vegetation:[],foundations:[]});
  world.gradient=(x,y,z,out)=>{
    const e=.001,dx=world.sdf(x+e,y,z)-world.sdf(x-e,y,z),dy=world.sdf(x,y+e,z)-world.sdf(x,y-e,z),dz=world.sdf(x,y,z+e)-world.sdf(x,y,z-e),n=Math.hypot(dx,dy,dz)||1;
    Object.assign(out,{x:dx/n,y:dy/n,z:dz/n});
  };
  world.trace=(x,y,z,dx,dy,dz,max)=>{
    const dist=dy<0?y/-dy:max,hit=dy<0&&dist<=max;
    return{hit,dist:hit?dist:max,x:x+dx*dist,y:y+dy*dist,z:z+dz*dist,nx:0,ny:1,nz:0};
  };
  return world;
}

test('walking clearance respects hull variants, vertical separation and escape from existing contact',()=>{
  const world=new World(1337),state=createMoveState(2.1,.006,0);
  const tank={id:500,type:VEHICLE.TANK,x:0,y:0,z:0,heading:0,health:1000};
  setVehicleColliders(world,0,[tank]);
  let clear=walkingHullClearance(world,state,0);
  assert.equal(clear(Math.PI/2),false,'a route into the occupied hull is blocked');
  assert.equal(clear(0),false,'a grazing bot cannot keep dragging along the fender');
  assert.equal(clear(-Math.PI/2),true,'increasing clearance lets a touching bot escape');
  state.px=3.2;
  assert.equal(walkingHullClearance(world,state,0)(0),true,'a normal tank has room along this route');
  setVehicleColliders(world,0,[{...tank,variant:VEHICLE_VARIANT.BASTION}]);
  assert.equal(walkingHullClearance(world,state,0)(0),false,'the larger siege hull requires a wider detour');
  setVehicleColliders(world,0,[{...tank,type:VEHICLE.JET,y:30}]);
  assert.equal(walkingHullClearance(world,state,0)(Math.PI/2),true,'an overhead aircraft does not block a ground route');
});

test('two marching bots peel away from a moving tank and keep making progress',()=>{
  const game=new Game(1337),world=flat(game);
  const players=[-1,1].map((z,i)=>{
    const p=new ServerPlayer(19+i*3,`marcher ${i}`,null,true,{x:2.1,y:.006,z});
    p.state.grounded=true;p.faction=1;return p;
  });
  const bots=players.map(p=>new Bot(p,1337));
  const tank={id:500,type:VEHICLE.TANK,x:0,y:0,z:0,heading:0,health:1000,vz:-7.67};
  setVehicleColliders(world,0,[tank]);
  const starts=players.map(p=>p.state.pz);let peeled=false;
  for(let tick=0;tick<180;tick++){
    game.tick=tick;tank.z=-7.67*tick*TICK_DT;updateVehicleCollider(world,tick,tank);
    for(let i=0;i<bots.length;i++){
      const p=players[i],desired=Math.atan2(-(-p.state.px),-(-100-p.state.pz));
      const yaw=(bots[i] as unknown as {walkCourse(g:Game,yaw:number):number}).walkCourse(game,desired);
      const cmd:InputCmd={seq:tick+1,buttons:BTN.FORWARD,weapon:0,yaw,pitch:0,renderTick:0,renderFrac:0};
      stepMove(world,p.state,cmd,TICK_DT,tick);
      peeled ||= p.state.px>3;
    }
  }
  assert.ok(peeled,'marchers take a lateral escape before continuing along the convoy');
  for(let i=0;i<players.length;i++){
    assert.ok(players[i].state.pz<starts[i]-15,'the tank cannot keep pushing the same walking bot indefinitely');
    assert.equal(players[i].state.alive,true);
  }
});

test('a swimmer turns around a piling in deep water without requiring a reachable lakebed',()=>{
  const game=new Game(1337),world=flat(game),p=new ServerPlayer(19,'swimmer',null,true,{x:0,y:-1.05,z:0});
  const bot=new Bot(p,1337);p.state.swimming=true;p.state.grounded=false;
  world.sampleColumn=world.column=()=>({h:-20}) as ReturnType<World['column']>;
  world.sdf=world.sdfCol=(x,y,z)=>Math.min(y+20,Math.max(Math.abs(x)-.5,Math.abs(y)-2,Math.abs(z+2)-.4));
  world.trace=World.prototype.trace.bind(world);
  world.liquidAt=(_x,y,_z)=>y<=0&&y>=-20?{id:1,kind:'water',surfaceY:0,bottomY:-20,distance:-50,flowX:0,flowZ:0}:undefined;
  const steer=bot as unknown as {walkCourse(g:Game,yaw:number):number};
  const initial=steer.walkCourse(game,0);
  assert.ok(Math.abs(initial)>.5,'a viable lateral swimming route avoids the blocked forward ray');
  for(let tick=0;tick<180;tick++){
    game.tick=tick;
    const desired=Math.atan2(p.state.px,40+p.state.pz);
    const yaw=steer.walkCourse(game,desired);
    stepMove(world,p.state,{seq:tick+1,buttons:BTN.FORWARD,weapon:0,yaw,pitch:0,renderTick:0,renderFrac:0},TICK_DT,tick);
  }
  assert.ok(p.state.pz<-10,'the swimmer passes the piling instead of remaining against it');
  assert.ok(p.state.airSeconds!>10);assert.equal(p.state.alive,true);

  const lavaBot=new Bot(new ServerPlayer(22,'lava detour',null,true,{x:0,y:-1.05,z:0}),1337);
  lavaBot.player.state.swimming=true;
  world.liquidAt=()=>({id:2,kind:'lava',surfaceY:0,bottomY:-20,distance:-50,flowX:0,flowZ:0});
  const rejected=(lavaBot as unknown as {walkCourse(g:Game,yaw:number):number}).walkCourse(game,0);
  assert.equal(rejected,0,'lava cannot qualify as a viable alternate swimming route');
});
