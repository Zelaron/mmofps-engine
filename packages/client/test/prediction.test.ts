import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BTN, TICK_DT, WEAPONS, World, VEHICLE, createFullAmmoLoadout, createMoveState, stepMove,
  type InputCmd, type Snapshot,
  rotationFromEuler, rotationToEuler, vehicleQuaternion,
} from '@shared/index';
import { Prediction } from '../src/prediction.js';
import {transportPose} from '@shared/transport';
import {transitLocal,transitWorld} from '@shared/transit-motion';

function command(seq: number, buttons: number, weapon = 0): InputCmd {
  return {
    seq,
    buttons,
    weapon,
    yaw: 0,
    pitch: 0,
    renderTick: 0,
    renderFrac: 0,
  };
}

function snapshot(
  lastSeq: number,
  magazine = WEAPONS[0].magazineSize,
  reserve = WEAPONS[0].reserveSize,
  weapon = 0,
): Snapshot {
  const ammo = createFullAmmoLoadout();
  ammo[weapon] = { magazine, reserve };
  return {
    tick: 100,
    lastSeq,
    you: {
      px: 0, py: 100, pz: 0,
      vx: 0, vy: 0, vz: 0,
      grounded: false,
      alive: true,
      dodgeCd: 0,
      health: 100,
      weapon,
      cooldown: 0,
      ammo,
      reloadWeapon: -1,
      reloadCooldown: 0,
      reloadHeld: false,
      vehicle: 0, heading: 0, boostFuel: 1, vehicleHealth: 0, lockState: 0,
    },
    ents: [],
  };
}

test('jittering snapshot ticks keep the rendered passenger fixed to a continuously moving deck',()=>{
  for(const kind of ['ferry','train'] as const) {
    const world=new World(1337),route=world.collectTransportPlan().routes.find(r=>r.kind===kind)!;
    const leg=route.legs[0],i=leg.distances.findIndex((d,i)=>i>0&&d-leg.distances[i-1]>800);
    const start=Math.round((route.dwell+1.5+(leg.distances[i-1]+300)/route.speed)*60);
    const car=kind==='train'?2:0,floor=kind==='train'?1.2:2,pred=new Prediction(world);
    const authority=(tick:number,seq:number)=>{
      const pose=transportPose(route,tick/60,route.carOffsets[car]),p=transitWorld(pose,0,floor+.006,0),snap=snapshot(seq);
      snap.tick=tick;Object.assign(snap.you,{px:p.x,py:p.y,pz:p.z,grounded:true});return snap;
    };
    pred.onSnapshot(authority(start,0));pred.frame(0);
    let previous=pred.renderSeconds,seq=0;
    for(let frame=1;frame<=360;frame++) {
      if(frame%2===0)pred.applyLocal(command(++seq,0));
      if(frame%12===0)pred.onSnapshot(authority(start+Math.floor(frame/2)+(frame%24===0?-2:1),seq));
      pred.frame(1/120,frame%2*.5);
      const time=pred.renderSeconds;
      assert.ok(time>previous&&time-previous<1.13/120,'presentation clock cannot jump or reverse on a snapshot');
      const p=pred.renderPos(),local=transitLocal(transportPose(route,time,route.carOffsets[car]),p.x,p.y,p.z);
      assert.ok(Math.hypot(local.x,local.z)<.005,`${kind} camera rocked on the deck`);
      assert.ok(Math.abs(local.y-floor)<.025);previous=time;
    }
  }
});

test('a delayed snapshot drops obsolete input replay and restores firing after a long stall', () => {
  const pred=new Prediction(new World(1337));
  pred.onSnapshot(snapshot(0,4,20,3));
  for(let i=1;i<=180;i++) pred.applyLocal(command(i,BTN.FIRE,3));
  assert.equal(pred.weaponState.ammo[3].magazine,0);
  const authority=snapshot(0,4,20,3);
  pred.onSnapshot(authority);
  assert.equal(pred.resyncVersion,1);
  assert.equal(pred.weaponState.ammo[3].magazine,4,'old shots must not consume fresh authoritative ammo');
  assert.equal(pred.state.pz,authority.you.pz);
  assert.equal(pred.applyLocal(command(181,BTN.FIRE,3)).weapon.firedWeapon,3);
});

test('an older snapshot cannot restore a locally predicted round', () => {
  const pred = new Prediction(new World(1337));
  pred.onSnapshot(snapshot(0));

  const fired = pred.applyLocal(command(1, BTN.FIRE));
  assert.equal(fired.weapon.firedWeapon, 0);
  assert.equal(pred.weaponState.ammo[0].magazine, WEAPONS[0].magazineSize - 1);

  // This authority state predates seq 1. Replaying the pending command must
  // consume the same round without re-emitting its presentation event.
  pred.onSnapshot(snapshot(0));
  assert.equal(pred.weaponState.ammo[0].magazine, WEAPONS[0].magazineSize - 1);

  const acknowledged = snapshot(1, WEAPONS[0].magazineSize - 1);
  acknowledged.you.cooldown = WEAPONS[0].interval - TICK_DT;
  pred.onSnapshot(acknowledged);
  assert.equal(pred.weaponState.ammo[0].magazine, WEAPONS[0].magazineSize - 1);
});

test('reload state is predicted, replayed, and completes with exact reserve transfer', () => {
  const pred = new Prediction(new World(4242));
  const weapon = 1;
  pred.onSnapshot(snapshot(0, 1, 50, weapon));

  const start = pred.applyLocal(command(1, BTN.RELOAD, weapon));
  assert.equal(start.weapon.reloadStartedWeapon, weapon);
  assert.equal(pred.weaponState.reloadWeapon, weapon);

  // Reconcile against authority from before the key press; pending replay
  // must restore the active reload and its edge-held state.
  pred.onSnapshot(snapshot(0, 1, 50, weapon));
  assert.equal(pred.weaponState.reloadWeapon, weapon);
  assert.equal(pred.weaponState.reloadHeld, true);

  let completed = false;
  const ticks = Math.ceil(WEAPONS[weapon].reloadTime / TICK_DT) + 2;
  for (let i = 0; i < ticks; i++) {
    const result = pred.applyLocal(command(i + 2, 0, weapon));
    completed ||= result.weapon.reloadCompletedWeapon === weapon;
  }

  assert.equal(completed, true);
  assert.equal(pred.weaponState.reloadWeapon, -1);
  assert.equal(pred.weaponState.ammo[weapon].magazine, WEAPONS[weapon].magazineSize);
  assert.equal(pred.weaponState.ammo[weapon].reserve, 50 - (WEAPONS[weapon].magazineSize - 1));
});


test('jet reconciliation restores aircraft attitude before replaying pending controls', () => {
  const world = new World(1337), pred = new Prediction(world);
  const initial = snapshot(0);
  Object.assign(initial.you, { vehicle: VEHICLE.JET, py: 250, vz: -50, vehiclePitch: 0.2, vehicleRoll: 0.4 });
  pred.onSnapshot(initial);
  const commands = Array.from({length: 6}, (_, i) => command(i + 1, BTN.THROTTLE | BTN.LEFT | BTN.BACK));
  for (const cmd of commands) pred.applyLocal(cmd);
  const correction = snapshot(3);
  Object.assign(correction.you, { vehicle: VEHICLE.JET, py: 251, vz: -52,
    heading: 0.6, vehiclePitch: 0.45, vehicleRoll: 1.1 });
  const expected = createMoveState(0, 251, 0);
  Object.assign(expected, { vehicle: VEHICLE.JET, vz: -52, heading: 0.6, vehiclePitch: 0.45, vehicleRoll: 1.1 });
  for (const cmd of commands.slice(3)) stepMove(world, expected, cmd, TICK_DT);
  pred.onSnapshot(correction);
  for (const key of ['px', 'py', 'pz', 'vx', 'vy', 'vz', 'heading', 'vehiclePitch', 'vehicleRoll'] as const) {
    assert.equal(pred.state[key], expected[key], `replayed ${key} must use the authoritative attitude`);
  }
});

test('jet reconciliation restores an inverted quaternion and replays through a vertical pole without aliasing', () => {
  const world = new World(1337), pred = new Prediction(world);
  const initial = snapshot(0);
  Object.assign(initial.you, { vehicle: VEHICLE.JET, py: 2000, vz: -90,
    vehicleRotation: rotationFromEuler(.7, Math.PI - .2, 1.1) });
  pred.onSnapshot(initial);
  const commands = Array.from({ length: 20 }, (_, i) => command(i + 1, BTN.THROTTLE | BTN.LEFT | BTN.BACK));
  for (const cmd of commands) pred.applyLocal(cmd);
  const rotation = rotationFromEuler(.2, Math.PI / 2 - .01, .9);
  const correction = snapshot(8);
  Object.assign(correction.you, { vehicle: VEHICLE.JET, py: 2002, vz: -92,
    ...rotationToEuler(rotation), vehicleRotation: rotation });
  const expected = createMoveState(0, 2002, 0);
  Object.assign(expected, { vehicle: VEHICLE.JET, vz: -92,
    ...rotationToEuler(rotation), vehicleRotation: { ...rotation } });
  for (const cmd of commands.slice(8)) stepMove(world, expected, cmd, TICK_DT);
  pred.onSnapshot(correction);
  assert.deepEqual(vehicleQuaternion(pred.state), vehicleQuaternion(expected));
  for (const key of ['px', 'py', 'pz', 'vx', 'vy', 'vz'] as const) assert.equal(pred.state[key], expected[key]);
  assert.deepEqual(correction.you.vehicleRotation, rotation, 'replay cannot mutate snapshot history');
  assert.notEqual(pred.state.vehicleRotation, correction.you.vehicleRotation);
});

test('possession changes discard old correction offsets even between the same base hull type', () => {
  const pred = new Prediction(new World(1337));
  const initial = snapshot(0); initial.you.vehicle=2; pred.onSnapshot(initial);
  const ordinaryCorrection = snapshot(0); ordinaryCorrection.you.vehicle=2; ordinaryCorrection.you.px=1;
  pred.onSnapshot(ordinaryCorrection); assert.notEqual(pred.renderPos().x,pred.state.px);
  const variant = snapshot(0); variant.you.vehicle=2; variant.you.vehicleVariant=2; variant.you.px=2;
  pred.onSnapshot(variant); assert.equal(pred.state.vehicleVariant,2); assert.equal(pred.renderPos().x,2);
  const exit = snapshot(0); exit.you.px=2.5; pred.onSnapshot(exit);
  assert.equal(pred.state.vehicleVariant,0); assert.equal(pred.renderPos().x,2.5);
});
