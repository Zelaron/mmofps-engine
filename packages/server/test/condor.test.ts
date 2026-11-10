import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, PLAYER, VEHICLE, VEHICLE_VARIANT, WEAPONS, vehicleDefinition, CONDOR_BOMB, CONDOR_CARPET_COUNT,
  CONDOR_CARPET, CONDOR_CARPET_RIPPLE_TICKS, CONDOR_CARPET_ROWS, CONDOR_LOCK_ROCKET, CONDOR_MEGA_NUKE, CONDOR_STATION_CONE, CONDOR_STATIONS,
  LOCK_LOCKED, LOCK_TICKS, aircraftCrewMuzzle, condorStationAim, crewArmament, rotateVector, rotationFromEuler, vehicleEyeOffset, vehicleQuaternion, viewDir,
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
  pilot.vehicleId = bomber.id; pilot.vehFireCd = 0;
  bombing.queueInput(pilot, command(1, BTN.FIRE | BTN.THROTTLE)); bombing.step();
  const carpet = () => [...bombing.projectiles.values()].filter(r => r.weapon === CONDOR_CARPET.id);
  assert.equal(carpet().length, 3, 'one row leaves the bay at once');
  assert.deepEqual(carpet().map(r => Math.round(r.vx)).sort((a, b) => a - b), [-12, 0, 12], 'and fans out across the flight path');
  for (let i = 0; i < (CONDOR_CARPET_ROWS - 1) * CONDOR_CARPET_RIPPLE_TICKS; i++) { bombing.queueInput(pilot, command(2 + i, BTN.THROTTLE)); bombing.step(); }
  assert.equal(carpet().length, CONDOR_CARPET_ROWS * 3, 'the whole carpet follows row by row');
  const gravity = CONDOR_CARPET.gravity!, landing = carpet().map(r => r.z + r.vz * (r.vy + Math.sqrt(r.vy * r.vy + 2 * gravity * r.y)) / gravity);
  const length = Math.max(...landing) - Math.min(...landing);
  assert.ok(length > 80, `the carpet lands strung out along the flight path (${length.toFixed(0)} m)`);
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

type CrewIntern = {
  toggleVehicle(p: ServerPlayer): void;
  destroyVehicle(v: ServerVehicle, attacker: ServerPlayer | null, weaponId: number): void;
  updateHomingLock(p: ServerPlayer, cmd: InputCmd): void;
  fireVehicleWeapons(p: ServerPlayer, cmd: InputCmd): void;
};
const crewable = () => {
  const game = new Game(1337, { vehicles: true, frontier: true });
  const hull = [...game.vehicles.values()].find(v => v.type === VEHICLE.JET && v.variant === VEHICLE_VARIANT.CONDOR)!;
  const intern = game as unknown as CrewIntern;
  /** Stand a soldier at a gun position (or at the hull) and press use. */
  const enter = (p: ServerPlayer, index = -1) => {
    p.faction = 1;
    const eye = index < 0 ? { x: 3, z: 0 } : CONDOR_STATIONS[index].eye, c = Math.cos(hull.heading), s = Math.sin(hull.heading);
    Object.assign(p.state, { px: hull.x + eye.x * c + eye.z * s, py: hull.y + .1, pz: hull.z - eye.x * s + eye.z * c });
    intern.toggleVehicle(p);
  };
  return { game, hull, intern, enter };
};
const asBot = (p: ServerPlayer) => { (p as unknown as { isBot: boolean }).isBot = true; return p; };

test('five soldiers man the Condor guns behind its pilot, each at the free station nearest them', () => {
  const { game, hull, enter } = crewable(), pilot = game.addPlayer('Pilot', null);
  enter(pilot);
  assert.equal(hull.occupant, pilot.id); assert.equal(pilot.state.seat, 0); assert.equal(pilot.state.station, undefined);
  for (const index of [4, 2, 0, 1, 3]) {
    const gunner = game.addPlayer(`Gunner ${index}`, null);
    enter(gunner, index);
    assert.equal(gunner.state.seat, 1); assert.equal(gunner.state.station, index + 1);
    assert.equal(hull.stations![index], gunner.id);
  }
  const sixth = game.addPlayer('Too late', null);
  enter(sixth, 2);
  assert.equal(sixth.state.vehicle, VEHICLE.NONE, 'a full crew turns the next soldier away');
  const bot = asBot(game.addPlayer('Bot gunner', null)), second = asBot(game.addPlayer('Second bot', null));
  enter(bot, 1); enter(second, 1);
  assert.equal(hull.gunner, bot.id, 'a bot takes only the ordinary gunner seat');
  assert.equal(bot.state.station, undefined); assert.equal(bot.state.seat, 1);
  assert.equal(second.state.vehicle, VEHICLE.NONE, 'and never a human gun station');
});

test('a gunner leaving frees only their station, and a bailing pilot hands the Condor to the lowest manned one', () => {
  const { game, hull, intern, enter } = crewable(), pilot = game.addPlayer('Pilot', null);
  enter(pilot);
  const crew = [0, 1, 2, 3].map(index => { const p = game.addPlayer(`Gunner ${index}`, null); enter(p, index); return p; });
  intern.toggleVehicle(crew[0]);
  assert.equal(crew[0].state.vehicle, VEHICLE.NONE); assert.equal(crew[0].state.station, undefined);
  assert.deepEqual(hull.stations, [-1, crew[1].id, crew[2].id, crew[3].id, -1], 'nobody else changes position');
  hull.reloads = new Map([[0, { fire: game.tick + 300, alt: game.tick + 6000 }]]);
  crew[1].vehAltCd = 0;
  intern.toggleVehicle(pilot);
  assert.equal(hull.occupant, crew[1].id); assert.equal(crew[1].state.seat, 0); assert.equal(crew[1].state.station, undefined);
  assert.ok(crew[1].vehAltCd > 90, 'the new pilot cannot skip the mega-nuke reload');
  assert.deepEqual(hull.stations, [-1, -1, crew[2].id, crew[3].id, -1]);
  assert.equal(crew[2].state.station, 3); assert.equal(crew[3].state.station, 4);
  intern.destroyVehicle(hull, null, CONDOR_LOCK_ROCKET.id);
  assert.equal(hull.stations, undefined);
  for (const p of [crew[1], crew[2], crew[3]]) { assert.equal(p.state.vehicle, VEHICLE.NONE); assert.equal(p.state.station, undefined); assert.equal(p.state.seat, undefined); }
});

test('a crew moves between servers together, gun stations and all', () => {
  const { game, hull, enter } = crewable(), pilot = game.addPlayer('Pilot', null), gunner = game.addPlayer('Gunner', null);
  enter(pilot); enter(gunner, 4);
  const departed = game.takeHandoff([pilot.id]);
  assert.deepEqual(departed.record.players.map(p => p.id).sort((a, b) => a - b), [pilot.id, gunner.id].sort((a, b) => a - b));
  const [back] = game.acceptHandoff(departed.record, new Map(departed.record.players.map(p => [p.id, { send() {} }]))).filter(p => p.id === gunner.id);
  assert.equal(back.state.station, 5);
  assert.equal(game.vehicles.get(hull.id)!.stations![4], gunner.id);
});

test('bot crews keep the old Condor weapons; only humans get the carpet ripple and the mega-nuke', () => {
  const flying = (bot: boolean) => {
    const game = new Game(1337), pilot = game.addPlayer('Pilot', null), def = vehicleDefinition(VEHICLE.JET, VEHICLE_VARIANT.CONDOR)!;
    if (bot) asBot(pilot);
    const hull: ServerVehicle = { id: 901, type: VEHICLE.JET, variant: VEHICLE_VARIANT.CONDOR, x: 0, y: 500, z: 0, heading: 0,
      occupant: pilot.id, health: def.maxHealth, respawnAtTick: -1 };
    game.vehicles.set(hull.id, hull);
    Object.assign(pilot.state, { px: 0, py: 500, pz: 0, vz: -60, vehicle: VEHICLE.JET, vehicleVariant: VEHICLE_VARIANT.CONDOR, seat: 0, vehicleId: hull.id, grounded: false });
    pilot.vehicleId = hull.id; pilot.vehFireCd = 0; pilot.vehAltCd = 0;
    return { game, pilot, hull, count: (id: number) => [...game.projectiles.values()].filter(r => r.weapon === id).length };
  };
  const human = flying(false);
  human.game.queueInput(human.pilot, command(1, BTN.ALTFIRE | BTN.THROTTLE)); human.game.step();
  assert.equal(human.count(CONDOR_MEGA_NUKE.id), 1, 'alt fire drops one mega-nuke');
  assert.ok(human.pilot.vehAltCd > 100, 'on a long reload');
  assert.ok(human.hull.reloads?.get(0)?.alt! > human.game.tick + 100 * 60, 'held by the hull');
  const bot = flying(true);
  bot.game.queueInput(bot.pilot, command(1, BTN.ALTFIRE | BTN.THROTTLE)); bot.game.step();
  assert.equal(bot.count(CONDOR_MEGA_NUKE.id), 0, 'bots never drop the mega-nuke');
  assert.equal(bot.count(CONDOR_BOMB.id), CONDOR_CARPET_COUNT, 'a bot alt-fires the original stick');
  const gun = flying(true);
  gun.game.queueInput(gun.pilot, command(1, BTN.FIRE | BTN.THROTTLE)); gun.game.step();
  assert.equal(gun.count(CONDOR_CARPET.id), 0, 'and its primary is still the nose gun');
  assert.equal(crewArmament(VEHICLE.JET, VEHICLE_VARIANT.CONDOR).primary.name, 'Ventral Rocket', 'a bot gunner keeps the ventral rockets');
  assert.equal(crewArmament(VEHICLE.JET, VEHICLE_VARIANT.CONDOR, 3).primary.name, 'Chaingun');
  assert.equal(crewArmament(VEHICLE.JET, VEHICLE_VARIANT.CONDOR, 3).alt, CONDOR_LOCK_ROCKET);
});

test('a Condor gun swings around its own axis, and the view and the server agree which way that is', () => {
  const attitude = { heading: .7, vehiclePitch: .2, vehicleRoll: -.3 }, q = vehicleQuaternion(attitude);
  const angles = (d: { x: number; y: number; z: number }) => ({ yaw: Math.atan2(-d.x, -d.z), pitch: Math.atan2(d.y, Math.hypot(d.x, d.z)) });
  const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} vs ${b}`);
  CONDOR_STATIONS.forEach((station, index) => {
    const nose = rotateVector(rotationFromEuler(station.yaw, station.pitch), 0, 0, -1);
    near(nose.x, station.dir.x, `${station.name} x`); near(nose.y, station.dir.y, `${station.name} y`); near(nose.z, station.dir.z, `${station.name} z`);
    const axis = rotateVector(q, station.dir.x, station.dir.y, station.dir.z), centered = angles(axis);
    const free = condorStationAim(attitude, station, centered.yaw, centered.pitch);
    near(free.yaw, centered.yaw, 'on-axis yaw'); near(free.pitch, centered.pitch, 'on-axis pitch');
    const opposite = angles({ x: -axis.x, y: -axis.y, z: -axis.z });
    const pulled = viewDir(...(Object.values(condorStationAim(attitude, station, opposite.yaw, opposite.pitch)) as [number, number]));
    near(Math.acos(pulled.x * axis.x + pulled.y * axis.y + pulled.z * axis.z), CONDOR_STATION_CONE, `${station.name} rim`);
    const crew = { ...attitude, vehicle: VEHICLE.JET, vehicleVariant: VEHICLE_VARIANT.CONDOR, seat: 1, station: index + 1 };
    const eye = rotateVector(q, station.eye.x, station.eye.y, station.eye.z), seen = vehicleEyeOffset(crew), muzzle = aircraftCrewMuzzle(crew);
    near(seen.x, eye.x, 'eye'); near(seen.y, eye.y, 'eye'); near(seen.z, eye.z, 'eye');
    const barrel = rotateVector(q, station.muzzle.x, station.muzzle.y, station.muzzle.z);
    near(muzzle.x, barrel.x, 'muzzle'); near(muzzle.y, barrel.y, 'muzzle'); near(muzzle.z, barrel.z, 'muzzle');
  });
});

test('a Condor gun station locks onto any crewed vehicle and its rocket homes on it', () => {
  for (const [type, offset] of [[VEHICLE.TANK, -150], [VEHICLE.JET, -320]] as const) {
    const game = new Game(1337), intern = game as unknown as CrewIntern, gunner = game.addPlayer('Gunner', null), enemy = game.addPlayer('Enemy', null);
    game.world.trace = (x, y, z, dx, dy, dz, max) => ({ hit: false, dist: max, x: x + dx * max, y: y + dy * max, z: z + dz * max, nx: 0, ny: 0, nz: 0 });
    const def = vehicleDefinition(VEHICLE.JET, VEHICLE_VARIANT.CONDOR)!;
    const bomber: ServerVehicle = { id: 900, type: VEHICLE.JET, variant: VEHICLE_VARIANT.CONDOR, x: 0, y: 500, z: 0, heading: 0, occupant: -1, health: def.maxHealth, respawnAtTick: -1, stations: [gunner.id, -1, -1, -1, -1] };
    game.vehicles.set(bomber.id, bomber);
    Object.assign(gunner.state, { px: 0, py: 500, pz: 0, vehicle: VEHICLE.JET, vehicleVariant: VEHICLE_VARIANT.CONDOR, seat: 1, station: 1, vehicleId: bomber.id, grounded: false });
    gunner.vehicleId = bomber.id; gunner.vehAltCd = 0;
    const target: ServerVehicle = { id: 901, type, x: 0, y: 500 + offset, z: 0, heading: 0, occupant: enemy.id, health: vehicleDefinition(type)!.maxHealth, respawnAtTick: -1 };
    game.vehicles.set(target.id, target);
    Object.assign(enemy.state, { px: 0, py: target.y, pz: 0, vehicle: type, vehicleVariant: 0, seat: 0, vehicleId: target.id });
    enemy.vehicleId = target.id;
    const eye = vehicleEyeOffset(gunner.state), radius = vehicleDefinition(type)!.radius;
    const aim = { ...command(1), yaw: 0, pitch: Math.atan2(target.y + radius - (500 + eye.y), Math.hypot(eye.x, eye.z)) };
    for (let i = 0; i <= LOCK_TICKS + 1; i++) intern.updateHomingLock(gunner, aim);
    assert.equal(gunner.lockState, LOCK_LOCKED, `locked on a crewed ${type === VEHICLE.TANK ? 'tank' : 'jet'}`);
    intern.fireVehicleWeapons(gunner, { ...aim, buttons: BTN.ALTFIRE });
    const rockets = [...game.projectiles.values()].filter(r => r.weapon === CONDOR_LOCK_ROCKET.id);
    assert.equal(rockets.length, 1); assert.equal(rockets[0].homingVehicleId, target.id);
  }
});
