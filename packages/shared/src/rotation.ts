import { clamp } from './math.js';

/** Unit quaternion; shared by simulation, snapshots and render interpolation. */
export interface Rotation { x: number; y: number; z: number; w: number }
export interface VehicleOrientation {
  heading: number; vehiclePitch?: number; vehicleRoll?: number; vehicleRotation?: Rotation;
}
const fresh = (): Rotation => ({ x: 0, y: 0, z: 0, w: 1 });

export function normalizeRotation(q: Rotation): Rotation {
  const length = Math.hypot(q.x, q.y, q.z, q.w);
  if (!Number.isFinite(length) || length < 1e-12) {
    q.x = q.y = q.z = 0; q.w = 1;
  } else { q.x /= length; q.y /= length; q.z /= length; q.w /= length; }
  return q;
}

/** Same YXZ convention used by vehicle meshes and their legacy fixtures. */
export function rotationFromEuler(heading: number, pitch = 0, roll = 0, out = fresh()): Rotation {
  const c1 = Math.cos(pitch / 2), c2 = Math.cos(heading / 2), c3 = Math.cos(roll / 2);
  const s1 = Math.sin(pitch / 2), s2 = Math.sin(heading / 2), s3 = Math.sin(roll / 2);
  out.x = s1 * c2 * c3 + c1 * s2 * s3;
  out.y = c1 * s2 * c3 - s1 * c2 * s3;
  out.z = c1 * c2 * s3 - s1 * s2 * c3;
  out.w = c1 * c2 * c3 + s1 * s2 * s3;
  return out;
}

/** Safe when the output aliases either input. Composition applies b then a. */
export function multiplyRotations(a: Rotation, b: Rotation, out = fresh()): Rotation {
  const x = a.x * b.w + a.w * b.x + a.y * b.z - a.z * b.y;
  const y = a.y * b.w + a.w * b.y + a.z * b.x - a.x * b.z;
  const z = a.z * b.w + a.w * b.z + a.x * b.y - a.y * b.x;
  const w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  out.x = x; out.y = y; out.z = z; out.w = w;
  return out;
}

export function rotateVector(q: Rotation, x: number, y: number, z: number,
  out = { x: 0, y: 0, z: 0 }): { x: number; y: number; z: number } {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  out.x = x + q.w * tx + q.y * tz - q.z * ty;
  out.y = y + q.w * ty + q.z * tx - q.x * tz;
  out.z = z + q.w * tz + q.x * ty - q.y * tx;
  return out;
}

export function vehicleQuaternion(state: VehicleOrientation): Rotation {
  return state.vehicleRotation ?? rotationFromEuler(state.heading, state.vehiclePitch ?? 0, state.vehicleRoll ?? 0);
}

/** Angles are a derived compatibility view, never the flight integrator. */
export function rotationToEuler(q: Rotation): { heading: number; vehiclePitch: number; vehicleRoll: number } {
  const m13 = 2 * (q.x * q.z + q.w * q.y), m23 = 2 * (q.y * q.z - q.w * q.x);
  const m33 = 1 - 2 * (q.x * q.x + q.y * q.y);
  const horizontal = Math.hypot(m13, m33);
  return {
    heading: horizontal > 1e-10 ? Math.atan2(m13, m33)
      : Math.atan2(-2 * (q.x * q.z - q.w * q.y), 1 - 2 * (q.y * q.y + q.z * q.z)),
    vehiclePitch: Math.atan2(-m23, horizontal),
    vehicleRoll: horizontal > 1e-10 ? Math.atan2(2 * (q.x * q.y + q.w * q.z), 1 - 2 * (q.x * q.x + q.z * q.z)) : 0,
  };
}

/** Shortest spherical interpolation remains smooth across all Euler poles. */
export function slerpRotations(a: Rotation, b: Rotation, t: number, out = fresh()): Rotation {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  const sign = dot < 0 ? -1 : 1; dot = Math.abs(dot);
  let ka = 1 - t, kb = t;
  if (dot < 0.9995) {
    const angle = Math.acos(clamp(dot, -1, 1)), denominator = Math.sin(angle);
    ka = Math.sin((1 - t) * angle) / denominator; kb = Math.sin(t * angle) / denominator;
  }
  out.x = ka * a.x + kb * b.x * sign; out.y = ka * a.y + kb * b.y * sign;
  out.z = ka * a.z + kb * b.z * sign; out.w = ka * a.w + kb * b.w * sign;
  return normalizeRotation(out);
}
