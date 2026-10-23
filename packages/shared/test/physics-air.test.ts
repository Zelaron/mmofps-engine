import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/worldgen.js';
import { collideCapsule, type KinState } from '../src/physics.js';
import { proveCapsuleAirPrism } from '../src/physics-air.js';
import { setVehicleColliders } from '../src/vehicle-collision.js';
import { SolidBoxIndex } from '../src/box-field.js';

// A captured native Meridian plinth, including the real solver's residual
// separation. Tests compare complete collision results against the unchanged
// canonical field path, disabled only by an identity-preserving SDF wrapper.
const settled:KinState={px:-1760.151695106149,py:21.20306299840857,pz:2059.3875775880333,
  vx:0,vy:0,vz:0,grounded:true};
function pair():[World,World] {
  const reference=new World(1337),sdf=reference.sdf;
  reference.sdf=function(...args){return sdf.apply(this,args);};
  return[reference,new World(1337)];
}
function compare(worlds:[World,World],state:KinState,dt=0,snap=false):KinState {
  const expected={...state},actual={...state};
  const expectedResult=collideCapsule(worlds[0],expected,dt,snap);
  const actualResult=collideCapsule(worlds[1],actual,dt,snap);
  assert.deepStrictEqual(actual,expected);assert.deepStrictEqual(actualResult,expectedResult);
  return actual;
}
const eligible=(world:World,state=settled)=>proveCapsuleAirPrism(world,state.px,state.py,state.pz);

test('exact empty city prism preserves threshold-adjacent contacts and complete movement state',()=>{
  const worlds=pair();assert.equal(eligible(worlds[0]),false);assert.equal(eligible(worlds[1]),true);
  const floor=worlds[0].collectCities().find(c=>c.name==='Meridian')!.y+.06;
  const offsets=[-.02,0,.004,.005499,.0055,.005501,.005502,.005503,.005584,.006,.006001,.05];
  for(let i=0;i<=64;i++)offsets.push(.0054+i*.0008/64);
  for(const offset of offsets)compare(worlds,{...settled,py:floor+offset});
  for(const [vx,vy,vz]of[[0,-.5,0],[7,-.5,3],[-5,2,5]]){
    let state={...settled,vx,vy,vz};
    for(let tick=0;tick<8;tick++)state=compare(worlds,state,1/60,true);
  }
});

test('native city boundary, smooth pad and cave witnesses retain full collision',()=>{
  const worlds=pair(),city=worlds[0].collectCities().find(c=>c.name==='Meridian')!;
  const states=[
    {...settled,px:city.x+city.radius-.01,pz:city.z,py:city.y+.02},
    {...settled,px:city.x+city.radius+.01,pz:city.z,py:city.y+.02},
    {...settled,px:-2048.1615674811374,py:21.20313634910421,pz:2134.1382069134734},
    {...settled,px:-1774.3203566675554,py:62.174703461564405,pz:3707.552648640696,vx:9.413820016020043,vz:-1.276711676918632},
  ];
  assert(worlds[0].column(states[3].px,states[3].pz).cave,'native cave witness');
  for(const state of states){assert.equal(eligible(worlds[1],state),false);compare(worlds,{...state,vy:-.4},1/60,true);}
});

test('cached city air proof observes live camp installation/removal and rotated hulls',()=>{
  const worlds=pair();assert(eligible(worlds[1]));
  const camp={id:999,owner:1,faction:1 as const,type:0,x:settled.px,y:settled.py+.4,z:settled.pz,facing:0};
  for(const world of worlds)world.outposts.add(camp);
  assert.equal(eligible(worlds[1]),false);compare(worlds,settled);
  for(const world of worlds)world.outposts.remove(camp.id);
  assert(eligible(worlds[1]));
  const hull={id:987,type:1,variant:0,x:settled.px,y:settled.py,z:settled.pz,heading:.41,pitch:.1,roll:.2,health:1000};
  for(const world of worlds){setVehicleColliders(world,8500,[hull]);world.pedestrianCollisions=world.vehicleCollisions!.select(settled,1/60,8500);}
  assert.equal(eligible(worlds[1]),false);compare(worlds,settled,1/60,true);
  for(const world of worlds)world.pedestrianCollisions=undefined;
  assert(eligible(worlds[1]));
});

test('positive nonmetric ghost minima cannot conceal a negative shell contact',()=>{
  const worlds=pair();assert(eligible(worlds[1]));
  const field=(x:number)=>Math.min(.01,.25-(x-settled.px));
  for(const world of worlds){world.sdf=field;world.sdfCol=field;}
  assert.equal(eligible(worlds[1]),false);
  assert(compare(worlds,settled).px<settled.px-.1,'the canonical shell fallback must resolve the actual wall');
});

test('cached proofs reject modified World/provider methods and callbacks before invoking collectors',()=>{
  const world=new World(1337);assert(eligible(world));
  const internal=world as unknown as {landscape:Record<string,unknown>;noise:Record<string,unknown>};
  for(const object of[world,internal.landscape,internal.noise,world.outposts]){
    const record=object as unknown as Record<string,unknown>;
    for(const name of Object.getOwnPropertyNames(Object.getPrototypeOf(object))){
      const original=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(object),name)?.value;
      if(name==='constructor'||typeof original!=='function')continue;
      record[name]=function(this:object,...args:unknown[]){return original.apply(this,args);};
      try{assert.equal(eligible(world),false,`${object.constructor.name}.${name}`);}
      finally{delete record[name];}
    }
  }
  for(const name of['base','naturalHeight']){
    const original=internal.landscape[name];internal.landscape[name]=()=>{throw new Error('injected callback invoked');};
    try{assert.equal(eligible(world),false);}finally{internal.landscape[name]=original;}
  }
  const bridge=world.regionAt(settled.px,settled.pz).transportBridges!;
  assert(bridge);
  for(const target of[bridge,Object.getPrototypeOf(bridge)]){
    const record=target as unknown as Record<string,unknown>;
    const descriptor=Object.getOwnPropertyDescriptor(record,'visit');
    record.visit=()=>{throw new Error('injected bridge traversal invoked');};
    try{assert.equal(eligible(world),false,'nested bridge traversal must be checked before the metric bound');}
    finally{if(descriptor)Object.defineProperty(record,'visit',descriptor);else delete record.visit;}
  }
  assert(eligible(world));
  for(const name of['distance','build']){
    const record=SolidBoxIndex.prototype as unknown as Record<string,unknown>;
    const descriptor=Object.getOwnPropertyDescriptor(record,name)!;
    record[name]=()=>{throw new Error('injected solid-box traversal invoked');};
    try{assert.equal(eligible(world),false,'nested solid-box traversal must retain the canonical field');}
    finally{Object.defineProperty(record,name,descriptor);}
  }
  assert(eligible(world));
  const original=World.prototype.collectCities;
  try{
    World.prototype.collectCities=()=>{throw new Error('injected collector invoked');};
    assert.equal(eligible(world),false);
    assert.equal(eligible(new World(1337)),false,'cold proof must check the saved collector reference too');
  }finally{World.prototype.collectCities=original;}
  assert(eligible(world));
});
