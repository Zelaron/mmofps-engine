import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BTN, TICK_DT, VEHICLE, VEHICLE_DEFS, World, createMoveState, copyMoveState, stepMove,
  rotationFromEuler, rotationToEuler, rotateVector, vehicleQuaternion, vehicleLocalOffset,
  slerpRotations, JET_GUN_MUZZLE, JET_BOMB_BAY, type Rotation, type InputCmd,
} from '@shared/index';

const OPEN_AIR = {
  sdf: (_x: number, y: number) => y,
  gradient: (_x: number, _y: number, _z: number, out: { x: number; y: number; z: number }) => {
    out.x = out.z = 0; out.y = 1;
  },
  groundY: () => 0,
} as unknown as World;
const input = (buttons: number, seq = 0): InputCmd => ({
  buttons, seq, weapon: 0, yaw: 2.3, pitch: -1.4, renderTick: 0, renderFrac: 0,
});
function dot(a: Rotation, b: Rotation): number { return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w; }

test('holding either pitch control completes repeated uninterrupted loops through both vertical poles', () => {
  for (const direction of [-1, 1]) {
    const state = createMoveState(0, 5000, 0); state.vehicle = VEHICLE.JET; state.vz = -100;
    let inverted = 0, backwards = 0;
    for (let tick = 1; tick <= 1100; tick++) {
      stepMove(OPEN_AIR, state, input(BTN.THROTTLE | (direction > 0 ? BTN.BACK : BTN.FORWARD), tick), TICK_DT);
      const q = vehicleQuaternion(state);
      const angle = direction * tick * TICK_DT * VEHICLE_DEFS[VEHICLE.JET].turnRate;
      assert.ok(Math.abs(dot(q, rotationFromEuler(0, angle))) > 1 - 1e-10,
        `pitch must keep integrating past90/180/360degrees (tick${tick}, angle${angle})`);
      assert.ok(Math.abs(Math.hypot(q.x, q.y, q.z, q.w) - 1) < 1e-12);
      const forward = rotateVector(q, 0, 0, -1), up = rotateVector(q, 0, 1, 0);
      if (up.y < -0.9) inverted++;
      if (forward.z > 0.9) backwards++;
      assert.equal(state.grounded, false);
      assert.ok(Number.isFinite(state.px + state.py + state.pz + state.vx + state.vy + state.vz));
    }
    assert.ok(inverted > 100 && backwards > 100, 'the flight actually passes through inverted/backward attitudes repeatedly');
  }
});

test('simultaneous local pitch and roll remain smooth, deterministic and independent of Euler display angles', () => {
  const first = createMoveState(0, 6000, 0); first.vehicle = VEHICLE.JET; first.vz = -100;
  const copy = createMoveState(0, 0, 0); copyMoveState(first, copy);
  // Copying materializes optional snapshot fields (seat/route) as undefined.
  // Normalize both replay fixtures before comparing the complete state.
  copyMoveState(copy, first);
  let previous = vehicleQuaternion(first);
  for (let tick = 0; tick < 1800; tick++) {
    const cmd = input(BTN.THROTTLE | BTN.BACK | (tick % 500 < 250 ? BTN.LEFT : BTN.RIGHT), tick);
    stepMove(OPEN_AIR, first, cmd, TICK_DT);
    stepMove(OPEN_AIR, copy, { ...cmd, yaw: -cmd.yaw, pitch: -cmd.pitch }, TICK_DT);
    assert.deepEqual(copy, first, 'prediction and authority must integrate the same orientation regardless of free look');
    const q = { ...vehicleQuaternion(first) };
    const angularStep = 2 * Math.acos(Math.min(1, Math.abs(dot(previous, q))));
    assert.ok(angularStep < 0.075, `an Euler pole must never produce a camera/hull flip (${angularStep})`);
    previous = q;
    assert.ok(Math.abs(dot(q, q) - 1) < 1e-12);
    // The next tick uses the quaternion, not the representational Euler
    // branch chosen for HUD/ground compatibility at a vertical pole.
    if (tick % 60 === 0) copy.heading += Math.PI * 2;
  }
  const destination = createMoveState(0, 0, 0); copyMoveState(first, destination);
  assert.deepEqual(destination.vehicleRotation, first.vehicleRotation);
  assert.notEqual(destination.vehicleRotation, first.vehicleRotation, 'prediction state copies must not alias rotations');
});

test('jet attachments and quaternion interpolation preserve inverted and pole-crossing attitudes', () => {
  for (const pitch of [-Math.PI, -Math.PI / 2, Math.PI / 2, Math.PI, 3 * Math.PI / 2]) {
    const q = rotationFromEuler(0.7, pitch, -1.1);
    const state = { ...rotationToEuler(q), vehicleRotation: q };
    for (const offset of [JET_GUN_MUZZLE, JET_BOMB_BAY]) {
      assert.deepEqual(vehicleLocalOffset(state, offset.x, offset.y, offset.z), rotateVector(q, offset.x, offset.y, offset.z));
    }
    const from = rotationFromEuler(0.7, pitch - .04, -1.1), to = rotationFromEuler(0.7, pitch + .04, -1.1);
    const middle = slerpRotations(from, to, .5);
    assert.ok(Math.abs(dot(middle, q)) > 1 - 1e-12, 'shortest interpolation crosses the pole without unwinding roll/yaw');
    const negated = { x: -to.x, y: -to.y, z: -to.z, w: -to.w };
    assert.ok(Math.abs(dot(slerpRotations(from, negated, .5), q)) > 1 - 1e-12,
      'equivalent quaternion signs must not send the remote model the long way around');
  }
});
