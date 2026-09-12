import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLAYER, WEAPONS, type WeaponDef } from '@shared/index';
import { Game, type ServerPlayer } from '../src/game.js';

test('grenade splash reaches the expanded edge without bypassing cover', () => {
  const game = new Game(1337);
  const edge = game.addPlayer('Edge', null), outside = game.addPlayer('Outside', null);
  const covered = game.addPlayer('Cover', null);
  for (const [player, x, z] of [[edge, 12.5, 0], [outside, 14, 0], [covered, 0, 6]] as const) {
    Object.assign(player.state, { px: x, py: 400, pz: z, vx: 0, vy: 0, vz: 0, alive: true });
    player.health = 100;
  }
  const trace = game.world.trace.bind(game.world);
  game.world.trace = (x, y, z, dx, dy, dz, distance) => dz > 0.5
    ? { hit: true, x, y, z: z + 1, nx: 0, ny: 0, nz: -1, dist: 1 }
    : trace(x, y, z, dx, dy, dz, distance);
  const internal = game as unknown as {
    explode(x: number, y: number, z: number, owner: ServerPlayer | null,
      def: WeaponDef, directId: number, projectileId: number): void;
  };
  internal.explode(0, 400 + PLAYER.RADIUS, 0, null, WEAPONS[4], -1, 900);
  assert.ok(edge.health < 100 && edge.health > 85, 'a near miss beyond the old radius does modest edge damage');
  assert.equal(outside.health, 100, 'distant targets stay outside the blast');
  assert.equal(covered.health, 100, 'solid cover still blocks splash');
  assert.equal(covered.state.vz, 0, 'solid cover also blocks radial push');
});
