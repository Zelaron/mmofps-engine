import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildRig, animateRig, PlayerModels, MAX_NEW_MODELS_PER_FRAME } from '../src/render/players.js';
import { VEHICLE } from '@shared/index';
import { weaponGripPoints } from '../src/render/weapon-models.js';
import type { PlayerView } from '../src/interp.js';

function view(partial: Partial<PlayerView> = {}): PlayerView {
  return {
    id: 1, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, dead: false, grounded: true,
    weapon: 1, vehicle: 0, heading: 0, vx: 0, vy: 0, vz: 0, ...partial,
  };
}

test('operator armor shares bounded geometry and stays aligned with the player capsule', () => {
  const a = buildRig(7), b = buildRig(7 + 24);
  const aMeshes: THREE.Mesh[] = [], bMeshes: THREE.Mesh[] = [];
  for (const [rig, meshes] of [[a, aMeshes], [b, bMeshes]] as const) {
    rig.group.traverse((obj) => { if (obj instanceof THREE.Mesh) meshes.push(obj); });
  }
  assert.equal(aMeshes.length, bMeshes.length);
  for (let i = 0; i < aMeshes.length; i++) assert.equal(aMeshes[i].geometry, bMeshes[i].geometry);
  assert.ok(aMeshes.length <= 18, `${aMeshes.length} draws including the weapon`);
  const bodyMeshes = aMeshes.filter((mesh) => {
    let parent: THREE.Object3D | null = mesh;
    while (parent) {
      if (parent === a.gunMount) return false;
      parent = parent.parent;
    }
    return true;
  });
  const triangles = aMeshes.reduce((sum, mesh) => sum + (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3, 0);
  assert.ok(triangles < 8000, `${triangles} triangles including the weapon`);
  const bounds = new THREE.Box3().setFromObject(a.group);
  assert.ok(bounds.min.y >= -0.005, `feet penetrate floor: ${bounds.min.y}`);
  assert.ok(bounds.max.y >= 1.75 && bounds.max.y <= 1.90, `operator height ${bounds.max.y}`);
  assert.equal(a.group.scale.y, 1, 'appearance must not scale feet away from their support');
  assert.equal(bodyMeshes.length, 1, 'all articulated body parts share one draw');
  assert.equal(bodyMeshes[0].userData.operatorParts.length, 15, 'all original articulated parts are retained');
  assert.equal(new Set(bodyMeshes.map((mesh) => mesh.material)).size, 1, 'one shared body material');
  const variants = new Set<number>();
  for (let id = 0; id < 8; id++) variants.add(buildRig(id).bulk);
  assert.ok(variants.size > 1, 'uniform silhouette varies across players');
});

test('grounded uphill and downhill travel keeps striding despite large vertical velocity', () => {
  for (const slope of [-0.65, 0.65]) {
    const rig = buildRig(3), samples: number[] = [];
    const running = view({ vz: -8, vy: slope * 8 });
    for (let i = 0; i < 150; i++) {
      running.z = -i * 8 / 60;
      running.y = i * 8 / 60 * slope;
      animateRig(rig, running, 1 / 60);
      if (i > 90) samples.push(rig.legL.rotation.x);
    }
    assert.ok(rig.air < 0.001, 'contact comes from grounded, not inferred vertical speed');
    assert.ok(Math.max(...samples) - Math.min(...samples) > 0.8, 'legs must keep alternating on slopes');
    assert.ok(rig.run > 0.8);
  }
});

test('walking plants its stance foot and keeps the sole level while the swing foot lifts', () => {
  const rig = buildRig(1), running = view({ vz: -5 });
  let lifted = false, planted = false;
  for (let i = 0; i < 180; i++) {
    running.z -= 5 / 60;
    animateRig(rig, running, 1 / 60);
    rig.group.updateMatrixWorld(true);
    const a = rig.footL.getWorldPosition(new THREE.Vector3());
    const b = rig.footR.getWorldPosition(new THREE.Vector3());
    const low = Math.min(a.y, b.y), high = Math.max(a.y, b.y);
    if (i > 60) {
      assert.ok(Math.abs(low - 0.085) < 0.012, `stance ankle must remain supported: ${low}`);
      lifted ||= high > 0.14;
      planted ||= low < 0.087;
    }
  }
  assert.ok(lifted && planted, 'stance and swing should be visually distinct');
});

test('stride follows displayed distance and settles when snapshots stall', () => {
  const rig = buildRig(2), running = view({ vz: -8, vy: 3 });
  for (let i = 0; i < 60; i++) {
    running.z -= 8 / 60;
    animateRig(rig, running, 1 / 60);
  }
  const phase = rig.phase;
  // Interp holds the newest pose when updates run out but retains velocity
  // for vehicles. Character animation must not continue marching in place.
  for (let i = 0; i < 120; i++) animateRig(rig, running, 1 / 60);
  assert.equal(rig.phase, phase);
  assert.ok(rig.run < 0.001 && rig.air < 0.001);
  assert.ok(Math.abs(rig.kneeL.rotation.x) < 0.3, 'idle knees should relax after a stalled stride');
  running.x += 400;
  animateRig(rig, running, 1 / 60);
  assert.equal(rig.phase, phase, 'teleports must not produce hundreds of phantom strides');
});

test('backpedal reverses the gait and strafing turns legs toward displayed travel', () => {
  const forward = buildRig(4), backward = buildRig(4), sideways = buildRig(4);
  const a = view(), b = view(), c = view();
  for (let i = 0; i < 30; i++) {
    a.z -= 3 / 60; b.z += 3 / 60; c.x += 3 / 60;
    animateRig(forward, a, 1 / 60);
    animateRig(backward, b, 1 / 60);
    animateRig(sideways, c, 1 / 60);
  }
  assert.ok(Math.abs(forward.legL.rotation.x - backward.legL.rotation.x) > 0.1);
  assert.ok(Math.abs(sideways.hips.rotation.y + sideways.legL.rotation.y) > 1.4,
    'strafe feet must move across the heading instead of running straight ahead');
});

test('stationary jumps stay airborne through the apex and recover on landing', () => {
  const rig = buildRig(3);
  for (let i = 0; i < 30; i++) animateRig(rig, view({ grounded: false, y: 1.4, vy: i < 10 ? 8 : 0 }), 1 / 60);
  assert.ok(rig.air > 0.98, 'the jump apex still has no ground contact');
  assert.ok(rig.kneeL.rotation.x < -0.7);
  animateRig(rig, view({ grounded: false, y: 0.2, vy: -8 }), 1 / 60);
  animateRig(rig, view({ grounded: true }), 1 / 60);
  assert.ok(rig.landing > 0.02, 'landing absorbs the impact');
  for (let i = 0; i < 90; i++) animateRig(rig, view(), 1 / 60);
  assert.ok(rig.air < 0.001 && rig.landing < 0.001);
});

test('aim follows pitch and both hands stay on every weapon grip', () => {
  const rig = buildRig(5);
  for (let weapon = 0; weapon < 7; weapon++) {
    animateRig(rig, view({ weapon, pitch: -0.8 }), 1 / 60);
    assert.ok(Math.abs(rig.torso.rotation.x + rig.aim.rotation.x + 0.8) < 1e-6);
    assert.equal(rig.gunMount.userData.weapon, weapon);
    const grips = weaponGripPoints(weapon);
    for (const arm of rig.arms) {
      const local = arm.side > 0 ? grips.trigger : grips.support;
      const expected = new THREE.Vector3(...local).add(rig.gunMount.position);
      assert.ok(arm.hand.position.distanceTo(expected) < 1e-9);
      assert.ok(arm.forearm.position.distanceTo(arm.hand.position) < 0.35, 'support wrist must remain attached to the forearm');
      assert.ok(arm.hand.position.z < -0.21, 'the grip must clear the plate carrier');
    }
  }
});

test('remote vehicles retain their own attitude and dismount without a phantom stride', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const context = { measureText: () => ({ width: 100 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ width: 256, height: 56, getContext: () => context }),
  } });
  try {
    const models = new PlayerModels(), names = new Map([[1, 'Pilot']]);
    const state = view({ vehicle: VEHICLE.JET, heading: 1, yaw: -.5, vehiclePitch: .2, vehicleRoll: -.7 });
    models.update([state], names, 1 / 60);
    const root = models.group.children[0], operator = root.getObjectByName('operator')!;
    const hull = root.children[root.children.length - 1];
    assert.equal(operator.visible, false);
    assert.ok(Math.abs(hull.rotation.y - 1.5) < 1e-9);
    assert.equal(hull.rotation.x, .2);
    assert.equal(hull.rotation.z, -.7);
    state.x += 2;
    state.vehicle = VEHICLE.NONE;
    models.update([state], names, 1 / 60);
    assert.equal(operator.visible, true);
    assert.equal(hull.visible, false);
    const idle = buildRig(1);
    const shownLeftLeg = operator.children[0].children[1];
    assert.ok(Math.abs(shownLeftLeg.rotation.x - idle.legL.rotation.x) < 1e-8,
      'first frame after dismount must use the idle support pose');
    const muzzle = models.muzzlePos(1)!;
    animateRig(idle, state, 1 / 60);
    idle.group.position.set(state.x, state.y, state.z);
    idle.group.rotation.y = state.yaw;
    const expected = idle.gunMount.localToWorld(new THREE.Vector3().fromArray(idle.gunMount.children[0].userData.muzzle));
    assert.ok(muzzle.distanceTo(expected) < 1e-8, 'remote tracer starts at the upgraded barrel tip');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('steady strafing keeps one world-space gait while rapid aim jitter crosses the old90degree boundary',()=>{
  const rig=buildRig(6),state=view(),wrap=(a:number)=>Math.atan2(Math.sin(a),Math.cos(a));
  let previousYaw=0,previousPhase=0;
  for(let i=0;i<240;i++){
    state.x=i*6/60;state.yaw=Math.sin(i*1.7)*.07;state.pitch=Math.sin(i*.2)*.5;
    rig.group.rotation.y=state.yaw;animateRig(rig,state,1/60);rig.group.updateMatrixWorld(true);
    const lowerWorld=wrap(state.yaw+rig.hips.rotation.y+rig.legL.rotation.y);
    if(i>60){
      assert.ok(Math.abs(wrap(lowerWorld-previousYaw))<.025,'steady travel cannot flip the legs when aim changes sign');
      assert.ok(wrap(rig.phase-previousPhase)>0,'strafe gait phase cannot alternate forward/backward every snapshot');
      assert.ok(Math.abs(wrap(lowerWorld+Math.PI/2))<.03);
    }
    const actual=new THREE.Vector3(0,0,-1).applyQuaternion(rig.aim.getWorldQuaternion(new THREE.Quaternion()));
    const expected=new THREE.Vector3(-Math.sin(state.yaw)*Math.cos(state.pitch),Math.sin(state.pitch),-Math.cos(state.yaw)*Math.cos(state.pitch));
    assert.ok(actual.distanceTo(expected)<1e-6,'upper gun aim remains exact despite eased lower-body facing');
    previousYaw=lowerWorld;previousPhase=rig.phase;
  }
});

test('an aim flick while running turns the legs with the soldier instead of leaving them on the old heading', () => {
  const rig = buildRig(8), state = view(), wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  // Run north while aiming north, then keep running north while aiming south
  // (a bot shooting behind itself on the march, or a player backpedalling).
  for (let i = 0; i < 60; i++) { state.z -= 6 / 60; animateRig(rig, state, 1 / 60); }
  assert.equal(rig.backward, false);
  state.yaw = Math.PI;
  for (let i = 0; i < 60; i++) {
    state.z -= 6 / 60; animateRig(rig, state, 1 / 60);
    assert.ok(Math.abs(rig.hips.rotation.y) <= 0.6 + 1e-9, `pelvis left the aim frame: ${rig.hips.rotation.y}`);
  }
  assert.equal(rig.backward, true, 'travel away from the aim is a backpedal');
  const pelvisWorld = wrap(state.yaw + rig.hips.rotation.y);
  assert.ok(Math.abs(wrap(pelvisWorld - Math.PI)) < 0.1, `pelvis should face the aim, got ${pelvisWorld}`);
  const stepLine = wrap(state.yaw + rig.hips.rotation.y + rig.legL.rotation.y);
  assert.ok(Math.abs(wrap(stepLine - Math.PI)) < 0.1, 'feet backpedal along the line of travel');
});

test('a soldier aiming anywhere while moving never twists its pelvis beyond the lower-body limit', () => {
  const rig = buildRig(9), state = view(), wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  for (let i = 0; i < 600; i++) {
    state.x += 7 / 60;
    state.yaw = wrap(Math.sin(i * 0.013) * 3.1 + Math.sin(i * 0.071));
    animateRig(rig, state, 1 / 60);
    assert.ok(Math.abs(rig.hips.rotation.y) <= 0.6 + 1e-9);
    assert.ok(Math.abs(rig.torso.rotation.y) <= 0.6 * 0.45 + 1e-6);
  }
});

test('diagonal running twists the pelvis toward travel and keeps the stride on the path', () => {
  const rig = buildRig(10), state = view(), wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  // Forward-left at 45 degrees while aiming straight ahead.
  for (let i = 0; i < 90; i++) { state.x -= 5 / 60; state.z -= 5 / 60; animateRig(rig, state, 1 / 60); }
  assert.equal(rig.backward, false);
  assert.ok(rig.hips.rotation.y > 0.4 && rig.hips.rotation.y <= 0.6, `pelvis twist ${rig.hips.rotation.y}`);
  assert.ok(Math.abs(wrap(rig.hips.rotation.y + rig.legL.rotation.y - Math.PI / 4)) < 0.05, 'stride follows the diagonal');
});

test('turning movement can reverse into backpedaling without a180degree lower-body snap',()=>{
 const rig=buildRig(7),state=view();let previous=0;
 for(let i=0;i<180;i++){
  state.z+=(i<90?-1:1)*5/60;animateRig(rig,state,1/60);
  const yaw=rig.moveYaw;
  if(i>3)assert.ok(Math.abs(Math.atan2(Math.sin(yaw-previous),Math.cos(yaw-previous)))<.09);
  previous=yaw;
 }
 assert.equal(rig.backward,true);
});

test('a gunner renders one independent MG beside a single hull and follows local prediction exactly',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'document');const context={measureText:()=>({width:100}),beginPath(){},roundRect(){},fill(){},fillText(){}};
 Object.defineProperty(globalThis,'document',{configurable:true,value:{createElement:()=>({getContext:()=>context})}});
 try {
  const models=new PlayerModels(),driver=view({id:1,vehicle:VEHICLE.TANK,vehicleVariant:2,vehicleId:7,x:10,y:5,z:2,heading:.4,yaw:.3}),
   gunner=view({...driver,id:2,seat:1,yaw:-1,pitch:.2});
  models.update([gunner,driver],new Map(),1/60);
  const internal=models as unknown as {models:Map<number,{hull:THREE.Group|null;crew:THREE.Group|null;root:THREE.Group}>};
  assert.equal(internal.models.get(2)!.hull,null,'passenger cannot draw a duplicate overlapping tank');
  assert.ok(internal.models.get(1)!.hull?.visible);assert.ok(internal.models.get(2)!.crew?.visible);
  const q=new THREE.Quaternion().setFromEuler(new THREE.Euler(.2,1.1,-.1,'YXZ'));
  for(let i=0;i<30;i++) {
   const local={vehicleId:7,x:100+i*1.5,y:6,z:-i*.3,rotation:q};models.update([gunner,driver],new Map(),1/60,local);
   assert.equal(internal.models.get(1)!.hull!.visible,false,'local first-person hull replaces remote driver hull');
   assert.ok(internal.models.get(2)!.root.position.distanceTo(new THREE.Vector3(local.x,local.y,local.z))<1e-9);
   const crew=internal.models.get(2)!.crew!;assert.ok(crew.getWorldQuaternion(new THREE.Quaternion()).angleTo(q)<1e-7);
   const muzzle=models.muzzlePos(2)!;assert.ok(muzzle.distanceTo(new THREE.Vector3(local.x,local.y,local.z))<8,'MG muzzle follows current predicted hull rather than old snapshot position');
  }
  gunner.seat=0;gunner.vehicle=0;gunner.vehicleId=undefined;models.update([gunner],new Map(),1/60);
  assert.equal(internal.models.get(2)!.crew!.visible,false,'dismount removes the crew weapon');
 }finally{if(previous)Object.defineProperty(globalThis,'document',previous);else Reflect.deleteProperty(globalThis,'document');}
});

test('arriving at a crowded battle builds at most a few soldiers per frame, then all of them', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const context = { measureText: () => ({ width: 100 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ getContext: () => context }) } });
  try {
    const models = new PlayerModels(), crowd = Array.from({ length: MAX_NEW_MODELS_PER_FRAME * 2 + 2 }, (_, i) => view({ id: 100 + i, x: i * 2 }));
    const built = () => models.group.children.length;
    models.update(crowd, new Map(), 1 / 60);
    assert.equal(built(), MAX_NEW_MODELS_PER_FRAME);
    models.update(crowd, new Map(), 1 / 60);
    assert.equal(built(), MAX_NEW_MODELS_PER_FRAME * 2, 'existing soldiers keep updating while more appear');
    models.update(crowd, new Map(), 1 / 60);
    assert.equal(built(), crowd.length);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document');
  }
});
