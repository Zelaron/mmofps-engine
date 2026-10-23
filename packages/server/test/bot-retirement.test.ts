import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, type InputCmd } from '@shared/movement';
import { VEHICLE, weaponDefById, HOMING_RANGE_FACTOR } from '@shared/vehicles';
import type { Territory } from '@shared/frontier';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer, type Projectile, type ServerVehicle } from '../src/game.js';
import { campaignTravelOrders } from '../src/bot-campaign-state.js';
import { campaignSquad } from '../src/campaign-director.js';
import { selectAdaptiveRetirements, createAdaptiveRetirementDiagnostics, ADAPTIVE_RETIREMENT_HUMAN_RADIUS,
  ADAPTIVE_RETIREMENT_CONTROL_MARGIN,
  ADAPTIVE_RETIREMENT_PROJECTILE_RADIUS } from '../src/bot-retirement.js';

function fixture() {
  const territories: Territory[] = [];
  const game = { tick: 0, players: new Map<number, ServerPlayer>(),
    vehicles: new Map<number, ServerVehicle>(), projectiles: new Map<number, Projectile>(),
    frontier: { territories } as NonNullable<Game['frontier']>, areEnemies: Game.prototype.areEnemies };
  const bots: Bot[] = [];
  const add = (ordinal: number, faction: 1 | 2 | 3 = 1, x = 3000 + faction * 3000, z = ordinal * 10) => {
    const p = new ServerPlayer(100 + ordinal, 'Soldier' + ordinal, null, true, { x, y: .1, z });
    p.botRosterIndex = ordinal; p.faction = faction; p.state.grounded = true; p.fireCd = 0;
    game.players.set(p.id, p); const bot = new Bot(p, 1337); bots.push(bot); return bot;
  };
  const human = (x = 0, z = 0) => {
    const p = new ServerPlayer(10000, 'Observer', null, false, { x, y: .1, z });
    p.faction = 1; game.players.set(p.id, p); return p;
  };
  const select = (count = 24, protect: (bot: Bot) => boolean = () => false) =>
    selectAdaptiveRetirements(game, bots, count, protect);
  return { game, bots, territories, add, human, select };
}
const command = (buttons: number): InputCmd => ({ seq: 1, buttons, yaw: 0, pitch: 0,
  weapon: 1, renderTick: 0, renderFrac: 0 });
const projectile = (owner: number, x = -9000, y = 50, z = -9000): Projectile => ({
  id: 1, owner, weapon: 3, x, y, z, vx: 0, vy: 0, vz: 0, distLeft: 500,
  fuseLeft: 3, ageSeconds: 0, sleeping: false,
});

test('dead unprotected bots retire first, but never erase their remaining projectiles', () => {
  const f = fixture(), alive = f.add(0), companion = f.add(3), dead = f.add(6, 1, 0, 0), armedDead = f.add(9, 1, 0, 0);
  f.human(); dead.player.state.alive = armedDead.player.state.alive = false;
  f.game.projectiles.set(1, projectile(armedDead.player.id));
  const result = f.select(3);
  assert.equal(result[0], dead, 'already dead actor may retire near an observer');
  assert.ok(!result.includes(armedDead), 'removePlayer would otherwise delete its explosive');
  assert.equal(result.length, 2, 'retain one living member of the remaining squad');
  assert.ok(result.includes(alive) || result.includes(companion));
  assert.equal(f.game.projectiles.size, 1); assert.equal(f.game.players.size, 5);
});

test('ownership, actual hull membership, airlift and orbital duties are protected even while dead', () => {
  for (const mode of ['callback', 'travel', 'vehicle-id', 'state-hull', 'seat', 'driver', 'gunner', 'airlift', 'state-airlift', 'sink', 'detached']) {
    const f = fixture(), p = f.add(0).player, bot = f.bots[0]; p.state.alive = false;
    if (mode === 'travel') campaignTravelOrders.set(p, {} as NonNullable<ReturnType<typeof campaignTravelOrders.get>>);
    if (mode === 'vehicle-id') p.vehicleId = 12;
    if (mode === 'state-hull') p.state.vehicleId = 12;
    if (mode === 'seat') p.state.seat = 2;
    if (mode === 'driver' || mode === 'gunner') f.game.vehicles.set(12,
      { id: 12, occupant: mode === 'driver' ? p.id : -1, gunner: mode === 'gunner' ? p.id : -1 } as ServerVehicle);
    if (mode === 'airlift') p.airlift = {} as NonNullable<ServerPlayer['airlift']>;
    if (mode === 'state-airlift') p.state.airlift = {} as NonNullable<ServerPlayer['state']['airlift']>;
    if (mode === 'sink') Object.defineProperty(p, 'sink', { value: { send() {} } });
    if (mode === 'detached') f.game.players.delete(p.id);
    assert.deepEqual(f.select(1, b => mode === 'callback' && b === bot), [], mode);
  }
});

test('living bots stay beyond observer interest, including dead humans and observed bots', () => {
  for (const kind of ['human', 'dead-human', 'observed-bot']) {
    const f = fixture(), bot = f.add(0, 1, ADAPTIVE_RETIREMENT_HUMAN_RADIUS, 0); f.add(3, 1, 10000, 0);
    const observer = f.human();
    if (kind === 'dead-human') observer.state.alive = false;
    if (kind === 'observed-bot') {
      Object.defineProperty(observer, 'isBot', { value: true });
      Object.defineProperty(observer, 'sink', { value: { send() {} } });
    }
    assert.ok(!f.select().includes(bot), kind + ': inclusive visibility boundary');
    bot.player.state.px += .01;
    assert.ok(f.select(1).includes(bot), kind + ': outside the conservative observer radius');
  }
});

test('spawn, critical actions and approaching projectiles remain hard protections for distant infantry', () => {
  for (const mode of ['spawn', 'fall', 'recall', 'use', 'queued-use', 'projectile', 'homing']) {
    const f = fixture(), bot = f.add(0, 1, 6000, 0), p = bot.player; f.add(3, 1, 10000, 0);
    if (mode === 'spawn') p.spawnProtectedUntil = f.game.tick + 1;
    if (mode === 'fall') p.fallCreditUntilTick = f.game.tick;
    if (mode === 'recall') p.recallSince = f.game.tick;
    if (mode === 'use') p.lastCmd = command(BTN.USE);
    if (mode === 'queued-use') p.inputQueue.push(command(BTN.USE));
    if (mode === 'projectile' || mode === 'homing') {
      const r = projectile(999, p.state.px + ADAPTIVE_RETIREMENT_PROJECTILE_RADIUS, p.state.py, 0);
      if (mode === 'homing') { r.x = -9000; r.homingTarget = p.id; }
      f.game.projectiles.set(r.id, r);
    }
    assert.ok(!f.select().includes(bot), mode);
  }
});

test('dead then quiet actors precede distant active infantry, whose ordinary combat can shed load', () => {
  const f = fixture(), dead = f.add(0), quiet = f.add(3), active = f.add(6), witness = f.add(9);
  dead.player.state.alive = false; active.player.lastCmd = command(BTN.FIRE);
  const diagnostics = createAdaptiveRetirementDiagnostics();
  assert.deepEqual(selectAdaptiveRetirements(f.game, f.bots, 3, b => b === witness, diagnostics), [dead, quiet, active]);
  assert.deepEqual(diagnostics.selectedByTier, { dead: 1, quiet: 1, active: 1 });
  assert.equal(diagnostics.excluded['transfer-or-arrival'], 1);
  for (const mode of ['damage', 'lock', 'fire', 'recent-fire', 'reload', 'queued', 'control-margin']) {
    const g = fixture(), bot = g.add(0), kept = g.add(3, 1, 10000, 0), p = bot.player;
    if (mode === 'damage') p.regenBlockUntil = g.game.tick + 60;
    if (mode === 'lock') p.lockTicks = 1;
    if (mode === 'fire') p.lastCmd = command(BTN.FIRE);
    if (mode === 'recent-fire') p.fireCd = .05;
    if (mode === 'reload') p.reloadCd = .5;
    if (mode === 'queued') p.inputQueue.push(command(BTN.ALTFIRE));
    if (mode === 'control-margin') g.territories.push({ id: 'held', name: 'Held', kind: 'relay',
      x: p.state.px + 30 + ADAPTIVE_RETIREMENT_CONTROL_MARGIN, y: p.state.py, z: p.state.pz,
      radius: 30, owner: 1, influence: 1, contested: false });
    assert.deepEqual(selectAdaptiveRetirements(g.game, g.bots, 1, b => b === kept, diagnostics), [bot], mode);
    assert.equal(diagnostics.selectedByTier.active, 1, mode);
    assert.equal(diagnostics.selectedByTier.dead, 0, 'the supplied report resets each attempt');
    g.human(p.state.px, p.state.pz);
    assert.ok(!g.select().includes(bot), mode + ': human interaction still wins');
  }
});

test('actual capture volumes and fight sectors retain faction witnesses without forbidding surplus retirement', () => {
  for (const kind of ['capture', 'fight']) {
    const f = fixture();
    const a = f.add(0, 1, 6200, 0), b = f.add(18, 1, 6201, 0);
    const companions = [f.add(3, 1, 10000, 0), f.add(21, 1, 11000, 0)];
    const opposed = kind === 'fight' ? [f.add(1, 2, 6202, 0), f.add(19, 2, 6203, 0)] : [];
    if (kind === 'fight') companions.push(f.add(4, 2, 12000, 0), f.add(22, 2, 13000, 0));
    if (kind === 'capture') f.territories.push({ id: 'contested', name: 'Control', kind: 'relay',
      x: 6200, y: .1, z: 0, radius: 30, owner: 1, influence: 1, contested: true });
    const diagnostics = createAdaptiveRetirementDiagnostics();
    const selected = selectAdaptiveRetirements(f.game, f.bots, 24, bot => companions.includes(bot), diagnostics);
    assert.equal([a, b].filter(bot => selected.includes(bot)).length, 1, kind + ': one defender remains');
    if (kind === 'fight') assert.equal(opposed.filter(bot => selected.includes(bot)).length, 1, 'one attacker remains');
    const expected = kind === 'fight' ? 2 : 1;
    assert.equal(diagnostics.selectedByTier.active, expected);
    assert.equal(diagnostics.witnessBlocked.operation, expected);
    assert.equal(diagnostics.unfilled, 24 - expected);
  }
  // Actual vertical capture presence, not the broad attention margin, owns a witness.
  const f = fixture(), bot = f.add(0, 1, 6000, 0), kept = f.add(3, 1, 10000, 0);
  f.territories.push({ id: 'below', name: 'Below', kind: 'relay', x: 6000, y: -10, z: 0,
    radius: 30, owner: 1, influence: 1, contested: false });
  assert.deepEqual(f.select(1, b => b === kept), [bot]);
});

test('human boosted rockets and large bot blast footprints protect otherwise distant recipients', () => {
  const f = fixture(), bot = f.add(0, 1, 2300, 0), kept = f.add(3, 1, 10000, 0), h = f.human();
  const rocket = projectile(h.id, 1200, .1, 0), def = weaponDefById(rocket.weapon)!;
  rocket.distLeft = def.range * HOMING_RANGE_FACTOR;
  assert.ok(bot.player.state.px - rocket.x > def.range + (def.splashRadius ?? 0) + 30,
    'recipient is beyond the base weapon range clamp');
  f.game.projectiles.set(rocket.id, rocket);
  const diagnostics = createAdaptiveRetirementDiagnostics();
  assert.deepEqual(selectAdaptiveRetirements(f.game, f.bots, 1, b => b === kept, diagnostics), []);
  assert.equal(diagnostics.excluded['projectile-recipient'], 1);
  rocket.distLeft = NaN;
  assert.deepEqual(f.select(1, b => b === kept), [], 'invalid remaining distance is conservative');
  f.game.projectiles.clear();
  const nuke = projectile(999, bot.player.state.px + 200, .1, 0); nuke.weapon = 102;
  assert.ok(200 > ADAPTIVE_RETIREMENT_PROJECTILE_RADIUS);
  assert.ok(200 < weaponDefById(102)!.splashRadius! + 30);
  f.game.projectiles.set(nuke.id, nuke);
  assert.deepEqual(f.select(1, b => b === kept), [], 'large blast recipients survive even without a human owner');
  f.game.projectiles.clear();
  assert.deepEqual(f.select(1, b => b === kept), [bot], 'actor is otherwise eligible');
});

test('only supported ordinary foot travel is eligible; quiet marching need not be stationary', () => {
  for (const mode of ['air', 'water', 'submerged', 'jump', 'vehicle', 'invalid']) {
    const f = fixture(), bot = f.add(0); f.add(3);
    if (mode === 'air') bot.player.state.grounded = false;
    if (mode === 'water') bot.player.state.swimming = true;
    if (mode === 'submerged') bot.player.state.submerged = true;
    if (mode === 'jump') bot.player.state.jumpAscent = true;
    if (mode === 'vehicle') bot.player.state.vehicle = VEHICLE.JEEP;
    if (mode === 'invalid') bot.player.state.px = NaN;
    assert.ok(!f.select().includes(bot), mode);
  }
  const f = fixture(), marcher = f.add(0); f.add(3);
  marcher.player.lastCmd = command(BTN.FORWARD); marcher.player.state.vx = 7;
  assert.deepEqual(f.select(1), [marcher]);
});

test('retirement balances overrepresented factions and squads while preserving a distant squad witness', () => {
  const f = fixture();
  for (const ordinal of [0, 3, 6, 18, 21, 24]) f.add(ordinal, 1);
  for (const ordinal of [1, 4, 7]) f.add(ordinal, 2);
  for (const ordinal of [2, 5, 8]) f.add(ordinal, 3);
  const first = f.select(3);
  assert.ok(first.every(bot => bot.player.faction === 1), 'reduce the surplus faction first');
  const result = f.select(50), remaining = f.bots.filter(bot => !result.includes(bot));
  const factions = [1, 2, 3].map(id => remaining.filter(b => b.player.faction === id).length);
  assert.deepEqual(factions, [2, 1, 1], 'one living witness remains in each faction/squad');
  assert.equal(new Set(remaining.map(bot => bot.player.faction + ':' + campaignSquad(bot.player))).size, 4);
  assert.equal(new Set(result).size, result.length);
  assert.deepEqual(f.select(3), first, 'same input yields the same choices');
});

test('selection is nonmutating and returns fewer rather than forcing a protected retirement', () => {
  const f = fixture(), a = f.add(0), b = f.add(3);
  const before = { bots: [...f.bots], players: [...f.game.players], states: f.bots.map(bot => structuredClone(bot.player.state)) };
  assert.deepEqual(f.select(24, () => true), []);
  assert.deepEqual(f.select(0), []); assert.deepEqual(f.select(NaN), []);
  const result = selectAdaptiveRetirements(f.game, [a, a, b], 24, () => false);
  assert.equal(result.length, 1, 'duplicate roster references cannot be selected twice');
  assert.deepEqual(f.bots, before.bots); assert.deepEqual([...f.game.players], before.players);
  assert.deepEqual(f.bots.map(bot => bot.player.state), before.states);
});
