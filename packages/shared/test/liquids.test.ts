import {test} from 'node:test';
import assert from 'node:assert/strict';
import {vehicleEyeOffset} from '../src/vehicles.js';
import {rotationFromEuler} from '../src/rotation.js';
import {World,sampleCaveFloorLayers} from '../src/worldgen.js';
import {liquidFootprint,surfaceLiquidVolumes,SWIMMING,islandRadius,islandCoastDistance,ISLAND_SHORE_END} from '../src/liquids.js';
import {createMoveState,stepMove,BTN} from '../src/movement.js';
import {PLAYER,TICK_DT} from '../src/constants.js';
import {buildJungleTemplePlan} from '../src/jungle-temples.js';
import {capsuleClearance} from '../src/physics.js';

const command=(buttons=0,pitch=0)=>({seq:0,buttons,weapon:0,yaw:0,pitch,renderTick:0,renderFrac:0});

test('real island coast is wet at sea level while inland lakes and the river retain independent levels',()=>{
 const world=new World(1337);
 for(let i=0;i<24;i++) {
  const angle=i*Math.PI/12,radius=10900/islandRadius(Math.cos(angle),Math.sin(angle)),x=Math.cos(angle)*radius,z=Math.sin(angle)*radius;
  assert.ok(islandCoastDistance(1337,x,z)>ISLAND_SHORE_END);
  const col=world.column(x,z),liquid=world.liquidAt(x,-1,z);
  assert.equal(liquid?.kind,'water');assert.equal(liquid.surfaceY,0);assert.ok(col.h<-40);
  assert.equal(col.lavaY,-1000,'coastal grading cannot leave lava floating over ocean water');
  assert.equal(world.liquidAt(x,.1,z),undefined);assert.equal(world.liquidAt(x,col.h-1,z),undefined);
 }
 for(const volume of surfaceLiquidVolumes().filter(v=>v.shape==='ellipse')) {
  const fluid=world.liquidAt(volume.x,volume.level-2,volume.z);
  assert.equal(fluid?.id,volume.id,volume.name);assert.equal(fluid.surfaceY,volume.level);
  assert.ok(fluid.bottomY<fluid.surfaceY-5);assert.equal(world.liquidAt(volume.x,volume.level+.1,volume.z),undefined);
 }
 const river=surfaceLiquidVolumes().find(v=>v.shape==='river')!;
 for(const [x,z] of [[6200,1300],[7200,1500],[8300,1100]]) {
  const level=liquidFootprint(river,1337,x,z).surfaceY,fluid=world.liquidAt(x,level-1,z);
  assert.equal(fluid?.id,river.id);assert.ok(Math.abs(fluid.surfaceY-level)<1e-9);assert.ok(fluid.flowX>0);
 }
});

test('ordinary deep caves stay dry below sea level and below finite lake beds',()=>{
 const world=new World(1337);let caves=0;
 outer:for(let z=-512;z<=512;z+=128)for(let x=-512;x<=512;x+=128)for(const floor of sampleCaveFloorLayers(world,x,z)) {
  assert.ok(floor.y<0);assert.equal(world.liquidAt(x,floor.y+PLAYER.EYE_HEIGHT,z),undefined);
  if(++caves>=12)break outer;
 }
 assert.equal(caves,12,'witnesses must be actual meshed underground floors');
 for(const volume of surfaceLiquidVolumes().filter(v=>v.shape==='ellipse')) {
  const sample=world.liquidAt(volume.x,volume.level-1,volume.z)!;
  assert.equal(world.liquidAt(volume.x,sample.bottomY-2,volume.z),undefined,'water stops at the lake bed');
 }
});

test('head immersion drains and restores air independently of wading, while deep-water entry absorbs a fast fall',()=>{
 const world=new World(1337),s=createMoveState(450,8,1250);
 for(let i=0;i<600;i++)stepMove(world,s,command(BTN.BRAKE),TICK_DT);
 assert.equal(s.submerged,true);assert.ok(Math.abs(s.airSeconds!-8)<1e-6);
 for(let i=0;i<600;i++)stepMove(world,s,command(BTN.BRAKE),TICK_DT);
 assert.equal(s.airSeconds,0);assert.ok(capsuleClearance(world,s.px,s.py,s.pz)>-.03);
 for(let i=0;i<420;i++)stepMove(world,s,command(BTN.JUMP),TICK_DT);
 assert.equal(s.submerged,false);assert.equal(s.airSeconds,SWIMMING.AIR_SECONDS);
 const falling=createMoveState(450,100,1250);falling.vy=-70;let maxImpact=0,entered=false;
 for(let i=0;i<240;i++){const result=stepMove(world,falling,command(),TICK_DT);maxImpact=Math.max(maxImpact,result.impact);entered ||= !!falling.swimming;}
 assert.ok(entered);assert.equal(maxImpact,0,'the water catches the player before the solid bed can inflict fall damage');
 assert.equal(falling.alive,true);assert.ok(falling.py>world.column(450,1250).h);
});

test('the real pyramid cistern supports diving, surfacing and a walkable stair exit',()=>{
 const world=new World(1337),site=world.collectJungleTemples().find(s=>s.kind==='great-pyramid')!;
 const pool=buildJungleTemplePlan(site).cisterns[0],s=createMoveState(pool.x,pool.bottom+.1,pool.z);
 assert.equal(world.liquidAt(s.px,s.py+PLAYER.EYE_HEIGHT,s.pz)?.id,pool.id);
 for(let i=0;i<180;i++)stepMove(world,s,command(BTN.JUMP),TICK_DT);
 assert.equal(s.submerged,false);assert.ok(s.py>pool.level-1);
 for(let i=0;i<180;i++)stepMove(world,s,command(BTN.FORWARD|BTN.JUMP),TICK_DT);
 assert.equal(s.swimming,false);assert.equal(s.grounded,true);assert.ok(s.py>pool.level+.7);
 assert.ok(Math.abs(s.pz-pool.z)>pool.hz);assert.ok(capsuleClearance(world,s.px,s.py,s.pz)>-.02);
 assert.equal(world.liquidAt(s.px,s.py+.72,s.pz),undefined,'the surrounding gallery is dry');
});

test('breathing samples the same quaternion-rotated eye as inverted pilots and underside gunners',()=>{
 const world=new World(1337);
 for(const variant of [0,1]) {
  const pilot=createMoveState(4900,5,1200);pilot.vehicle=3;pilot.vehicleVariant=variant;pilot.vehicleRotation=rotationFromEuler(0,Math.PI,0);
  const eye=vehicleEyeOffset(pilot);assert.ok(eye.y<0);assert.equal(world.liquidAt(pilot.px+eye.x,pilot.py+eye.y,pilot.pz+eye.z)?.kind,'water');
  stepMove(world,pilot,command(),TICK_DT);assert.equal(pilot.submerged,true);assert.ok(pilot.airSeconds!<18);
  const gunner=createMoveState(4900,5.7,1200);gunner.vehicle=3;gunner.vehicleVariant=variant;gunner.seat=1;gunner.vehicleRotation=rotationFromEuler(0,0,0);
  const under=vehicleEyeOffset(gunner);assert.ok(under.y<.3);assert.ok(under.z>.5);
  stepMove(world,gunner,command(),TICK_DT);assert.equal(gunner.submerged,true,'underside camera can submerge while cockpit is above water');
 }
});
