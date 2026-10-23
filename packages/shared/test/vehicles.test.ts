import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  World, WORLD, TICK_DT, BTN,
  createMoveState, stepMove,
  VEHICLE, VEHICLE_DEFS, weaponDefById, WEAPONS,
  JEEP_MG, TANK_CANNON, TANK_CLUSTER, JET_BOMB,
  JET_TAKEOFF_SPEED, STRUCTURE_KIND,
  type InputCmd, type MoveState,
} from '@shared/index';
import { cavePathPoint } from '@shared/worldgen';

/** Center of the first runway strip - guaranteed long flat ground. */
function findRunway(world: World): { x: number; z: number; heading: number } {
  const region = world.collectStructures(-3200, 3200, -3200, 3200);
  for (const site of region.sites) {
    if (site.kind !== STRUCTURE_KIND.RUNWAY) continue;
    return {
      x: site.x,
      z: site.z,
      heading: site.hx >= site.hz ? -Math.PI / 2 : 0,
    };
  }
  assert.fail('seed 1337 must generate at least one runway');
}

function cmd(buttons: number, yaw = 0, pitch = 0): InputCmd {
  return {
    seq: 0, buttons, weapon: 0, yaw, pitch, renderTick: 0, renderFrac: 0,
  };
}

function spawnDriver(world: World, type: number): MoveState {
  const strip = findRunway(world);
  // Start at the threshold so the full strip lies ahead of the hull.
  const fx = -Math.sin(strip.heading);
  const fz = -Math.cos(strip.heading);
  const x = strip.x - fx * 35;
  const z = strip.z - fz * 35;
  const s = createMoveState(x, world.groundY(x, z) + 0.2, z);
  s.vehicle = type;
  s.heading = strip.heading;
  return s;
}

test('vehicle ids resolve through weaponDefById without disturbing slots', () => {
  for (let i = 0; i < WEAPONS.length; i++) {
    assert.equal(weaponDefById(i), WEAPONS[i]);
  }
  assert.equal(weaponDefById(JEEP_MG.id), JEEP_MG);
  assert.equal(weaponDefById(TANK_CANNON.id), TANK_CANNON);
  assert.equal(weaponDefById(TANK_CLUSTER.id), TANK_CLUSTER);
  assert.equal(weaponDefById(JET_BOMB.id), JET_BOMB);
  assert.equal(weaponDefById(199), undefined);
});

test('vehicle simulation is deterministic and stays above terrain', () => {
  const run = (): MoveState => {
    const world = new World(1337);
    const s = spawnDriver(world, VEHICLE.JEEP);
    for (let t = 0; t < 60 * 8; t++) {
      const steer = t % 240 < 120 ? BTN.LEFT : BTN.RIGHT;
      stepMove(world, s, cmd(BTN.FORWARD | steer | (t % 300 > 200 ? BTN.ALTFIRE : 0)), TICK_DT);
    }
    return s;
  };
  const a = run();
  const b = run();
  assert.deepEqual(a, b, 'two identical drives must match bit-for-bit');

  const world = new World(1337);
  const gy = world.groundY(a.px, a.pz);
  assert.ok(
    a.py > gy - VEHICLE_DEFS[VEHICLE.JEEP].radius - 0.5,
    `jeep sank into terrain: y=${a.py.toFixed(2)} ground=${gy.toFixed(2)}`,
  );
  const dist = Math.hypot(a.px, a.pz);
  assert.ok(Number.isFinite(dist));
});

test('jeep boost drains fuel and raises top speed on open ground', () => {
  const world = new World(1337);
  const s = spawnDriver(world, VEHICLE.JEEP);
  // Cruise straight to measure speed, staying on the strip throughout.
  for (let t = 0; t < 60 * 2; t++) {
    stepMove(world, s, cmd(BTN.FORWARD, s.heading), TICK_DT);
  }
  const cruise = Math.hypot(s.vx, s.vz);
  const fuelBefore = s.boostFuel;
  let peak = 0;
  for (let t = 0; t < 180; t++) {
    stepMove(world, s, cmd(BTN.FORWARD | BTN.ALTFIRE, s.heading), TICK_DT);
    peak = Math.max(peak, Math.hypot(s.vx, s.vz));
  }
  assert.ok(s.boostFuel < fuelBefore - 0.18, 'boost must drain fuel');
  assert.ok(
    peak > cruise + 25,
    `boost peak ${peak.toFixed(1)} did not dwarf cruise ${cruise.toFixed(1)}`,
  );
  assert.ok(peak <= 83, `boost speed ${peak.toFixed(1)} exceeded its cap`);
});

test('a jet must roll to takeoff speed before it can climb', () => {
  const world = new World(1337);
  const s = spawnDriver(world, VEHICLE.JET);
  const startY = s.py;

  // Full throttle with the stick hauled back from a standstill: below the
  // takeoff speed the nose stays down and no altitude is gained.
  for (let t = 0; t < 30; t++) {
    stepMove(world, s, cmd(BTN.THROTTLE | BTN.BACK, s.heading, -1.0), TICK_DT);
  }
  assert.ok(
    s.py < startY + 1.5,
    `jet ballooned before reaching takeoff speed (dy=${(s.py - startY).toFixed(2)})`,
  );

  // Keep rolling; once past takeoff speed the same input climbs for real.
  let climbed = false;
  for (let t = 0; t < 60 * 10 && !climbed; t++) {
    stepMove(world, s, cmd(BTN.THROTTLE | BTN.BACK, s.heading, -0.5), TICK_DT);
    const speed = Math.hypot(s.vx, s.vy, s.vz);
    if (speed > JET_TAKEOFF_SPEED && s.py > startY + 12) climbed = true;
  }
  assert.ok(climbed, 'jet never became airborne on open ground');
});

test('driving off a drop falls ballistically instead of floating', () => {
  const world = new World(1337);
  const s = spawnDriver(world, VEHICLE.JEEP);
  s.py += 30; // launched off a cliff, dead air below
  s.vx = -Math.sin(s.heading) * 12;
  s.vz = -Math.cos(s.heading) * 12;
  const startY = s.py;
  for (let t = 0; t < 60; t++) {
    stepMove(world, s, cmd(BTN.FORWARD), TICK_DT);
  }
  // One second of free fall is ~8m at the softened airborne gravity (16);
  // the float bug managed centimeters.
  assert.ok(
    startY - s.py > 6.5,
    `airborne jeep barely fell (dy=${(startY - s.py).toFixed(2)}m in 1s)`,
  );
  assert.ok(s.vy < -12, `fall never accelerated (vy=${s.vy.toFixed(1)})`);
});

test('hulls fall through cave mouths instead of hovering on carved air', () => {
  const world = new World(1337);
  // The removed nominal surface still creates a small positive field
  // minimum. Find clear columns inside real gallery mouths, so this hull
  // regression remains valid when procedural site positions change.
  const mouths = world.collectCaveSites(-960, 960, -960, 960)
    .map((site) => cavePathPoint(site, site.mouthLength - 5))
    .filter(({ x, y, z }) => world.terrainHeight(x, z) - y > 8)
    .slice(0, 2);
  assert.equal(mouths.length, 2, 'need two deep open-mouth witnesses');
  for (const { x, z } of mouths) {
    const h = world.column(x, z).h;
    const floor = world.groundY(x, z);
    assert.ok(floor < h - 8, 'fixture must be open below the removed surface');
    const s = createMoveState(x, h + 5, z);
    s.vehicle = VEHICLE.JEEP;
    for (let t = 0; t < 60 * 6; t++) stepMove(world, s, cmd(0), TICK_DT);
    assert.ok(
      s.py < floor + 3,
      `jeep hovered at ${s.py.toFixed(2)} over a floor at ${floor.toFixed(2)}`,
    );
    // The rounded hull can roll several metres down the graded mouth
    // before settling. Its original column is no longer its landing floor;
    // groundY at the new XZ can also return the gallery's roof overhead.
    const landing = world.column(s.px, s.pz).cave;
    assert.ok(landing, 'the dropped hull must remain in its gallery');
    assert.ok(world.sdf(s.px, landing.floor - .1, s.pz) < 0, 'landing floor must remain solid');
    assert.ok(s.grounded, 'the hull must settle on the actual gallery grade');
    assert.ok(s.py > landing.floor - .25 && s.py < landing.floor + .75,
      `jeep at ${s.py.toFixed(2)} must rest on its current floor ${landing.floor.toFixed(2)}`);
  }
});

test('ground hulls shrug off landings but still crash into walls', () => {
  const world = new World(1337);

  // Hard flat landing: 20m drop onto the runway. Wheels cushion it - the
  // reported crash impact must stay zero however fast it comes down.
  const s = spawnDriver(world, VEHICLE.JEEP);
  s.py += 20;
  let landingImpact = 0;
  for (let t = 0; t < 60 * 3; t++) {
    const res = stepMove(world, s, cmd(0), TICK_DT);
    landingImpact = Math.max(landingImpact, res.impact);
  }
  assert.ok(s.grounded, 'jeep must have landed');
  assert.ok(
    landingImpact < 1,
    `flat landing reported a crash impact of ${landingImpact.toFixed(1)}`,
  );

  // Ramming the border wall mid-air: a steep-normal contact is a crash.
  const w = createMoveState(WORLD.BORDER - 40, 150, 0);
  w.vehicle = VEHICLE.JEEP;
  w.heading = -Math.PI / 2; // facing +x
  w.vx = 40;
  let wallImpact = 0;
  for (let t = 0; t < 90; t++) {
    const res = stepMove(world, w, cmd(0), TICK_DT);
    wallImpact = Math.max(wallImpact, res.impact);
  }
  assert.ok(
    wallImpact > 10,
    `border-wall ram only reported ${wallImpact.toFixed(1)} impact`,
  );
});

test('a boosting jeep launches off a ramp lip with real upward inertia', () => {
  const world = new World(1337);
  // A supported convex hillside, independent of evolving procedural roads,
  // station foundations or lake banks at a once-suitable seed coordinate.
  // Both slopes stay inside the canonical field's ordinary terrain envelope.
  const height = (z: number) => Math.max(0, z >= 0 ? 24 - z * .34 : 24 + z * .3);
  const slope = (z: number) => height(z) <= 0 ? 0 : z >= 0 ? -.34 : .3;
  world.sdf = (_x, y, z) => (y - height(z)) / Math.hypot(1, slope(z));
  world.sdfCol = (x, y, z) => world.sdf(x, y, z);
  world.groundY = (_x, z) => height(z);
  world.liquidAt = () => undefined;
  world.collectCityLifts = () => [];
  world.collectTransportPlan = () => ({ routes: [], stations: [], harbors: [], pods: [], lifts: [], solids: [], bridges: [], accesses: [] });
  world.gradient = (_x, _y, z, out) => { const n = Math.hypot(1, slope(z)); out.x = 0; out.y = 1 / n; out.z = -slope(z) / n; };
  const x = 0, sz = 70;
  const s = createMoveState(x, world.groundY(x, sz) + 0.2, sz);
  s.vehicle = VEHICLE.JEEP;
  s.heading = 0; // driving -z
  let maxVy = 0;
  let maxClear = 0;
  for (let t = 0; t < 60 * 8; t++) {
    stepMove(world, s, cmd(BTN.FORWARD | BTN.ALTFIRE), TICK_DT);
    maxVy = Math.max(maxVy, s.vy);
    maxClear = Math.max(maxClear, s.py - world.groundY(s.px, s.pz));
  }
  assert.ok(maxVy > 6, `never launched upward (peak vy ${maxVy.toFixed(1)})`);
  assert.ok(maxClear > 2, `never left the ground (peak clearance ${maxClear.toFixed(1)}m)`);
});

test('A/D steer the hull; the mouse only aims', () => {
  const world = new World(1337);
  const s = spawnDriver(world, VEHICLE.JEEP);
  // Cruise with the camera yanked 90 degrees sideways: heading must hold.
  const before = s.heading;
  for (let t = 0; t < 90; t++) {
    stepMove(world, s, cmd(BTN.FORWARD, s.heading + Math.PI / 2), TICK_DT);
  }
  assert.equal(s.heading, before, 'free look must not steer the hull');

  // Now hold A: the hull yaws left (positive) regardless of aim.
  for (let t = 0; t < 45; t++) {
    stepMove(world, s, cmd(BTN.FORWARD | BTN.LEFT, s.heading - 1), TICK_DT);
  }
  let turned = s.heading - before;
  while (turned > Math.PI) turned -= 2 * Math.PI;
  while (turned < -Math.PI) turned += 2 * Math.PI;
  assert.ok(turned > 0.5, `holding A only turned ${turned.toFixed(3)} rad`);
});

test('airborne hulls retain reduced steering instead of bricking', () => {
  const world = new World(1337);
  // A jeep launched off a crest: 20m up, moving fast along +heading.
  const s = spawnDriver(world, VEHICLE.JEEP);
  s.py += 20;
  s.vx = -Math.sin(s.heading) * 20;
  s.vz = -Math.cos(s.heading) * 20;
  const dirBefore = Math.atan2(-s.vx, -s.vz);
  for (let t = 0; t < 45; t++) {
    stepMove(world, s, cmd(BTN.FORWARD | BTN.LEFT), TICK_DT);
    if (s.grounded) break; // landed early on a hill - enough airtime either way
  }
  const dirAfter = Math.atan2(-s.vx, -s.vz);
  let turned = dirAfter - dirBefore;
  while (turned > Math.PI) turned -= 2 * Math.PI;
  while (turned < -Math.PI) turned += 2 * Math.PI;
  assert.ok(
    Math.abs(turned) > 0.12,
    `airborne jeep velocity never followed the wheel (turned ${turned.toFixed(3)} rad)`,
  );

  // A slow airborne jet must also answer the stick (glide steering).
  const j = spawnDriver(world, VEHICLE.JET);
  j.py += 40;
  j.vx = -Math.sin(j.heading) * 10;
  j.vz = -Math.cos(j.heading) * 10;
  const jTarget = j.heading + Math.PI / 2;
  const jBefore = Math.atan2(-j.vx, -j.vz);
  for (let t = 0; t < 60; t++) {
    stepMove(world, j, cmd(BTN.THROTTLE | BTN.LEFT | BTN.BACK, jTarget, -0.4), TICK_DT);
  }
  const jAfter = Math.atan2(-j.vx, -j.vz);
  let jTurned = jAfter - jBefore;
  while (jTurned > Math.PI) jTurned -= 2 * Math.PI;
  while (jTurned < -Math.PI) jTurned += 2 * Math.PI;
  assert.ok(
    Math.abs(jTurned) > 0.3,
    `below-stall airborne jet ignored the stick (turned ${jTurned.toFixed(3)} rad)`,
  );
});

test('the H hyperspeed cheat multiplies on-foot run speed', () => {
  const world = new World(1337);
  const strip = findRunway(world);
  const run = (buttons: number): number => {
    const fx = -Math.sin(strip.heading), fz = -Math.cos(strip.heading);
    const x = strip.x - fx * 35, z = strip.z - fz * 35;
    const s = createMoveState(
      x, world.groundY(x, z) + 0.2, z,
    );
    s.grounded = true;
    // At hyperspeed 1.5 seconds runs beyond the entire runway. Measure
    // acceleration and top speed while both players remain on its surface.
    for (let t = 0; t < 45; t++) {
      stepMove(world, s, cmd(buttons, strip.heading), TICK_DT);
    }
    assert.ok(Math.hypot(s.px - strip.x, s.pz - strip.z) < 40,
      'speed measurement must stay on the clear runway');
    return Math.hypot(s.vx, s.vz);
  };
  const normal = run(BTN.FORWARD);
  const hyper = run(BTN.FORWARD | BTN.HYPER);
  assert.ok(normal < 11, `normal run speed drifted (${normal.toFixed(1)})`);
  assert.ok(
    hyper > 55,
    `hyperspeed only reached ${hyper.toFixed(1)} m/s on the strip`,
  );
});


const FLAT_VEHICLE_WORLD = {
  sdf: (_x: number, y: number, _z: number) => y,
  gradient: (_x: number, _y: number, _z: number, out: {x: number; y: number; z: number}) => {
    out.x = 0; out.y = 1; out.z = 0;
  },
  groundY: () => 0,
} as unknown as World;

test('jet attitude ignores mouse movement and responds to bounded pitch/roll controls', () => {
  const make = () => { const s = createMoveState(0, 120, 0); s.vehicle = VEHICLE.JET; s.vz = -65; return s; };
  const straight = make(), looking = make();
  for (let t = 0; t < 60; t++) {
    stepMove(FLAT_VEHICLE_WORLD, straight, cmd(BTN.THROTTLE, 0, 0), TICK_DT);
    stepMove(FLAT_VEHICLE_WORLD, looking, cmd(BTN.THROTTLE, t % 2 ? 3.1 : -3.1, t % 2 ? 1.5 : -1.5), TICK_DT);
  }
  assert.deepEqual(looking, straight, 'free look cannot rotate or steer the aircraft');
  const climb = make(), dive = make(), bank = make();
  for (let t = 0; t < 30; t++) {
    stepMove(FLAT_VEHICLE_WORLD, climb, cmd(BTN.THROTTLE | BTN.BACK), TICK_DT);
    stepMove(FLAT_VEHICLE_WORLD, dive, cmd(BTN.THROTTLE | BTN.FORWARD), TICK_DT);
    const previous = bank.heading;
    stepMove(FLAT_VEHICLE_WORLD, bank, cmd(BTN.THROTTLE | BTN.LEFT), TICK_DT);
    assert.ok(Math.abs(bank.heading - previous) < 0.05, 'a banked turn must be rate-limited');
  }
  assert.ok(climb.vehiclePitch > 0.6 && climb.vy > 10, 'S pulls the nose up');
  assert.ok(dive.vehiclePitch < -0.6 && dive.vy < -10, 'W pushes the nose down');
  assert.ok(bank.vehicleRoll > 0.8 && bank.heading > 0.1, 'A rolls left into a gradual banked turn');
  const braking = make();
  for (let t = 0; t < 60; t++) stepMove(FLAT_VEHICLE_WORLD, braking, cmd(BTN.BRAKE), TICK_DT);
  assert.ok(Math.hypot(braking.vx, braking.vy, braking.vz) < 60, 'C reduces airspeed');
});

test('depleted boost cannot pulse back on until the boost control is released', () => {
  const s = createMoveState(0, 0.02, 0); s.vehicle = VEHICLE.JEEP; s.boostFuel = 0.025;
  const held = cmd(BTN.FORWARD | BTN.ALTFIRE);
  for (let t = 0; t < 15; t++) stepMove(FLAT_VEHICLE_WORLD, s, held, TICK_DT);
  assert.equal(s.boostFuel, 0);
  for (let t = 0; t < 240; t++) {
    stepMove(FLAT_VEHICLE_WORLD, s, held, TICK_DT);
    assert.equal(s.boosting, false, 'empty fuel must keep both propulsion and its turbo audio off');
    assert.equal(s.boostFuel, 0);
  }
  for (let t = 0; t < 120; t++) stepMove(FLAT_VEHICLE_WORLD, s, cmd(0), TICK_DT);
  assert.ok(s.boostFuel > 0.08, 'releasing the boost control recharges fuel');
  stepMove(FLAT_VEHICLE_WORLD, s, held, TICK_DT);
  assert.equal(s.boosting, true);
});
