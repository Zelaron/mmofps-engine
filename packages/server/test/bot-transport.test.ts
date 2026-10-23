import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, VEHICLE, vehicleDefinition, type ColumnData } from '@shared/index';
import type { CampaignOrder, Territory } from '@shared/frontier';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';
import type { Frontier } from '../src/frontier.js';

function fixture() {
  const game = new Game(1337);
  const col = { h: 0, temp: .5, moist: .5, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 } as ColumnData;
  game.world.column = () => col;
  game.world.sdf = game.world.sdfCol = (_x, y) => y;
  game.world.terrainHeight = () => 0;
  game.world.liquidAt = () => undefined;
  game.world.collectCityLifts = () => [];
  game.world.collectCities = () => [];
  game.world.collectRoadSegments = () => [];
  game.world.collectTransportPlan = () => ({ routes: [], stations: [], harbors: [], pods: [], lifts: [], solids: [], bridges: [], accesses: [] });
  game.world.gradient = (_x, _y, _z, out) => Object.assign(out, { x: 0, y: 1, z: 0 });
  game.world.trace = (ox, oy, oz, dx, dy, dz, maxDist) => {
    const dist = dy < 0 ? Math.min(maxDist, Math.max(0, oy / -dy)) : maxDist;
    return { hit: dy < 0 && oy / -dy <= maxDist, dist, x: ox + dx * dist, y: oy + dy * dist,
      z: oz + dz * dist, nx: 0, ny: 1, nz: 0 };
  };
  const objective: Territory = { id: 'east', baseId: 'east-base', name: 'Remote relay', kind: 'relay',
    x: 1200, y: 0, z: 0, radius: 30, owner: 0, influence: 0, contested: false };
  const baseOrder: CampaignOrder = { baseId: objective.baseId!, targetId: objective.id, name: 'Capture remote relay',
    x: objective.x, z: objective.z, phase: 'attack', squad: 1, staging: { x: 0, y: 0, z: 0 } };
  const orders = new Map<number, CampaignOrder>();
  Object.defineProperty(game, 'frontier', { value: { territories: [objective],
    order: (p: ServerPlayer) => orders.get(p.id) ?? baseOrder, recordCombat() {}, step() {}, send() {} } as unknown as Frontier });
  const bots: Bot[] = [];
  const soldier = (id: number, x = 0, z = 0, faction: 1 | 2 = 1) => {
    const player = new ServerPlayer(id, `Soldier ${id}`, null, true, { x, y: .006, z });
    player.faction = faction; player.state.grounded = true; game.players.set(id, player);
    const bot = new Bot(player, 1337); bots.push(bot); return { player, bot };
  };
  const jeep = (id: number, x: number, z: number, driver?: ServerPlayer): ServerVehicle => {
    const hull: ServerVehicle = { id, type: VEHICLE.JEEP, x, y: .006, z, heading: 0,
      health: vehicleDefinition(VEHICLE.JEEP)!.maxHealth, occupant: driver?.id ?? -1, respawnAtTick: -1, campaignFaction: 1 };
    game.vehicles.set(id, hull);
    if (driver) {
      driver.vehicleId = id;
      Object.assign(driver.state, { vehicle: VEHICLE.JEEP, vehicleId: id, px: x, pz: z });
    }
    return hull;
  };
  const advance = (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      for (const bot of bots) game.queueInput(bot.player, bot.think(game));
      game.step();
    }
  };
  return { game, objective, baseOrder, orders, soldier, jeep, advance };
}

test('marching infantry ignores an unrelated battle but reacts to close threats and resumes its order', () => {
  const { game, soldier } = fixture();
  const { bot } = soldier(19);
  const { player: enemy } = soldier(90, -200, 0, 2);
  const marching = bot.think(game);
  assert.ok(bot.intent.x > 1100, 'the remote assignment survives a visible battle behind the squad');
  assert.ok(marching.buttons & BTN.FORWARD);
  enemy.state.px = -35; game.tick = 30;
  const defense = bot.think(game);
  assert.ok(Math.sin(defense.yaw) > .8, 'the infantry still turns to fight a nearby attacker');
  enemy.state.px = -220; game.tick++;
  const resumed = bot.think(game);
  assert.ok(Math.sin(resumed.yaw) < -.8, 'a receding enemy does not retain an obsolete pursuit between LOS scans');
  assert.ok(bot.intent.x > 1100);
});

test('vehicle weapons cover nearby enemies while the driver keeps its route to a distant order', () => {
  const { game, objective, soldier, jeep } = fixture();
  objective.x = 0; objective.z = -1200;
  const { player, bot } = soldier(13);
  jeep(800, 0, 0, player);
  soldier(90, 180, 0, 2);
  const command = bot.think(game);
  assert.ok(Math.sin(command.yaw) < -.8, 'mounted weapons aim at the enemy to the east');
  assert.ok(bot.intent.z < -1100, 'navigation still targets the northern relay');
  assert.ok(command.buttons & BTN.FORWARD);
  assert.equal(command.buttons & (BTN.LEFT | BTN.RIGHT), 0, 'weapon aim does not turn the convoy east');
});

test('soldiers choose a shared squad ride over a closer convoy heading to another region', () => {
  const { game, baseOrder, orders, soldier, jeep } = fixture();
  const { bot } = soldier(19);
  const wrong = soldier(13, 0, -15).player, matching = soldier(16, 0, -55).player;
  orders.set(wrong.id, { ...baseOrder, baseId: 'west-base', targetId: 'west', squad: 0, x: -1200 });
  jeep(801, 0, -15, wrong); jeep(802, 0, -55, matching);
  bot.think(game);
  assert.equal(bot.intent.vehicleId, 802);
});

test('one gunner-seat reservation sends the next recruit to another available convoy', () => {
  const { game, soldier, jeep } = fixture();
  const first = soldier(19, 0, 40), second = soldier(22, 0, 42);
  jeep(803, 0, 0, soldier(13).player);
  jeep(804, 50, 0, soldier(16).player);
  first.bot.think(game); second.bot.think(game);
  assert.equal(first.bot.intent.vehicleId, 803);
  assert.equal(second.bot.intent.vehicleId, 804, 'two recruits cannot chase the same last seat');
});

test('an unrelated squad does not delay a convoy with an empty seat', () => {
  const { game, baseOrder, objective, orders, soldier, jeep } = fixture();
  objective.x = 0; objective.z = -1200;
  const driver = soldier(13); jeep(805, 0, 0, driver.player);
  const recruit = soldier(19, 0, 20);
  orders.set(recruit.player.id, { ...baseOrder, baseId: 'west-base', targetId: 'west', squad: 0, x: -1200 });
  assert.ok(driver.bot.think(game).buttons & BTN.FORWARD, 'pickup pauses only serve a compatible operation');
});

test('squadmates reserve an unoccupied ride, board together and make sustained progress across the map', () => {
  const { objective, soldier, jeep, advance } = fixture();
  objective.x = 0; objective.z = -1200;
  const driver = soldier(13), passenger = soldier(19, 0, 65), transport = jeep(806, 0, -4);
  advance(660);
  assert.equal(transport.occupant, driver.player.id);
  assert.equal(transport.gunner, passenger.player.id, 'the driver waits through the longer rendezvous');
  advance(900);
  assert.ok(driver.player.state.pz < -180, 'the assembled crew departs on its campaign route');
  assert.equal(passenger.player.vehicleId, transport.id);
});

test('stranded infantry can drive an unclaimed jeep for a long trip but stays on foot inside a capture area', () => {
  const { game, objective, soldier, jeep, advance } = fixture();
  const infantry = soldier(19); const transport = jeep(807, 0, -4);
  advance(2);
  assert.equal(infantry.player.vehicleId, transport.id, 'a missing specialist does not strand a long-distance squad');
  const defender = soldier(37, objective.x - 10, objective.z);
  jeep(808, objective.x - 10, objective.z - 4);
  assert.equal(defender.bot.think(game).buttons & BTN.USE, 0, 'capturing soldiers do not abandon a flag for nearby parking');
  assert.equal(defender.bot.intent.vehicleId, -1);
});

test('tank drivers dismount at an explicit expedition waypoint while ordinary armor keeps its cover role',()=>{
  for(const travel of [false,true]){
    const{game,objective,soldier,jeep}=fixture();
    objective.x=0;objective.z=-10;
    const{player,bot}=soldier(13),hull=jeep(809,0,0,player);
    hull.type=VEHICLE.TANK;hull.health=vehicleDefinition(VEHICLE.TANK)!.maxHealth;
    player.state.vehicle=VEHICLE.TANK;
    if(travel)bot.setTravelWaypoint({id:'orbital-test',x:0,y:0,z:-10});
    const command=bot.think(game);
    assert.equal(!!(command.buttons&BTN.USE),travel,
      travel?'the driver becomes infantry for the physical pod rendezvous':'ordinary armor stays mounted to cover its objective');
  }
});
