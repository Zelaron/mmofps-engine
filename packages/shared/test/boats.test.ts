import {test} from 'node:test';
import assert from 'node:assert/strict';
import {World} from '../src/worldgen.js';
import {stepBoat} from '../src/boats.js';
import {createMoveState,BTN} from '../src/movement.js';
import {VEHICLE,GUNBOAT_DRAFT,vehicleDefinition} from '../src/vehicles.js';
import {sphereFieldContact,capsuleClearance} from '../src/physics.js';
import {harborBoatSite,harborDockSide} from '../src/transport.js';
import {TICK_DT} from '../src/constants.js';
const command=(buttons=0)=>({seq:0,buttons,weapon:0,yaw:0,pitch:0,renderTick:0,renderFrac:0});

test('gunboats reach24m/s in real water and follow local lake/river buoyancy levels',()=>{
 const world=new World(1337);
 for(const [x,z] of [[4900,1200],[9800,4000]]) {
  const level=world.liquidAt(x,world.column(x,z).h+.5,z)!.surfaceY,s=createMoveState(x,level-GUNBOAT_DRAFT,z);s.vehicle=VEHICLE.GUNBOAT;
  for(let i=0;i<180;i++)stepBoat(world,s,command(BTN.FORWARD),TICK_DT);
  assert.ok(Math.abs(Math.hypot(s.vx,s.vz)-24)<.001);assert.ok(Math.abs(s.py-(level-GUNBOAT_DRAFT))<.01);
  assert.ok(z-s.pz>44);assert.equal(sphereFieldContact(world,s.px,s.py+2.2,s.pz,2.2),null);
 }
 const x=7100,z=1480,level=world.liquidAt(x,world.column(x,z).h+.5,z)!.surfaceY,s=createMoveState(x,level-GUNBOAT_DRAFT,z);
 s.vehicle=VEHICLE.GUNBOAT;s.heading=-Math.PI/2;
 for(let i=0;i<180;i++)stepBoat(world,s,command(BTN.FORWARD),TICK_DT);
 const current=world.liquidAt(s.px,s.py+GUNBOAT_DRAFT-.1,s.pz)!;
 assert.ok(Math.abs(s.py+GUNBOAT_DRAFT-current.surfaceY)<.015,'buoyancy tracks the river rather than staying at its original level');
});

test('fast boats collide with a real shoreline instead of tunneling onto land',()=>{
 const world=new World(1337),s=createMoveState(450,12-GUNBOAT_DRAFT,1250);s.vehicle=VEHICLE.GUNBOAT;s.heading=-Math.PI/2;s.vx=24;
 let impact=0;for(let i=0;i<600;i++)impact=Math.max(impact,stepBoat(world,s,command(BTN.FORWARD),TICK_DT));
 assert.ok(s.px<660,'the boat cannot power through the eastern lagoon bank');
 assert.ok(Math.abs(s.vx)<1);assert.equal(s.grounded,true,'the gentle bank physically beaches the hull');
 const contact=sphereFieldContact(world,s.px,s.py+2.2,s.pz,2.2);assert.ok(!contact||contact.depth<.04);
});

test('all five authored harbor berths have water, clear hulls and reachable dry boarding positions',()=>{
 const world=new World(1337),harbors=world.collectTransportPlan().harbors;assert.equal(harbors.length,5);
 for(const harbor of harbors) {
  const berth=harborBoatSite(harbor),col=world.column(berth.x,berth.z),fluid=world.liquidAt(berth.x,col.h+.5,berth.z);
  assert.equal(fluid?.kind,'water',harbor.name);assert.equal(col.lavaY,-1000);
  const y=fluid.surfaceY-GUNBOAT_DRAFT,r=vehicleDefinition(VEHICLE.GUNBOAT)!.radius;
  assert.equal(sphereFieldContact(world,berth.x,y+r,berth.z,r),null,harbor.name);
  const c=Math.cos(harbor.heading),sn=Math.sin(harbor.heading),px=harbor.x+c*29*harborDockSide(harbor)-sn*33.85,pz=harbor.z-sn*29*harborDockSide(harbor)-c*33.85,py=harbor.y+2.03;
  assert.ok(capsuleClearance(world,px,py,pz)>0,`${harbor.name}: dry dock capsule`);
  assert.ok(Math.hypot(berth.x-px,y+r-py-1,berth.z-pz)<=vehicleDefinition(VEHICLE.GUNBOAT)!.enterRange,`${harbor.name}: E boarding reach`);
 }
});
