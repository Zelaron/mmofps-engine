import { transportPose, transportBoxes, TRAIN_ARTILLERY_MOUNT, type TransportPose, type TransportRoute } from './transport.js';
import { solidBoxDistance } from './box-field.js';
import type { World } from './worldgen.js';
import { collideCapsule, type KinState, type CollideResult } from './physics.js';
import type { MoveState } from './movement.js';
import { wrapAngle } from './math.js';
import { PLAYER } from './constants.js';
import type { Box } from './worldgen.js';

export function placeTrainArtillery(world: World, state: MoveState, routeId: number, seconds: number): void {
  const route = world.collectTransportPlan().routes.find(r => r.id === routeId);
  if (!route) return;
  const pose = transportPose(route, seconds, route.carOffsets[TRAIN_ARTILLERY_MOUNT.car]);
  const p = transitWorld(pose, TRAIN_ARTILLERY_MOUNT.x, TRAIN_ARTILLERY_MOUNT.y, TRAIN_ARTILLERY_MOUNT.z);
  state.px = p.x; state.py = p.y; state.pz = p.z; state.heading = pose.yaw;
  state.vx = pose.vx; state.vy = pose.vy; state.vz = pose.vz;
  state.vehiclePitch = 0; state.vehicleRoll = 0; state.grounded = true;
}

interface Body { route: TransportRoute; car: number; pose: TransportPose }
interface TransitFrame { seconds: number; bodies: Body[]; nearby?: Map<number, Body[]> }
// Every simulated rider asks for the same previous/current pair. Retaining
// both avoids rebuilding all route poses twice for every passenger each tick.
const frames = new WeakMap<World, TransitFrame[]>();
function frameAt(world: World, seconds: number): TransitFrame {
  let cached = frames.get(world);
  const found = cached?.find(frame => frame.seconds === seconds);
  if (found) return found;
  const bodies: Body[] = [];
  for (const route of world.collectTransportPlan().routes) for (let car = 0; car < route.carOffsets.length; car++)
    bodies.push({ route, car, pose: transportPose(route, seconds, route.carOffsets[car]) });
  if (!cached) { cached = []; frames.set(world, cached); }
  const frame = { seconds, bodies };
  cached.push(frame); if (cached.length > 2) cached.shift();
  return frame;
}
const CELL = 128, NEAR_DISTANCE = 32;
const EMPTY_BODIES: readonly Body[] = [];
const spatialKey = (x: number, z: number) => (x + 512) * 1024 + z + 512;
function nearbyBodies(world: World, seconds: number, x: number, z: number, distance: number): readonly Body[] {
  const frame = frameAt(world, seconds);
  if (distance > NEAR_DISTANCE) return frame.bodies;
  if (!frame.nearby) {
    const cells = new Map<number, Body[]>();
    for (const body of frame.bodies) {
      const margin = (body.route.kind === 'ferry' ? 38 : 20) + NEAR_DISTANCE;
      for (let ix = Math.floor((body.pose.x-margin)/CELL); ix <= Math.floor((body.pose.x+margin)/CELL); ix++)
        for (let iz = Math.floor((body.pose.z-margin)/CELL); iz <= Math.floor((body.pose.z+margin)/CELL); iz++) {
          const key = spatialKey(ix,iz), cell = cells.get(key);
          if (cell) cell.push(body); else cells.set(key,[body]);
        }
    }
    frame.nearby = cells;
  }
  return frame.nearby.get(spatialKey(Math.floor(x/CELL),Math.floor(z/CELL))) ?? EMPTY_BODIES;
}
export function transitLocal(pose: TransportPose, x: number, y: number, z: number): { x: number; y: number; z: number } {
  const dx = x - pose.x, dz = z - pose.z, c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  return { x: c * dx - s * dz, y: y - pose.y, z: s * dx + c * dz };
}
export function transitWorld(pose: TransportPose, x: number, y: number, z: number): { x: number; y: number; z: number } {
  const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
  return { x: pose.x + c * x + s * z, y: pose.y + y, z: pose.z - s * x + c * z };
}
/** Only physics worlds activate this union; terrain workers mesh static land. */
export function transitDistance(world: World, seconds: number, x: number, y: number, z: number, best: number): number {
  for (const body of nearbyBodies(world, seconds, x, z, best)) {
    const p = body.pose, reach = body.route.kind === 'ferry' ? 38 : 20;
    if (Math.abs(x - p.x) > reach + Math.max(0, best) || Math.abs(z - p.z) > reach + Math.max(0, best) || Math.abs(y - p.y) > 16 + Math.max(0, best)) continue;
    const local = transitLocal(p, x, y, z);
    best = solidBoxDistance(transportBoxes(body.route, body.car), local.x, local.y, local.z, best);
  }
  return best;
}
export interface TransitCarry { dx: number; dy: number; dz: number; before: number; now: number; routeId: number }
/** Attachment is derived from canonical support, never from a network entity. */
export function transitSupport(world: World, state: KinState, seconds: number):
  { route: TransportRoute; car: number; pose: TransportPose; local: { x: number; y: number; z: number } } | null {
  if (!state.grounded || state.vy > .1 || !world.collectTransportPlan) return null;
  for (const body of nearbyBodies(world, seconds, state.px, state.pz, 0)) {
    const local = transitLocal(body.pose, state.px, state.py, state.pz);
    for (const box of transportBoxes(body.route, body.car)) {
      if (Math.abs(local.x - box.x) <= box.hx + .15 && Math.abs(local.z - box.z) <= box.hz + .15 &&
          Math.abs(local.y - box.y - box.hy) <= .14) return { ...body, local };
    }
  }
  return null;
}
/** Feet resting on any genuine deck, stair, or roof inherit its rigid motion. */
export function carryTransit(world: World, state: KinState, before: number, now: number): TransitCarry | null {
  if (!state.grounded || state.vy > .1 || !world.collectTransportPlan) return null;
  for (const body of nearbyBodies(world, before, state.px, state.pz, 0)) {
    const p = body.pose, reach = body.route.kind === 'ferry' ? 38 : 20;
    if (Math.abs(state.px - p.x) > reach || Math.abs(state.pz - p.z) > reach) continue;
    const local = transitLocal(p, state.px, state.py, state.pz);
    for (const box of transportBoxes(body.route, body.car)) {
      if (Math.abs(local.x - box.x) > box.hx + .15 || Math.abs(local.z - box.z) > box.hz + .15 || Math.abs(local.y - box.y - box.hy) > .14) continue;
      const to = transportPose(body.route, now, body.route.carOffsets[body.car]), target = transitWorld(to, local.x, local.y, local.z);
      const carry = { dx: target.x - state.px, dy: target.y - state.py, dz: target.z - state.pz, before, now, routeId: body.route.id };
      state.px = target.x; state.py = target.y; state.pz = target.z;
      const rotating = state as KinState & { heading?: number };
      if (rotating.heading !== undefined) rotating.heading += wrapAngle(to.yaw - p.yaw);
      return carry;
    }
  }
  return null;
}

/** Convert a landing's inertial velocity back to the carrier-relative velocity
 * stored while grounded. Otherwise the next tick adds the ship's travel twice. */
export function settleTransitLanding(world: World, state: KinState, before: number, now: number): boolean {
  if (!state.grounded || !world.collectTransportPlan) return false;
  for (const body of nearbyBodies(world, now, state.px, state.pz, 0)) {
    const local = transitLocal(body.pose, state.px, state.py, state.pz);
    const reach = body.route.kind === 'ferry' ? 38 : 20;
    if (Math.abs(local.x) > reach || Math.abs(local.z) > reach) continue;
    for (const box of transportBoxes(body.route, body.car)) {
      if (Math.abs(local.x - box.x) > box.hx + .15 || Math.abs(local.z - box.z) > box.hz + .15 || Math.abs(local.y - box.y - box.hy) > .14) continue;
      const previous = transportPose(body.route, before, body.route.carOffsets[body.car]);
      const old = transitWorld(previous, local.x, local.y, local.z), span = Math.max(.001, now - before);
      state.vx -= (state.px - old.x) / span;
      state.vz -= (state.pz - old.z) / span;
      return true;
    }
  }
  return false;
}

type Point = { x: number; y: number; z: number };
interface SweepHit { t: number; x: number; y: number; z: number; nx: number; ny: number; nz: number }
/** Exact distance from a vertical capsule axis to a box. Circular corners
 * avoid the phantom contacts produced by a merely expanded box sweep. */
function capsuleBoxGap(p: Point, box: Box): { distance: number; nx: number; ny: number; nz: number } {
  const dx = p.x - box.x, dz = p.z - box.z;
  const qx = Math.max(0, Math.abs(dx) - box.hx), qz = Math.max(0, Math.abs(dz) - box.hz);
  const bottom = p.y + PLAYER.RADIUS, top = p.y + PLAYER.HEIGHT - PLAYER.RADIUS;
  const qy = Math.max(0, bottom - box.y - box.hy, box.y - box.hy - top);
  const length = Math.hypot(qx, qy, qz);
  if (length > 1e-8) return { distance: length - PLAYER.RADIUS,
    nx: Math.sign(dx) * qx / length, ny: (bottom > box.y ? 1 : -1) * qy / length, nz: Math.sign(dz) * qz / length };
  // Existing overlap: a short horizontal separation is preferable to the
  // old field-gradient recovery lifting a track victim through the floor.
  const xDepth = box.hx - Math.abs(dx), zDepth = box.hz - Math.abs(dz);
  return { distance: -PLAYER.RADIUS, nx: xDepth < zDepth ? Math.sign(dx) || 1 : 0,
    ny: 0, nz: xDepth < zDepth ? 0 : Math.sign(dz) || 1 };
}
function sweepCapsuleBox(from: Point, to: Point, box: Box): SweepHit | null {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z, speed = Math.hypot(dx, dy, dz);
  if (Math.min(from.x, to.x) > box.x + box.hx + PLAYER.RADIUS || Math.max(from.x, to.x) < box.x - box.hx - PLAYER.RADIUS ||
      Math.min(from.z, to.z) > box.z + box.hz + PLAYER.RADIUS || Math.max(from.z, to.z) < box.z - box.hz - PLAYER.RADIUS ||
      Math.min(from.y, to.y) > box.y + box.hy + .01 || Math.max(from.y, to.y) + PLAYER.HEIGHT < box.y - box.hy) return null;
  let t = 0;
  for (let i = 0; i < 32 && t <= 1; i++) {
    const p = { x: from.x + dx * t, y: from.y + dy * t, z: from.z + dz * t }, gap = capsuleBoxGap(p, box);
    if (gap.distance < .008) return { t, ...p, nx: gap.nx, ny: gap.ny, nz: gap.nz };
    if (speed < 1e-8) return null;
    t += Math.max(.00001, (gap.distance - .006) / speed);
  }
  return null;
}

/** Damage is based on relative closing speed, separate from landing damage.
 * A brisk boarding nudge is harmless; a full-speed train is a serious hit. */
export function transitImpactDamage(speed: number): number {
  return speed <= 10 ? 0 : Math.min(100, Math.round((speed - 10) * 1.8));
}

/** Integrate nearby moving trains in bounded shared-clock slices. Ordinary
 * collision alone freezes a 62m/s train at the new pose, letting thin floors
 * cross stationary players between ticks. Sweeping each capsule relative to
 * the car catches that crossing before expensive deep-solid recovery runs. */
export function collideTransitCapsule(world: World, state: KinState, dt: number, allowSnap: boolean,
  before: number, now: number, carried: TransitCarry | null): CollideResult & { transitImpact: number } {
  const span = now - before;
  if (!world.collectTransportPlan || span <= 0 || span > .1) return { ...collideCapsule(world, state, dt, allowSnap), transitImpact: 0 };
  const bodies = nearbyBodies(world, before, state.px, state.pz, 0).filter(body => body.route.kind === 'train' &&
    body.route.id !== carried?.routeId && Math.abs(state.py - body.pose.y) < 12 &&
    Math.hypot(state.px - body.pose.x, state.pz - body.pose.z) < 25 &&
    Math.hypot(body.pose.vx, body.pose.vz) > .1);
  if (!bodies.length) return { ...collideCapsule(world, state, dt, allowSnap), transitImpact: 0 };
  const maxSpeed = Math.max(...bodies.map(body => Math.hypot(body.pose.vx - state.vx, body.pose.vz - state.vz)));
  const slices = Math.min(12, Math.max(1, Math.ceil(maxSpeed * dt / .18)));
  const out = { impact: 0, transitImpact: 0 };
  for (let step = 0; step < slices; step++) {
    const t0 = before + span * step / slices, t1 = before + span * (step + 1) / slices, slice = dt / slices;
    let first: { body: Body; old: TransportPose; pose: TransportPose; from: Point; hit: SweepHit; box: Box } | undefined;
    for (const body of bodies) {
      const old = transportPose(body.route, t0, body.route.carOffsets[body.car]), pose = transportPose(body.route, t1, body.route.carOffsets[body.car]);
      const from = transitLocal(old, state.px, state.py, state.pz);
      const to = transitLocal(pose, state.px + state.vx * slice, state.py + state.vy * slice, state.pz + state.vz * slice);
      for (const box of transportBoxes(body.route, body.car)) {
        const hit = sweepCapsuleBox(from, to, box);
        if (!hit || Math.abs(hit.ny) > .5 || (first && hit.t >= first.hit.t)) continue;
        const c = Math.cos(pose.yaw), s = Math.sin(pose.yaw), nx = c * hit.nx + s * hit.nz, nz = -s * hit.nx + c * hit.nz;
        const a = transitWorld(old, hit.x, hit.y, hit.z), b = transitWorld(pose, hit.x, hit.y, hit.z);
        const closing = ((b.x - a.x) / slice - state.vx) * nx + ((b.z - a.z) / slice - state.vz) * nz;
        if (closing <= .4) continue;
        first = { body, old, pose, from, hit, box };
      }
    }
    if (first) {
      const { old, pose, from, hit, box } = first, c = Math.cos(pose.yaw), s = Math.sin(pose.yaw);
      const nx = c * hit.nx + s * hit.nz, nz = -s * hit.nx + c * hit.nz;
      const a = transitWorld(old, hit.x, hit.y, hit.z), b = transitWorld(pose, hit.x, hit.y, hit.z);
      const vx = (b.x - a.x) / slice, vz = (b.z - a.z) / slice;
      const closing = Math.max(0, (vx - state.vx) * nx + (vz - state.vz) * nz);
      // Someone already inside the deck footprint is a passenger, including
      // jumping riders whose velocity a cabin wall may have clipped.
      const rider = from.y >= 1.05 && Math.abs(from.x) < 4.9 && Math.abs(from.z) < 12.5;
      const hard = !rider && closing > 10;
      if (!rider) out.transitImpact = Math.max(out.transitImpact, closing);
      const local = transitLocal(pose, state.px, state.py, state.pz), gap = capsuleBoxGap(local, box);
      const push = Math.min(.24, Math.max(0, .012 - gap.distance));
      state.px += nx * push; state.pz += nz * push;
      // Front/rear impacts shed the victim sideways, avoiding an endless
      // ride against the nose. Every displacement remains a small contact
      // separation; the escape is ordinary predicted velocity afterwards.
      const side = hard && Math.abs(hit.nz) > .65 ? (from.x >= 0 ? 1 : -1) * 15 : 0;
      state.vx = vx + nx * (hard ? 4 : .35) + c * side;
      state.vz = vz + nz * (hard ? 4 : .35) - s * side;
      if (hard) { state.vy = Math.max(state.vy, 5.5); state.grounded = false; }
    }
    world.motionTime = t1;
    const result = collideCapsule(world, state, slice, allowSnap);
    out.impact = Math.max(out.impact, result.impact);
  }
  world.motionTime = now;
  return out;
}
