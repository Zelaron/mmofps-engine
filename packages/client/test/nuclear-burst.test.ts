import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { NuclearBurstBudget, NUCLEAR_PARTICLE_CAP } from '../src/render/nuclear-burst.js';
import { Effects } from '../src/render/effects.js';

test('nuclear explosions use dense rising particles with no solid cloud meshes and bounded emission',()=>{
 const budget=new NuclearBurstBudget();assert.deepEqual([budget.take(),budget.take(),budget.take(),budget.take()],[true,true,true,false]);
 budget.nextFrame();assert.equal(budget.take(),true);
 const effects=new Effects(),before=effects.group.children.length;
 effects.addNukeExplosion(0,0,0,new THREE.Vector3(0,10,80),115);
 const internal=effects as unknown as {particles:{x:number;y:number;z:number;gravity:number;life:number}[]};
 assert.equal(internal.particles.length,6600,'nukes restore more particles than the old5000-point explosion');
 const rising=internal.particles.find(p=>p.gravity<0&&p.y===4)!,height=rising.y;
 effects.update(.8);assert.ok(rising.y>height,'smoke and fallout billow rather than remaining a solid model');
 for(let i=0;i<20;i++)effects.addVoidExplosion(i,0,0,new THREE.Vector3(0,10,80),115);
 assert.equal(effects.group.children.length,before,'no per-blast meshes or lights');
 assert.equal(effects.group.getObjectByName('nuclear-cap'),undefined);
 assert.ok(internal.particles.length<=NUCLEAR_PARTICLE_CAP);
 const retained=internal.particles.slice();effects.addNukeExplosion(900,0,0,new THREE.Vector3(),115);
 assert.deepEqual(internal.particles,retained,'extra same-frame detonations cannot allocate another cloud');
 effects.update(6);assert.equal(internal.particles.length,0);
});

test('laser fans remain bounded and special cannon shells have substantial shared geometry aligned to flight',()=>{
 const effects=new Effects();
 for(let i=0;i<200;i++)effects.addBeam(0,1,0,i,2,-100,0xc881ff,.05);
 effects.update(.01);const beams=effects.group.getObjectByName('coherent-laser-beams') as THREE.InstancedMesh;
 assert.equal(beams.count,64);assert.ok(Array.from(beams.instanceMatrix.array).every(Number.isFinite));
 effects.updateProjectiles([{id:1,weapon:209,x:0,y:10,z:0,vx:180,vy:0,vz:0},
  {id:2,weapon:209,x:0,y:20,z:0,vx:0,vy:0,vz:-180},{id:3,weapon:210,x:0,y:30,z:0,vx:0,vy:20,vz:-125}]);
 const shells=effects.group.children.filter(c=>c.name==='solar-energy-shell');assert.equal(shells.length,2);
 const bounds=new THREE.Box3().setFromObject(shells[0]);
 assert.ok(bounds.max.x-bounds.min.x>5,'the moving cylinder is visibly several metres long');
 assert.ok(bounds.max.y-bounds.min.y>1.2,'the luminous body is more than a metre wide');
 const one=shells[0].children[0] as THREE.Mesh,two=shells[1].children[0] as THREE.Mesh;
 assert.equal(one.geometry,two.geometry);assert.equal(one.material,two.material);
 assert.equal(shells[0].children.length,2,'energy core plus glow costs two bounded shared draws');
 const nuke=effects.group.getObjectByName('nuclear-cannon-shell') as THREE.Mesh;
 assert.ok(nuke);const q=nuke.quaternion.toArray();effects.update(.1);assert.deepEqual(nuke.quaternion.toArray(),q,'a cannon shell does not tumble like a hand grenade');
 assert.equal(nuke.geometry.groups.length,0);
 effects.updateProjectiles([]);assert.equal(effects.group.getObjectByName('solar-energy-shell'),undefined);
});
