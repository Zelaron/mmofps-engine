import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {World} from '@shared/worldgen';
import {buildJungleTemplePlan,templeTrapPose} from '@shared/jungle-temples';
import {JungleTempleRenderer} from '../src/render/jungle-temples.js';

test('temple masonry matches collision, uses four bounded draw pools and disposes once',()=>{
  const world=new World(1337),site=world.collectJungleTemples()[0],plan=buildJungleTemplePlan(site),r=new JungleTempleRenderer(world);
  r.update(0,site.x,site.y,site.z);assert.equal(r.group.children.length,4);assert.ok(r.stats.triangles<18000);
  const boxes=r.group.children[0] as THREE.InstancedMesh,m=new THREE.Matrix4(),p=new THREE.Vector3(),s=new THREE.Vector3(),q=new THREE.Quaternion();
  boxes.getMatrixAt(0,m);m.decompose(p,q,s);
  assert.ok(p.distanceTo(new THREE.Vector3(plan.solids[0].x,plan.solids[0].y,plan.solids[0].z))<.001);
  assert.ok(Math.abs(s.y-plan.solids[0].hy)<.001);
  r.update(0,30000,100,30000);assert.equal(r.stats.boxes,0);
  r.update(0,site.x,site.y,site.z);assert.ok(r.stats.boxes>0);assert.ok(boxes.boundingSphere!.radius>0);
  let disposed=0;for(const mesh of r.group.children as THREE.InstancedMesh[])mesh.geometry.addEventListener('dispose',()=>disposed++);
  r.dispose();r.dispose();assert.equal(disposed,4);assert.equal(r.group.children.length,0);
});

test('visible crusher follows the same shared trap clock and contact height',()=>{
  const world=new World(1337),site=world.collectJungleTemples()[0],trap=buildJungleTemplePlan(site).traps.find(t=>t.kind==='crusher')!,r=new JungleTempleRenderer(world);
  const mesh=r.group.children[2] as THREE.InstancedMesh,m=new THREE.Matrix4(),p=new THREE.Vector3();
  for(const phase of [0,1.7,2.3,2.9,3.5,5]) {
    const seconds=phase-trap.phase;r.update(seconds,trap.x,trap.y+1.62,trap.z);mesh.getMatrixAt(0,m);p.setFromMatrixPosition(m);
    assert.ok(Math.abs(p.y-(trap.y+trap.height*(1-templeTrapPose(trap,seconds).extension)+.275))<.001);
  }
  r.dispose();
});
