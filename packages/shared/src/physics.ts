import { PLAYER } from './constants.js';
import type { World } from './worldgen.js';

// Capsule-vs-implicit-field collision. The world's sign is canonical
// (positive air, negative solid), but its MAGNITUDE is not a metric distance:
// cave subtraction and height-field CSG can leave a small positive local
// minimum where the old height surface has been carved away. Raw field values
// are therefore only a broad-phase hint. Every contact below is validated by
// finding an actual air->solid sign bracket inside the capsule radius before
// it may push, ground, or snap the player.

export interface KinState {
  px: number; py: number; pz: number; // feet position
  vx: number; vy: number; vz: number;
  grounded: boolean;
}

export interface CollideResult {
  /** Vertical impact speed absorbed this step (for fall damage/effects). */
  impact: number;
}

const R = PLAYER.RADIUS;
const H = PLAYER.HEIGHT;
/** Max movement per substep; well below the thinnest world feature (~0.9m). */
const MAX_SUBSTEP_MOVE = 0.22;
/** Small separation left between the capsule and a resolved surface. */
const CONTACT_SKIN = 0.006;
/** Raw-field broad phase only; false positives are rejected by sign probes. */
const CONTACT_BROAD_D = R + 1.2;
const ROOT_ITERS = 10;
const MAX_RECOVERY = 192;
const AXIS_SPAN = H - R * 2;
/**
 * Five spheres approximate the continuous capsule axis. At this 0.24m
 * spacing, the largest unsampled radial sliver is under 1.8cm; three levels
 * would leave a 7.6cm gap that thin ledges could enter.
 */
const AXIS_OFFSETS = [
  R,
  R + AXIS_SPAN * 0.25,
  H * 0.5,
  R + AXIS_SPAN * 0.75,
  H - R,
] as const;

const grad = { x: 0, y: 1, z: 0 };
const probe = { dist: 0, nx: 0, ny: 1, nz: 0 };
const contact = { depth: 0, nx: 0, ny: 1, nz: 0, mx: 0, my: 1, mz: 0 };
const axisYs = new Float64Array(AXIS_OFFSETS.length);
const axisDs = new Float64Array(AXIS_OFFSETS.length);

const INV_SQRT3 = 1 / Math.sqrt(3);
/** Fallback sphere rays when the implicit-field gradient points at a ghost CSG branch. */
const PROBE_DIRS: readonly (readonly [number, number, number])[] = [
  [-1, 0, 0], [1, 0, 0],
  [0, -1, 0], [0, 1, 0],
  [0, 0, -1], [0, 0, 1],
  [-INV_SQRT3, -INV_SQRT3, -INV_SQRT3],
  [-INV_SQRT3, -INV_SQRT3, INV_SQRT3],
  [-INV_SQRT3, INV_SQRT3, -INV_SQRT3],
  [-INV_SQRT3, INV_SQRT3, INV_SQRT3],
  [INV_SQRT3, -INV_SQRT3, -INV_SQRT3],
  [INV_SQRT3, -INV_SQRT3, INV_SQRT3],
  [INV_SQRT3, INV_SQRT3, -INV_SQRT3],
  [INV_SQRT3, INV_SQRT3, INV_SQRT3],
];

/**
 * Minimum canonical field value sampled on the capsule boundary.
 *
 * Only the sign is meaningful: a negative result identifies sampled overlap
 * with solid, while a positive result means the sampled shell is in air. It is
 * deliberately not reported as meters of clearance.
 */
export function capsuleClearance(world: World, px: number, py: number, pz: number): number {
  let minD = Infinity;
  for (const offset of AXIS_OFFSETS) {
    const cy = py + offset;
    for (const d of PROBE_DIRS) {
      const v = world.sdf(
        px + d[0] * R,
        cy + d[1] * R,
        pz + d[2] * R,
      );
      if (v < minD) minD = v;
    }
  }
  return minD;
}

/**
 * Find the first real solid crossing along a ray that starts in air.
 * Small positive field values alone are never considered a surface.
 */
function bracketSurfaceFromAir(
  world: World,
  x: number, y: number, z: number,
  dx: number, dy: number, dz: number,
  maxDist: number,
  startD: number,
  knownEndD?: number,
): boolean {
  if (!(startD > 0) || maxDist <= 0) return false;
  const ex = x + dx * maxDist;
  const ey = y + dy * maxDist;
  const ez = z + dz * maxDist;
  const endD = knownEndD ?? world.sdf(ex, ey, ez);
  if (endD > 0) return false;

  let lo = 0;
  let hi = maxDist;
  for (let i = 0; i < ROOT_ITERS; i++) {
    const mid = (lo + hi) * 0.5;
    if (world.sdf(x + dx * mid, y + dy * mid, z + dz * mid) > 0) lo = mid;
    else hi = mid;
  }

  const hx = x + dx * hi;
  const hy = y + dy * hi;
  const hz = z + dz * hi;
  world.gradient(hx, hy, hz, grad);
  probe.dist = hi;
  probe.nx = grad.x;
  probe.ny = grad.y;
  probe.nz = grad.z;
  return true;
}

/**
 * Directly sample the same shell stencil used by capsuleClearance(). This is
 * the correctness fallback for non-metric fields: no center-value threshold
 * is allowed to discard a negative sampled boundary point.
 */
function sampledSphereContact(
  world: World,
  x: number, y: number, z: number,
  centerD: number,
  r: number = R,
): boolean {
  if (centerD <= 0) return recoverSolidCenter(world, x, y, z, r);
  const reach = r + CONTACT_SKIN;
  let bestDist = Infinity;
  let bestNx = 0, bestNy = 1, bestNz = 0;
  for (const d of PROBE_DIRS) {
    const endD = world.sdf(
      x + d[0] * r,
      y + d[1] * r,
      z + d[2] * r,
    );
    if (endD > 0 || !bracketSurfaceFromAir(
      world, x, y, z, d[0], d[1], d[2], r, centerD, endD,
    )) continue;
    if (probe.dist < bestDist) {
      bestDist = probe.dist;
      bestNx = probe.nx;
      bestNy = probe.ny;
      bestNz = probe.nz;
    }
  }
  if (bestDist === Infinity) return false;

  contact.depth = reach - bestDist;
  contact.nx = bestNx;
  contact.ny = bestNy;
  contact.nz = bestNz;
  contact.mx = bestNx;
  contact.my = bestNy;
  contact.mz = bestNz;
  return contact.depth > 0.0005;
}

/**
 * Recover a sphere center that is itself inside solid. This is the expensive
 * teleport/deep-penetration path, not the ordinary per-tick contact path.
 */
function recoverSolidCenter(
  world: World,
  x: number, y: number, z: number,
  r: number = R,
): boolean {
  world.gradient(x, y, z, grad);
  const dx = grad.x, dy = grad.y, dz = grad.z;
  let lo = 0;
  let hi = 0.05;
  while (hi < MAX_RECOVERY &&
         world.sdf(x + dx * hi, y + dy * hi, z + dz * hi) <= 0) {
    lo = hi;
    hi *= 2;
  }
  if (hi > MAX_RECOVERY) hi = MAX_RECOVERY;
  if (world.sdf(x + dx * hi, y + dy * hi, z + dz * hi) <= 0) return false;

  for (let i = 0; i < ROOT_ITERS; i++) {
    const mid = (lo + hi) * 0.5;
    if (world.sdf(x + dx * mid, y + dy * mid, z + dz * mid) <= 0) lo = mid;
    else hi = mid;
  }
  const hx = x + dx * hi;
  const hy = y + dy * hi;
  const hz = z + dz * hi;
  world.gradient(hx, hy, hz, grad);
  contact.depth = hi + r + CONTACT_SKIN;
  contact.nx = grad.x;
  contact.ny = grad.y;
  contact.nz = grad.z;
  // Follow the proven solid->air escape ray for deep recovery. Its surface
  // normal is still used for velocity clipping and impact classification.
  contact.mx = dx;
  contact.my = dy;
  contact.mz = dz;
  return true;
}

/** Find a sign-validated contact for one sphere on the capsule axis. */
function sphereContact(
  world: World,
  x: number, y: number, z: number,
  centerD: number,
  r: number = R,
): boolean {
  if (centerD <= 0) return recoverSolidCenter(world, x, y, z, r);

  world.gradient(x, y, z, grad);
  const towardX = -grad.x;
  const towardY = -grad.y;
  const towardZ = -grad.z;
  const reach = r + CONTACT_SKIN;

  // Usually the normalized implicit gradient identifies the closest face.
  if (bracketSurfaceFromAir(
    world, x, y, z, towardX, towardY, towardZ, reach, centerD,
  )) {
    contact.depth = reach - probe.dist;
    contact.nx = probe.nx;
    contact.ny = probe.ny;
    contact.nz = probe.nz;
    contact.mx = probe.nx;
    contact.my = probe.ny;
    contact.mz = probe.nz;
    if (contact.depth > 0.0005) return true;
    // A merely grazing surface on the gradient ray must not mask a deeper
    // negative shell sample in another direction.
    return sampledSphereContact(world, x, y, z, centerD, r);
  }

  // At max/min CSG creases the gradient can point toward a removed primitive
  // rather than toward the resulting solid.
  return sampledSphereContact(world, x, y, z, centerD, r);
}

export interface SphereFieldContact {
  depth: number;
  /** Surface normal (velocity clipping / impact classification). */
  nx: number; ny: number; nz: number;
  /** Push-out direction (equals the normal except in deep recovery). */
  mx: number; my: number; mz: number;
}

/**
 * Sign-validated contact for a free sphere (vehicle hulls). The raw field
 * magnitude is only a broad phase - a contact exists only where an actual
 * air->solid crossing lies within the radius, exactly like the player
 * capsule. Trusting `sdf(center) < radius` instead makes hulls hover on the
 * small positive minima left where cave entrances carved the heightfield
 * away. Returns a shared record valid until the next physics call.
 */
export function sphereFieldContact(
  world: World,
  x: number, y: number, z: number,
  radius: number,
): SphereFieldContact | null {
  const d = world.sdf(x, y, z);
  if (d >= radius + 1.2) return null;
  return sphereContact(world, x, y, z, d, radius) ? contact : null;
}

/**
 * True when a real, upward-facing air->solid crossing lies within `maxDist`
 * below (x,y,z) (a solid start also counts). The sign-validated "is there
 * ground under this hull" probe - see sphereFieldContact for why raw field
 * magnitudes must not be used for this.
 */
export function probeGroundBelowPoint(
  world: World,
  x: number, y: number, z: number,
  maxDist: number,
  minNormalY = 0.3,
): boolean {
  const d = world.sdf(x, y, z);
  if (d <= 0) return true;
  if (!bracketSurfaceFromAir(world, x, y, z, 0, -1, 0, maxDist, d)) return false;
  return probe.ny > minNormalY;
}

/**
 * Find one capsule contact, trying the most suspicious raw-field axis sample
 * first. Raw magnitudes only prioritize work; sphereContact validates signs.
 */
function findCapsuleContact(world: World, px: number, py: number, pz: number): boolean {
  const col = world.column(px, pz);
  const region = world.regionAt(px, pz);
  for (let i = 0; i < AXIS_OFFSETS.length; i++) {
    axisYs[i] = py + AXIS_OFFSETS[i];
    axisDs[i] = world.sdfCol(px, axisYs[i], pz, col, region);
  }
  let tried = 0;
  for (let attempt = 0; attempt < AXIS_OFFSETS.length; attempt++) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < AXIS_OFFSETS.length; i++) {
      if ((tried & (1 << i)) === 0 && axisDs[i] < bestD) {
        best = i;
        bestD = axisDs[i];
      }
    }
    if (best < 0 || bestD >= CONTACT_BROAD_D) break;
    tried |= 1 << best;
    if (sphereContact(world, px, axisYs[best], pz, bestD)) return true;
  }

  // Center magnitude is not a safe rejection criterion. Directly inspect
  // every axis level the fast path did not already validate.
  for (let i = 0; i < AXIS_OFFSETS.length; i++) {
    if ((tried & (1 << i)) !== 0) continue;
    if (sampledSphereContact(world, px, axisYs[i], pz, axisDs[i])) return true;
  }
  return false;
}

/** Real, upward-facing support below the capsule's bottom sphere center. */
function groundProbe(
  world: World,
  px: number, py: number, pz: number,
  extra: number,
  minNormalY: number,
): boolean {
  const cy = py + R;
  const d = world.sdf(px, cy, pz);
  if (!bracketSurfaceFromAir(world, px, cy, pz, 0, -1, 0, R + extra, d)) {
    return false;
  }
  return probe.ny > minNormalY;
}

/** Test/debug invariant used to verify that a grounded pose has real support. */
export function capsuleHasGroundSupport(
  world: World,
  px: number, py: number, pz: number,
  extra = 0.16,
): boolean {
  return groundProbe(world, px, py, pz, extra, 0.5);
}

/**
 * Integrate `state` forward by dt against the world, sliding along surfaces.
 * `allowSnap` keeps the capsule glued to the ground over small downhill drops
 * (disabled on the jump tick).
 */
export function collideCapsule(world: World, s: KinState, dt: number, allowSnap: boolean): CollideResult {
  const res: CollideResult = { impact: 0 };
  const wasGrounded = s.grounded;

  const speed = Math.sqrt(s.vx * s.vx + s.vy * s.vy + s.vz * s.vz);
  const steps = Math.min(8, Math.max(1, Math.ceil((speed * dt) / MAX_SUBSTEP_MOVE)));
  const sdt = dt / steps;

  for (let step = 0; step < steps; step++) {
    s.px += s.vx * sdt;
    s.py += s.vy * sdt;
    s.pz += s.vz * sdt;

    // Push-out iterations use raw field samples only as a broad phase. The
    // selected contact already proved an air->solid crossing within radius.
    // Most floor/wall contacts converge in one iteration. Acute procedural
    // cave creases can expose a long chain of alternating shell contacts, so
    // retain a bounded recovery tail for those rare configurations.
    for (let iter = 0; iter < 32; iter++) {
      if (!findCapsuleContact(world, s.px, s.py, s.pz)) break;
      s.px += contact.mx * contact.depth;
      s.py += contact.my * contact.depth;
      s.pz += contact.mz * contact.depth;

      const vn = s.vx * contact.nx + s.vy * contact.ny + s.vz * contact.nz;
      if (vn < 0) {
        if (contact.ny > 0.5 && -vn > res.impact) res.impact = -vn;
        s.vx -= contact.nx * vn;
        s.vy -= contact.ny * vn;
        s.vz -= contact.nz * vn;
      }
    }
  }

  // Grounded/snap probes require a real negative sample below the player and
  // bisect its first sign crossing. A small positive CSG minimum is air.
  {
    // A short input substep can leave a rising jumper inside probe range.
    // The controller disables snap through that ascent; stair contacts keep
    // their normal probe even when a step projects velocity upward.
    const canGround = allowSnap || s.vy <= 0.5;
    let grounded = canGround && groundProbe(world, s.px, s.py, s.pz, 0.14, 0.5);

    // Downhill snap: if we just left the ground while moving along it (not
    // jumping), glue back down within GROUND_SNAP so slopes don't stutter.
    if (!grounded && wasGrounded && allowSnap && s.vy <= 0.5) {
      if (groundProbe(world, s.px, s.py, s.pz, PLAYER.GROUND_SNAP, 0.55)) {
        // The probe travels vertically, but separation is measured along
        // the support normal. Snapping just R above a sloping floor embeds
        // the uphill side of the capsule's bottom sphere into solid ground.
        const drop = probe.dist - (R + CONTACT_SKIN) / probe.ny;
        if (drop > 0) s.py -= drop;
        grounded = true;
        if (s.vy < 0) s.vy = 0;
      }
    }
    s.grounded = grounded;
  }

  // Never allow NaN/Inf to propagate through the simulation.
  if (!Number.isFinite(s.px) || !Number.isFinite(s.py) || !Number.isFinite(s.pz) ||
      !Number.isFinite(s.vx) || !Number.isFinite(s.vy) || !Number.isFinite(s.vz)) {
    s.px = 0; s.py = 120; s.pz = 0;
    s.vx = 0; s.vy = 0; s.vz = 0;
    s.grounded = false;
  }

  return res;
}

/**
 * Analytic ray vs vertical capsule (segment [ay0,ay1] at (ax,az), radius r).
 * Returns hit distance along the (normalized) ray, or -1.
 */
export function rayCapsule(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  maxT: number,
  ax: number, ay0: number, ay1: number, az: number,
  r: number,
): number {
  // Cylinder part: project to XZ around the axis.
  const mx = ox - ax, mz = oz - az;
  const a = dx * dx + dz * dz;
  const r2 = r * r;
  let best = -1;

  if (a > 1e-12) {
    const b = mx * dx + mz * dz;
    const c = mx * mx + mz * mz - r2;
    const disc = b * b - a * c;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t = (-b - sq) / a;
      if (t >= 0 && t <= maxT) {
        const y = oy + dy * t;
        if (y >= ay0 && y <= ay1) best = t;
      }
    }
  } else {
    // Ray is vertical: inside the circle?
    if (mx * mx + mz * mz <= r2 && dy !== 0) {
      const tTop = (ay1 - oy) / dy;
      const tBot = (ay0 - oy) / dy;
      const t = Math.min(
        tTop >= 0 ? tTop : Infinity,
        tBot >= 0 ? tBot : Infinity,
      );
      if (t !== Infinity && t <= maxT) best = t;
    }
  }

  // End-cap spheres.
  for (const cy of [ay0, ay1]) {
    const ex = ox - ax, ey = oy - cy, ez = oz - az;
    const b = ex * dx + ey * dy + ez * dz;
    const c = ex * ex + ey * ey + ez * ez - r2;
    if (c <= 0) return 0; // started inside
    const disc = b * b - c;
    if (disc >= 0) {
      const t = -b - Math.sqrt(disc);
      if (t >= 0 && t <= maxT && (best < 0 || t < best)) best = t;
    }
  }
  return best;
}
