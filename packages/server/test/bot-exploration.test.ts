import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, PICKUP_WEAPON, VEHICLE, WEAPONS, vehicleDefinition, type ColumnData } from '@shared/index';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer, type ServerPickup, type ServerVehicle } from '../src/game.js';

/** Real command/collection/possession pipeline over an unobstructed practice field. */
function fixture(id = 4, x = 0, z = 0) {
  const game = new Game(1337);
  const col = { h: 0, temp: .5, moist: .5, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 } as ColumnData;
  game.world.column = () => col;
  game.world.sdf = (_x, y) => y;
  game.world.sdfCol = (_x, y) => y;
  game.world.terrainHeight = () => 0;
  game.world.liquidAt = () => undefined;
  game.world.collectCityLifts = () => [];
  game.world.collectTransportPlan = () => ({ routes: [], stations: [], harbors: [], pods: [], lifts: [], solids: [], bridges: [], accesses: [] });
  game.world.gradient = (_x, _y, _z, out) => Object.assign(out, { x: 0, y: 1, z: 0 });
  game.world.trace = (ox, oy, oz, dx, dy, dz, maxDist) => {
    const dist = dy < 0 ? Math.min(maxDist, Math.max(0, oy / -dy)) : maxDist;
    return { hit: dy < 0 && oy / -dy <= maxDist, dist, x: ox + dx * dist, y: oy + dy * dist,
      z: oz + dz * dist, nx: 0, ny: 1, nz: 0 };
  };
  const player = new ServerPlayer(id, 'Explorer', null, true, { x, y: .006, z });
  player.state.grounded = true;
  game.players.set(id, player);
  const bot = new Bot(player, 1337);
  const advance = (ticks: number) => {
    for (let i = 0; i < ticks; i++) { game.queueInput(player, bot.think(game)); game.step(); }
  };
  return { game, player, bot, advance };
}

function crate(id: number, weapon: number, x: number, z: number): ServerPickup {
  return { id, weapon, kind: PICKUP_WEAPON, x, y: .6, z, availableAtTick: 0, expiresAtTick: 10000 };
}
function hull(id: number, type: ServerVehicle['type'], z: number): ServerVehicle {
  return { id, type, x: 0, y: .006, z, heading: 0,
    health: vehicleDefinition(type)!.maxHealth, occupant: -1, respawnAtTick: -1 };
}

test('a bot walks to a found weapon, collects it through the server, equips and fires it', () => {
  const { game, player, bot, advance } = fixture();
  game.pickups.set(900, crate(900, 7, 0, -24));
  assert.equal(player.ammo[7].magazine, 0);
  for (let i = 0; i < 300 && game.pickups.has(900); i++) advance(1);
  assert.equal(game.pickups.has(900), false, `failed to reach crate: ${JSON.stringify(bot.intent)}`);
  advance(1);
  assert.equal(player.weapon, 7);
  assert.equal(player.ammo[7].magazine, WEAPONS[7].magazineSize);
  const target = new ServerPlayer(90, 'Target', null, false, { x: player.state.px, y: .006, z: player.state.pz - 90 });
  target.health = 10000;
  game.players.set(target.id, target);
  advance(90);
  assert.ok(game.stats.shotsFired > 0);
  assert.ok(player.ammo[7].magazine < WEAPONS[7].magazineSize, 'the actual acquired weapon fires');
});

test('a bot keeps a distant free driver objective, enters its jeep and drives away', () => {
  const { game, player, bot, advance } = fixture();
  const jeep = hull(901, VEHICLE.JEEP, -70);
  game.vehicles.set(jeep.id, jeep);
  advance(1);
  assert.equal(bot.intent.vehicleId, jeep.id);
  for (let i = 0; i < 750 && player.vehicleId < 0; i++) advance(1);
  assert.equal(player.vehicleId, jeep.id);
  assert.equal(jeep.occupant, player.id);
  assert.equal(player.state.seat, 0);
  const start = { x: jeep.x, z: jeep.z };
  advance(240);
  assert.ok(Math.hypot(jeep.x - start.x, jeep.z - start.z) > 20);
  assert.equal(player.state.alive, true);
});

test('a bot takes nearby armor during a visible fight, then stays aboard and uses its gun', () => {
  const { game, player, bot } = fixture();
  const jeep = hull(905, VEHICLE.JEEP, -28);
  game.vehicles.set(jeep.id, jeep);
  const enemy = new ServerPlayer(90, 'Visible opponent', null, false, { x: 0, y: .006, z: -110 });
  enemy.health = 10000;
  game.players.set(enemy.id, enemy);
  let uses = 0;
  const step = () => {
    const command = bot.think(game);
    if (command.buttons & BTN.USE) uses++;
    game.queueInput(player, command); game.step();
  };
  step();
  assert.equal(bot.intent.vehicleId, jeep.id, 'an enemy in sight must not starve armor acquisition');
  for (let i = 0; i < 300 && player.vehicleId < 0; i++) step();
  assert.equal(jeep.occupant, player.id);
  assert.equal(player.state.seat, 0);
  const start = { x: jeep.x, z: jeep.z }, health = enemy.health;
  for (let i = 0; i < 300; i++) {
    step();
    assert.equal(jeep.occupant, player.id, 'the approach USE must not become a repeated exit command');
  }
  assert.equal(uses, 1);
  assert.ok(Math.hypot(jeep.x - start.x, jeep.z - start.z) > 20);
  assert.ok(enemy.health < health, 'the mounted weapon damages the visible enemy');
});

test('close combat does not pull a bot toward a distant hull', () => {
  const { game, player, bot } = fixture();
  game.vehicles.set(905, hull(905, VEHICLE.JEEP, -50));
  const enemy = new ServerPlayer(90, 'Close opponent', null, false, { x: 0, y: .006, z: -15 });
  game.players.set(enemy.id, enemy);
  for (let i = 0; i < 150; i++) {
    const command = bot.think(game);
    assert.equal(bot.intent.vehicleId, -1);
    assert.equal(command.buttons & BTN.USE, 0);
    game.tick++;
  }
  assert.equal(player.vehicleId, -1);
});

test('remote exploration stays local, and pickup visibility work is capped per scan', () => {
  const { game, bot } = fixture(3, 4000, 4000);
  bot.think(game);
  assert.ok(Math.hypot(bot.intent.x - 4000, bot.intent.z - 4000) < 170);
  let traces = 0;
  game.world.trace = () => { traces++; return { hit: true, dist: 1, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 }; };
  for (let i = 0; i < 60; i++) game.pickups.set(900 + i, crate(900 + i, 7, 4001 + i, 3990));
  game.tick = 60;
  bot.think(game);
  assert.equal(bot.intent.pickupId, -1);
  assert.equal(traces, 2);
  for (let i = 0; i < 40; i++) { game.tick++; bot.think(game); }
  assert.equal(traces, 2, 'quiet ticks do not repeat resource visibility scans');
});

test('a common-jet pilot takes off and maintains finite, upright cruise over a flat runway', () => {
  const { game, player, advance } = fixture();
  const jet = hull(902, VEHICLE.JET, -4);
  game.vehicles.set(jet.id, jet);
  advance(2);
  assert.equal(player.vehicleId, jet.id);
  advance(1500);
  assert.equal(player.state.alive, true);
  assert.equal(player.vehicleId, jet.id);
  assert.ok(player.state.py > 25, `altitude ${player.state.py}`);
  assert.ok(Math.hypot(player.state.vx, player.state.vz) > 22);
  assert.ok(Math.abs(player.state.vehicleRoll) < .85);
  assert.ok([player.state.px, player.state.py, player.state.pz, player.state.vehiclePitch].every(Number.isFinite));
});

test('bots leave occupied driver seats alone and passengers never steer a shared hull', () => {
  const { game, player, bot } = fixture();
  const jeep = hull(903, VEHICLE.JEEP, -4); jeep.occupant = 8;
  game.vehicles.set(jeep.id, jeep);
  assert.equal(bot.think(game).buttons & BTN.USE, 0);
  const free = hull(904, VEHICLE.JEEP, -5); game.vehicles.set(free.id, free);
  game.tick = 80;
  assert.equal(bot.think(game).buttons & BTN.USE, 0, 'USE must not accidentally enter the closer occupied hull');
  Object.assign(player.state, { vehicle: VEHICLE.JEEP, vehicleId: jeep.id, seat: 1 });
  player.vehicleId = jeep.id;
  const command = bot.think(game);
  assert.equal(command.buttons & (BTN.FORWARD | BTN.BACK | BTN.LEFT | BTN.RIGHT | BTN.THROTTLE), 0);
});

test('a bot pilots a gunboat using the local water level', () => {
  const { game, player, advance } = fixture();
  const boat = hull(904, VEHICLE.GUNBOAT, -4);
  game.vehicles.set(boat.id, boat);
  game.world.sdf = (_x, y) => y + 20;
  game.world.sdfCol = (_x, y) => y + 20;
  game.world.liquidAt = (_x, y) => y <= 1 ? { id: 99, kind: 'water', surfaceY: 1, bottomY: -20, distance: -100, flowX: 0, flowZ: 0 } : undefined;
  advance(2);
  assert.equal(boat.occupant, player.id);
  const start = { x: boat.x, z: boat.z };
  advance(240);
  assert.ok(Math.hypot(boat.x - start.x, boat.z - start.z) > 20);
  assert.ok(Math.abs(boat.y) < 2);
  assert.equal(player.state.alive, true);
});
