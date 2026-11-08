import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, PLAYER, VEHICLE, VEHICLE_VARIANT, WEAPONS, vehicleDefinition, CONDOR_BOMB, CONDOR_CARPET_COUNT,
  type InputCmd, type WeaponDef } from '@shared/index';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';

const command = (seq: number, buttons = 0): InputCmd => ({ seq, buttons, yaw: 0, pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 });

test('at most two Condor heavy bombers park at runway thresholds, inside the strip', () => {
  const game = new Game(1337, { vehicles: true, frontier: true });
  const condors = [...game.vehicles.values()].filter(v => v.type === VEHICLE.JET && v.variant === VEHICLE_VARIANT.CONDOR);
  assert.equal(condors.length, 2);
  const strips = (game as unknown as { vehicleSites: { type: number; variant?: number; x: number; z: number; heading: number }[] })
    .vehicleSites.filter(s => s.type === VEHICLE.JET && !s.variant);
  for (const v of condors) {
    assert.ok(v.campaignHome, 'a destroyed bomber returns to its runway');
    const strip = strips.find(s => Math.abs(Math.hypot(s.x - v.x, s.z - v.z) - 32) < .5);
    assert.ok(strip, 'parked 32 m behind a runway center');
    assert.equal(v.heading, strip.heading, 'nose down the strip');
    assert.ok(Math.abs(v.y - game.world.groundY(v.x, v.z)) < .2, 'on the ground');
  }
  assert.ok(Math.hypot(condors[0].x - condors[1].x, condors[0].z - condors[1].z) > 1000, 'on two different runways');
  assert.ok(vehicleDefinition(VEHICLE.JET, VEHICLE_VARIANT.CONDOR)!.maxSpeed < vehicleDefinition(VEHICLE.JET)!.maxSpeed * .6,
    'much slower than a fighter: an easy target unless it flies high');
});

test('about 8 direct rockets bring a Condor down, and one release drops a long bomb carpet', () => {
  const game = new Game(1337), p = game.addPlayer('Rocketeer', null);
  game.world.trace = (x, y, z, dx, dy, dz, max) => ({ hit: false, dist: max, x: x + dx * max, y: y + dy * max, z: z + dz * max, nx: 0, ny: 0, nz: 0 });
  const def = vehicleDefinition(VEHICLE.JET, VEHICLE_VARIANT.CONDOR)!;
  const hull: ServerVehicle = { id: 900, type: VEHICLE.JET, variant: VEHICLE_VARIANT.CONDOR, x: 0, y: 1000, z: -60, heading: 0,
    occupant: -1, health: def.maxHealth, respawnAtTick: -1 };
  game.vehicles.set(hull.id, hull);
  const intern = game as unknown as { fireProjectile(p: ServerPlayer, c: InputCmd, d: WeaponDef): void; updateProjectiles(): void };
  Object.assign(p.state, { px: 0, py: 1000, pz: 0 }); p.weapon = 3;
  const cmd = { ...command(1), pitch: Math.atan2(def.radius - PLAYER.EYE_HEIGHT, 60) };
  let hits = 0;
  while (hull.health > 0 && hull.respawnAtTick < 0 && hits < 20) {
    intern.fireProjectile(p, cmd, WEAPONS[3]);
    for (let i = 0; i < 120 && game.projectiles.size; i++) intern.updateProjectiles();
    hits++;
  }
  assert.ok(hits >= 7 && hits <= 9, `brought down by ${hits} direct rockets`);

  const bombing = new Game(1337), pilot = bombing.addPlayer('Bombardier', null);
  const bomber: ServerVehicle = { id: 901, type: VEHICLE.JET, variant: VEHICLE_VARIANT.CONDOR, x: 0, y: 400, z: 0, heading: 0,
    occupant: pilot.id, health: def.maxHealth, respawnAtTick: -1 };
  bombing.vehicles.set(bomber.id, bomber);
  Object.assign(pilot.state, { px: 0, py: 400, pz: 0, vz: -60, vehicle: VEHICLE.JET, vehicleVariant: VEHICLE_VARIANT.CONDOR, seat: 0, vehicleId: bomber.id, grounded: false });
  pilot.vehicleId = bomber.id; pilot.vehAltCd = 0;
  bombing.queueInput(pilot, command(1, BTN.ALTFIRE | BTN.THROTTLE)); bombing.step();
  assert.equal([...bombing.projectiles.values()].filter(r => r.weapon === CONDOR_BOMB.id).length, CONDOR_CARPET_COUNT);
});

test('a Condor rolls down its runway and climbs away on held throttle and a short pull-up', () => {
  const game = new Game(1337, { vehicles: true, frontier: true });
  const bomber = [...game.vehicles.values()].find(v => v.type === VEHICLE.JET && v.variant === VEHICLE_VARIANT.CONDOR)!;
  const pilot = game.addPlayer('Condor pilot', null); pilot.faction = 1;
  Object.assign(pilot.state, { px: bomber.x + 3, py: bomber.y + .1, pz: bomber.z, grounded: true });
  game.queueInput(pilot, command(pilot.lastQueuedSeq + 1, BTN.USE)); game.step();
  game.queueInput(pilot, command(pilot.lastQueuedSeq + 1)); game.step();
  assert.equal(pilot.state.vehicleId, bomber.id, 'boards the parked bomber');
  const ground = game.world.groundY(bomber.x, bomber.z);
  for (let i = 0; i < 480; i++) {
    game.queueInput(pilot, { ...command(pilot.lastQueuedSeq + 1, BTN.THROTTLE | (i > 70 && i < 110 ? BTN.BACK : 0)), yaw: pilot.state.heading });
    game.step();
  }
  assert.ok(pilot.state.alive && pilot.state.vehicle === VEHICLE.JET && pilot.state.py > ground + 20,
    `climbs away from the strip (height ${(pilot.state.py - ground).toFixed(1)} m)`);
  assert.ok(Math.hypot(pilot.state.vx, pilot.state.vy, pilot.state.vz) <= vehicleDefinition(VEHICLE.JET, VEHICLE_VARIANT.CONDOR)!.maxSpeed + 1);
});
