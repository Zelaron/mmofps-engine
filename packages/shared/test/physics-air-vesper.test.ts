import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { PLAYER } from '@shared/constants';
import { collideCapsule, capsuleClearance, capsuleHasGroundSupport, type KinState } from '@shared/physics';
import { createMoveState, stepMove } from '@shared/movement';
import { proveCapsuleAirPrism } from '@shared/physics-air';
import { setVehicleColliders } from '@shared/vehicle-collision';

// The reference field has identical values and deliberately disables the air
// proof, retaining the canonical contact solver for complete state comparisons.
const EPS=1e-6, REACH=PLAYER.RADIUS+.006-.0005+EPS;
const captured:KinState={px:-2990,py:60,pz:-5223,vx:0,vy:0,vz:0,grounded:false};
function pair():[World,World] {
  const reference=new World(7331),sdf=reference.sdf;
  reference.sdf=function(...args){return sdf.apply(this,args);};
  return [reference,new World(7331)];
}
const eligible=(w:World,s=captured)=>proveCapsuleAirPrism(w,s.px,s.py,s.pz);
function compare(worlds:[World,World],state:KinState,dt=0,snap=false):KinState {
  const expected={...state},actual={...state};
  const er=collideCapsule(worlds[0],expected,dt,snap),ar=collideCapsule(worlds[1],actual,dt,snap);
  assert.deepStrictEqual(actual,expected);assert.deepStrictEqual(ar,er);
  return actual;
}
function vesper(w:World) {
  const city=w.collectCities().find(c=>c.theme==='vesper'&&Math.hypot(c.x-captured.px,c.z-captured.pz)<c.radius);
  assert(city,'the captured Cinder pose must lie in a native Vesper capital');
  return city;
}

test('native Vesper abyss is clear air, never invented support, and preserves complete falling controller state',()=>{
  const worlds=pair();vesper(worlds[1]);
  assert.equal(eligible(worlds[0]),false);assert.equal(eligible(worlds[1]),true);
  assert(capsuleClearance(worlds[1],captured.px,captured.py,captured.pz)>0);
  assert.equal(capsuleHasGroundSupport(worlds[1],captured.px,captured.py,captured.pz),false);
  const expected=createMoveState(captured.px,captured.py,captured.pz),actual={...expected};
  let admitted=0;
  for(let tick=1;tick<=240;tick++){
    if(eligible(worlds[1],actual))admitted++;
    const cmd={seq:tick,buttons:0,weapon:0,yaw:0,pitch:0,renderTick:tick,renderFrac:0};
    const er=stepMove(worlds[0],expected,cmd,1/60,tick),ar=stepMove(worlds[1],actual,cmd,1/60,tick);
    assert.deepStrictEqual(actual,expected,`complete state at tick ${tick}`);
    assert.deepStrictEqual(ar,er,`controller result at tick ${tick}`);
  }
  assert(admitted>60,'exercise continued proof use, not just an initial admission');
  assert(actual.py<captured.py-20,'the proof must not create an invisible floor');
});

test('Vesper proof bounds the entire expanded four-meter cell, including radial corners',()=>{
  const worlds=pair(),w=worlds[1],city=vesper(w),bound=city.radius*.85-260-EPS;
  const y=2500; // Above native spires: isolates the horizontal admission bound.
  const inner={...captured,px:city.x+1432.1,pz:city.z+.1,py:y};
  assert(eligible(w,inner),'native interior cell should have an empty high-air prism');
  const cardinal={...inner,px:city.x+1439.9};
  assert(Math.hypot(cardinal.px-city.x,cardinal.pz-city.z)<bound);
  assert.equal(eligible(w,cardinal),false,'the point is inside but its expanded cell crosses the radial limit');
  const diagonal={...inner,px:city.x+1017.9,pz:city.z+1017.9};
  assert(Math.hypot(diagonal.px-city.x,diagonal.pz-city.z)<bound);
  const ax=Math.max(Math.abs(Math.floor(diagonal.px/4)*4-REACH-EPS-city.x),Math.abs((Math.floor(diagonal.px/4)+1)*4+REACH+EPS-city.x));
  const az=Math.max(Math.abs(Math.floor(diagonal.pz/4)*4-REACH-EPS-city.z),Math.abs((Math.floor(diagonal.pz/4)+1)*4+REACH+EPS-city.z));
  assert(Math.hypot(ax,az)>bound,'the diagonal expanded corner is outside');
  for(const pose of[cardinal,diagonal,{...inner,px:city.x+1551},{...inner,px:city.x+1690},{...inner,px:city.x+1900}]){
    assert.equal(eligible(w,pose),false,'rim and raised approach retain the canonical controller');
    compare(worlds,{...pose,vy:-3},1/60,true);
  }
});

test('Vesper conservative minus-sixty terrain floor has strict contact-threshold fallback',()=>{
  const worlds=pair(),w=worlds[1];
  const threshold=-60+2*EPS-PLAYER.RADIUS+REACH;
  // This is the actual captured empty cell, not an injected flat floor.
  const above={...captured,py:threshold+1e-5};
  assert(eligible(w,above),'the captured native cell must remain empty at the conservative floor ceiling');
  for(const offset of[-.05,-1e-5,-1e-7,0,1e-7,1e-5,.05]){
    const pose={...captured,py:threshold+offset};
    if(offset<0)assert.equal(eligible(w,pose),false);
    if(offset>0)assert.equal(eligible(w,pose),true);
    compare(worlds,pose);
    compare(worlds,{...pose,vy:-.5},1/60,true);
  }
  // Check the actual native terrain values on the complete cached cell and its
  // expanded corners. The ceiling is a sign proof, never a substituted surface.
  const x0=Math.floor(captured.px/4)*4-REACH-EPS,z0=Math.floor(captured.pz/4)*4-REACH-EPS;
  for(const x of[x0,x0+2+REACH+EPS,x0+4+2*(REACH+EPS)])
    for(const z of[z0,z0+2+REACH+EPS,z0+4+2*(REACH+EPS)])assert(w.column(x,z).h<=-60+EPS);
});

test('native Vesper decks and tapered ribs still reject the air certificate',()=>{
  const worlds=pair(),w=worlds[1],city=vesper(w);
  const region=w.collectRegion(city.x-1100,city.x+1100,city.z-1100,city.z+1100);
  const deck=region.solids.find(b=>Math.hypot(b.x-city.x,b.z-city.z)<1200&&b.hx>2&&b.hz>2&&w.sdf(b.x,b.y,b.z)<0);
  assert(deck,'native deep-interior deck witness');
  const deckPose={...captured,px:deck.x,py:deck.y+deck.hy-.02,pz:deck.z,grounded:true};
  assert.equal(eligible(w,deckPose),false);compare(worlds,deckPose);
  const rib=region.capitalSegments?.find(({a,b})=>{
    const x=(a.x+b.x)/2,y=(a.y+b.y)/2,z=(a.z+b.z)/2;
    return Math.hypot(x-city.x,z-city.z)<1200&&Math.abs(a.radius-b.radius)>.001&&w.sdf(x,y,z)<0;
  });
  assert(rib,'native tapered capital-segment witness');
  const ribPose={...captured,px:(rib.a.x+rib.b.x)/2,py:(rib.a.y+rib.b.y)/2-PLAYER.HEIGHT/2,pz:(rib.a.z+rib.b.z)/2};
  assert.equal(eligible(w,ribPose),false);
  assert(capsuleClearance(w,ribPose.px,ribPose.py,ribPose.pz)<0,'a real solid body witness');
  compare(worlds,ribPose);
});

test('cached Vesper cell observes newly installed camps and rotated live hulls immediately',()=>{
  const worlds=pair();assert(eligible(worlds[1]));
  const camp={id:999,owner:1,faction:1 as const,type:0,x:captured.px,y:captured.py+.4,z:captured.pz,facing:0};
  for(const w of worlds)w.outposts.add(camp);
  assert.equal(eligible(worlds[1]),false);compare(worlds,captured);
  for(const w of worlds)w.outposts.remove(camp.id);
  assert(eligible(worlds[1]));
  const hull={id:987,type:1,variant:0,x:captured.px,y:captured.py,z:captured.pz,heading:.41,pitch:.1,roll:.2,health:1000};
  for(const w of worlds){setVehicleColliders(w,8500,[hull]);w.pedestrianCollisions=w.vehicleCollisions!.select(captured,1/60,8500);}
  assert.equal(eligible(worlds[1]),false);compare(worlds,captured,1/60,true);
  for(const w of worlds)w.pedestrianCollisions=undefined;
  assert(eligible(worlds[1]));
});

test('Vesper eligibility retains saved provider identities and never invokes injected collectors',()=>{
  const w=new World(7331);assert(eligible(w));
  for(const name of['sdf','sdfCol','column','collectRegion','collectCaveSites','collectTransportPlan'] as const){
    const record=w as unknown as Record<string,unknown>;
    record[name]=()=>{throw Error(`must reject before ${name}`);};
    try{assert.equal(eligible(w),false,name);}finally{delete record[name];}
  }
  const landscape=(w as unknown as {landscape:Record<string,unknown>}).landscape;
  for(const name of['base','naturalHeight']){
    const original=landscape[name];landscape[name]=()=>{throw Error('injected landscape');};
    try{assert.equal(eligible(w),false,name);}finally{landscape[name]=original;}
  }
  const original=World.prototype.collectCities;
  try{
    World.prototype.collectCities=()=>{throw Error('injected city collector');};
    assert.equal(eligible(w),false);assert.equal(eligible(new World(7331)),false);
  }finally{World.prototype.collectCities=original;}
  assert(eligible(w));
  w.motionTime=NaN;assert.equal(eligible(w),false,'invalid moving-field time falls back');
});
