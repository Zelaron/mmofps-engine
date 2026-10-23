import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, CREATURE, CREATURE_DEFS, TICK_DT, VEHICLE, stepMove, vehicleArmament, vehicleDefinition, type ColumnData } from '@shared/index';
import type { CampaignOrder, Territory } from '@shared/frontier';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';
import type { Frontier } from '../src/frontier.js';
import type { Creature } from '../src/wildlife.js';

const PROPULSION = BTN.FORWARD | BTN.BACK | BTN.LEFT | BTN.RIGHT | BTN.ALTFIRE;

function fixture() {
  const game = new Game(1337), world = game.world;
  const column = { h: 0, temp: .5, moist: .5, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 } as ColumnData;
  world.sampleColumn = world.column = () => column;
  world.sdf = world.sdfCol = (_x, y) => y;
  world.terrainHeight = world.groundY = () => 0;
  world.liquidAt = () => undefined;
  world.collectRegion = () => ({ sites: [], boulders: [], pads: [], solids: [], cuts: [], vegetation: [], foundations: [] });
  world.collectCities = world.collectCityLifts = world.collectRoadSegments = () => [];
  world.collectTransportPlan = () => ({ routes: [], stations: [], harbors: [], pods: [], lifts: [], solids: [], bridges: [], accesses: [] });
  world.gradient = (_x, _y, _z, out) => Object.assign(out, { x: 0, y: 1, z: 0 });
  let traces = 0;
  world.trace = (x, y, z, dx, dy, dz, maxDist) => {
    traces++;
    const dist = dy < 0 ? Math.min(maxDist, Math.max(0, y / -dy)) : maxDist;
    return { hit: dy < 0 && y / -dy <= maxDist, dist, x: x + dx * dist,
      y: y + dy * dist, z: z + dz * dist, nx: 0, ny: 1, nz: 0 };
  };
  const objective: Territory = { id: 'cover', name: 'Relay', kind: 'relay', x: 0, y: 0, z: -10,
    radius: 30, owner: 1, influence: 0, contested: false };
  const order: CampaignOrder = { baseId: 'base', targetId: objective.id, name: 'Defend relay', x: 0, z: -10,
    phase: 'defend', squad: 1, staging: { x: 0, y: 0, z: 0 } };
  Object.defineProperty(game, 'frontier', { value: { territories: [objective], order: () => order,
    recordCombat() {}, step() {}, send() {} } as unknown as Frontier });
  game.shouldThinkBot = () => true;
  const player = new ServerPlayer(13, 'Armor', null, true, { x: 0, y: .006, z: 0 });
  player.faction = 1; player.vehicleId = 800;
  Object.assign(player.state, { vehicle: VEHICLE.TANK, vehicleId: 800, seat: 0, grounded: true });
  const hull: ServerVehicle = { id: 800, type: VEHICLE.TANK, x: 0, y: .006, z: 0, heading: 0,
    health: vehicleDefinition(VEHICLE.TANK)!.maxHealth, occupant: player.id, gunner: -1, respawnAtTick: -1 };
  game.players.set(player.id, player); game.vehicles.set(hull.id, hull);
  const bot = new Bot(player, 1337);
  return { game, world, player, hull, bot, objective, order, traces: () => traces };
}

test('armor holding its objective clears recovery and does not mistake successful cover for a stuck convoy', () => {
  const { game, player, hull, bot, objective, traces } = fixture();
  bot.think(game); // Complete ordinary boarding initialization.
  const recovery = bot as unknown as { reverseUntil: number; avoidUntil: number; obstacleScanAt: number;
    stuckX: number; stuckZ: number; stuckCheckAt: number; vehicleSupportAhead: boolean };
  Object.assign(recovery, { reverseUntil: 9999, avoidUntil: 9999, obstacleScanAt: 9999,
    stuckX: -50, stuckZ: -50, stuckCheckAt: 0, vehicleSupportAhead: false });
  for (let tick = 1; tick <= 360; tick++) {
    game.tick = tick;
    assert.equal(bot.think(game).buttons & (PROPULSION | BTN.USE), 0);
  }
  assert.equal(traces(), 0, 'no forward route feelers are useful while holding still');
  assert.equal(recovery.reverseUntil, -1); assert.equal(recovery.avoidUntil, 0);
  assert.equal(recovery.stuckX, player.state.px); assert.equal(recovery.stuckZ, player.state.pz);
  assert.ok(recovery.stuckCheckAt > game.tick);
  assert.equal(player.vehicleId, hull.id, 'ordinary armor retains its cover role');

  objective.z = -1200; game.tick++;
  const departure = bot.think(game);
  assert.ok(departure.buttons & BTN.FORWARD, 'a changed objective immediately restores travel');
  assert.equal(departure.buttons & BTN.BACK, 0, 'old recovery cannot delay the new assignment');
  assert.ok(traces() >= 8, 'departure checks the actual forward route again');
});

test('parked armor brakes through ordinary physics without driving into reverse or freezing motion', () => {
  for (const velocity of [{ x: 0, z: -8 }, { x: 0, z: 8 }, { x: 8, z: 0 }]) {
    const { game, world, player, bot } = fixture(), s = player.state;
    s.vx = velocity.x; s.vz = velocity.z;
    let priorSpeed = Math.hypot(s.vx, s.vz);
    for (let tick = 0; tick < 240; tick++) {
      game.tick = tick; const command = bot.think(game);
      assert.equal(command.buttons & PROPULSION, 0);
      stepMove(world, s, command, TICK_DT, tick);
      const speed = Math.hypot(s.vx, s.vz);
      assert.ok(speed <= priorSpeed + 1e-9, 'neutral throttle decelerates the existing velocity');
      assert.ok(s.vx * velocity.x + s.vz * velocity.z >= -1e-9, 'braking never becomes reverse propulsion');
      priorSpeed = speed;
    }
    assert.ok(Math.hypot(s.px, s.pz) > .1, 'live physics advances the residual motion');
    assert.ok(priorSpeed < .01); assert.ok(s.grounded); assert.ok(s.py >= -.01);
  }
});

test('parked armor keeps enemy aim and the ordinary mounted weapon cooldown', () => {
  const { game, player, bot } = fixture();
  const enemy = new ServerPlayer(90, 'Attacker', null, true, { x: 100, y: .006, z: 0 });
  enemy.faction = 2; enemy.state.grounded = true; enemy.health = 10000; game.players.set(enemy.id, enemy);
  let firstCooldown = 0;
  const cooldownTicks = Math.ceil(vehicleArmament(VEHICLE.TANK).primary.interval / TICK_DT);
  for (let tick = 0; tick < cooldownTicks + 6; tick++) {
    const command = bot.think(game);
    assert.equal(command.buttons & PROPULSION, 0);
    assert.ok(command.buttons & BTN.FIRE); assert.ok(Math.sin(command.yaw) < -.99);
    game.queueInput(player, command); game.step();
    if (tick === 0) { firstCooldown = player.vehFireCd; assert.equal(game.stats.shotsFired, 1); }
    if (tick === 10) { assert.ok(player.vehFireCd < firstCooldown); assert.equal(game.stats.shotsFired, 1); }
  }
  assert.ok(game.stats.shotsFired >= 2, 'holding cover continues firing after the canonical cooldown');
  assert.ok(Math.hypot(player.state.px, player.state.pz) < .01);
});

test('parked armor still aims and fires at an attacking creature', () => {
  const { game, bot } = fixture(), species = CREATURE.BRUTE;
  const creature: Creature = { id: 990, species, x: -25, y: 0, z: 0, yaw: 0, speed: 0, alert: true,
    health: CREATURE_DEFS[species].health, homeX: -25, homeY: 0, homeZ: 0, attackAt: 0, turnAt: 0,
    deadUntil: 0, thinkAt: 0, windupUntil: 0, targetId: -1, aggressorId: -1, aggressorUntil: 0,
    rangedAt: 0, detourUntil: 0, damageContributors: new Map() };
  game.wildlife.creatures.set(creature.id, creature);
  const command = bot.think(game);
  assert.ok(command.buttons & BTN.FIRE); assert.ok(Math.sin(command.yaw) > .99);
  assert.equal(command.buttons & PROPULSION, 0);
});

test('parked armor still evacuates a failing hull and dismounts for explicit expedition duties', () => {
  for (const reason of ['damage', 'expedition'] as const) {
    const { game, player, hull, bot } = fixture();
    bot.think(game); game.tick = 360;
    if (reason === 'damage') hull.health = 1;
    else bot.setTravelWaypoint({ id: 'orbital-rendezvous', x: 0, y: 0, z: -10 });
    assert.equal(bot.think(game).buttons, BTN.USE, reason);
    assert.equal(player.vehicleId, hull.id, 'the bot requests ordinary input-driven dismounting');
  }
});
