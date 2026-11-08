import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, TICK_RATE, VEHICLE, VEHICLE_VARIANT } from '@shared/index';
import { Game, vehicleDistrictActive, type ServerPlayer } from '../src/game.js';

test('stationary cavern recall reaches daylight and cancels on movement, firing or damage', () => {
  const game = new Game(1337, { teleporters: true });
  const player = game.addPlayer('Explorer', null);
  const cave = game.teleporterPads.find(p => p.cave)!;
  Object.assign(player.state, { px: cave.x, py: cave.y, pz: cave.z, vx: 0, vy: 0, vz: 0, grounded: true });
  player.lastCmd = { seq: 1, buttons: BTN.USE, weapon: 0, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 };
  const internal = game as unknown as { updateCaveRecall(): void; updateTeleporters(): void };
  const run = (ticks: number) => { for (let i = 0; i < ticks; i++) { game.tick++; internal.updateCaveRecall(); } };
  run(100); assert.ok(player.recallSince >= 0);
  player.state.px += 1; run(1); assert.equal(player.recallSince, -1);
  run(1); player.health--; run(1); assert.equal(player.recallSince, -1);
  run(1); player.lastCmd.buttons |= BTN.FIRE; run(1); assert.equal(player.recallSince, -1);
  player.lastCmd.buttons = BTN.USE;
  run(4 * TICK_RATE); assert.ok(player.state.py < game.world.terrainHeight(player.state.px, player.state.pz) - 2);
  run(2);
  assert.ok(game.teleporterPads.some(p => !p.cave && Math.hypot(p.x - player.state.px, p.z - player.state.pz) < .1));
  assert.equal(player.teleportArmed, false);
  const y = player.state.py; internal.updateTeleporters(); assert.equal(player.state.py, y, 'recall cannot ping-pong back underground');
  assert.equal(player.state.vehicle, VEHICLE.NONE);
});

test('surface buildings and airborne or vehicle occupants cannot trigger cave recall', () => {
  const game = new Game(1337, { teleporters: true }), p = game.addPlayer('Visitor', null);
  const internal = game as unknown as { updateCaveRecall(): void };
  p.lastCmd = { seq: 1, buttons: BTN.USE, weapon: 0, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 };
  p.state.grounded = true;
  game.world.roofedAbove = () => true; game.world.terrainHeight = () => p.state.py;
  internal.updateCaveRecall(); assert.equal(p.recallSince, -1, 'a building roof is not a cave');
  game.world.terrainHeight = () => p.state.py + 20;
  p.state.grounded = false; internal.updateCaveRecall(); assert.equal(p.recallSince, -1);
  p.state.grounded = true; p.state.vehicle = VEHICLE.JEEP;
  internal.updateCaveRecall(); assert.equal(p.recallSince, -1);
});

test('damage interrupts a nearly complete recall even after health regeneration raised the starting health', () => {
  const game = new Game(1337, { teleporters: true }), player = game.addPlayer('Recovering explorer', null);
  const cave = game.teleporterPads.find(p => p.cave)!;
  Object.assign(player.state, { px: cave.x, py: cave.y, pz: cave.z, vx: 0, vy: 0, vz: 0, grounded: true });
  player.health = 50;
  player.lastCmd = { seq: 1, buttons: BTN.USE, weapon: 0, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 };
  const internal = game as unknown as {
    updateCaveRecall(): void;
    updateRespawnsAndRegen(): void;
    damage(victim: ServerPlayer, amount: number, attacker: ServerPlayer, weapon: number, x: number, y: number, z: number): void;
  };
  const run = (ticks: number) => {
    for (let i = 0; i < ticks; i++) {
      game.tick++; internal.updateCaveRecall(); internal.updateRespawnsAndRegen();
    }
  };
  run(4 * TICK_RATE - 4);
  assert.ok(player.health > player.recallAnchor.health + 1, 'real regeneration must cover more than the upcoming hit');
  internal.damage(player, 1, player, 0, 0, 0, 0);
  assert.ok(player.health > player.recallAnchor.health,
    'comparing only with initial health would incorrectly preserve this recall');
  assert.equal(player.recallSince, -1, 'damage cancels immediately, regardless of health gained during the hold');
  run(8);
  assert.ok(Math.hypot(player.state.px - cave.x, player.state.py - cave.y, player.state.pz - cave.z) < .1,
    'the former completion tick must not transport the player');
  player.lastCmd.buttons |= BTN.HYPER;
  const currentStart = player.recallSince;
  internal.damage(player, 10, player, 0, 0, 0, 0);
  assert.equal(player.recallSince, currentStart, 'an immunity-blocked hit is not damage');
  player.lastCmd.buttons = BTN.USE;
  run(4 * TICK_RATE);
  assert.ok(game.teleporterPads.some(p => !p.cave && Math.hypot(p.x - player.state.px, p.z - player.state.pz) < .1),
    'a fresh uninterrupted hold can still complete normally');
});

test('surface vehicle districts are quarter density with intact local motor pools', () => {
  let enabled = 0;
  for (let z = -32; z < 32; z++) for (let x = -32; x < 32; x++) if (vehicleDistrictActive(1337, x, z)) enabled++;
  assert.ok(enabled > 900 && enabled < 1150, `expected about25percent active districts, got${enabled}/4096`);
  const game = new Game(1337, { vehicles: true });
  const ordinary = [...game.vehicles.values()].filter(v => !v.variant && v.type !== VEHICLE.GUNBOAT);
  assert.ok(ordinary.length <= 17, 'legacy roster is also reduced to a quarter');
  assert.equal([...game.vehicles.values()].filter(v => v.variant && v.variant !== VEHICLE_VARIANT.RAIL && v.variant !== VEHICLE_VARIANT.DESTROYER).length, 2,
    'the separate capital reward roster stays bounded');
  assert.equal([...game.vehicles.values()].filter(v => v.type === VEHICLE.GUNBOAT && !v.variant).length, 5);
  assert.equal([...game.vehicles.values()].filter(v => v.variant === VEHICLE_VARIANT.DESTROYER).length, 2, 'two moored destroyers');
  assert.equal([...game.vehicles.values()].filter(v => v.variant === VEHICLE_VARIANT.RAIL).length, 7);
});
