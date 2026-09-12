import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, createMoveState, stepMove, TICK_DT, BTN, capsuleClearance } from '@shared/index';
import { cityVehicleSites } from '@shared/cities';

test('capital motorcourts remain clear and special hulls can drive or launch using ordinary controls', () => {
  for(const seed of [1,1337,424242]) {
    const world=new World(seed);
    for(const city of world.collectCities()) for(const site of cityVehicleSites(city)) {
      for(let x=-12;x<=12;x+=3) for(let z=-12;z<=12;z+=3) {
        assert.ok(capsuleClearance(world,site.x+x,site.y+.1,site.z+z)>=-.01,
          `${seed} ${city.name} pad blocked at${x},${z}`);
      }
      const state=createMoveState(site.x,site.y+.1,site.z);
      state.vehicle=site.type;state.vehicleVariant=site.variant;state.heading=site.heading;
      for(let tick=0;tick<240;tick++) stepMove(world,state,{seq:tick,buttons:site.type===3
        ? BTN.THROTTLE|(tick>45&&tick<80?BTN.BACK:0):BTN.FORWARD,
        weapon:0,yaw:0,pitch:0,renderTick:0,renderFrac:0},TICK_DT);
      assert.ok(Math.hypot(state.px-site.x,state.pz-site.z)>(site.type===3?150:16),`${city.name} hull cannot leave pad`);
      if(site.type===3) assert.ok(state.py-site.y>80,`${city.name} interceptor cannot take off`);
      else assert.ok(Math.abs(state.py-site.y)<.15,'palace motorcourt route must remain level');
    }
  }
});
