import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, TICK_DT, VEHICLE, WEAPONS, stepWeaponState } from '@shared/index';
import { Bot } from '../src/bots.js';
import { Game, ServerPlayer, type ServerVehicle } from '../src/game.js';

const ROCKET = 3, RIFLE = 1, SIDEARM = 0;
function fixture() {
  const player = new ServerPlayer(13, 'Traveling AA specialist', null, true, { x: 0, y: 0, z: 0 });
  player.faction = 1; player.weapon = ROCKET; player.state.grounded = true;
  const game = { tick: 0, areEnemies: Game.prototype.areEnemies,
    players: new Map([[player.id, player]]), vehicles: new Map<number, ServerVehicle>(),
    world: { trace: (_x:number,_y:number,_z:number,_dx:number,_dy:number,_dz:number,distance:number) =>
      ({ hit: false, dist: distance }) } } as unknown as Game;
  const bot = new Bot(player, 1337);
  const advance = () => {
    const command = bot.think(game);
    const weapon = stepWeaponState(player, command.weapon, command.buttons, TICK_DT);
    player.lastCmd = command; game.tick++;
    return { command, weapon };
  };
  return { player, game, bot, advance };
}

test('quiet infantry stows a loaded launcher for a loaded conventional travel weapon', () => {
  for (const [rifle, sidearm, expected] of [[1,1,RIFLE], [0,1,SIDEARM], [0,0,ROCKET]]) {
    const f = fixture();
    f.player.ammo[RIFLE].magazine = rifle;
    f.player.ammo[SIDEARM].magazine = sidearm;
    const { command } = f.advance();
    assert.equal(command.weapon, expected);
    assert.ok(command.buttons & BTN.FORWARD, 'the bot still follows its ordinary travel course');
    assert.equal(command.buttons & (BTN.FIRE | BTN.RELOAD), 0);
    assert.equal(f.player.weapon, expected, 'the ordinary input weapon state applies the stow');
    assert.equal(f.player.ammo[ROCKET].magazine, WEAPONS[ROCKET].magazineSize);
  }
});

test('quiet launcher top-off completes before stowing and active reloads are never canceled', () => {
  const f = fixture();
  f.player.ammo[ROCKET].magazine = 1;
  const reserve = f.player.ammo[ROCKET].reserve;
  const first = f.advance();
  assert.equal(first.command.weapon, ROCKET);
  assert.ok(first.command.buttons & BTN.RELOAD);
  assert.equal(first.weapon.reloadStartedWeapon, ROCKET);
  let reloadTicks = 0;
  while (f.player.reloadWeapon >= 0 && reloadTicks++ < 500) {
    const { command } = f.advance();
    assert.equal(command.weapon, ROCKET, 'a loaded rifle must not cancel the launcher reload');
    assert.equal(command.buttons & (BTN.RELOAD | BTN.FIRE), 0);
  }
  assert.ok(reloadTicks > 1 && reloadTicks < 500, 'the finite authoritative reload completes');
  assert.equal(f.player.ammo[ROCKET].magazine, WEAPONS[ROCKET].magazineSize);
  assert.equal(f.player.ammo[ROCKET].reserve, reserve - (WEAPONS[ROCKET].magazineSize - 1));
  assert.equal(f.advance().command.weapon, RIFLE, 'completed reload leaves the rifle ready for the journey');
});

test('quiet launcher top-off releases a held reload input before queuing its new edge', () => {
  const f = fixture();
  f.player.ammo[ROCKET].magazine = 1; f.player.reloadHeld = true;
  const released = f.advance();
  assert.equal(released.command.weapon, ROCKET);
  assert.equal(released.command.buttons & BTN.RELOAD, 0);
  const reloaded = f.advance();
  assert.equal(reloaded.command.weapon, ROCKET);
  assert.ok(reloaded.command.buttons & BTN.RELOAD);
  assert.equal(reloaded.weapon.reloadStartedWeapon, ROCKET);
});

test('a traveling AA specialist immediately re-equips its stowed launcher for an aircraft', () => {
  const f = fixture();
  assert.equal(f.advance().command.weapon, RIFLE);
  const pilot = new ServerPlayer(90, 'Enemy pilot', null, false, { x: 0, y: 130, z: -550 });
  pilot.faction = 2; pilot.vehicleId = 992;
  Object.assign(pilot.state, { vehicle: VEHICLE.JET, vehicleId: 992, grounded: false });
  f.game.players.set(pilot.id, pilot);
  f.game.vehicles.set(992, { id: 992, type: VEHICLE.JET, x: 0, y: 130, z: -550, heading: 0,
    health: 600, occupant: pilot.id, respawnAtTick: -1 });
  f.game.tick = 30; // Existing AA scan cadence; no extra scan or targeting shortcut.
  const { command } = f.advance();
  assert.equal(command.weapon, ROCKET);
  assert.equal(command.buttons & (BTN.FORWARD | BTN.FIRE | BTN.RELOAD), 0,
    'the sentry stops and begins its ordinary authoritative lock before firing');
  assert.ok(command.pitch > .15, 'aim follows the aircraft rather than the travel heading');
  assert.equal(f.player.weapon, ROCKET);
});

test('stowing a launcher leaves the next ground encounter free to choose for its current range', () => {
  const f = fixture(); f.advance();
  const internals = f.bot as unknown as { weapon: number; weaponPickAt: number;
    chooseCombatWeapon(player: ServerPlayer, distance: number, grenadeRange: number): number };
  // A previous combat decision may still have most of its two-second scoring
  // interval left when the soldier resumes traveling with that launcher.
  f.player.weapon = internals.weapon = ROCKET; internals.weaponPickAt = 120;
  const choose = internals.chooseCombatWeapon, scored: number[] = [];
  internals.chooseCombatWeapon = function(player, distance, grenadeRange) {
    scored.push(distance); return choose.call(this, player, distance, grenadeRange);
  };
  f.game.tick = 30;
  assert.equal(f.advance().command.weapon, RIFLE);
  assert.equal(scored.length, 0, 'quiet travel does not run randomized combat weapon scoring');
  const enemy = new ServerPlayer(90, 'Close ambusher', null, false, { x: 0, y: 0, z: -12 });
  enemy.faction = 2; enemy.state.grounded = true; f.game.players.set(enemy.id, enemy);
  f.game.tick = 60;
  const { command } = f.advance();
  assert.equal(scored.length, 1, 'the next fight immediately scores instead of waiting for the old deadline');
  assert.ok(scored[0] < 16, 'the decision uses the new close-range opponent');
  assert.ok([RIFLE, 2].includes(command.weapon), 'close combat selects its ordinary rifle/scattergun options');
});
