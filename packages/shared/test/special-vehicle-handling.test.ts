import {test} from 'node:test';
import assert from 'node:assert/strict';
import {World,createMoveState,stepVehicle,TICK_DT,BTN,vehicleDefinition} from '@shared/index';

test('Bastion accelerates briskly and the larger bomber actually reaches175percent fighter speed',()=>{
  const world=new World(1337);
  world.sdf=(_x,y)=>y;world.groundY=()=>0;
  world.gradient=(_x,_y,_z,out)=>Object.assign(out,{x:0,y:1,z:0});
  const tank=createMoveState(0,.05,0);tank.vehicle=2;tank.vehicleVariant=2;
  const cmd={seq:0,buttons:BTN.FORWARD,weapon:0,yaw:0,pitch:0,renderTick:0,renderFrac:0};
  for(let i=0;i<120;i++)stepVehicle(world,tank,cmd,TICK_DT);
  assert.ok(Math.hypot(tank.vx,tank.vz)>23,'speed must improve in the real simulation, not just a nominal cap');
  assert.ok(-tank.pz>35,'the heavy hull must leave its parking space promptly');
  const speeds=[];
  for(const variant of [0,1]) {
    const jet=createMoveState(0,1000,0);jet.vehicle=3;jet.vehicleVariant=variant;jet.vz=-30;
    for(let i=0;i<360;i++)stepVehicle(world,jet,{...cmd,buttons:BTN.THROTTLE},TICK_DT);
    speeds.push(Math.hypot(jet.vx,jet.vy,jet.vz));
    assert.ok(Math.abs(speeds[variant]-vehicleDefinition(3,variant)!.maxSpeed)<.01);
  }
  assert.ok(Math.abs(speeds[1]/speeds[0]-1.75)<1e-5);
});
