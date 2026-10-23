// Proposed destination: packages/server/test/bot-crew-spotting.test.ts.
// Source preparation only; imports resolve after the reviewed production move.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, PLAYER, VEHICLE, WEAPONS, quantYaw, unquantYaw, vehicleDefinition,
  type CreatureState, type InputCmd, type WeaponDef } from '@shared/index';
import type { CampaignOrder } from '@shared/frontier';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';
import { readCrewBoard, type CrewBoard } from '../src/bot-crew-spotting.js';

interface BotState {
  crewSpotting: CrewBoard | undefined; enemyId: number;
  campaign(game: Game): { order: CampaignOrder; objective: undefined };
  acquireCreature(game: Game): CreatureState | null;
}
const internal = (bot: Bot) => bot as unknown as BotState;
function fixture({ type = VEHICLE.JEEP, remote = false, reverse = false }:
  { type?: ServerVehicle['type']; remote?: boolean; reverse?: boolean } = {}) {
  const game = new Game(1337), hull: ServerVehicle = { id: 800, type, x: 0, y: 0, z: 0, heading: 0,
    health: vehicleDefinition(type)!.maxHealth, occupant: 11, gunner: 12, respawnAtTick: -1 };
  Object.defineProperty(game, 'frontier', { value: { territories: [], order: () => undefined, recordCombat() {} } });
  let admitted = remote, wall = false;
  game.remoteGroundPerception = () => admitted;
  game.shouldThinkBot = () => false;
  // Controlled scheduling geometry; the canonical trace method is unchanged.
  game.world.sdf = (_x, y, z) => wall ? Math.min(y, Math.abs(z + 40) - 1) : y;
  const crew = [11, 12].map((id, seat) => {
    const p = new ServerPlayer(id, `crew${id}`, null, true, { x: 0, y: 0, z: 0 });
    p.faction = 1; p.vehicleId = hull.id;
    Object.assign(p.state, { vehicle: type, vehicleId: hull.id, seat, grounded: true });
    return p;
  });
  for (const p of reverse ? [...crew].reverse() : crew) game.players.set(p.id, p);
  game.vehicles.set(hull.id, hull);
  const enemy = new ServerPlayer(101, 'target', null, true, { x: 0, y: 0, z: -100 });
  enemy.faction = 2; enemy.state.grounded = true; game.players.set(enemy.id, enemy);
  const bots = crew.map(p => new Bot(p, 1337));
  for (const bot of bots) {
    // Assembly isolates aiming without replacing acquisition or vehicle input.
    internal(bot).campaign = () => ({ objective: undefined, order: { baseId: 'assembly', targetId: 'assembly',
      name: 'Assembly', x: 0, z: 0, phase: 'assemble', squad: 1, staging: { x: 0, y: 0, z: 0 } } });
    internal(bot).acquireCreature = () => null;
  }
  const step = (tick: number) => {
    game.tick = tick; const commands: InputCmd[] = [];
    for (const i of reverse ? [1, 0] : [0, 1]) {
      const cmd = bots[i].think(game); crew[i].lastCmd = cmd; commands[i] = cmd;
    }
    return commands;
  };
  return { game, hull, crew, bots, enemy, step, setWall: (v: boolean) => { wall = v; },
    setRemote: (v: boolean) => { admitted = v; } };
}
type Fixture = ReturnType<typeof fixture>;
const board = (f: Fixture, seat = 0) => {
  const value = internal(f.bots[seat]).crewSpotting; assert.ok(value); return value;
};

test('jeep and tank crews share observed targets independently of roster order', () => {
  for (const type of [VEHICLE.JEEP, VEHICLE.TANK] as const) {
    const outcomes: InputCmd[][][] = [];
    for (const reverse of [false, true]) {
      const f = fixture({ type, reverse }), commands: InputCmd[][] = [], scans: number[] = [];
      for (let tick = 0; tick <= 18; tick++) {
        commands.push(f.step(tick)); if (board(f).lastScanTick === tick) scans.push(tick);
      }
      assert.deepEqual(scans, [0, 9, 18]);
      assert.equal(board(f), board(f, 1));
      assert.equal(internal(f.bots[0]).enemyId, f.enemy.id);
      assert.equal(internal(f.bots[1]).enemyId, f.enemy.id);
      assert.ok(commands[0].every(cmd => cmd.buttons & BTN.FIRE));
      outcomes.push(commands);
    }
    assert.deepEqual(outcomes[1], outcomes[0]);
  }
});

test('hidden target motion does not update shared aim, and fresh cover clears retained fire', () => {
  const f = fixture(); f.step(0); const first = board(f).observation;
  assert.ok(first); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.state));
  let reads = 0;
  Object.defineProperty(f.enemy.state, 'px', { configurable: true, get() { reads++; return 30; } });
  f.setWall(true); const previous = f.crew.map(p => p.lastCmd);
  for (let tick = 1; tick < 9; tick++) assert.deepEqual(f.step(tick), previous);
  assert.equal(reads, 0); assert.equal(board(f).observation, first); assert.equal(first.state.px, 0);
  const commands = f.step(9); assert.ok(reads > 0);
  assert.equal(board(f).observation, null); assert.ok(commands.every(cmd => !(cmd.buttons & BTN.FIRE)));
});

test('target and crew lifecycle changes revoke observations before deferred input returns', () => {
  const changes: ((f: Fixture) => void)[] = [
    f => { f.enemy.state.alive = false; }, f => { f.enemy.faction = 1; },
    f => { f.game.players.delete(f.enemy.id); }, f => { f.enemy.state = { ...f.enemy.state }; },
    f => { f.enemy.state.grounded = false; }, f => { f.enemy.state.seat = 1; },
    f => { f.enemy.state.vehicleVariant = 1; },
    f => { const q = new ServerPlayer(f.enemy.id, 'replacement', null, true, { x: 0, y: 0, z: -100 });
      q.faction = 2; f.game.players.set(q.id, q); },
  ];
  for (const change of changes) {
    const f = fixture(); f.step(0); const old = board(f).observation; change(f); f.step(1);
    assert.equal(board(f).lastScanTick, 1); assert.notEqual(board(f).observation, old);
  }
  for (const seat of [0, 1]) {
    const f = fixture(); f.step(0); const old = board(f);
    f.crew[seat].state = { ...f.crew[seat].state }; f.step(1); assert.notEqual(board(f), old);
  }
});

test('same-tick replacement and human takeover cannot grant a second shared scan', () => {
  const f = fixture(); f.step(0); f.crew[1].state = { ...f.crew[1].state };
  assert.ok(f.step(0).every(cmd => !(cmd.buttons & BTN.FIRE))); assert.equal(board(f).nextScanAt, 1);
  Object.defineProperty(f.crew[1], 'isBot', { value: false, configurable: true }); f.step(0);
  assert.equal(internal(f.bots[0]).crewSpotting, undefined);
  Object.defineProperty(f.crew[1], 'isBot', { value: true, configurable: true });
  assert.ok(f.step(0).every(cmd => !(cmd.buttons & BTN.FIRE))); assert.equal(board(f).nextScanAt, 1);
  f.step(1); assert.equal(board(f).lastScanTick, 1); assert.ok(board(f).observation);
});

test('solo, custom observer/provider and unsupported crews retain individual fallback', () => {
  const changes: ((f: Fixture) => void)[] = [
    f => { f.hull.gunner = -1; }, f => { f.hull.transportRoute = 5; },
    f => { f.crew[0].state.grounded = false; },
    f => { Object.defineProperty(f.crew[1], 'sink', { value: { send() {} } }); },
    f => { f.game.world.trace = f.game.world.trace.bind(f.game.world); },
  ];
  for (const change of changes) {
    const f = fixture(); f.step(0); change(f); f.step(1);
    assert.equal(internal(f.bots[0]).crewSpotting, undefined);
    assert.equal(internal(f.bots[0]).enemyId, f.enemy.id, 'individual canonical acquisition remains active');
  }
  for (const type of [VEHICLE.JET, VEHICLE.GUNBOAT] as const) {
    const f = fixture({ type });
    assert.equal(readCrewBoard(f.game, f.crew[1], 390, () => { throw Error('unsupported shared scan'); }), undefined);
  }
});

test('remote deadlines promote immediately; burst damage does not repeatedly reset LOS cadence', () => {
  const f = fixture({ remote: true }), scans: number[] = [];
  for (let tick = 0; tick <= 48; tick++) { f.step(tick); if (board(f).lastScanTick === tick) scans.push(tick); }
  assert.deepEqual(scans, [0, 24, 48]);
  f.setRemote(false); f.step(49); assert.equal(board(f).lastScanTick, 49); assert.equal(board(f).nextScanAt, 58);
  f.step(50); assert.equal(board(f).lastScanTick, 49);
  const hurt = fixture({ remote: true }), damageScans: number[] = [];
  for (let tick = 0; tick <= 90; tick++) {
    if (tick >= 5 && tick <= 29 && (tick - 5) % 4 === 0) {
      hurt.crew[0].health--; hurt.hull.health--; hurt.crew[1].regenBlockUntil = tick + 300;
    }
    hurt.step(tick); if (board(hurt).lastScanTick === tick) damageScans.push(tick);
  }
  assert.deepEqual(damageScans, [0, 5, 14, 23, 32, 41, 50, 59, 68, 77, 86]);
});

test('current crew range and actual replacement hull invalidate retained reports', () => {
  const f = fixture(); f.enemy.state.pz = -380; f.step(0); assert.ok(f.crew[1].lastCmd!.buttons & BTN.FIRE);
  for (let tick = 1; tick <= 4; tick++) {
    for (const p of f.crew) p.state.pz = tick * 3; f.hull.z = tick * 3; f.step(tick);
  }
  assert.equal(board(f).observation, null); assert.equal(f.crew[1].lastCmd!.buttons & BTN.FIRE, 0);
  const g = fixture(); g.step(0); const old = board(g), replacement = { ...g.hull };
  g.game.vehicles.set(replacement.id, replacement); g.step(1);
  assert.notEqual(board(g), old); assert.equal(board(g).hull, replacement);
});

test('an empty crew report leaves each seat free to defend against a creature', () => {
  const f = fixture(); f.game.players.delete(f.enemy.id);
  const creature: CreatureState = { id: 8000, x: 10, y: 0, z: -20, species: 0, yaw: 0, speed: 0, alert: true };
  for (const bot of f.bots) internal(bot).acquireCreature = () => creature;
  const commands = f.step(0); assert.equal(board(f).observation, null);
  assert.ok(commands.every(cmd => cmd.buttons & BTN.FIRE));
  assert.equal(commands[1].yaw, unquantYaw(quantYaw(Math.atan2(-10, 20))));
});

test('held reports cannot bypass current wall or hull collision for a directed gunner hitscan', () => {
  const f = fixture(); f.step(0);
  const command = { ...f.crew[1].lastCmd!, yaw: 0, pitch: 0 }, def = { ...WEAPONS[1], spread: 0, range: 150 };
  const game = f.game as unknown as { fireHitscan(p: ServerPlayer, cmd: InputCmd, def: WeaponDef,
    attachment: { x: number; y: number; z: number }): void };
  const shoot = () => game.fireHitscan(f.crew[1], command, def, { x: 0, y: PLAYER.EYE_HEIGHT, z: 0 });
  f.setWall(true); f.step(1); assert.ok(f.crew[1].lastCmd!.buttons & BTN.FIRE); shoot(); assert.equal(f.enemy.health, 100);
  f.setWall(false); const cover: ServerVehicle = { id: 801, type: VEHICLE.JEEP, x: 0, y: 0, z: -40,
    heading: 0, health: 1000, occupant: -1, respawnAtTick: -1 };
  f.game.vehicles.set(cover.id, cover); shoot(); assert.ok(cover.health < 1000); assert.equal(f.enemy.health, 100);
  f.game.vehicles.delete(cover.id); shoot(); assert.ok(f.enemy.health < 100);
});
