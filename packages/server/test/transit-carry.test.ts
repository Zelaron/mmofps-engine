import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerVehicle } from '../src/game.js';
import { VEHICLE, vehicleDefinition, wrapAngle, BTN } from '@shared/index';
import { transportPose } from '@shared/transport';
import { transitWorld, transitLocal } from '@shared/transit-motion';

test('a parked tank stays on a turning ferry and snapshots its carried heading', () => {
  const game = new Game(1337), route = game.world.collectTransportPlan().routes.find(r => r.kind === 'ferry')!;
  game.tick = 30 * 60;
  const first = transportPose(route, game.tick / 60), p = transitWorld(first, 0, 2.006, 0);
  const tank: ServerVehicle = { id: 990, type: VEHICLE.TANK, ...p, heading: first.yaw, health: vehicleDefinition(VEHICLE.TANK)!.maxHealth,
    occupant: -1, respawnAtTick: -1 };
  game.vehicles.set(tank.id, tank);
  for (let i = 0; i < 600; i++) {
    game.step();
    const pose = transportPose(route, game.tick / 60), local = transitLocal(pose, tank.x, tank.y, tank.z);
    assert.ok(Math.hypot(local.x, local.z) < .03);
    assert.ok(Math.abs(local.y - 2) < .03);
    assert.ok(Math.abs(wrapAngle(tank.heading - pose.yaw)) < .01, 'parked hull orientation should follow the deck');
    assert.equal(tank.health, vehicleDefinition(VEHICLE.TANK)!.maxHealth);
  }
});

test('a jump in the middle of a packet burst retains ferry and train momentum',()=>{
  for(const kind of ['ferry','train'] as const) {
    const game=new Game(1337),route=game.world.collectTransportPlan().routes.find(r=>r.kind===kind)!;
    const leg=route.legs[0],section=leg.distances.findIndex((d,i)=>i>0&&d-leg.distances[i-1]>800);
    game.tick=Math.round((route.dwell+1.5+(leg.distances[section-1]+300)/route.speed)*60);
    const car=kind==='train'?2:0,floor=kind==='train'?1.2:2,pose=transportPose(route,game.tick/60,route.carOffsets[car]);
    const p=game.addPlayer('Passenger',null),start=transitWorld(pose,0,floor+.006,0);
    Object.assign(p.state,{px:start.x,py:start.y,pz:start.z,grounded:true,simulationTick:game.tick});
    for(let seq=1;seq<=3;seq++)game.queueInput(p,{seq,buttons:seq===2?BTN.JUMP:0,yaw:pose.yaw,pitch:0,weapon:0,renderTick:0,renderFrac:0});
    game.step();
    assert.equal(p.state.grounded,false);
    const next=transportPose(route,(game.tick-1)/60+.001,route.carOffsets[car]);
    const vx=(next.x-pose.x)/.001,vz=(next.z-pose.z)/.001;
    assert.ok(Math.hypot(p.state.vx-vx,p.state.vz-vz)<.1,`${kind} burst jump lost deck momentum`);
    for(let i=0;i<85;i++)game.step();
    const local=transitLocal(transportPose(route,game.tick/60,route.carOffsets[car]),p.state.px,p.state.py,p.state.pz);
    assert.ok(Math.hypot(local.x,local.z)<.25,`${kind} burst jump drifted ${JSON.stringify(local)}`);
    assert.ok(Math.abs(local.y-floor)<.05);assert.equal(p.health,100);
  }
});
