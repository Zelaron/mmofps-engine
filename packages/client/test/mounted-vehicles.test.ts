import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {vehicleEyeHeight,gunboatGunMuzzle,trainArtilleryMuzzle,crewGunMuzzle} from '@shared/index';
import {buildVehicleHull,trainArtilleryModel,buildCrewWeapon,aimVehicleWeapon,vehicleMuzzlePosition} from '../src/render/vehicles.js';

test('gunboat, rail artillery and crew mounts preserve finite shared geometry and exact articulated muzzles',t=>{
  const factories=[{name:'gunboat',build:()=>buildVehicleHull(4),muzzle:gunboatGunMuzzle,maxDraws:4,maxTris:4500},
    {name:'rail artillery',build:trainArtilleryModel,muzzle:trainArtilleryMuzzle,maxDraws:3,maxTris:5000},
    ...[[1,0],[2,0],[2,2],[4,0]].map(([type,variant])=>({name:`crew ${type}/${variant}`,
      build:()=>buildCrewWeapon(type,variant),muzzle:(h:number,y:number,p:number)=>crewGunMuzzle(type,variant,h,y,p),maxDraws:2,maxTris:1600}))];
  for(const fixture of factories) {
    const model=fixture.build(),copy=fixture.build(),meshes:THREE.Mesh[]=[];
    model.traverse(o=>{if(o instanceof THREE.Mesh&&o.name!=='attached-muzzle-flash')meshes.push(o);});
    let triangles=0;for(const mesh of meshes) {
      assert.equal(mesh.geometry,(copy.getObjectByName(mesh.name) as THREE.Mesh).geometry);
      assert.ok(Array.from(mesh.geometry.getAttribute('position').array).every(Number.isFinite));
      triangles+=(mesh.geometry.index?.count??mesh.geometry.getAttribute('position').count)/3;
    }
    assert.ok(meshes.length<=fixture.maxDraws);assert.ok(triangles<=fixture.maxTris,`${fixture.name}: ${triangles}`);
    const point=new THREE.Vector3();
    for(const heading of [-1.7,0,2])for(const yaw of [-2,0,1.3])for(const pitch of [-.1,.3,1]) {
      model.rotation.y=heading;aimVehicleWeapon(model,yaw,pitch);model.updateMatrixWorld(true);
      vehicleMuzzlePosition(model,point);const expected=fixture.muzzle(heading,yaw,pitch);
      assert.ok(point.distanceTo(new THREE.Vector3(expected.x,expected.y,expected.z))<1e-6,fixture.name);
    }
    t.diagnostic(`${fixture.name}: ${meshes.length} draws / ${triangles} triangles`);
  }
});

test('gunboat has a recognizable broad waterline and a clear forward helm view',()=>{
  const boat=buildVehicleHull(4),parts:THREE.Mesh[]=[];
  boat.traverse(o=>{if(o instanceof THREE.Mesh&&o.name!=='attached-muzzle-flash')parts.push(o);});
  const box=new THREE.Box3().setFromObject(boat);assert.ok(box.max.z-box.min.z>=10);assert.ok(box.max.x-box.min.x>4);
  assert.ok(box.min.y>=0,'keel-origin hull never extends below the declared draft origin');
  boat.updateMatrixWorld(true);
  const ray=new THREE.Raycaster(new THREE.Vector3(0,vehicleEyeHeight(4),0),new THREE.Vector3(0,0,-1));
  assert.equal(ray.intersectObjects(parts,false).length,0);
});
