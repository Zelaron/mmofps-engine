import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerPlayer } from '../src/game.js';
import { BTN, NOCTURNE_LANCE, BASTION_CANNON, BASTION_SHOCK_SHELL, bastionGunMuzzle, ByteReader, Msg, decodeFire, type InputCmd, type WeaponDef } from '@shared/index';
const cmd:InputCmd={seq:7,buttons:BTN.FIRE,weapon:0,yaw:0,pitch:0,renderTick:0,renderFrac:0};
function arena(){const game=new Game(1337),p=game.addPlayer('Pilot',null);
 Object.assign(p.state,{px:0,py:1500,pz:0,vehicle:3,vehicleVariant:1,heading:0});
 game.world.trace=(x,y,z,dx,dy,dz,max)=>{const t=dz<0?(-40-z)/dz:Infinity,hit=t>=0&&t<=max,dist=hit?t:max;
  return {hit,dist,x:x+dx*dist,y:y+dy*dist,z:z+dz*dist,nx:0,ny:0,nz:1};};
 const intern=game as unknown as {fireVehicleWeapons(p:ServerPlayer,c:InputCmd):void;fireHitscan(p:ServerPlayer,c:InputCmd,d:WeaponDef):void;events:{bytes:Uint8Array}[]};
 return {game,p,intern};}

test('Scatterstorm emits nine dispersed authoritative rays and one explosion per real hit without projectiles',()=>{
 const {game,p,intern}=arena();p.vehFireCd=0;intern.fireVehicleWeapons(p,cmd);
 const reports=intern.events.filter(e=>e.bytes[0]===Msg.SFire);assert.equal(reports.length,1);
 const reader=new ByteReader(reports[0].bytes);reader.u8();const fire=decodeFire(reader);
 assert.equal(fire.ends.length,9);assert.ok(fire.ends.every(e=>e.hitKind===0));
 assert.equal(intern.events.filter(e=>e.bytes[0]===Msg.SExplosion).length,9);assert.equal(game.projectiles.size,0);
 assert.ok(Math.max(...fire.ends.map(e=>e.x))-Math.min(...fire.ends.map(e=>e.x))>4,'wide spread needs visibly different beam directions');
 assert.ok(reports[0].bytes.length<180,'one bounded pellet report, not nine entity streams');
 intern.fireVehicleWeapons(p,cmd);assert.equal(intern.events.filter(e=>e.bytes[0]===Msg.SFire).length,1);
});

test('Scatterstorm splash damages a nearby target missed by its direct beam',()=>{
 const {game,p,intern}=arena(),target=game.addPlayer('Near impact',null);
 Object.assign(target.state,{px:2,py:1500,pz:-39.5});target.health=100;
 intern.fireHitscan(p,cmd,{...NOCTURNE_LANCE,pellets:1,spread:0});
 assert.ok(target.health<100&&target.health>90,'small blast must damage beyond the thin ray without paying direct damage');
});

test('Solar Cannon fires a thick moving projectile from its barrel and impacts an off-axis target',()=>{
 const {game,p,intern}=arena(),target=game.addPlayer('Energy shell edge',null);
 Object.assign(p.state,{vehicle:2,vehicleVariant:2});Object.assign(target.state,{px:.8,py:1502.1,pz:-20});target.health=100;
 intern.fireVehicleWeapons(p,cmd);
 const shell=[...game.projectiles.values()].find(r=>r.weapon===BASTION_CANNON.id)!;
 assert.ok(shell);assert.equal(target.health,100,'projectile fire cannot pay instantaneous hitscan damage');
 assert.equal(shell.vy,0);assert.equal(shell.vz,-180);
 const expected=bastionGunMuzzle(0,0,0);
 assert.equal(shell.x,expected.x);assert.equal(shell.y,1500+expected.y);assert.equal(shell.z,expected.z);
 const start=shell.z; const step=()=> (game as unknown as {updateProjectiles():void}).updateProjectiles();
 step();assert.ok(Math.abs(shell.z-start+3)<1e-8,'the energy cylinder advances three metres per fixed tick');
 assert.equal(target.health,100);
 for(let i=0;i<10&&game.projectiles.has(shell.id);i++)step();
 assert.ok(!game.projectiles.has(shell.id));assert.equal(target.health,35,'its actual radius clips the off-axis capsule');
});

test('Solar Cannon stops at cover before an immediately hidden body and retires quietly at maximum range',()=>{
 const {game,p,intern}=arena(),target=game.addPlayer('Behind cover',null);
 Object.assign(p.state,{vehicle:2,vehicleVariant:2});Object.assign(target.state,{px:0,py:1502.1,pz:-40.8});target.health=100;
 intern.fireVehicleWeapons(p,cmd);
 const step=()=> (game as unknown as {updateProjectiles():void}).updateProjectiles();
 for(let i=0;i<20;i++)step();
 assert.equal(target.health,100);assert.equal(game.projectiles.size,0);
 const blasts=intern.events.filter(e=>e.bytes[0]===Msg.SExplosion).length;assert.equal(blasts,1);
 game.world.trace=(x,y,z,dx,dy,dz,max)=>({hit:false,dist:max,x:x+dx*max,y:y+dy*max,z:z+dz*max,nx:0,ny:0,nz:0});
 target.state.px=1000;p.vehFireCd=0;intern.fireVehicleWeapons(p,cmd);
 for(let i=0;i<240;i++)step();
 assert.equal(game.projectiles.size,0);
 assert.equal(intern.events.filter(e=>e.bytes[0]===Msg.SExplosion).length,blasts,'a range limit is not a free explosion');
});

test('nuclear alternate fire launches one cannon shell along exact mouse aim with a shallow ballistic arc',()=>{
 const {game,p,intern}=arena();Object.assign(p.state,{vehicle:2,vehicleVariant:2,heading:.7});
 for(const pitch of [-.15,0,.35]) {
  game.projectiles.clear();p.vehAltCd=0;
  const aim={...cmd,buttons:BTN.ALTFIRE,yaw:-.4,pitch};intern.fireVehicleWeapons(p,aim);
  assert.equal(game.projectiles.size,1);
  const shell=[...game.projectiles.values()][0],offset=bastionGunMuzzle(.7,-.4,pitch);
  assert.equal(shell.weapon,BASTION_SHOCK_SHELL.id);
  assert.ok(Math.hypot(shell.x-offset.x,shell.y-1500-offset.y,shell.z-offset.z)<1e-8);
  assert.ok(Math.abs(shell.vy-Math.sin(pitch)*125)<1e-8,'no upward angle is added to the gunner aim');
  assert.equal(p.vehAltCd,10);
  intern.fireVehicleWeapons(p,aim);assert.equal(game.projectiles.size,1,'held alt is cooldown gated');
 }
});
