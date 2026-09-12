import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMoveState, copyMoveState, stepMove, BTN, type InputCmd } from '@shared/movement';
import { transportPose } from '@shared/transport';
import { transitWorld, transitLocal, transitImpactDamage } from '@shared/transit-motion';
import { capsuleClearance } from '@shared/physics';
import { transportField } from './transport-fixture.js';
import { World } from '@shared/worldgen';

const cmd = (buttons = 0, yaw = 0): InputCmd => ({ seq:0, buttons, yaw, pitch:0, weapon:0, renderTick:0, renderFrac:0 });

test('full-speed trains sweep track pedestrians aside without embedding or carrying them to a station', () => {
  for (const yaw of [0,.73,Math.PI/2]) {
    const { world, route } = transportField(undefined,yaw), seconds = 30, pose = transportPose(route,seconds);
    const p = transitWorld(pose,0,-1.194,-16.5), state = createMoveState(p.x,p.y,p.z);
    state.simulationTick = seconds*60; state.grounded = true;
    const replay = createMoveState(0,0,0); copyMoveState(state,replay); copyMoveState(replay,state);
    let peak = 0, contactCount = 0, maximumStep = 0;
    const contacts: unknown[] = [];
    for (let i=0; i<80; i++) {
      const previous = { x:state.px,y:state.py,z:state.pz };
      const result = stepMove(world,state,cmd(),1/60);
      const repeated = stepMove(world,replay,cmd(),1/60);
      assert.deepEqual(replay,state); assert.deepEqual(repeated,result);
      if (transitImpactDamage(result.transitImpact)>0) { contactCount++; contacts.push({ i, speed:result.transitImpact, x:state.px,y:state.py,z:state.pz,vx:state.vx,vy:state.vy,vz:state.vz }); }
      peak = Math.max(peak,result.transitImpact);
      maximumStep = Math.max(maximumStep,Math.hypot(state.px-previous.x,state.py-previous.y,state.pz-previous.z));
      assert.ok(capsuleClearance(world,state.px,state.py,state.pz)>-.035,'contact leaves the capsule outside the train');
    }
    const local = transitLocal(transportPose(route,state.simulationTick!/60),state.px,state.py,state.pz);
    assert.ok(peak>50,`missing moving-body impact: ${peak}`);
    assert.ok(contactCount<=4,`repeated nose contacts should end as the rebound clears the track: ${JSON.stringify(contacts)}`);
    assert.ok(Math.abs(local.x)>5.5,`victim did not clear the track: ${JSON.stringify(local)}`);
    assert.ok(maximumStep<2.2,`contact used a broad snap instead of a rebound: ${maximumStep}`);
  }
});

test('standing and jumping passengers are not run over by their own moving train', () => {
  for (const jump of [false,true]) {
    const { world,route } = transportField(), seconds = 30, pose = transportPose(route,seconds,route.carOffsets[2]);
    const p = transitWorld(pose,0,1.206,0), state = createMoveState(p.x,p.y,p.z);
    state.simulationTick = seconds*60; state.grounded = true;
    for (let i=0; i<180; i++) {
      const result = stepMove(world,state,cmd(jump&&i===0?BTN.JUMP:0),1/60);
      assert.equal(transitImpactDamage(result.transitImpact),0);
      assert.ok(result.impact<10,`rider suffered a spurious collision: ${result.impact}`);
    }
    const local = transitLocal(transportPose(route,state.simulationTick!/60,route.carOffsets[2]),state.px,state.py,state.pz);
    assert.ok(Math.hypot(local.x,local.z)<1.5,`rider drift: ${JSON.stringify(local)}`);
    assert.ok(Math.abs(local.y-1.2)<.05);
  }
});

test('stationary boarding has no moving-body injury and low-speed contact is harmless', () => {
  const { world,route } = transportField(), pose = transportPose(route,0,route.carOffsets[2]);
  const p = transitWorld(pose,5.6,1.206,0), state = createMoveState(p.x,p.y,p.z);
  state.simulationTick = 0; state.grounded = true;
  for (let i=0; i<40; i++) {
    const result = stepMove(world,state,cmd(BTN.FORWARD,Math.PI/2),1/60);
    assert.equal(result.transitImpact,0);
  }
  assert.ok(Math.abs(transitLocal(pose,state.px,state.py,state.pz).x)<3);
  for (const speed of [0,1,5,10]) assert.equal(transitImpactDamage(speed),0);
  assert.ok(transitImpactDamage(62)>=90);
});

test('a reversing consist also catches a pedestrian ahead of its leading artillery car', () => {
  const { world,route } = transportField(), seconds = Math.round((2*route.dwell+4000/route.speed+8)*60)/60;
  const pose = transportPose(route,seconds,route.carOffsets[3]), p = transitWorld(pose,0,-1.194,16.5);
  const state = createMoveState(p.x,p.y,p.z); state.grounded = true; state.simulationTick = seconds*60;
  let peak = 0;
  for (let i=0; i<80; i++) peak = Math.max(peak,stepMove(world,state,cmd(),1/60).transitImpact);
  assert.ok(peak>50);
  const local = transitLocal(transportPose(route,state.simulationTick!/60,route.carOffsets[3]),state.px,state.py,state.pz);
  assert.ok(Math.abs(local.x)>5.5);
});

test('walking across moving inter-car gangways does not add rebound or fall damage', () => {
  const { world,route } = transportField(), seconds = 30, pose = transportPose(route,seconds,route.carOffsets[2]);
  const p = transitWorld(pose,0,1.206,-8), state = createMoveState(p.x,p.y,p.z);
  state.simulationTick = seconds*60; state.grounded = true;
  for (let i=0; i<110; i++) {
    const current = transportPose(route,state.simulationTick!/60,route.carOffsets[2]);
    const result = stepMove(world,state,cmd(BTN.FORWARD,current.yaw),1/60);
    assert.equal(result.transitImpact,0);
    assert.ok(result.impact<3);
    assert.ok(Math.abs(state.py-321.206)<.08,'gangway crossing must retain real support');
  }
  const local = transitLocal(transportPose(route,state.simulationTick!/60,route.carOffsets[2]),state.px,state.py,state.pz);
  assert.ok(local.z < -22,`did not cross into the next car: ${JSON.stringify(local)}`);
});

test('a slowly departing train nudges a track pedestrian without a damaging launch', () => {
  const { world,route } = transportField(), seconds = 22.2, pose = transportPose(route,seconds);
  const p = transitWorld(pose,4,-1.194,-12.92), state = createMoveState(p.x,p.y,p.z);
  state.simulationTick = seconds*60; state.grounded = true;
  for (let i=0; i<12; i++) {
    const result = stepMove(world,state,cmd(),1/60);
    assert.equal(transitImpactDamage(result.transitImpact),0);
    assert.ok(state.vy<1,'gentle contact must not launch the player');
  }
});

test('the real Vesper viaduct leaves room for a swept train victim to escape beside the consist', () => {
  const world = new World(1337), route = world.collectTransportPlan().routes.find(r=>r.id===11)!;
  const pose = transportPose(route,26), p = transitWorld(pose,0,-1.194,-16.5), state = createMoveState(p.x,p.y,p.z);
  state.simulationTick = 1560; state.grounded = true;
  let peak = 0;
  for (let i=0; i<65; i++) {
    const result = stepMove(world,state,cmd(),1/60);
    peak = Math.max(peak,result.transitImpact);
    assert.ok(result.impact<10,'recovery must not fling the victim down through the viaduct');
    assert.ok(state.py>318.7,'the track bed remains solid after the impact');
  }
  const local = transitLocal(transportPose(route,state.simulationTick!/60),state.px,state.py,state.pz);
  assert.ok(peak>50);
  assert.ok(Math.abs(local.x)>5.4,`victim trapped under real train: ${JSON.stringify(local)}`);
  assert.ok(capsuleClearance(world,state.px,state.py,state.pz)>-.035);
});
