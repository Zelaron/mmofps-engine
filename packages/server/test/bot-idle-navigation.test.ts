import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, TICK_DT, stepWeaponState, type ColumnData } from '@shared/index';
import type { CampaignOrder, Territory } from '@shared/frontier';
import { Bot, campaignSpot } from '../src/bots.js';
import { Game, ServerPlayer } from '../src/game.js';
import type { Frontier } from '../src/frontier.js';

function fixture() {
  const game = new Game(1337), world = game.world;
  const column = { h: 0, temp: .5, moist: .5, desert: 0, entr: 0, entrRaw: 0, volc: 0, lavaY: -1000 } as ColumnData;
  world.sampleColumn = world.column = () => column;
  world.sdf = world.sdfCol = (_x, y) => y;
  world.liquidAt = () => undefined;
  world.collectCities = world.collectCityLifts = world.collectRoadSegments = () => [];
  world.collectTransportPlan = () => ({ routes: [], stations: [], harbors: [], pods: [], lifts: [], solids: [], bridges: [], accesses: [] });
  const directions: { dx: number; dy: number; dz: number }[] = [];
  world.trace = (x, y, z, dx, dy, dz, max) => {
    directions.push({ dx, dy, dz });
    const dist = dy < 0 ? Math.min(max, Math.max(0, y / -dy)) : max;
    return { hit: dy < 0 && y / -dy <= max, dist, x: x + dx * dist,
      y: y + dy * dist, z: z + dz * dist, nx: 0, ny: 1, nz: 0 };
  };
  // The objective sits so that soldier 19's own spot is 0,0.
  const offset = campaignSpot({ id: 19 }, { x: 0, z: 0 }, 30);
  const objective: Territory = { id: 'held', name: 'Held relay', kind: 'relay', x: -offset.x, y: 0, z: -offset.z,
    radius: 30, owner: 1, influence: 1, contested: false };
  const order: CampaignOrder = { baseId: 'base', targetId: objective.id, name: 'Defend relay',
    x: objective.x, z: objective.z, phase: 'defend', squad: 1, staging: { x: 0, y: 0, z: 0 } };
  Object.defineProperty(game, 'frontier', { configurable: true, value: {
    territories: [objective], order: () => order,
  } as unknown as Frontier });
  game.shouldThinkBot = () => true;
  const player = new ServerPlayer(19, 'Defender', null, true, { x: 0, y: .006, z: 0 });
  player.faction = 1; player.state.grounded = true; player.weapon = 1;
  game.players.set(player.id, player);
  const bot = new Bot(player, 1337);
  const think = () => {
    const command = bot.think(game);
    stepWeaponState(player, command.weapon, command.buttons, TICK_DT);
    player.lastCmd = command; game.tick++;
    return command;
  };
  return { game, world, player, bot, objective, order, directions, think };
}

test('settled infantry stops probing an unused walking course while completing its ordinary reload', () => {
  const f = fixture(); f.player.ammo[1].magazine = 1;
  const initial = f.think();
  assert.ok(initial.buttons & BTN.RELOAD);
  assert.equal(initial.buttons & BTN.FORWARD, 0);
  for (let tick = 0; tick < 360; tick++) {
    assert.equal(f.think().buttons & (BTN.FORWARD | BTN.BACK | BTN.LEFT | BTN.RIGHT | BTN.JUMP), 0);
  }
  assert.equal(f.directions.length, 0, 'a stationary assigned defender has no forward route to trace');
  assert.ok(f.player.ammo[1].magazine > 1, 'navigation gating does not suspend the authoritative reload');
  assert.equal(f.player.reloadWeapon, -1);
});

test('a moved objective gets immediate fresh clearance rather than a retained idle avoidance heading', () => {
  const f = fixture(); f.think();
  const steering = f.bot as unknown as { walkAvoidUntil: number; walkScanAt: number; walkAvoidYaw: number };
  Object.assign(steering, { walkAvoidUntil: 9999, walkScanAt: 9999, walkAvoidYaw: Math.PI / 2 });
  f.think();
  assert.equal(steering.walkAvoidUntil, 0); assert.equal(steering.walkScanAt, 0);
  f.objective.z = -112;
  const command = f.think();
  assert.ok(command.buttons & BTN.FORWARD, 'the new objective immediately resumes travel');
  assert.ok(Math.abs(command.yaw) < .01, 'old sideways avoidance does not survive holding the objective');
  assert.ok(f.directions.some(d => d.dy === 0 && d.dz < -.99), 'departure checks the actual new forward ray');
  assert.ok(f.directions.some(d => d.dy < 0), 'departure also checks support before choosing its course');
});

test('settled infantry still acquires and reacts to a newly arriving close enemy', () => {
  const f = fixture(); f.think();
  const enemy = new ServerPlayer(90, 'Attacker', null, true, { x: 25, y: .006, z: 0 });
  enemy.faction = 2; enemy.state.grounded = true; f.game.players.set(enemy.id, enemy);
  f.game.tick = 30;
  const command = f.think();
  assert.ok(Math.sin(command.yaw) < -.95, 'normal combat aim faces the approaching enemy');
  assert.ok(f.directions.some(d => d.dx > .9), 'ordinary scheduled enemy LOS remains active');
});

test('enemy acquisition rejects exact out-of-range coordinates before campaign geometry and retains candidate order', () => {
  const f = fixture(); Object.defineProperty(f.game, 'frontier', { value: undefined });
  const internal = f.bot as unknown as { acquireEnemy(game: Game): ServerPlayer | null;
    campaignThreat(game: Game, player: ServerPlayer): boolean; losCheckAt: number };
  const evaluated: number[] = [], threat = internal.campaignThreat;
  internal.campaignThreat = function(game, player) { evaluated.push(player.id); return threat.call(this, game, player); };
  const add = (id: number, x: number, y = .006, z = 0) => {
    const p = new ServerPlayer(id, 'Candidate', null, true, { x, y, z });
    p.faction = 2; p.state.grounded = true; f.game.players.set(id, p); return p;
  };
  for (const [index, x] of [390, 390 + 1e-8, Infinity, NaN].entries()) add(90 + index, x);
  add(94, 0, 400.006);
  assert.equal(internal.acquireEnemy(f.game), null);
  assert.deepEqual(evaluated, [], 'range-ineligible actors need no campaign threat calculations');
  const inside = add(99, 390 - 1e-8);
  f.game.tick = internal.losCheckAt;
  assert.equal(internal.acquireEnemy(f.game), inside, 'the original strict 390 m boundary is retained');
  assert.ok(evaluated.every(id => id === inside.id));
  f.game.players.delete(inside.id); evaluated.length = 0;
  add(102, 0, .006, -30); const first = add(101, 0, .006, -30);
  f.game.tick = internal.losCheckAt;
  assert.equal(internal.acquireEnemy(f.game), first, 'equal-distance targets retain entity-ID tie ordering');
  assert.ok(evaluated.every(id => id === 101 || id === 102));
});
