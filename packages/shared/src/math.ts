export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export function len3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Two numeric arguments only: scaled, ordered Math.hypot arithmetic without
 * the temporary argument array used by Node 22's generic builtin. The first
 * Kahan compensation is zero and the final compensation is unused for two
 * terms. Keep Infinity before NaN and return positive zero for either sign.
 * This is not a replacement for Math.hypot's variadic/coercion contract. */
export function hypot2(x: number, y: number): number {
  const a = Math.abs(x), b = Math.abs(y);
  if (a === Infinity || b === Infinity) return Infinity;
  if (a !== a || b !== b) return NaN;
  const max = a > b ? a : b;
  if (max === 0) return 0;
  const an = a / max, bn = b / max;
  return Math.sqrt(an * an + bn * bn) * max;
}

/** Wrap an angle to [-PI, PI). */
export function wrapAngle(a: number): number {
  a = a % TAU;
  if (a >= Math.PI) a -= TAU;
  if (a < -Math.PI) a += TAU;
  return a;
}

/** Interpolate angles along the shortest arc. */
export function angleLerp(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

// ---- Wire quantization ---------------------------------------------------
// Inputs are quantized on the client BEFORE being fed to the local predicted
// simulation, so client and server run the movement code with bit-identical
// view angles.

export function quantYaw(yaw: number): number {
  const n = ((yaw % TAU) + TAU) % TAU;
  return Math.round((n / TAU) * 65536) & 0xffff;
}

export function unquantYaw(q: number): number {
  return (q / 65536) * TAU;
}

const HALF_PI = Math.PI / 2;

export function quantPitch(pitch: number): number {
  return Math.round(clamp(pitch, -HALF_PI, HALF_PI) / HALF_PI * 32767) | 0;
}

export function unquantPitch(q: number): number {
  return (q / 32767) * HALF_PI;
}

/**
 * View direction from yaw/pitch, matching a three.js camera with euler order
 * 'YXZ' (rotation.y = yaw, rotation.x = pitch). Yaw 0 looks down -Z.
 */
export function viewDir(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** Camera-right vector for a given yaw (pitch does not affect it in YXZ). */
export function rightDir(yaw: number): { x: number; z: number } {
  return { x: Math.cos(yaw), z: -Math.sin(yaw) };
}
