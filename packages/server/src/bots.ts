import {
  VEHICLE, vehicleDefinition,
  mulberry32, clamp, TAU, wrapAngle, WORLD,
  quantYaw, unquantYaw, quantPitch, unquantPitch,
  viewDir, WEAPONS, TICK_DT,
  PLAYER, NET, BTN, PICKUP_HEALTH, PICKUP_AMMO, PICKUP_WEAPON, probeGroundBelowPoint, type InputCmd, type WeaponAmmo,
} from '@shared/index';
import type { Game, ServerPlayer, ServerPickup } from './game.js';

// Server-side bots. They produce InputCmds and go through the exact same
// input pipeline as human players, so they continuously exercise movement,
// collision, lag comp and weapons - and give a lone player something to shoot.

export interface BallisticVec3 {
  x: number;
  y: number;
  z: number;
}

export interface BallisticIntercept {
  direction: BallisticVec3;
  /** Seconds from launch until the predicted intercept. */
  time: number;
  yaw: number;
  pitch: number;
}

export interface BallisticInterceptParams {
  origin: BallisticVec3;
  target: BallisticVec3;
  targetVelocity: BallisticVec3;
  speed: number;
  gravity: number;
  /** Distance in front of `origin` at which the projectile is spawned. */
  muzzleOffset?: number;
  /** Latest permitted intercept time, bounded by aiming policy. */
  maxTime: number;
}

/**
 * Solve a fixed-speed ballistic intercept against a linearly moving target.
 *
 * The projectile starts `muzzleOffset` metres along its launch direction and
 * then follows constant downward acceleration. The resulting equation is a
 * quartic for a moving target. Sampling it into sign brackets and bisecting
 * those brackets is inexpensive at bot scale, finds both low and high arcs,
 * and is considerably less fragile near maximum range than iterative lead.
 */
export function solveBallisticIntercept(params: BallisticInterceptParams): BallisticIntercept[] {
  const {
    origin, target, targetVelocity,
    speed, gravity, maxTime,
  } = params;
  const muzzleOffset = Math.max(0, params.muzzleOffset ?? 0);
  if (
    !(speed > 0) || !(maxTime > 0) || !(gravity >= 0) ||
    !finiteVec(origin) || !finiteVec(target) || !finiteVec(targetVelocity)
  ) {
    return [];
  }

  const residual = (t: number): number => {
    const rx = target.x + targetVelocity.x * t - origin.x;
    const ry = target.y + targetVelocity.y * t - origin.y + 0.5 * gravity * t * t;
    const rz = target.z + targetVelocity.z * t - origin.z;
    const travel = muzzleOffset + speed * t;
    return rx * rx + ry * ry + rz * rz - travel * travel;
  };

  // Half-tick sampling comfortably brackets the two ordinary roots. Retain a
  // minimum density for callers using a short custom maxTime in unit tests.
  const samples = Math.max(96, Math.ceil(maxTime / (TICK_DT * 0.5)));
  const roots: number[] = [];
  let loT = 1e-5;
  let loF = residual(loT);

  for (let i = 1; i <= samples; i++) {
    const hiT = maxTime * i / samples;
    const hiF = residual(hiT);

    if (Number.isFinite(loF) && Number.isFinite(hiF)) {
      if (loF === 0) addRoot(roots, loT);
      if (hiF === 0) addRoot(roots, hiT);
      if ((loF < 0 && hiF > 0) || (loF > 0 && hiF < 0)) {
        let a = loT, b = hiT;
        let fa = loF;
        for (let j = 0; j < 42; j++) {
          const mid = (a + b) * 0.5;
          const fm = residual(mid);
          if ((fa < 0 && fm > 0) || (fa > 0 && fm < 0)) {
            b = mid;
          } else {
            a = mid;
            fa = fm;
          }
        }
        addRoot(roots, (a + b) * 0.5);
      }
    }
    loT = hiT;
    loF = hiF;
  }

  const out: BallisticIntercept[] = [];
  for (const time of roots) {
    const rx = target.x + targetVelocity.x * time - origin.x;
    const ry = target.y + targetVelocity.y * time - origin.y + 0.5 * gravity * time * time;
    const rz = target.z + targetVelocity.z * time - origin.z;
    const len = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (!(len > 1e-8)) continue;
    const direction = { x: rx / len, y: ry / len, z: rz / len };
    out.push({
      direction,
      time,
      yaw: Math.atan2(-direction.x, -direction.z),
      pitch: Math.atan2(direction.y, Math.hypot(direction.x, direction.z)),
    });
  }
  return out;
}

function finiteVec(v: BallisticVec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function addRoot(roots: number[], t: number): void {
  if (!(t > 0) || !Number.isFinite(t)) return;
  if (roots.some((r) => Math.abs(r - t) < 1e-4)) return;
  roots.push(t);
}

export interface BallisticTerrain {
  trace(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): { hit: boolean; dist: number };
}

export interface BallisticClearanceParams {
  origin: BallisticVec3;
  direction: BallisticVec3;
  speed: number;
  gravity: number;
  muzzleOffset: number;
  flightTime: number;
  projectileRadius: number;
}

/**
 * Validate the quantized launch direction with conservative two-tick chords.
 * The small radius inflation covers the maximum gravitational sag between a
 * two-tick chord and the authoritative one-tick chords. Any terrain contact
 * rejects this direct arc so bots do not blindly fire artillery into cave
 * walls.
 */
export function ballisticArcClear(
  terrain: BallisticTerrain,
  params: BallisticClearanceParams,
): boolean {
  const {
    origin, direction, speed, gravity,
    muzzleOffset, flightTime, projectileRadius,
  } = params;
  if (
    !(speed > 0) || !(flightTime > 0) || gravity < 0 ||
    !finiteVec(origin) || !finiteVec(direction)
  ) {
    return false;
  }

  const pointAt = (t: number): BallisticVec3 => {
    const travel = muzzleOffset + speed * t;
    return {
      x: origin.x + direction.x * travel,
      y: origin.y + direction.y * travel - 0.5 * gravity * t * t,
      z: origin.z + direction.z * travel,
    };
  };

  // Check the short muzzle offset too. The server intentionally spawns there,
  // but a bot should not fire if that spawn point is already behind terrain.
  let previous = origin;
  let t = 0;
  const spawn = pointAt(0);
  if (!traceSegmentClear(terrain, previous, spawn, projectileRadius)) return false;
  previous = spawn;

  const traceStep = TICK_DT * 2;
  const chordSag = gravity * traceStep * traceStep / 8;
  const clearanceRadius = projectileRadius + chordSag + 0.01;
  while (t < flightTime - 1e-9) {
    t = Math.min(flightTime, t + traceStep);
    const next = pointAt(t);
    if (!traceSegmentClear(terrain, previous, next, clearanceRadius)) return false;
    previous = next;
  }
  return true;
}

/**
 * Chord distance consumed by the authoritative 60Hz projectile integrator.
 * Ballistic flight time cannot be bounded by range / launchSpeed: ascent slows
 * the projectile, so a valid high arc may remain airborne longer while still
 * consuming less than its path budget.
 */
export function ballisticPathDistance(
  direction: BallisticVec3,
  speed: number,
  gravity: number,
  flightTime: number,
): number {
  if (
    !finiteVec(direction) ||
    !(speed > 0) ||
    !(gravity >= 0) ||
    !(flightTime >= 0)
  ) {
    return Infinity;
  }
  let vx = direction.x * speed;
  let vy = direction.y * speed;
  let vz = direction.z * speed;
  let remaining = flightTime;
  let distance = 0;
  while (remaining > 1e-9) {
    const dt = Math.min(TICK_DT, remaining);
    const sx = vx * dt;
    const sy = vy * dt - 0.5 * gravity * dt * dt;
    const sz = vz * dt;
    distance += Math.sqrt(sx * sx + sy * sy + sz * sz);
    vy -= gravity * dt;
    remaining -= dt;
  }
  return distance;
}

function traceSegmentClear(
  terrain: BallisticTerrain,
  a: BallisticVec3,
  b: BallisticVec3,
  radius: number,
): boolean {
  const sx = b.x - a.x, sy = b.y - a.y, sz = b.z - a.z;
  const len = Math.sqrt(sx * sx + sy * sy + sz * sz);
  if (len < 1e-9) return true;
  const th = terrain.trace(a.x, a.y, a.z, sx / len, sy / len, sz / len, len + radius);
  if (!th.hit) return true;
  return Math.max(0, th.dist - radius) > len;
}

const BOT_NAMES = [
  'Steven Seagull', 'Bruise Lee', 'Spruce Willis', 'Snackie Chan',
  'Jason Mimosa', 'Harrison Sword', 'John Lambo', 'Duck Norris',
  'Sylvester Calzone', 'Lint Eastwood', 'Rat Damon', 'Tom Booze',
  'Roger Boar', 'Russell Dough', 'Orlando Broom',
];

const SIDEARM_WEAPON = 0;
const PULSE_RIFLE_WEAPON = 1;
const SCATTERGUN_WEAPON = 2;
const ROCKET_WEAPON = 3;
const GRENADE_WEAPON = 4;
const GRENADE_MIN_RANGE = 60;
const GRENADE_PREFERRED_MIN = 100;
const GRENADE_PREFERRED_MAX = 330;
const GRENADE_MAX_RANGE = 370;
const GRENADE_MAX_FLIGHT_TIME = 12;
/** Long artillery traces are expensive; 200 ms remains modest beside an 11.5 m blast. */
const GRENADE_PLAN_TICKS = 12;
const BOT_ACQUIRE_RANGE = 390;

interface BotCombatState {
  ammo?: WeaponAmmo[];
  reloadWeapon?: number;
  reloadCd?: number;
  reloadHeld?: boolean;
}

function combatState(player: ServerPlayer): BotCombatState {
  return player as ServerPlayer & BotCombatState;
}

function weaponAmmo(player: ServerPlayer, weapon: number): WeaponAmmo {
  return combatState(player).ammo?.[weapon] ?? {
    magazine: WEAPONS[weapon]?.magazineSize ?? 1,
    reserve: WEAPONS[weapon]?.reserveSize ?? 0,
  };
}

function weaponLoaded(player: ServerPlayer, weapon: number): boolean {
  return weaponAmmo(player, weapon).magazine > 0;
}

function weaponHasAmmo(player: ServerPlayer, weapon: number): boolean {
  const ammo = weaponAmmo(player, weapon);
  return WEAPONS[weapon]?.infiniteReserve === true ||
    ammo.magazine > 0 ||
    ammo.reserve > 0;
}

function weaponCanReload(player: ServerPlayer, weapon: number): boolean {
  const ammo = weaponAmmo(player, weapon);
  const def = WEAPONS[weapon];
  return !!def &&
    ammo.magazine < def.magazineSize &&
    (def.infiniteReserve === true || ammo.reserve > 0);
}

function activeReloadWeapon(player: ServerPlayer): number {
  return combatState(player).reloadWeapon ?? -1;
}

function reloadInputHeld(player: ServerPlayer): boolean {
  return combatState(player).reloadHeld ?? false;
}

function weaponCoversDistance(
  weapon: number,
  dist: number,
  grenadeMaxRange = GRENADE_MAX_RANGE,
): boolean {
  if (!Number.isFinite(dist)) return true;
  if (weapon === GRENADE_WEAPON) {
    return dist >= GRENADE_MIN_RANGE && dist <= grenadeMaxRange;
  }
  const def = WEAPONS[weapon];
  return !!def && dist <= def.range;
}

interface GrenadeAim {
  yaw: number;
  pitch: number;
}

export function botName(i: number): string {
  const base = BOT_NAMES[i % BOT_NAMES.length];
  return i < BOT_NAMES.length ? base : `${base}-${Math.floor(i / BOT_NAMES.length) + 1}`;
}

export class Bot {
  private rng: () => number;
  private seq = 0;

  private targetX = 0;
  private targetZ = 0;
  private repathAtTick = 0;

  private strafeDir = 1;
  private strafeFlipAt = 0;
  private fireCycleAt = 0;
  private firing = false;

  private stuckCheckAt = 0;
  private stuckX = 0;
  private stuckZ = 0;

  private weaponPickAt = 0;
  private weapon = 0;

  private enemyId = -1;
  private losCheckAt = 0;
  private losOk = false;
  private losCursor = 0;
  private losStarted = false;
  private seekCheckAt = 0;

  private lastUseTick = -1e9;
  private enterScanAt = 0;
  private reverseUntil = -1;
  private grenadeAim: GrenadeAim | null = null;
  private grenadeAimEnemyId = -1;
  private grenadeAimUntil = 0;
  private wasAlive = true;
  private pickupId = -1;
  private pickupWeapon = -1;
  private pickupScanAt = 0;
  private pickupUntil = 0;
  private failedPickupId = -1;
  private failedPickupUntil = 0;
  private vehicleGoal = -1;
  private failedVehicleId = -1;
  private failedVehicleUntil = 0;
  private obstacleScanAt = 0;
  private avoidUntil = 0;
  private avoidDir = 1;
  private flightGround = 0;

  get intent() { return {pickupId:this.pickupId,vehicleId:this.vehicleGoal,x:this.targetX,z:this.targetZ}; }

  constructor(readonly player: ServerPlayer, seed: number) {
    this.rng = mulberry32(seed ^ Math.imul(player.id % 0x1_0000_0000, 7919));
    this.weapon = player.weapon;
  }

  think(game: Game): InputCmd {
    const p = this.player;
    const s = p.state;
    const tick = game.tick;
    if(this.stuckCheckAt===0){this.stuckCheckAt=tick+54;this.stuckX=s.px;this.stuckZ=s.pz;}
    let buttons = 0;
    let yaw = p.lastCmd ? p.lastCmd.yaw : 0;
    let pitch = 0;

    if (s.alive && !this.wasAlive) {
      this.weapon = p.weapon;
      this.weaponPickAt = 0;
      this.grenadeAim = null;
      this.grenadeAimEnemyId = -1;
      this.grenadeAimUntil = 0;
      this.firing = false;
      this.fireCycleAt = tick + 12;
      this.pickupId = this.vehicleGoal = -1;
      this.pickupScanAt = this.enterScanAt = 0;
      this.repathAtTick = 0;
    }

    const reloadAtStart = activeReloadWeapon(p);
    const wasReloading = reloadAtStart >= 0;
    if (wasReloading) this.weapon = p.weapon;

    // ---- Vehicles: keep driving an occupied hull.
    if (s.alive && s.vehicle !== VEHICLE.NONE) {
      const drive = this.driveVehicle(game, tick);
      this.wasAlive = s.alive;
      this.seq++;
      return {
        seq: this.seq,
        buttons: drive.buttons,
        weapon: this.weapon,
        yaw: unquantYaw(quantYaw(drive.yaw)),
        pitch: unquantPitch(quantPitch(clamp(drive.pitch, -1.4, 1.4))),
        renderTick: Math.max(0, tick - NET.INTERP_TICKS),
        renderFrac: 0,
      };
    }

    if (s.alive) {
      const enemy = this.acquireEnemy(game);
      const pickup = this.seekPickup(game,tick);
      const enemyDistance = enemy ? Math.hypot(enemy.state.px-s.px,enemy.state.pz-s.pz) : Infinity;
      const pickupDetour = !!pickup && (!enemy || (enemyDistance>45 && Math.hypot(pickup.x-s.px,pickup.z-s.pz)<32));
      const routePickup = !enemy || pickupDetour ? pickup : null;
      // A visible opponent is the usual arena state. Take nearby armor during
      // that fight instead of waiting for a rare completely peaceful moment.
      // Keep close firefights local and preserve an already short approach.
      const boardingRange = enemyDistance > 35 ? Math.min(55,enemyDistance*.55) : 12;
      const vehicleInput = enemy && !pickupDetour ? this.maybeEnterVehicle(game,tick,boardingRange) : 0;
      const detour = pickupDetour || this.vehicleGoal >= 0 || (vehicleInput & BTN.USE) !== 0;
      if (enemy && !detour) {
        const ex = enemy.state.px - s.px;
        const ey = (enemy.state.py + 1.2) - (s.py + PLAYER.EYE_HEIGHT);
        const ez = enemy.state.pz - s.pz;
        const distXZ = Math.sqrt(ex * ex + ez * ez);
        const dist = Math.sqrt(ex * ex + ey * ey + ez * ez);

        // Burst fire with pauses so bots are beatable.
        if (tick >= this.fireCycleAt) {
          this.firing = !this.firing;
          this.fireCycleAt = tick + Math.floor((this.firing ? 30 : 18) + this.rng() * 20);
        }

        const grenadeMaxRange = this.grenadeMaxRange(enemy);

        // Weapon choice by range and ammunition, re-evaluated occasionally.
        // Do not abandon an almost-complete reload just because the random
        // range scorer woke up this tick.
        if (!wasReloading && tick >= this.weaponPickAt) {
          this.weaponPickAt = tick + 120;
          this.weapon = this.chooseCombatWeapon(p, dist, grenadeMaxRange);
        }

        let reloadQueued = false;

        // An empty weapon never receives FIRE. Once a reload has begun, commit
        // to it: repeatedly cancelling a finite reload for another loaded gun
        // can livelock when that fallback is unsuitable for the current range.
        if (wasReloading) {
          this.weapon = p.weapon;
        } else if (!weaponLoaded(p, this.weapon)) {
          // Rechamber the one-shot grenade launcher while its target remains
          // inside the artillery envelope. If the fight has moved too close
          // or too far away, use an immediately useful loaded fallback.
          if (
            this.weapon === GRENADE_WEAPON &&
            weaponCoversDistance(
              GRENADE_WEAPON,
              dist,
              grenadeMaxRange,
            ) &&
            weaponCanReload(p, GRENADE_WEAPON)
          ) {
            reloadQueued = true;
            if (!reloadInputHeld(p)) buttons |= BTN.RELOAD;
            this.firing = false;
            this.fireCycleAt = tick + 12;
          } else {
            const fallback = this.loadedFallback(p, dist, this.weapon);
            if (fallback >= 0) {
              this.weapon = fallback;
              this.weaponPickAt = Math.min(this.weaponPickAt, tick + 60);
            } else {
              const reloadable = this.reloadableFallback(p, dist, this.weapon);
              if (reloadable >= 0) {
                this.weapon = reloadable;
                if (!reloadInputHeld(p)) {
                  buttons |= BTN.RELOAD;
                  reloadQueued = true;
                  this.firing = false;
                  this.fireCycleAt = tick + 12;
                }
              }
            }
          }
        }

        let grenadeReady = false;
        if (
          this.weapon === GRENADE_WEAPON &&
          !wasReloading &&
          !reloadQueued &&
          weaponLoaded(p, GRENADE_WEAPON)
        ) {
          if (dist < GRENADE_MIN_RANGE || dist > grenadeMaxRange) {
            this.grenadeAim = null;
          } else if (
            this.grenadeAimEnemyId !== enemy.id ||
            tick >= this.grenadeAimUntil
          ) {
            this.grenadeAim = this.planGrenadeAim(game, enemy);
            this.grenadeAimEnemyId = enemy.id;
            this.grenadeAimUntil = tick + GRENADE_PLAN_TICKS;
          }

          if (this.grenadeAim) {
            yaw = this.grenadeAim.yaw;
            pitch = this.grenadeAim.pitch;
            grenadeReady = true;
          } else {
            // Never lob at an unreachable or terrain-blocked target. Choose a
            // loaded, range-appropriate conventional fallback instead.
            const fallback = this.loadedFallback(p, dist, GRENADE_WEAPON);
            this.weapon = fallback >= 0 ? fallback : this.reloadableFallback(p, dist, GRENADE_WEAPON);
            if (this.weapon < 0) this.weapon = p.weapon;
            if (!weaponLoaded(p, this.weapon) &&
                weaponCanReload(p, this.weapon) &&
                !reloadInputHeld(p)) {
              buttons |= BTN.RELOAD;
              reloadQueued = true;
              this.firing = false;
              this.fireCycleAt = tick + 12;
            }
            this.weaponPickAt = Math.min(this.weaponPickAt, tick + 30);
          }
        }

        if (this.weapon !== GRENADE_WEAPON) {
          const aimErr = 0.022 + dist * 0.00042;
          yaw = Math.atan2(-ex, -ez) + (this.rng() - 0.5) * aimErr * 6;
          pitch = Math.atan2(ey, distXZ) + (this.rng() - 0.5) * aimErr * 4;
        }
        const mayFire =
          !wasReloading &&
          !reloadQueued &&
          weaponLoaded(p, this.weapon) &&
          (this.weapon !== GRENADE_WEAPON || grenadeReady);
        if (this.firing && mayFire) buttons |= BTN.FIRE;

        // Strafe orbit, keep medium distance.
        if (tick >= this.strafeFlipAt) {
          this.strafeDir = this.rng() < 0.5 ? -1 : 1;
          this.strafeFlipAt = tick + Math.floor(40 + this.rng() * 60);
        }
        buttons |= this.strafeDir > 0 ? BTN.RIGHT : BTN.LEFT;
        if (distXZ > 26) buttons |= BTN.FORWARD;
        else if (distXZ < 9) buttons |= BTN.BACK;

        if (this.rng() < 0.004) buttons |= BTN.JUMP;
        if (this.rng() < 0.006 && s.dodgeCd <= 0) buttons |= BTN.DODGE;
      } else {
        // Follow the resource approach, or seek toward the nearest human
        // (fall back to the nearest bot) so fights find the players.
        // NOTE: linear scan is fine at MVP scale; at thousands of players
        // this becomes a spatial-grid nearest query (see ARCHITECTURE.md).
        if (!routePickup && this.vehicleGoal<0 && tick >= this.seekCheckAt) {
          this.seekCheckAt = tick + 150 + Math.floor(this.rng() * 60);
          let best: ServerPlayer | null = null;
          let bestD2 = Infinity;
          for (const q of game.players.values()) {
            if (!game.areEnemies(p, q) || !q.state.alive) continue;
            const dx = q.state.px - s.px, dz = q.state.pz - s.pz;
            let d2 = dx * dx + dz * dz;
            if (q.isBot) d2 *= 9; // strongly prefer humans
            if (d2 < bestD2) { bestD2 = d2; best = q; }
          }
          if (best) {
            // Head to a point near them, not on top of them.
            this.targetX = best.state.px + (this.rng() - 0.5) * 60;
            this.targetZ = best.state.pz + (this.rng() - 0.5) * 60;
            this.repathAtTick = tick + 20 * 60;
          }
        }
        const objective = game.frontier?.objective(p);
        if (objective && !routePickup && this.vehicleGoal < 0) {
          this.targetX = objective.x + Math.sin((p.id % 65536) * 2.4) * 12;
          this.targetZ = objective.z + Math.cos((p.id % 65536) * 2.4) * 12;
          this.repathAtTick = tick + 120;
        }
        // Wander between (seeked or random) ground points.
        const dx = this.targetX - s.px;
        const dz = this.targetZ - s.pz;
        if (tick >= this.repathAtTick || dx * dx + dz * dz < 9) {
          const ang = this.rng() * TAU;
          const r = 40 + this.rng() * 120;
          this.targetX = clamp(s.px + Math.cos(ang) * r, -WORLD.BORDER+150, WORLD.BORDER-150);
          this.targetZ = clamp(s.pz + Math.sin(ang) * r, -WORLD.BORDER+150, WORLD.BORDER-150);
          this.repathAtTick = tick + 12 * 60;
        }
        if(routePickup) {this.targetX=routePickup.x;this.targetZ=routePickup.z;this.repathAtTick=tick+120;}
        else buttons |= enemy ? vehicleInput : this.maybeEnterVehicle(game, tick);
        yaw = Math.atan2(-(this.targetX - s.px), -(this.targetZ - s.pz)) + (routePickup || this.vehicleGoal>=0 ? 0 : (this.rng() - 0.5) * 0.2);
        pitch = 0;
        buttons |= BTN.FORWARD;

        // Quiet moments are the right time to top off. If the current weapon
        // is completely dry, first move to a loaded general-purpose option;
        // otherwise queue one reload edge while continuing to navigate.
        if (!wasReloading) {
          if (!weaponHasAmmo(p, this.weapon)) {
            const fallback = this.loadedFallback(p, Infinity, this.weapon);
            if (fallback >= 0) this.weapon = fallback;
          }
          const ammo = weaponAmmo(p, this.weapon);
          const def = WEAPONS[this.weapon];
          const usefulPartial =
            !!def &&
            (def.infiniteReserve === true || ammo.reserve > 0) &&
            ammo.magazine < Math.ceil(def.magazineSize * 0.7);
          if (usefulPartial && !reloadInputHeld(p)) {
            buttons |= BTN.RELOAD;
            this.firing = false;
            this.fireCycleAt = tick + 12;
          }
        }

        // Stuck? Hop and consider a new target.
        if (tick >= this.stuckCheckAt) {
          const moved = Math.hypot(s.px - this.stuckX, s.pz - this.stuckZ);
          if (moved < 0.6 && s.grounded) {
            buttons |= BTN.JUMP;
            if(this.pickupId>=0){this.failedPickupId=this.pickupId;this.failedPickupUntil=tick+600;this.pickupId=-1;}
            if(this.vehicleGoal>=0){this.failedVehicleId=this.vehicleGoal;this.failedVehicleUntil=tick+600;this.vehicleGoal=-1;}
            if (this.rng() < 0.5) this.repathAtTick = 0;
          }
          this.stuckX = s.px;
          this.stuckZ = s.pz;
          this.stuckCheckAt = tick + 54;
        }
      }
    }

    this.wasAlive = s.alive;
    this.seq++;
    // Grenade plans already contain wire-quantized angles. Quantizing all
    // paths here remains harmless and preserves the bot/client input invariant.
    return {
      seq: this.seq,
      buttons,
      weapon: this.weapon,
      yaw: unquantYaw(quantYaw(yaw)),
      pitch: unquantPitch(quantPitch(clamp(pitch, -1.4, 1.4))),
      renderTick: Math.max(0, tick - NET.INTERP_TICKS),
      renderFrac: 0,
    };
  }

  /**
   * Simple but effective vehicle brain: chase the nearest enemy, keep the
   * throttle open, fire the mounted weapon inside its envelope, use the
   * tank's cluster shell at medium range, and bail out of a burning hull.
   * Ground steering is independent from weapon aim; a separate bounded
   * flight controller handles runway takeoff, banking and terrain clearance.
   */
  private driveVehicle(
    game: Game,
    tick: number,
  ): { buttons: number; yaw: number; pitch: number } {
    const p = this.player;
    const s = p.state;
    let buttons = 0;
    let yaw = s.heading;
    let pitch = 0;

    const hull = game.vehicles?.get(p.vehicleId);
    const def = vehicleDefinition(s.vehicle,s.vehicleVariant)!;
    if (hull && def && hull.health < def.maxHealth * 0.18 &&
        tick - this.lastUseTick > 90) {
      this.lastUseTick = tick;
      return { buttons: BTN.USE, yaw, pitch };
    }
    if((s.seat??0)>0) {
      const target=this.acquireEnemy(game);
      if(!target)return {buttons:0,yaw,pitch};
      const dx=target.state.px-s.px,dz=target.state.pz-s.pz;
      return {buttons:BTN.FIRE,yaw:Math.atan2(-dx,-dz),pitch:Math.atan2(target.state.py-s.py,Math.hypot(dx,dz))};
    }
    if(s.vehicle===VEHICLE.JET)return this.flyJet(game,tick);

    const enemy = this.acquireEnemy(game);
    if (enemy) {
      const ex = enemy.state.px - s.px;
      const ey = (enemy.state.py + 1.2) - (s.py + def.radius + 0.9);
      const ez = enemy.state.pz - s.pz;
      const dist = Math.hypot(ex, ey, ez);
      yaw = Math.atan2(-ex, -ez);
      if (s.vehicle === VEHICLE.TANK) {
        // Crude ballistic hold-over for the cannon's arc.
        pitch = Math.atan2(ey, Math.hypot(ex, ez)) + dist * 0.0022;
        if (dist > 24) buttons |= BTN.FORWARD;
        if (dist < 340 && this.losOk) buttons |= BTN.FIRE;
        if (dist > 90 && dist < 320 && this.rng() < 0.015) buttons |= BTN.ALTFIRE;
      } else {
        pitch = Math.atan2(ey, Math.hypot(ex, ez));
        if (dist > 20) buttons |= BTN.FORWARD;
        if (dist < 250 && this.losOk) buttons |= BTN.FIRE;
        if (dist > 160 && this.rng() < 0.03) buttons |= BTN.ALTFIRE; // boost
      }
      // Refresh the shared LOS cache used by the on-foot brain.
      if (tick >= this.losCheckAt) {
        this.losCheckAt = tick + 12;
        const oy = s.py + def.radius + 0.9;
        const th = game.world.trace(
          s.px, oy, s.pz,
          ex / dist, ey / dist, ez / dist, dist,
        );
        this.losOk = !th.hit;
      }
    } else {
      // Cruise between wander points, boosting on open stretches.
      const dx = this.targetX - s.px;
      const dz = this.targetZ - s.pz;
      if (tick >= this.repathAtTick || dx * dx + dz * dz < 160) {
        const ang = this.rng() * TAU;
        const r = 120 + this.rng() * 240;
        this.targetX = clamp(s.px + Math.cos(ang) * r, -WORLD.BORDER+150, WORLD.BORDER-150);
        this.targetZ = clamp(s.pz + Math.sin(ang) * r, -WORLD.BORDER+150, WORLD.BORDER-150);
        this.repathAtTick = tick + 15 * 60;
      }
      yaw = Math.atan2(-(this.targetX - s.px), -(this.targetZ - s.pz));
      buttons |= BTN.FORWARD;
      if (s.vehicle === VEHICLE.JEEP && this.rng() < 0.02) buttons |= BTN.ALTFIRE;
    }

    // Ground hulls steer with A/D (the aim yaw only points the weapons),
    // so press toward the desired course with a small deadband.
    const speed=Math.hypot(s.vx,s.vz),forward=viewDir(s.heading,0),look=clamp(speed*.6+5,7,23);
    if(tick>=this.obstacleScanAt) {
      this.obstacleScanAt=tick+18;
      const hit=game.world.trace(s.px,s.py+def.radius,s.pz,forward.x,0,forward.z,look);
      const nx=s.px+forward.x*look,nz=s.pz+forward.z*look;
      const ground=s.vehicle===VEHICLE.GUNBOAT ? !!game.world.liquidAt(nx,s.py,nz) : probeGroundBelowPoint(game.world,nx,s.py+2,nz,5);
      if(hit.hit||!ground){this.avoidUntil=tick+85;this.avoidDir=this.rng()<.5?-1:1;this.reverseUntil=tick+24;}
    }
    const steerErr = tick<this.avoidUntil ? this.avoidDir*.9 : wrapAngle(yaw-s.heading);
    if (steerErr > 0.06) buttons |= BTN.LEFT;
    else if (steerErr < -0.06) buttons |= BTN.RIGHT;
    if(Math.abs(steerErr)>1.1&&speed>7){buttons&=~BTN.FORWARD;buttons|=BTN.BACK;}

    // Stuck against a cliff: back straight out and repath.
    if (tick >= this.stuckCheckAt) {
      const moved = Math.hypot(s.px - this.stuckX, s.pz - this.stuckZ);
      if (moved < 0.8) {
        this.reverseUntil = tick + 45;
        this.repathAtTick = 0;
      }
      this.stuckX = s.px;
      this.stuckZ = s.pz;
      this.stuckCheckAt = tick + 60;
    }
    if (tick < this.reverseUntil) {
      buttons &= ~(BTN.FORWARD | BTN.LEFT | BTN.RIGHT);
      buttons |= BTN.BACK;
    }
    return { buttons, yaw, pitch };
  }

  private flyJet(game:Game,tick:number):{buttons:number;yaw:number;pitch:number} {
    const s=this.player.state;
    let buttons=BTN.THROTTLE as number;
    if(tick>=this.obstacleScanAt) {
      this.obstacleScanAt=tick+24;
      const f=viewDir(s.heading,0),distance=140;
      this.flightGround=Math.max(game.world.terrainHeight(s.px,s.pz),game.world.terrainHeight(s.px+f.x*distance,s.pz+f.z*distance));
      const hit=game.world.trace(s.px,s.py+2,s.pz,f.x,0,f.z,distance);
      if(hit.hit)this.flightGround=Math.max(this.flightGround,s.py+90);
    }
    if(tick>=this.repathAtTick || Math.hypot(this.targetX-s.px,this.targetZ-s.pz)<130) {
      const heading=s.heading+(s.grounded?0:(this.rng()-.5)*1.4),f=viewDir(heading,0);
      this.targetX=clamp(s.px+f.x*900,-WORLD.BORDER+650,WORLD.BORDER-650);
      this.targetZ=clamp(s.pz+f.z*900,-WORLD.BORDER+650,WORLD.BORDER-650);
      this.repathAtTick=tick+600;
    }
    const heading=Math.atan2(s.px-this.targetX,s.pz-this.targetZ),courseError=wrapAngle(heading-s.heading);
    const targetBank=s.grounded?0:clamp(courseError*.65,-.5,.5);
    const bankError=wrapAngle(targetBank-s.vehicleRoll);
    if(s.grounded){if(courseError>.06)buttons|=BTN.LEFT;else if(courseError<-.06)buttons|=BTN.RIGHT;}
    else if(bankError>.045)buttons|=BTN.LEFT;else if(bankError<-.045)buttons|=BTN.RIGHT;
    const targetPitch=clamp((this.flightGround+75-s.py)/170,-.22,.38);
    if(s.vehiclePitch<targetPitch-.028)buttons|=BTN.BACK;
    else if(s.vehiclePitch>targetPitch+.028)buttons|=BTN.FORWARD;
    const enemy=this.acquireEnemy(game);
    if(enemy) {
      const dx=enemy.state.px-s.px,dy=enemy.state.py-s.py,dz=enemy.state.pz-s.pz,dist=Math.hypot(dx,dy,dz),f=viewDir(s.heading,s.vehiclePitch);
      if(dist>15&&dist<390&&(dx*f.x+dy*f.y+dz*f.z)/dist>.988)buttons|=BTN.FIRE;
      if(Math.hypot(dx,dz)<55&&-dy>32&&Math.abs(s.vehicleRoll)<.35)buttons|=BTN.ALTFIRE;
    }
    return {buttons,yaw:s.heading,pitch:s.vehiclePitch};
  }

  /** Short visible resource goals; no per-frame raycasts or global path search. */
  private seekPickup(game:Game,tick:number):ServerPickup|null {
    if(!game.pickups)return null;
    const p=this.player,s=p.state;
    const useful=(pk:ServerPickup):boolean=>{
      if(pk.availableAtTick>tick || pk.expiresAtTick<=tick)return false;
      if(pk.kind===PICKUP_HEALTH)return p.health<85;
      const def=WEAPONS[pk.weapon],ammo=p.ammo?.[pk.weapon];
      if(!def || !ammo)return false;
      return pk.kind===PICKUP_WEAPON ? !!def.spawnEmpty&&ammo.magazine<def.magazineSize :
        pk.kind===PICKUP_AMMO&&!def.infiniteReserve&&ammo.magazine+ammo.reserve<def.magazineSize+def.reserveSize;
    };
    const current=game.pickups.get(this.pickupId);
    if(current && tick<this.pickupUntil && useful(current))return current;
    if(this.pickupId>=0 && this.pickupWeapon>=0 && p.ammo?.[this.pickupWeapon]?.magazine>0){this.weapon=this.pickupWeapon;this.weaponPickAt=0;}
    this.pickupId=-1;
    if(tick<this.pickupScanAt)return null;
    this.pickupScanAt=tick+45+(p.id%7)*3;
    const candidates:{pickup:ServerPickup;score:number}[]=[];
    for(const pk of game.pickups.values()) {
      if(pk.id===this.failedPickupId&&tick<this.failedPickupUntil || !useful(pk))continue;
      const distance=Math.hypot(pk.x-s.px,pk.z-s.pz);
      if(distance>95 || Math.abs(pk.y-s.py)>9)continue;
      const priority=pk.kind===PICKUP_WEAPON?4:pk.kind===PICKUP_HEALTH?1+(100-p.health)/20:1;
      candidates.push({pickup:pk,score:priority/(distance+12)});
    }
    candidates.sort((a,b)=>b.score-a.score||a.pickup.id-b.pickup.id);
    for(const {pickup:pk}of candidates.slice(0,2)) {
      const dx=pk.x-s.px,dy=pk.y+.5-s.py-PLAYER.EYE_HEIGHT,dz=pk.z-s.pz,len=Math.hypot(dx,dy,dz);
      if(len>2){const hit=game.world.trace(s.px,s.py+PLAYER.EYE_HEIGHT,s.pz,dx/len,dy/len,dz/len,len);if(hit.hit&&hit.dist<len-.7)continue;}
      this.pickupId=pk.id;this.pickupWeapon=pk.weapon;this.pickupUntil=tick+Math.ceil((len/PLAYER.RUN_SPEED+3)/TICK_DT);
      return pk;
    }
    return null;
  }

  /** On-foot: deliberately seek a useful free driver seat, then press E. */
  private maybeEnterVehicle(game: Game, tick: number, maxDistance = 115): number {
    // A third of the bots stay infantry, so the population
    // cannot vacuum up every parked hull before a player finds one.
    if (this.player.id % 3 === 0) return 0;
    if (tick - this.lastUseTick < 120) return 0;
    const p = this.player;
    // Test harnesses stub Game without a vehicle roster.
    if (!game.vehicles) return 0;
    const current=game.vehicles.get(this.vehicleGoal);
    if(current && current.occupant<0 && current.respawnAtTick<0 &&
      Math.hypot(current.x-p.state.px,current.z-p.state.pz)<=Math.max(20,maxDistance)) {
      const def=vehicleDefinition(current.type,current.variant)!;
      this.targetX=current.x;this.targetZ=current.z;this.repathAtTick=tick+180;
      if(Math.hypot(current.x-p.state.px,current.z-p.state.pz)<def.enterRange-.3 && Math.abs(current.y-p.state.py)<def.radius+3 && this.driverInteractionClear(game,current.id)) {
        this.lastUseTick=tick;this.vehicleGoal=-1;return BTN.USE;
      }
      if(tick<this.enterScanAt)return 0;
    }
    this.vehicleGoal=-1;
    if(tick<this.enterScanAt)return 0;
    this.enterScanAt = tick + 60+(p.id%5)*4;
    let nearest:typeof current,best=Infinity;
    for (const v of game.vehicles.values()) {
      if (v.occupant >= 0 || v.respawnAtTick >= 0) continue;
      if(v.id===this.failedVehicleId&&tick<this.failedVehicleUntil)continue;
      if(v.type===VEHICLE.JET && (p.id%4!==0 || v.variant))continue;
      const def = vehicleDefinition(v.type,v.variant)!;
      if (v.health < def.maxHealth * 0.4) continue;
      const d = Math.hypot(v.x - p.state.px, v.z - p.state.pz);
      if(d>maxDistance || d>=best || Math.abs(v.y-p.state.py)>8)continue;
      nearest=v;best=d;
    }
    if(nearest) {
      const dx=nearest.x-p.state.px,dy=nearest.y+1-p.state.py-PLAYER.EYE_HEIGHT,dz=nearest.z-p.state.pz,len=Math.hypot(dx,dy,dz);
      const hit=game.world.trace(p.state.px,p.state.py+PLAYER.EYE_HEIGHT,p.state.pz,dx/Math.max(.001,len),dy/Math.max(.001,len),dz/Math.max(.001,len),len);
      if(!hit.hit||hit.dist>len-1) {
        this.vehicleGoal=nearest.id;this.targetX=nearest.x;this.targetZ=nearest.z;this.repathAtTick=tick+180;
        if(best<vehicleDefinition(nearest.type,nearest.variant)!.enterRange-.3 && this.driverInteractionClear(game,nearest.id)){this.lastUseTick=tick;this.vehicleGoal=-1;return BTN.USE;}
      }
    }
    return 0;
  }

  /** The USE command has no target ID. Approach closer before pressing it if
   * another hull would win the server's nearest-seat selection. */
  private driverInteractionClear(game: Game, targetId: number): boolean {
    const s = this.player.state;
    let nearestId = -1, nearestDistance = Infinity;
    for (const hull of game.vehicles.values()) {
      if (hull.respawnAtTick >= 0 || (hull.occupant >= 0 && ((hull.gunner ?? -1) >= 0 || hull.transportRoute))) continue;
      const def = vehicleDefinition(hull.type, hull.variant)!;
      const distance = (hull.x - s.px) ** 2 + (hull.y + def.radius - s.py - 1) ** 2 + (hull.z - s.pz) ** 2;
      if (distance <= def.enterRange ** 2 && distance < nearestDistance) { nearestDistance = distance; nearestId = hull.id; }
    }
    return nearestId === targetId;
  }

  private grenadeMaxRange(enemy: ServerPlayer): number {
    const targetSpeed = Math.hypot(enemy.state.vx, enemy.state.vz);
    // Constant-velocity prediction becomes increasingly speculative over a
    // multi-second flight. Still targets expose the full 370 m capability;
    // fast dodgers bring the practical cap back toward the 330 m sweet spot.
    return clamp(
      GRENADE_MAX_RANGE - Math.max(0, targetSpeed - 2) * 3.3,
      GRENADE_PREFERRED_MAX,
      GRENADE_MAX_RANGE,
    );
  }

  private chooseCombatWeapon(
    player: ServerPlayer,
    dist: number,
    grenadeMaxRange: number,
  ): number {
    // Found weapons participate only after a real pickup put ammunition in
    // their slot. Explosive discoveries retain room to avoid self-blasts.
    const found=this.foundWeaponOrder(dist).find(w=>(player.ammo?.[w]?.magazine??0)>0&&weaponCoversDistance(w,dist));
    if(found!==undefined)return found;
    const roll = this.rng();
    let order: number[];

    if (dist < 16) {
      order = roll < 0.6
        ? [
            SCATTERGUN_WEAPON,
            PULSE_RIFLE_WEAPON,
            SIDEARM_WEAPON,
            ROCKET_WEAPON,
            GRENADE_WEAPON,
          ]
        : [
            PULSE_RIFLE_WEAPON,
            SCATTERGUN_WEAPON,
            SIDEARM_WEAPON,
            ROCKET_WEAPON,
            GRENADE_WEAPON,
          ];
    } else if (dist < GRENADE_MIN_RANGE) {
      order = roll < 0.55
        ? [
            PULSE_RIFLE_WEAPON,
            ROCKET_WEAPON,
            SIDEARM_WEAPON,
            SCATTERGUN_WEAPON,
            GRENADE_WEAPON,
          ]
        : [
            ROCKET_WEAPON,
            PULSE_RIFLE_WEAPON,
            SIDEARM_WEAPON,
            SCATTERGUN_WEAPON,
            GRENADE_WEAPON,
          ];
    } else if (dist <= grenadeMaxRange) {
      const grenadeChance =
        dist < GRENADE_PREFERRED_MIN ? 0.28 :
        dist <= GRENADE_PREFERRED_MAX ? 0.62 :
        0.32;
      if (roll < grenadeChance) {
        order = [
          GRENADE_WEAPON,
          PULSE_RIFLE_WEAPON,
          ROCKET_WEAPON,
          SIDEARM_WEAPON,
          SCATTERGUN_WEAPON,
        ];
      } else if (dist < GRENADE_PREFERRED_MIN && roll < 0.82) {
        order = [
          ROCKET_WEAPON,
          PULSE_RIFLE_WEAPON,
          SIDEARM_WEAPON,
          GRENADE_WEAPON,
          SCATTERGUN_WEAPON,
        ];
      } else {
        order = [
          PULSE_RIFLE_WEAPON,
          GRENADE_WEAPON,
          ROCKET_WEAPON,
          SIDEARM_WEAPON,
          SCATTERGUN_WEAPON,
        ];
      }
    } else {
      order = [
        PULSE_RIFLE_WEAPON,
        ROCKET_WEAPON,
        SIDEARM_WEAPON,
        SCATTERGUN_WEAPON,
        GRENADE_WEAPON,
      ];
    }

    for (const weapon of order) {
      if (!weaponCoversDistance(weapon, dist, grenadeMaxRange)) continue;
      if (weaponHasAmmo(player, weapon)) return weapon;
    }
    return player.weapon;
  }

  private fallbackOrder(dist: number): number[] {
    // Artillery is never a blind fallback. It is selected by
    // chooseCombatWeapon(), then accepted only after planGrenadeAim() validates
    // both its range and complete terrain clearance. This prevents a loaded
    // grenade from cancelling a useful reload in close quarters or behind
    // cover.
    if (dist < 16) {
      return [...this.foundWeaponOrder(dist).filter(w=>(this.player.ammo?.[w]?.magazine??0)>0),
        SCATTERGUN_WEAPON,
        PULSE_RIFLE_WEAPON,
        SIDEARM_WEAPON,
        ROCKET_WEAPON,
      ];
    }
    if (dist < GRENADE_PREFERRED_MIN) {
      return [...this.foundWeaponOrder(dist).filter(w=>(this.player.ammo?.[w]?.magazine??0)>0),
        PULSE_RIFLE_WEAPON,
        ROCKET_WEAPON,
        SIDEARM_WEAPON,
        SCATTERGUN_WEAPON,
      ];
    }
    return [...this.foundWeaponOrder(dist).filter(w=>(this.player.ammo?.[w]?.magazine??0)>0),
      PULSE_RIFLE_WEAPON,
      ROCKET_WEAPON,
      SIDEARM_WEAPON,
      SCATTERGUN_WEAPON,
    ];
  }

  private foundWeaponOrder(dist:number):number[] {
    if(dist<22)return [8,7];
    if(dist<70)return [9,8,7];
    if(dist<180)return [7,9];
    return [5,6,7];
  }

  private loadedFallback(
    player: ServerPlayer,
    dist: number,
    exclude: number,
  ): number {
    for (const weapon of this.fallbackOrder(dist)) {
      if (
        weapon !== exclude &&
        weaponCoversDistance(weapon, dist) &&
        weaponLoaded(player, weapon)
      ) {
        return weapon;
      }
    }
    return -1;
  }

  private reloadableFallback(
    player: ServerPlayer,
    dist: number,
    preferred: number,
  ): number {
    if (
      weaponCoversDistance(preferred, dist) &&
      weaponCanReload(player, preferred)
    ) {
      return preferred;
    }
    for (const weapon of this.fallbackOrder(dist)) {
      if (
        weapon !== preferred &&
        weaponCoversDistance(weapon, dist) &&
        weaponCanReload(player, weapon)
      ) {
        return weapon;
      }
    }
    return -1;
  }

  private planGrenadeAim(game: Game, enemy: ServerPlayer): GrenadeAim | null {
    const def = WEAPONS[GRENADE_WEAPON];
    const speed = def.speed ?? 78;
    const gravity = def.gravity ?? 16;
    const projectileRadius = def.projRadius ?? 0.24;
    // Flight time is a policy bound, independent from path distance: gravity
    // slows ascent, so range / launchSpeed rejects valid steep trajectories.
    // Each candidate is checked against the actual authoritative chord budget
    // below before the more expensive terrain trace.
    const maxFlightTime = GRENADE_MAX_FLIGHT_TIME;
    const s = this.player.state;

    const origin = {
      x: s.px,
      y: s.py + PLAYER.EYE_HEIGHT,
      z: s.pz,
    };
    // Keep inaccuracy in target space and inside the expanded player capsule.
    // Angular jitter after solving could turn a clear arc into a cave-wall hit.
    const target = {
      x: enemy.state.px + (this.rng() - 0.5) * 1.6,
      y: enemy.state.py + 1.0 + (this.rng() - 0.5) * 0.5,
      z: enemy.state.pz + (this.rng() - 0.5) * 1.6,
    };
    const horizontalSpeed = Math.hypot(enemy.state.vx, enemy.state.vz);
    const velocityScale = horizontalSpeed > 16 ? 16 / horizontalSpeed : 1;
    const targetVelocity = {
      x: enemy.state.vx * velocityScale,
      y: enemy.state.grounded ? 0 : clamp(enemy.state.vy, -8, 8),
      z: enemy.state.vz * velocityScale,
    };

    const solutions = solveBallisticIntercept({
      origin,
      target,
      targetVelocity,
      speed,
      gravity,
      muzzleOffset: 0.5,
      maxTime: maxFlightTime,
    });

    // Earlier root is the low arc. If cover blocks it, the unrestricted high
    // arc gets a chance, while cave ceilings naturally reject that fallback.
    for (const solution of solutions) {
      if (solution.pitch < -1.4 || solution.pitch > 1.4) continue;
      const yaw = unquantYaw(quantYaw(solution.yaw));
      const pitch = unquantPitch(quantPitch(solution.pitch));
      const direction = viewDir(yaw, pitch);
      if (
        ballisticPathDistance(direction, speed, gravity, solution.time) >
        def.range + 1e-6
      ) {
        continue;
      }
      if (!ballisticArcClear(game.world, {
        origin,
        direction,
        speed,
        gravity,
        muzzleOffset: 0.5,
        flightTime: solution.time,
        projectileRadius,
      })) {
        continue;
      }
      return { yaw, pitch };
    }
    return null;
  }

  private acquireEnemy(game: Game): ServerPlayer | null {
    const p = this.player;
    const s = p.state;

    // Re-check line of sight only a few times a second; traces aren't free.
    if (game.tick >= this.losCheckAt) {
      // Give each actor a different scan phase. A whole roster must not fire
      // all its expensive terrain traces on the same simulation tick.
      this.losCheckAt = game.tick + (this.losStarted ? 9 : 1 + p.id % 9);
      this.losStarted = true;
      const candidates: { player: ServerPlayer; d2: number }[] = [];
      for (const q of game.players.values()) {
        if (!game.areEnemies(p, q) || !q.state.alive) continue;
        if(p.vehicleId>=0&&q.vehicleId===p.vehicleId)continue;
        const dx = q.state.px - s.px, dy = q.state.py - s.py, dz = q.state.pz - s.pz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < BOT_ACQUIRE_RANGE * BOT_ACQUIRE_RANGE) candidates.push({ player: q, d2 });
      }
      candidates.sort((a, b) => a.d2 - b.d2 || a.player.id - b.player.id);

      const retained = candidates.find(c => c.player.id === this.enemyId);
      this.losOk = false;
      this.enemyId = -1;
      // Keep a visible opponent; rotate through occluded candidates with at
      // most two probes per scan so a crowded city cannot monopolize a tick.
      // No candidate is permanently hidden behind a fixed nearest-N limit.
      const checks: typeof candidates = [];
      if (retained) checks.push(retained);
      for (let visited = 0; visited < candidates.length && checks.length < 2; visited++) {
        const candidate = candidates[this.losCursor++ % candidates.length];
        if (candidate !== retained) checks.push(candidate);
      }
      this.losCursor %= Math.max(1, candidates.length);
      for (const candidate of checks) {
        const q = candidate.player;
        const ox = s.px, oy = s.py + PLAYER.EYE_HEIGHT, oz = s.pz;
        const tx = q.state.px, ty = q.state.py + 1.2, tz = q.state.pz;
        const dx = tx - ox, dy = ty - oy, dz = tz - oz;
        const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (dl < 1e-6) {
          this.losOk = true;
          this.enemyId = q.id;
          break;
        }
        const th = game.world.trace(ox, oy, oz, dx / dl, dy / dl, dz / dl, dl);
        if (!th.hit || th.dist > dl - 0.8) {
          this.losOk = true;
          this.enemyId = q.id;
          break;
        }
      }
      // Searching through occluded streets can run at 3.3 Hz; an acquired
      // opponent keeps the faster 6.7 Hz visibility check and 60 Hz aiming.
      if (!this.losOk) this.losCheckAt += 9;
    }
    if (!this.losOk || this.enemyId < 0) return null;
    const enemy = game.players.get(this.enemyId);
    if (!enemy || !enemy.state.alive || !game.areEnemies(p, enemy)) return null;
    return enemy;
  }
}
