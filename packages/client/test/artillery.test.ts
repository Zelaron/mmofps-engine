import { MAX_OWNED_ARTILLERY_SHELLS } from '@shared/vehicles';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {ArtilleryFeedback} from '../src/artillery-feedback.js';
import {AudioFX} from '../src/audio.js';
import {Effects} from '../src/render/effects.js';
import {StrategicBurst,STRATEGIC_BURST_SLOTS,STRATEGIC_PARTICLES_PER_BURST} from '../src/render/strategic-burst.js';
import {trainArtilleryModel,aimVehicleWeapon,flashVehicleWeapon,updateVehicleHull,vehicleMuzzlePosition} from '../src/render/vehicles.js';
import {trainArtilleryMuzzle,artilleryPitch} from '@shared/vehicles';
import {viewDir} from '@shared/math';
import {VehicleShotQueue} from '../src/vehicle-shot-queue.js';

test('queued rail muzzle reports resolve against the moving barrel, and flash follows recoil and elevation',()=>{
 const hull=trainArtilleryModel(),queue=new VehicleShotQueue(),muzzle=new THREE.Vector3();
 hull.position.set(100,50,-200);hull.rotation.y=.4;aimVehicleWeapon(hull,1.3,.35);
 vehicleMuzzlePosition(hull,muzzle);queue.enqueue({shooter:1,weapon:213,seq:1,ox:muzzle.x,oy:muzzle.y,oz:muzzle.z,ends:[]});
 hull.position.z-=90*.03;hull.rotation.y=.5;aimVehicleWeapon(hull,1.5,-1.2);
 assert.equal(queue.take().length,1);vehicleMuzzlePosition(hull,muzzle);
 const offset=trainArtilleryMuzzle(.5,1.5,-1.2);
 assert.ok(muzzle.distanceTo(new THREE.Vector3(hull.position.x+offset.x,hull.position.y+offset.y,hull.position.z+offset.z))<1e-7);
 const flash=hull.getObjectByName('attached-muzzle-flash') as THREE.Mesh;
 const geometry=flash.geometry;flashVehicleWeapon(hull);assert.ok(flash.scale.x>=8);
 hull.position.x+=3;aimVehicleWeapon(hull,-.3,.6);updateVehicleHull(hull,{dt:.03,speed:90});
 vehicleMuzzlePosition(hull,muzzle);assert.ok(flash.getWorldPosition(new THREE.Vector3()).distanceTo(muzzle)<1e-8);
 const direction=new THREE.Vector3(0,0,-1).applyQuaternion(flash.getWorldQuaternion(new THREE.Quaternion()));
 const aim=viewDir(-.3,artilleryPitch(.6));assert.ok(direction.distanceTo(new THREE.Vector3(aim.x,aim.y,aim.z))<1e-7);
 assert.ok(hull.getObjectByName('weapon-recoil')!.position.z>.4);assert.equal(flash.geometry,geometry);
 for(let i=0;i<60;i++)updateVehicleHull(hull,{dt:1/60,speed:90});
 assert.equal(flash.visible,false);assert.ok(hull.getObjectByName('weapon-recoil')!.position.z<.001);
});

test('the strategic cloud is one bounded particle draw with analytic animation and no per-frame buffer uploads',()=>{
 const burst=new StrategicBurst(),points=burst.group.children[0] as THREE.Points<THREE.BufferGeometry,THREE.ShaderMaterial>;
 assert.equal(burst.group.visible,false);assert.equal(burst.capacity,STRATEGIC_BURST_SLOTS*STRATEGIC_PARTICLES_PER_BURST);
 assert.ok(STRATEGIC_BURST_SLOTS>=5,'a five-shell nuclear salvo keeps every cloud');
 assert.equal(points.geometry.getAttribute('position').count,STRATEGIC_BURST_SLOTS*STRATEGIC_PARTICLES_PER_BURST);
 assert.equal(points.material.fog,false);assert.equal(points.material.depthTest,true);assert.equal(points.material.depthWrite,false);
 assert.equal(points.material.blending,THREE.NormalBlending,'overlapping smoke must not saturate into a white disk');
 for(let i=0;i<100;i++)burst.emit(i*20,0,1800);
 assert.equal(burst.activeBursts,STRATEGIC_BURST_SLOTS);const position=points.geometry.getAttribute('position') as THREE.BufferAttribute;
 assert.equal(position.version,STRATEGIC_BURST_SLOTS,'bursts arriving in one frame cannot exceed the slot count');
 assert.ok(Array.from(position.array).every(Number.isFinite));
 burst.update(4);assert.equal(position.version,STRATEGIC_BURST_SLOTS,'GPU motion does not upload positions every frame');assert.equal(burst.group.visible,true);
 burst.update(4.1);assert.equal(burst.activeBursts,0);assert.equal(burst.group.visible,false);burst.dispose();
});

test('long-range rail shells retain a shared fog-free beacon and far impacts avoid ordinary particle overdraw',()=>{
 const effects=new Effects();effects.updateProjectiles([1,2].map(id=>({id,weapon:213,x:1800,y:300,z:id*10,vx:190,vy:0,vz:0})));
 const shells=effects.group.children.filter(c=>c.name==='leviathan-shell');assert.equal(shells.length,2);
 const beacon=shells[0].getObjectByName('artillery-shell-beacon') as THREE.Points;
 const second=shells[1].getObjectByName('artillery-shell-beacon') as THREE.Points;
 assert.equal(beacon.geometry,second.geometry);assert.equal(beacon.material,second.material);
 assert.equal((beacon.material as THREE.PointsMaterial).sizeAttenuation,false);
 assert.equal((beacon.material as THREE.PointsMaterial).fog,false);assert.equal((beacon.material as THREE.PointsMaterial).depthTest,true);
 effects.addArtilleryExplosion(1800,0,0,new THREE.Vector3(),130);effects.update(.1);
 const ordinary=effects.group.children.find(c=>c instanceof THREE.Points) as THREE.Points;
 assert.equal(ordinary.geometry.drawRange.count,0,'far observers only need the strategic cloud');
 assert.ok(effects.group.getObjectByName('strategic-cloud-particles')?.parent?.visible);
 effects.removeProjectile(1,213,1800,0,0);assert.equal(effects.group.children.filter(c=>c.name==='leviathan-shell').length,1);
});

test('own-shell feedback survives snapshot retirement until impact, expires cleanly, and never tracks other gunners',()=>{
 const feedback=new ArtilleryFeedback();feedback.fired(10);assert.equal(feedback.reloadSeconds(10),5.5);
 assert.equal(feedback.reloadSeconds(16),0);
 feedback.sync(Array.from({length:10},(_,i)=>({id:i,owner:i===0?99:7,weapon:213,x:i*100,y:50,z:0})),7,10);
 assert.equal(feedback.count,MAX_OWNED_ARTILLERY_SHELLS);assert.equal(feedback.impact(0,{x:0,y:0,z:0},10),false);
 feedback.sync([],7,11);assert.equal(feedback.count,MAX_OWNED_ARTILLERY_SHELLS,'removal snapshot may precede the explosion packet');
 assert.equal(feedback.impact(9,{x:1900,y:80,z:10},11),true);assert.equal(feedback.count,MAX_OWNED_ARTILLERY_SHELLS-1);
 assert.deepEqual(feedback.marker(12),{point:{x:1900,y:80,z:10},impact:true});
 assert.equal(feedback.impact(9,{x:1900,y:80,z:10},11),false,'duplicate impact packets do not duplicate feedback');
 feedback.sync([],7,29);assert.equal(feedback.count,0);assert.equal(feedback.marker(29),null);
 feedback.fired(30);feedback.clear();assert.equal(feedback.reloadSeconds(30),0);assert.equal(feedback.marker(30),null);
});

test('rail artillery has a distinct bounded muzzle report with preserved spatial pan and gain',()=>{
 const signatures:string[]=[];
 for(const weapon of [210,213]) {
  const audio=new AudioFX();assert.doesNotThrow(()=>audio.fire(weapon));
  const calls:unknown[][]=[],record=audio as unknown as {tone(...args:unknown[]):void;noise(...args:unknown[]):void};
  record.tone=(...args)=>calls.push(['tone',...args]);record.noise=(...args)=>calls.push(['noise',...args]);
  audio.fire(weapon,.4,.3);assert.ok(calls.length<=5);signatures.push(JSON.stringify(calls));
  if(weapon===213){assert.equal(calls.length,5);assert.ok(calls.some(c=>c[0]==='noise'&&Number(c[1])>=.85));}
 }
 assert.notEqual(signatures[0],signatures[1]);
});

test('a scaled strategic cloud spreads and rises farther with larger puffs',()=>{
 const spread=(scale:number)=>{
  const burst=new StrategicBurst();burst.emit(0,0,0,scale);
  const points=burst.group.children[0] as THREE.Points<THREE.BufferGeometry,THREE.ShaderMaterial>;
  const p=points.geometry.getAttribute('position') as THREE.BufferAttribute,t=points.geometry.getAttribute('timing') as THREE.BufferAttribute;
  let reach=0,top=0,size=0;for(let i=0;i<STRATEGIC_PARTICLES_PER_BURST;i++){reach=Math.max(reach,Math.hypot(p.getX(i),p.getZ(i)));top=Math.max(top,p.getY(i));size=Math.max(size,t.getZ(i));}
  burst.dispose();return {reach,top,size};
 };
 const plain=spread(1),large=spread(2);
 assert.ok(large.reach>plain.reach*1.5&&large.top>plain.top*1.5&&large.size===plain.size*2,JSON.stringify({plain,large}));
});
