import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, type InputCmd } from '@shared/index';
import { harborStairs } from '@shared/transport';
import { Game, ServerPlayer } from '../src/game.js';
import { Bot } from '../src/bots.js';
import type { Frontier } from '../src/frontier.js';
import type { CampaignOrder, Territory } from '@shared/frontier';

const command = (seq: number, buttons: number, yaw: number): InputCmd => ({ seq, buttons, yaw, pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 });

test('a swimmer climbs every harbor quay by its stairs', () => {
  const game = new Game(1337);
  for (const harbor of game.world.collectTransportPlan().harbors) for (const stair of harborStairs(harbor)) {
    const p = game.addPlayer(`Swimmer ${harbor.id}`, null);
    Object.assign(p.state, { px: stair.footX, py: harbor.y - 1.2, pz: stair.footZ, vx: 0, vy: 0, vz: 0, grounded: false });
    const quayTop = game.world.groundY(stair.topX, stair.topZ);
    for (let i = 0; i < 900 && Math.hypot(p.state.px - stair.topX, p.state.pz - stair.topZ) > .8; i++) {
      game.queueInput(p, command(p.lastQueuedSeq + 1, BTN.FORWARD, Math.atan2(-(stair.topX - p.state.px), -(stair.topZ - p.state.pz))));
      game.step();
    }
    assert.ok(Math.abs(p.state.py - quayTop) < .3 && !p.state.swimming,
      `${harbor.name}: out of the water on the quay (y ${p.state.py.toFixed(2)}, quay ${quayTop.toFixed(2)})`);
    game.removePlayer?.(p.id);
  }
});

test('a swimming bot ordered onto a quay climbs out by its stairs instead of paddling along the wall', () => {
  const game = new Game(1337);
  const harbor = game.world.collectTransportPlan().harbors[0], stair = harborStairs(harbor)[0];
  const outX = stair.footX - stair.topX, outZ = stair.footZ - stair.topZ, inward = Math.hypot(outX, outZ);
  const p = new ServerPlayer(4294967872, 'Swimming bot', null, true,
    { x: stair.footX + outX * 5, y: harbor.y - 1.2, z: stair.footZ + outZ * 5 });
  p.botRosterIndex = 20; p.faction = 1; p.weapon = 1;
  game.players.set(p.id, p); game.pickups.clear(); game.vehicles.clear(); game.wildlife.creatures.clear();
  const goal = { x: stair.topX - outX / inward * 8, z: stair.topZ - outZ / inward * 8 };
  const objective: Territory = { id: 'quay-relay', name: 'Quay relay', kind: 'relay', x: goal.x, y: harbor.y + 2, z: goal.z,
    radius: 6, owner: 2, influence: 1, contested: false };
  const order: CampaignOrder = { baseId: 'base-harbor', targetId: objective.id, name: 'Capture the quay', x: goal.x, z: goal.z,
    phase: 'attack', squad: 1, staging: { x: goal.x, y: harbor.y + 2, z: goal.z } };
  Object.defineProperty(game, 'frontier', { value: { territories: [objective], order: () => order, step: () => {}, send: () => {},
    protectedAreas: () => [], spawnOptions: () => [] } as unknown as Frontier });
  game.shouldThinkBot = () => true;
  const bot = new Bot(p, 1337), quayTop = game.world.groundY(stair.topX, stair.topZ);
  let i = 0;
  for (; i < 60 * 60 && !(Math.abs(p.state.py - quayTop) < .3 && !p.state.swimming); i++) { game.queueInput(p, bot.think(game)); game.step(); }
  assert.ok(Math.abs(p.state.py - quayTop) < .3 && !p.state.swimming,
    `climbed onto the quay (y ${p.state.py.toFixed(2)} at ${p.state.px.toFixed(0)},${p.state.pz.toFixed(0)}, swimming ${p.state.swimming})`);
  assert.ok(i < 60 * 40, `within ${(i / 60).toFixed(0)} s`);
});
