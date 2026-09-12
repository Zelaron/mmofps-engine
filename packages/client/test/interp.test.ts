import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ENT_PLAYER, ENT_PROJECTILE, WEAPONS, createFullAmmoLoadout,
  type Snapshot,
  VEHICLE, rotationFromEuler, rotationToEuler, rotateVector, vehicleQuaternion,
} from '@shared/index';
import { Interp } from '../src/interp.js';

const ROCKET_WEAPON = 3;
const GRENADE_WEAPON = 4;

test('remote aircraft interpolate through vertical and inverted poles without Euler flips', () => {
  for (const pole of [-Math.PI, -Math.PI / 2, Math.PI / 2, Math.PI]) {
    const interp = new Interp();
    for (const [tick, offset] of [[100, -.05], [104, .05]]) {
      const rotation = rotationFromEuler(.6, pole + offset, .9), snap = projectileSnapshot(tick, 3, 1000, 0);
      snap.ents = [{ kind: ENT_PLAYER, id: 42, x: 0, y: 1000, z: 0, yaw: 2, pitch: -.5,
        grounded: false, dead: false, weapon: 0, vehicle: VEHICLE.JET,
        ...rotationToEuler(rotation), vehicleRotation: rotation }];
      interp.push(snap);
    }
    for (let tick = 100; tick <= 104; tick += .25) {
      const actual = vehicleQuaternion(interp.samplePlayers(tick)[0]);
      const expected = rotationFromEuler(.6, pole + (tick - 102) * .025, .9);
      for (const axis of [[0, 1, 0], [0, 0, -1]]) {
        const a = rotateVector(actual, ...axis as [number, number, number]), b = rotateVector(expected, ...axis as [number, number, number]);
        assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < 1e-8,
          'both the nose and cabin up vector follow the shortest physical rotation');
      }
    }
  }
});

function projectileSnapshot(
  tick: number,
  weapon: number,
  y: number,
  vy: number,
  vx = 3,
  vz = -4,
): Snapshot {
  return {
    tick,
    lastSeq: 0,
    you: {
      px: 0, py: 0, pz: 0,
      vx: 0, vy: 0, vz: 0,
      grounded: true,
      alive: true,
      dodgeCd: 0,
      health: 100,
      weapon: 0,
      cooldown: 0,
      ammo: createFullAmmoLoadout(),
      reloadWeapon: -1,
      reloadCooldown: 0,
      reloadHeld: false,
      vehicle: 0, heading: 0, boostFuel: 1, vehicleHealth: 0, lockState: 0,
    },
    ents: [{
      kind: ENT_PROJECTILE,
      id: 17,
      x: 1, y, z: 2,
      vx, vy, vz,
      owner: 9,
      weapon,
    }],
  };
}

test('grenade extrapolation follows its authoritative ballistic gravity', () => {
  const interp = new Interp();
  interp.push(projectileSnapshot(10, GRENADE_WEAPON, 8, 12));
  interp.push(projectileSnapshot(12, GRENADE_WEAPON, 8.38, 11.2));

  const [grenade] = interp.sampleProjectiles(13);
  assert.ok(grenade);
  const dt = 1 / 60;
  const gravity = WEAPONS[GRENADE_WEAPON].gravity ?? 0;
  assert.ok(Math.abs(grenade.y - (8.38 + 11.2 * dt - 0.5 * gravity * dt * dt)) < 1e-9);
  assert.ok(Math.abs(grenade.vy - (11.2 - gravity * dt)) < 1e-9);
  assert.equal(grenade.weapon, GRENADE_WEAPON);
});

test('rocket extrapolation remains gravity-free and explosions retire immediately', () => {
  const interp = new Interp();
  interp.push(projectileSnapshot(20, ROCKET_WEAPON, 5, 6));
  interp.push(projectileSnapshot(22, ROCKET_WEAPON, 5.2, 6));

  const [rocket] = interp.sampleProjectiles(23);
  assert.ok(rocket);
  assert.ok(Math.abs(rocket.y - 5.3) < 1e-9);
  assert.equal(rocket.vy, 6);

  interp.removeProjectile(17);
  assert.deepEqual(interp.sampleProjectiles(23), []);
});

test('a sleeping authoritative grenade stays fixed between snapshots', () => {
  const interp = new Interp();
  interp.push(projectileSnapshot(30, GRENADE_WEAPON, 4.25, 0, 0, 0));
  interp.push(projectileSnapshot(32, GRENADE_WEAPON, 4.25, 0, 0, 0));

  const [grenade] = interp.sampleProjectiles(34);
  assert.ok(grenade);
  assert.equal(grenade.y, 4.25);
  assert.equal(grenade.vy, 0);
});

function playerSnapshot(tick: number, x: number, y: number, z: number): Snapshot {
  const base = projectileSnapshot(tick, GRENADE_WEAPON, 0, 0);
  base.ents = [{
    kind: ENT_PLAYER,
    id: 5,
    x, y, z,
    yaw: 0, pitch: 0,
    dead: false, grounded: false,
    weapon: 0, vehicle: 1, heading: 0,
  }];
  return base;
}

test('player views carry a finite-difference velocity for hull attitude', () => {
  const interp = new Interp();
  // 2 ticks apart, moving (+2, -1, 0): velocity (60, -30, 0) m/s at 60Hz.
  interp.push(playerSnapshot(10, 0, 50, 0));
  interp.push(playerSnapshot(12, 2, 49, 0));

  const [mid] = interp.samplePlayers(11);
  assert.ok(mid);
  assert.ok(Math.abs(mid.vx - 60) < 1e-9, `vx ${mid.vx}`);
  assert.ok(Math.abs(mid.vy + 30) < 1e-9, `vy ${mid.vy}`);
  assert.equal(mid.vz, 0);

  // At/past the newest sample the last pair still supplies the estimate.
  const [tip] = interp.samplePlayers(13);
  assert.ok(tip);
  assert.ok(Math.abs(tip.vx - 60) < 1e-9, `vx ${tip.vx}`);

  // A respawn teleport must not read as a 1200 m/s dive.
  interp.push(playerSnapshot(14, 400, 80, 400));
  const [warped] = interp.samplePlayers(15);
  assert.ok(warped);
  assert.equal(warped.vx, 0);
  assert.equal(warped.vy, 0);
});

test('remote player ground contact follows the render tick through slopes, jump, apex and landing', () => {
  const interp = new Interp();
  const samples = [
    [10, 0, 0, true], [12, 0.2, 0.15, true],
    [14, 0.4, 0.40, false], [16, 0.5, 0.40, false],
    [18, 0.6, 0.2, true],
  ] as const;
  for (const [tick, x, y, grounded] of samples) {
    const snapshot = playerSnapshot(tick, x, y, 0);
    const player = snapshot.ents[0];
    assert.equal(player.kind, ENT_PLAYER);
    if (player.kind === ENT_PLAYER) player.grounded = grounded;
    interp.push(snapshot);
  }
  assert.equal(interp.samplePlayers(9)[0].grounded, true, 'oldest contact before buffer starts');
  const slope = interp.samplePlayers(11)[0];
  assert.equal(slope.grounded, true);
  assert.ok(slope.vy > 4, 'fast height changes on slopes do not mean airborne');
  assert.equal(interp.samplePlayers(13)[0].grounded, true, 'do not start the jump before its tick');
  assert.equal(interp.samplePlayers(14)[0].grounded, false);
  const apex = interp.samplePlayers(15)[0];
  assert.equal(apex.grounded, false);
  assert.equal(apex.vy, 0, 'zero vertical velocity at the apex is still airborne');
  assert.equal(interp.samplePlayers(17)[0].grounded, false, 'do not anticipate contact at the next tick');
  assert.equal(interp.samplePlayers(18)[0].grounded, true);
  assert.equal(interp.samplePlayers(20)[0].grounded, true, 'held snapshots retain their last contact');
  const teleport = playerSnapshot(22, 400, 80, 400);
  const player = teleport.ents[0];
  if (player.kind === ENT_PLAYER) player.grounded = true;
  interp.push(teleport);
  assert.equal(interp.samplePlayers(21)[0].grounded, true, 'teleport guard forwards contact too');
});

test('a new projectile stays hidden before its oldest authoritative sample', () => {
  const interp = new Interp();

  interp.push(projectileSnapshot(10, GRENADE_WEAPON, 10, 12));
  assert.deepEqual(interp.sampleProjectiles(4), []);

  interp.push(projectileSnapshot(12, GRENADE_WEAPON, 12, 11.5));
  interp.push(projectileSnapshot(14, GRENADE_WEAPON, 14, 11));
  interp.push(projectileSnapshot(16, GRENADE_WEAPON, 16, 10.5));

  // The normal six-tick interpolation delay must not expose positions from
  // ticks 12/14/16 before the projectile was first observed at tick 10.
  assert.deepEqual(interp.sampleProjectiles(6), []);
  assert.deepEqual(interp.sampleProjectiles(8), []);
  assert.deepEqual(interp.sampleProjectiles(9.999), []);

  const [born] = interp.sampleProjectiles(10);
  assert.ok(born);
  assert.equal(born.y, 10);
  assert.equal(born.ageTicks, 0);

  const [between] = interp.sampleProjectiles(11);
  assert.ok(between);
  assert.equal(between.y, 11);
});

test('interpolation preserves crew identity in old, bracketed and newest samples and snaps seat transitions',()=>{
 const interp=new Interp();for(const tick of [100,104]){const snap=projectileSnapshot(tick,3,0,0);
  snap.ents=[{kind:ENT_PLAYER,id:42,x:tick-100,y:2,z:0,yaw:.4,pitch:.2,dead:false,grounded:true,weapon:0,
   vehicle:VEHICLE.TANK,vehicleVariant:2,heading:.3,seat:1,vehicleId:73}];interp.push(snap);}
 for(const tick of [98,102,104,108]) {const view=interp.samplePlayers(tick)[0];assert.equal(view.seat,1);assert.equal(view.vehicleId,73);}
 const changed=projectileSnapshot(106,3,0,0);changed.ents=[{kind:ENT_PLAYER,id:42,x:6,y:2,z:0,yaw:1,pitch:0,dead:false,
  grounded:true,weapon:0,vehicle:VEHICLE.TANK,vehicleVariant:3,heading:0,seat:2,vehicleId:99}];interp.push(changed);
 const view=interp.samplePlayers(105)[0];assert.equal(view.seat,2);assert.equal(view.vehicleId,99);assert.equal(view.x,6);
});
