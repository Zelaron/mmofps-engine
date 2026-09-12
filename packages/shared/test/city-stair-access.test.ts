import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, createMoveState, stepMove, TICK_DT, BTN, capsuleClearance } from '@shared/index';

test('ordinary-city walking climbs both stair flights and reaches the upper lift ring', () => {
  const world=new World(1337);
  for(const city of world.collectCities().filter(c => !c.theme)) {
    const roof={x:city.x+96,z:city.z+96},floor=city.y+.06;
    const state=createMoveState(roof.x+17,floor+.12,roof.z+17);
    // Turn on the flat middle court. Turning on the first riser while still
    // airborne carries lateral momentum off a narrow stair flight.
    const path=[[roof.x+17,roof.z-16,12],[roof.x+11,roof.z-16,12],
      [roof.x+11,roof.z+14.5,24],[roof.x+5,roof.z+20,24],
      [city.x+113,city.z+120,24],[city.x+124,city.z+120,24],[city.x+124,city.z+128,24]];
    let seq=0;
    for(const [x,z,height] of path) {
      let ticks=0;
      for(;ticks<700;ticks++) {
        const dx=x-state.px,dz=z-state.pz;if(Math.hypot(dx,dz)<.18)break;
        stepMove(world,state,{seq:seq++,buttons:BTN.FORWARD,weapon:0,
          yaw:Math.atan2(-dx,-dz),pitch:0,renderTick:0,renderFrac:0},TICK_DT);
      }
      assert.ok(ticks<700,`${city.name}: route blocked before${x},${z}`);
      assert.ok(state.py-floor>=height-.12,`${city.name}: fell off stair or bridge; expected${height}m, got${state.py-floor}`);
      assert.ok(capsuleClearance(world,state.px,state.py,state.pz)>-.01);
    }
    assert.ok(Math.abs(state.py-floor-24)<.15,'upper ring connects to the supported promenade');
  }
});
