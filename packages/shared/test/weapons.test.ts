import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOUNCY_GRENADES, WEAPONS,
  createWeaponState, refillWeaponAmmo, stepWeaponState,
  BURST_CARBINE_ID, FLECHETTE_REPEATER_ID, PRISM_PROJECTOR_ID, shotInterval, isWeaponSelectable,
} from '@shared/weapons';
import { BTN } from '@shared/movement';
import { NET, PLAYER, TICK_DT, WORLD } from '@shared/constants';

const SIDEARM = 0;
const PULSE_RIFLE = 1;
const SCATTERGUN = 2;
const ROCKET_LAUNCHER = 3;
const GRENADE_LAUNCHER = 4;

test('new found weapons have distinct burst, dart-salvo and plasma roles', () => {
  const burst = WEAPONS[BURST_CARBINE_ID], darts = WEAPONS[FLECHETTE_REPEATER_ID], prism = WEAPONS[PRISM_PROJECTOR_ID];
  assert.equal(WEAPONS.length, 10);
  assert.equal(burst.burstSize, 3);
  assert.ok(burst.spread < WEAPONS[PULSE_RIFLE].spread && burst.range > WEAPONS[PULSE_RIFLE].range);
  assert.ok((burst.burstPause ?? 0) > burst.interval * 4);
  assert.ok(darts.pellets > 1 && darts.pellets < WEAPONS[SCATTERGUN].pellets);
  assert.ok(darts.interval < WEAPONS[SCATTERGUN].interval / 3);
  assert.ok(darts.range < WEAPONS[PULSE_RIFLE].range / 2);
  assert.equal(prism.kind, 'projectile');
  assert.equal(prism.projectile, 'rocket');
  assert.ok(prism.speed! > WEAPONS[ROCKET_LAUNCHER].speed!);
  assert.ok(prism.gravity! > 0 && prism.gravity! < WEAPONS[GRENADE_LAUNCHER].gravity!);
  assert.ok(prism.splashRadius! < WEAPONS[ROCKET_LAUNCHER].splashRadius!);
  assert.ok(prism.damage + prism.splashMax! < 100, 'a small plasma blast cannot replace heavy artillery');
});

test('burst carbine fires actual separated rounds and preserves its pause during replay', () => {
  const state = createWeaponState(BURST_CARBINE_ID), def = WEAPONS[BURST_CARBINE_ID];
  state.ammo[BURST_CARBINE_ID] = { magazine: def.magazineSize, reserve: def.reserveSize };
  const times: number[] = [];
  for (let tick = 0; tick < 100 && times.length < 6; tick++) {
    if (stepWeaponState(state, BURST_CARBINE_ID, BTN.FIRE, TICK_DT).firedWeapon >= 0) times.push(tick * TICK_DT);
  }
  assert.equal(times.length, 6);
  for (const i of [1, 2, 4, 5]) assert.ok(times[i] - times[i - 1] >= .09 && times[i] - times[i - 1] < .12);
  assert.ok(times[3] - times[2] >= .48 && times[3] - times[2] < .51);
  assert.equal(state.ammo[BURST_CARBINE_ID].magazine, def.magazineSize - 6);
  assert.equal(shotInterval(def, def.magazineSize - 3), def.burstPause);
  const replay = structuredClone(state);
  for (let tick = 0; tick < 160; tick++) {
    const buttons = tick < 30 ? 0 : BTN.FIRE;
    assert.deepEqual(stepWeaponState(replay, BURST_CARBINE_ID, buttons, TICK_DT),
      stepWeaponState(state, BURST_CARBINE_ID, buttons, TICK_DT));
    assert.deepEqual(replay, state);
  }
});

test('all found weapons start unavailable, reload acquired ammunition, and disappear on death', () => {
  for (const id of [5, 6, BURST_CARBINE_ID, FLECHETTE_REPEATER_ID, PRISM_PROJECTOR_ID]) {
    const state = createWeaponState(), def = WEAPONS[id];
    assert.equal(def.spawnEmpty, true);
    assert.deepEqual(state.ammo[id], { magazine: 0, reserve: 0 });
    assert.equal(isWeaponSelectable(state.ammo, id), false);
    stepWeaponState(state, id, 0, TICK_DT);
    assert.equal(state.weapon, 0);
    state.ammo[id] = { magazine: 0, reserve: def.magazineSize + 2 };
    assert.equal(stepWeaponState(state, id, 0, TICK_DT).switched, true);
    assert.equal(stepWeaponState(state, id, BTN.RELOAD, TICK_DT).reloadStartedWeapon, id);
    for (let i = 0; i < Math.ceil(def.reloadTime / TICK_DT) + 1; i++) stepWeaponState(state, id, 0, TICK_DT);
    assert.deepEqual(state.ammo[id], { magazine: def.magazineSize, reserve: 2 });
    assert.equal(stepWeaponState(state, id, BTN.FIRE, TICK_DT).firedWeapon, id);
    assert.equal(state.ammo[id].magazine, def.magazineSize - 1);
    assert.equal(state.fireCd, shotInterval(def, def.magazineSize - 1));
    refillWeaponAmmo(state);
    assert.equal(isWeaponSelectable(state.ammo, id), false);
    assert.deepEqual(state.ammo[id], { magazine: 0, reserve: 0 });
  }
});

function ballisticChordPath(
  speed: number,
  gravity: number,
  pitch: number,
  flightTime: number,
): number {
  const vx = Math.cos(pitch) * speed;
  let vy = Math.sin(pitch) * speed;
  let remaining = flightTime;
  let distance = 0;
  while (remaining > 1e-9) {
    const dt = Math.min(TICK_DT, remaining);
    distance += Math.hypot(
      vx * dt,
      vy * dt - 0.5 * gravity * dt * dt,
    );
    vy -= gravity * dt;
    remaining -= dt;
  }
  return distance;
}

test('weapon slot 5 is a genuinely ballistic grenade launcher', () => {
  const grenade = WEAPONS[GRENADE_LAUNCHER];
  assert.equal(grenade.id, GRENADE_LAUNCHER);
  assert.equal(grenade.name, 'Grenade Launcher');
  assert.equal(grenade.kind, 'projectile');
  assert.equal(grenade.projectile, 'grenade');
  assert.ok((grenade.speed ?? 0) > 0);
  assert.ok((grenade.gravity ?? 0) > 0);
  assert.equal(grenade.fuse, undefined);
  assert.equal(grenade.bounces, false);
  assert.equal(grenade.terrainBounceTime, 1);
  assert.equal(grenade.impactOnly, true);
  assert.equal(BOUNCY_GRENADES, false);
  assert.equal(grenade.bounce, 0.42);
  assert.equal(grenade.bounceFriction, 0.72);
  assert.ok((grenade.splashRadius ?? 0) > 0);
  assert.ok((grenade.speed ?? 0) > (WEAPONS[ROCKET_LAUNCHER].speed ?? 0));
  assert.ok((grenade.splashRadius ?? 0) > (WEAPONS[ROCKET_LAUNCHER].splashRadius ?? 0));
  assert.ok((grenade.splashMax ?? 0) > (WEAPONS[ROCKET_LAUNCHER].splashMax ?? 0));
  assert.ok(
    grenade.interval < grenade.reloadTime * 0.1,
    'the one-round reload, not a competing fire timer, sets cadence',
  );
  assert.ok((grenade.splashImpulse ?? 0) > (WEAPONS[ROCKET_LAUNCHER].splashImpulse ?? 0));
  assert.equal(grenade.magazineSize, 1);
  assert.equal(grenade.magazineSize + grenade.reserveSize, 10);
  assert.ok(grenade.range < 1200, 'path budget is derived rather than an arbitrary long lifetime');

  const speed = grenade.speed ?? 0;
  const gravity = grenade.gravity ?? 0;
  const maxDrop =
    WORLD.MAX_HEIGHT + PLAYER.EYE_HEIGHT + 0.5 - WORLD.MIN_CAVE_Y;
  const maxHorizontal =
    speed / gravity * Math.sqrt(speed * speed + 2 * gravity * maxDrop);
  const maxEndpointDistance = Math.hypot(maxHorizontal, maxDrop);
  assert.ok(NET.FIRE_EVENT_RADIUS > maxHorizontal);
  assert.ok(NET.INTEREST_RADIUS > maxEndpointDistance);

  let longestPath = 0;
  for (let i = 0; i <= 720; i++) {
    const pitch = -Math.PI / 2 + Math.PI * i / 720;
    const initialVy = Math.sin(pitch) * speed;
    const flightTime =
      (initialVy + Math.sqrt(initialVy * initialVy + 2 * gravity * maxDrop)) /
      gravity;
    longestPath = Math.max(
      longestPath,
      ballisticChordPath(speed, gravity, pitch, flightTime),
    );
  }
  assert.ok(grenade.range >= longestPath + 10, 'path budget includes a safety margin');
  assert.ok(grenade.range < longestPath + 50, 'path budget remains derived and tight');
});

test('rocket and grenade projectile behavior remain distinct', () => {
  const rocket = WEAPONS[ROCKET_LAUNCHER];
  const grenade = WEAPONS[GRENADE_LAUNCHER];
  assert.equal(rocket.projectile, 'rocket');
  assert.equal(rocket.gravity ?? 0, 0);
  assert.equal(rocket.fuse, undefined);
  assert.equal(rocket.bounce, undefined);
  assert.equal(rocket.terrainBounceTime, undefined);
  assert.notEqual(grenade.projectile, rocket.projectile);
  assert.equal(rocket.magazineSize, 6);
  assert.equal(rocket.magazineSize + rocket.reserveSize, 40);
});

test('every weapon has a wire-safe independent spawn loadout', () => {
  const state = createWeaponState();
  assert.deepEqual(
    WEAPONS.map((weapon) => weapon.name),
    [
      'Sidearm',
      'Pulse Rifle',
      'Scattergun',
      'Rocket Launcher',
      'Grenade Launcher',
      'Gauss Rifle',
      'Nuke Launcher',
      'Burst Carbine',
      'Flechette Repeater',
      'Prism Projector',
    ],
    'the numbered slots must retain their intended weapons and order',
  );
  assert.equal(state.ammo.length, WEAPONS.length);
  for (let i = 0; i < WEAPONS.length; i++) {
    const def = WEAPONS[i];
    assert.equal(def.id, i);
    assert.ok(def.magazineSize > 0);
    assert.ok(def.reserveSize >= 0);
    assert.ok(Number.isFinite(def.reserveSize));
    assert.ok(def.reloadTime > 0);
    assert.deepEqual(state.ammo[i], def.spawnEmpty
      ? { magazine: 0, reserve: 0 }
      : { magazine: def.magazineSize, reserve: def.reserveSize });
  }
});

test('weapon slot 1 is an inaccurate infinite-reserve fallback sidearm', () => {
  const sidearm = WEAPONS[SIDEARM];
  assert.equal(sidearm.id, SIDEARM);
  assert.equal(sidearm.name, 'Sidearm');
  assert.equal(sidearm.kind, 'hitscan');
  assert.equal(sidearm.infiniteReserve, true);
  assert.equal(sidearm.reserveSize, 0, 'wire state uses zero, never Infinity');
  assert.equal(sidearm.magazineSize, 12);
  assert.ok(sidearm.spread >= 0.05);
  assert.ok(sidearm.range <= 240);
  assert.ok(sidearm.reloadTime > 0);
});

test('weapon slot 2 restores the exact historical rapid-fire Pulse Rifle', () => {
  const pulse = WEAPONS[PULSE_RIFLE];
  assert.deepEqual(
    {
      id: pulse.id,
      name: pulse.name,
      kind: pulse.kind,
      interval: pulse.interval,
      damage: pulse.damage,
      pellets: pulse.pellets,
      spread: pulse.spread,
      range: pulse.range,
      knockback: pulse.knockback,
    },
    {
      id: PULSE_RIFLE,
      name: 'Pulse Rifle',
      kind: 'hitscan',
      interval: 0.105,
      damage: 11,
      pellets: 1,
      spread: 0.0175,
      range: 420,
      knockback: 1.4,
    },
  );

  const state = createWeaponState(PULSE_RIFLE);
  const firedTicks: number[] = [];
  for (let tick = 0; tick < 30; tick++) {
    const result = stepWeaponState(
      state,
      PULSE_RIFLE,
      BTN.FIRE,
      TICK_DT,
    );
    if (result.firedWeapon >= 0) firedTicks.push(tick);
  }

  const spacing = Math.ceil(pulse.interval / TICK_DT);
  assert.deepEqual(
    firedTicks.slice(0, 4),
    [0, spacing, spacing * 2, spacing * 3],
    'one held trigger must repeatedly fire at the Pulse Rifle cadence',
  );
});

test('accepted shots consume one round and respect the fire interval', () => {
  const state = createWeaponState(SIDEARM);
  const initialReserve = state.ammo[SIDEARM].reserve;
  const first = stepWeaponState(state, SIDEARM, BTN.FIRE, TICK_DT);
  assert.equal(first.firedWeapon, SIDEARM);
  assert.equal(state.ammo[SIDEARM].magazine, WEAPONS[SIDEARM].magazineSize - 1);
  assert.equal(state.ammo[SIDEARM].reserve, initialReserve);

  const blocked = stepWeaponState(state, SIDEARM, BTN.FIRE, TICK_DT);
  assert.equal(blocked.firedWeapon, -1);
  assert.equal(state.ammo[SIDEARM].magazine, WEAPONS[SIDEARM].magazineSize - 1);

  while (state.fireCd > TICK_DT + 1e-9) {
    stepWeaponState(state, SIDEARM, 0, TICK_DT);
  }
  const second = stepWeaponState(state, SIDEARM, BTN.FIRE, TICK_DT);
  assert.equal(second.firedWeapon, SIDEARM);
  assert.equal(state.ammo[SIDEARM].magazine, WEAPONS[SIDEARM].magazineSize - 2);
});

test('held fire starts reloading the step after it empties a magazine', () => {
  const state = createWeaponState(GRENADE_LAUNCHER);
  const shot = stepWeaponState(state, GRENADE_LAUNCHER, BTN.FIRE, TICK_DT);
  assert.equal(shot.firedWeapon, GRENADE_LAUNCHER);
  assert.equal(state.ammo[GRENADE_LAUNCHER].magazine, 0);
  assert.ok(state.fireCd > 0);
  assert.ok(
    state.fireCd < WEAPONS[GRENADE_LAUNCHER].reloadTime * 0.1,
    'only a brief action lock remains after the shot',
  );

  const reload = stepWeaponState(state, GRENADE_LAUNCHER, BTN.FIRE, TICK_DT);
  assert.equal(reload.reloadStartedWeapon, GRENADE_LAUNCHER);
  assert.equal(state.reloadWeapon, GRENADE_LAUNCHER);
  assert.ok(state.reloadCd > 0);
  assert.ok(state.fireCd > 0, 'auto reload does not wait for the action lock');
});

test('a held single-shot grenade cycles at its reload time', () => {
  const state = createWeaponState(GRENADE_LAUNCHER);
  assert.equal(
    stepWeaponState(state, GRENADE_LAUNCHER, BTN.FIRE, TICK_DT).firedWeapon,
    GRENADE_LAUNCHER,
  );

  let elapsed = 0;
  let secondShot = false;
  for (let i = 0; i < 1000; i++) {
    elapsed += TICK_DT;
    const result = stepWeaponState(state, GRENADE_LAUNCHER, BTN.FIRE, TICK_DT);
    if (result.firedWeapon === GRENADE_LAUNCHER) {
      secondShot = true;
      break;
    }
  }

  assert.ok(secondShot);
  assert.ok(elapsed >= WEAPONS[GRENADE_LAUNCHER].reloadTime);
  assert.ok(
    elapsed <= WEAPONS[GRENADE_LAUNCHER].reloadTime + TICK_DT * 4,
    'the old multi-second fire cooldown must not extend the reload cycle',
  );
});

test('the sidearm reloads a full magazine without creating reserve ammo', () => {
  const state = createWeaponState(SIDEARM);
  state.ammo[SIDEARM] = { magazine: 0, reserve: 0 };

  const started = stepWeaponState(state, SIDEARM, BTN.FIRE, TICK_DT);
  assert.equal(started.reloadStartedWeapon, SIDEARM);

  let completed = false;
  for (let i = 0; i < 1000; i++) {
    const result = stepWeaponState(state, SIDEARM, 0, TICK_DT);
    if (result.reloadCompletedWeapon === SIDEARM) {
      completed = true;
      break;
    }
  }

  assert.ok(completed);
  assert.deepEqual(state.ammo[SIDEARM], {
    magazine: WEAPONS[SIDEARM].magazineSize,
    reserve: 0,
  });
  assert.ok(Number.isFinite(state.ammo[SIDEARM].reserve));
});

test('tactical reload conserves rounds and held R cannot restart it', () => {
  const state = createWeaponState(SCATTERGUN);
  state.ammo[SCATTERGUN] = { magazine: 3, reserve: 2 };

  const start = stepWeaponState(state, SCATTERGUN, BTN.RELOAD | BTN.FIRE, TICK_DT);
  assert.equal(start.reloadStartedWeapon, SCATTERGUN);
  assert.equal(start.firedWeapon, -1, 'reload takes precedence over fire');

  let completed = false;
  for (let i = 0; i < 1000; i++) {
    const result = stepWeaponState(state, SCATTERGUN, BTN.RELOAD, TICK_DT);
    if (result.reloadCompletedWeapon === SCATTERGUN) {
      completed = true;
      break;
    }
  }
  assert.ok(completed);
  assert.deepEqual(state.ammo[SCATTERGUN], { magazine: 5, reserve: 0 });
  assert.equal(state.reloadWeapon, -1);

  for (let i = 0; i < 10; i++) {
    const held = stepWeaponState(state, SCATTERGUN, BTN.RELOAD, TICK_DT);
    assert.equal(held.reloadStartedWeapon, -1);
  }
});

test('switching cancels reload without transferring ammunition', () => {
  const state = createWeaponState(ROCKET_LAUNCHER);
  state.ammo[ROCKET_LAUNCHER] = { magazine: 1, reserve: 6 };
  stepWeaponState(state, ROCKET_LAUNCHER, BTN.RELOAD, TICK_DT);
  assert.equal(state.reloadWeapon, ROCKET_LAUNCHER);

  const switched = stepWeaponState(state, SIDEARM, 0, TICK_DT);
  assert.ok(switched.switched);
  assert.equal(state.weapon, SIDEARM);
  assert.equal(state.reloadWeapon, -1);
  assert.deepEqual(state.ammo[ROCKET_LAUNCHER], { magazine: 1, reserve: 6 });
});

test('an empty trigger auto-reloads from reserve and dry-fires when exhausted', () => {
  const state = createWeaponState(GRENADE_LAUNCHER);
  state.ammo[GRENADE_LAUNCHER] = { magazine: 0, reserve: 2 };
  const auto = stepWeaponState(state, GRENADE_LAUNCHER, BTN.FIRE, TICK_DT);
  assert.equal(auto.reloadStartedWeapon, GRENADE_LAUNCHER);
  assert.equal(auto.firedWeapon, -1);

  state.reloadWeapon = -1;
  state.reloadCd = 0;
  state.ammo[GRENADE_LAUNCHER] = { magazine: 0, reserve: 0 };
  const dry = stepWeaponState(state, GRENADE_LAUNCHER, BTN.FIRE, TICK_DT);
  assert.equal(dry.dryFireWeapon, GRENADE_LAUNCHER);
  assert.equal(dry.firedWeapon, -1);
  assert.equal(state.fireCd, 0.35);

  refillWeaponAmmo(state);
  assert.deepEqual(state.ammo[GRENADE_LAUNCHER], {
    magazine: WEAPONS[GRENADE_LAUNCHER].magazineSize,
    reserve: WEAPONS[GRENADE_LAUNCHER].reserveSize,
  });
});
