import { clamp, wrapAngle, viewDir } from './math.js';
import { BTN, type InputCmd, type MoveState } from './movement.js';
import { probeGroundBelowPoint, sphereFieldContact } from './physics.js';
import { AUX_WEAPONS, WEAPONS, type WeaponDef } from './weapons.js';
import type { World } from './worldgen.js';
import { PLAYER } from './constants.js';
import { multiplyRotations, normalizeRotation, rotateVector, rotationFromEuler, rotationToEuler,
  vehicleQuaternion, type VehicleOrientation } from './rotation.js';
import { VEHICLE, VEHICLE_VARIANT, validVehicleVariant, NOCTURNE_SCALE } from './vehicle-identity.js';
export { VEHICLE, VEHICLE_VARIANT, validVehicleVariant, NOCTURNE_SCALE } from './vehicle-identity.js';

// Vehicles use a "possession" model: while a player drives, their MoveState
// IS the vehicle (stepMove dispatches here), so the existing client
// prediction/reconciliation replays vehicle motion bit-for-bit like on-foot
// movement. Unoccupied vehicles are static server-tracked entities.
//
// The simulation is deliberately arcade-simple and deterministic: a single
// sphere against the canonical SDF and per-type tuning below. Ground
// vehicles steer like cars - A/D yaw the hull, W/S throttle along it, and
// the mouse is a free look (aiming the tank turret / jeep MG) that never
// steers. Jets pitch/roll with W/S and A/D; mouse movement is free look. No transcendental
// randomness, no wall-clock - a pure function of (world, state, input, dt).

export const JET_GUN_MUZZLE = { x: 0, y: 0.99, z: -3.29 } as const;
export const BASTION_GUN_PIVOT = { x: 0, y: 2.99, z: .26 } as const;
export const BASTION_BARREL_LENGTH = 6.149;
export const GUNBOAT_DRAFT = .65;
export const GUNBOAT_GUN_PIVOT = { x: 0, y: 2.05, z: -2.35 } as const;
export const GUNBOAT_BARREL_LENGTH = 2.4;
export const TRAIN_ARTILLERY_PIVOT = { x: 0, y: 4.5, z: 0 } as const;
export const TRAIN_ARTILLERY_BARREL_LENGTH = 16;
export const TRAIN_ARTILLERY_EYE = {x:0,y:6.4,z:1.4} as const;

/** One physical eye position for rendering, predicted breathing and server
 * hazards. Aircraft eyes rotate with the cabin, including its underside seat. */
export function vehicleEyeOffset(state: VehicleOrientation & {vehicle:number;vehicleVariant?:number;seat?:number},
  out={x:0,y:0,z:0}): {x:number;y:number;z:number} {
  if(state.vehicle===VEHICLE.NONE) {out.x=0;out.y=PLAYER.EYE_HEIGHT;out.z=0;return out;}
  let x=0,y=vehicleEyeHeight(state.vehicle as VehicleType,state.vehicleVariant),z=0;
  if(state.seat===2) {x=TRAIN_ARTILLERY_EYE.x;y=TRAIN_ARTILLERY_EYE.y;z=TRAIN_ARTILLERY_EYE.z;}
  else if(state.seat===1) {
    if(state.vehicle===VEHICLE.JET) {const scale=state.vehicleVariant===VEHICLE_VARIANT.NOCTURNE?NOCTURNE_SCALE:1;y=.10*scale;z=.6*scale;}
    else {const pivot=crewGunPivot(state.vehicle,state.vehicleVariant);x=pivot.x;y=pivot.y+.48;z=pivot.z+.85;}
  }
  if(state.vehicle===VEHICLE.JET)return rotateVector(vehicleQuaternion(state),x,y,z,out);
  const c=Math.cos(state.heading),s=Math.sin(state.heading);out.x=c*x+s*z;out.y=y;out.z=-s*x+c*z;return out;
}
export const JET_BOMB_BAY = { x: 0, y: 0.62, z: 0.20 } as const;
const NOCTURNE_GUN_MUZZLE = { x: 0, y: JET_GUN_MUZZLE.y * NOCTURNE_SCALE, z: JET_GUN_MUZZLE.z * NOCTURNE_SCALE };
const NOCTURNE_BOMB_BAY = { x: 0, y: JET_BOMB_BAY.y * NOCTURNE_SCALE, z: JET_BOMB_BAY.z * NOCTURNE_SCALE };
export function jetGunMuzzle(variant = 0): Readonly<{ x: number; y: number; z: number }> {
  return variant === VEHICLE_VARIANT.NOCTURNE ? NOCTURNE_GUN_MUZZLE : JET_GUN_MUZZLE;
}
export function jetBombBay(variant = 0): Readonly<{ x: number; y: number; z: number }> {
  return variant === VEHICLE_VARIANT.NOCTURNE ? NOCTURNE_BOMB_BAY : JET_BOMB_BAY;
}

/** Rotate an attachment exactly like the renderer's YXZ airframe rotation. */
export function vehicleLocalOffset(
  state: VehicleOrientation,
  x: number, y: number, z: number,
): { x: number; y: number; z: number } {
  return rotateVector(vehicleQuaternion(state), x, y, z);
}
export type VehicleType = (typeof VEHICLE)[keyof typeof VEHICLE];

export interface VehicleDef {
  name: string;
  /** Collision sphere radius; also the occupant camera base height. */
  radius: number;
  maxHealth: number;
  accel: number;
  maxSpeed: number;
  reverseSpeed: number;
  /** Hull steering rate (A/D for ground vehicles, pitch control for jets), rad/s. */
  turnRate: number;
  brakeDrag: number;
  rollDrag: number;
  /** Players may enter within this range of the hull center. */
  enterRange: number;
  /** Seconds after destruction before respawning at another site. */
  respawnSeconds: number;
}

export const VEHICLE_DEFS: Record<Exclude<VehicleType, 0>, VehicleDef> = {
  [VEHICLE.JEEP]: {
    name: 'Jeep',
    radius: 1.35,
    maxHealth: 1200,
    accel: 13,
    maxSpeed: 17,
    reverseSpeed: 7,
    turnRate: 1.9,
    brakeDrag: 4.5,
    rollDrag: 0.7,
    enterRange: 4.5,
    respawnSeconds: 45,
  },
  [VEHICLE.TANK]: {
    name: 'Tank',
    radius: 1.9,
    maxHealth: 4500,
    accel: 9,
    maxSpeed: 13,
    reverseSpeed: 6,
    turnRate: 1.25,
    brakeDrag: 5,
    rollDrag: 1.1,
    enterRange: 5.5,
    respawnSeconds: 60,
  },
  [VEHICLE.JET]: {
    name: 'Jet',
    radius: 1.55,
    maxHealth: 600,
    accel: 40,
    maxSpeed: 132,
    reverseSpeed: 0,
    turnRate: 1.5,
    brakeDrag: 1.8,
    rollDrag: 0.35,
    enterRange: 5.0,
    respawnSeconds: 75,
  },
  [VEHICLE.GUNBOAT]: {
    name: 'Gunboat', radius: 2.2, maxHealth: 1800, accel: 11, maxSpeed: 24,
    reverseSpeed: 8, turnRate: 1.15, brakeDrag: 1.8, rollDrag: .2,
    enterRange: 7.5, respawnSeconds: 65,
  },
};

const NOCTURNE_DEF: VehicleDef = { ...VEHICLE_DEFS[VEHICLE.JET], name: 'Nocturne',
  radius: VEHICLE_DEFS[VEHICLE.JET].radius * NOCTURNE_SCALE, enterRange: 8,
  maxHealth: 1000, accel: 64, maxSpeed: VEHICLE_DEFS[VEHICLE.JET].maxSpeed * 1.75,
  turnRate: 1.2, respawnSeconds: 100 };
const BASTION_DEF: VehicleDef = { ...VEHICLE_DEFS[VEHICLE.TANK], name: 'Bastion Siege Tank',
  radius: 2.95, maxHealth: 11000, accel: 32, maxSpeed: 24, reverseSpeed: 10,
  rollDrag: .55, turnRate: 1.35, enterRange: 6, respawnSeconds: 110 };
export function vehicleDefinition(type: number, variant = 0): VehicleDef | undefined {
  const special = validVehicleVariant(type, variant);
  if (special === VEHICLE_VARIANT.RAIL) return RAIL_DEF;
  return special === VEHICLE_VARIANT.NOCTURNE ? NOCTURNE_DEF
    : special === VEHICLE_VARIANT.BASTION ? BASTION_DEF : VEHICLE_DEFS[type as Exclude<VehicleType, 0>];
}

/** Jeep boost (alternate fire): fuel drains and regenerates per second. */
export const JEEP_BOOST_DRAIN = 0.1667; // ~6s of boost on a full tank
export const JEEP_BOOST_REGEN = 0.055; // ~18s to refill from empty
export const JEEP_BOOST_ACCEL = 60;
export const JEEP_BOOST_MAX_SPEED = 81;

/** Jets stall below this airspeed and must roll to it before climbing. */
export const JET_TAKEOFF_SPEED = 22;
export const JET_STALL_SPEED = 15;
/** Terrain contact above this speed damages the jet (handled server-side). */
export const JET_CRASH_SPEED = 14;

const GRAVITY = 24;
/**
 * Airborne ground vehicles fall a touch softer than true gravity: hill
 * jumps read as ramp launches with hang time instead of the hull being
 * yanked back onto the terrain (jets have their own lift model).
 */
const GRAVITY_AIRBORNE = 16;

/**
 * Resolve the vehicle sphere out of the canonical field, clipping velocity.
 * Returns the surface normal Y of the deepest resolved contact and the
 * impact speed absorbed along that normal. normalY is 0 when nothing was
 * touched - it MUST NOT default to 1, or the callers' "kill downward
 * velocity on ground contact" check fires every airborne tick and hulls
 * float off cliffs instead of falling.
 *
 * Contacts are sign-validated (sphereFieldContact): the field's magnitude
 * is NOT a metric distance, and the naive `sdf(center) < radius` test made
 * hulls hover in mid-air on the small positive minima left where entrance
 * bowls carved the old heightfield surface away.
 */
function collideSphere(
  world: World,
  s: MoveState,
  radius: number,
): { normalY: number; impact: number; wallImpact: number } {
  let normalY = 0;
  let impact = 0;
  let wallImpact = 0;
  for (let iter = 0; iter < 6; iter++) {
    const c = sphereFieldContact(world, s.px, s.py + radius, s.pz, radius);
    if (!c) break;
    s.px += c.mx * c.depth;
    s.py += c.my * c.depth;
    s.pz += c.mz * c.depth;
    const vn = s.vx * c.nx + s.vy * c.ny + s.vz * c.nz;
    if (vn < 0) {
      if (-vn > impact) impact = -vn;
      // Wall-like contacts (steep normals) tracked separately: ground
      // vehicles are suspension-cushioned and shrug off landings, but
      // ramming a cliff face is still a crash.
      if (c.ny <= 0.55 && -vn > wallImpact) wallImpact = -vn;
      s.vx -= c.nx * vn;
      s.vy -= c.ny * vn;
      s.vz -= c.nz * vn;
      normalY = c.ny;
    }
  }
  return { normalY, impact, wallImpact };
}

export interface VehicleStepResult {
  /** Vertical-ish impact speed (m/s); the server converts to crash damage. */
  impact: number;
  boosting: boolean;
}

/**
 * One fixed tick of vehicle kinematics. Shared verbatim by server physics
 * and client prediction. `s.heading` is the hull yaw; ground vehicles yaw
 * it with A/D and throttle along it with W/S. Jet attitude uses only keys.
 */
export function stepVehicle(
  world: World,
  s: MoveState,
  cmd: InputCmd,
  dt: number,
  allowCrestLaunch = true,
): VehicleStepResult {
  const def = vehicleDefinition(s.vehicle, s.vehicleVariant);
  const out: VehicleStepResult = { impact: 0, boosting: false };
  s.boosting = false;
  if (!def) return out;
  const b = cmd.buttons;
  const throttle = ((b & BTN.FORWARD) ? 1 : 0) - ((b & BTN.BACK) ? 1 : 0);

  if (s.vehicle === VEHICLE.JET) {
    stepJet(world, s, cmd, dt, def, out);
    return out;
  }

  // ---- Ground vehicles ----------------------------------------------------
  // The generous grounded window matters: at speed over rolling terrain the
  // sphere ballistically skips between contacts, and gating ALL control on
  // strict contact turned every hill crest into an uncontrollable straight
  // slide until the next collision.
  const cy = s.py + def.radius;
  const grounded = probeGroundBelowPoint(world, s.px, cy, s.pz, def.radius + 1.0);

  // Car steering: A/D yaw the hull directly; the mouse is a free look
  // (and aims the turret/MG) that never steers. Steering authority scales
  // with rolling speed so a parked hull cannot pirouette, and it flips
  // while backing up so reverse steers like a real car.
  const fx0 = -Math.sin(s.heading);
  const fz0 = -Math.cos(s.heading);
  const steer = ((b & BTN.LEFT) ? 1 : 0) - ((b & BTN.RIGHT) ? 1 : 0);
  const speed = Math.hypot(s.vx, s.vz);
  const steerScale = clamp(0.25 + speed / 6, 0, 1) * (grounded ? 1 : 0.5);
  const steerDir = s.vx * fx0 + s.vz * fz0 < -0.5 ? -1 : 1;
  s.heading += def.turnRate * steerScale * steer * steerDir * dt;
  if (s.heading > Math.PI) s.heading -= 2 * Math.PI;
  else if (s.heading < -Math.PI) s.heading += 2 * Math.PI;

  const fx = -Math.sin(s.heading);
  const fz = -Math.cos(s.heading);
  // Airborne hulls keep reduced authority (arcade feel): weaker throttle
  // and much softer grip, so jumps stay floaty but never brick the wheel.
  const authority = grounded ? 1 : 0.35;
  const gripRate = grounded ? 6 : 1.6;

  const boosting =
    s.vehicle === VEHICLE.JEEP && (b & BTN.ALTFIRE) !== 0 &&
    s.boostFuel > 0.02 && grounded && throttle > 0;
  out.boosting = boosting;
  s.boosting = boosting;
  const accel = (boosting ? JEEP_BOOST_ACCEL : def.accel) * authority;
  const maxSpeed = boosting ? JEEP_BOOST_MAX_SPEED : def.maxSpeed;
  if (boosting) {
    s.boostFuel = clamp(s.boostFuel - JEEP_BOOST_DRAIN * dt, 0, 1);
    if (s.boostFuel <= 0.02) s.boostFuel = 0;
  } else if (s.vehicle === VEHICLE.JEEP && grounded && (b & BTN.ALTFIRE) === 0) {
    s.boostFuel = clamp(s.boostFuel + JEEP_BOOST_REGEN * dt, 0, 1);
  }

  const forwardSpeed = s.vx * fx + s.vz * fz;
  if (throttle > 0 && forwardSpeed < maxSpeed) {
    s.vx += fx * accel * dt;
    s.vz += fz * accel * dt;
  } else if (throttle < 0 && forwardSpeed > -def.reverseSpeed) {
    s.vx -= fx * accel * 0.7 * dt;
    s.vz -= fz * accel * 0.7 * dt;
  } else if (throttle === 0 && grounded) {
    const drag = Math.max(0, 1 - def.brakeDrag * dt);
    s.vx *= drag;
    s.vz *= drag;
  }
  // Lateral grip: bleed sideways velocity so the hull tracks its heading
  // instead of drifting like a puck (a little slide survives for feel).
  const rx = fz, rz = -fx;
  const lateral = s.vx * rx + s.vz * rz;
  const grip = Math.max(0, 1 - gripRate * dt);
  s.vx -= rx * lateral * (1 - grip);
  s.vz -= rz * lateral * (1 - grip);
  if (grounded) {
    const rd = Math.max(0, 1 - def.rollDrag * dt);
    s.vx *= rd;
    s.vz *= rd;
  }

  s.vy -= (grounded ? GRAVITY : GRAVITY_AIRBORNE) * dt;
  s.px += s.vx * dt;
  s.py += s.vy * dt;
  s.pz += s.vz * dt;
  const contact = collideSphere(world, s, def.radius);
  // Wheels and tracks cushion any landing - ground vehicles report only
  // wall-like impacts as crashes, so ramp jumps are damage-free however
  // hard the hull comes down. (Jets still belly-flop; see stepJet.)
  out.impact = contact.wallImpact;
  if (contact.normalY > 0.4 && s.vy < 0) s.vy = 0;

  // Ramp launch. At hull speeds a rounded crest keeps the sphere glued to
  // the dome: contour-following contact clips bleed away the climb
  // inertia the hull earned on the way up, so unlike a fast runner it
  // never separated (vy ~ 0 at the top, then straight down - "glued to
  // the ground"). While riding uphill at speed, watch for the lip: the
  // moment the grade ahead falls clearly below the grade behind, convert
  // the climb grade into upward inertia, exactly as if the hill face were
  // a ramp. Stateless (terrain + state only), so client prediction and
  // the server agree bit-for-bit.
  const hspeed = Math.hypot(s.vx, s.vz);
  if (allowCrestLaunch && grounded && hspeed > 6) {
    const ux = s.vx / hspeed, uz = s.vz / hspeed;
    const gHere = world.groundY(s.px, s.pz);
    // Only when actually riding the heightfield (not a cave floor under
    // an unrelated surface far above).
    if (Math.abs(s.py - gHere) < 3) {
      const gBack = world.groundY(s.px - ux * 4.5, s.pz - uz * 4.5);
      const slopeBehind = (gHere - gBack) / 4.5;
      if (slopeBehind > 0.08 && slopeBehind < 1.4) {
        const gAhead = world.groundY(s.px + ux * 4, s.pz + uz * 4);
        const slopeAhead = (gAhead - gHere) / 4;
        if (slopeAhead < slopeBehind - 0.15) {
          s.vy = Math.max(s.vy, Math.min(hspeed * slopeBehind, 18));
        }
      }
    }
  }

  s.grounded = grounded;
  return out;
}

function stepJet(
  world: World,
  s: MoveState,
  cmd: InputCmd,
  dt: number,
  def: VehicleDef,
  out: VehicleStepResult,
): void {
  const speed = Math.hypot(s.vx, s.vy, s.vz);
  const airborne = !probeGroundBelowPoint(
    world, s.px, s.py + def.radius, s.pz, def.radius + 1.2,
  );

  const b = cmd.buttons;
  const throttle = (b & BTN.BRAKE) ? -1 : (b & BTN.THROTTLE) ? 1 : 0;
  const pitchInput = Number((b & BTN.BACK) !== 0) - Number((b & BTN.FORWARD) !== 0);
  const rollInput = Number((b & BTN.LEFT) !== 0) - Number((b & BTN.RIGHT) !== 0);
  const liftReadiness = clamp(
    (speed - JET_STALL_SPEED) / (JET_TAKEOFF_SPEED - JET_STALL_SPEED), 0, 1,
  );
  const authority = airborne ? Math.max(0.45, liftReadiness) : liftReadiness;
  // Bank is persistent: a pilot rolls into a turn, then rolls out to level.
  // The pitch control acts in the aircraft's local plane, so banking also
  // turns its nose. Mouse aim never changes the flight state.
  if (airborne) {
    const orientation = s.vehicleRotation ??= vehicleQuaternion(s);
    const local = rotationFromEuler(0, pitchInput * def.turnRate * authority * dt, rollInput * 1.9 * dt);
    multiplyRotations(orientation, local, orientation);
    // Lift in a bank still makes a gentle coordinated turn. The world-space
    // right wing's height replaces Euler roll, including while inverted.
    const bank = 2 * (orientation.x * orientation.y + orientation.w * orientation.z);
    const turn = rotationFromEuler(bank * authority * 0.72 * dt);
    normalizeRotation(multiplyRotations(turn, orientation, orientation));
    Object.assign(s, rotationToEuler(orientation));
  } else {
    // A/D also steer the nosewheel while rolling; ground roll stays level.
    s.heading = wrapAngle(s.heading + rollInput * def.turnRate * clamp(speed / 12, 0, 1) * dt);
    s.vehicleRoll *= Math.max(0, 1 - 5 * dt);
    s.vehiclePitch = liftReadiness > 0
      ? clamp(s.vehiclePitch + pitchInput * def.turnRate * authority * dt, -0.08, 0.55)
      : s.vehiclePitch * Math.max(0, 1 - 5 * dt);
    s.vehicleRotation = rotationFromEuler(s.heading, s.vehiclePitch, s.vehicleRoll, s.vehicleRotation);
  }
  const pitch = s.vehiclePitch;

  const forward = rotateVector(vehicleQuaternion(s), 0, 0, -1);
  const dirX = forward.x, dirY = forward.y, dirZ = forward.z;

  let targetSpeed = 0;
  if (throttle > 0) targetSpeed = def.maxSpeed;
  else if (throttle === 0) targetSpeed = airborne ? def.maxSpeed * 0.62 : 0;
  // C is the airbrake / taxi brake; releasing Space holds a cruise setting.

  const accel = throttle > 0 ? def.accel : def.brakeDrag * 6;
  const newSpeed = speed < targetSpeed
    ? Math.min(targetSpeed, speed + accel * dt)
    : Math.max(targetSpeed, speed - def.brakeDrag * 6 * dt);

  // Velocity eases onto the aim direction; below stall the nose drops and
  // gravity takes over, so a dead-stick jet descends instead of hovering -
  // but an airborne pilot always retains enough alignment to steer the
  // glide (matching the pitch authority above).
  const align = clamp(
    (airborne ? Math.max(0.4, liftReadiness) : liftReadiness) * 5 * dt, 0, 1,
  );
  // Change speed directly; ease only the direction. Applying the same
  // interpolation to acceleration/braking multiplied their strength by dt
  // twice, making an airborne brake almost inaudible and ineffective.
  const inverseSpeed = speed > 0.001 ? 1 / speed : 0;
  const ux = s.vx * inverseSpeed + (dirX - s.vx * inverseSpeed) * align;
  const uy = s.vy * inverseSpeed + (dirY - s.vy * inverseSpeed) * align;
  const uz = s.vz * inverseSpeed + (dirZ - s.vz * inverseSpeed) * align;
  const directionLength = Math.max(0.00001, Math.hypot(ux, uy, uz));
  let vx = ux / directionLength * newSpeed;
  let vy = uy / directionLength * newSpeed;
  let vz = uz / directionLength * newSpeed;
  const gravityScale = 1 - liftReadiness * (throttle > 0 ? 1 : 0.9);
  vy -= GRAVITY * gravityScale * dt;
  if (!airborne) {
    // Taxiing: roll along the FULL horizontal heading. Projecting the roll
    // through the pitch cosine bled enough thrust to cap ground speed just
    // below takeoff, so a jet could never leave the strip.
    const taxiSpeed = clamp(newSpeed, 0, def.maxSpeed);
    vx = -Math.sin(s.heading) * taxiSpeed;
    vz = -Math.cos(s.heading) * taxiSpeed;
    if (vy > 0 && (liftReadiness < 1 || pitch <= 0.02)) vy = 0;
  }
  s.vx = vx; s.vy = vy; s.vz = vz;

  s.px += s.vx * dt;
  s.py += s.vy * dt;
  s.pz += s.vz * dt;
  const contact = collideSphere(world, s, def.radius);
  out.impact = contact.impact;
  if (contact.normalY > 0.4 && s.vy < 0) s.vy = 0;
  s.grounded = !airborne;
}

/** Siege turret attachment in world-relative coordinates; mouse aims the barrel. */
export function bastionGunMuzzle(heading: number, yaw: number, pitch: number): { x: number; y: number; z: number } {
  const dir = viewDir(yaw, pitch), pivot = BASTION_GUN_PIVOT;
  return { x: Math.sin(heading) * pivot.z + dir.x * BASTION_BARREL_LENGTH,
    y: pivot.y + dir.y * BASTION_BARREL_LENGTH,
    z: Math.cos(heading) * pivot.z + dir.z * BASTION_BARREL_LENGTH };
}
const RAIL_DEF: VehicleDef = { ...VEHICLE_DEFS[VEHICLE.TANK], name: 'Leviathan Rail Artillery', radius: 3.2,
  maxHealth: 8000, maxSpeed: 0, accel: 0, enterRange: 8, respawnSeconds: 75 };
export function gunboatGunMuzzle(heading:number,yaw:number,pitch:number):{x:number;y:number;z:number} {
  return mountedGunMuzzle(GUNBOAT_GUN_PIVOT,GUNBOAT_BARREL_LENGTH,heading,yaw,pitch);
}
export function trainArtilleryMuzzle(heading:number,yaw:number,pitch:number):{x:number;y:number;z:number} {
  return mountedGunMuzzle(TRAIN_ARTILLERY_PIVOT,TRAIN_ARTILLERY_BARREL_LENGTH,heading,yaw,artilleryPitch(pitch));
}
function mountedGunMuzzle(pivot:Readonly<{x:number;y:number;z:number}>,length:number,heading:number,yaw:number,pitch:number) {
  const dir=viewDir(yaw,pitch),s=Math.sin(heading),c=Math.cos(heading);
  return {x:pivot.x*c+pivot.z*s+dir.x*length,y:pivot.y+dir.y*length,z:-pivot.x*s+pivot.z*c+dir.z*length};
}

/** World-relative crew attachment, independent of driver aim and camera. */
export function crewGunPivot(type:number,variant=0):Readonly<{x:number;y:number;z:number}> {
  return type===VEHICLE.TANK ? variant===VEHICLE_VARIANT.BASTION
    ? {x:.72,y:3.64,z:.33} : {x:.55,y:2.8,z:.25}
    : type===VEHICLE.GUNBOAT ? {x:0,y:1.8,z:2.4} : {x:.55,y:1.82,z:.32};
}
export const CREW_GUN_LENGTH = 1.3;
export function crewGunMuzzle(type:number,variant:number,heading:number,yaw:number,pitch:number) {
  return mountedGunMuzzle(crewGunPivot(type,variant),CREW_GUN_LENGTH,heading,yaw,pitch);
}
export function aircraftCrewMuzzle(state:VehicleOrientation & {vehicleVariant?:number}) {
  const scale=state.vehicleVariant===VEHICLE_VARIANT.NOCTURNE?NOCTURNE_SCALE:1;
  return vehicleLocalOffset(state,0,.28*scale,.6*scale);
}

/** Camera/eye height for an occupant of the given vehicle type. */
export function vehicleEyeHeight(type: VehicleType, variant = 0): number {
  if (variant === VEHICLE_VARIANT.RAIL) return TRAIN_ARTILLERY_EYE.y;
  if (type === VEHICLE.GUNBOAT) return 3.6;
  if (validVehicleVariant(type, variant) === VEHICLE_VARIANT.NOCTURNE) {
    return (VEHICLE_DEFS[VEHICLE.JET].radius + .9) * NOCTURNE_SCALE;
  }
  const def = vehicleDefinition(type, variant);
  return def ? def.radius + 0.9 : 1.62;
}

// ---- Vehicle weapons -------------------------------------------------------
//
// Vehicle armament lives in its own id namespace (>= 200) so the handheld
// WEAPONS array - whose length drives ammo loadouts and reload state - never
// changes shape. Vehicle weapons are cooldown-gated with infinite ammo.

export const VEHICLE_WEAPON_ID_BASE = 200;

const common = {
  pellets: 1,
  magazineSize: 1,
  reserveSize: 0,
  infiniteReserve: true,
  reloadTime: 1,
} as const;

export const JEEP_MG: WeaponDef = {
  ...common,
  id: 200, name: 'Jeep MG', kind: 'hitscan',
  interval: 0.095, damage: 9, spread: 0.02, range: 300, knockback: 0.5,
};

export const TANK_CANNON: WeaponDef = {
  ...common,
  id: 201, name: 'Tank Cannon', kind: 'projectile', projectile: 'grenade',
  interval: 2.1, damage: 130, spread: 0, range: 900, knockback: 0,
  speed: 60, gravity: 8, splashRadius: 9, splashMax: 110,
  splashImpulse: 26, splashLift: 0.6, projRadius: 0.3,
  bounces: false, terrainBounceTime: 0,
};

/** Splits into CLUSTER_COUNT bomblets when its fuse expires mid-air. */
export const TANK_CLUSTER: WeaponDef = {
  ...common,
  id: 202, name: 'Cluster Shell', kind: 'projectile', projectile: 'grenade',
  interval: 8, damage: 60, spread: 0, range: 900, knockback: 0,
  speed: 67, gravity: 9, fuse: 1.7, splashRadius: 6, splashMax: 60,
  splashImpulse: 18, splashLift: 0.5, projRadius: 0.3,
  bounces: false, terrainBounceTime: 0,
};

export const CLUSTER_BOMBLET: WeaponDef = {
  ...common,
  id: 203, name: 'Bomblet', kind: 'projectile', projectile: 'grenade',
  interval: 1, damage: 45, spread: 0, range: 1200, knockback: 0,
  speed: 20, gravity: 18, fuse: 12, splashRadius: 12.5, splashMax: 48,
  splashImpulse: 20, splashLift: 0.65, projRadius: 0.18,
  bounces: false, terrainBounceTime: 0, impactOnly: true,
};

export const JET_MG: WeaponDef = {
  ...common,
  id: 204, name: 'Jet MG', kind: 'hitscan',
  interval: 0.075, damage: 11, spread: 0.014, range: 460, knockback: 0.4,
};

export const JET_BOMB: WeaponDef = {
  ...common,
  id: 205, name: 'Bomb', kind: 'projectile', projectile: 'grenade',
  interval: 6, damage: 170, spread: 0, range: 1400, knockback: 0,
  speed: 0, gravity: 22, fuse: 12, splashRadius: 22.5, splashMax: 170,
  splashImpulse: 22, splashLift: 0.55, projRadius: 0.26,
  bounces: false, terrainBounceTime: 0,
};

/**
 * Pseudo-weapon credited when a hull runs a pedestrian down. Never fired;
 * exists so the kill feed can say "Run-over" instead of "world".
 */
export const RUN_OVER: WeaponDef = {
  ...common,
  id: 206, name: 'Run-over', kind: 'hitscan',
  interval: 1, damage: 0, spread: 0, range: 0, knockback: 0,
};

export const NOCTURNE_LANCE: WeaponDef = {
  ...common, id: 207, name: 'Lance Scatterstorm', kind: 'hitscan', interval: .17,
  pellets: 9, damage: 12, spread: .14, range: 560, knockback: .7,
  splashRadius: 3.4, splashMax: 10, splashImpulse: 3.5, splashLift: .25,
};
/** One coherent bomb: no cluster spawning or secondary blast recursion. */
export const NOCTURNE_VOID_BOMB: WeaponDef = {
  ...common, id: 208, name: 'Void Bomb', kind: 'projectile', projectile: 'grenade',
  interval: 12, damage: 300, spread: 0, range: 1600, knockback: 0,
  speed: 0, gravity: 14, fuse: 12, splashRadius: 115, splashMax: 270,
  splashImpulse: 65, splashLift: .65, projRadius: .3, bounces: false, terrainBounceTime: 0,
};
export const BASTION_CANNON: WeaponDef = {
  ...common, id: 209, name: 'Solar Cannon', kind: 'projectile', projectile: 'rocket', interval: .16,
  damage: 65, spread: 0, range: 700, knockback: 2,
  speed: 180, gravity: 0, projRadius: .65, splashRadius: 2.5, splashMax: 12,
  splashImpulse: 5, splashLift: .2, impactOnly: true,
};
export const BASTION_SHOCK_SHELL: WeaponDef = {
  ...common, id: 210, name: 'Nuclear Cannon', kind: 'projectile', projectile: 'rocket',
  interval: 10, damage: 300, spread: 0, range: 1600, knockback: 0,
  speed: 125, gravity: 5, fuse: 14, splashRadius: 90, splashMax: 300, splashImpulse: 60,
  splashLift: .8, projRadius: .38, bounces: false, terrainBounceTime: 0,
};
export const GUNBOAT_CANNON: WeaponDef = {
  ...common,id:211,name:'Deck Cannon',kind:'projectile',projectile:'rocket',interval:.2,
  damage:38,spread:0,range:650,speed:150,gravity:1.8,projRadius:.18,
  knockback:1,splashRadius:3.5,splashMax:18,splashImpulse:7,splashLift:.3,
};
export const GUNBOAT_ROCKET: WeaponDef = {
  ...common,id:212,name:'Harbor Rocket',kind:'projectile',projectile:'rocket',interval:1.8,
  damage:110,spread:0,range:950,speed:80,gravity:0,projRadius:.2,
  knockback:0,splashRadius:10,splashMax:85,splashImpulse:18,splashLift:.45,
};
export const TRAIN_NUCLEAR_CANNON: WeaponDef = {
  ...BASTION_SHOCK_SHELL,id:213,name:'Leviathan Nuclear Artillery',interval:5.5,
  damage:450,speed:190,gravity:4,range:2400,fuse:16,splashRadius:130,splashMax:420,splashImpulse:80,
};
/** A private long-range view for the gunner, within the existing entity cap. */
export const MAX_OWNED_ARTILLERY_SHELLS = 4;
export function artilleryPitch(pitch:number):number { return clamp(pitch,-.08,1.1); }
export const CREW_MG: WeaponDef = {
  ...common,id:214,name:'Crew Machine Gun',kind:'hitscan',interval:.085,
  damage:12,spread:.02,range:400,knockback:.6,
};
export const AIRCREW_ROCKET: WeaponDef = {
  ...GUNBOAT_ROCKET,id:215,name:'Ventral Rocket',interval:1.2,range:1200,speed:100,
};
export function vehicleArmament(type: number, variant = 0): { primary: WeaponDef; alt?: WeaponDef } {
  const special = validVehicleVariant(type, variant);
  if (special === VEHICLE_VARIANT.RAIL) return { primary: TRAIN_NUCLEAR_CANNON };
  if (special === VEHICLE_VARIANT.NOCTURNE) return { primary: NOCTURNE_LANCE, alt: NOCTURNE_VOID_BOMB };
  if (special === VEHICLE_VARIANT.BASTION) return { primary: BASTION_CANNON, alt: BASTION_SHOCK_SHELL };
  if (type === VEHICLE.GUNBOAT) return {primary:GUNBOAT_CANNON,alt:GUNBOAT_ROCKET};
  return type === VEHICLE.JET ? { primary: JET_MG, alt: JET_BOMB }
    : type === VEHICLE.TANK ? { primary: TANK_CANNON, alt: TANK_CLUSTER } : { primary: JEEP_MG };
}
export function isJetBombWeapon(id: number): boolean { return id === JET_BOMB.id || id === NOCTURNE_VOID_BOMB.id; }
export function vehicleWeaponColor(id: number): number {
  return id === NOCTURNE_LANCE.id || id === NOCTURNE_VOID_BOMB.id ? 0xc577ff
    : id === BASTION_SHOCK_SHELL.id ? 0x8ee8ed : 0xffd48a;
}

export const CLUSTER_COUNT = 54;
export const CARPET_BOMB_COUNT = 8;

const VEHICLE_WEAPONS: readonly WeaponDef[] = [
  JEEP_MG, TANK_CANNON, TANK_CLUSTER, CLUSTER_BOMBLET, JET_MG, JET_BOMB,
  RUN_OVER, NOCTURNE_LANCE, NOCTURNE_VOID_BOMB, BASTION_CANNON, BASTION_SHOCK_SHELL,
  GUNBOAT_CANNON,GUNBOAT_ROCKET,TRAIN_NUCLEAR_CANNON,CREW_MG,AIRCREW_ROCKET,
];

/** Resolve any weapon id - handheld, auxiliary (100+), or vehicle (200+). */
export function weaponDefById(id: number): WeaponDef | undefined {
  if (id >= 0 && id < WEAPONS.length) return WEAPONS[id];
  return AUX_WEAPONS.find((def) => def.id === id) ??
    VEHICLE_WEAPONS.find((def) => def.id === id);
}

// ---- Homing (rocket launcher vs vehicles) ---------------------------------

/** Aim must stay within this cone of an occupied hull to build a lock. */
export const LOCK_CONE_COS = 0.99619; // ~5 degrees
export const LOCK_RANGE = 900;
/** Ticks of continuous aim required for a full lock (2s at 60Hz). */
export const LOCK_TICKS = 120;
/** Every Rocket Launcher direct hit on a hull is anti-armor, locked or not;
 * a lock only steers the rocket. With the blast of a direct impact (about
 * 115 on the hull) these take a jeep or gunboat in 2-3 hits, a tank in 6 and
 * an aircraft in 3, so a fighter survives a first hit. */
const ROCKET_HULL_DAMAGE: Readonly<Record<number, number>> = {
  [VEHICLE.JEEP]: 5.5, [VEHICLE.GUNBOAT]: 5.5, [VEHICLE.TANK]: 7.2, [VEHICLE.JET]: 2,
};
export function rocketHullDamageFactor(vehicleType: number): number {
  return ROCKET_HULL_DAMAGE[vehicleType] ?? 1;
}
/** Shared per-target bot launch spacing, including rival AA squads. */
export const BOT_AA_LAUNCH_INTERVAL = 7 * 60;
/** Homing rockets fly faster but turn on a leash - outmaneuverable. */
export const HOMING_SPEED_FACTOR = 6.25;
export const HOMING_RANGE_FACTOR = 2.5;
export const HOMING_TURN_RATE = 3.4; // ground armor remains vulnerable to close-range locked shots
/** Aircraft have room to perform a deliberate break turn before impact. */
export const HOMING_AIR_TURN_RATE = 1.65; // rad/s; ~182m radius at300m/s
/** The rocket drops its lock beyond this off-axis angle. */
export const HOMING_BREAK_COS = 0.5; // 60 degrees
