import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { PLAYER, capsuleClearance, type InputCmd } from '@shared/index';

function cmd(seq: number): InputCmd {
  return { seq, buttons: 0, weapon: 0, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 };
}

test('standing in lava burns and kills as an environment death', () => {
  const game = new Game(1337);
  // Find a lava column in the known volcanic zone on the default seed.
  let lx = 0, lz = 0, lavaY = -1000;
  outer:
  for (let x = -4436; x <= -3436; x += 16) {
    for (let z = 1964; z <= 2964; z += 16) {
      const col = game.world.column(x, z);
      if (col.lavaY > -999 && col.lavaY-col.h>2) { lx = x; lz = z; lavaY = col.lavaY; break outer; }
    }
  }
  assert.ok(lavaY > -999, 'seed 1337 has lava in the survey zone');

  const p = game.addPlayer('Icarus', null);
  p.state.px = lx; p.state.py = lavaY - 0.6; p.state.pz = lz;
  p.state.vx = 0; p.state.vy = 0; p.state.vz = 0;

  let seq = 1;
  game.queueInput(p, cmd(seq++));
  game.step();
  assert.ok(p.health < PLAYER.MAX_HEALTH, 'lava damage begins immediately');

  let died = false;
  for (let t = 0; t < 60 * 5 && !died; t++) {
    if (p.state.alive) {
      p.state.px = lx; p.state.py = lavaY - 0.6; p.state.pz = lz;
    }
    game.queueInput(p, cmd(seq++));
    game.step();
    died = !p.state.alive;
  }
  assert.ok(died, 'sustained lava contact is lethal');
  assert.equal(p.deaths, 1);
});

test('a roofed cave beneath a lava pool is outside the surface contact band', () => {
  const game = new Game(1337);
  let witness: { x: number; y: number; z: number } | undefined;
  outer:
  for (let x = -4436; x <= -3436; x += 32) {
    for (let z = 1964; z <= 2964; z += 32) {
      const col = game.world.column(x, z);
      if (col.lavaY <= -999) continue;
      for (let y = col.h - 12; y > -44; y -= 2) {
        if (capsuleClearance(game.world, x, y, z) > 0.8 && game.world.roofedAbove(x, y + 1.7, z)) {
          witness = { x, y, z }; break outer;
        }
      }
    }
  }
  assert.ok(witness, 'survey finds an actual clear, roofed cave under a lava pool');
  const p = game.addPlayer('Underworld', null);
  Object.assign(p.state, { px: witness.x, py: witness.y, pz: witness.z, vx: 0, vy: 0, vz: 0 });
  game.queueInput(p, cmd(1));
  game.step();
  assert.equal(p.health, PLAYER.MAX_HEALTH, 'lava contact cannot extend down through the cave roof');
});
