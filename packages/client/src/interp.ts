import {
  angleLerp, ENT_PLAYER, ENT_PROJECTILE, TICK_RATE, weaponDefById,
  VEHICLE, vehicleQuaternion, rotationToEuler, slerpRotations, type Rotation, type Snapshot,
} from '@shared/index';

// Remote entities are rendered a few ticks in the past, interpolated between
// the two snapshots bracketing the render time - the standard recipe for
// smooth remote movement at 30 snapshots/sec.

interface PSnap { tick: number; x: number; y: number; z: number; yaw: number; pitch: number; dead: boolean; grounded: boolean; weapon: number; vehicle: number; vehicleVariant?: number; seat?: number; station?: number; vehicleId?: number; heading: number; vehiclePitch: number; vehicleRoll: number; vehicleRotation?: Rotation }
interface ProjectileSnap {
  tick: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  owner: number;
  weapon: number;
}

export interface PlayerView { id: number; x: number; y: number; z: number; yaw: number; pitch: number; dead: boolean; grounded: boolean; weapon: number; vehicle: number; vehicleVariant?: number; seat?: number; station?: number; vehicleId?: number; heading: number; vehiclePitch?: number; vehicleRoll?: number; vehicleRotation?: Rotation; vx: number; vy: number; vz: number }
export interface ProjectileView {
  id: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  owner: number;
  weapon: number;
  ageTicks: number;
}

const BUF_CAP = 40;

export class Interp {
  private players = new Map<number, PSnap[]>();
  private projectiles = new Map<number, { born: number; buf: ProjectileSnap[] }>();

  push(snap: Snapshot): void {
    const seen = new Set<number>();
    const seenProjectiles = new Set<number>();
    for (const e of snap.ents) {
      if (e.kind === ENT_PLAYER) {
        seen.add(e.id);
        let buf = this.players.get(e.id);
        if (!buf) { buf = []; this.players.set(e.id, buf); }
        buf.push({ tick: snap.tick, x: e.x, y: e.y, z: e.z, yaw: e.yaw, pitch: e.pitch, dead: e.dead, grounded: e.grounded, weapon: e.weapon, vehicle: e.vehicle, vehicleVariant: e.vehicleVariant ?? 0, seat: e.seat ?? 0, station: e.station, vehicleId: e.vehicleId, heading: e.heading, vehiclePitch: e.vehiclePitch ?? 0, vehicleRoll: e.vehicleRoll ?? 0,
          vehicleRotation: e.vehicle === VEHICLE.JET ? { ...vehicleQuaternion(e) } : undefined });
        if (buf.length > BUF_CAP) buf.shift();
      } else if (e.kind === ENT_PROJECTILE) {
        seenProjectiles.add(e.id);
        let p = this.projectiles.get(e.id);
        if (!p) { p = { born: snap.tick, buf: [] }; this.projectiles.set(e.id, p); }
        p.buf.push({
          tick: snap.tick,
          x: e.x, y: e.y, z: e.z,
          vx: e.vx, vy: e.vy, vz: e.vz,
          owner: e.owner,
          weapon: e.weapon,
        });
        if (p.buf.length > BUF_CAP) p.buf.shift();
      }
    }
    // Entities that left the snapshot stop receiving data and expire in gc().
    void seen; void seenProjectiles;
  }

  /** Wipe an entity's history (respawn teleport). */
  reset(id: number): void {
    this.players.delete(id);
  }

  clearAll(): void {
    this.players.clear();
    this.projectiles.clear();
  }

  samplePlayers(renderTick: number): PlayerView[] {
    const out: PlayerView[] = [];
    for (const [id, buf] of this.players) {
      const v = sampleBuf(buf, renderTick);
      if (v) out.push({ id, ...v });
    }
    return out;
  }

  sampleProjectiles(renderTick: number): ProjectileView[] {
    const out: ProjectileView[] = [];
    for (const [id, p] of this.projectiles) {
      const buf = p.buf;
      if (buf.length === 0) continue;
      // A projectile has a real birth tick, unlike a continuously-existing
      // player. While the delayed render clock is still before its first
      // replicated sample, keep it hidden instead of rendering the newest
      // position and later snapping backward to the oldest one.
      if (renderTick < buf[0].tick) continue;
      const last = buf[buf.length - 1];
      if (renderTick - last.tick > 6) continue; // exploded / expired
      let x = last.x, y = last.y, z = last.z;
      let vx = last.vx, vy = last.vy, vz = last.vz;
      // Bracket authoritative samples where possible. Past the newest sample,
      // extrapolate using the projectile's gravity so grenades retain their arc
      // across the normal snapshot/interpolation delay.
      for (let i = buf.length - 2; i >= 0; i--) {
        const a = buf[i], b = buf[i + 1];
        if (a.tick <= renderTick && renderTick <= b.tick) {
          const t = (renderTick - a.tick) / Math.max(1e-6, b.tick - a.tick);
          x = a.x + (b.x - a.x) * t;
          y = a.y + (b.y - a.y) * t;
          z = a.z + (b.z - a.z) * t;
          vx = a.vx + (b.vx - a.vx) * t;
          vy = a.vy + (b.vy - a.vy) * t;
          vz = a.vz + (b.vz - a.vz) * t;
          break;
        }
        if (b.tick < renderTick) {
          const dtb = (renderTick - b.tick) / TICK_RATE;
          // Resting grenades are replicated with an exact zero velocity. The
          // server intentionally stops integrating them, so do not make the
          // client sink them into the floor between snapshots.
          const resting = b.vx === 0 && b.vy === 0 && b.vz === 0;
          const gravity = resting ? 0 : (weaponDefById(b.weapon)?.gravity ?? 0);
          x = b.x + b.vx * dtb;
          y = b.y + b.vy * dtb - 0.5 * gravity * dtb * dtb;
          z = b.z + b.vz * dtb;
          vx = b.vx;
          vy = b.vy - gravity * dtb;
          vz = b.vz;
          break;
        }
      }
      out.push({
        id, x, y, z, vx, vy, vz,
        owner: last.owner,
        weapon: last.weapon,
        ageTicks: renderTick - p.born,
      });
    }
    return out;
  }

  /** Drop an exploded projectile before the next snapshot retires it. */
  removeProjectile(id: number): void {
    this.projectiles.delete(id);
  }

  gc(renderTick: number): void {
    for (const [id, buf] of this.players) {
      if (buf.length === 0 || renderTick - buf[buf.length - 1].tick > 90) this.players.delete(id);
    }
    for (const [id, p] of this.projectiles) {
      if (p.buf.length === 0 || renderTick - p.buf[p.buf.length - 1].tick > 30) this.projectiles.delete(id);
    }
  }
}

function sampleBuf(buf: PSnap[], renderTick: number):
  | Omit<PlayerView, 'id'>
  | null {
  if (buf.length === 0) return null;
  const newest = buf[buf.length - 1];
  if (renderTick - newest.tick > 90) return null; // left interest range

  if (renderTick >= newest.tick) {
    const vel = velBetween(buf.length >= 2 ? buf[buf.length - 2] : newest, newest);
    return { x: newest.x, y: newest.y, z: newest.z, yaw: newest.yaw, pitch: newest.pitch, dead: newest.dead, grounded: newest.grounded, weapon: newest.weapon, vehicle: newest.vehicle, vehicleVariant: newest.vehicleVariant ?? 0, seat: newest.seat ?? 0, station: newest.station, vehicleId: newest.vehicleId, heading: newest.heading, vehiclePitch: newest.vehiclePitch, vehicleRoll: newest.vehicleRoll, vehicleRotation: newest.vehicleRotation, ...vel };
  }
  for (let i = buf.length - 2; i >= 0; i--) {
    const a = buf[i], b = buf[i + 1];
    if (a.tick <= renderTick && renderTick <= b.tick) {
      const span = Math.max(1e-6, b.tick - a.tick);
      // Teleport guard: don't lerp across respawns.
      const jump = Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + Math.abs(b.z - a.z);
      if (jump > 20 || a.vehicle !== b.vehicle || (a.seat ?? 0) !== (b.seat ?? 0) || a.vehicleId !== b.vehicleId) return { x: b.x, y: b.y, z: b.z, yaw: b.yaw, pitch: b.pitch, dead: b.dead, grounded: b.grounded, weapon: b.weapon, vehicle: b.vehicle, vehicleVariant: b.vehicleVariant ?? 0, seat: b.seat ?? 0, station: b.station, vehicleId: b.vehicleId, heading: b.heading, vehiclePitch: b.vehiclePitch, vehicleRoll: b.vehicleRoll, vehicleRotation: b.vehicleRotation, vx: 0, vy: 0, vz: 0 };
      const t = (renderTick - a.tick) / span;
      const vehicleRotation = b.vehicle === VEHICLE.JET
        ? a.vehicle === VEHICLE.JET ? slerpRotations(vehicleQuaternion(a), vehicleQuaternion(b), t) : vehicleQuaternion(b)
        : undefined;
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
        yaw: angleLerp(a.yaw, b.yaw, t),
        pitch: a.pitch + (b.pitch - a.pitch) * t,
        dead: b.dead,
        // Contact is discrete. Keep the state belonging to this render time;
        // don't anticipate a jump or landing from the future endpoint.
        grounded: t < 1 ? a.grounded : b.grounded,
        weapon: b.weapon,
        vehicle: b.vehicle, vehicleVariant: b.vehicleVariant ?? 0, seat: b.seat ?? 0, station: b.station, vehicleId: b.vehicleId,
        heading: angleLerp(a.heading, b.heading, t),
        vehiclePitch: a.vehiclePitch + (b.vehiclePitch - a.vehiclePitch) * t,
        vehicleRoll: angleLerp(a.vehicleRoll, b.vehicleRoll, t),
        ...(vehicleRotation ? { ...rotationToEuler(vehicleRotation), vehicleRotation } : {}),
        ...velBetween(a, b),
      };
    }
  }
  const oldest = buf[0];
  return { x: oldest.x, y: oldest.y, z: oldest.z, yaw: oldest.yaw, pitch: oldest.pitch, dead: oldest.dead, grounded: oldest.grounded, weapon: oldest.weapon, vehicle: oldest.vehicle, vehicleVariant: oldest.vehicleVariant ?? 0, seat: oldest.seat ?? 0, station: oldest.station, vehicleId: oldest.vehicleId, heading: oldest.heading, vehiclePitch: oldest.vehiclePitch, vehicleRoll: oldest.vehicleRoll, vehicleRotation: oldest.vehicleRotation, vx: 0, vy: 0, vz: 0 };
}

/**
 * Finite-difference velocity between two snapshots (m/s). Player entities
 * don't replicate velocity, but vehicle hull attitude (nose following the
 * fall, banking) needs one - this estimate is plenty for a cosmetic tilt.
 */
function velBetween(a: PSnap, b: PSnap): { vx: number; vy: number; vz: number } {
  const span = b.tick - a.tick;
  if (span <= 0) return { vx: 0, vy: 0, vz: 0 };
  const jump = Math.abs(b.x - a.x) + Math.abs(b.y - a.y) + Math.abs(b.z - a.z);
  if (jump > 20) return { vx: 0, vy: 0, vz: 0 }; // respawn teleport
  const k = TICK_RATE / span;
  return { vx: (b.x - a.x) * k, vy: (b.y - a.y) * k, vz: (b.z - a.z) * k };
}
