import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ENT_PLAYER, ENT_PROJECTILE, PICKUP_WEAPON, PICKUP_AMMO, type EntPlayer, type Snapshot } from '@shared/protocol';
import type { FrontierState, Territory } from '@shared/frontier';
import { CREATURE } from '@shared/wildlife';
import { NUKE_LAUNCHER_ID } from '@shared/weapons';
import { buildMapIntel, controlReadout, declutterMapLoot, localMapPoint, MAP_CONTACT_LIMIT, type MapContact } from '../src/tactical-intel.js';

const player=(id:number,overrides:Partial<EntPlayer>={}):EntPlayer=>({id,kind:ENT_PLAYER,x:id,y:20,z:0,yaw:0,pitch:0,grounded:true,dead:false,weapon:0,vehicle:0,heading:0,...overrides});
const snapshot=(overrides:Partial<Snapshot>={}):Snapshot=>({tick:20,lastSeq:0,you:{px:0,py:20,pz:0,vx:0,vy:0,vz:0,grounded:true,alive:true,dodgeCd:0,health:100,weapon:0,cooldown:0,ammo:[],reloadWeapon:-1,reloadCooldown:0,reloadHeld:false,vehicle:0,heading:0,boostFuel:1,vehicleHealth:0,lockState:0},ents:[],...overrides});
const state=(overrides:Partial<FrontierState>={}):FrontierState=>({revision:1,territories:[],you:{faction:1,salvage:0,discoveries:[],factionCooldown:0},nearby:[],...overrides});

test('live map contacts use replicated faction identity, exclude self and collapse multi-seat hulls',()=>{
  const snap=snapshot({ents:[player(1),player(2),player(3),player(4),player(5,{vehicle:2,vehicleId:40}),player(6,{vehicle:2,vehicleId:40,seat:1}),player(7,{dead:true}),player(8,{x:NaN}),{kind:ENT_PROJECTILE,id:9,x:1,y:20,z:1,vx:1,vy:0,vz:0,weapon:0,owner:3}],vehicles:[{id:40,type:2,x:5,y:20,z:0,heading:0,health:100},{id:41,type:1,x:10,y:20,z:5,heading:0,health:100}]});
  const intel=buildMapIntel(snap,state({nearby:[{id:2,faction:1},{id:3,faction:3},{id:5,faction:2},{id:6,faction:2}]}),1);
  assert.deepEqual(intel.contacts.map(c=>[c.id,c.relation]),[['player:2','friendly'],['player:3','hostile'],['player:4','unknown'],['vehicle:40','hostile'],['vehicle:41','available']]);
  snap.you.vehicleId=40;snap.you.vehicle=2;
  assert.ok(!buildMapIntel(snap,state(),1).contacts.some(c=>c.id==='vehicle:40'),'own hull never duplicates the player arrow');
});

test('boss broadcasts merge with fresher local health and death instead of creating stale duplicate markers',()=>{
  const strategic=state({threats:[{id:10,species:CREATURE.OSSUARY_TITAN,x:9000,y:20,z:0,health:.9,engaged:false},{id:11,species:CREATURE.CINDER_COLOSSUS,x:1000,y:20,z:0,health:1,engaged:false}]});
  const snap=snapshot({creatures:[{id:10,species:CREATURE.OSSUARY_TITAN,x:600,y:20,z:0,yaw:1,speed:2,alert:true,health:.6},{id:11,species:CREATURE.CINDER_COLOSSUS,x:1000,y:20,z:0,yaw:0,speed:0,alert:false,dead:true,health:0}]});
  const bosses=buildMapIntel(snap,strategic).contacts;
  assert.equal(bosses.length,1);assert.equal(bosses[0].x,600);assert.equal(bosses[0].health,.6);assert.equal(bosses[0].engaged,true);
  assert.equal(buildMapIntel(snapshot(),null).contacts.length,0,'disconnected/world-reset input carries no old reports');
});

test('map exposes valuable nearby weapon drops and dangerous wildlife without passive clutter',()=>{
  const snap=snapshot({creatures:[{id:2,species:CREATURE.GRAZER,x:20,y:20,z:0,yaw:0,speed:0,alert:false},{id:3,species:CREATURE.SHAMBLER,x:30,y:20,z:0,yaw:0,speed:2,alert:true}],pickups:[{id:1,kind:PICKUP_WEAPON,weapon:NUKE_LAUNCHER_ID,x:5,y:20,z:0},{id:2,kind:PICKUP_AMMO,weapon:0,x:6,y:20,z:0}]});
  const intel=buildMapIntel(snap,null);assert.deepEqual(intel.contacts.map(c=>c.kind),['loot','creature']);assert.match(intel.contacts[0].label,/nuke/i);
  snap.creatures![0].alert=true;
  assert.deepEqual(buildMapIntel(snap,null).contacts.map(c=>c.kind),['loot','creature'],'fleeing passive wildlife is not a hostile contact');
});

test('map marker budget preserves public bosses and nearest snapshot contacts',()=>{
  const intel=buildMapIntel(snapshot({ents:Array.from({length:600},(_,i)=>player(i+1))}),state({threats:[{id:90,species:CREATURE.OSSUARY_TITAN,x:8000,y:20,z:0,health:1,engaged:false}]}));
  assert.equal(intel.contacts.length,MAP_CONTACT_LIMIT);assert.equal(intel.contacts[0].kind,'boss');assert.equal(intel.contacts[1].id,'player:1');assert.equal(intel.contacts.at(-1)!.id,`player:${MAP_CONTACT_LIMIT-1}`);
});

test('offscreen objective pins retain their direction at every minimap edge',()=>{
  assert.deepEqual(localMapPoint(0,0,0,0,2000),{x:128,y:128,offscreen:false});
  const diagonal=localMapPoint(4000,-2000,0,0,2000);assert.equal(diagonal.x,240);assert.equal(diagonal.y,72);assert.equal(diagonal.offscreen,true);
  assert.equal(localMapPoint(-4000,0,0,0,2000).x,16);
});

test('capture labels distinguish paused contests, neutralization and a new claim',()=>{
  const site:Territory={id:'a',name:'A',kind:'relay',x:0,y:0,z:0,radius:40,owner:2,influence:1,contested:false,captureFaction:2,captureProgress:.6,pressureFaction:1,progressRate:.02};
  assert.equal(controlReadout(site),'NEUTRALIZING 40%');assert.equal(controlReadout({...site,contested:true}),'CONTESTED');
  assert.equal(controlReadout({...site,owner:0,captureFaction:1}),'CAPTURING 60%');assert.equal(controlReadout({...site,progressRate:0}),'HELD');
});

test('cache glyph grouping preserves nearby nuke rewards without changing other contacts or source data',()=>{
  const caches:MapContact[]=Array.from({length:20},(_,i)=>({id:`loot:${i}`,x:i*3,z:0,yaw:0,kind:'loot',relation:'available',faction:0,label:'Cache',weapon:i===5?NUKE_LAUNCHER_ID:0}));
  const infantry:MapContact={id:'player:1',x:0,z:0,yaw:0,kind:'infantry',relation:'hostile',faction:2,label:'Enemy'};
  const source=[...caches,infantry],before=JSON.stringify(source),result=declutterMapLoot(source,0,0,25,4),loot=result.filter(c=>c.kind==='loot');
  assert.equal(loot[0].id,'loot:5');assert.ok(loot.length<=4);assert.ok(result.includes(infantry));assert.equal(JSON.stringify(source),before);
  for(const [i,cache] of loot.entries())for(const prior of loot.slice(0,i))assert.ok(Math.hypot(cache.x-prior.x,cache.z-prior.z)>=25);
});
