import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMoveState, copyMoveState, stepMove, BTN } from '../src/movement.js';
import { World } from '../src/worldgen.js';
import { VEHICLE } from '../src/vehicles.js';
import { TICK_DT } from '../src/constants.js';

test('movement factory keeps legacy serialized defaults and explicit optional values independent', () => {
  const a = createMoveState(-0, 12.5, -20), b = createMoveState(1, 2, 3);
  assert.equal(Object.is(a.px, -0), true);
  assert.deepEqual(JSON.parse(JSON.stringify(a)), {
    px: 0, py: 12.5, pz: -20, vx: 0, vy: 0, vz: 0,
    grounded: false, jumpHeld: false, dodgeCd: 0, alive: true,
    vehicle: 0, vehicleVariant: 0, heading: 0, boostFuel: 1,
    vehiclePitch: 0, vehicleRoll: 0, boosting: false,
  });
  assert.equal(a.seat, undefined); assert.equal(a.airSeconds, undefined);
  a.airlift = { source: 1, destination: 2, startTick: 10, durationTicks: 300 };
  a.vehicleRotation = { x: 0, y: 0, z: 0, w: 1 };
  copyMoveState(a, b);
  assert.deepEqual(b, a);
  assert.notEqual(b.airlift, a.airlift); assert.notEqual(b.vehicleRotation, a.vehicleRotation);
  b.airlift!.source = 9; b.vehicleRotation!.x = .2;
  assert.equal(a.airlift.source, 1); assert.equal(a.vehicleRotation.x, 0);
  copyMoveState(createMoveState(0, 0, 0), b);
  assert.equal(b.airlift, undefined); assert.equal(b.vehicleRotation, undefined);
});

test('ordinary movement, vehicle possession fields and swimming keep the factory property order', () => {
  const world = new World(1337), s = createMoveState(0, .006, 0), keys = Object.keys(s);
  world.sdf = world.sdfCol = (_x, y) => y;
  world.sampleColumn = () => ({ h: 0 }) as ReturnType<World['sampleColumn']>;
  world.collectRegion = () => ({ sites: [], boulders: [], pads: [], solids: [], cuts: [], vegetation: [], foundations: [] });
  world.collectTransportPlan = () => ({ routes: [], pods: [] }) as unknown as ReturnType<World['collectTransportPlan']>;
  world.collectCityLifts = () => [];
  world.liquidAt = () => undefined;
  const cmd = { seq: 1, buttons: BTN.FORWARD, weapon: 0, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 };
  s.grounded = true;
  stepMove(world, s, cmd, TICK_DT, 1);
  assert.equal(s.simulationTick, 1); assert.equal(s.airSeconds, 18);
  assert.deepEqual(Object.keys(s), keys);
  Object.assign(s, { vehicle: VEHICLE.JEEP, seat: 0, vehicleId: 50, transportRoute: undefined });
  stepMove(world, s, cmd, TICK_DT, 2);
  assert.equal(s.vehicle, VEHICLE.JEEP); assert.deepEqual(Object.keys(s), keys);
  Object.assign(s, { vehicle: VEHICLE.NONE, seat: undefined, vehicleId: undefined, py: -1 });
  world.sdf = world.sdfCol = (_x, y) => y + 10;
  world.liquidAt = () => ({ id: 1, kind: 'water', surfaceY: 4, bottomY: -10, distance: -50, flowX: .3, flowZ: 0 });
  stepMove(world, s, cmd, TICK_DT, 3);
  assert.equal(s.swimming, true); assert.equal(s.submerged, true);
  assert.ok(s.airSeconds! < 18); assert.deepEqual(Object.keys(s), keys);
});
