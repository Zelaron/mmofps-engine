import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerPlayer } from '../src/game.js';
import { BTN, NET, TICK_DT, TICK_RATE, VEHICLE, VEHICLE_VARIANT, ENT_PROJECTILE, ByteReader, Msg,
  decodeFire, decodeSnapshot, type InputCmd, type WeaponDef, viewDir } from '@shared/index';
import { TRAIN_NUCLEAR_CANNON, MAX_OWNED_ARTILLERY_SHELLS, trainArtilleryMuzzle, artilleryPitch } from '@shared/vehicles';
import { placeTrainArtillery } from '@shared/transit-motion';

function internals(game:Game) {return game as unknown as {
  fireVehicleWeapons(p:ServerPlayer,cmd:InputCmd):void;updateProjectiles():void;
  buildSnapshotFor(p:ServerPlayer):Uint8Array;broadcast():void;
  explode(x:number,y:number,z:number,p:ServerPlayer,def:WeaponDef,victim:number,id:number):void;
  events:{bytes:Uint8Array}[];
};}
function snapshot(game:Game,p:ServerPlayer) {const reader=new ByteReader(internals(game).buildSnapshotFor(p));reader.u8();return decodeSnapshot(reader);}

test('Leviathan shells and fire events leave the current moving train muzzle with matching bounded elevation',()=>{
  const game=new Game(1337),p=game.addPlayer('gunner',null),internal=internals(game);
  const route=game.world.collectTransportPlan().routes.find(r=>r.kind==='train')!;
  Object.assign(p.state,{vehicle:VEHICLE.TANK,vehicleVariant:VEHICLE_VARIANT.RAIL,seat:2,transportRoute:route.id});
  let previous:{x:number;y:number;z:number}|undefined;
  for(const [seconds,pitch] of [[route.dwell+8,.7],[route.dwell+9,-1.2],[route.dwell+10,1.4]]) {
    placeTrainArtillery(game.world,p.state,route.id,seconds*TICK_RATE);
    const cmd={seq:1,buttons:BTN.FIRE,weapon:0,yaw:p.state.heading+.35,pitch,renderTick:0,renderFrac:0};
    p.vehFireCd=0;internal.events.length=0;game.projectiles.clear();internal.fireVehicleWeapons(p,cmd);
    const projectile=[...game.projectiles.values()][0];assert.ok(projectile);assert.equal(projectile.weapon,213);
    const offset=trainArtilleryMuzzle(p.state.heading,cmd.yaw,pitch),expected={x:p.state.px+offset.x,y:p.state.py+offset.y,z:p.state.pz+offset.z};
    assert.ok(Math.hypot(projectile.x-expected.x,projectile.y-expected.y,projectile.z-expected.z)<1e-8);
    const bytes=internal.events.find(e=>e.bytes[0]===Msg.SFire)!.bytes,r=new ByteReader(bytes);r.u8();const event=decodeFire(r);
    assert.ok(Math.hypot(event.ox-expected.x,event.oy-expected.y,event.oz-expected.z)<.002);
    const direction=viewDir(cmd.yaw,artilleryPitch(pitch)),speed=TRAIN_NUCLEAR_CANNON.speed!;
    assert.ok(Math.hypot(projectile.vx-direction.x*speed,projectile.vy-direction.y*speed,projectile.vz-direction.z*speed)<1e-8);
    assert.equal(p.vehFireCd,5.5);assert.equal(projectile.fuseLeft,16);assert.equal(projectile.distLeft,2400);
    internal.fireVehicleWeapons(p,cmd);assert.equal(game.projectiles.size,1,'holding fire cannot bypass reload');
    if(previous)assert.ok(Math.hypot(p.state.px-previous.x,p.state.pz-previous.z)>2,'the fixture must move between shots');
    previous={x:p.state.px,y:p.state.py,z:p.state.pz};
  }
});

test('owned strategic shells reserve at most four existing snapshot slots beyond normal interest',()=>{
  const game=new Game(1337),owner=game.addPlayer('owner',null),other=game.addPlayer('other',null);
  for(const p of [owner,other])Object.assign(p.state,{px:0,py:600,pz:0});
  for(let id=1;id<=75;id++)game.projectiles.set(id,{id,owner:other.id,weapon:3,x:20+id,y:600,z:0,
    vx:0,vy:0,vz:0,distLeft:300,fuseLeft:10,ageSeconds:0,sleeping:false});
  for(let i=0;i<7;i++)game.projectiles.set(500+i,{id:500+i,owner:owner.id,weapon:213,x:1100+i*100,y:650,z:0,
    vx:190,vy:0,vz:0,distLeft:1000,fuseLeft:8,ageSeconds:8,sleeping:false});
  const own=snapshot(game,owner),spectator=snapshot(game,other);
  assert.equal(own.ents.length,NET.MAX_SNAPSHOT_ENTITIES);
  const shells=own.ents.filter(e=>e.kind===ENT_PROJECTILE&&e.weapon===213);
  assert.equal(shells.length,MAX_OWNED_ARTILLERY_SHELLS);
  assert.ok(shells.every(e=>e.x>NET.INTEREST_RADIUS));
  assert.ok(!spectator.ents.some(e=>e.kind===ENT_PROJECTILE&&e.weapon===213),'other clients retain their ordinary interest radius');
  assert.ok(internals(game).buildSnapshotFor(owner).length<3000,'strategic interest does not grow the entity or packet cap');
});

test('a shell travels beyond normal replication range and its eventual impact reaches only owner and nearby witnesses',()=>{
  const received:Uint8Array[][]=[[],[],[]],game=new Game(1337);
  const players=received.map((list,i)=>game.addPlayer(`witness${i}`,{send:bytes=>list.push(bytes)}));
  const [owner,farBystander,nearImpact]=players;
  Object.assign(owner.state,{px:0,py:1000,pz:0});Object.assign(farBystander.state,{px:2,py:1000,pz:100});
  Object.assign(nearImpact.state,{px:1200,py:1000,pz:400});
  const def=TRAIN_NUCLEAR_CANNON,projectile={id:501,owner:owner.id,weapon:213,x:0,y:1000,z:0,
    vx:def.speed!,vy:0,vz:0,distLeft:def.range,fuseLeft:5,ageSeconds:0,sleeping:false};
  game.projectiles.set(projectile.id,projectile);
  const internal=internals(game);internal.events.length=0;received.forEach(list=>list.length=0);
  for(let i=0;i<4.5/TICK_DT;i++)internal.updateProjectiles();
  assert.ok(projectile.x>NET.INTEREST_RADIUS);assert.ok(game.projectiles.has(501));
  assert.ok(snapshot(game,owner).ents.some(e=>e.kind===ENT_PROJECTILE&&e.id===501));
  for(let i=0;i<60&&game.projectiles.has(501);i++)internal.updateProjectiles();
  assert.equal(game.projectiles.has(501),false);assert.ok(projectile.x>900&&projectile.x<960);
  internal.broadcast();
  assert.equal(received[0].filter(b=>b[0]===Msg.SExplosion).length,1,'owner receives one distant terminal impact');
  assert.equal(received[1].filter(b=>b[0]===Msg.SExplosion).length,0,'unrelated distant players receive no strategic event');
  assert.equal(received[2].filter(b=>b[0]===Msg.SExplosion).length,1,'a witness within the existing event radius still receives it');
});
