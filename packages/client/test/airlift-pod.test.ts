import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { airliftPose, type AirliftFlight } from '@shared/airlift';
import { PLAYER, TICK_DT, TICK_RATE } from '@shared/constants';
import type { TransportPlan } from '@shared/transport';
import { AirliftPodView } from '../src/render/airlift-pod.js';

const plan:TransportPlan={stations:[],harbors:[],routes:[],solids:[],lifts:[],bridges:[],accesses:[],pods:[
  {id:1,stationId:1,name:'Launch',x:-120,y:42,z:320},
  {id:2,stationId:2,name:'Arrival',x:12400,y:76,z:-5800},
]};
const flight:AirliftFlight={source:1,destination:2,startTick:180,durationTicks:1200};

function withPod(run:(pod:AirliftPodView,camera:THREE.PerspectiveCamera,scene:THREE.Scene)=>void):void {
  class Element {
    hidden=false;id='';className='';textContent='';
    style={setProperty:(_name:string,_value:string)=>{}};
    append(..._children:Element[]){} setAttribute(_name:string,_value:string){} remove(){}
  }
  const previous=Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>new Element(),body:new Element()}});
  const scene=new THREE.Scene(),camera=new THREE.PerspectiveCamera(92,16/9,.08,12000);
  scene.add(camera);
  const pod=new AirliftPodView(scene);
  try {run(pod,camera,scene);} finally {
    pod.dispose();
    if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');
  }
}

test('the cabin stays on its route while the passenger looks forward, sideways and behind',()=>withPod((pod,camera,scene)=>{
  const seconds=(flight.startTick+flight.durationTicks*.5)/TICK_RATE;
  const pose=airliftPose(plan,flight,seconds/TICK_DT)!;
  camera.position.set(pose.x,pose.y+PLAYER.EYE_HEIGHT,pose.z);
  pod.update(plan,flight,seconds,camera);
  assert.equal(pod.group.parent,scene,'the cabin must not inherit camera rotation');
  const front=pod.group.getObjectByName('windscreen')!;
  const fixedFront=front.getWorldPosition(new THREE.Vector3());
  for(const offset of [0,Math.PI/2,Math.PI,-Math.PI/2]) {
    camera.rotation.set(0,pose.heading+offset,0,'YXZ');
    const look=camera.quaternion.clone();
    pod.update(plan,flight,seconds,camera);
    assert.ok(front.getWorldPosition(new THREE.Vector3()).distanceTo(fixedFront)<1e-8);
    assert.equal(camera.quaternion.angleTo(look),0,'flight rendering must not steer the passenger view');
    const state=pod.diagnostics(camera);
    assert.equal(state.heading,pose.heading);
    assert.ok(Math.abs(state.viewForward.x-Math.sin(offset))<1e-10);
    assert.ok(Math.abs(state.viewForward.z+Math.cos(offset))<1e-10);
    assert.ok(Math.hypot(state.cameraLocal.x,state.cameraLocal.y,state.cameraLocal.z)<1e-8);
  }
  // Looking up/down and a small impact shake also cannot drag the cabin along.
  camera.rotation.set(1.2,pose.heading+.8,.12,'YXZ');camera.position.x+=.08;
  pod.update(plan,flight,seconds,camera);
  assert.ok(front.getWorldPosition(new THREE.Vector3()).distanceTo(fixedFront)<1e-8);
  assert.ok(Math.abs(Math.hypot(...Object.values(pod.diagnostics(camera).cameraLocal))-.08)<1e-8);
}));

test('pod and eye use the same fractional flight trajectory through launch, cruise, landing and reversed routes',()=>withPod((pod,camera)=>{
  for(const current of [flight,{...flight,source:2,destination:1}]) {
    for(const progress of [0,.10347,.23013,.50123,.82119,.9991,1]) {
      const tick=current.startTick+progress*current.durationTicks,seconds=tick/TICK_RATE;
      const pose=airliftPose(plan,current,seconds/TICK_DT)!;
      camera.position.set(pose.x,pose.y+PLAYER.EYE_HEIGHT,pose.z);
      pod.update(plan,current,seconds,camera);
      const state=pod.diagnostics(camera);
      assert.deepEqual([state.x,state.y,state.z],[pose.x,pose.y+PLAYER.EYE_HEIGHT,pose.z]);
      assert.ok(Math.hypot(...Object.values(state.cameraLocal))<1e-8);
      const forward=new THREE.Vector3(0,0,-1).applyQuaternion(pod.group.quaternion);
      const source=plan.pods.find(p=>p.id===current.source)!,destination=plan.pods.find(p=>p.id===current.destination)!;
      const route=new THREE.Vector3(destination.x-source.x,0,destination.z-source.z).normalize();
      assert.ok(forward.distanceTo(route)<1e-10);
    }
  }
  assert.ok(camera.fov>=92);
  pod.update(plan,undefined,42,camera);
  assert.equal(pod.group.visible,false);assert.equal(camera.fov,92);
}));

test('free-look reveals side framing, rear hatch, roof and floor without placing geometry near the eye',()=>withPod((pod,camera)=>{
  // Check the actual triangles, not a duplicate dimension formula. Every view
  // leaves ample room for the .08m near plane and camera shake inside the cabin.
  let nearest=Infinity;
  const triangle=new THREE.Triangle(),origin=new THREE.Vector3(),closest=new THREE.Vector3();
  pod.group.updateMatrixWorld(true);
  for(const object of pod.group.children) {
    assert.ok(object instanceof THREE.Mesh);
    const mesh=object as THREE.Mesh<THREE.BufferGeometry,THREE.MeshBasicMaterial>;
    assert.equal(mesh.material.depthTest,true,'cabin parts must occlude each other normally');
    const vertices=mesh.geometry.getAttribute('position'),index=mesh.geometry.index;
    const count=index?.count??vertices.count;
    for(let i=0;i<count;i+=3) {
      for(const [vertex,j] of [[triangle.a,i],[triangle.b,i+1],[triangle.c,i+2]] as const) {
        vertex.fromBufferAttribute(vertices,index?index.getX(j):j).applyMatrix4(mesh.matrix);
      }
      nearest=Math.min(nearest,triangle.closestPointToPoint(origin,closest).length());
    }
  }
  assert.ok(nearest>.9,`nearest cabin surface is ${nearest}m from the eye`);
  const ray=new THREE.Raycaster();
  for(const name of ['side-post--1','side-post-1','rear-hatch','cabin-roof','cabin-floor']) {
    const part=pod.group.getObjectByName(name)!;
    ray.set(origin,part.position.clone().normalize());
    const hits=ray.intersectObjects(pod.group.children,false);
    assert.ok(hits.some(hit=>hit.object===part),`${name} is visible from the seat`);
  }
  // Forward remains a window onto the world, rather than an opaque box.
  ray.set(origin,new THREE.Vector3(0,0,-1));
  assert.equal(ray.intersectObjects(pod.group.children,false).length,0);
  pod.update(plan,flight,12,camera,true);assert.equal(pod.group.visible,false);
}));
