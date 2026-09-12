import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BTN, NET, PLAYER, TICK_DT, WEAPONS, createFullAmmoLoadout, stepWeaponState,
  quantPitch, quantYaw, unquantPitch, unquantYaw, viewDir,
  type WeaponAmmo,
} from '@shared/index';
import {
  Bot,
  ballisticArcClear,
  ballisticPathDistance,
  botName,
  solveBallisticIntercept,
  type BallisticIntercept,
  type BallisticTerrain,
} from '../src/bots.js';
import { ServerPlayer, Game } from '../src/game.js';
import { DEFAULT_TARGET_POPULATION } from '../src/server.js';

const SIDEARM_WEAPON = 0;
const PULSE_RIFLE_WEAPON = 1;
const SCATTERGUN_WEAPON = 2;
const ROCKET_WEAPON = 3;
const GRENADE_WEAPON = 4;
const ARTILLERY = WEAPONS[GRENADE_WEAPON];
const SPEED = ARTILLERY.speed ?? 78;
const GRAVITY = ARTILLERY.gravity ?? 16;
const MUZZLE_OFFSET = 0.5;
const MAX_FLIGHT_TIME = 12;

test('the default fifteen-bot roster is vivid, unique, and wire-safe', () => {
  const expected = [
    'Steven Seagull', 'Bruise Lee', 'Spruce Willis', 'Snackie Chan',
    'Jason Mimosa', 'Harrison Sword', 'John Lambo', 'Duck Norris',
    'Sylvester Calzone', 'Lint Eastwood', 'Rat Damon', 'Tom Booze',
    'Roger Boar', 'Russell Dough', 'Orlando Broom',
  ];
  assert.equal(DEFAULT_TARGET_POPULATION, expected.length);
  assert.deepEqual(expected.map((_name, i) => botName(i)), expected);
  assert.equal(botName(15), 'Steven Seagull-2');
  assert.equal(botName(29), 'Orlando Broom-2');
  assert.equal(botName(30), 'Steven Seagull-3');

  const capacityRoster = Array.from({ length: 64 }, (_unused, i) => botName(i));
  assert.equal(new Set(capacityRoster).size, capacityRoster.length);
  assert.ok(capacityRoster.every((name) => name.length <= NET.MAX_NAME_LEN));
});

test('ballistic solver returns accurate low and high arcs beyond 300 m', () => {
  const origin = { x: 0, y: 2, z: 0 };
  const target = { x: 0, y: 2, z: -320 };
  const velocity = { x: 0, y: 0, z: 0 };
  const solutions = solveBallisticIntercept({
    origin,
    target,
    targetVelocity: velocity,
    speed: SPEED,
    gravity: GRAVITY,
    muzzleOffset: MUZZLE_OFFSET,
    maxTime: MAX_FLIGHT_TIME,
  });

  assert.equal(solutions.length, 2);
  assert.ok(solutions[0].time < solutions[1].time);
  assert.ok(solutions[0].pitch < solutions[1].pitch);
  assert.ok(
    solutions[1].time > 5.8,
    'the high arc must remain viable beyond the retired grenade fuse window',
  );
  for (const solution of solutions) {
    const actual = projectileAt(origin, solution, solution.time);
    assert.ok(distance(actual, target) < 1e-7, `missed by ${distance(actual, target)}`);
  }
});

test('a valid high arc may outlast range divided by launch speed', () => {
  const origin = { x: 0, y: 2, z: 0 };
  // A deep-drop target: on level ground the longest lob (2*speed/gravity =
  // 9.75s) no longer exceeds range/speed (840/78 = 10.77s) since the range
  // budget grew with the world height, but a downhill arc still does.
  const target = { x: 0, y: -150, z: -200 };
  const solutions = solveBallisticIntercept({
    origin,
    target,
    targetVelocity: { x: 0, y: 0, z: 0 },
    speed: SPEED,
    gravity: GRAVITY,
    muzzleOffset: MUZZLE_OFFSET,
    maxTime: MAX_FLIGHT_TIME,
  });
  assert.equal(solutions.length, 2);
  const high = solutions[1];
  assert.ok(
    high.time > ARTILLERY.range / SPEED,
    `${high.time}s high arc should exceed the invalid range/speed time bound`,
  );
  assert.ok(
    ballisticPathDistance(high.direction, SPEED, GRAVITY, high.time) <
      ARTILLERY.range,
    'the same high arc remains inside the authoritative path budget',
  );
});

test('ballistic solver leads a moving target at artillery range and rejects unreachable shots', () => {
  const origin = { x: 0, y: 1.62, z: 0 };
  const target = { x: 0, y: 1.0, z: -320 };
  const velocity = { x: 6, y: 0, z: 0 };
  const moving = solveBallisticIntercept({
    origin,
    target,
    targetVelocity: velocity,
    speed: SPEED,
    gravity: GRAVITY,
    muzzleOffset: MUZZLE_OFFSET,
    maxTime: MAX_FLIGHT_TIME,
  });

  assert.ok(moving.length >= 1);
  assert.ok(moving[0].direction.x > 0, 'aim should lead lateral movement');
  const expected = {
    x: target.x + velocity.x * moving[0].time,
    y: target.y,
    z: target.z,
  };
  assert.ok(distance(projectileAt(origin, moving[0], moving[0].time), expected) < 1e-7);

  const unreachable = solveBallisticIntercept({
    origin,
    target: { x: 0, y: 1.0, z: -400 },
    targetVelocity: { x: 0, y: 0, z: 0 },
    speed: SPEED,
    gravity: GRAVITY,
    muzzleOffset: MUZZLE_OFFSET,
    maxTime: MAX_FLIGHT_TIME,
  });
  assert.equal(unreachable.length, 0);
});

test('quantized ballistic aim remains accurate and terrain clearance rejects an obstruction', () => {
  const origin = { x: 0, y: 1.62, z: 0 };
  const target = { x: 4, y: 1.0, z: -320 };
  const solution = solveBallisticIntercept({
    origin,
    target,
    targetVelocity: { x: 0, y: 0, z: 0 },
    speed: SPEED,
    gravity: GRAVITY,
    muzzleOffset: MUZZLE_OFFSET,
    maxTime: MAX_FLIGHT_TIME,
  })[0];
  assert.ok(solution);

  const yaw = unquantYaw(quantYaw(solution.yaw));
  const pitch = unquantPitch(quantPitch(solution.pitch));
  const direction = viewDir(yaw, pitch);
  const quantized = { ...solution, direction };
  const quantizedMiss = distance(projectileAt(origin, quantized, solution.time), target);
  assert.ok(
    quantizedMiss < 0.08,
    `wire-angle quantization missed the 320 m target by ${quantizedMiss} m`,
  );

  assert.equal(ballisticArcClear(CLEAR_TERRAIN, {
    origin,
    direction,
    speed: SPEED,
    gravity: GRAVITY,
    muzzleOffset: MUZZLE_OFFSET,
    flightTime: solution.time,
    projectileRadius: ARTILLERY.projRadius ?? 0.24,
  }), true);

  const blocked: BallisticTerrain = {
    trace: (_ox, _oy, oz, _dx, _dy, _dz, maxDist) => (
      maxDist < 6 && oz < -140 && oz > -180
        ? { hit: true, dist: Math.min(0.1, maxDist) }
        : { hit: false, dist: maxDist }
    ),
  };
  assert.equal(ballisticArcClear(blocked, {
    origin,
    direction,
    speed: SPEED,
    gravity: GRAVITY,
    muzzleOffset: MUZZLE_OFFSET,
    flightTime: solution.time,
    projectileRadius: ARTILLERY.projRadius ?? 0.24,
  }), false);
});

test('bot selects and safely leads long-range grenade artillery', () => {
  const found = findGrenadeCommand(CLEAR_TERRAIN, 0, -320, 6);
  assert.ok(found, 'at least one deterministic bot seed should select slot 5');
  assert.equal(found.cmd.weapon, GRENADE_WEAPON);
  assert.ok((found.cmd.buttons & BTN.FIRE) !== 0, 'a clear quantized arc may fire');
  assert.ok(found.cmd.pitch > 0, 'level-ground grenade aim must compensate for gravity');
  assert.ok(viewDir(found.cmd.yaw, found.cmd.pitch).x > 0, 'aim should lead the moving target');

  const blockedTerrain: BallisticTerrain = {
    trace: (_ox, _oy, oz, _dx, _dy, _dz, maxDist) => (
      maxDist < 6 && oz < -140 && oz > -180
        ? { hit: true, dist: 0.05 }
        : { hit: false, dist: maxDist }
    ),
  };
  const blocked = firstCommand(found.seed, blockedTerrain, 0, -320, 6);
  assert.equal(
    blocked.weapon,
    PULSE_RIFLE_WEAPON,
    'an obstructed grenade arc must use the conventional 320 m fallback',
  );
});

test('bot can use the fuse-free high arc when low cover blocks the direct arc', () => {
  const lowCover: BallisticTerrain = {
    trace: (_ox, oy, oz, _dx, _dy, _dz, maxDist) => (
      maxDist < 6 && oz < -140 && oz > -180 && oy < 60
        ? { hit: true, dist: 0.05 }
        : { hit: false, dist: maxDist }
    ),
  };
  const found = findGrenadeCommand(lowCover, 0, -320, 0);
  assert.ok(found, 'a high solution should clear low middle-distance cover');
  assert.equal(found.cmd.weapon, GRENADE_WEAPON);
  assert.ok((found.cmd.buttons & BTN.FIRE) !== 0);
  assert.ok(found.cmd.pitch > 0.9, 'bot should select the steep high solution');
});

test('bot never selects grenades outside the safe range envelope', () => {
  for (let seed = 1; seed <= 64; seed++) {
    assert.notEqual(
      firstCommand(seed, CLEAR_TERRAIN, 0, -50, 0).weapon,
      GRENADE_WEAPON,
    );
    assert.notEqual(
      firstCommand(seed, CLEAR_TERRAIN, 0, -380, 0).weapon,
      GRENADE_WEAPON,
    );
    assert.notEqual(
      firstCommand(seed, CLEAR_TERRAIN, 0, -350, 14).weapon,
      GRENADE_WEAPON,
    );
  }
});

test('close-range bot selection exercises both the pulse rifle and scattergun', () => {
  const selected = new Set<number>();
  for (let seed = 1; seed <= 128; seed++) {
    selected.add(firstCommand(seed, CLEAR_TERRAIN, 0, -12, 0).weapon);
  }
  assert.ok(selected.has(PULSE_RIFLE_WEAPON));
  assert.ok(selected.has(SCATTERGUN_WEAPON));
});

test('bot suppresses fire while an authoritative reload is active', () => {
  const shooter = player(1, 'Bot', 0, 0, 0, true);
  const target = player(2, 'Target', 0, 0, -140, false);
  const ammo = createFullAmmoLoadout();
  for (let i = 0; i < ammo.length; i++) {
    if (i !== GRENADE_WEAPON) ammo[i] = { magazine: 0, reserve: 0 };
  }
  ammo[GRENADE_WEAPON] = {
    magazine: 0,
    reserve: ARTILLERY.reserveSize,
  };
  setCombatState(shooter, {
    weapon: GRENADE_WEAPON,
    ammo,
    reloadWeapon: GRENADE_WEAPON,
    reloadCd: 1.2,
    reloadHeld: false,
  });

  const cmd = new Bot(shooter, 11).think(fakeGame(CLEAR_TERRAIN, shooter, target));
  assert.equal(cmd.weapon, GRENADE_WEAPON);
  assert.equal(cmd.buttons & BTN.FIRE, 0);
  assert.equal(cmd.buttons & BTN.RELOAD, 0, 'an active reload does not need another edge');
});

test('bot commits to a finite reload instead of cancelling for a loaded fallback', () => {
  const shooter = player(1, 'Bot', 0, 0, 0, true);
  const target = player(2, 'Target', 0, 0, -12, false);
  const ammo = createFullAmmoLoadout();
  ammo[PULSE_RIFLE_WEAPON] = { magazine: 0, reserve: 12 };
  setCombatState(shooter, {
    weapon: PULSE_RIFLE_WEAPON,
    ammo,
    reloadWeapon: PULSE_RIFLE_WEAPON,
    reloadCd: 1.2,
    reloadHeld: false,
  });

  const cmd = new Bot(shooter, 17).think(fakeGame(CLEAR_TERRAIN, shooter, target));
  assert.equal(cmd.weapon, PULSE_RIFLE_WEAPON);
  assert.equal(cmd.buttons & BTN.FIRE, 0);
  assert.equal(cmd.buttons & BTN.RELOAD, 0);

  stepWeaponState(shooter, cmd.weapon, cmd.buttons, TICK_DT);
  assert.equal(
    shooter.reloadWeapon,
    PULSE_RIFLE_WEAPON,
    'the in-progress reload must remain active',
  );
  assert.ok(shooter.reloadCd < 1.2);
});

test('bot tactically reloads a useful partial magazine out of combat', () => {
  const shooter = player(1, 'Bot', 0, 0, 0, true);
  const ammo = createFullAmmoLoadout();
  ammo[SIDEARM_WEAPON] = { magazine: 3, reserve: 0 };
  setCombatState(shooter, {
    weapon: SIDEARM_WEAPON,
    ammo,
    reloadWeapon: -1,
    reloadCd: 0,
    reloadHeld: false,
  });

  const cmd = new Bot(shooter, 22).think(fakeGame(CLEAR_TERRAIN, shooter));
  assert.ok((cmd.buttons & BTN.RELOAD) !== 0);
  assert.equal(cmd.buttons & BTN.FIRE, 0);

  ammo[PULSE_RIFLE_WEAPON] = { magazine: 3, reserve: 0 };
  shooter.weapon = PULSE_RIFLE_WEAPON;
  const noReserve = new Bot(shooter, 22).think(fakeGame(CLEAR_TERRAIN, shooter));
  assert.equal(noReserve.buttons & BTN.RELOAD, 0);
});

test('empty infinite-reserve sidearm reloads instead of falling back to an unsafe grenade', () => {
  for (let seed = 1; seed <= 32; seed++) {
    const shooter = player(1, 'Bot', 0, 0, 0, true);
    const target = player(2, 'Target', 0, 0, -12, false);
    const ammo = createFullAmmoLoadout();
    ammo[SIDEARM_WEAPON] = { magazine: 0, reserve: 0 };
    ammo[PULSE_RIFLE_WEAPON] = { magazine: 0, reserve: 0 };
    ammo[SCATTERGUN_WEAPON] = { magazine: 0, reserve: 0 };
    ammo[ROCKET_WEAPON] = { magazine: 0, reserve: 0 };
    assert.equal(
      ammo[GRENADE_WEAPON].magazine,
      1,
      'regression requires a loaded grenade',
    );
    setCombatState(shooter, {
      weapon: SIDEARM_WEAPON,
      ammo,
      reloadWeapon: -1,
      reloadCd: 0,
      reloadHeld: false,
    });

    const cmd = new Bot(shooter, seed).think(
      fakeGame(CLEAR_TERRAIN, shooter, target),
    );
    assert.equal(cmd.weapon, SIDEARM_WEAPON);
    assert.ok((cmd.buttons & BTN.RELOAD) !== 0);
    assert.equal(cmd.buttons & BTN.FIRE, 0);
  }
});

test('empty grenade switches to a loaded sidearm when its target moves too close', () => {
  const found = findGrenadeCommand(CLEAR_TERRAIN, 0, -140, 0);
  assert.ok(found);

  const shooter = player(1, 'Bot', 0, 0, 0, true);
  const target = player(2, 'Target', 0, 0, -140, false);
  const ammo = createFullAmmoLoadout();
  ammo[PULSE_RIFLE_WEAPON] = { magazine: 0, reserve: 0 };
  ammo[SCATTERGUN_WEAPON] = { magazine: 0, reserve: 0 };
  ammo[ROCKET_WEAPON] = { magazine: 0, reserve: 0 };
  setCombatState(shooter, {
    weapon: SIDEARM_WEAPON,
    ammo,
    reloadWeapon: -1,
    reloadCd: 0,
    reloadHeld: false,
  });
  const game = fakeGame(CLEAR_TERRAIN, shooter, target);
  const bot = new Bot(shooter, found.seed);

  const grenadeShot = bot.think(game);
  assert.equal(grenadeShot.weapon, GRENADE_WEAPON);
  assert.ok((grenadeShot.buttons & BTN.FIRE) !== 0);

  // Mirror the shot while the target closes inside the 60 m safety boundary.
  shooter.weapon = GRENADE_WEAPON;
  shooter.fireCd = ARTILLERY.interval;
  ammo[GRENADE_WEAPON].magazine = 0;
  target.state.pz = -12;
  game.tick = 1;

  const fallback = bot.think(game);
  assert.equal(fallback.weapon, SIDEARM_WEAPON);
  assert.ok((fallback.buttons & BTN.FIRE) !== 0);
  assert.equal(
    fallback.buttons & BTN.RELOAD,
    0,
    'the bot must not begin a 3.6s grenade reload at close range',
  );
});

test('terrain-blocked artillery is never used as a blind loaded fallback', () => {
  const blockedArc: BallisticTerrain = {
    // Long LOS traces remain clear, but every short ballistic clearance chord
    // meets terrain.
    trace: (_ox, _oy, _oz, _dx, _dy, _dz, maxDist) => (
      maxDist < 10
        ? { hit: true, dist: 0.05 }
        : { hit: false, dist: maxDist }
    ),
  };

  for (let seed = 1; seed <= 32; seed++) {
    const shooter = player(1, 'Bot', 0, 0, 0, true);
    const target = player(2, 'Target', 0, 0, -140, false);
    const ammo = createFullAmmoLoadout();
    ammo[PULSE_RIFLE_WEAPON] = { magazine: 0, reserve: 0 };
    ammo[SCATTERGUN_WEAPON] = { magazine: 0, reserve: 0 };
    ammo[ROCKET_WEAPON] = { magazine: 0, reserve: 0 };
    setCombatState(shooter, {
      weapon: ROCKET_WEAPON,
      ammo,
      reloadWeapon: -1,
      reloadCd: 0,
      reloadHeld: false,
    });

    const cmd = new Bot(shooter, seed).think(
      fakeGame(blockedArc, shooter, target),
    );
    assert.equal(cmd.weapon, SIDEARM_WEAPON);
    assert.notEqual(cmd.weapon, GRENADE_WEAPON);
  }
});

test('infinite sidearm does not eclipse a finite weapon beyond its range', () => {
  for (let seed = 1; seed <= 32; seed++) {
    const shooter = player(1, 'Bot', 0, 0, 0, true);
    const target = player(2, 'Target', 0, 0, -300, false);
    const ammo = createFullAmmoLoadout();
    ammo[PULSE_RIFLE_WEAPON] = { magazine: 0, reserve: 0 };
    ammo[SCATTERGUN_WEAPON] = { magazine: 0, reserve: 0 };
    ammo[GRENADE_WEAPON] = { magazine: 0, reserve: 0 };
    setCombatState(shooter, {
      weapon: SIDEARM_WEAPON,
      ammo,
      reloadWeapon: -1,
      reloadCd: 0,
      reloadHeld: false,
    });

    const cmd = new Bot(shooter, seed).think(
      fakeGame(CLEAR_TERRAIN, shooter, target),
    );
    assert.equal(
      cmd.weapon,
      ROCKET_WEAPON,
      `seed ${seed} chose an out-of-range sidearm`,
    );
  }
});

test('bot uses a loaded fallback instead of selecting empty artillery', () => {
  const seed = findGrenadeCommand(CLEAR_TERRAIN, 0, -140, 0)?.seed;
  assert.ok(seed);
  const shooter = player(1, 'Bot', 0, 0, 0, true);
  const target = player(2, 'Target', 0, 0, -140, false);
  const ammo = createFullAmmoLoadout();
  ammo[SIDEARM_WEAPON] = { magazine: 0, reserve: 0 };
  ammo[PULSE_RIFLE_WEAPON] = { magazine: 0, reserve: 0 };
  ammo[ROCKET_WEAPON] = { magazine: 4, reserve: 16 };
  ammo[GRENADE_WEAPON] = { magazine: 0, reserve: 0 };
  setCombatState(shooter, {
    weapon: SIDEARM_WEAPON,
    ammo,
    reloadWeapon: -1,
    reloadCd: 0,
    reloadHeld: false,
  });

  const cmd = new Bot(shooter, seed).think(fakeGame(CLEAR_TERRAIN, shooter, target));
  assert.equal(cmd.weapon, ROCKET_WEAPON);
  assert.ok((cmd.buttons & BTN.FIRE) !== 0);
});

test('bot queues reload rather than dry-firing when no loaded fallback exists', () => {
  const seed = findGrenadeCommand(CLEAR_TERRAIN, 0, -140, 0)?.seed;
  assert.ok(seed);
  const shooter = player(1, 'Bot', 0, 0, 0, true);
  const target = player(2, 'Target', 0, 0, -140, false);
  const ammo = createFullAmmoLoadout().map(() => ({ magazine: 0, reserve: 0 }));
  ammo[GRENADE_WEAPON] = {
    magazine: 0,
    reserve: ARTILLERY.reserveSize,
  };
  setCombatState(shooter, {
    weapon: SIDEARM_WEAPON,
    ammo,
    reloadWeapon: -1,
    reloadCd: 0,
    reloadHeld: false,
  });

  const cmd = new Bot(shooter, seed).think(fakeGame(CLEAR_TERRAIN, shooter, target));
  assert.equal(cmd.weapon, GRENADE_WEAPON);
  assert.ok((cmd.buttons & BTN.RELOAD) !== 0);
  assert.equal(cmd.buttons & BTN.FIRE, 0);
});

test('bot reloads the one-round grenade launcher immediately after firing it', () => {
  assert.equal(ARTILLERY.magazineSize, 1);
  const found = findGrenadeCommand(CLEAR_TERRAIN, 0, -320, 0);
  assert.ok(found);

  const shooter = player(1, 'Bot', 0, 0, 0, true);
  const target = player(2, 'Target', 0, 0, -320, false);
  const ammo = createFullAmmoLoadout();
  setCombatState(shooter, {
    weapon: SIDEARM_WEAPON,
    ammo,
    reloadWeapon: -1,
    reloadCd: 0,
    reloadHeld: false,
  });
  const game = fakeGame(CLEAR_TERRAIN, shooter, target);
  const bot = new Bot(shooter, found.seed);

  const shot = bot.think(game);
  assert.equal(shot.weapon, GRENADE_WEAPON);
  assert.ok((shot.buttons & BTN.FIRE) !== 0);

  // Mirror the authoritative result of that command before the next bot tick.
  shooter.weapon = GRENADE_WEAPON;
  shooter.fireCd = ARTILLERY.interval;
  ammo[GRENADE_WEAPON].magazine = 0;
  game.tick = 1;
  const reload = bot.think(game);
  assert.equal(reload.weapon, GRENADE_WEAPON);
  assert.ok((reload.buttons & BTN.RELOAD) !== 0);
  assert.equal(reload.buttons & BTN.FIRE, 0);

  const started = stepWeaponState(
    shooter,
    reload.weapon,
    reload.buttons,
    TICK_DT,
  );
  assert.equal(started.reloadStartedWeapon, GRENADE_WEAPON);

  // Full fallback magazines must not make the bot cancel its long artillery
  // reload on the next tick (or any subsequent tick).
  let ticks = 0;
  while (shooter.reloadWeapon >= 0 && ticks < 300) {
    game.tick++;
    const continuing = bot.think(game);
    assert.equal(continuing.weapon, GRENADE_WEAPON);
    assert.equal(continuing.buttons & BTN.FIRE, 0);
    stepWeaponState(
      shooter,
      continuing.weapon,
      continuing.buttons,
      TICK_DT,
    );
    ticks++;
  }
  assert.ok(ticks > 1, 'regression exercised a multi-tick reload');
  assert.equal(shooter.reloadWeapon, -1);
  assert.equal(ammo[GRENADE_WEAPON].magazine, 1);
  assert.equal(
    ammo[GRENADE_WEAPON].reserve,
    ARTILLERY.reserveSize - 1,
  );
});

test('close-range bots keep firing indefinitely across multi-seed ammo cycles', () => {
  const durationTicks = 60 * 60;
  const lateWindowTick = 45 * 60;

  for (let seed = 1; seed <= 8; seed++) {
    const shooter = player(1, 'Bot', 0, 0, 0, true);
    const target = player(2, 'Target', 0, 0, -12, false);
    shooter.fireCd = 0;
    const game = fakeGame(CLEAR_TERRAIN, shooter, target);
    const bot = new Bot(shooter, seed);
    let lateShots = 0;
    let lastShotTick = -1;

    for (let tick = 0; tick < durationTicks; tick++) {
      game.tick = tick;
      const cmd = bot.think(game);
      const result = stepWeaponState(
        shooter,
        cmd.weapon,
        cmd.buttons,
        TICK_DT,
      );
      if (result.firedWeapon >= 0) {
        lastShotTick = tick;
        if (tick >= lateWindowTick) lateShots++;
      }
    }

    assert.ok(
      lateShots >= 8,
      `seed ${seed} stopped fighting after its initial magazines (${lateShots} late shots)`,
    );
    assert.ok(
      lastShotTick >= 55 * 60,
      `seed ${seed} last fired too early at ${(lastShotTick / 60).toFixed(2)}s`,
    );
    assert.equal(
      shooter.ammo[SIDEARM_WEAPON].reserve,
      0,
      'the infinite sidearm must not synthesize replicated reserve rounds',
    );
  }
});

test('long artillery clearance is cached between planning intervals', () => {
  const found = findGrenadeCommand(CLEAR_TERRAIN, 0, -320, 0);
  assert.ok(found);
  let trajectoryTraces = 0;
  const countingTerrain: BallisticTerrain = {
    trace: (_ox, _oy, _oz, _dx, _dy, _dz, maxDist) => {
      if (maxDist < 10) trajectoryTraces++;
      return { hit: false, dist: maxDist };
    },
  };
  const shooter = player(1, 'Bot', 0, 0, 0, true);
  const target = player(2, 'Target', 0, 0, -320, false);
  const game = fakeGame(countingTerrain, shooter, target);
  const bot = new Bot(shooter, found.seed);

  bot.think(game);
  const initialTraces = trajectoryTraces;
  assert.ok(initialTraces > 40, 'initial plan should sample the long arc');
  for (let tick = 1; tick < 12; tick++) {
    game.tick = tick;
    bot.think(game);
  }
  assert.equal(
    trajectoryTraces,
    initialTraces,
    'cached aim avoids repeating the trajectory trace',
  );
  game.tick = 12;
  bot.think(game);
  assert.ok(
    trajectoryTraces > initialTraces,
    'the cache is refreshed after its bounded lifetime',
  );
});

test('bot skips an occluded nearest enemy for a visible target', () => {
  const shooter = player(1, 'Bot', 0, 0, 0, true);
  const hidden = player(2, 'Hidden', 0, 0, -8, false);
  const visible = player(3, 'Visible', 20, 0, 0, false);
  const terrain: BallisticTerrain = {
    trace: (_ox, _oy, _oz, _dx, _dy, _dz, maxDist) => (
      maxDist < 12
        ? { hit: true, dist: maxDist * 0.5 }
        : { hit: false, dist: maxDist }
    ),
  };
  const game = fakeGame(terrain, shooter, hidden, visible);
  const cmd = new Bot(shooter, 77).think(game);
  const direction = viewDir(cmd.yaw, cmd.pitch);
  assert.ok(direction.x > 0.5, 'bot should aim toward the visible enemy on +X');
});

function projectileAt(
  origin: { x: number; y: number; z: number },
  solution: BallisticIntercept,
  time: number,
): { x: number; y: number; z: number } {
  const travel = MUZZLE_OFFSET + SPEED * time;
  return {
    x: origin.x + solution.direction.x * travel,
    y: origin.y + solution.direction.y * travel - 0.5 * GRAVITY * time * time,
    z: origin.z + solution.direction.z * travel,
  };
}

function distance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

const CLEAR_TERRAIN: BallisticTerrain = {
  trace: (_ox, _oy, _oz, _dx, _dy, _dz, maxDist) => ({ hit: false, dist: maxDist }),
};

function findGrenadeCommand(
  terrain: BallisticTerrain,
  tx: number,
  tz: number,
  targetVx: number,
): { seed: number; cmd: ReturnType<Bot['think']> } | null {
  for (let seed = 1; seed <= 128; seed++) {
    const cmd = firstCommand(seed, terrain, tx, tz, targetVx);
    if (cmd.weapon === GRENADE_WEAPON) return { seed, cmd };
  }
  return null;
}

function firstCommand(
  seed: number,
  terrain: BallisticTerrain,
  tx: number,
  tz: number,
  targetVx: number,
): ReturnType<Bot['think']> {
  const shooter = player(1, 'Bot', 0, 0, 0, true);
  const target = player(2, 'Target', tx, 0, tz, false);
  target.state.vx = targetVx;
  const game = fakeGame(terrain, shooter, target);
  return new Bot(shooter, seed).think(game);
}

function player(
  id: number,
  name: string,
  x: number,
  y: number,
  z: number,
  isBot: boolean,
): ServerPlayer {
  const out = new ServerPlayer(id, name, null, isBot, { x, y, z });
  out.state.grounded = true;
  return out;
}

function fakeGame(
  terrain: BallisticTerrain,
  ...players: ServerPlayer[]
): Game {
  return {
    tick: 0,
    areEnemies: Game.prototype.areEnemies,
    players: new Map(players.map((p) => [p.id, p])),
    world: terrain,
  } as unknown as Game;
}

interface TestCombatState {
  weapon: number;
  ammo: WeaponAmmo[];
  reloadWeapon: number;
  reloadCd: number;
  reloadHeld: boolean;
}

function setCombatState(player: ServerPlayer, state: TestCombatState): void {
  Object.assign(player, state);
}


test('occluded crowds have bounded visibility work without starving a farther visible opponent', () => {
  const shooter = player(1, 'Bot', 0, 0, 0, true);
  shooter.ammo = WEAPONS.map((_, i) => ({ magazine: i === 1 ? 20 : 0, reserve: i === 1 ? 100 : 0 }));
  const targets = Array.from({ length: 7 }, (_, i) => player(i + 2, 'Target', (i + 1) * 20, 0, 0, false));
  let traces = 0, reachedVisible = false;
  const terrain: BallisticTerrain = { trace: (_x, _y, _z, _dx, _dy, _dz, distance) => {
    traces++;
    if (distance > 130) { reachedVisible = true; return { hit: false, dist: distance }; }
    return { hit: true, dist: 1 };
  } };
  const game = fakeGame(terrain, shooter, ...targets), bot = new Bot(shooter, 77);
  const scanTicks: number[] = [];
  for (let tick = 0; tick < 90; tick++) {
    game.tick = tick; const before = traces; bot.think(game);
    assert.ok(traces - before <= 2, 'a single bot cannot trace the whole crowd in one tick');
    if (traces !== before) scanTicks.push(tick);
  }
  assert.ok(reachedVisible, 'rotating candidates eventually reaches beyond every occluded neighbor');
  assert.ok(scanTicks.length < 15, 'visibility checks are paced while movement input still runs every tick');
});
