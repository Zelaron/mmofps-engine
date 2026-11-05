import { PLAYER, TICK_RATE } from './constants.js';
import { carryCityLift, landOnCityLift } from './lifts.js';
import { carryTransit, placeTrainArtillery, settleTransitLanding, collideTransitCapsule } from './transit-motion.js';
import { collideCapsule, type KinState } from './physics.js';
import { stepVehicle, VEHICLE, vehicleEyeOffset } from './vehicles.js';
import { stepBoat } from './boats.js';
import { SWIMMING } from './liquids.js';
import { clamp } from './math.js';
import type { World } from './worldgen.js';
import type { Rotation } from './rotation.js';
import { airliftPose, type AirliftFlight } from './airlift.js';

// The player controller. This exact code runs on the server (authoritative)
// and on the client (prediction + reconciliation replay). It must stay a pure
// function of (world, state, input, dt) - no clocks, no randomness.

export const BTN = {
  FORWARD: 1,
  BACK: 2,
  LEFT: 4,
  RIGHT: 8,
  JUMP: 16,
  FIRE: 32,
  DODGE: 64,
  RELOAD: 128,
  /** Enter/exit the nearest vehicle (edge-triggered server-side). */
  USE: 256,
  /** Vehicle alternate action: jeep boost, tank cluster shell, jet bombs. */
  ALTFIRE: 512,
  /**
   * Playtest cheat (H): ~10x run speed on foot. Honoured only while
   * HYPERSPEED_ENABLED (or a Game created with `hyperspeed`); bots never send it.
   */
  HYPER: 1024,
  /** Jet engine / airbrake: Space and C (also touch controls). */
  THROTTLE: 2048,
  BRAKE: 4096,
} as const;

/** Playtest hyperspeed (H: ~10x speed on foot, invulnerable, no captures or
 * XP) is disabled for players: the client ignores H and the server strips
 * BTN.HYPER from every input. Set true to bring it back. */
export const HYPERSPEED_ENABLED = false;

export interface InputCmd {
  seq: number;
  buttons: number;
  weapon: number;
  /** Radians. MUST already be round-tripped through quantYaw/unquantYaw. */
  yaw: number;
  /** Radians. MUST already be round-tripped through quantPitch/unquantPitch. */
  pitch: number;
  /** The remote-entity tick the client was rendering (for lag compensation). */
  renderTick: number;
  renderFrac: number;
}

export interface MoveState extends KinState {
  /** Explicit jump/dodge ascent, distinct from upward velocity on stairs. */
  jumpAscent?: boolean;
  airlift?: AirliftFlight;
  /** Derived from snapshot.tick; synchronizes moving city platforms without
   * duplicating their transforms in every snapshot. */
  simulationTick?: number;
  jumpHeld: boolean;
  dodgeCd: number;
  alive: boolean;
  /** VEHICLE.NONE on foot; otherwise the possessed vehicle type. */
  vehicle: number;
  vehicleVariant: number;
  /** 0 pilots the hull; 1 operates an independent passenger weapon. */
  seat?: number;
  vehicleId?: number;
  transportRoute?: number;
  /** Vehicle hull yaw, independent from mouse view/aim. */
  heading: number;
  /** Jeep boost fuel, 0..1. */
  boostFuel: number;
  vehiclePitch: number;
  vehicleRoll: number;
  /** Authoritative aircraft orientation; absent for legacy/on-foot states. */
  vehicleRotation?: Rotation;
  /** Actual propulsion boost this simulation tick. */
  boosting: boolean;
  airSeconds?: number;
  swimming?: boolean;
  submerged?: boolean;
}

export interface StepResult {
  /** Landing speed (m/s) - caller converts to fall damage. */
  impact: number;
  /** Closing speed against a moving train; authoritative runover damage. */
  transitImpact: number;
  jumped: boolean;
  dodged: boolean;
}

export function createMoveState(x: number, y: number, z: number): MoveState {
  return {
    px: x, py: y, pz: z,
    vx: 0, vy: 0, vz: 0,
    grounded: false, jumpHeld: false, dodgeCd: 0, alive: true,
    vehicle: 0, vehicleVariant: 0, heading: 0, boostFuel: 1, vehiclePitch: 0, vehicleRoll: 0, boosting: false,
    // Keep one property order as actors walk, swim, board and return. Undefined
    // retains the existing defaults and omission from serialized state.
    jumpAscent: undefined, airlift: undefined, simulationTick: undefined,
    seat: undefined, vehicleId: undefined, transportRoute: undefined,
    vehicleRotation: undefined, airSeconds: undefined, swimming: undefined, submerged: undefined,
  };
}

export function copyMoveState(from: MoveState, to: MoveState): void {
  to.jumpAscent = from.jumpAscent;
  to.airlift = from.airlift ? { ...from.airlift } : undefined;
  to.simulationTick = from.simulationTick;
  to.px = from.px; to.py = from.py; to.pz = from.pz;
  to.vx = from.vx; to.vy = from.vy; to.vz = from.vz;
  to.grounded = from.grounded;
  to.jumpHeld = from.jumpHeld;
  to.dodgeCd = from.dodgeCd;
  to.alive = from.alive;
  to.vehicle = from.vehicle;
  to.vehicleVariant = from.vehicleVariant ?? 0;
  to.seat = from.seat; to.vehicleId = from.vehicleId;
  to.transportRoute = from.transportRoute;
  to.heading = from.heading;
  to.boostFuel = from.boostFuel;
  to.vehiclePitch = from.vehiclePitch; to.vehicleRoll = from.vehicleRoll;
  to.vehicleRotation = from.vehicleRotation ? { ...from.vehicleRotation } : undefined;
  to.boosting = from.boosting;
  to.airSeconds = from.airSeconds; to.swimming = from.swimming; to.submerged = from.submerged;
}

/** Ground crest assistance stays enabled for ordinary simulation and client
 * prediction. The server may explicitly disable only that arcade impulse for
 * an admitted distant convoy; gravity and collision still use this controller. */
export function stepMove(world: World, s: MoveState, cmd: InputCmd, dt: number, simulationTick?: number, allowGroundCrestLaunch = true): StepResult {
  const out: StepResult = { impact: 0, transitImpact: 0, jumped: false, dodged: false };
  const previousTick = s.simulationTick ?? ((simulationTick ?? 1) - 1);
  s.simulationTick = simulationTick ?? previousTick + dt * TICK_RATE;
  world.motionTime = s.simulationTick / TICK_RATE;
  if (!s.alive) return out; // corpses are frozen; respawn resets the state
  if (s.airlift) {
    s.jumpAscent = false;
    const pose = airliftPose(world.collectTransportPlan(), s.airlift, s.simulationTick);
    if (pose) {
      s.px=pose.x;s.py=pose.y;s.pz=pose.z;s.vx=pose.vx;s.vy=pose.vy;s.vz=pose.vz;
      s.grounded=false;s.swimming=false;s.submerged=false;s.airSeconds=SWIMMING.AIR_SECONDS;
      s.jumpHeld=(cmd.buttons & BTN.JUMP)!==0;
      return out;
    }
    s.airlift=undefined;
  }
  const eye = vehicleEyeOffset(s);
  const headLiquid = world.liquidAt?.(s.px + eye.x, s.py + eye.y, s.pz + eye.z);
  s.submerged = !!headLiquid;
  s.airSeconds = headLiquid ? Math.max(0, (s.airSeconds ?? SWIMMING.AIR_SECONDS) - dt)
    : Math.min(SWIMMING.AIR_SECONDS, (s.airSeconds ?? SWIMMING.AIR_SECONDS) + dt * 5);
  s.swimming = false;

  // Driving replaces on-foot kinematics entirely; the same shared function
  // runs on the server and in client prediction, so possession costs no
  // extra netcode. Crash impacts surface through `impact` for the server's
  // vehicle damage model (occupants never take fall damage in a hull).
  if (s.vehicle !== 0) {
    s.jumpAscent = false;
    if (s.seat === 2 && s.transportRoute) {
      placeTrainArtillery(world, s, s.transportRoute, s.simulationTick / TICK_RATE);
      return out;
    }
    if (s.seat === 1) {
      // Passenger input never changes the hull. Extrapolate its replicated
      // velocity between authoritative driver poses during client replay.
      s.px += s.vx * dt; s.py += s.vy * dt; s.pz += s.vz * dt;
      return out;
    }
    const previousFeet = s.py, before = previousTick / TICK_RATE, now = s.simulationTick / TICK_RATE;
    const approach = { x: s.px, z: s.pz, grounded: s.grounded, velocityY: s.vy };
    carryTransit(world, s, before, now);
    const lift = carryCityLift(world, s, before, now);
    out.impact = s.vehicle === VEHICLE.GUNBOAT ? stepBoat(world, s, cmd, dt) : stepVehicle(world, s, cmd, dt, allowGroundCrestLaunch).impact;
    out.impact = Math.max(out.impact, landOnCityLift(world, s, previousFeet, before, now, lift, false, approach));
    s.jumpHeld = (cmd.buttons & BTN.JUMP) !== 0;
    s.dodgeCd = Math.max(0, s.dodgeCd - dt);
    return out;
  }

  const previousCollisions = world.pedestrianCollisions;
  world.pedestrianCollisions = world.vehicleCollisions?.select(s, dt, s.simulationTick);
  try {
    world.pedestrianCollisions?.carry(s);
    return stepPedestrian(world, s, cmd, dt, previousTick, out);
  } finally { world.pedestrianCollisions = previousCollisions; }
}

function stepPedestrian(world: World, s: MoveState, cmd: InputCmd, dt: number,
  previousTick: number, out: StepResult): StepResult {
  const fluid = world.liquidAt?.(s.px, s.py + .72, s.pz);
  if (fluid && fluid.surfaceY - fluid.bottomY > .8) {
    s.jumpAscent = false;
    s.swimming = true; s.grounded = false; s.boosting = false;
    const b = cmd.buttons, forward = Number((b & BTN.FORWARD) !== 0) - Number((b & BTN.BACK) !== 0);
    const right = Number((b & BTN.RIGHT) !== 0) - Number((b & BTN.LEFT) !== 0);
    const speed = SWIMMING.SPEED * ((b & BTN.HYPER) ? 5 : 1);
    const sy = Math.sin(cmd.yaw), cy = Math.cos(cmd.yaw), cp = Math.cos(cmd.pitch);
    let wx = -sy * forward * cp + cy * right, wz = -cy * forward * cp - sy * right;
    const length = Math.max(1, Math.hypot(wx, wz)); wx /= length; wz /= length;
    const ascent = (b & BTN.JUMP) ? 1 : (b & BTN.BRAKE) ? -1 : Math.sin(cmd.pitch) * forward;
    const buoyancy = clamp((fluid.surfaceY - 1.05 - s.py) * 2, -2, 2);
    const targetY = ascent ? ascent * speed : buoyancy;
    const blend = Math.min(1, dt * SWIMMING.ACCEL);
    s.vx += (wx * speed + fluid.flowX - s.vx) * blend;
    s.vz += (wz * speed + fluid.flowZ - s.vz) * blend;
    s.vy += (targetY - s.vy) * blend;
    collideCapsule(world, s, dt, false);
    s.jumpHeld = (b & BTN.JUMP) !== 0; s.dodgeCd = Math.max(0, s.dodgeCd - dt);
    return out;
  }

  const beforeLiftTime = previousTick / TICK_RATE, liftTime = s.simulationTick! / TICK_RATE;
  const previousFeet = s.py;
  const previousHorizontalSpeed = Math.hypot(s.vx, s.vz);
  const liftApproach = { x: s.px, z: s.pz, grounded: s.grounded, velocityY: s.vy };
  const lift = carryCityLift(world, s, beforeLiftTime, liftTime);
  const transit = carryTransit(world, s, beforeLiftTime, liftTime);
  const b = cmd.buttons;
  const f = ((b & BTN.FORWARD) ? 1 : 0) - ((b & BTN.BACK) ? 1 : 0);
  const r = ((b & BTN.RIGHT) ? 1 : 0) - ((b & BTN.LEFT) ? 1 : 0);

  // Ground-plane movement basis from yaw (pitch never affects movement).
  const sy = Math.sin(cmd.yaw), cy = Math.cos(cmd.yaw);
  let wx = -sy * f + cy * r;
  let wz = -cy * f - sy * r;
  const wl = Math.sqrt(wx * wx + wz * wz);
  const hasWish = wl > 1e-6;
  if (hasWish) { wx /= wl; wz /= wl; }

  const hyper = (b & BTN.HYPER) !== 0;
  const runSpeed = hyper ? PLAYER.RUN_SPEED * 10 : PLAYER.RUN_SPEED;
  if (s.grounded) {
    if (hasWish) {
      // Snap-accelerate the horizontal velocity toward wish * RUN_SPEED.
      const tx = wx * runSpeed;
      const tz = wz * runSpeed;
      let dx = tx - s.vx, dz = tz - s.vz;
      const dl = Math.sqrt(dx * dx + dz * dz);
      const maxD = PLAYER.ACCEL * (hyper ? 8 : 1) * dt;
      if (dl > maxD) { dx = (dx / dl) * maxD; dz = (dz / dl) * maxD; }
      s.vx += dx; s.vz += dz;
    } else {
      const factor = Math.max(0, 1 - PLAYER.FRICTION * dt);
      s.vx *= factor; s.vz *= factor;
    }

    if ((b & BTN.JUMP) && !s.jumpHeld) {
      s.vy = PLAYER.JUMP_SPEED;
      out.jumped = true;
    }
    if ((b & BTN.DODGE) && s.dodgeCd <= 0 && hasWish) {
      s.vx = wx * PLAYER.DODGE_SPEED;
      s.vz = wz * PLAYER.DODGE_SPEED;
      s.vy = Math.max(s.vy, PLAYER.DODGE_UP);
      s.dodgeCd = PLAYER.DODGE_COOLDOWN;
      out.dodged = true;
      out.jumped = true; // suppress ground snap this tick
    }
  } else if (hasWish) {
    // Air control: can steer up to run speed along the wish direction, but
    // input alone never pushes total horizontal speed past what you have.
    const cur = s.vx * wx + s.vz * wz;
    const add = Math.min(PLAYER.AIR_ACCEL * dt, Math.max(0, runSpeed - cur));
    if (add > 0) { s.vx += wx * add; s.vz += wz * add; }
  }

  s.jumpHeld = (b & BTN.JUMP) !== 0;
  s.dodgeCd = Math.max(0, s.dodgeCd - dt);

  if (out.jumped && lift) {
    // Jump integration already includes inherited deck velocity. Undo the
    // pre-move carry so descending lifts cannot move the jumper twice and
    // leave their feet below the platform on the release tick.
    s.py -= lift.to.y - lift.from.y;
    s.vy += lift.from.velocity;
  }
  if (out.jumped && transit) {
    const span = Math.max(.001, transit.now - transit.before);
    s.px -= transit.dx; s.py -= transit.dy; s.pz -= transit.dz;
    s.vx += transit.dx / span; s.vy += transit.dy / span; s.vz += transit.dz / span;
  }

  s.vy -= PLAYER.GRAVITY * dt;

  const sp = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
  const speedCap = hyper ? PLAYER.RUN_SPEED * 10 + 40 : PLAYER.MAX_SPEED;
  const inheritedHorizontal = out.jumped && transit
    ? Math.hypot(s.vx, s.vz) : !s.grounded ? previousHorizontalSpeed : 0;
  if (!hyper && inheritedHorizontal > speedCap) {
    // A train is faster than a running player. Preserve external horizontal
    // momentum in air, without letting air steering increase it further.
    // The snapshot already carries these velocities, so replay needs no
    // hidden attachment state or additional network field.
    const horizontal = Math.hypot(s.vx, s.vz);
    if (horizontal > inheritedHorizontal) { s.vx *= inheritedHorizontal / horizontal; s.vz *= inheritedHorizontal / horizontal; }
    s.vy = clamp(s.vy, -speedCap, speedCap);
  } else if (sp > speedCap) {
    const k = speedCap / sp;
    s.vx *= k; s.vy *= k; s.vz *= k;
  }

  const wasAirborne = !s.grounded || out.jumped;
  s.jumpAscent = (s.jumpAscent || out.jumped) && s.vy > 0.5;
  const fallSpeed = -s.vy;
  liftApproach.velocityY = s.vy;
  const { impact, transitImpact } = collideTransitCapsule(world, s, dt, !out.jumped && !s.jumpAscent, beforeLiftTime, liftTime, transit);
  out.transitImpact = transitImpact;
  if (wasAirborne && s.grounded) settleTransitLanding(world, s, beforeLiftTime, liftTime);
  if (transit && !out.jumped && !s.grounded) {
    // Walking off an edge has the same inertial release as jumping. Carry
    // already moved the feet this tick, so only subsequent motion inherits it.
    const span = Math.max(.001, transit.now - transit.before);
    s.vx += transit.dx / span; s.vy += transit.dy / span; s.vz += transit.dz / span;
  }
  const liftImpact = landOnCityLift(world, s, previousFeet, beforeLiftTime, liftTime, lift, out.jumped, liftApproach);
  out.impact = Math.max(impact, liftImpact);
  // Fall damage keys off VERTICAL speed at the airborne->grounded
  // transition, not the into-surface component - otherwise landing on a
  // slope "absorbs" a lethal fall. (A future water volume hooks in here by
  // zeroing the impact.)
  if (wasAirborne && s.grounded && fallSpeed > out.impact) {
    out.impact = fallSpeed;
  }
  if (s.grounded && s.vy < 0) s.vy = 0;
  const landingWater = world.liquidAt?.(s.px, s.py + .72, s.pz);
  if (landingWater && landingWater.surfaceY - landingWater.bottomY > 1.2) out.impact = 0;
  return out;
}

/** Fall damage from a landing impact speed; 0 if below threshold. */
export function fallDamage(impact: number): number {
  if (impact <= PLAYER.FALL_DMG_MIN) return 0;
  return Math.round((impact - PLAYER.FALL_DMG_MIN) * PLAYER.FALL_DMG_SCALE);
}
