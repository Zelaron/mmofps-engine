import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/game.js';
import { Bot, botName } from '../src/bots.js';
import { mulberry32 } from "@shared/rng";
import {
  ByteReader, Msg, decodeSnapshot, decodeExplosion,
  PLAYER, WORLD, NET, BTN, TICK_DT, WEAPONS, createFullAmmoLoadout,
  ENT_PROJECTILE,
  type InputCmd, type WeaponDef,
} from '@shared/index';

function input(
  seq: number,
  weapon: number,
  buttons = 0,
  yaw = 0,
  pitch = 0,
): InputCmd {
  return {
    seq, weapon, buttons, yaw, pitch,
    renderTick: 0,
    renderFrac: 0,
  };
}

function placeInOpenSky(p: ReturnType<Game['addPlayer']>, x: number, z: number): void {
  p.state.px = x;
  p.state.py = 100;
  p.state.pz = z;
  p.state.vx = 0;
  p.state.vy = 0;
  p.state.vz = 0;
  p.state.grounded = false;
  p.state.alive = true;
  p.health = PLAYER.MAX_HEALTH;
}

function runBotMatch(seed: number, ticks: number): Game {
  const game = new Game(seed);
  const bots: Bot[] = [];
  for (let i = 0; i < 6; i++) {
    const p = game.addPlayer(botName(i), null, true);
    bots.push(new Bot(p, seed));
  }
  for (let t = 0; t < ticks; t++) {
    for (const b of bots) game.queueInput(b.player, b.think(game));
    game.step();
  }
  return game;
}

test('bot match runs 20 sim-seconds with sane invariants', () => {
  const game = runBotMatch(1337, 1200);
  for (const p of game.players.values()) {
    const s = p.state;
    assert.ok(
      Number.isFinite(s.px) && Number.isFinite(s.py) && Number.isFinite(s.pz),
      `non-finite position for ${p.name}`,
    );
    assert.ok(s.py > -80, `${p.name} below the world: ${s.py}`);
    assert.ok(p.health >= 0 && p.health <= PLAYER.MAX_HEALTH, `bad health ${p.health}`);
  }
  assert.ok(game.stats.shotsFired > 0, 'bots should have fired at least once');
  assert.equal(game.tick, 1200);
});

test('bot match is deterministic', () => {
  const sum = (g: Game): number => {
    let acc = 0;
    for (const p of g.players.values()) acc += p.state.px + p.state.py * 1e3 + p.state.pz * 1e-3 + p.frags * 17;
    return acc;
  };
  assert.equal(sum(runBotMatch(4242, 600)), sum(runBotMatch(4242, 600)));
});

test('connected players receive decodable snapshots', () => {
  const game = new Game(99);
  const bots: Bot[] = [];
  for (let i = 0; i < 3; i++) {
    const p = game.addPlayer(botName(i), null, true);
    bots.push(new Bot(p, seedOf(99, i)));
  }
  const received: Uint8Array[] = [];
  const me = game.addPlayer('Tester', { send: (b) => received.push(b) }, false);
  game.sendRoster(me);

  for (let t = 0; t < 120; t++) {
    for (const b of bots) game.queueInput(b.player, b.think(game));
    game.queueInput(me, {
      seq: t + 1, buttons: 1 /* forward */, weapon: 0,
      yaw: 0, pitch: 0, renderTick: Math.max(0, game.tick - 6), renderFrac: 0,
    });
    game.step();
  }

  const snaps = received.filter((b) => b[0] === Msg.SSnapshot);
  assert.ok(snaps.length >= 50, `expected ~60 snapshots, got ${snaps.length}`);
  const last = new ByteReader(snaps[snaps.length - 1]);
  last.u8();
  const snap = decodeSnapshot(last);
  assert.ok(snap.lastSeq >= 110, `server consumed inputs (lastSeq ${snap.lastSeq})`);
  assert.ok(Number.isFinite(snap.you.py));
  assert.equal(snap.you.alive, me.state.alive, 'snapshot preserves the authoritative state even if a bot killed the tester');
  assert.equal(snap.tick, game.tick);
  assert.deepEqual(snap.you.ammo, me.ammo);
  assert.equal(snap.you.reloadWeapon, me.reloadWeapon);
  assert.ok(Math.abs(snap.you.reloadCooldown - me.reloadCd) < 0.002);
  assert.equal(snap.you.reloadHeld, me.reloadHeld);
});

test('players spawn with an independent full loadout for every weapon', () => {
  const game = new Game(101);
  const p = game.addPlayer('Loaded', null);
  assert.deepEqual(p.ammo, createFullAmmoLoadout());
  assert.notEqual(p.ammo[0], p.ammo[1], 'weapon ammo slots must not alias');
  assert.equal(p.reloadWeapon, -1);
  assert.equal(p.reloadCd, 0);
});

test('hyperspeed playtest cheat grants invulnerability, dropped with the key', () => {
  const game = new Game(103);
  const victim = game.addPlayer('Hyper', null);
  const attacker = game.addPlayer('Rival', null);
  placeInOpenSky(victim, 0, 0);
  const internals = game as unknown as {
    damage: (
      v: typeof victim, amount: number, a: typeof attacker,
      weaponId: number, kx: number, ky: number, kz: number,
    ) => void;
  };

  victim.lastCmd = input(1, 0, BTN.HYPER);
  internals.damage(victim, 40, attacker, 0, 0, 0, 0);
  assert.equal(victim.health, PLAYER.MAX_HEALTH, 'hyper player is untouchable');

  victim.lastCmd = input(2, 0, 0);
  internals.damage(victim, 40, attacker, 0, 0, 0, 0);
  assert.equal(
    victim.health, PLAYER.MAX_HEALTH - 40,
    'damage flows normally once hyperspeed is off',
  );
});

test('a speeding hull runs pedestrians over; a crawling one only nudges', () => {
  const game = new Game(104);
  const driver = game.addPlayer('Driver', null);
  const victim = game.addPlayer('Walker', null);
  placeInOpenSky(driver, 0, 0);
  placeInOpenSky(victim, 0, -1.5);
  driver.state.vehicle = 1; // jeep possession; no roster needed for the sweep
  driver.state.heading = 0;
  driver.state.vx = 0;
  driver.state.vz = -15;

  game.queueInput(driver, input(1, 0));
  game.queueInput(victim, input(1, 0));
  game.step();

  assert.equal(victim.state.alive, false, 'victim must be flattened');
  assert.equal(driver.frags, 1, 'run-over credits the driver');

  // A hull rolling below the threshold must not hurt anyone.
  const slow = new Game(105);
  const d2 = slow.addPlayer('Creeper', null);
  const v2 = slow.addPlayer('Bystander', null);
  placeInOpenSky(d2, 0, 0);
  placeInOpenSky(v2, 0, -1.5);
  d2.state.vehicle = 1;
  d2.state.vz = -3;
  slow.queueInput(d2, input(1, 0));
  slow.queueInput(v2, input(1, 0));
  slow.step();
  assert.equal(v2.state.alive, true);
  assert.equal(v2.health, PLAYER.MAX_HEALTH);
});

test('an accepted shot consumes one round from only its weapon', () => {
  const game = new Game(102);
  const p = game.addPlayer('Ammo', null);
  placeInOpenSky(p, 0, 0);
  p.weapon = 0;
  p.fireCd = 0;
  const before = p.ammo.map((a) => ({ ...a }));

  game.queueInput(p, input(1, 0, BTN.FIRE));
  game.step();

  assert.equal(game.stats.shotsFired, 1);
  assert.equal(p.ammo[0].magazine, before[0].magazine - 1);
  assert.equal(p.ammo[0].reserve, before[0].reserve);
  assert.deepEqual(p.ammo.slice(1), before.slice(1));
});

test('held fire immediately starts the authoritative reload after the last grenade', () => {
  const game = new Game(1021);
  const p = game.addPlayer('AutoReload', null);
  placeInOpenSky(p, 0, 0);
  p.weapon = 4;
  p.fireCd = 0;

  game.queueInput(p, input(1, 4, BTN.FIRE, 0, 0.4));
  game.step();
  assert.equal(p.ammo[4].magazine, 0);
  assert.ok(p.fireCd > 0 && p.fireCd <= WEAPONS[4].interval);

  game.queueInput(p, input(2, 4, BTN.FIRE));
  game.step();
  assert.equal(p.reloadWeapon, 4);
  assert.ok(p.reloadCd > 0);
  assert.ok(
    p.fireCd < WEAPONS[4].reloadTime,
    'the mandatory reload, not a redundant fire interval, owns the cadence',
  );
});

test('an exhausted weapon dry-fires without creating a shot or projectile', () => {
  const game = new Game(103);
  const p = game.addPlayer('Dry', null);
  placeInOpenSky(p, 0, 0);
  p.weapon = 3;
  p.fireCd = 0;
  p.ammo[3].magazine = 0;
  p.ammo[3].reserve = 0;

  game.queueInput(p, input(1, 3, BTN.FIRE));
  game.step();

  assert.equal(game.stats.shotsFired, 0);
  assert.equal(game.projectiles.size, 0);
  assert.equal(p.ammo[3].magazine, 0);
  assert.equal(p.ammo[3].reserve, 0);
  assert.ok(p.fireCd > 0, 'dry fire is throttled while FIRE remains held');
});

test('reload transfers only available reserve and leaves other weapons untouched', () => {
  const game = new Game(104);
  const p = game.addPlayer('Reload', null);
  placeInOpenSky(p, 0, 0);
  p.weapon = 2;
  p.ammo[2] = { magazine: 5, reserve: 3 };
  const expectedAmmo = p.ammo.map((a) => ({ ...a }));
  expectedAmmo[2] = { magazine: 8, reserve: 0 };

  game.queueInput(p, input(1, 2, BTN.RELOAD));
  game.step();
  assert.equal(p.reloadWeapon, 2);
  assert.ok(p.reloadCd > 0);

  const reloadTicks = Math.ceil(WEAPONS[2].reloadTime / TICK_DT);
  for (let i = 0; i < reloadTicks; i++) {
    game.queueInput(p, input(i + 2, 2));
    game.step();
  }

  assert.equal(p.reloadWeapon, -1);
  assert.equal(p.reloadCd, 0);
  assert.deepEqual(p.ammo, expectedAmmo);
});

test('switching weapons cancels a reload without transferring ammo', () => {
  const game = new Game(105);
  const p = game.addPlayer('Cancel', null);
  placeInOpenSky(p, 0, 0);
  p.weapon = 2;
  p.ammo[2] = { magazine: 4, reserve: 9 };

  game.queueInput(p, input(1, 2, BTN.RELOAD));
  game.step();
  assert.equal(p.reloadWeapon, 2);

  game.queueInput(p, input(2, 3));
  game.step();
  assert.equal(p.weapon, 3);
  assert.equal(p.reloadWeapon, -1);
  assert.equal(p.reloadCd, 0);
  assert.deepEqual(p.ammo[2], { magazine: 4, reserve: 9 });
});

test('death cancels reload and respawn refills ammo without replaying stale input', () => {
  const game = new Game(106);
  const p = game.addPlayer('Respawn', null);
  placeInOpenSky(p, 0, 0);
  p.weapon = 3;
  p.ammo[3] = { magazine: 1, reserve: 2 };
  p.reloadWeapon = 3;
  p.reloadCd = 1;
  p.reloadHeld = true;
  p.lastCmd = input(7, 3, BTN.FIRE | BTN.RELOAD);

  const kill = (game as unknown as {
    kill(victim: typeof p, attacker: typeof p, weapon: number): void;
  }).kill.bind(game);
  kill(p, p, 255);
  assert.equal(p.reloadWeapon, -1);
  assert.equal(p.reloadCd, 0);

  p.respawnAtTick = game.tick + 1;
  const shotsBeforeRespawn = game.stats.shotsFired;
  game.step();
  assert.ok(p.state.alive);
  assert.deepEqual(p.ammo, createFullAmmoLoadout());
  assert.equal(p.reloadWeapon, -1);
  assert.equal(p.reloadCd, 0);
  assert.equal(p.reloadHeld, false);
  assert.equal(p.lastCmd, null);
  assert.equal(p.inputQueue.length, 0);

  game.step();
  assert.equal(
    game.stats.shotsFired,
    shotsBeforeRespawn,
    'stale held FIRE was not repeated after respawn',
  );
});

test('duplicate and non-monotonic input sequences cannot advance weapon state twice', () => {
  const game = new Game(107);
  const p = game.addPlayer('Sequence', null);
  placeInOpenSky(p, 0, 0);
  p.weapon = 0;
  p.fireCd = TICK_DT * 2.5;
  const magazine = p.ammo[0].magazine;
  const duplicate = input(10, 0, BTN.FIRE);

  game.queueInput(p, duplicate);
  game.queueInput(p, duplicate);
  game.queueInput(p, input(9, 0, BTN.FIRE));
  assert.equal(p.inputQueue.length, 1);

  game.step();
  assert.equal(game.stats.shotsFired, 0);
  assert.equal(p.ammo[0].magazine, magazine);
  assert.ok(p.fireCd > 0, 'only one accepted input tick reduced cooldown');
});

test('grenades retain weapon identity and accelerate along a visible arc', () => {
  const game = new Game(1337);
  const shooter = game.addPlayer('Arc', null);
  placeInOpenSky(shooter, 0, 0);
  shooter.weapon = 4;
  shooter.fireCd = 0;

  game.queueInput(shooter, input(1, 4, BTN.FIRE, 0, 0.45));
  game.step();
  const grenade = [...game.projectiles.values()][0];
  assert.ok(grenade, 'grenade spawned');
  assert.equal(grenade.weapon, 4);
  const firstY = grenade.y;
  const firstVy = grenade.vy;

  for (let i = 0; i < 12; i++) {
    game.queueInput(shooter, input(i + 2, 4));
    game.step();
  }
  const later = game.projectiles.get(grenade.id);
  assert.ok(later, 'grenade remains in flight');
  assert.ok(later.y > firstY, 'the chosen upward shot initially rises');
  const expectedDrop = (WEAPONS[4].gravity ?? 0) * TICK_DT * 12;
  assert.ok(
    later.vy < firstVy - expectedDrop * 0.99,
    `gravity reduced vy (${firstVy} -> ${later.vy})`,
  );
});

test('grenade terrain impacts ricochet during the one-second arming window', () => {
  const received: Uint8Array[] = [];
  const game = new Game(2025);
  const shooter = game.addPlayer('Impact', { send: (b) => received.push(b) });
  shooter.weapon = 4;
  shooter.fireCd = 0;

  game.queueInput(shooter, input(1, 4, BTN.FIRE, 0, -1.0));
  game.step();
  const grenade = [...game.projectiles.values()][0];
  assert.ok(grenade);

  let bounced = grenade.vy > 0;
  for (let steps = 0; steps < 24 && !bounced; steps++) {
    const previousVy = grenade.vy;
    game.queueInput(shooter, input(steps + 2, 4));
    game.step();
    bounced = previousVy < 0 && grenade.vy > 0;
  }

  assert.ok(bounced, 'a close downward miss reflected away from terrain');
  assert.ok(game.projectiles.has(grenade.id), 'the early miss remained live after impact');
  assert.ok(grenade.ageSeconds < (WEAPONS[4].terrainBounceTime ?? 0));
  assert.equal(
    received.some((b) => b[0] === Msg.SExplosion),
    false,
    'the early terrain impact emitted no explosion',
  );
});

test('rocket terrain impacts still detonate immediately', () => {
  const received: Uint8Array[] = [];
  const game = new Game(2025);
  const shooter = game.addPlayer('Rocket impact', { send: (b) => received.push(b) });
  const internals = game as unknown as {
    fireProjectile(p: typeof shooter, cmd: InputCmd, def: WeaponDef): void;
    updateProjectiles(): void;
    broadcast(): void;
  };
  internals.fireProjectile(shooter, input(1, 3, BTN.FIRE, 0, -1.0), WEAPONS[3]);
  const rocket = [...game.projectiles.values()][0];
  assert.ok(rocket);

  for (let steps = 0; steps < 30 && game.projectiles.has(rocket.id); steps++) {
    internals.updateProjectiles();
  }
  assert.ok(!game.projectiles.has(rocket.id), 'the first rocket terrain contact detonated');
  internals.broadcast();
  const packet = received.find((b) => b[0] === Msg.SExplosion);
  assert.ok(packet);
  const reader = new ByteReader(packet);
  reader.u8();
  const explosion = decodeExplosion(reader);
  assert.equal(explosion.weapon, 3);
  assert.equal(explosion.projectileId, rocket.id);
});

test('the indefinite ricochet branch remains safely opt-in', () => {
  const game = new Game(2025);
  const shooter = game.addPlayer('Bounce', null);
  const bounceDef: WeaponDef = { ...WEAPONS[4], bounces: true };
  const internals = game as unknown as {
    fireProjectile(p: typeof shooter, cmd: InputCmd, def: WeaponDef): void;
    advanceProjectile(
      projectile: (typeof game.projectiles extends Map<number, infer P> ? P : never),
      def: WeaponDef,
      dt: number,
    ): boolean;
  };
  internals.fireProjectile(shooter, input(1, 4, BTN.FIRE, 0, -1.0), bounceDef);
  const grenade = [...game.projectiles.values()][0];
  assert.ok(grenade);

  let bounced = false;
  let previousVy = grenade.vy;
  for (let i = 0; i < 60 && !bounced; i++) {
    assert.equal(internals.advanceProjectile(grenade, bounceDef, TICK_DT), false);
    if (previousVy < 0 && grenade.vy > 0) bounced = true;
    previousVy = grenade.vy;
  }
  assert.ok(bounced, 'explicit bounces=true reflects the projectile from terrain');
  assert.ok(game.projectiles.has(grenade.id), 'the opt-in bounce did not detonate');
});

test('terrain arming is decided at the sub-tick contact time without an airburst', () => {
  const game = new Game(2026);
  const def = WEAPONS[4];
  const armTime = def.terrainBounceTime ?? 0;
  const internals = game as unknown as {
    advanceProjectile(
      projectile: (typeof game.projectiles extends Map<number, infer P> ? P : never),
      weaponDef: WeaponDef,
      dt: number,
    ): boolean;
  };

  let traceCalls = 0;
  game.world.trace = (ox, oy, oz, dx, dy, dz, maxDist) => {
    if (traceCalls++ === 0) {
      const dist = 0.5 + (def.projRadius ?? 0.24);
      return {
        hit: true,
        dist,
        x: ox + dx * dist,
        y: oy + dy * dist,
        z: oz + dz * dist,
        nx: -1, ny: 0, nz: 0,
      };
    }
    return { hit: false, dist: maxDist, x: 0, y: 0, z: 0, nx: 0, ny: 1, nz: 0 };
  };

  // At 60 m/s the controlled wall is reached halfway through this tick.
  const early = {
    id: 801,
    owner: 999,
    weapon: 4,
    x: 0, y: 100, z: 0,
    vx: 60, vy: 0, vz: 0,
    distLeft: def.range,
    fuseLeft: Infinity,
    ageSeconds: armTime - TICK_DT * 0.75,
    sleeping: false,
  };
  game.projectiles.set(early.id, early);
  assert.equal(internals.advanceProjectile(early, def, TICK_DT), false);
  assert.ok(early.vx < 0, 'contact just before one second reflected the normal velocity');
  assert.ok(
    early.ageSeconds > armTime,
    'crossing the arming threshold after that bounce did not cause a mid-air explosion',
  );
  assert.ok(game.projectiles.has(early.id));

  traceCalls = 0;
  const armed = {
    id: 802,
    owner: 999,
    weapon: 4,
    x: 0,
    y: 100,
    z: 0,
    vx: 60, vy: 0, vz: 0,
    distLeft: def.range,
    fuseLeft: Infinity,
    ageSeconds: armTime - TICK_DT * 0.25,
    sleeping: false,
  };
  game.projectiles.set(armed.id, armed);
  assert.equal(internals.advanceProjectile(armed, def, TICK_DT), true);
  assert.ok(!game.projectiles.has(armed.id), 'contact just after one second detonated');
});

test('an early direct player hit bypasses terrain arming and explodes', () => {
  const game = new Game(2027);
  const victim = game.addPlayer('Direct target', null);
  placeInOpenSky(victim, 1.2, 0);
  victim.health = 500;
  game.world.trace = (_ox, _oy, _oz, _dx, _dy, _dz, maxDist) => ({
    hit: false, dist: maxDist,
    x: 0, y: 0, z: 0,
    nx: 0, ny: 1, nz: 0,
  });

  const grenade = {
    id: 803,
    owner: 999,
    weapon: 4,
    x: 0, y: victim.state.py + PLAYER.EYE_HEIGHT, z: 0,
    vx: WEAPONS[4].speed ?? 78, vy: 0, vz: 0,
    distLeft: WEAPONS[4].range,
    fuseLeft: Infinity,
    ageSeconds: 0.1,
    sleeping: false,
  };
  game.projectiles.set(grenade.id, grenade);
  const updateProjectiles = (game as unknown as {
    updateProjectiles(): void;
  }).updateProjectiles.bind(game);

  updateProjectiles();
  assert.ok(!game.projectiles.has(grenade.id));
  assert.equal(victim.health, 500 - WEAPONS[4].damage);
});

test('an early grenade that settles detonates when terrain contact arms', () => {
  const received: Uint8Array[] = [];
  const game = new Game(2028);
  const owner = game.addPlayer('Owner', { send: (b) => received.push(b) });
  placeInOpenSky(owner, 100, 0);
  const armTime = WEAPONS[4].terrainBounceTime ?? 0;
  const grenade = {
    id: 804,
    owner: owner.id,
    weapon: 4,
    x: 0, y: 0, z: 0,
    vx: 0, vy: 0, vz: 0,
    distLeft: WEAPONS[4].range,
    fuseLeft: Infinity,
    ageSeconds: armTime - TICK_DT * 0.5,
    sleeping: true,
  };
  game.projectiles.set(grenade.id, grenade);
  const internals = game as unknown as {
    updateProjectiles(): void;
    broadcast(): void;
  };

  internals.updateProjectiles();
  internals.updateProjectiles();
  assert.ok(!game.projectiles.has(grenade.id), 'the resting grenade cannot become permanent');
  internals.broadcast();
  assert.equal(
    received.filter((b) => b[0] === Msg.SExplosion).length,
    1,
    'arming continuous terrain contact emitted exactly one explosion',
  );
});

test('a player touching a resting grenade just before arming gets the direct hit', () => {
  const game = new Game(2029);
  const victim = game.addPlayer('Resting direct target', null);
  placeInOpenSky(victim, 0, 0);
  victim.health = 500;
  const grenade = {
    id: 805,
    owner: 999,
    weapon: 4,
    x: victim.state.px,
    y: victim.state.py + PLAYER.EYE_HEIGHT,
    z: victim.state.pz,
    vx: 0, vy: 0, vz: 0,
    distLeft: WEAPONS[4].range,
    fuseLeft: Infinity,
    ageSeconds: (WEAPONS[4].terrainBounceTime ?? 0) - TICK_DT * 0.25,
    sleeping: true,
  };
  game.projectiles.set(grenade.id, grenade);
  const updateProjectiles = (game as unknown as {
    updateProjectiles(): void;
  }).updateProjectiles.bind(game);

  updateProjectiles();
  assert.ok(!game.projectiles.has(grenade.id));
  assert.equal(
    victim.health,
    500 - WEAPONS[4].damage,
    'direct damage won over the imminent terrain-contact explosion',
  );
});

test('an unfused grenade survives the former timer while still in clear sky', () => {
  const game = new Game(31415);
  const shooter = game.addPlayer('NoFuse', null);
  placeInOpenSky(shooter, 0, 0);
  shooter.state.py = 220;
  shooter.weapon = 4;
  shooter.fireCd = 0;

  assert.equal(WEAPONS[4].fuse, undefined);
  game.queueInput(shooter, input(1, 4, BTN.FIRE, 0, 0.75));
  game.step();
  const grenade = [...game.projectiles.values()][0];
  assert.ok(grenade);

  const updateProjectiles = (game as unknown as {
    updateProjectiles(): void;
  }).updateProjectiles.bind(game);
  const formerFuseSeconds = 5.8;
  for (let i = 0; i < Math.ceil(formerFuseSeconds / TICK_DT); i++) {
    updateProjectiles();
  }

  assert.ok(game.projectiles.has(grenade.id), 'clear-sky artillery has no midair timer');
  assert.equal(grenade.fuseLeft, Infinity);
});

test('strict range budget cannot hit beyond its remainder or airburst impact artillery', () => {
  const received: Uint8Array[] = [];
  const game = new Game(7001);
  const owner = game.addPlayer('Owner', { send: (b) => received.push(b) });
  const victim = game.addPlayer('BeyondRange', null);
  placeInOpenSky(owner, -20, 0);
  placeInOpenSky(victim, 1.5, 0);
  owner.state.py = 1000;
  victim.state.py = 1000 - PLAYER.RADIUS;
  victim.health = 200;

  const grenade = {
    id: 701,
    owner: owner.id,
    weapon: 4,
    x: 0, y: 1000, z: 0,
    vx: WEAPONS[4].speed ?? 78, vy: 0, vz: 0,
    distLeft: 0.1,
    fuseLeft: Infinity,
    ageSeconds: 0,
    sleeping: false,
  };
  game.projectiles.set(grenade.id, grenade);
  const updateProjectiles = (game as unknown as {
    updateProjectiles(): void;
  }).updateProjectiles.bind(game);
  const broadcast = (game as unknown as {
    broadcast(): void;
  }).broadcast.bind(game);

  updateProjectiles();
  assert.ok(!game.projectiles.has(grenade.id), 'range exhaustion retired the grenade');
  assert.equal(victim.health, 200, 'victim contact 0.84m away exceeded the 0.1m budget');
  assert.ok(
    Math.hypot(grenade.x, grenade.y - 1000, grenade.z) <= 0.100000001,
    'terminal sweep stayed inside the remaining center-path budget',
  );
  broadcast();
  assert.equal(
    received.some((b) => b[0] === Msg.SExplosion),
    false,
    'impact-only range exhaustion emitted no explosion',
  );
});

test('rocket range exhaustion remains a terminal airburst', () => {
  const received: Uint8Array[] = [];
  const game = new Game(7002);
  const owner = game.addPlayer('Rocketeer', { send: (b) => received.push(b) });
  placeInOpenSky(owner, -20, 0);
  owner.state.py = 1000;
  const rocket = {
    id: 702,
    owner: owner.id,
    weapon: 3,
    x: 0, y: 1000, z: 0,
    vx: WEAPONS[3].speed ?? 48, vy: 0, vz: 0,
    distLeft: 0.1,
    fuseLeft: Infinity,
    ageSeconds: 0,
    sleeping: false,
  };
  game.projectiles.set(rocket.id, rocket);
  const internals = game as unknown as {
    updateProjectiles(): void;
    broadcast(): void;
  };

  internals.updateProjectiles();
  assert.ok(!game.projectiles.has(rocket.id));
  assert.ok(
    Math.hypot(rocket.x, rocket.y - 1000, rocket.z) <= 0.100000001,
  );
  internals.broadcast();
  const packet = received.find((b) => b[0] === Msg.SExplosion);
  assert.ok(packet, 'rocket expiry retained its useful terminal explosion');
  const reader = new ByteReader(packet);
  reader.u8();
  const explosion = decodeExplosion(reader);
  assert.equal(explosion.weapon, 3);
  assert.equal(explosion.projectileId, rocket.id);
});

test('artillery endpoint and explosion remain visible across the practical envelope', () => {
  const received: Uint8Array[] = [];
  const game = new Game(7003);
  const owner = game.addPlayer('Observer', { send: (b) => received.push(b) });
  const def = WEAPONS[4];
  const speed = def.speed ?? 0;
  const gravity = def.gravity ?? 0;
  const maxDrop =
    WORLD.MAX_HEIGHT + PLAYER.EYE_HEIGHT + 0.5 - WORLD.MIN_CAVE_Y;
  const maxHorizontal =
    speed / gravity * Math.sqrt(speed * speed + 2 * gravity * maxDrop);
  const maxEndpointDistance = Math.hypot(maxHorizontal, maxDrop);
  assert.ok(NET.FIRE_EVENT_RADIUS > maxHorizontal);
  assert.ok(NET.INTEREST_RADIUS > maxEndpointDistance);

  owner.state.px = 0;
  owner.state.py = 300;
  owner.state.pz = 0;
  const projectile = {
    id: 703,
    owner: owner.id,
    weapon: 4,
    x: maxHorizontal,
    y: owner.state.py - maxDrop,
    z: 0,
    vx: 1, vy: 0, vz: 0,
    distLeft: 1,
    fuseLeft: Infinity,
    ageSeconds: 0,
    sleeping: false,
  };
  game.projectiles.set(projectile.id, projectile);
  const internals = game as unknown as {
    buildSnapshotFor(player: typeof owner): Uint8Array;
    explode(
      x: number, y: number, z: number,
      source: typeof owner,
      weaponDef: WeaponDef,
      directVictimId: number,
      projectileId: number,
    ): void;
    broadcast(): void;
  };
  const snapshotReader = new ByteReader(internals.buildSnapshotFor(owner));
  assert.equal(snapshotReader.u8(), Msg.SSnapshot);
  const snapshot = decodeSnapshot(snapshotReader);
  assert.ok(snapshot.ents.some(
    (e) => e.kind === ENT_PROJECTILE && e.id === projectile.id,
  ));

  internals.explode(
    maxHorizontal, projectile.y, 0,
    owner, def, -1, projectile.id,
  );
  internals.broadcast();
  assert.ok(
    received.some((b) => b[0] === Msg.SExplosion),
    'owner received the terminal explosion at maximum practical range',
  );
});

for (const weapon of [3, 4] as const) {
  test(`${WEAPONS[weapon].name} direct and splash victims receive a strong radial launch`, () => {
    const game = new Game(8800 + weapon);
    const owner = game.addPlayer('Owner', null);
    const direct = game.addPlayer('Direct', null);
    const splash = game.addPlayer('Splash', null);
    const def = WEAPONS[weapon];
    const explosionY = 220 + PLAYER.RADIUS;
    const splashX = (def.splashRadius ?? 1) * 0.75;
    placeInOpenSky(owner, -30, 0);
    placeInOpenSky(direct, 1, 0);
    placeInOpenSky(splash, splashX, 0);
    owner.state.py = direct.state.py = splash.state.py = 220;
    direct.state.grounded = true;
    splash.state.grounded = true;
    direct.health = 500;
    splash.health = 500;

    const projectile = {
      id: 400 + weapon,
      owner: owner.id,
      weapon,
      x: 0, y: explosionY, z: 0,
      vx: 1, vy: 0, vz: 0,
      distLeft: def.range,
      fuseLeft: Infinity,
      ageSeconds: 0,
      sleeping: false,
    };
    const projectileHitPlayer = (game as unknown as {
      projectileHitPlayer(
        r: typeof projectile,
        weaponDef: WeaponDef,
        victim: typeof direct,
        x: number, y: number, z: number,
      ): void;
    }).projectileHitPlayer.bind(game);
    projectileHitPlayer(projectile, def, direct, 0, explosionY, 0);

    assert.equal(
      direct.health,
      500 - def.damage,
      'direct damage applied once without duplicate splash damage',
    );
    assert.ok(splash.health < 500, 'nearby victim received splash damage');
    assert.ok(direct.state.vx > 15, `direct outward impulse was ${direct.state.vx}`);
    assert.ok(direct.state.vy > 8, `direct upward impulse was ${direct.state.vy}`);
    assert.ok(splash.state.vx > 8, `splash outward impulse was ${splash.state.vx}`);
    assert.ok(splash.state.vy > 3, `splash upward impulse was ${splash.state.vy}`);
    assert.equal(direct.state.grounded, false);
    assert.equal(splash.state.grounded, false);
  });
}

test('a confirmed direct-hit survivor bypasses redundant blast LOS', () => {
  const game = new Game(8804);
  const owner = game.addPlayer('Owner', null);
  const direct = game.addPlayer('Direct', null);
  placeInOpenSky(owner, -30, 0);
  placeInOpenSky(direct, 1, 0);
  owner.state.py = direct.state.py = 220;
  direct.state.grounded = true;
  direct.health = 500;
  const y = 220 + PLAYER.RADIUS;
  const projectile = {
    id: 804,
    owner: owner.id,
    weapon: 4,
    x: 0, y, z: 0,
    vx: 1, vy: 0, vz: 0,
    distLeft: WEAPONS[4].range,
    fuseLeft: Infinity,
    ageSeconds: 0,
    sleeping: false,
  };
  // A second blast ray would report a wall (as can happen at a capsule
  // grazing a corner), but the projectile sweep has already confirmed contact.
  game.world.trace = (x, traceY, z) => ({
    hit: true,
    dist: 0,
    x, y: traceY, z,
    nx: 0, ny: 1, nz: 0,
  });
  const projectileHitPlayer = (game as unknown as {
    projectileHitPlayer(
      r: typeof projectile,
      def: WeaponDef,
      victim: typeof direct,
      x: number, y: number, z: number,
    ): void;
  }).projectileHitPlayer.bind(game);

  projectileHitPlayer(projectile, WEAPONS[4], direct, 0, y, 0);
  assert.equal(direct.health, 500 - WEAPONS[4].damage);
  assert.ok(direct.state.vx > 15);
  assert.ok(direct.state.vy > 8);
  assert.equal(direct.state.grounded, false);
});

test('self damage is reduced without reducing blast impulse', () => {
  const game = new Game(9090);
  const owner = game.addPlayer('Owner', null);
  const peer = game.addPlayer('Peer', null);
  placeInOpenSky(owner, 1, 0);
  placeInOpenSky(peer, -1, 0);
  owner.state.py = peer.state.py = 220;
  owner.state.grounded = true;
  peer.state.grounded = true;
  owner.health = peer.health = 500;
  const y = 220 + PLAYER.RADIUS;
  const explode = (game as unknown as {
    explode(
      x: number, y: number, z: number,
      source: typeof owner | null,
      def: WeaponDef,
      excludeId: number,
      projectileId: number,
    ): void;
  }).explode.bind(game);

  explode(0, y, 0, owner, WEAPONS[4], -1, 777);

  const selfDamage = 500 - owner.health;
  const peerDamage = 500 - peer.health;
  assert.ok(Math.abs(selfDamage - peerDamage * 0.55) < 1e-9);
  assert.ok(Math.abs(Math.abs(owner.state.vx) - Math.abs(peer.state.vx)) < 1e-9);
  assert.ok(Math.abs(owner.state.vy - peer.state.vy) < 1e-9);
  assert.equal(owner.state.grounded, false);
  assert.equal(peer.state.grounded, false);
});

test('a blast-launched player can still take landing fall damage', () => {
  const game = new Game(42424);
  const player = game.addPlayer('Jumper', null);
  let seq = 1;
  for (; seq < 180 && !player.state.grounded; seq++) {
    game.queueInput(player, input(seq, player.weapon));
    game.step();
  }
  assert.ok(player.state.grounded, 'spawn settled onto terrain');
  player.health = 1000;
  const y = player.state.py + 0.1;
  const explode = (game as unknown as {
    explode(
      x: number, y: number, z: number,
      source: typeof player | null,
      def: WeaponDef,
      excludeId: number,
      projectileId: number,
    ): void;
  }).explode.bind(game);
  explode(
    player.state.px, y, player.state.pz,
    player, WEAPONS[4], player.id, 778,
  );
  assert.ok(player.state.vy > 30, `blast launch speed was ${player.state.vy}`);
  assert.equal(player.state.grounded, false);

  let wasAirborne = false;
  let landed = false;
  for (let i = 0; i < 600 && player.state.alive; i++, seq++) {
    game.queueInput(player, input(seq, player.weapon));
    game.step();
    if (!player.state.grounded) wasAirborne = true;
    if (wasAirborne && player.state.grounded) {
      landed = true;
      break;
    }
  }
  assert.ok(landed, 'blast-launched player returned to terrain');
  assert.ok(player.health < 1000, 'landing impact still flowed through fall damage');
  assert.equal(player.fallCreditAttackerId, -1, 'landing cleared bounded blast credit');
  assert.equal(player.fallCreditUntilTick, -1);
});

test('a fatal blast-launched fall preserves enemy weapon credit', () => {
  const game = new Game(42424);
  const owner = game.addPlayer('Launcher', null);
  const victim = game.addPlayer('Faller', null);
  let seq = 1;
  for (; seq < 180 && !victim.state.grounded; seq++) {
    game.queueInput(victim, input(seq, victim.weapon));
    game.step();
  }
  assert.ok(victim.state.grounded);
  // Leave a sliver of health after the stronger grenade; this regression
  // exercises the ensuing fall death, rather than death in the explosion.
  victim.health = 110;
  // Start beyond a ledge so the landing is fatal even when a balance change
  // shifts the horizontal trajectory onto a higher patch of terrain.
  victim.state.py += 20;
  victim.state.grounded = false;
  owner.state.px = victim.state.px - 30;
  owner.state.py = victim.state.py;
  owner.state.pz = victim.state.pz;
  owner.state.grounded = true;
  const explode = (game as unknown as {
    explode(
      x: number, y: number, z: number,
      source: typeof owner,
      def: WeaponDef,
      directVictimId: number,
      projectileId: number,
    ): void;
  }).explode.bind(game);
  explode(
    victim.state.px - 3, victim.state.py + 0.1, victim.state.pz,
    owner, WEAPONS[4], -1, 779,
  );
  assert.ok(victim.state.alive, 'blast itself left the victim alive');
  assert.ok(victim.health < 10);
  assert.equal(victim.fallCreditAttackerId, owner.id);
  assert.equal(victim.fallCreditWeapon, 4);
  assert.ok(victim.fallCreditUntilTick > game.tick);

  for (let i = 0; i < 600 && victim.state.alive; i++, seq++) {
    game.queueInput(victim, input(seq, victim.weapon));
    game.step();
  }
  assert.equal(victim.state.alive, false);
  assert.equal(owner.frags, 1, 'blast owner received the environmental kill');
  assert.equal(victim.frags, 0, 'victim was not charged with a suicide');
  assert.equal(victim.fallCreditAttackerId, -1, 'death cleared blast credit');
  assert.equal(victim.fallCreditUntilTick, -1);
});

test('airborne blast credit expires even without player input', () => {
  const game = new Game(42425);
  const attacker = game.addPlayer('Attacker', null);
  const victim = game.addPlayer('Victim', null);
  victim.state.grounded = false;
  victim.fallCreditAttackerId = attacker.id;
  victim.fallCreditWeapon = 4;
  victim.fallCreditUntilTick = game.tick;

  game.step();
  assert.equal(victim.fallCreditAttackerId, -1);
  assert.equal(victim.fallCreditWeapon, 255);
  assert.equal(victim.fallCreditUntilTick, -1);
});

test('rocket projectiles remain gravity-free', () => {
  const game = new Game(1337);
  const shooter = game.addPlayer('Rocket', null);
  placeInOpenSky(shooter, 0, 0);
  shooter.weapon = 3;
  shooter.fireCd = 0;

  game.queueInput(shooter, input(1, 3, BTN.FIRE, 0, 0.3));
  game.step();
  const rocket = [...game.projectiles.values()][0];
  assert.ok(rocket);
  assert.equal(rocket.weapon, 3);
  const vy = rocket.vy;
  for (let i = 0; i < 8; i++) {
    game.queueInput(shooter, input(i + 2, 3));
    game.step();
  }
  assert.ok(game.projectiles.has(rocket.id));
  assert.ok(Math.abs(game.projectiles.get(rocket.id)!.vy - vy) < 1e-12);
});

test('disconnecting an owner retires their live explosives', () => {
  const game = new Game(1337);
  const shooter = game.addPlayer('Leaving', null);
  placeInOpenSky(shooter, 0, 0);
  shooter.weapon = 4;
  shooter.fireCd = 0;
  game.queueInput(shooter, input(1, 4, BTN.FIRE, 0, 0.5));
  game.step();
  assert.equal(game.projectiles.size, 1);

  game.removePlayer(shooter.id);
  assert.equal(game.projectiles.size, 0);
});

function seedOf(base: number, i: number): number {
  return base * 31 + i;
}

test('spawns anchor near the living population instead of a fixed origin', () => {
  const game = new Game(1337);
  const anchor = game.addPlayer('Anchor', null);
  // Re-seat the anchor on safe ground far outside the origin spawn region,
  // as a player who wandered off would be.
  const far = game.world.findSpawnNear(2200, 1500, mulberry32(7), 0, 220);
  assert.ok(far, 'fixture neighborhood must offer safe ground');
  anchor.state.px = far.x;
  anchor.state.py = far.y;
  anchor.state.pz = far.z;

  let proximate = 0;
  const positions = [{ x: far.x, z: far.z }];
  for (let i = 0; i < 8; i++) {
    const joiner = game.addPlayer(`J${i}`, null);
    const minDist = Math.min(...positions.map((q) =>
      Math.hypot(joiner.state.px - q.x, joiner.state.pz - q.z)));
    if (minDist <= 130) proximate++;
    assert.ok(
      minDist <= 130 ||
        Math.hypot(joiner.state.px, joiner.state.pz) <= WORLD.SPAWN_RADIUS + 1,
      `join ${i} landed neither near the population (${minDist.toFixed(0)}m) ` +
        'nor in the origin fallback region',
    );
    positions.push({ x: joiner.state.px, z: joiner.state.pz });
  }
  // The annulus search may fall back on hostile ground occasionally, but
  // proximity must be the norm - that is the whole point of the feature.
  assert.ok(proximate >= 6, `only ${proximate}/8 joins spawned near the population`);
});
