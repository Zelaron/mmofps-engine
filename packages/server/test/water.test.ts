import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Game,type ServerPlayer} from '../src/game.js';
import {BTN,TICK_DT,PLAYER,VEHICLE,SWIMMING,GUNBOAT_DRAFT,vehicleDefinition,capsuleClearance,sphereFieldContact,ByteReader,decodeSnapshot,type InputCmd} from '@shared/index';
import {harborBoatSite,harborDockSide} from '@shared/transport';

function apply(game:Game,p:ServerPlayer,buttons=0):void {
 const cmd:InputCmd={seq:game.tick+1,buttons,weapon:0,yaw:0,pitch:0,renderTick:0,renderFrac:0};game.tick++;
 (game as unknown as {applyCmd(p:ServerPlayer,cmd:InputCmd):void}).applyCmd(p,cmd);
}

test('server drowning damages only after air exhaustion and surfacing stops damage while recovering air',()=>{
 const game=new Game(1337),p=game.addPlayer('diver',null);
 Object.assign(p.state,{px:450,py:8,pz:1250,vx:0,vy:0,vz:0,airSeconds:SWIMMING.AIR_SECONDS});
 for(let i=0;i<17*60;i++)apply(game,p,BTN.BRAKE);
 assert.equal(p.health,PLAYER.MAX_HEALTH);assert.ok(Math.abs(p.state.airSeconds!-1)<1e-6);
 for(let i=0;i<120;i++)apply(game,p,BTN.BRAKE);
 assert.ok(p.health<83&&p.health>80,'one second without air costs the configured18HP');
 Object.assign(p.state,{py:11,vx:0,vy:0,vz:0});const health=p.health;
 for(let i=0;i<240;i++)apply(game,p,BTN.JUMP);
 assert.equal(p.state.submerged,false);assert.equal(p.health,health);assert.equal(p.state.airSeconds,18);
});

test('drowning and lava victims respawn with full air and dry movement flags before the first new input',()=>{
 for(const kind of ['water','lava'] as const) {
  const game=new Game(1337),p=game.addPlayer(`${kind}-respawn`,null);
  let at={x:450,y:8,z:1250};
  if(kind==='lava') {
   let found=false;
   outer:for(let x=-4436;x<=-3436;x+=16)for(let z=1964;z<=2964;z+=16) {
    const col=game.world.column(x,z);
    if(col.lavaY>-999&&col.lavaY-col.h>3) {at={x,y:col.lavaY-2.2,z};found=true;break outer;}
   }
   assert.ok(found,'the witness must use an actual deep lava pool');
  }
  Object.assign(p.state,{px:at.x,py:at.y,pz:at.z,vx:0,vy:0,vz:0,airSeconds:kind==='water'?0:9});
  assert.equal(game.world.liquidAt(at.x,at.y+PLAYER.EYE_HEIGHT,at.z)?.kind,kind);
  p.health=.1;apply(game,p,BTN.BRAKE);
  assert.equal(p.state.alive,false,`${kind} exposure must cause the death`);
  assert.equal(p.state.submerged,true);assert.equal(p.state.swimming,true);
  assert.ok(p.state.airSeconds!<SWIMMING.AIR_SECONDS);

  game.tick=p.respawnAtTick-1;game.step();
  assert.equal(p.state.alive,true);assert.equal(p.health,PLAYER.MAX_HEALTH);
  assert.equal(game.world.liquidAt(p.state.px,p.state.py+PLAYER.EYE_HEIGHT,p.state.pz),undefined);
  assert.equal(p.lastCmd,null,'no new movement tick may be needed to repair the respawn state');
  assert.equal(p.state.airSeconds,SWIMMING.AIR_SECONDS);
  assert.equal(p.state.submerged,false);assert.equal(p.state.swimming,false);
  const bytes=(game as unknown as {buildSnapshotFor(p:ServerPlayer):Uint8Array}).buildSnapshotFor(p);
  const reader=new ByteReader(bytes);reader.u8();const snapshot=decodeSnapshot(reader);
  // The compact decoder omits the dry/default values, as Prediction expects.
  assert.equal(snapshot.you.airSeconds??SWIMMING.AIR_SECONDS,SWIMMING.AIR_SECONDS);
  assert.equal(snapshot.you.submerged??false,false);assert.equal(snapshot.you.swimming??false,false);
 }
});

test('boarding an above-water gunner seat clears stale drowning and preserves each occupants own air reserve',()=>{
 const game=new Game(1337),pilot=game.addPlayer('pilot',null),gunner=game.addPlayer('gunner',null),level=12;
 game.vehicles.set(901,{id:901,type:VEHICLE.GUNBOAT,x:450,y:level-GUNBOAT_DRAFT,z:1250,heading:0,
  health:vehicleDefinition(VEHICLE.GUNBOAT)!.maxHealth,occupant:-1,respawnAtTick:-1});
 Object.assign(pilot.state,{px:453,py:11,pz:1250,vx:0,vy:0,vz:0});apply(game,pilot,BTN.USE);
 Object.assign(gunner.state,{px:453,py:9,pz:1250,vx:0,vy:0,vz:0,submerged:true,airSeconds:0});apply(game,gunner,BTN.USE);
 assert.equal(gunner.state.seat,1);assert.equal(gunner.state.submerged,false);assert.equal(gunner.health,100);
 for(let i=0;i<60;i++)apply(game,gunner);
 assert.ok(gunner.state.airSeconds!>5&&gunner.state.airSeconds!<5.2);assert.equal(pilot.state.airSeconds,18,'passenger recovery never steals or copies pilot reserve');
 pilot.state.py=5;const air=gunner.state.airSeconds!;for(let i=0;i<60;i++)apply(game,gunner);
 assert.equal(gunner.state.submerged,true);assert.ok(Math.abs(gunner.state.airSeconds!-(air-1))<1e-6,'a submerged gunner consumes their own air');
});

test('all real harbor boats board from the dock, dismount to dry support and respawn at the local water surface',()=>{
 const game=new Game(1337,{vehicles:true}),p=game.addPlayer('sailor',null),harbors=game.world.collectTransportPlan().harbors;
 const boats=[...game.vehicles.values()].filter(v=>v.type===VEHICLE.GUNBOAT);assert.equal(boats.length,5);
 for(const harbor of harbors) {
  const berth=harborBoatSite(harbor),v=boats.find(v=>Math.hypot(v.x-berth.x,v.z-berth.z)<.1)!;assert.ok(v,harbor.name);
  const liquid=game.world.liquidAt(v.x,game.world.column(v.x,v.z).h+.5,v.z)!;
  assert.equal(liquid.kind,'water');assert.ok(Math.abs(v.y+GUNBOAT_DRAFT-liquid.surfaceY)<.015,harbor.name);
  const c=Math.cos(harbor.heading),sn=Math.sin(harbor.heading),side=harborDockSide(harbor);
  Object.assign(p.state,{px:harbor.x+c*29*side-sn*33.85,py:harbor.y+2.03,pz:harbor.z-sn*29*side-c*33.85,vx:0,vy:0,vz:0});
  apply(game,p);apply(game,p,BTN.USE);assert.equal(p.vehicleId,v.id,`${harbor.name}: E boards from dry quay`);
  apply(game,p);apply(game,p,BTN.USE);assert.equal(p.state.vehicle,0);
  assert.ok(p.state.py>=harbor.y+1.9,`${harbor.name}: dismount reaches dock instead of dropping into water`);
  assert.ok(capsuleClearance(game.world,p.state.px,p.state.py,p.state.pz)>-.02);
  assert.ok(Math.abs(v.y+GUNBOAT_DRAFT-liquid.surfaceY)<.03,'abandoned boat keeps its buoyant origin');
 }
 Object.assign(p.state,{px:0,py:600,pz:0});
 for(const v of boats)game.damageVehicle(v,1e9,null,255);
 game.tick=Math.max(...boats.map(v=>v.respawnAtTick));
 for(let i=0;i<150&&boats.some(v=>v.respawnAtTick>=0);i++) {(game as unknown as {updateVehicles():void}).updateVehicles();game.tick++;}
 for(const v of boats) {
  assert.equal(v.respawnAtTick,-1);assert.equal(v.health,vehicleDefinition(VEHICLE.GUNBOAT)!.maxHealth);
  const fluid=game.world.liquidAt(v.x,v.y+GUNBOAT_DRAFT-.08,v.z);assert.equal(fluid?.kind,'water');
  assert.ok(Math.abs(v.y+GUNBOAT_DRAFT-fluid.surfaceY)<.04,'respawn height uses the selected berth liquid, including estuary level');
  assert.equal(sphereFieldContact(game.world,v.x,v.y+2.2,v.z,2.2),null);
 }
});
