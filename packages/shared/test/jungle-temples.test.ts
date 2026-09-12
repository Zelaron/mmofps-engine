import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/worldgen.js';
import { buildJungleTemplePlan, templeTrapPose, templeTrapTouches } from '../src/jungle-temples.js';
import { capsuleClearance } from '../src/physics.js';
import { BTN, createMoveState, stepMove } from '../src/movement.js';
import { TICK_DT } from '../src/constants.js';

test('rainforests contain a huge pyramid and six varied two-exit shrines with bounded shared geometry',()=>{
  for(const seed of [1,1337,424242]) {
    const world=new World(seed), sites=world.collectJungleTemples();
    assert.equal(sites.length,7);assert.equal(new Set(sites.map(s=>s.kind)).size,4);
    for(const site of sites) {
      const p=buildJungleTemplePlan(site);
      assert.equal(p,buildJungleTemplePlan(site));assert.ok(p.solids.length<500);
      assert.equal(p.entrances.length,site.kind==='great-pyramid'?4:2);
      assert.ok(p.loot.length>=2&&p.traps.length>=1);
      assert.ok(p.loot.every(l=>l.cave&&[5,6,9].includes(l.weapon)));
    }
    const pyramid=buildJungleTemplePlan(sites[0]);
    assert.ok(Math.max(...pyramid.solids.map(b=>b.x+b.hx))-Math.min(...pyramid.solids.map(b=>b.x-b.hx))>=208);
    assert.ok(pyramid.cisterns.length===1);
  }
});

test('all authored jungle routes have supported player-sized clearance in real generated worlds',()=>{
  for(const seed of [1,1337,424242]) {
    const world=new World(seed);
    for(const site of world.collectJungleTemples()) {
      const plan=buildJungleTemplePlan(site);
      for(const route of plan.routes)for(let j=1;j<route.length;j++) {
        const a=route[j-1],b=route[j],length=Math.hypot(b.x-a.x,b.z-a.z), steps=Math.max(1,Math.ceil(length/3));
        for(let i=0;i<=steps;i++) {
          const t=i/steps,x=a.x+(b.x-a.x)*t,y=a.y+(b.y-a.y)*t,z=a.z+(b.z-a.z)*t;
          assert.ok(capsuleClearance(world,x,y+.07,z)>=-.025,`seed${seed} temple${site.id} blocked at${x-site.x},${y-site.y},${z-site.z}`);
          assert.ok(world.sdf(x,y-.12,z)<0,`seed${seed} temple${site.id} unsupported route at${x-site.x},${y-site.y},${z-site.z}`);
        }
      }
      for(const loot of plan.loot) {
        assert.ok(world.sdf(loot.x,loot.y-.15,loot.z)<0,'offering plate has no support');
        assert.ok(world.sdf(loot.x,loot.y+.4,loot.z)>0,'loot is buried');
      }
    }
  }
});

test('pyramid front entry can be walked down and back out without jumping or teleporting',()=>{
  const world=new World(1337),plan=buildJungleTemplePlan(world.collectJungleTemples()[0]), route=plan.routes[0];
  const s=createMoveState(route[0].x,route[0].y+.02,route[0].z);s.grounded=true;
  for(const destination of [...route.slice(1),...route.slice(0,-1).reverse()]) {
    let ticks=0;
    while(Math.hypot(s.px-destination.x,s.pz-destination.z)>.25 && ticks++<1400) {
      stepMove(world,s,{seq:0,buttons:BTN.FORWARD,weapon:0,yaw:Math.atan2(s.px-destination.x,s.pz-destination.z),pitch:0,renderTick:0,renderFrac:0},TICK_DT);
    }
    assert.ok(ticks<1400,`cannot reach waypoint${JSON.stringify(destination)}: ${JSON.stringify(s)}`);
    assert.ok(Math.abs(s.py-destination.y)<.2,'route fell into another cave level');
  }
});

test('trap warnings precede bounded danger with shared visible contact and long safe intervals',()=>{
  const world=new World(1337);
  for(const trap of buildJungleTemplePlan(world.collectJungleTemples()[0]).traps) {
    assert.equal(templeTrapPose(trap,1.7-trap.phase).warning,true);
    assert.equal(templeTrapTouches(trap,1.7-trap.phase,trap.x,trap.y,trap.z),false);
    const time=2.9-trap.phase;
    const pose=templeTrapPose(trap,time),x=trap.kind==='darts'?trap.x+(((pose.progress*3)%1)*2-1)*trap.hx:trap.x;
    assert.equal(templeTrapTouches(trap,time,x,trap.y,trap.z),true);
    assert.equal(templeTrapTouches(trap,time,trap.x+trap.hx+1,trap.y,trap.z),false);
    assert.equal(templeTrapPose(trap,5-trap.phase).active,false);
  }
});

test('pyramid cistern has a bounded deep basin, dry perimeter and supported access stair',()=>{
  const world=new World(1337),plan=buildJungleTemplePlan(world.collectJungleTemples()[0]),pool=plan.cisterns[0];
  assert.ok(world.sdf(pool.x+4,pool.bottom+.1,pool.z)>0);
  assert.ok(world.sdf(pool.x+4,pool.bottom-.1,pool.z)<0);
  assert.equal(world.liquidAt(pool.x+4,pool.level-.2,pool.z)?.kind,'water');
  assert.equal(world.liquidAt(pool.x+11,plan.site.y-23,pool.z),undefined);
  assert.ok(capsuleClearance(world,pool.x+11,plan.site.y-24+.04,pool.z)>=-.02);
  for(let i=0;i<20;i++) {
    const z=pool.z-8+i*.45,top=plan.site.y-24-(i+1)*.25;
    assert.ok(world.sdf(pool.x,top-.05,z)<0,'cistern stair lost its stone tread');
    assert.ok(capsuleClearance(world,pool.x,top+.1,z)>=-.1,'cistern stair cannot fit a player');
  }
});
