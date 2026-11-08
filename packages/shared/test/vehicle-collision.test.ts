import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, createMoveState, stepMove, type InputCmd, type MoveState } from '@shared/movement';
import { capsuleClearance } from '@shared/physics';
import { rotationFromEuler, rotateVector } from '@shared/rotation';
import { VEHICLE, VEHICLE_VARIANT } from '@shared/vehicles';
import { setVehicleColliders, updateVehicleCollider, clearVehicleColliders,
  withVehicleColliders, VehicleCollisionField, type VehicleColliderPose } from '@shared/vehicle-collision';
import { vehicleCollisionWorld } from './vehicle-collision-fixture.js';

const cmd: InputCmd = { seq: 1, buttons: 0, weapon: 0, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 };
const hull = (type: number = VEHICLE.JEEP, extra: Partial<VehicleColliderPose> = {}): VehicleColliderPose =>
  ({ id: 1, type, x: 0, y: 0, z: 0, heading: 0, health: 100, ...extra });
const state = (x = 0, y = .02, z = 8): MoveState => ({ ...createMoveState(x, y, z), grounded: true });
const run = (world: ReturnType<typeof vehicleCollisionWorld>, s: MoveState, frames = 120, buttons: number = BTN.FORWARD, yaw = 0) => {
  for (let tick = 1; tick <= frames; tick++) stepMove(world, s, { ...cmd, yaw, buttons }, 1 / 60);
};
const clear = (world: ReturnType<typeof vehicleCollisionWorld>, s: MoveState) =>
  withVehicleColliders(world, s, 1 / 60, () => capsuleClearance(world, s.px, s.py, s.pz));

test('on-foot controller stops at substantial bodies for every vehicle and variant', () => {
  for (const [type, variant, rear] of [[VEHICLE.JEEP, 0, 2.04], [VEHICLE.TANK, 0, 2.33],
    [VEHICLE.TANK, VEHICLE_VARIANT.BASTION, 3.64], [VEHICLE.JET, 0, 3.22],
    [VEHICLE.JET, VEHICLE_VARIANT.NOCTURNE, 8.58], [VEHICLE.GUNBOAT, 0, 4.68]]) {
    const world = vehicleCollisionWorld(), s = state(0, .02, rear + 5);
    // The crescent fuselage sits above a standing person's head at y=0;
    // lower its origin here so the approach intersects its substantial body.
    setVehicleColliders(world, 0, [hull(type, { variant, y: variant === VEHICLE_VARIANT.NOCTURNE && type === VEHICLE.JET ? -1.4 : 0 })]);
    run(world, s);
    assert.ok(s.pz > rear - .1 && s.pz < rear + 1.2, `${type}/${variant}: stopped at ${s.pz}, expected rear ${rear}`);
    assert.ok(clear(world, s) > -.025, `body intersection ${type}/${variant}`);
    assert.equal(world.pedestrianCollisions, undefined, 'scoped field is restored');
  }
});

test('hull yaw changes its footprint and diagonal input slides around its corners', () => {
  const world = vehicleCollisionWorld(), s = state();
  setVehicleColliders(world, 0, [hull(VEHICLE.TANK, { heading: Math.PI / 2 })]);
  run(world, s, 90);
  assert.ok(s.pz > 1.7 && s.pz < 2.2, `side hit ${s.pz}`);
  run(world, s, 180, BTN.FORWARD | BTN.RIGHT);
  assert.ok(s.px > 10 && s.pz < -8, `corner did not slide: ${s.px},${s.pz}`);
  assert.ok(clear(world, s) > -.025);
});

test('hyperspeed cannot cross a tank body or an upright thin jet airfoil', () => {
  for (const pose of [hull(VEHICLE.TANK), hull(VEHICLE.JET, {
    rotation: rotationFromEuler(0, Math.PI / 2, 0), y: 2.68, x: -3.04,
  })]) {
    const world = vehicleCollisionWorld(), s = state(0, .02, 7);
    setVehicleColliders(world, 0, [pose]);
    run(world, s, 180, BTN.FORWARD | BTN.HYPER);
    assert.ok(s.pz > -3.5, `crossed hull: ${pose.type} z=${s.pz}`);
    assert.ok(clear(world, s) > -.025);
  }
});

test('landing onto the roof remains supported and a player can jump onto the hood', () => {
  const world = vehicleCollisionWorld(), s = state(0, 5, .36);
  s.grounded = false;
  setVehicleColliders(world, 0, [hull()]);
  run(world, s, 180, 0);
  assert.ok(Math.abs(s.py - 2.055) < .05 && s.grounded, `roof ${s.py}, grounded ${s.grounded}`);
  assert.ok(clear(world, s) > -.025);
  const jumper = state(0, .02, -3.5);
  run(world, jumper, 5, BTN.FORWARD, Math.PI);
  run(world, jumper, 14, BTN.FORWARD | BTN.JUMP, Math.PI);
  run(world, jumper, 90, 0);
  assert.ok(jumper.py > 1.24 && jumper.grounded, `failed hood jump: ${jumper.py},${jumper.pz}`);
});

test('a slow moving hull pushes a pedestrian and carries a standing roof passenger', () => {
  const world = vehicleCollisionWorld(), standing = state(0, 2.075, .36), front = state(2, .02, .36);
  for (let tick = 1; tick <= 90; tick++) {
    setVehicleColliders(world, tick, [hull(VEHICLE.JEEP, { x: tick / 60, vx: 1 })]);
    stepMove(world, standing, cmd, 1 / 60, tick);
    stepMove(world, front, cmd, 1 / 60, tick);
    assert.ok(clear(world, standing) > -.025);
    assert.ok(clear(world, front) > -.025);
  }
  assert.ok(Math.abs(standing.px - 1.5) < .08 && standing.grounded, `roof carry ${standing.px},${standing.py}`);
  assert.ok(front.px > 2.8, `moving side failed to push: ${front.px}`);
});

test('swimming collides with a gunboat hull', () => {
  const world = vehicleCollisionWorld(undefined, -10), s = state(0, 0, 9);
  world.liquidAt = (_x, y) => y < 2 ? { kind: 'water', surfaceY: 2, bottomY: -10,
    flowX: 0, flowZ: 0, distance: -100, id: 1 } : undefined;
  setVehicleColliders(world, 0, [hull(VEHICLE.GUNBOAT)]);
  run(world, s, 10);
  assert.equal(s.swimming, true, 'approach uses the fluid movement branch');
  run(world, s, 240);
  assert.ok(s.pz > 4.7 || s.py >= 1.47, `swimmer crossed hull without climbing onto deck: ${s.pz},${s.py}`);
  assert.ok(clear(world, s) > -.025);
});

test('full aircraft rotation is used and crescent wing bays remain open', () => {
  const world = vehicleCollisionWorld(undefined, -100);
  const q = rotationFromEuler(.7, 1.1, -.6), origin = { x: 1, y: 20, z: 2 };
  setVehicleColliders(world, 0, [hull(VEHICLE.JET, { ...origin, rotation: q })]);
  const s = state(origin.x, origin.y, origin.z);
  withVehicleColliders(world, s, 1 / 60, () => {
    const p = rotateVector(q, 3, 1.14, .88);
    assert.ok(world.sdf(origin.x + p.x, origin.y + p.y, origin.z + p.z) < 0, 'rotated wing is solid');
    assert.ok(world.sdf(origin.x + 3, origin.y + 1.14, origin.z + .88) > .1, 'unrotated wing location remains open');
  });
  setVehicleColliders(world, 0, [hull(VEHICLE.JET, { variant: VEHICLE_VARIANT.NOCTURNE })]);
  withVehicleColliders(world, state(), 1 / 60, () => {
    assert.ok(world.sdf(6.6, 2.8, -3.3) > .5, 'open crescent bay is not a filled bounding box');
    assert.ok(world.sdf(0, 2.7, -1.2) < 0, 'central fuselage remains solid');
  });
});

test('vehicle union is isolated from ordinary traces, drivers, and nested placement scopes', () => {
  const world = vehicleCollisionWorld(), s = state();
  setVehicleColliders(world, 0, [hull()]);
  assert.equal(world.sdf(0, 1, 0), 1);
  assert.equal(world.trace(0, 1, 8, 0, 0, -1, 16).hit, false, 'ordinary weapon trace ignores pedestrian overlay');
  withVehicleColliders(world, s, 1 / 60, () => {
    assert.ok(world.sdf(0, 1, 0) < 0);
    assert.ok(world.sdfCol(0, 1, 0, world.column(0, 0), world.regionAt(0, 0)) < 0);
    const selection = world.pedestrianCollisions;
    assert.throws(() => withVehicleColliders(world, state(1000), 1 / 60, () => { throw new Error('fixture'); }));
    assert.equal(world.pedestrianCollisions, selection);
  });
  assert.equal(world.sdf(0, 1, 0), 1);
  const driver = state(0, 0, 0); driver.vehicle = VEHICLE.JEEP; driver.vehicleId = 1;
  run(world, driver, 60);
  assert.ok(driver.pz < -2, `own hull blocked driver: ${driver.pz}`);
  assert.equal(world.pedestrianCollisions, undefined);
});

test('ground vehicles stop at other hulls, never at their own, and report the crash', () => {
  for (const [type, radius] of [[VEHICLE.JEEP, 1.35], [VEHICLE.TANK, 1.9]] as const) {
    const world = vehicleCollisionWorld(), driver = state(0, 0, 0);
    driver.vehicle = type; driver.vehicleId = 1;
    // The parked tank's front track ends 2.33 m ahead of its origin.
    const front = -30 + 2.33;
    setVehicleColliders(world, 0, [hull(type, { id: 1 }), hull(VEHICLE.TANK, { id: 2, z: -30 })]);
    let impact = 0;
    for (let tick = 1; tick <= 300; tick++)
      impact = Math.max(impact, stepMove(world, driver, { ...cmd, buttons: BTN.FORWARD }, 1 / 60, tick).impact);
    // A sphere stops a jeep at the tank's flank; a taller tank may nose up
    // onto the low rear deck, but neither passes through.
    assert.ok(driver.pz > front && driver.pz < front + radius + .6, `${type}: stopped at ${driver.pz}, front ${front}`);
    if (type === VEHICLE.JEEP) assert.ok(impact > 10, `ramming at speed is a wall-like crash (${impact})`);
    assert.equal(world.pedestrianCollisions, undefined, 'the hull selection is scoped to the step');
  }
});

test('destruction, respawn, replacement and railway hulls leave no stale solid', () => {
  const world = vehicleCollisionWorld(), s = state();
  setVehicleColliders(world, 0, [hull()]);
  updateVehicleCollider(world, 1, hull(VEHICLE.JEEP, { health: 0 }));
  assert.equal(world.vehicleCollisions!.size, 0);
  setVehicleColliders(world, 2, [hull(VEHICLE.JEEP, { respawnAtTick: 300 })]);
  assert.equal(world.vehicleCollisions!.size, 0);
  setVehicleColliders(world, 2, [hull(VEHICLE.TANK, { variant: VEHICLE_VARIANT.RAIL })]);
  assert.equal(world.vehicleCollisions!.size, 0);
  setVehicleColliders(world, 2, [hull()]);
  setVehicleColliders(world, 3, []);
  assert.equal(world.vehicleCollisions!.size, 0);
  setVehicleColliders(world, 2, [hull()]); clearVehicleColliders(world);
  run(world, s);
  assert.ok(s.pz < -8);
});

test('poses are copied, extrapolation is capped, and probe work ignores remote hulls', () => {
  const world = vehicleCollisionWorld(), original = hull(VEHICLE.JEEP, { vx: 10 });
  setVehicleColliders(world, 10, [original, ...Array.from({ length: 600 }, (_, i) => hull(VEHICLE.JEEP,
    { id: i + 2, x: 1000 + i * 50 }))]);
  assert.equal(world.vehicleCollisions!.size, 512, 'hard bound on retained poses');
  updateVehicleCollider(world, 10, original);
  original.x = 500;
  const s = state(); s.simulationTick = 1000;
  withVehicleColliders(world, s, 1 / 60, () => {
    assert.equal(world.pedestrianCollisions!.hulls.length, 1, 'only nearby hull reaches each probe');
    assert.ok(world.sdf(1, 1, 0) < 0, 'velocity stopped after 100ms, immutable pose');
  });
});

test('invalid poses cannot poison the field and overlapping roof carry has stable ordering', () => {
  const world = vehicleCollisionWorld();
  setVehicleColliders(world, 0, [hull(VEHICLE.JEEP, { x: 1e308 }), hull(VEHICLE.JEEP, { id: 2, z: NaN })]);
  assert.equal(world.vehicleCollisions!.size, 0);
  const a = hull(VEHICLE.JEEP, { id: 7, pitch: NaN, roll: Infinity, vx: 1 });
  const b = hull(VEHICLE.JEEP, { id: 3, vx: -1 });
  const results: number[] = [];
  for (const poses of [[a, b], [b, a]]) {
    setVehicleColliders(world, 0, poses);
    const s = state(0, 2.075, .36); s.simulationTick = 1;
    withVehicleColliders(world, s, 1 / 60, () => {
      assert.ok(world.sdf(0, 1, 0) < 0);
      world.pedestrianCollisions!.carry(s);
    });
    results.push(s.px);
  }
  assert.deepEqual(results, [-1 / 60, -1 / 60]);
  assert.equal(world.vehicleCollisions!.select(state(1e308), 1 / 60, 1), undefined);
});

test('stationary hulls reuse prepared geometry while changed poses retain immutable earlier selections', () => {
  const world = vehicleCollisionWorld(), pose = hull(VEHICLE.TANK, { x: 12, z: 12 });
  setVehicleColliders(world, 1, [pose]);
  const field = world.vehicleCollisions!;
  const first = field.select(state(12, .02, 12), 1 / 60, 1)!;
  const original = first.hulls[0].hull;
  const inside = first.distance(12, 1, 12, Infinity);
  for (let tick = 2; tick < 100; tick++) {
    setVehicleColliders(world, tick, [{ ...pose, health: tick }]);
    const current = field.select(state(12, .02, 12), 1 / 60, tick)!;
    assert.equal(current.hulls[0].hull, original, 'unchanged parked hull avoids rebuild');
    assert.equal(current.distance(12, 1, 12, Infinity), inside);
  }
  updateVehicleCollider(world, 100, { ...pose, x: 15, heading: Math.PI / 2, vx: 3 });
  const moved = field.select(state(15, .02, 12), 1 / 60, 100)!;
  assert.notEqual(moved.hulls[0].hull, original, 'changes get a new immutable record');
  assert.equal(moved.hulls[0].hull.cells, original.cells, 'same grid coverage reuses membership keys');
  assert.equal(first.distance(12, 1, 12, Infinity), inside, 'prior selection keeps its old pose');
  assert.ok(moved.distance(12, 1, 12, Infinity) > .5, 'new orientation and position are applied');
  const beforeTick = moved.hulls[0].hull;
  updateVehicleCollider(world, 101, { ...pose, x: 15, heading: Math.PI / 2, vx: 3 });
  const nextTick = field.select(state(15, .02, 12), 1 / 60, 101)!;
  assert.notEqual(nextTick.hulls[0].hull, beforeTick, 'moving poses always refresh the extrapolation origin');
  assert.equal(nextTick.hulls[0].x, 15);
  assert.equal(nextTick.hulls[0].hull.cells, original.cells);
  updateVehicleCollider(world, 102, { ...pose, x: 100 });
  assert.equal(field.select(state(12, .02, 12), 1 / 60, 102), undefined, 'old cell membership is removed');
  assert.equal(field.select(state(100, .02, 12), 1 / 60, 102)!.hulls.length, 1);
});

test('reused poses preserve update eviction order, removal and changes to caller-owned rotation', () => {
  const world = vehicleCollisionWorld();
  const poses = Array.from({ length: 512 }, (_, i) => hull(VEHICLE.JEEP, { id: i + 1, x: i * 50 }));
  setVehicleColliders(world, 1, poses);
  updateVehicleCollider(world, 2, poses[0]);
  updateVehicleCollider(world, 2, hull(VEHICLE.JEEP, { id: 513, x: 25600 }));
  const field = world.vehicleCollisions!;
  assert.equal(field.size, 512);
  assert.equal(field.select(state(0), 1 / 60, 2)!.hulls[0].hull.id, 1, 'a reused pose is still most recently updated');
  assert.equal(field.select(state(50), 1 / 60, 2), undefined, 'the next oldest pose is evicted');
  updateVehicleCollider(world, 3, { ...poses[0], health: 0 });
  assert.equal(field.select(state(0), 1 / 60, 3), undefined, 'reused hulls still remove immediately');
  const rotation = rotationFromEuler(0), pose = hull(VEHICLE.TANK, { rotation });
  setVehicleColliders(world, 4, [pose]);
  const first = field.select(state(), 1 / 60, 4)!, before = first.distance(0, 1, 2, Infinity);
  Object.assign(rotation, rotationFromEuler(Math.PI / 2));
  updateVehicleCollider(world, 5, pose);
  const changed = field.select(state(), 1 / 60, 5)!;
  assert.ok(before < 0 && changed.distance(0, 1, 2, Infinity) > 0, 'rotation changes are copied and re-prepared');
  assert.equal(first.distance(0, 1, 2, Infinity), before, 'caller mutation cannot alter an earlier selection');
  setVehicleColliders(world, 6, [pose]);
  assert.equal(field.select(state(), 1 / 60, 6)!.hulls[0].hull, changed.hulls[0].hull);
});

test('incremental hull updates give exactly the same distances and carry as fresh field preparation', () => {
  const incremental = new VehicleCollisionField();
  const variants = [[VEHICLE.JEEP, 0], [VEHICLE.TANK, 0], [VEHICLE.TANK, VEHICLE_VARIANT.BASTION],
    [VEHICLE.JET, 0], [VEHICLE.JET, VEHICLE_VARIANT.NOCTURNE], [VEHICLE.GUNBOAT, 0]];
  for (let tick = 1; tick <= 60; tick++) {
    const phase = Math.floor(tick / 5);
    const poses = variants.map(([type, variant], i) => hull(type, { id: i, variant,
      x: i * 100 + phase * 2, z: phase % 3, heading: phase * .1,
      rotation: i === 3 ? rotationFromEuler(phase * .1, .3, -.2) : undefined,
      vx: phase % 2 ? i : 0, health: (phase + i) % 7 ? 100 : 0 }));
    incremental.replace(tick, poses);
    const fresh = new VehicleCollisionField(); fresh.replace(tick, poses);
    for (const pose of poses) for (const delay of [-2, 0, 3, 20]) {
      const foot = state(pose.x, 2.075, pose.z + .36);
      const actual = incremental.select(foot, 1 / 60, tick + delay);
      const expected = fresh.select(foot, 1 / 60, tick + delay);
      assert.equal(!!actual, !!expected);
      if (!actual || !expected) continue;
      for (let x = -3; x <= 3; x += 1.5) for (let z = -3; z <= 3; z += 1.5) {
        const px = pose.x + x, py = 1 + Math.abs(x * .5), pz = pose.z + z;
        assert.equal(actual.distance(px, py, pz, Infinity), expected.distance(px, py, pz, Infinity));
      }
      const carried = { ...foot }, freshCarried = { ...foot };
      actual.carry(carried); expected.carry(freshCarried);
      assert.deepEqual(carried, freshCarried);
    }
  }
});
