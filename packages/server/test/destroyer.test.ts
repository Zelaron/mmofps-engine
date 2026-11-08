import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, PLAYER, VEHICLE, VEHICLE_VARIANT, WEAPONS, LOCK_LOCKED, LOCK_TICKS, TICK_RATE, vehicleDefinition,
  DESTROYER_AA_PIVOT, DESTROYER_BRIDGE_EYE, DESTROYER_CLUSTER, DESTROYER_NUKE, DESTROYER_AA_ROCKET,
  type InputCmd, type WeaponDef } from '@shared/index';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';
import { Bot } from '../src/bots.js';
import { batteryPitch, DESTROYER_BATTERY_PIVOT } from '@shared/vehicles';
import { vehicleCollisionWorld } from '../../shared/test/vehicle-collision-fixture.js';

const command = (seq: number, buttons = 0, yaw = 0, pitch = 0): InputCmd =>
  ({ seq, buttons, yaw, pitch, weapon: 0, renderTick: 0, renderFrac: 0 });
const ship = (id: number, extra: Partial<ServerVehicle> = {}): ServerVehicle => ({ id, type: VEHICLE.GUNBOAT,
  variant: VEHICLE_VARIANT.DESTROYER, x: 0, y: 0, z: 0, heading: 0, occupant: -1, gunner: -1,
  health: vehicleDefinition(VEHICLE.GUNBOAT, VEHICLE_VARIANT.DESTROYER)!.maxHealth, respawnAtTick: -1, ...extra });
/** A world point at a destroyer's local offset (heading 0: local -z is the bow). */
const post = (v: ServerVehicle, o: { x: number; z: number }) => ({ x: v.x + o.x, z: v.z + o.z });

test('two destroyers moor at opposite ocean quays with their decks level with the quay', () => {
  const game = new Game(1337, { vehicles: true, frontier: true });
  const ships = [...game.vehicles.values()].filter(v => v.type === VEHICLE.GUNBOAT && v.variant === VEHICLE_VARIANT.DESTROYER);
  assert.equal(ships.length, 2);
  for (const v of ships) {
    assert.ok(v.campaignHome, 'a sunk destroyer returns to its mooring');
    assert.equal(game.world.liquidAt(v.x, v.y + 1, v.z)?.kind, 'water');
    const quay = Math.max(game.world.groundY(v.x + Math.cos(v.heading) * 6, v.z - Math.sin(v.heading) * 6),
      game.world.groundY(v.x - Math.cos(v.heading) * 6, v.z + Math.sin(v.heading) * 6));
    assert.ok(Math.abs(v.y + 3.4 - quay) < .3, `deck ${v.y + 3.4} beside quay ${quay}`);
  }
  for (let i = 0; i < 300; i++) game.step();
  for (const v of ships) assert.ok(Math.hypot(v.x - v.campaignHome!.x, v.z - v.campaignHome!.z) < .5, 'a moored ship stays put');
});

test('about 25 direct rockets sink a destroyer, and hits register from bow to stern', () => {
  const game = new Game(1337), p = game.addPlayer('Rocketeer', null);
  game.world.trace = (x, y, z, dx, dy, dz, max) => ({ hit: false, dist: max, x: x + dx * max, y: y + dy * max, z: z + dz * max, nx: 0, ny: 0, nz: 0 });
  const hull = ship(900, { y: 1000 }); game.vehicles.set(hull.id, hull);
  const intern = game as unknown as { fireProjectile(p: ServerPlayer, c: InputCmd, d: WeaponDef): void; updateProjectiles(): void };
  p.weapon = 3;
  let hits = 0;
  for (const along of [-15, -8, 0, 8, 14]) {
    // From the beam, level with the hull's hit spheres.
    Object.assign(p.state, { px: 40, py: 1000 + 3.6 - PLAYER.EYE_HEIGHT, pz: along });
    const before = hull.health;
    intern.fireProjectile(p, command(1, 0, Math.PI / 2, 0), WEAPONS[3]);
    for (let i = 0; i < 120 && game.projectiles.size; i++) intern.updateProjectiles();
    assert.ok(hull.health < before, `a rocket striking ${along} m along the keel hits the hull`);
    hits++;
  }
  while (hull.health > 0 && hull.respawnAtTick < 0 && hits < 40) {
    Object.assign(p.state, { px: 40, py: 1000 + 3.6 - PLAYER.EYE_HEIGHT, pz: 0 });
    intern.fireProjectile(p, command(1, 0, Math.PI / 2, 0), WEAPONS[3]);
    for (let i = 0; i < 120 && game.projectiles.size; i++) intern.updateProjectiles();
    hits++;
  }
  assert.ok(hits >= 23 && hits <= 27, `sank after ${hits} direct rockets`);
});

function deckFixture() {
  const game = new Game(1337); vehicleCollisionWorld(game.world);
  const hull = ship(10002); game.vehicles.set(hull.id, hull);
  const soldier = (id: number, at: { x: number; z: number }) => {
    const p = new ServerPlayer(id, `Sailor ${id}`, null, false, { x: at.x, y: 3.5, z: at.z });
    p.faction = 1; p.state.grounded = true; game.players.set(p.id, p); return p;
  };
  const press = (p: ServerPlayer, buttons: number, yaw = 0, pitch = 0) => {
    game.queueInput(p, command(p.lastQueuedSeq + 1, buttons, yaw, pitch)); game.step();
    game.queueInput(p, command(p.lastQueuedSeq + 1, 0, yaw, pitch)); game.step();
  };
  return { game, hull, soldier, press };
}

test('crew take the post they stand nearer, the AA gunner keeps the mount, and exits land on deck', () => {
  const { hull, soldier, press } = deckFixture();
  const gunner = soldier(10003, post(hull, { x: 1.5, z: DESTROYER_AA_PIVOT.z }));
  press(gunner, BTN.USE);
  assert.equal(gunner.state.vehicleId, hull.id); assert.equal(gunner.state.seat, 1, 'beside the stern mount: AA seat');
  assert.equal(hull.occupant, -1, 'the bridge stays free');
  const captain = soldier(10004, post(hull, { x: 1.5, z: DESTROYER_BRIDGE_EYE.z }));
  press(captain, BTN.USE);
  assert.equal(captain.state.seat, 0); assert.equal(hull.occupant, captain.id);
  press(captain, BTN.USE);
  assert.equal(captain.state.vehicle, VEHICLE.NONE);
  assert.equal(gunner.state.seat, 1, 'the AA gunner is not moved to the bridge');
  assert.equal(hull.gunner, gunner.id); assert.equal(hull.occupant, -1);
  assert.ok(Math.abs(captain.state.py - (hull.y + 3.5)) < .2, `the captain steps out onto the deck (y ${captain.state.py})`);
  assert.ok(Math.hypot(captain.state.px - hull.x, captain.state.pz - hull.z) < 8, 'beside the bridge, not in the sea');
});

test('the bridge fires five-shell salvos; the nuclear salvo has a long cooldown and is never fired by bots', () => {
  for (const bot of [false, true]) {
    const { game, hull, press } = deckFixture();
    const captain = new ServerPlayer(10005, 'Captain', null, bot, { x: hull.x, y: hull.y, z: hull.z });
    captain.faction = 1; game.players.set(captain.id, captain);
    Object.assign(captain.state, { vehicle: VEHICLE.GUNBOAT, vehicleVariant: VEHICLE_VARIANT.DESTROYER, seat: 0, vehicleId: hull.id });
    captain.vehicleId = hull.id; hull.occupant = captain.id; captain.vehFireCd = 0; captain.vehAltCd = 0;
    const count = (id: number) => [...game.projectiles.values()].filter(r => r.weapon === id).length;
    game.queueInput(captain, command(captain.lastQueuedSeq + 1, BTN.FIRE, 0, .2)); game.step();
    assert.equal(count(DESTROYER_CLUSTER.id), 5, 'one salvo, five cluster shells');
    game.queueInput(captain, command(captain.lastQueuedSeq + 1, BTN.ALTFIRE, 0, .3)); game.step();
    assert.equal(count(DESTROYER_NUKE.id), bot ? 0 : 5, bot ? 'bots never fire the nuclear salvo' : 'five nuclear shells');
    if (!bot) {
      for (let i = 0; i < 30 * TICK_RATE; i++) { game.queueInput(captain, command(captain.lastQueuedSeq + 1, BTN.ALTFIRE, 0, .3)); game.step(); }
      assert.ok(count(DESTROYER_NUKE.id) <= 5, 'no second nuclear salvo within its cooldown');
    }
    void press;
  }
});

test('the AA mount locks onto an enemy aircraft and fires homing rocket pairs', () => {
  const { game, hull, soldier, press } = deckFixture();
  game.world.trace = (x, y, z, dx, dy, dz, max) => ({ hit: false, dist: max, x: x + dx * max, y: y + dy * max, z: z + dz * max, nx: 0, ny: 0, nz: 0 });
  const gunner = soldier(10003, post(hull, { x: 1.5, z: DESTROYER_AA_PIVOT.z }));
  press(gunner, BTN.USE); assert.equal(gunner.state.seat, 1);
  const pilot = new ServerPlayer(10010, 'Raider', null, false, { x: 0, y: 300, z: -400 });
  pilot.faction = 2; game.players.set(pilot.id, pilot);
  const jet: ServerVehicle = { id: 10011, type: VEHICLE.JET, x: 0, y: 300, z: -400, heading: 0, occupant: pilot.id,
    health: vehicleDefinition(VEHICLE.JET)!.maxHealth, respawnAtTick: -1 };
  game.vehicles.set(jet.id, jet);
  Object.assign(pilot.state, { vehicle: VEHICLE.JET, vehicleId: jet.id, seat: 0, grounded: false });
  pilot.vehicleId = jet.id;
  const aim = () => {
    const eye = { x: gunner.state.px, y: gunner.state.py + DESTROYER_AA_PIVOT.y + .48, z: gunner.state.pz + .85 };
    const dx = jet.x - eye.x, dy = jet.y + vehicleDefinition(VEHICLE.JET)!.radius - eye.y, dz = jet.z - eye.z;
    return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
  };
  for (let i = 0; i <= LOCK_TICKS + 2; i++) {
    Object.assign(pilot.state, { px: jet.x, py: jet.y, pz: jet.z, vx: 0, vy: 0, vz: 0 });
    const a = aim(); game.queueInput(gunner, command(gunner.lastQueuedSeq + 1, 0, a.yaw, a.pitch)); game.step();
  }
  assert.equal(gunner.lockState, LOCK_LOCKED, 'two seconds on target lock the aircraft');
  const a = aim(); game.queueInput(gunner, command(gunner.lastQueuedSeq + 1, BTN.FIRE, a.yaw, a.pitch)); game.step();
  const rockets = [...game.projectiles.values()].filter(r => r.weapon === DESTROYER_AA_ROCKET.id);
  assert.equal(rockets.length, 2, 'a pair per shot');
  assert.ok(rockets.every(r => r.homingVehicleId === jet.id), 'locked rockets home on the aircraft');
});

test('a bot captain lobs the battery salvo on its solved arc and never fires the nuclear salvo', () => {
  const { game, hull } = deckFixture();
  game.world.trace = (x, y, z, dx, dy, dz, max) => ({ hit: false, dist: max, x: x + dx * max, y: y + dy * max, z: z + dz * max, nx: 0, ny: 0, nz: 0 });
  game.shouldThinkBot = () => true;
  const captain = new ServerPlayer(10020, 'Bot captain', null, true, { x: hull.x, y: hull.y, z: hull.z });
  captain.faction = 1; game.players.set(captain.id, captain);
  Object.assign(captain.state, { vehicle: VEHICLE.GUNBOAT, vehicleVariant: VEHICLE_VARIANT.DESTROYER, seat: 0, vehicleId: hull.id });
  captain.vehicleId = hull.id; hull.occupant = captain.id;
  const enemy = new ServerPlayer(10021, 'Coastal gunner', null, true, { x: 0, y: 0, z: -200 });
  enemy.faction = 2; enemy.state.grounded = true; game.players.set(enemy.id, enemy);
  const bot = new Bot(captain, 1337);
  let fired = 0, alt = 0, pitch = 0;
  for (let i = 0; i < 30; i++) {
    const c = bot.think(game); game.tick++;
    if (c.buttons & BTN.FIRE) { fired++; pitch = c.pitch; }
    if (c.buttons & BTN.ALTFIRE) alt++;
  }
  assert.ok(fired > 0, 'the captain fires at a target within reach');
  assert.equal(alt, 0, 'bots never press the nuclear salvo');
  const arc = batteryPitch(200, hull.y + DESTROYER_BATTERY_PIVOT.y - enemy.state.py - 1)!;
  assert.ok(Math.abs(pitch - arc) < .03, `aims on the lobbed arc (${pitch} vs ${arc})`);
});
