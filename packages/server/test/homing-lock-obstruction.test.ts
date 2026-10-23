import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCK_CONE_COS, LOCK_RANGE, LOCK_TICKS, LOCK_NONE, LOCK_ACQUIRING, LOCK_LOCKED,
  PLAYER, VEHICLE, vehicleDefinition, viewDir, type InputCmd } from '@shared/index';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';

/** Independent old selection/transition, always using complete current rays. */
function referenceLock(game:Game,p:ServerPlayer,cmd:InputCmd) {
  let target=p.lockTargetId,hull=p.lockVehicleId,ticks=p.lockTicks,best:ServerPlayer|null=null,cosine=LOCK_CONE_COS;
  if(p.weapon!==3)return {target:-1,hull:-1,ticks:0,state:LOCK_NONE};
  const aim=viewDir(cmd.yaw,cmd.pitch),x=p.state.px,y=p.state.py+PLAYER.EYE_HEIGHT,z=p.state.pz;
  for(const q of game.players.values()) {
    if(!game.areEnemies(p,q)||!q.state.alive||q.state.vehicle===VEHICLE.NONE||q.state.seat===1)continue;
    if(p.vehicleId>=0&&p.vehicleId===q.vehicleId)continue;
    const vehicle=game.vehicles.get(q.vehicleId);
    if(!vehicle||vehicle.occupant!==q.id||vehicle.health<=0||vehicle.respawnAtTick>=0)continue;
    const radius=vehicleDefinition(q.state.vehicle,q.state.vehicleVariant)?.radius??1;
    const dx=q.state.px-x,dy=q.state.py+radius-y,dz=q.state.pz-z,dist=Math.hypot(dx,dy,dz);
    if(dist<6||dist>LOCK_RANGE)continue;
    const cos=(dx*aim.x+dy*aim.y+dz*aim.z)/dist;if(cos<cosine)continue;
    const hit=game.world.trace(x,y,z,dx/dist,dy/dist,dz/dist,dist,false);
    if(hit.hit&&hit.dist<dist-radius-.5)continue;
    best=q;cosine=cos;
  }
  if(best&&best.vehicleId===hull){ticks=Math.min(ticks+1,LOCK_TICKS+30);target=best.id;hull=best.vehicleId;}
  else if(best){target=best.id;hull=best.vehicleId;ticks=1;}
  else if(target>=0&&ticks>0){ticks-=3;if(ticks<=0){target=hull=-1;ticks=0;}}
  else {target=hull=-1;ticks=0;}
  return {target,hull,ticks,state:target<0?LOCK_NONE:ticks>=LOCK_TICKS?LOCK_LOCKED:LOCK_ACQUIRING};
}

function fixture() {
  const game=new Game(1337),shooter=new ServerPlayer(1,'Launcher',null,false,{x:0,y:0,z:0});
  shooter.faction=1;shooter.weapon=3;game.players.set(shooter.id,shooter);
  const target=new ServerPlayer(2,'Hull pilot',null,false,{x:0,y:PLAYER.EYE_HEIGHT-vehicleDefinition(VEHICLE.JET)!.radius,z:-600});
  target.faction=2;target.vehicleId=20;Object.assign(target.state,{vehicle:VEHICLE.JET,vehicleId:20});game.players.set(target.id,target);
  const hull:ServerVehicle={id:20,type:VEHICLE.JET,x:target.state.px,y:target.state.py,z:target.state.pz,heading:0,
    occupant:target.id,health:600,respawnAtTick:-1};game.vehicles.set(hull.id,hull);
  game.areEnemies=(a,b)=>a.id!==b.id&&a.faction!==0&&b.faction!==0&&a.faction!==b.faction;
  const wall={x:0,y:PLAYER.EYE_HEIGHT,z:-120,hx:6,hy:8,hz:8,enabled:true};
  let traces=0,samples=0;
  game.world.sdf=(x,y,z)=>{
    samples++;if(!wall.enabled)return 1000;
    const dx=Math.abs(x-wall.x)-wall.hx,dy=Math.abs(y-wall.y)-wall.hy,dz=Math.abs(z-wall.z)-wall.hz;
    return Math.hypot(Math.max(dx,0),Math.max(dy,0),Math.max(dz,0))+Math.min(Math.max(dx,dy,dz),0);
  };
  // Actual production sphere marching over that exact, mutable signed field.
  const trace=game.world.trace.bind(game.world);
  game.world.trace=(...args)=>{traces++;return trace(...args);};
  const cmd:InputCmd={seq:1,buttons:0,weapon:3,yaw:0,pitch:0,renderTick:0,renderFrac:0};
  const internals=game as unknown as {updateHomingLock(p:ServerPlayer,cmd:InputCmd):void;
    homingObstructions:WeakMap<ServerPlayer,Map<number,unknown>>};
  const aim=()=>{
    const dx=target.state.px-shooter.state.px,dy=target.state.py+vehicleDefinition(VEHICLE.JET)!.radius-shooter.state.py-PLAYER.EYE_HEIGHT,dz=target.state.pz-shooter.state.pz;
    cmd.yaw=Math.atan2(-dx,-dz);cmd.pitch=Math.atan2(dy,Math.hypot(dx,dz));
  };
  const step=()=>{
    aim();const expected=referenceLock(game,shooter,cmd);traces=samples=0;
    internals.updateHomingLock(shooter,cmd);
    assert.deepEqual({target:shooter.lockTargetId,hull:shooter.lockVehicleId,ticks:shooter.lockTicks,state:shooter.lockState},expected,
      'fresh obstruction proof preserves the complete60Hz lock transition');
    game.tick++;return {traces,samples};
  };
  return {game,shooter,target,hull,wall,step,internals};
}

test('blocked locks replace repeated long traces with one freshly verified current-ray point',()=>{
  const f=fixture();assert.equal(f.step().traces,1);
  for(let i=0;i<45;i++) {
    f.target.state.px=Math.sin(i*.1);f.shooter.state.px=Math.cos(i*.1)*.1;
    const query=f.step();assert.equal(query.traces,0);assert.equal(query.samples,1);
  }
  assert.equal(f.shooter.lockState,LOCK_NONE);
  f.target.state.px=100;
  assert.equal(f.step().traces,1,'a target moving around the wall immediately gets a complete fresh ray');
  assert.equal(f.shooter.lockTicks,1);
  assert.equal(f.step().traces,1,'clear visibility is never cached');
});

test('moved or removed cover cannot leave a stale blocked lock',()=>{
  const f=fixture();f.step();assert.equal(f.step().traces,0);
  f.wall.x=80;assert.equal(f.step().traces,1);assert.equal(f.shooter.lockTicks,1);
  f.wall.x=0;assert.equal(f.step().traces,1);assert.equal(f.shooter.lockState,LOCK_NONE);
  assert.equal(f.step().traces,0);
  f.wall.enabled=false;assert.equal(f.step().traces,1);assert.equal(f.shooter.lockTicks,1);
  f.wall.enabled=true;f.wall.z=-300;
  assert.equal(f.step().traces,1,'new cover is detected even after a visible frame');
  assert.equal(f.step().traces,0,'the new obstruction can supply its own fresh witness');
});

test('hull changes, faction changes, holstering and expiry revalidate bounded witnesses',()=>{
  const f=fixture();f.step();assert.equal(f.step().traces,0);
  for(let id=21;id<=33;id++) {
    f.game.vehicles.get(f.target.vehicleId)!.occupant=-1;
    const next={...f.hull,id,occupant:f.target.id};f.game.vehicles.set(id,next);
    f.target.vehicleId=id;f.target.state.vehicleId=id;
    assert.equal(f.step().traces,1,'a different hull never borrows another hull witness');
    assert.ok((f.internals.homingObstructions.get(f.shooter)?.size??0)<=8);
  }
  f.target.faction=1;assert.deepEqual(f.step(),{traces:0,samples:0});
  assert.equal(f.internals.homingObstructions.has(f.shooter),false,'no eligible target clears the shooter cache');
  f.target.faction=2;assert.equal(f.step().traces,1);
  f.shooter.weapon=1;assert.deepEqual(f.step(),{traces:0,samples:0});
  assert.equal(f.internals.homingObstructions.has(f.shooter),false);
  f.shooter.weapon=3;assert.equal(f.step().traces,1);
  f.game.tick+=121;assert.equal(f.step().traces,1,'an unused witness expires after the bounded retention window');
});

test('a retained witness never rejects a point inside the current hull allowance',()=>{
  const f=fixture();f.wall.z=-590;f.wall.hz=.1;
  f.step();assert.equal(f.step().traces,0);
  f.target.state.pz=-6;f.wall.z=-5.8;
  assert.equal(f.step().traces,1,'the old fraction lies past the new visible-hull threshold and requires a full trace');
  assert.equal(f.shooter.lockTicks,1);
});
