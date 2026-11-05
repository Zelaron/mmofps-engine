import * as THREE from 'three';
import type { CreatureState } from '@shared/index';
import type { V3 } from './creature-geometry.js';

const TAU = Math.PI * 2;
export const clamp01 = (x: number) => x < 0 ? 0 : x > 1 ? 1 : x;
/** Exact at both ends, so settled poses (corpses) are bit-identical frame to frame. */
export const lerp = (a: number, b: number, t: number) => t <= 0 ? a : t >= 1 ? b : a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const frac = (x: number) => x - Math.floor(x);
/** Deterministic 0..1 hash for per-creature variety (idle timing, look targets). */
export const hash01 = (a: number, b = 0) => { const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453; return s - Math.floor(s); };

/** Client-side presentation state for one creature; never sent anywhere. */
export interface CreatureTrack {
  target: CreatureState;
  x: number; y: number; z: number; yaw: number;
  /** Gait phase in radians, advanced only by displayed travel (never wrapped). */
  phase: number;
  /** Smoothed displayed ground speed (m/s), locomotion weight, yaw rate, slope. */
  speed: number; move: number; turn: number; climb: number;
  alert: number; windup: number; strike: number; strikeTime: number; cast: number;
  /** Seconds since the collapse began; -1 while alive. */
  dead: number; side: number;
  time: number; seed: number; scale: number;
  lookYaw: number; lookPitch: number;
  tail: number; tailVelocity: number; tail2: number;
  winding: boolean;
}

export interface GaitRig {
  walkSpeed: number; runSpeed: number;
  walkStride: number; runStride: number;
  walkDuty: number; runDuty: number;
  walkLift: number; runLift: number;
  walkBob: number; runBob: number;
  walkPitch: number; runPitch: number;
  walkRoll: number; runRoll: number;
  /** Lateral weight shift over the stance foot (bipeds). */
  sway: number;
  runLean: number;
  /** Sprinting heel kick: the swing foot folds up behind before driving forward. */
  kick?: number;
  /** Longest planted-foot sweep the legs can reach (set from the rig). */
  reach?: number;
}
export interface LegRig {
  /** Hip/shoulder joint in body (or pelvis) space. */
  hip: V3;
  /** Neutral foot contact (x, z) in root space; the ground is y = 0. */
  foot: readonly [number, number];
  upper: number; lower: number; ankle: number;
  /** Knee bend direction and segment facing, body space. */
  hint: V3; face?: V3;
  walk: number; run: number;
  thick?: number; lift?: number;
  /** Dead: foot direction from the hip (body space; x mirrors with the fall
   * side), outward splay by the leg's own side, and reach fraction. */
  limp: V3; limpOut?: number; limpReach?: number;
}

// ---- Scratch math: nothing below allocates per frame. ----------------------
const _m = new THREE.Matrix4(), _m2 = new THREE.Matrix4(), _basis = new THREE.Matrix4();
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _hip = new THREE.Vector3(), _knee = new THREE.Vector3(), _end = new THREE.Vector3();
const _target = new THREE.Vector3(), _dead = new THREE.Vector3(), _hint = new THREE.Vector3(), _face = new THREE.Vector3();
const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();

// Hot helpers write matrix elements directly instead of calling scalar
// three.js setters, so optimized code keeps intermediate numbers unboxed.
/** out = parent · T(p) · R(yaw, pitch, roll as YXZ, matching THREE.Euler 'YXZ'). */
export function child(out: THREE.Matrix4, parent: THREE.Matrix4, px: number, py: number, pz: number,
  pitch = 0, yaw = 0, roll = 0): THREE.Matrix4 {
  const a = Math.cos(pitch), b = Math.sin(pitch), c = Math.cos(yaw), d = Math.sin(yaw), e = Math.cos(roll), f = Math.sin(roll);
  const ce = c * e, cf = c * f, de = d * e, df = d * f, m = _m.elements;
  m[0] = ce + df * b; m[4] = de * b - cf; m[8] = a * d; m[12] = px;
  m[1] = a * f; m[5] = a * e; m[9] = -b; m[13] = py;
  m[2] = cf * b - de; m[6] = df + ce * b; m[10] = a * c; m[14] = pz;
  m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
  return out.multiplyMatrices(parent, _m);
}
/** out = m · S (a leaf scale; parents stay rigid so instancing normals stay valid). */
export function scaled(out: THREE.Matrix4, m: THREE.Matrix4, sx: number, sy: number, sz: number): THREE.Matrix4 {
  out.copy(m);
  const o = out.elements;
  o[0] *= sx; o[1] *= sx; o[2] *= sx; o[4] *= sy; o[5] *= sy; o[6] *= sy; o[8] *= sz; o[9] *= sz; o[10] *= sz;
  return out;
}

/** Analytic two-bone IK in root space. Writes the knee and reachable end. */
function solveIk(hip: THREE.Vector3, target: THREE.Vector3, upper: number, lower: number, hint: THREE.Vector3,
  knee: THREE.Vector3, end: THREE.Vector3): void {
  let ux = target.x - hip.x, uy = target.y - hip.y, uz = target.z - hip.z;
  const distance = Math.sqrt(ux * ux + uy * uy + uz * uz);
  if (distance < 1e-6) { ux = 0; uy = -1; uz = 0; } else { ux /= distance; uy /= distance; uz /= distance; }
  const reach = Math.min(Math.max(distance, Math.abs(upper - lower) + 1e-3), (upper + lower) * .9995);
  end.x = hip.x + ux * reach; end.y = hip.y + uy * reach; end.z = hip.z + uz * reach;
  const along = (upper * upper - lower * lower + reach * reach) / (2 * reach);
  const height = Math.sqrt(Math.max(0, upper * upper - along * along));
  const dot = hint.x * ux + hint.y * uy + hint.z * uz;
  let wx = hint.x - ux * dot, wy = hint.y - uy * dot, wz = hint.z - uz * dot;
  let w = wx * wx + wy * wy + wz * wz;
  if (w < 1e-8) { wx = ux * uz; wy = uy * uz; wz = uz * uz - 1; w = wx * wx + wy * wy + wz * wz || 1; }
  w = height / Math.sqrt(w);
  knee.x = hip.x + ux * along + wx * w; knee.y = hip.y + uy * along + wy * w; knee.z = hip.z + uz * along + wz * w;
}

/** Segment whose geometry runs along local -Y from `a` to `b`; local -Z faces `face`. */
function segment(out: THREE.Matrix4, root: THREE.Matrix4, a: THREE.Vector3, b: THREE.Vector3, face: THREE.Vector3,
  nominal: number, thick: number): THREE.Matrix4 {
  let yx = a.x - b.x, yy = a.y - b.y, yz = a.z - b.z;
  const length = Math.sqrt(yx * yx + yy * yy + yz * yz) || 1e-6;
  yx /= length; yy /= length; yz /= length;
  const dot = face.x * yx + face.y * yy + face.z * yz;
  let zx = yx * dot - face.x, zy = yy * dot - face.y, zz = yz * dot - face.z;
  let z = zx * zx + zy * zy + zz * zz;
  if (z < 1e-8) { zx = -yx * yz; zy = -yy * yz; zz = 1 - yz * yz; z = zx * zx + zy * zy + zz * zz || 1; }
  z = 1 / Math.sqrt(z); zx *= z; zy *= z; zz *= z;
  const xx = yy * zz - yz * zy, xy = yz * zx - yx * zz, xz = yx * zy - yy * zx, sy = length / nominal, m = _basis.elements;
  m[0] = xx * thick; m[1] = xy * thick; m[2] = xz * thick; m[3] = 0;
  m[4] = yx * sy; m[5] = yy * sy; m[6] = yz * sy; m[7] = 0;
  m[8] = zx * thick; m[9] = zy * thick; m[10] = zz * thick; m[11] = 0;
  m[12] = a.x; m[13] = a.y; m[14] = a.z; m[15] = 1;
  return out.multiplyMatrices(root, _basis);
}

// ---- Gait --------------------------------------------------------------------
/** Per-frame gait parameters for the creature being posed. */
export const gaitNow = { blend: 0, duty: .6, stride: 1, excursion: .5, lift: .1, u: 0, move: 0, kick: 0, drop: 0 };
const gaitBlend = (gait: GaitRig, speed: number) => smooth(gait.walkSpeed * 1.35, gait.runSpeed, speed);
/** Metres (rig units) per gait cycle. Stance can never sweep further than the
 * legs reach, so beyond that limit cadence rises instead and feet stay planted. */
export function strideLength(gait: GaitRig, speed: number): number {
  const length = speed <= gait.walkSpeed ? gait.walkStride * (.55 + .45 * clamp01(speed / gait.walkSpeed))
    : speed <= gait.runSpeed ? lerp(gait.walkStride, gait.runStride, (speed - gait.walkSpeed) / (gait.runSpeed - gait.walkSpeed))
      : gait.runStride * (1 + .3 * clamp01((speed - gait.runSpeed) / gait.runSpeed));
  return gait.reach ? Math.min(length, gait.reach / lerp(gait.walkDuty, gait.runDuty, gaitBlend(gait, speed))) : length;
}
function updateGait(t: CreatureTrack, gait: GaitRig, live: number): void {
  const g = gaitBlend(gait, t.speed);
  gaitNow.blend = g;
  gaitNow.duty = lerp(gait.walkDuty, gait.runDuty, g);
  gaitNow.stride = strideLength(gait, t.speed);
  gaitNow.excursion = gaitNow.duty * gaitNow.stride;
  gaitNow.lift = lerp(gait.walkLift, gait.runLift, g) * clamp01(.45 + .55 * t.speed / gait.walkSpeed);
  gaitNow.u = t.phase / TAU;
  gaitNow.move = t.move * live;
  gaitNow.kick = (gait.kick ?? 0) * g;
}
/** Planted-foot curve: stance slides back exactly with body travel; swing arcs forward. */
const foot = { dz: 0, y: 0, pitch: 0, stance: 0 };
function footCurve(u: number, duty: number, excursion: number, lift: number, kick: number): void {
  if (u < duty) {
    const s = u / duty;
    foot.dz = (s - .5) * excursion; foot.y = 0; foot.stance = 1;
    foot.pitch = -.35 * smooth(.72, 1, s);
  } else {
    const s = (u - duty) / (1 - duty), e = s * s * (3 - 2 * s);
    foot.dz = (.5 - e) * excursion + kick * excursion * .35 * Math.sin(Math.PI * Math.min(1, s * 1.6)) * (1 - s); foot.stance = 0;
    foot.y = lift * Math.sin(Math.PI * Math.pow(s, .8 - kick * .25));
    foot.pitch = -.7 * Math.sin(Math.PI * Math.min(1, s * 1.25)) * (1 - s * .4);
  }
}
/** Death easing: knees buckle first, then the body topples and settles. */
export const deathNow = { buckle: 0, topple: 0, limp: 0 };
function updateDeath(t: CreatureTrack, seconds: number): void {
  if (t.dead < 0) { deathNow.buckle = deathNow.topple = deathNow.limp = 0; return; }
  const p = clamp01(t.dead / seconds);
  deathNow.buckle = smooth(0, .35, p);
  const fall = clamp01((p - .12) / .88);
  // Gravity-like acceleration with a small settle at the end.
  deathNow.topple = Math.min(1, fall * fall * (1.9 - .9 * fall) + .05 * Math.sin(Math.PI * smooth(.82, 1, p)) * (p < 1 ? 1 : 0));
  deathNow.limp = smooth(.1, .75, p);
}

/** Shared leg solve: planted gait foot, IK, and a limp body-space target when dead. */
/** p = M · (x, y, z, w) written component-wise (w = 1 point, 0 direction). */
function transform(out: THREE.Vector3, m: THREE.Matrix4, x: number, y: number, z: number, w: number): THREE.Vector3 {
  const e = m.elements;
  out.x = e[0] * x + e[4] * y + e[8] * z + e[12] * w;
  out.y = e[1] * x + e[5] * y + e[9] * z + e[13] * w;
  out.z = e[2] * x + e[6] * y + e[10] * z + e[14] * w;
  return out;
}
function poseLeg(out: THREE.Matrix4[], slots: readonly number[], root: THREE.Matrix4, body: THREE.Matrix4, leg: LegRig,
  t: CreatureTrack, offset: number, extraLift: number, crouchForward: number): void {
  const hip = leg.hip;
  transform(_hip, body, hip[0], hip[1], hip[2], 1);
  footCurve(frac(gaitNow.u + offset), gaitNow.duty, gaitNow.excursion, gaitNow.lift * (leg.lift ?? 1), gaitNow.kick);
  const move = gaitNow.move;
  _target.x = leg.foot[0]; _target.y = leg.ankle + (foot.y + extraLift) * move; _target.z = leg.foot[1] + foot.dz * move + crouchForward;
  let pitch = foot.pitch * move;
  const limp = deathNow.limp;
  if (limp > 0) {
    // Legs on the upper side of a rolled corpse droop onto the ones below.
    const side = Math.sign(hip[0]), upperSide = side === t.side ? 1 : .1;
    let dx = leg.limp[0] * t.side * upperSide + side * (leg.limpOut ?? 0), dy = leg.limp[1], dz = leg.limp[2];
    const scale = (leg.upper + leg.lower) * (leg.limpReach ?? .86) / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
    dx = hip[0] + dx * scale; dy = hip[1] + dy * scale; dz = hip[2] + dz * scale;
    transform(_dead, body, dx, dy, dz, 1);
    _target.x += (_dead.x - _target.x) * limp; _target.y += (_dead.y - _target.y) * limp; _target.z += (_dead.z - _target.z) * limp;
    pitch *= 1 - limp;
  }
  transform(_hint, body, leg.hint[0], leg.hint[1], leg.hint[2], 0);
  const face = leg.face;
  if (face) transform(_face, body, face[0], face[1], face[2], 0); else transform(_face, body, 0, 0, -1, 0);
  solveIk(_hip, _target, leg.upper, leg.lower, _hint, _knee, _end);
  const thick = leg.thick ?? 1;
  segment(out[slots[0]], root, _hip, _knee, _face, leg.upper, thick);
  segment(out[slots[1]], root, _knee, _end, _face, leg.lower, thick);
  if (slots.length > 2) {
    // Feet stay level with the ground (plus toe roll) while alive and follow
    // the lower leg once limp, so hooves never dig in or float off the shin.
    const m = _m2.elements;
    if (limp > 0) {
      _e.set(pitch, 0, 0, 'YXZ'); _q.setFromEuler(_e);
      _y.subVectors(_knee, _end).normalize();
      _z.copy(_face).addScaledVector(_y, -_face.dot(_y)).negate().normalize(); _x.crossVectors(_y, _z);
      _basis.makeBasis(_x, _y, _z); _q2.setFromRotationMatrix(_basis);
      _q.slerp(_q2, limp);
      _m2.makeRotationFromQuaternion(_q);
    } else {
      const c = Math.cos(pitch), s = Math.sin(pitch);
      m[0] = 1; m[1] = 0; m[2] = 0; m[4] = 0; m[5] = c; m[6] = s; m[8] = 0; m[9] = -s; m[10] = c;
      m[3] = 0; m[7] = 0; m[11] = 0; m[15] = 1;
    }
    m[12] = _end.x; m[13] = _end.y; m[14] = _end.z;
    scaled(out[slots[2]], out[slots[2]].multiplyMatrices(root, _m2), thick, 1, thick);
  }
}

// ---- Shared idle helpers -------------------------------------------------------
/** Occasional deterministic look-around; returns the target yaw for this moment. */
function lookTarget(t: CreatureTrack, range: number, period: number): number {
  const bucket = Math.floor((t.time + t.seed * 7) / period);
  const roll = hash01(t.seed * 31 + bucket, 3.7);
  return roll < .35 ? 0 : (hash01(bucket, t.seed * 13) - .5) * 2 * range;
}
function ease(current: number, target: number, rate: number, dt: number): number {
  return current + (target - current) * (1 - Math.exp(-rate * dt));
}
/** Head look, tail spring and blends that need dt; called before posing. */
export function animateTrackSecondary(t: CreatureTrack, dt: number, look: { range: number; period: number; rate: number }): void {
  if (t.dead >= 0) return; // Corpses keep their last look and tail; the collapse blends to rest.
  const moving = t.move > .3 || t.alert > .5 || t.dead >= 0;
  t.lookYaw = ease(t.lookYaw, moving ? clampAbs(t.turn * .25, .4) : lookTarget(t, look.range, look.period), look.rate, dt);
  const bucket = Math.floor((t.time + t.seed * 5) / (look.period * 1.3));
  t.lookPitch = ease(t.lookPitch, moving ? 0 : (hash01(bucket, t.seed + 9) - .5) * .5, look.rate * .7, dt);
  // Tail: a damped spring chasing turn-induced lag plus a slow sway.
  const goal = clampAbs(t.turn * .35, .7) + Math.sin(t.time * 1.7 + t.seed * 6) * .12 * (1 - t.move * .5);
  t.tailVelocity += ((goal - t.tail) * 30 - t.tailVelocity * 7) * dt;
  t.tail += t.tailVelocity * dt;
  t.tail2 = ease(t.tail2, t.tail, 6, dt);
}
const clampAbs = (x: number, limit: number) => x < -limit ? -limit : x > limit ? limit : x;

// ---- Archetypes -----------------------------------------------------------------
interface RigBase {
  gait: GaitRig;
  legs: LegRig[];
  deathSeconds: number;
  /** Body/pelvis rest height per collapse variant, calibrated from geometry
   * so corpses rest on the ground (see deathVariant). */
  deadDrop: [number, number];
  look: { range: number; period: number; rate: number };
  scale: number;
}
export interface QuadrupedRig extends RigBase {
  kind: 'quadruped';
  body: { y: number; z: number; breath: number };
  neck: { at: V3; pitch: number; length: number };
  head: { pitch: number; alert: number; grazes?: boolean };
  tail: { at: V3; pitch: number; length: number; segments: number; alert: number; run: number };
  crouch: number; predator?: boolean;
}
export interface BirdRig extends RigBase {
  kind: 'bird';
  body: { y: number; z: number; pitch: number; breath: number };
  neck: { at: V3; pitch: number; length: number; bend: number; segments: number };
  head: { pitch: number };
  tail: { at: V3; pitch: number; length: number };
}
export interface ArthropodRig extends RigBase {
  kind: 'arthropod';
  /** Insects and spiders die on their backs; armoured crawlers slump flat. */
  flip: boolean;
  body: { y: number; z: number; breath: number };
  head: { at: V3; pitch: number };
  abdomen?: { at: V3; pitch: number; bob: number };
  claws?: { at: V3; upper: number; lower: number; spread: number; raise: number };
  tail?: { at: V3; segments: number; length: number; curl: number; stinger: boolean };
}
export interface HumanoidRig extends RigBase {
  kind: 'humanoid';
  pelvis: { y: number; lean: number; breath: number };
  torso: { at: V3; lean: number; length: number };
  head: { at: V3; pitch: number; roll: number };
  arms: { at: V3; upper: number; lower: number; reach: number; hang: number; swing: number; asymmetry: number; spread: number };
  style: 'shamble' | 'sprint' | 'brute' | 'giant';
  windupLift: number;
}
export type CreatureRig = QuadrupedRig | BirdRig | ArthropodRig | HumanoidRig;
/** Humanoids fall forward or back by id; animals roll onto either side. */
export const deathVariant = (rig: CreatureRig, t: CreatureTrack) => rig.kind === 'humanoid' ? (t.seed > .5 ? 1 : 0) : t.side > 0 ? 1 : 0;

/** Instanced part types and slot layout in pose order. */
export interface PartLayout { name: string; instances: number }
export function partLayout(rig: CreatureRig): PartLayout[] {
  const legs = rig.legs.length;
  switch (rig.kind) {
    case 'quadruped': return [{ name: 'body', instances: 1 }, { name: 'neck', instances: 1 }, { name: 'head', instances: 1 },
      { name: 'tail', instances: rig.tail.segments }, { name: 'upper', instances: legs }, { name: 'lower', instances: legs }, { name: 'foot', instances: legs }];
    case 'bird': return [{ name: 'body', instances: 1 }, { name: 'neck', instances: rig.neck.segments }, { name: 'head', instances: 1 },
      { name: 'tail', instances: 1 }, { name: 'upper', instances: legs }, { name: 'lower', instances: legs }, { name: 'foot', instances: legs }];
    case 'arthropod': return [{ name: 'body', instances: 1 }, { name: 'head', instances: 1 },
      ...(rig.abdomen ? [{ name: 'abdomen', instances: 1 }] : []),
      ...(rig.tail ? [{ name: 'tail', instances: rig.tail.segments }, ...(rig.tail.stinger ? [{ name: 'stinger', instances: 1 }] : [])] : []),
      ...(rig.claws ? [{ name: 'arm', instances: 2 }, { name: 'claw', instances: 2 }] : []),
      { name: 'upper', instances: legs }, { name: 'lower', instances: legs }];
    case 'humanoid': return [{ name: 'pelvis', instances: 1 }, { name: 'torso', instances: 1 }, { name: 'head', instances: 1 },
      { name: 'arm', instances: 2 }, { name: 'forearm', instances: 2 }, { name: 'upper', instances: 2 }, { name: 'lower', instances: 2 }, { name: 'foot', instances: 2 }];
  }
}
export function slotBases(layout: readonly PartLayout[]): Record<string, number> {
  const bases: Record<string, number> = {}; let next = 0;
  for (const part of layout) { bases[part.name] = next; next += part.instances; }
  return bases;
}

/** Pose context reused for every creature of one species. */
export class RigPoser {
  readonly layout: PartLayout[];
  readonly slots: number;
  private readonly base: Record<string, number>;
  private readonly legSlots: number[][];
  private readonly body = new THREE.Matrix4();
  /** Body (or pelvis) relative to the creature root; legs solve in this space. */
  private readonly local = new THREE.Matrix4();
  private readonly joint = new THREE.Matrix4();
  private readonly joint2 = new THREE.Matrix4();
  private readonly joint3 = new THREE.Matrix4();
  constructor(readonly rig: CreatureRig) {
    this.layout = partLayout(rig);
    this.base = slotBases(this.layout);
    this.slots = this.layout.reduce((sum, part) => sum + part.instances, 0);
    const feet = this.base.foot;
    this.legSlots = rig.legs.map((_leg, i) => feet === undefined ? [this.base.upper + i, this.base.lower + i]
      : [this.base.upper + i, this.base.lower + i, feet + i]);
    // Leg reach constants: a moving body sinks just enough for its stance sweep
    // to stay reachable, and stride length is capped at an 18% crouch.
    const bodyY = rig.kind === 'humanoid' ? rig.pelvis.y : rig.body.y;
    this.legFit = rig.legs.map(leg => ({ height: bodyY + leg.hip[1] - leg.ankle, reach: (leg.upper + leg.lower) * .995,
      side: leg.foot[0] - leg.hip[0], offset: Math.abs(leg.foot[1] - leg.hip[2]) }));
    rig.gait.reach = Math.max(.1, Math.min(...this.legFit.map(fit =>
      2 * (Math.sqrt(Math.max(0, fit.reach * fit.reach - Math.pow(fit.height * .82, 2) - fit.side * fit.side)) - fit.offset) * .95)));
  }
  private readonly legFit: { height: number; reach: number; side: number; offset: number }[];
  /** How far the body must sink so every planted foot can reach its stance sweep. */
  private stanceDrop(): number {
    const half = gaitNow.excursion * .5;
    let drop = 0;
    for (let i = 0; i < this.legFit.length; i++) {
      const fit = this.legFit[i], along = half + fit.offset;
      const need = fit.height - Math.sqrt(Math.max(0, fit.reach * fit.reach - fit.side * fit.side - along * along));
      if (need > drop) drop = need;
    }
    return drop * gaitNow.move;
  }

  /** Writes every part matrix (world space) into out[0..slots). */
  pose(t: CreatureTrack, root: THREE.Matrix4, out: THREE.Matrix4[]): void {
    const rig = this.rig;
    updateDeath(t, rig.deathSeconds);
    updateGait(t, rig.gait, 1 - deathNow.buckle);
    gaitNow.drop = this.stanceDrop();
    switch (rig.kind) {
      case 'quadruped': this.quadruped(rig, t, root, out); break;
      case 'bird': this.bird(rig, t, root, out); break;
      case 'arthropod': this.arthropod(rig, t, root, out); break;
      case 'humanoid': this.humanoid(rig, t, root, out); break;
    }
  }

  private legs(rig: RigBase, t: CreatureTrack, root: THREE.Matrix4, body: THREE.Matrix4, out: THREE.Matrix4[], crouchForward = 0, liftAll = 0): void {
    const g = gaitNow.blend;
    for (let i = 0; i < rig.legs.length; i++) {
      const leg = rig.legs[i];
      poseLeg(out, this.legSlots[i], root, body, leg, t, lerp(leg.walk, leg.run, g), liftAll, crouchForward);
    }
  }

  private quadruped(rig: QuadrupedRig, t: CreatureTrack, root: THREE.Matrix4, out: THREE.Matrix4[]): void {
    const gait = rig.gait, g = gaitNow.blend, move = gaitNow.move, u = gaitNow.u, d = deathNow;
    const alert = t.alert * (1 - d.buckle), live = 1 - d.topple;
    // Walk: two bobs per cycle; gallop: one big heave with nose-up push-off.
    const walkBob = Math.cos(TAU * (u * 2 + .1)), runBob = Math.cos(TAU * (u + .15));
    const bob = move * lerp(gait.walkBob * walkBob, gait.runBob * runBob, g);
    const pitch = move * lerp(gait.walkPitch * Math.sin(TAU * u * 2), gait.runPitch * Math.sin(TAU * (u + .05)), g)
      - move * g * gait.runLean + t.climb * .55 * live;
    const crouch = alert * rig.crouch * (rig.predator ? 1 : -.3);
    const breath = d.topple > 0 ? 0 : Math.sin(t.time * 2.1 + t.seed * 9) * rig.body.breath;
    const y = lerp(rig.body.y + bob - crouch - gaitNow.drop - d.buckle * rig.body.y * .22, rig.deadDrop[deathVariant(rig, t)], d.topple);
    const roll = clampAbs(t.turn * t.speed * .05, .2) * live + t.side * Math.PI / 2 * d.topple;
    child(this.local, IDENTITY, 0, y, rig.body.z, pitch * live - d.buckle * .12 * (1 - d.topple), 0, roll);
    this.body.multiplyMatrices(root, this.local);
    scaled(out[this.base.body], this.body, 1 + breath * .6, 1 + breath, 1);
    this.legs(rig, t, root, this.local, out, rig.predator ? -crouch * .2 : 0);
    // Neck and head: the head is stabilized against body pitch and bob.
    const graze = rig.head.grazes && t.move < .2 && t.alert < .3 && d.topple === 0
      ? smooth(.2, .45, frac((t.time + t.seed * 23) / 13)) * (1 - smooth(.78, .95, frac((t.time + t.seed * 23) / 13))) : 0;
    const neckPitch = lerp(rig.neck.pitch + alert * (rig.predator ? -.35 : .25) - graze * (rig.neck.pitch + .75)
      - move * g * .25 + t.lookPitch * .4, .15, d.topple);
    const neckYaw = lerp(t.lookYaw * .55, t.side * .14, d.topple);
    child(this.joint, this.body, rig.neck.at[0], rig.neck.at[1], rig.neck.at[2], neckPitch, neckYaw, 0);
    out[this.base.neck].copy(this.joint);
    const chew = graze > .8 ? Math.sin(t.time * 9) * .05 : 0;
    const headWorld = rig.head.pitch + alert * rig.head.alert - graze * .45 + chew + t.lookPitch * .5
      - bob * .6 - move * g * .15;
    const headPitch = lerp(headWorld - (pitch + neckPitch), -.1, d.topple);
    child(this.joint2, this.joint, 0, 0, -rig.neck.length, headPitch, lerp(t.lookYaw * .45, t.side * .08, d.topple), 0);
    out[this.base.head].copy(this.joint2);
    // Tail: lagging spring sway, raised when alert or running, limp when dead.
    const tail = rig.tail, segments = tail.segments, segment = tail.length / segments;
    let tailPitch = lerp(tail.pitch - alert * tail.alert - move * g * tail.run + Math.sin(TAU * u * 2) * .08 * move, .05, d.topple);
    let tailYaw = lerp(t.tail, -t.side * .1, d.topple);
    child(this.joint3, this.body, tail.at[0], tail.at[1], tail.at[2], tailPitch, tailYaw, 0);
    out[this.base.tail].copy(this.joint3);
    for (let i = 1; i < segments; i++) {
      tailPitch = lerp(.12 + move * .1, .05, d.topple); tailYaw = lerp(t.tail2 * 1.4 - t.tail * .6, -t.side * .06, d.topple);
      child(this.joint3, this.joint3, 0, 0, segment, tailPitch, tailYaw, 0);
      out[this.base.tail + i].copy(this.joint3);
    }
  }

  private bird(rig: BirdRig, t: CreatureTrack, root: THREE.Matrix4, out: THREE.Matrix4[]): void {
    const gait = rig.gait, g = gaitNow.blend, move = gaitNow.move, u = gaitNow.u, d = deathNow;
    const alert = t.alert * (1 - d.buckle), live = 1 - d.topple;
    const step = Math.cos(TAU * (u * 2 + .15));
    const bob = move * lerp(gait.walkBob, gait.runBob, g) * step;
    const sway = move * gait.sway * Math.sin(TAU * u) * (1 - g * .6);
    const pitch = rig.body.pitch - move * g * gait.runLean + move * lerp(gait.walkPitch, gait.runPitch, g) * Math.sin(TAU * u * 2)
      + t.climb * .4 * live + alert * .12;
    const roll = move * lerp(gait.walkRoll, gait.runRoll, g) * Math.sin(TAU * u) + clampAbs(t.turn * t.speed * .04, .25) * live;
    const breath = d.topple > 0 ? 0 : Math.sin(t.time * 2.6 + t.seed * 9) * rig.body.breath;
    const y = lerp(rig.body.y + bob - gaitNow.drop - d.buckle * rig.body.y * .3 + alert * .04, rig.deadDrop[deathVariant(rig, t)], d.topple);
    child(this.local, IDENTITY, sway * live, y, rig.body.z, lerp(pitch, 0, d.topple), 0, roll * live + t.side * Math.PI / 2 * d.topple);
    this.body.multiplyMatrices(root, this.local);
    scaled(out[this.base.body], this.body, 1 + breath, 1 + breath, 1);
    this.legs(rig, t, root, this.local, out);
    // S-curved neck: the bend spreads over several segments so it reads as one
    // smooth curve; the head bobs forward and back like a striding bird.
    const headBob = move * Math.sin(TAU * u * 2 + 1.2) * .22 * (1 - g * .5);
    const neckPitch = lerp(rig.neck.pitch + alert * .2 - move * g * .55 + headBob * .5 + t.lookPitch * .3, .1, d.topple);
    const segments = rig.neck.segments, share = 1 / (segments - 1);
    child(this.joint, this.body, rig.neck.at[0], rig.neck.at[1], rig.neck.at[2], neckPitch, lerp(t.lookYaw * .5, t.side * .2, d.topple) * share, 0);
    out[this.base.neck].copy(this.joint);
    const bend = lerp(rig.neck.bend - headBob + move * g * .35, .1, d.topple);
    for (let i = 1; i < segments; i++) {
      child(this.joint, this.joint, 0, 0, -rig.neck.length, bend * share, lerp(t.lookYaw * .4, t.side * .1, d.topple) * share, 0);
      out[this.base.neck + i].copy(this.joint);
    }
    const headPitch = lerp(rig.head.pitch - (pitch + neckPitch + bend) + t.lookPitch * .6, 0, d.topple);
    child(this.joint2, this.joint, 0, 0, -rig.neck.length, headPitch, t.lookYaw * .3 * live, 0);
    out[this.base.head].copy(this.joint2);
    const tailPitch = lerp(rig.tail.pitch + move * g * .45 + Math.sin(TAU * u * 2) * .06 * move - alert * .25, 0, d.topple);
    child(this.joint3, this.body, rig.tail.at[0], rig.tail.at[1], rig.tail.at[2], tailPitch, t.tail * .8 * live, 0);
    out[this.base.tail].copy(this.joint3);
  }

  private arthropod(rig: ArthropodRig, t: CreatureTrack, root: THREE.Matrix4, out: THREE.Matrix4[]): void {
    const gait = rig.gait, g = gaitNow.blend, move = gaitNow.move, u = gaitNow.u, d = deathNow;
    const alert = t.alert * (1 - d.buckle), wind = t.windup * (1 - d.buckle), live = 1 - d.topple;
    // Tripod scuttle: small fast bob twice per cycle and a body yaw wiggle.
    const bob = move * lerp(gait.walkBob, gait.runBob, g) * Math.cos(TAU * u * 2);
    const wiggle = move * lerp(gait.walkRoll, gait.runRoll, g) * Math.sin(TAU * u);
    const breath = d.topple > 0 ? 0 : Math.sin(t.time * 1.6 + t.seed * 9) * rig.body.breath;
    const raise = alert * .06 + wind * .1;
    const y = lerp(rig.body.y + bob + raise - gaitNow.drop - d.buckle * rig.body.y * .45, rig.deadDrop[deathVariant(rig, t)], d.topple);
    const pitch = (t.climb * .5 + wind * .22 + alert * .05 - move * g * gait.runLean) * live;
    child(this.local, IDENTITY, 0, y, rig.body.z, pitch * (1 - d.topple), wiggle * live, t.side * (rig.flip ? Math.PI : .16) * d.topple);
    this.body.multiplyMatrices(root, this.local);
    scaled(out[this.base.body], this.body, 1 + breath, 1 + breath, 1 + breath * .5);
    this.legs(rig, t, root, this.local, out);
    // Head and mandibles probe; a scorpion tail sways and arches with tension.
    child(this.joint, this.body, rig.head.at[0], rig.head.at[1], rig.head.at[2],
      rig.head.pitch + alert * .15 + t.lookPitch * .4 - wind * .2 + d.topple * (rig.flip ? -.7 : .25), t.lookYaw * .6 * live, 0);
    out[this.base.head].copy(this.joint);
    if (rig.abdomen) {
      const a = rig.abdomen;
      child(this.joint2, this.body, a.at[0], a.at[1], a.at[2], a.pitch + bob * a.bob * 6 + alert * .12 + Math.sin(t.time * 2 + t.seed) * .03 * live
        + d.topple * .25, -t.tail * .5 * live, 0);
      out[this.base.abdomen].copy(this.joint2);
    }
    if (rig.tail) {
      const tail = rig.tail, segment = tail.length / tail.segments;
      child(this.joint2, this.body, tail.at[0], tail.at[1], tail.at[2], lerp(-tail.curl * (.75 + alert * .35 + wind * .3), .12, d.topple), t.tail * .6 * live, 0);
      out[this.base.tail].copy(this.joint2);
      for (let i = 1; i < tail.segments; i++) {
        const curl = lerp(-tail.curl * (.9 + alert * .25 + wind * .35) + Math.sin(t.time * 2.2 - i * .7 + t.seed) * .05, .02 - i * .04, d.topple);
        child(this.joint2, this.joint2, 0, 0, segment, curl, (t.tail2 - t.tail) * .5 * live, 0);
        out[this.base.tail + i].copy(this.joint2);
      }
      if (tail.stinger) {
        child(this.joint2, this.joint2, 0, 0, segment, lerp(-.7 - wind * .5 + t.strike * 1.2, .1, d.topple), 0, 0);
        out[this.base.stinger].copy(this.joint2);
      }
    }
    if (rig.claws) {
      const c = rig.claws;
      for (let side = -1; side <= 1; side += 2) {
        const index = side < 0 ? 0 : 1;
        const swing = move * Math.sin(TAU * (u + (side < 0 ? 0 : .5))) * .18;
        const snap = Math.max(0, Math.sin(t.time * 3 + side + t.seed * 5)) * .2 * alert;
        const lift = c.raise * (alert * .45 + wind) - d.limp * .4;
        child(this.joint, this.body, side * c.at[0], c.at[1], c.at[2], lerp(.35 + lift + swing, -.12, d.limp), side * -(c.spread + alert * .15 - wind * .2 + d.limp * .3), side * .2);
        out[this.base.arm + index].copy(this.joint);
        child(this.joint2, this.joint, 0, 0, -c.upper, lerp(-.75 - lift * .6 + snap - t.strike * .8, .08, d.limp), side * (.55 + wind * .3), 0);
        out[this.base.claw + index].copy(this.joint2);
      }
    }
  }

  private humanoid(rig: HumanoidRig, t: CreatureTrack, root: THREE.Matrix4, out: THREE.Matrix4[]): void {
    const gait = rig.gait, g = gaitNow.blend, move = gaitNow.move, u = gaitNow.u, d = deathNow;
    const alert = t.alert * (1 - d.buckle), strike = t.strike * (1 - d.buckle), live = 1 - d.topple;
    // A boss charging a ranged bolt reuses the overhead wind-up silhouette.
    const wind = Math.max(t.windup, t.cast * .75) * (1 - d.buckle);
    const style = rig.style;
    // Step-synced bob: lowest just after each heel strike; heavy styles stomp.
    const stepWave = Math.cos(TAU * (u * 2 - .12));
    const heavy = style === 'brute' || style === 'giant';
    const stomp = heavy ? Math.pow(Math.max(0, -stepWave), 3) : 0;
    const bob = move * (lerp(gait.walkBob, gait.runBob, g) * stepWave - stomp * gait.walkBob * 1.5);
    const sway = move * gait.sway * Math.sin(TAU * u);
    const lurch = style === 'shamble' ? move * Math.max(0, Math.sin(TAU * u)) * .09 : 0;
    const roll = move * lerp(gait.walkRoll, gait.runRoll, g) * Math.sin(TAU * u) + lurch;
    const crouch = alert * (style === 'sprint' ? .1 : .04) * (1 - move * .8) + wind * .1 - strike * .05;
    const breath = d.topple > 0 ? 0 : Math.sin(t.time * (heavy ? 1.3 : 2) + t.seed * 9) * rig.pelvis.breath;
    // Fall direction: shamblers crumple forward, the rest topple back or forward by id.
    const fall = (t.seed > .5 ? 1 : -1) * d.topple, legLength = rig.legs[0].upper + rig.legs[0].lower;
    const pelvisY = lerp(rig.pelvis.y + bob - crouch - gaitNow.drop - d.buckle * rig.pelvis.y * .3, rig.deadDrop[deathVariant(rig, t)], d.topple);
    const pelvisPitch = (rig.pelvis.lean + alert * .05) * live + fall * Math.PI / 2 * .97;
    const twist = move * Math.sin(TAU * u) * .12 * live;
    // Falling back lands the pelvis behind the feet with legs forward; forward the reverse.
    child(this.local, IDENTITY, sway * live, pelvisY, fall * legLength * .72, pelvisPitch, twist, roll * live);
    this.body.multiplyMatrices(root, this.local);
    out[this.base.pelvis].copy(this.body);
    this.legs(rig, t, root, this.local, out, 0);
    // Torso: lean, counter-twist, breathing; wind-up rears back, the strike folds forward.
    const lean = rig.torso.lean + move * g * gait.runLean + alert * .08 - wind * (rig.windupLift ? .45 : .15) + strike * .55
      + (style === 'shamble' ? Math.sin(TAU * u * 2) * .05 * move : 0) - bob * .4;
    child(this.joint, this.body, rig.torso.at[0], rig.torso.at[1], rig.torso.at[2], -lean * live, -twist * 1.8 + t.lookYaw * .3 * live,
      -roll * .6 * live + (style === 'shamble' ? .08 * live : 0));
    scaled(out[this.base.torso], this.joint, 1 + breath, 1 + breath * .4, 1 + breath);
    const loll = style === 'shamble' ? Math.sin(t.time * 1.1 + t.seed * 4) * .14 + .22 : 0;
    child(this.joint2, this.joint, rig.head.at[0], rig.head.at[1], rig.head.at[2],
      lerp(rig.head.pitch + lean * .6 - alert * .15 + t.lookPitch * .4 - wind * .2, .3, d.topple), lerp(t.lookYaw * .7, t.side * .6, d.topple),
      lerp(rig.head.roll + loll + roll * .5, t.side * .3, d.topple));
    out[this.base.head].copy(this.joint2);
    // Arms: walk counter-swing, reaching shamble, pumping sprint, overhead wind-up and slam.
    const arms = rig.arms;
    for (let side = -1; side <= 1; side += 2) {
      const index = side < 0 ? 0 : 1, other = side < 0 ? 0 : .5;
      const swing = move * arms.swing * Math.sin(TAU * (u + other + .5)) * lerp(1, 1.6, g);
      const asym = side > 0 ? arms.asymmetry : -arms.asymmetry * .5;
      const reach = arms.reach * (1 + alert * .12) + asym + Math.sin(t.time * 1.3 + side + t.seed * 3) * .06 * (style === 'shamble' ? 1 : .3);
      const overhead = wind * (rig.windupLift || 0);
      const slam = strike * 2.4;
      // Hanging arms keep to gravity while walking; at a run they pump with the torso.
      let pitch = reach + swing + overhead - slam * (overhead > 0 || rig.windupLift ? 1 : .4) + lean * .8 * (1 - g);
      pitch = lerp(pitch * live, side * .1, d.topple);
      const spread = arms.spread + alert * .1 + wind * .15 + d.limp * 1.1;
      child(this.joint3, this.joint, side * arms.at[0], arms.at[1], arms.at[2], pitch, 0, side * spread);
      scaled(out[this.base.arm + index], this.joint3, 1, 1, 1);
      const elbow = lerp(arms.hang + (style === 'sprint' ? g * .7 : 0) + alert * .2 - wind * .3 + Math.max(0, swing) * .3, .2, d.limp);
      child(this.joint3, this.joint3, 0, -arms.upper, 0, elbow, 0, 0);
      out[this.base.forearm + index].copy(this.joint3);
    }
  }
}
