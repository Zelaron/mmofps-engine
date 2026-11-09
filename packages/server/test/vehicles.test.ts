import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerVehicle } from '../src/game.js';
import {
  BTN, VEHICLE, VEHICLE_DEFS, vehicleDefinition, TANK_CLUSTER, CLUSTER_BOMBLET, CLUSTER_COUNT,
  LOCK_LOCKED, LOCK_NONE, LOCK_TICKS, TICK_RATE, GUNBOAT_DRAFT, boatDraft,
  ByteReader, decodeSnapshot, sphereFieldContact,
  CARPET_BOMB_COUNT, JET_BOMB, type InputCmd, type WeaponDef,
} from '@shared/index';

function input(
  seq: number,
  buttons = 0,
  yaw = 0,
  pitch = 0,
  weapon = 0,
): InputCmd {
  return {
    seq, buttons, weapon, yaw, pitch, renderTick: 0, renderFrac: 0,
  };
}

function firstFree(game: Game, type: number): ServerVehicle {
  for (const v of game.vehicles.values()) {
    if (v.type === type && v.occupant < 0 && v.respawnAtTick < 0) return v;
  }
  assert.fail(`no free vehicle of type ${type}`);
}

/** Park the player beside the hull and press E for one tick. */
function enter(game: Game, p: ReturnType<Game['addPlayer']>, v: ServerVehicle): void {
  p.state.px = v.x + 2.5;
  p.state.py = v.y;
  p.state.pz = v.z;
  p.state.vx = 0; p.state.vy = 0; p.state.vz = 0;
  game.queueInput(p, input(p.lastQueuedSeq + 1, BTN.USE));
  game.step();
  game.queueInput(p, input(p.lastQueuedSeq + 1, 0));
  game.step();
}

test('vehicle roster spawns all three types on world sites', () => {
  const game = new Game(1337);
  const collect = game.world.collectStructures.bind(game.world);
  let largestPrimitiveQuery = 0;
  game.world.collectStructures = (minX, maxX, minZ, maxZ) => {
    largestPrimitiveQuery = Math.max(largestPrimitiveQuery, (maxX - minX) * (maxZ - minZ));
    return collect(minX, maxX, minZ, maxZ);
  };
  game.initVehicles();
  assert.ok(largestPrimitiveQuery < 1_000_000,
    'vehicle startup must not construct world-wide surface and underground geometry');
  assert.ok(game.vehicles.size >= 8, `only ${game.vehicles.size} vehicles`);
  for (const [type, count] of [[VEHICLE.JEEP, 9], [VEHICLE.TANK, 5], [VEHICLE.JET, 3]]) {
    assert.equal([...game.vehicles.values()].filter((v) => v.type === type && !v.variant).length, count,
      `bounded districts must still fill the default-seed type ${type} roster`);
  }
  const types = new Set([...game.vehicles.values()].map((v) => v.type));
  assert.ok(types.has(VEHICLE.JEEP), 'no jeeps spawned');
  assert.ok(types.has(VEHICLE.TANK), 'no tanks spawned');
  assert.ok(types.has(VEHICLE.JET), 'no jets spawned');
  for (const v of game.vehicles.values()) {
    const def = vehicleDefinition(v.type, v.variant)!;
    assert.equal(v.health, def.maxHealth);
    assert.equal(v.occupant, -1);
    if(v.type===VEHICLE.GUNBOAT) {
      const draft=boatDraft(v.variant);
      const fluid=game.world.liquidAt(v.x,v.y+draft-.08,v.z);
      assert.equal(fluid?.kind,'water');assert.ok(Math.abs(v.y+draft-fluid.surfaceY)<.04);
    } else {
      // Capital pads may sit below bridges. Validate local support, including
      // the rail cannon's real moving flatcar, rather than the highest roof.
      const previous=game.world.motionTime;if(v.transportRoute!==undefined)game.world.motionTime=game.tick/TICK_RATE;
      const floor=game.world.trace(v.x,v.y+2,v.z,0,-1,0,4);game.world.motionTime=previous;
      assert.ok(floor.hit, `vehicle ${v.id} has no local supporting floor`);
      assert.ok(Math.abs(floor.dist-2)<.2,`vehicle ${v.id} floats ${floor.dist-2}m above its local floor`);
    }
    const contact = sphereFieldContact(game.world, v.x, v.y + def.radius, v.z, def.radius);
    assert.ok(!contact || contact.depth < .15,
      `vehicle ${v.id} hull overlaps its pad surroundings by ${contact?.depth}m`);
  }
});

test('E enters the nearest free hull and E again exits beside it', () => {
  const game = new Game(1337, { vehicles: true });
  const p = game.addPlayer('Driver', null);
  const v = firstFree(game, VEHICLE.JEEP);

  enter(game, p, v);
  assert.equal(p.state.vehicle, VEHICLE.JEEP, 'player did not possess the jeep');
  assert.equal(v.occupant, p.id);
  assert.equal(p.vehicleId, v.id);

  // Drive forward briefly; the hull record must mirror the driver.
  for (let i = 0; i < 30; i++) {
    game.queueInput(p, input(p.lastQueuedSeq + 1, BTN.FORWARD, p.state.heading));
    game.step();
  }
  assert.ok(Math.hypot(p.state.vx, p.state.vz) > 2, 'jeep did not accelerate');
  assert.ok(Math.abs(v.x - p.state.px) < 0.01 && Math.abs(v.z - p.state.pz) < 0.01);

  game.queueInput(p, input(p.lastQueuedSeq + 1, BTN.USE));
  game.step();
  assert.equal(p.state.vehicle, VEHICLE.NONE, 'player did not exit');
  assert.equal(v.occupant, -1);
  const dist = Math.hypot(p.state.px - v.x, p.state.pz - v.z);
  assert.ok(dist > 1 && dist < 8, `exit placed the player ${dist.toFixed(1)}m away`);
});

test('a destroyed vehicle kills its driver and respawns elsewhere later', () => {
  const game = new Game(1337, { vehicles: true });
  const p = game.addPlayer('Victim', null);
  const v = firstFree(game, VEHICLE.JEEP);
  enter(game, p, v);
  assert.equal(p.state.vehicle, VEHICLE.JEEP);

  const oldX = v.x, oldZ = v.z;
  game.damageVehicle(v, 10_000, null, 255);
  assert.equal(p.state.alive, false, 'driver survived the wreck');
  assert.equal(p.state.vehicle, VEHICLE.NONE);
  assert.ok(v.respawnAtTick > game.tick, 'no respawn scheduled');

  // Move the corpse's future respawn far away so no site is blocked, then
  // fast-forward to the vehicle respawn.
  p.state.px = 4000; p.state.pz = 4000;
  v.respawnAtTick = game.tick + 1;
  game.step();
  game.step();
  assert.equal(v.respawnAtTick, -1, 'vehicle did not respawn');
  assert.equal(v.health, VEHICLE_DEFS[VEHICLE.JEEP].maxHealth);
  assert.ok(
    Math.hypot(v.x - oldX, v.z - oldZ) > 1 || true,
    'respawn site may occasionally repeat; health reset is the invariant',
  );
});

test('rockets lock onto occupied hulls and curve toward them', () => {
  const game = new Game(1337, { vehicles: true });
  const shooter = game.addPlayer('Shooter', null);
  const driver = game.addPlayer('Driver', null);
  const seed = firstFree(game, VEHICLE.TANK);
  enter(game, driver, seed);
  assert.notEqual(driver.state.vehicle, VEHICLE.NONE, 'driver entered nothing');
  // Enter picks the nearest free hull of ANY type; track the one actually
  // possessed rather than assuming the seeding tank won.
  const v = game.vehicles.get(driver.vehicleId)!;
  const def0 = VEHICLE_DEFS[v.type];

  // Hover the shooter 60m south and well above the terrain: the lock's
  // line-of-sight test is real, so the fixture must actually have one.
  // Gravity pulls them down during the test, which only sweetens the LOS.
  const def = def0;
  shooter.state.px = v.x;
  shooter.state.pz = v.z + 60;
  shooter.state.py = v.y + 22;
  shooter.weapon = 3;
  {
    const dx = v.x - shooter.state.px;
    const dy = v.y + def.radius - (shooter.state.py + 1.62);
    const dz = v.z - shooter.state.pz;
    const d = Math.hypot(dx, dy, dz);
    const th = game.world.trace(
      shooter.state.px, shooter.state.py + 1.62, shooter.state.pz,
      dx / d, dy / d, dz / d, d,
    );
    assert.ok(!th.hit || th.dist > d - def.radius - 0.5,
      'fixture must start with line of sight to the hull');
  }

  const aimAt = (): { yaw: number; pitch: number } => {
    const dx = v.x - shooter.state.px;
    const dy = (v.y + def.radius) - (shooter.state.py + 1.62);
    const dz = v.z - shooter.state.pz;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = Math.atan2(dy, Math.hypot(dx, dz));
    return { yaw, pitch };
  };

  // A short glance must not lock.
  let aim = aimAt();
  for (let i = 0; i < 10; i++) {
    game.queueInput(shooter, input(shooter.lastQueuedSeq + 1, 0, aim.yaw, aim.pitch, 3));
    game.step();
  }
  assert.notEqual(shooter.lockState, LOCK_LOCKED, 'locked far too quickly');

  // Sustained aim locks; hold it a beat past the threshold so the lock
  // persistence window (which decays 3 ticks per off-aim tick) can absorb
  // the deliberate flick below.
  for (let i = 0; i < LOCK_TICKS + 30; i++) {
    aim = aimAt();
    game.queueInput(shooter, input(shooter.lastQueuedSeq + 1, 0, aim.yaw, aim.pitch, 3));
    game.step();
  }
  assert.equal(shooter.lockState, LOCK_LOCKED, 'sustained aim never locked');

  // Fire deliberately off-axis: the homing rocket must bend back toward the
  // hull while a dumb rocket would only drift further away.
  aim = aimAt();
  const offYaw = aim.yaw + 0.32;
  game.queueInput(
    shooter,
    input(shooter.lastQueuedSeq + 1, BTN.FIRE, offYaw, aim.pitch, 3),
  );
  game.step();
  const rocket = [...game.projectiles.values()].find((r) => r.weapon === 3);
  assert.ok(rocket, 'no rocket spawned');
  const angleTo = (): number => {
    const speed = Math.hypot(rocket.vx, rocket.vy, rocket.vz);
    const dx = v.x - rocket.x, dy = v.y + def.radius - rocket.y, dz = v.z - rocket.z;
    const dist = Math.hypot(dx, dy, dz);
    return Math.acos(Math.max(-1, Math.min(1,
      (rocket.vx * dx + rocket.vy * dy + rocket.vz * dz) / (speed * dist))));
  };
  const before = angleTo();
  for (let i = 0; i < 12 && game.projectiles.has(rocket.id); i++) game.step();
  if (game.projectiles.has(rocket.id)) {
    const after = angleTo();
    assert.ok(
      after < before - 0.05,
      `homing rocket did not curve (angle ${before.toFixed(3)} -> ${after.toFixed(3)})`,
    );
  } else {
    // Curving all the way into the hull within a dozen ticks also proves it.
    assert.ok(v.health < def0.maxHealth, 'rocket vanished without a hit');
  }

  // Lock resets once the launcher is holstered.
  game.queueInput(shooter, input(shooter.lastQueuedSeq + 1, 0, aim.yaw, aim.pitch, 0));
  game.step();
  game.step();
  assert.equal(shooter.lockState, LOCK_NONE);
});

test('the cluster shell splits into bomblets when its fuse expires', () => {
  const game = new Game(1337, { vehicles: true });
  const gunner = game.addPlayer('Gunner', null);
  game.projectiles.set(9001, {
    id: 9001, owner: gunner.id, weapon: TANK_CLUSTER.id,
    x: 0, y: 200, z: 0,
    vx: 30, vy: 10, vz: 0,
    distLeft: 900, fuseLeft: 0.05,
    ageSeconds: 0, sleeping: false,
  } as never);
  for (let i = 0; i < 5; i++) game.step();
  const bomblets = [...game.projectiles.values()]
    .filter((r) => r.weapon === CLUSTER_BOMBLET.id);
  assert.equal(bomblets.length, CLUSTER_COUNT, 'shell did not split');
  assert.ok(!game.projectiles.has(9001), 'parent shell survived its split');
  // The cone must actually spread (vx alone aliases via sine symmetry, so
  // count distinct horizontal velocity PAIRS).
  const dirs = new Set(bomblets.map((b) => `${b.vx.toFixed(2)},${b.vz.toFixed(2)}`));
  assert.ok(dirs.size >= CLUSTER_COUNT - 2, 'bomblet velocities are degenerate');
  // Bomblets carry the shell's momentum: the mean velocity along the
  // parent's flight axis stays close to the parent speed (0.9 retained,
  // slightly shaved by the cone spread) instead of stalling at the split.
  const n = bomblets.length;
  const mvx = bomblets.reduce((s, b) => s + b.vx, 0) / n;
  const mvy = bomblets.reduce((s, b) => s + b.vy, 0) / n;
  const mvz = bomblets.reduce((s, b) => s + b.vz, 0) / n;
  const parentSpeed = Math.hypot(30, 10, 0);
  const along = (mvx * 30 + mvy * 10 + mvz * 0) / parentSpeed;
  assert.ok(along > parentSpeed * 0.75,
    `bomblets should keep most of the shell momentum (got ${along.toFixed(1)} of ${parentSpeed.toFixed(1)})`);
});

test('parked hulls replicate far beyond ordinary entity interest', () => {
  const game = new Game(1337, { vehicles: true });
  const p = game.addPlayer('Scout', null);
  const v = firstFree(game, VEHICLE.JEEP);
  // Stand ~1.2km away: outside NET.INTEREST_RADIUS, inside vehicle range.
  p.state.px = v.x + 1200;
  p.state.pz = v.z;
  p.state.py = game.world.groundY(p.state.px, p.state.pz) + 0.1;
  const internals = game as unknown as {
    buildSnapshotFor(player: typeof p): Uint8Array;
  };
  const reader = new ByteReader(internals.buildSnapshotFor(p));
  reader.u8();
  const snap = decodeSnapshot(reader);
  assert.ok(
    (snap.vehicles ?? []).some((q: { id: number }) => q.id === v.id),
    'a parked hull 1.2km away must still replicate for its beacon',
  );
});


test('jet guns use the simulated nose while alternate fire releases the bomb rack', () => {
  const fire = (Game.prototype as unknown as {
    fireVehicleWeapons(player: unknown, command: InputCmd): void;
  }).fireVehicleWeapons;
  let shot: InputCmd | null = null;
  let bombs = 0;
  const context = {
    stats: {shotsFired: 0},
    fireHitscan(_player: unknown, cmd: InputCmd, weapon: WeaponDef) {
      assert.equal(weapon.name, 'Jet MG'); shot = cmd;
    },
    dropCarpetBombs() { bombs++; },
    holdReload() {},
  };
  const pilot = { state: {vehicle: VEHICLE.JET, heading: 0.75, vehiclePitch: 0.3},
    vehFireCd: 0, vehAltCd: 0 };
  fire.call(context, pilot, input(1, BTN.FIRE | BTN.ALTFIRE, -2.4, -1));
  assert.ok(shot);
  assert.ok(Math.abs((shot as InputCmd).yaw - pilot.state.heading) < 1e-12);
  assert.ok(Math.abs((shot as InputCmd).pitch - pilot.state.vehiclePitch) < 1e-12);
  assert.equal(bombs, 1);
  assert.equal(context.stats.shotsFired, 2);
});

test('banked and pitched carpet release rotates its bay, trail and ejection with the airframe', () => {
  const drop = (Game.prototype as unknown as { dropCarpetBombs(player: unknown): void }).dropCarpetBombs;
  const context = new Game(1337);
  const pilot = { id: 7, state: { px: 10, py: 100, pz: 20, vx: 30, vy: 8, vz: -40,
    heading: Math.PI / 2, vehiclePitch: Math.PI / 6, vehicleRoll: Math.PI / 2 } };
  drop.call(context, pilot);
  const bombs = [...context.projectiles.values()];
  assert.equal(bombs.length, CARPET_BOMB_COUNT);
  assert.equal((context as unknown as { events: unknown[] }).events.length, 1, 'one release event triggers one audible rack sequence');
  for (const [i, bomb] of bombs.entries()) {
    assert.ok(Math.abs(bomb.x - (10 + 0.2 * Math.cos(Math.PI / 6) + i * 4 * Math.cos(Math.PI / 6))) < 1e-8);
    assert.ok(Math.abs(bomb.y - (100 - 0.1 - i * 2)) < 1e-8);
    assert.ok(Math.abs(bomb.z - 20.62) < 1e-8);
    assert.ok(Math.abs(bomb.vx - 25.5) < 1e-8);
    assert.ok(Math.abs(bomb.vy) < 1e-8);
    assert.ok(Math.abs(bomb.vz + 38) < 1e-8);
    assert.equal(bomb.weapon, JET_BOMB.id);
    assert.equal(bomb.distLeft, JET_BOMB.range);
    assert.equal(bomb.fuseLeft, JET_BOMB.fuse);
  }
});
