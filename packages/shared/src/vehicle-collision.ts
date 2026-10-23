import { PLAYER, TICK_RATE } from './constants.js';
import { clamp } from './math.js';
import { normalizeRotation, rotationFromEuler, type Rotation } from './rotation.js';
import { VEHICLE, VEHICLE_VARIANT, NOCTURNE_SCALE, validVehicleVariant } from './vehicle-identity.js';
import type { KinState } from './physics.js';
import type { World } from './worldgen.js';

export interface VehicleColliderPose {
  id: number; type: number; variant?: number;
  x: number; y: number; z: number; heading: number;
  pitch?: number; roll?: number; rotation?: Rotation;
  vx?: number; vy?: number; vz?: number;
  health: number; respawnAtTick?: number; transportRoute?: number;
}

interface HullBox { x: number; y: number; z: number; hx: number; hy: number; hz: number; c: number; s: number }
const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw = 0): HullBox =>
  ({ x, y, z, hx, hy, hz, c: Math.cos(yaw), s: Math.sin(yaw) });
const scaled = (boxes: HullBox[], scale: number): HullBox[] => boxes.map(b => ({ ...b,
  x: b.x * scale, y: b.y * scale, z: b.z * scale, hx: b.hx * scale, hy: b.hy * scale, hz: b.hz * scale }));

// Local origin and major surfaces follow client/render/vehicles.ts. Small
// weapons, mirrors, aerials and exhaust are decorative; cabins, decks, tracks
// and substantial airfoils are physical. Do not fill the crescent's open bays.
const JEEP = [box(0, .93, .04, .92, .34, 1.84), box(0, 1.62, .36, .90, .435, .82),
  box(0, .69, -1.89, .96, .11, .1), box(0, 1.30, 1.88, .39, .39, .16),
  ...[-1, 1].flatMap(side => [-1.18, 1.13].map(z => box(side, .485, z, .225, .46, .46)))];
const TANK = [box(0, 1.04, 0, 1.43, .43, 2.2), box(0, 1.95, .30, 1.07, .39, 1.17),
  box(-.34, 2.405, .66, .30, .075, .30),
  ...[-1, 1].map(side => box(side * 1.42, .59, 0, .29, .51, 2.33))];
const BASTION = scaled([box(0, 1.15, -.07, 1.68, .54, 2.73), box(0, 2.34, .32, 1.30, .49, 1.38),
  box(-.48, 2.865, .77, .37, .095, .37),
  ...[-1, 1].flatMap(side => [box(side * 1.66, .73, -.04, .44, .65, 2.84),
    box(side * 1.88, 1.69, .20, .20, .39, 1.42)])], 1.3);
const JET = [box(0, 1.20, .13, .61, .46, 2.38), box(0, 1.17, -2.95, .26, .22, .72),
  box(0, 1.16, 2.82, .38, .33, .40), box(0, 1.76, -1.20, .35, .33, .79),
  ...[-1, 1].flatMap(side => [box(side * .98, 1.14, -.13, .48, .12, 1.1),
    box(side * 1.97, 1.14, .36, .51, .12, .76), box(side * 3.04, 1.14, .88, .61, .12, .47),
    box(side * 1.03, 1.45, 2.68, .59, .12, .53), box(side * .71, 1.97, 2.34, .12, .62, .70)])];
const NOCTURNE = (() => {
  const boxes = [box(0, 1.23, -.55, .57, .40, 1.73), box(0, 1.14, -3.13, .25, .19, .95),
    box(0, 1.35, 2.42, .28, .29, 1.48), box(0, 1.72, -1.4, .34, .26, .9)];
  for (const side of [-1, 1]) {
    const points = [[.45, 1.18, -.8], [2.4, 1.46, 1.05], [4.6, 1.65, .54], [5.25, 1.30, -1.25], [3.7, 1.06, -3.55]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], dx = (b[0] - a[0]) * side, dz = b[2] - a[2];
      boxes.push(box((a[0] + b[0]) * side * .5, (a[1] + b[1]) * .5, (a[2] + b[2]) * .5,
        [.53, .48, .33, .17][i - 1], .16, Math.hypot(dx, dz) * .5 + .17, Math.atan2(dx, dz)));
    }
    boxes.push(box(side * 1.08, 1.67, 2.90, .43, .20, 1.10));
  }
  return scaled(boxes, NOCTURNE_SCALE);
})();
const GUNBOAT = [box(0, .79, .5, 1.98, .69, 4.18), box(0, 1.04, -4.17, .81, .43, .87),
  box(0, 1.45, .68, 1.85, .06, 3.65), box(0, 2.01, 1, 1.35, .54, 1.25),
  box(0, 2.63, 1, 1.47, .08, 1.365)];
const EMPTY: readonly HullBox[] = [];
const RADII = new Map<readonly HullBox[], number>([JEEP, TANK, BASTION, JET, NOCTURNE, GUNBOAT].map(boxes =>
  [boxes, Math.max(...boxes.map(b => Math.hypot(b.x, b.y, b.z) + Math.hypot(b.hx, b.hy, b.hz)))]));
function geometry(type: number, variant: number): readonly HullBox[] {
  if (variant === VEHICLE_VARIANT.RAIL) return EMPTY;
  if (type === VEHICLE.JEEP) return JEEP;
  if (type === VEHICLE.TANK) return variant === VEHICLE_VARIANT.BASTION ? BASTION : TANK;
  if (type === VEHICLE.JET) return variant === VEHICLE_VARIANT.NOCTURNE ? NOCTURNE : JET;
  return type === VEHICLE.GUNBOAT ? GUNBOAT : EMPTY;
}

const CELL = 32;
const MAX_HULLS = 512;
// Much larger than the playable world; avoids non-progressing grid indices
// from corrupted finite coordinates beyond integer precision.
const MAX_COORDINATE = 1e7;
/** Prediction may bridge at most 100ms of missing poses; never drift forever. */
export const VEHICLE_COLLISION_EXTRAPOLATION_TICKS = 6;
interface PreparedHull {
  id: number; tick: number; x: number; y: number; z: number; vx: number; vy: number; vz: number;
  boxes: readonly HullBox[]; radius: number; cells: string[];
  minCellX: number; maxCellX: number; minCellZ: number; maxCellZ: number;
  heading: number; pitch: number; roll: number;
  quaternion: boolean; qx: number; qy: number; qz: number; qw: number;
  // Rotation columns: dotting them with world displacement gives local XYZ.
  xx: number; xy: number; xz: number; yx: number; yy: number; yz: number; zx: number; zy: number; zz: number;
}
interface ActiveHull { hull: PreparedHull; x: number; y: number; z: number; beforeX: number; beforeY: number; beforeZ: number }

function hullDistance(active: ActiveHull, x: number, y: number, z: number, best: number, before = false): number {
  const h = active.hull, dx = x - (before ? active.beforeX : active.x),
    dy = y - (before ? active.beforeY : active.y), dz = z - (before ? active.beforeZ : active.z);
  const lx = dx * h.xx + dy * h.xy + dz * h.xz;
  const ly = dx * h.yx + dy * h.yy + dz * h.yz;
  const lz = dx * h.zx + dy * h.zy + dz * h.zz;
  for (const b of h.boxes) {
    const bx = lx - b.x, bz = lz - b.z;
    const qx = Math.abs(bx * b.c - bz * b.s) - b.hx;
    if (qx >= best) continue;
    const qy = Math.abs(ly - b.y) - b.hy;
    if (qy >= best) continue;
    const qz = Math.abs(bx * b.s + bz * b.c) - b.hz;
    if (qz >= best) continue;
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0), az = Math.max(qz, 0);
    const d = Math.sqrt(ax * ax + ay * ay + az * az) + Math.min(Math.max(qx, qy, qz), 0);
    if (d < best) best = d;
  }
  return best;
}

/** A single pedestrian's broad phase. No global hull scan occurs in sdf(). */
export class VehicleCollisionSelection {
  constructor(readonly hulls: readonly ActiveHull[]) {}
  distance(x: number, y: number, z: number, best: number): number {
    for (const hull of this.hulls) best = hullDistance(hull, x, y, z, best);
    return best;
  }
  carry(state: KinState): void {
    if (!state.grounded || state.vy > .5) return;
    for (const h of this.hulls) {
      const dx = h.x - h.beforeX, dy = h.y - h.beforeY, dz = h.z - h.beforeZ;
      if (Math.abs(dx) + Math.abs(dy) + Math.abs(dz) < 1e-9) continue;
      // Standing feet must straddle this hull's old top surface. A nearby
      // side panel cannot attach a pedestrian who is standing on terrain.
      if (hullDistance(h, state.px, state.py - .08, state.pz, Infinity, true) <= 0 &&
          hullDistance(h, state.px, state.py + .06, state.pz, Infinity, true) > 0) {
        state.px += dx; state.py += dy; state.pz += dz;
        return;
      }
    }
  }
}

/** Immutable poses, spatially indexed once when replication/authority updates. */
export class VehicleCollisionField {
  private readonly hulls = new Map<number, PreparedHull>();
  private readonly cells = new Map<string, Set<number>>();
  get size(): number { return this.hulls.size; }
  clear(): void { this.hulls.clear(); this.cells.clear(); }
  replace(tick: number, poses: Iterable<VehicleColliderPose>): void {
    const seen = new Set<number>();
    for (const pose of poses) { seen.add(pose.id); this.update(tick, pose); }
    for (const id of this.hulls.keys()) if (!seen.has(id)) this.remove(id);
  }
  remove(id: number): void {
    const old = this.hulls.get(id); if (!old) return;
    for (const key of old.cells) { const cell = this.cells.get(key)!; cell.delete(id); if (!cell.size) this.cells.delete(key); }
    this.hulls.delete(id);
  }
  update(tick: number, pose: VehicleColliderPose): void {
    if (!(pose.health > 0) || (pose.respawnAtTick ?? -1) >= 0 || pose.transportRoute !== undefined ||
        !Number.isFinite(pose.id + tick + pose.x + pose.y + pose.z + pose.heading) ||
        Math.max(Math.abs(pose.x), Math.abs(pose.y), Math.abs(pose.z)) > MAX_COORDINATE) {
      this.remove(pose.id); return;
    }
    const boxes = geometry(pose.type, validVehicleVariant(pose.type, pose.variant));
    if (!boxes.length) { this.remove(pose.id); return; }
    const old = this.hulls.get(pose.id);
    const pitch = Number.isFinite(pose.pitch) ? pose.pitch! : 0;
    const roll = Number.isFinite(pose.roll) ? pose.roll! : 0;
    const quaternion = !!pose.rotation;
    const qx = pose.rotation ? pose.rotation.x : 0, qy = pose.rotation ? pose.rotation.y : 0,
      qz = pose.rotation ? pose.rotation.z : 0, qw = pose.rotation ? pose.rotation.w : 1;
    const sameOrientation = old && old.quaternion === quaternion && (quaternion
      ? old.qx === qx && old.qy === qy && old.qz === qz && old.qw === qw
      : old.heading === pose.heading && old.pitch === pitch && old.roll === roll);
    const vx = Number.isFinite(pose.vx) ? clamp(pose.vx!, -300, 300) : 0;
    const vy = Number.isFinite(pose.vy) ? clamp(pose.vy!, -300, 300) : 0;
    const vz = Number.isFinite(pose.vz) ? clamp(pose.vz!, -300, 300) : 0;
    // Preserve the bounded field's update/eviction order without tearing down
    // the spatial index. An unchanged parked pose has no clock extrapolation,
    // so its immutable record can serve every subsequent authority snapshot.
    if (old) this.hulls.delete(pose.id);
    else if (this.hulls.size >= MAX_HULLS) this.remove(this.hulls.keys().next().value!);
    if (sameOrientation && old.boxes === boxes && old.x === pose.x && old.y === pose.y && old.z === pose.z &&
        old.vx === vx && old.vy === vy && old.vz === vz &&
        (old.tick === tick || vx === 0 && vy === 0 && vz === 0)) {
      this.hulls.set(pose.id, old); return;
    }
    const radius = RADII.get(boxes)!;
    const horizon = VEHICLE_COLLISION_EXTRAPOLATION_TICKS / TICK_RATE;
    const rx = radius + Math.abs(vx) * horizon, rz = radius + Math.abs(vz) * horizon;
    const minCellX = Math.floor((pose.x - rx) / CELL), maxCellX = Math.floor((pose.x + rx) / CELL);
    const minCellZ = Math.floor((pose.z - rz) / CELL), maxCellZ = Math.floor((pose.z + rz) / CELL);
    const sameCells = old && old.minCellX === minCellX && old.maxCellX === maxCellX &&
      old.minCellZ === minCellZ && old.maxCellZ === maxCellZ;
    const q = sameOrientation ? undefined : pose.rotation ? normalizeRotation({ ...pose.rotation }) :
      rotationFromEuler(pose.heading, pitch, roll);
    const h: PreparedHull = { id: pose.id, tick, x: pose.x, y: pose.y, z: pose.z, vx, vy, vz, boxes, radius,
      cells: sameCells ? old.cells : [], minCellX, maxCellX, minCellZ, maxCellZ,
      heading: pose.heading, pitch, roll, quaternion, qx, qy, qz, qw,
      xx: q ? 1 - 2 * (q.y * q.y + q.z * q.z) : old!.xx,
      xy: q ? 2 * (q.x * q.y + q.z * q.w) : old!.xy,
      xz: q ? 2 * (q.x * q.z - q.y * q.w) : old!.xz,
      yx: q ? 2 * (q.x * q.y - q.z * q.w) : old!.yx,
      yy: q ? 1 - 2 * (q.x * q.x + q.z * q.z) : old!.yy,
      yz: q ? 2 * (q.y * q.z + q.x * q.w) : old!.yz,
      zx: q ? 2 * (q.x * q.z + q.y * q.w) : old!.zx,
      zy: q ? 2 * (q.y * q.z - q.x * q.w) : old!.zy,
      zz: q ? 1 - 2 * (q.x * q.x + q.y * q.y) : old!.zz };
    // A moving hull gets a new record so earlier selections retain their
    // exact pose. Most such updates still occupy the same 32 m grid cells.
    if (!sameCells) {
      if (old) for (const key of old.cells) {
        const cell = this.cells.get(key)!; cell.delete(old.id); if (!cell.size) this.cells.delete(key);
      }
      for (let ix = minCellX; ix <= maxCellX; ix++) for (let iz = minCellZ; iz <= maxCellZ; iz++) {
        const key = `${ix},${iz}`; h.cells.push(key);
        let cell = this.cells.get(key); if (!cell) this.cells.set(key, cell = new Set()); cell.add(h.id);
      }
    }
    this.hulls.set(h.id, h);
  }
  select(state: KinState, dt: number, tick: number): VehicleCollisionSelection | undefined {
    if (!this.hulls.size || !Number.isFinite(state.px + state.py + state.pz + state.vx + state.vy + state.vz + tick + dt) ||
        Math.max(Math.abs(state.px), Math.abs(state.py), Math.abs(state.pz)) > MAX_COORDINATE) return undefined;
    // Cover any legal acceleration/jump/hyperspeed direction in this step,
    // plus contact recovery and lift/vehicle carry, without per-probe lookup.
    const reach = Math.min(300, Math.max(PLAYER.RUN_SPEED * 10 + 40, Math.hypot(state.vx, state.vy, state.vz))) * clamp(dt, 0, .1) + 3;
    const ids = new Set<number>(), nearby: ActiveHull[] = [];
    for (let ix = Math.floor((state.px - reach) / CELL); ix <= Math.floor((state.px + reach) / CELL); ix++)
      for (let iz = Math.floor((state.pz - reach) / CELL); iz <= Math.floor((state.pz + reach) / CELL); iz++)
        for (const id of this.cells.get(`${ix},${iz}`) ?? []) ids.add(id);
    // Pose arrival/driver processing order can differ during replay. If two
    // overlapping roofs can both carry the player, use the same hull on each.
    for (const id of [...ids].sort((a, b) => a - b)) {
      const h = this.hulls.get(id)!;
      const now = clamp(tick - h.tick, -6, 6) / TICK_RATE;
      const before = clamp(tick - dt * TICK_RATE - h.tick, -6, 6) / TICK_RATE;
      const x = h.x + h.vx * now, y = h.y + h.vy * now, z = h.z + h.vz * now;
      if (Math.abs(x - state.px) > h.radius + reach || Math.abs(z - state.pz) > h.radius + reach ||
          Math.abs(y - state.py) > h.radius + reach + PLAYER.HEIGHT) continue;
      nearby.push({ hull: h, x, y, z, beforeX: h.x + h.vx * before, beforeY: h.y + h.vy * before, beforeZ: h.z + h.vz * before });
    }
    return nearby.length ? new VehicleCollisionSelection(nearby) : undefined;
  }
}

export function setVehicleColliders(world: World, tick: number, poses: Iterable<VehicleColliderPose>): void {
  (world.vehicleCollisions ??= new VehicleCollisionField()).replace(tick, poses);
}
export function updateVehicleCollider(world: World, tick: number, pose: VehicleColliderPose): void {
  (world.vehicleCollisions ??= new VehicleCollisionField()).update(tick, pose);
}
export function clearVehicleColliders(world: World): void { world.vehicleCollisions?.clear(); }

/** Scope safe-exit/placement probes without leaking hulls into world traces. */
export function withVehicleColliders<T>(world: World, state: KinState & { simulationTick?: number }, dt: number, callback: () => T): T {
  const previous = world.pedestrianCollisions;
  world.pedestrianCollisions = world.vehicleCollisions?.select(state, dt, state.simulationTick ?? (world.motionTime ?? 0) * TICK_RATE);
  try { return callback(); } finally { world.pedestrianCollisions = previous; }
}
