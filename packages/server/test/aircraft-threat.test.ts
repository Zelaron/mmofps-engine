import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteReader, decodeSnapshot, LOCK_ACQUIRING, LOCK_LOCKED, VEHICLE, vehicleDefinition } from '@shared/index';
import { Game, ServerPlayer, type Projectile, type ServerVehicle } from '../src/game.js';
import { aircraftThreatFor } from '../src/aircraft-threat.js';

function fixture() {
  const pilot=new ServerPlayer(1,'Pilot',null,false,{x:0,y:100,z:0});pilot.faction=1;pilot.vehicleId=20;
  const gunner=new ServerPlayer(2,'Gunner',null,false,{x:0,y:100,z:0});gunner.faction=1;gunner.vehicleId=20;
  for(const p of [pilot,gunner]) Object.assign(p.state,{vehicle:VEHICLE.JET,vehicleId:20,vz:-120});
  gunner.state.seat=1;
  const hull:ServerVehicle={id:20,type:VEHICLE.JET,x:0,y:100,z:0,heading:0,
    health:vehicleDefinition(VEHICLE.JET)!.maxHealth,occupant:1,gunner:2,respawnAtTick:-1};
  const enemy=new ServerPlayer(3,'Launcher',null,true,{x:700,y:0,z:0});enemy.faction=2;
  enemy.weapon=3;enemy.lockVehicleId=20;enemy.lockTargetId=1;enemy.lockTicks=1;enemy.lockState=LOCK_ACQUIRING;
  const friend=new ServerPlayer(4,'Ally',null,true,{x:-5,y:100,z:0});friend.faction=1;
  friend.weapon=3;friend.lockVehicleId=20;friend.lockTargetId=1;friend.lockTicks=120;friend.lockState=LOCK_LOCKED;
  const players=new Map([pilot,gunner,enemy,friend].map(p=>[p.id,p]));
  const vehicles=new Map([[hull.id,hull]]), projectiles=new Map<number,Projectile>();
  const warning=(p:ServerPlayer)=>aircraftThreatFor(p,players,projectiles,vehicles,(a,b)=>a.faction!==b.faction);
  return {pilot,gunner,enemy,friend,hull,players,projectiles,warning};
}

test('both aircraft seats receive distant acquisition and lock warnings; friendly or stale locks are ignored',()=>{
  const {pilot,gunner,enemy,warning}=fixture();
  assert.deepEqual(warning(pilot),{stage:1,bearing:-Math.PI/2,eta:0});
  assert.deepEqual(warning(gunner),warning(pilot),'the gunner receives the same hull threat before launch');
  enemy.lockState=LOCK_LOCKED;enemy.lockTicks=120;
  assert.equal(warning(pilot)?.stage,2);
  enemy.weapon=1;assert.equal(warning(pilot),undefined,'holstered launcher no longer threatens the aircraft');
  enemy.weapon=3;enemy.state.alive=false;assert.equal(warning(gunner),undefined,'dead shooters do not leave a warning behind');
});

test('incoming missiles outrank locks and show the shortest closing time through crew promotion',()=>{
  const {pilot,gunner,enemy,hull,projectiles,warning}=fixture();
  const missile=(id:number,z:number):Projectile=>({id,owner:enemy.id,weapon:3,x:0,y:101.55,z,
    vx:0,vy:0,vz:-300,distLeft:1500,fuseLeft:Infinity,ageSeconds:0,sleeping:false,
    homingTarget:pilot.id,homingVehicleId:hull.id});
  projectiles.set(30,missile(30,360));projectiles.set(31,missile(31,180));
  assert.equal(warning(pilot)?.stage,3);assert.equal(warning(pilot)?.eta,1);
  assert.equal(Math.abs(warning(pilot)!.bearing),Math.PI);
  assert.deepEqual(warning(gunner),warning(pilot));
  hull.occupant=gunner.id;hull.gunner=-1;gunner.state.seat=undefined;pilot.vehicleId=-1;
  assert.equal(warning(gunner)?.stage,3,'guidance and warnings follow the hull when its gunner takes control');
  assert.equal(warning(pilot),undefined,'an ejected pilot does not keep hearing the cockpit alarm');
  for(const rocket of projectiles.values()){rocket.homingTarget=-1;rocket.homingVehicleId=-1;}
  assert.equal(warning(gunner)?.stage,1,'a successful seeker break clears the missile warning');
  hull.health=0;assert.equal(warning(gunner),undefined);
});

test('real player snapshots deliver cockpit warnings to both seats even outside the rendered entity radius',()=>{
  const {pilot,gunner,enemy,hull,players}=fixture();
  enemy.state.px=850;
  const game=new Game(1337);
  game.players.clear();game.vehicles.clear();
  for(const [id,p] of players)game.players.set(id,p);
  game.vehicles.set(hull.id,hull);
  game.areEnemies=(a,b)=>a.faction!==b.faction;
  const internals=game as unknown as {buildSnapshotFor(p:ServerPlayer):Uint8Array};
  for(const p of [pilot,gunner]) {
    const reader=new ByteReader(internals.buildSnapshotFor(p));reader.u8();
    const snapshot=decodeSnapshot(reader);
    assert.equal(snapshot.you.aircraftThreat?.stage,1);
    assert.ok(!snapshot.ents.some(e=>e.id===enemy.id),'a cockpit warning must not depend on local entity visibility');
    assert.equal(reader.remaining,0);
  }
});
