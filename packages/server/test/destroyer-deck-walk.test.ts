import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, VEHICLE, VEHICLE_VARIANT, vehicleDefinition, DESTROYER_AA_PIVOT, DESTROYER_BRIDGE_EYE, type InputCmd } from '@shared/index';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';
import { vehicleCollisionWorld } from '../../shared/test/vehicle-collision-fixture.js';

const command = (seq: number, buttons = 0, yaw = 0): InputCmd => ({ seq, buttons, yaw, pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 });

test('a captain can leave the bridge, walk aft along the side deck and take the AA mount', () => {
  const game = new Game(1337); vehicleCollisionWorld(game.world);
  const hull: ServerVehicle = { id: 10002, type: VEHICLE.GUNBOAT, variant: VEHICLE_VARIANT.DESTROYER, x: 0, y: 0, z: 0, heading: 0,
    occupant: -1, gunner: -1, health: vehicleDefinition(VEHICLE.GUNBOAT, VEHICLE_VARIANT.DESTROYER)!.maxHealth, respawnAtTick: -1 };
  game.vehicles.set(hull.id, hull);
  const captain = new ServerPlayer(10003, 'Captain', null, false, { x: 1.5, y: 3.5, z: DESTROYER_BRIDGE_EYE.z });
  captain.faction = 1; captain.state.grounded = true; game.players.set(captain.id, captain);
  const press = (buttons: number, yaw = 0) => { game.queueInput(captain, command(captain.lastQueuedSeq + 1, buttons, yaw)); game.step(); };
  press(BTN.USE); press(0);
  assert.equal(captain.state.seat, 0, 'boards the bridge');
  press(BTN.USE); press(0);
  assert.equal(captain.state.vehicle, VEHICLE.NONE, 'steps out onto the deck');
  const start = { x: captain.state.px, z: captain.state.pz };
  // Aft is local +z here (heading 0, the bow points to -z): yaw pi faces +z.
  for (let i = 0; i < 300 && captain.state.pz < DESTROYER_AA_PIVOT.z - 2; i++) press(BTN.FORWARD, Math.PI);
  assert.ok(captain.state.pz > (DESTROYER_BRIDGE_EYE.z + DESTROYER_AA_PIVOT.z) / 2 + 1,
    `walks past the midpoint between the posts (from z ${start.z.toFixed(1)} to ${captain.state.pz.toFixed(1)})`);
  assert.ok(Math.abs(captain.state.py - 3.4) < .3, `stays on deck (y ${captain.state.py.toFixed(2)})`);
  assert.ok(Math.abs(captain.state.px) < 3.6, 'still aboard, not over the side');
  press(BTN.USE); press(0);
  assert.equal(captain.state.vehicleId, hull.id); assert.equal(captain.state.seat, 1, 'takes the AA mount');
});
