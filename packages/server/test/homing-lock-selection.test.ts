import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOCK_CONE_COS, LOCK_RANGE, LOCK_TICKS, LOCK_LOCKED, LOCK_NONE, PLAYER, VEHICLE, VEHICLE_VARIANT,
  vehicleDefinition, viewDir, mulberry32, type InputCmd } from '@shared/index';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';

// Frozen pre-optimization scan. Reference selection intentionally retains its
// original Map order, progressively tighter cone and per-candidate LOS work.
function previousSelection(game:Game,p:ServerPlayer,cmd:InputCmd):ServerPlayer|null {
  const ex=p.state.px,ey=p.state.py+PLAYER.EYE_HEIGHT,ez=p.state.pz,aim=viewDir(cmd.yaw,cmd.pitch);
  let best:ServerPlayer|null=null,bestCos=LOCK_CONE_COS;
  for(const q of game.players.values()) {
    if(!game.areEnemies(p,q)||!q.state.alive||q.state.vehicle===VEHICLE.NONE||q.state.seat===1)continue;
    if(p.vehicleId>=0&&q.vehicleId===p.vehicleId)continue;
    const hull=game.vehicles.get(q.vehicleId);
    if(!hull||hull.occupant!==q.id||hull.health<=0||hull.respawnAtTick>=0)continue;
    const def=vehicleDefinition(q.state.vehicle,q.state.vehicleVariant);
    const tx=q.state.px-ex,ty=q.state.py+(def?.radius??1)-ey,tz=q.state.pz-ez,dist=Math.hypot(tx,ty,tz);
    if(dist<6||dist>LOCK_RANGE)continue;
    const cos=(tx*aim.x+ty*aim.y+tz*aim.z)/dist;
    if(cos<bestCos)continue;
    const hit=game.world.trace(ex,ey,ez,tx/dist,ty/dist,tz/dist,dist);
    if(hit.hit&&hit.dist<dist-(def?.radius??1)-.5)continue;
    best=q;bestCos=cos;
  }
  return best;
}

function fixture() {
  const game=new Game(1337),shooter=new ServerPlayer(1,'Launcher',null,false,{x:0,y:0,z:0});
  game.areEnemies=(a,b)=>a.id!==b.id&&a.faction!==0&&b.faction!==0&&a.faction!==b.faction;
  // This fixture's synthetic visibility policy has no physical obstruction
  // witnesses; dedicated obstruction tests exercise the real signed field.
  game.world.sdf=()=>1;
  shooter.faction=1;shooter.weapon=3;game.players.set(shooter.id,shooter);
  const cmd:InputCmd={seq:1,buttons:0,weapon:3,yaw:0,pitch:0,renderTick:0,renderFrac:0};
  const update=(game as unknown as {updateHomingLock(p:ServerPlayer,cmd:InputCmd):void}).updateHomingLock.bind(game);
  let traces=0,normalRequests=0,occluded=(x:number,y:number,z:number,distance:number)=>false;
  game.world.trace=(ox,oy,oz,dx,dy,dz,distance,computeNormal=true)=>{
    traces++;if(computeNormal)normalRequests++;
    const x=ox+dx*distance,y=oy+dy*distance,z=oz+dz*distance,hit=occluded(x,y,z,distance);
    return {hit,dist:hit?distance*.5:distance,x,y,z,nx:0,ny:0,nz:1};
  };
  const add=(id:number,x:number,z:number,type:ServerVehicle['type']=VEHICLE.JET)=>{
    const radius=vehicleDefinition(type)!.radius,q=new ServerPlayer(id,`Target ${id}`,null,false,{x,y:PLAYER.EYE_HEIGHT-radius,z});
    q.faction=2;q.vehicleId=1000+id;Object.assign(q.state,{vehicle:type,vehicleId:q.vehicleId});
    const hull:ServerVehicle={id:q.vehicleId,type,x,y:q.state.py,z,heading:0,health:1000,occupant:q.id,respawnAtTick:-1};
    game.players.set(q.id,q);game.vehicles.set(hull.id,hull);return {q,hull};
  };
  const compare=()=>{
    traces=0;const expected=previousSelection(game,shooter,cmd),oldQueries=traces;
    shooter.lockTargetId=-1;shooter.lockVehicleId=-1;shooter.lockTicks=0;shooter.lockState=LOCK_NONE;
    traces=normalRequests=0;update(shooter,cmd);
    assert.equal(shooter.lockTargetId,expected?.id??-1);
    assert.equal(shooter.lockVehicleId,expected?.vehicleId??-1);
    assert.equal(shooter.lockTicks,expected?1:0);
    assert.ok(traces<=oldQueries,'ranking never needs more visibility queries than the previous progressive scan');
    assert.equal(normalRequests,0,'lock visibility consumes only hit and distance, so it never requests a surface normal');
    return {oldQueries,newQueries:traces};
  };
  return {game,shooter,cmd,add,compare,update,block:(predicate:typeof occluded)=>{occluded=predicate;}};
}

test('lock ranking checks the best visible aim first without changing lock timing',()=>{
  const f=fixture();
  for(let i=0;i<8;i++)f.add(10+i,(7-i)*4,-600);
  const result=f.compare();
  assert.equal(f.shooter.lockTargetId,17);
  assert.equal(result.oldQueries,8,'the old loop traces every progressively better target');
  assert.equal(result.newQueries,1,'only the strongest visible candidate needs a terrain query');
  f.shooter.lockTicks=LOCK_TICKS-1;f.update(f.shooter,f.cmd);
  assert.equal(f.shooter.lockTicks,LOCK_TICKS);assert.equal(f.shooter.lockState,LOCK_LOCKED);
  f.block(()=>true);f.update(f.shooter,f.cmd);
  assert.equal(f.shooter.lockTicks,LOCK_TICKS-3,'an occlusion still immediately applies the ordinary three-tick decay');
});

test('blocked leaders, exact-angle ties and duplicate crew retain the previous target',()=>{
  const f=fixture();f.add(10,0,-200,VEHICLE.JEEP);f.add(11,0,-400,VEHICLE.TANK);f.add(12,0,-600);
  f.compare();assert.equal(f.shooter.lockTargetId,12,'the last equal-angle Map entry wins');
  f.block((_x,_y,_z,distance)=>distance>450);f.compare();
  assert.equal(f.shooter.lockTargetId,11,'a blocked last tie leaves the last visible tie selected');
  const duplicate=f.add(13,0,-100);duplicate.q.vehicleId=1011;duplicate.q.state.vehicleId=1011;duplicate.q.state.seat=1;
  duplicate.hull.occupant=-1;f.compare();assert.equal(f.shooter.lockTargetId,11,'a gunner seat cannot replace its actual driver');
  duplicate.q.state.seat=0;f.compare();assert.equal(f.shooter.lockTargetId,11,'stale duplicate driver references must also fail occupancy checks');
  const friendly=f.add(14,0,-100);friendly.q.faction=1;f.compare();
  assert.equal(f.shooter.lockTargetId,11,'a friendly hull centered in the sight cannot replace the hostile target');
  // Reordering the collection must preserve its current iteration tie policy.
  const first=f.game.players.get(10)!;f.game.players.delete(10);f.game.players.set(10,first);
  f.compare();assert.equal(f.shooter.lockTargetId,10);
  f.block(()=>true);const none=f.compare();assert.equal(f.shooter.lockTargetId,-1);assert.equal(none.newQueries,3);
});

test('ranked selection matches the frozen scan across changing actors, factions, hulls, visibility and aim',()=>{
  const f=fixture(),random=mulberry32(0x18118);
  for(let i=0;i<24;i++)f.add(10+i,0,-100,[VEHICLE.JEEP,VEHICLE.TANK,VEHICLE.JET,VEHICLE.GUNBOAT][i%4]);
  for(let sample=0;sample<1600;sample++) {
    f.cmd.yaw=(random()-.5)*.15;f.cmd.pitch=(random()-.5)*.1;
    for(const q of f.game.players.values()) {
      if(q===f.shooter)continue;
      const hull=f.game.vehicles.get(1000+q.id)!;
      q.vehicleId=hull.id;q.state.vehicleId=hull.id;
      q.faction=random()<.2?1:2;q.state.alive=random()>.12;q.state.seat=random()<.12?1:undefined;
      q.state.vehicle=random()<.08?VEHICLE.NONE:hull.type;
      hull.health=random()<.08?0:1000;hull.respawnAtTick=random()<.08?120:-1;hull.occupant=random()<.08?-1:q.id;
      q.state.px=(random()-.5)*90;q.state.pz=-random()*1050;q.state.py=(random()-.5)*24;
      if(sample%11===0){q.state.px=0;q.state.py=PLAYER.EYE_HEIGHT-vehicleDefinition(hull.type)!.radius;f.cmd.yaw=f.cmd.pitch=0;}
      if(sample%17===0&&q.id===10){q.state.pz=-6;q.state.px=0;q.state.py=PLAYER.EYE_HEIGHT-vehicleDefinition(hull.type)!.radius;}
      if(sample%19===0&&q.id===11){q.state.pz=-LOCK_RANGE;q.state.px=0;q.state.py=PLAYER.EYE_HEIGHT-vehicleDefinition(hull.type)!.radius;}
      if(sample%23===0&&q.id===12){q.state.vehicleVariant=VEHICLE_VARIANT.NOCTURNE;}else q.state.vehicleVariant=0;
    }
    f.shooter.vehicleId=sample%7===0?1013:-1;
    f.block((x,y,z)=>Math.abs(Math.floor(x*3+y*5+z*.17+sample))%4===0);
    f.compare();
  }
});
