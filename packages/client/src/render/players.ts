import * as THREE from 'three';
import { FACTIONS, type Faction } from '@shared/frontier';
import { PLAYER, VEHICLE, mulberry32, vehicleQuaternion, aircraftCrewMuzzle, type Rotation } from '@shared/index';
import type { PlayerView } from '../interp.js';
import { buildVehicleHull, buildCrewWeapon, trainArtilleryModel, aimVehicleWeapon, vehicleMuzzlePosition, flashVehicleWeapon, vehicleAttitude, updateVehicleHull, disposeVehicleHull } from './vehicles.js';
import { cloneWorldWeapon, weaponGripPoints } from './weapon-models.js';
const HULL_PARENT_ROTATION = new THREE.Quaternion();

// Each articulated body part is a single vertex-colored mesh. Equipment,
// seams, fingers and armor bevels share that draw; 24 deterministic uniforms
// share geometry across the entire session, including respawns.
const BODY_COLORS = [
  0xbc5148, 0x477ba9, 0x528d67, 0xb89b43, 0x8b5b9e, 0x458d97,
  0xb77742, 0x819849, 0xa85c7b, 0x727fad, 0xaa9774, 0x5d9d8e,
];
const SKIN_TONES = [0xe3b991, 0xc88c63, 0xa96e4d, 0x794a32, 0x563526, 0xf0ccb0];
const PANTS_COLORS = [0x39414b, 0x514b3e, 0x36483f, 0x4b4038, 0x41404d, 0x3e4c58];
const BODY_MATERIAL = new THREE.MeshLambertMaterial({ vertexColors: true });
const BOX = new THREE.BoxGeometry().toNonIndexed();
const BEVEL = chamferedBox();
const BALL = new THREE.SphereGeometry(1, 12, 8).toNonIndexed();
const TAPER = new THREE.CylinderGeometry(0.43, 0.5, 1, 10).toNonIndexed();
const PARTS = new Map<string, THREE.BufferGeometry>();

/** Forty-four triangles retain shaped plate edges without a dense box grid. */
function chamferedBox(): THREE.BufferGeometry {
  const positions: number[] = [], normals: number[] = [];
  const q = 0.38;
  const face = (points: THREE.Vector3[]): void => {
    const normal = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0])).normalize();
    const center = points.reduce((sum, point) => sum.add(point), new THREE.Vector3());
    if (normal.dot(center) < 0) { points.reverse(); normal.negate(); }
    for (let i = 1; i < points.length - 1; i++) {
      for (const point of [points[0], points[i], points[i + 1]]) {
        positions.push(point.x, point.y, point.z);
        normals.push(normal.x, normal.y, normal.z);
      }
    }
  };
  for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    face([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) =>
      new THREE.Vector3().setComponent(axis, sign * .5).setComponent(u, a * q).setComponent(v, b * q)));
  }
  for (let a = 0; a < 3; a++) for (let b = a + 1; b < 3; b++) {
    const c = 3 - a - b;
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
      face([[.5, q, -q], [.5, q, q], [q, .5, q], [q, .5, -q]].map(([x, y, z]) =>
        new THREE.Vector3().setComponent(a, x * sa).setComponent(b, y * sb).setComponent(c, z)));
    }
  }
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    face([new THREE.Vector3(x * .5, y * q, z * q), new THREE.Vector3(x * q, y * .5, z * q), new THREE.Vector3(x * q, y * q, z * .5)]);
  }
  return new THREE.BufferGeometry()
    .setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    .setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
}

/** Bake parts into one mesh, preserving smooth normals and per-part colors. */
class Part {
  private readonly p: number[] = [];
  private readonly n: number[] = [];
  private readonly c: number[] = [];
  private readonly shapes: [THREE.BufferGeometry, number, number, number, number, number, number, number, number, number, number][] = [];
  shape(geo: THREE.BufferGeometry, color: number, sx: number, sy: number, sz: number,
    x: number, y: number, z: number, rx = 0, ry = 0, rz = 0): this {
    this.shapes.push([geo, color, sx, sy, sz, x, y, z, rx, ry, rz]);
    return this;
  }
  private bake(geo: THREE.BufferGeometry, color: number, sx: number, sy: number, sz: number,
    x: number, y: number, z: number, rx: number, ry: number, rz: number): void {
    const matrix = new THREE.Matrix4().compose(
      new THREE.Vector3(x, y, z),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)),
      new THREE.Vector3(sx, sy, sz),
    );
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const position = geo.getAttribute('position'), normal = geo.getAttribute('normal');
    const vertex = new THREE.Vector3(), direction = new THREE.Vector3();
    const shade = new THREE.Color(color);
    for (let i = 0; i < position.count; i++) {
      vertex.fromBufferAttribute(position, i).applyMatrix4(matrix);
      direction.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize();
      this.p.push(vertex.x, vertex.y, vertex.z);
      this.n.push(direction.x, direction.y, direction.z);
      this.c.push(shade.r, shade.g, shade.b);
    }
  }
  box(color: number, sx: number, sy: number, sz: number, x: number, y: number, z: number,
    bevel = false, rx = 0, ry = 0, rz = 0): this {
    return this.shape(bevel ? BEVEL : BOX, color, sx, sy, sz, x, y, z, rx, ry, rz);
  }
  ball(color: number, sx: number, sy: number, sz: number, x: number, y: number, z: number): this {
    return this.shape(BALL, color, sx, sy, sz, x, y, z);
  }
  finish(key: string): THREE.Mesh {
    let geometry = PARTS.get(key);
    if (!geometry) {
      for (const shape of this.shapes) this.bake(...shape);
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
      geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      PARTS.set(key, geometry);
    }
    const mesh = new THREE.Mesh(geometry, BODY_MATERIAL);
    mesh.name = key.slice(key.indexOf(':') + 1);
    return mesh;
  }
}

interface Arm {
  upper: THREE.Group;
  forearm: THREE.Group;
  hand: THREE.Group;
  side: number;
}

export interface Rig {
  group: THREE.Group;
  hips: THREE.Group;
  legL: THREE.Group; kneeL: THREE.Group; footL: THREE.Group;
  legR: THREE.Group; kneeR: THREE.Group; footR: THREE.Group;
  torso: THREE.Group;
  aim: THREE.Group;
  head: THREE.Group;
  gunMount: THREE.Group;
  arms: Arm[];
  phase: number;
  air: number;
  idleT: number;
  lastWeapon: number;
  run: number;
  landing: number;
  offGroundT: number;
  previousGrounded: boolean;
  previousVy: number;
  moveYaw: number;
  bodyYaw: number;
  moving: boolean;
  backward: boolean;
  lastX: number;
  lastY: number;
  lastZ: number;
  bulk: number;
  torsoHeight: number;
}

const UPPER_LEG = 0.435, LOWER_LEG = 0.405;
const HIP_HEIGHT = 0.92;
const ANKLE_HEIGHT = 0.085;

/** Articulated field armor, fitted fatigues and practical equipment. */
export function buildRig(id: number): Rig {
  const variant = ((id % 24) + 24) % 24;
  const rng = mulberry32(((variant + 1) * 2654435761) >>> 0);
  const jacket = BODY_COLORS[variant % BODY_COLORS.length];
  const accent = new THREE.Color(jacket).multiplyScalar(0.58).getHex();
  const clothLight = new THREE.Color(jacket).multiplyScalar(1.16).getHex();
  const skin = SKIN_TONES[Math.floor(rng() * SKIN_TONES.length)];
  const pants = PANTS_COLORS[Math.floor(rng() * PANTS_COLORS.length)];
  const bulk = 0.94 + rng() * 0.12;
  const torsoHeight = -0.02 + rng() * 0.035;
  const headgear = variant % 3;
  const kit = 0x343a39, rubber = 0x1e2428, trim = 0x9ca79e;
  const key = (name: string): string => `${variant}:${name}`;
  const group = new THREE.Group();
  group.name = 'operator';
  group.userData.variant = variant;

  const hips = new THREE.Group();
  hips.position.y = HIP_HEIGHT;
  group.add(hips);
  const hip = new Part()
    .box(pants, 0.36 * bulk, 0.19, 0.24, 0, -0.01, 0, true)
    .box(kit, 0.365 * bulk, 0.055, 0.25, 0, 0.07, 0, true)
    .box(trim, 0.068, 0.048, 0.023, 0, 0.07, -0.138, true);
  for (const side of [-1, 1]) {
    hip.box(kit, 0.09, 0.14, 0.085, side * 0.185 * bulk, 0.005, -0.085, true);
    hip.box(0x77816d, 0.065, 0.026, 0.09, side * 0.185 * bulk, 0.07, -0.085);
  }
  hips.add(hip.finish(key('belt')));

  const makeLeg = (side: number): { leg: THREE.Group; knee: THREE.Group; foot: THREE.Group } => {
    const leg = new THREE.Group();
    leg.position.set(side * 0.11 * bulk, 0, 0);
    const thigh = new Part()
      .shape(TAPER, pants, 0.18, 0.405, 0.205, 0, -0.20, 0)
      .ball(pants, 0.086, 0.085, 0.09, 0, -0.39, 0)
      .box(accent, 0.068, 0.18, 0.13, side * 0.074, -0.19, 0, true)
      .box(kit, 0.177, 0.037, 0.18, 0, -0.27, 0)
      .box(0x63715f, 0.08, 0.033, 0.15, side * 0.075, -0.12, 0, true);
    leg.add(thigh.finish(key(`thigh-${side}`)));
    const knee = new THREE.Group();
    knee.position.y = -UPPER_LEG;
    const shin = new Part()
      .shape(TAPER, pants, 0.13, 0.33, 0.15, 0, -0.18, 0)
      .box(kit, 0.135, 0.16, 0.075, 0, -0.025, -0.067, true)
      .box(accent, 0.103, 0.112, 0.026, 0, -0.02, -0.107, true)
      .box(rubber, 0.125, 0.145, 0.13, 0, -0.335, 0, true);
    knee.add(shin.finish(key(`shin-${side}`)));
    const foot = new THREE.Group();
    foot.position.y = -LOWER_LEG;
    const boot = new Part()
      .box(rubber, 0.155, 0.09, 0.265, 0, -0.035, -0.055, true)
      .box(0x434844, 0.145, 0.07, 0.18, 0, -0.018, -0.09, true)
      .box(0x11191d, 0.16, 0.025, 0.275, 0, -0.0725, -0.055, true)
      .box(kit, 0.11, 0.055, 0.09, 0, 0.015, -0.03, true);
    for (let i = 0; i < 3; i++) boot.box(0x839080, 0.083, 0.006, 0.008, 0, 0.023 - i * 0.009, -0.035 - i * 0.025);
    foot.add(boot.finish(key(`boot-${side}`)));
    knee.add(foot);
    leg.add(knee);
    hips.add(leg);
    return { leg, knee, foot };
  };
  const l = makeLeg(-1), r = makeLeg(1);

  const torso = new THREE.Group();
  torso.position.y = HIP_HEIGHT;
  group.add(torso);
  const chest = new Part()
    .box(jacket, 0.43 * bulk, 0.50 + torsoHeight, 0.265, 0, 0.30, 0, true)
    .shape(TAPER, accent, 0.205, 0.08, 0.19, 0, 0.575 + torsoHeight, 0)
    .box(kit, 0.345 * bulk, 0.34, 0.07, 0, 0.35, -0.143, true)
    .box(accent, 0.288 * bulk, 0.25, 0.026, 0, 0.39, -0.19, true)
    .box(0xc6c3a2, 0.10, 0.04, 0.012, 0.072, 0.47, -0.207)
    .box(kit, 0.28, 0.34, 0.14, 0, 0.34, 0.178, true)
    .box(0x59604f, 0.225, 0.10, 0.10, 0, 0.19, 0.235, true);
  for (const side of [-1, 1]) {
    chest.box(kit, 0.063, 0.51, 0.03, side * 0.14, 0.34, -0.145, true, 0, 0, side * -0.05);
    chest.box(kit, 0.064, 0.5, 0.025, side * 0.125, 0.34, 0.145, true);
    chest.box(clothLight, 0.12, 0.10, 0.24, side * 0.22 * bulk, 0.51 + torsoHeight, 0, true);
    chest.box(kit, 0.10, 0.075, 0.195, side * 0.238 * bulk, 0.55 + torsoHeight, 0, true);
    chest.box(trim, 0.035, 0.048, 0.032, side * 0.14, 0.49, -0.16, true);
  }
  for (let i = 0; i < 3; i++) {
    chest.box(0x4d5548, 0.084, 0.125, 0.07, (i - 1) * 0.099, 0.245, -0.20, true);
    chest.box(0x83907a, 0.06, 0.025, 0.015, (i - 1) * 0.099, 0.292, -0.241);
  }
  chest.box(kit, 0.07, 0.14, 0.06, -0.19, 0.43, 0.17, true)
    .box(0x181e21, 0.013, 0.18, 0.013, -0.195, 0.59, 0.17)
    .box(0x8eaaa2, 0.035, 0.025, 0.009, -0.19, 0.47, 0.207);
  torso.add(chest.finish(key('plate-carrier')));

  const aim = new THREE.Group();
  aim.position.y = 0.49 + torsoHeight;
  torso.add(aim);
  const arms: Arm[] = [];
  for (const side of [-1, 1]) {
    const upper = new THREE.Group(), forearm = new THREE.Group(), hand = new THREE.Group();
    upper.position.set(side * 0.25 * bulk, 0, -0.09);
    upper.scale.y = forearm.scale.y = 0.335 / 0.29;
    upper.add(new Part()
      .shape(TAPER, jacket, 0.15, 0.265, 0.155, 0, -0.13, 0)
      .ball(jacket, 0.08, 0.085, 0.08, 0, -0.035, 0)
      .box(accent, 0.055, 0.12, 0.11, side * 0.06, -0.11, 0, true)
      .box(0xd7d0af, 0.01, 0.064, 0.073, side * 0.091, -0.10, 0, true)
      .finish(key(`sleeve-${side}`)));
    forearm.add(new Part()
      .ball(kit, 0.06, 0.064, 0.06, 0, -0.018, 0)
      .shape(TAPER, jacket, 0.105, 0.25, 0.115, 0, -0.145, 0)
      .box(kit, 0.075, 0.16, 0.035, 0, -0.12, 0.044, true)
      .box(accent, 0.11, 0.045, 0.12, 0, -0.25, 0, true)
      .finish(key(`forearm-${side}`)));
    const glove = new Part()
      .box(kit, 0.077, 0.09, 0.081, 0, 0, 0, true)
      .box(accent, 0.056, 0.06, 0.02, 0, 0, 0.042, true)
      .box(kit, 0.037, 0.065, 0.042, -side * 0.04, 0.02, -0.016, true, 0, 0, side * 0.3);
    for (let i = 0; i < 3; i++) glove.box(0x5b6456, 0.059, 0.018, 0.034, 0, 0.028 - i * 0.026, -0.041, true);
    hand.add(glove.finish(key(`glove-${side}`)));
    aim.add(upper, forearm, hand);
    arms.push({ upper, forearm, hand, side });
  }
  const gunMount = new THREE.Group();
  gunMount.position.set(0.045, -0.09, -0.36);
  aim.add(gunMount);

  const head = new THREE.Group();
  head.position.y = 0.65 + torsoHeight;
  torso.add(head);
  const face = new Part()
    .shape(TAPER, skin, 0.13, 0.095, 0.13, 0, -0.045, 0)
    .ball(skin, 0.126, 0.155, 0.124, 0, 0.085, -0.01)
    .box(skin, 0.169, 0.075, 0.142, 0, -0.006, -0.036, true)
    .box(new THREE.Color(skin).multiplyScalar(0.81).getHex(), 0.065, 0.015, 0.014, 0, 0.005, -0.118, true)
    .box(skin, 0.036, 0.061, 0.041, 0, 0.058, -0.13, true)
    .ball(skin, 0.026, 0.043, 0.019, -0.123, 0.065, -0.003)
    .ball(skin, 0.026, 0.043, 0.019, 0.123, 0.065, -0.003);
  const helmetColor = headgear === 2 ? jacket : kit;
  face.ball(helmetColor, 0.15, headgear === 1 ? 0.105 : 0.137, 0.15, 0, 0.16, 0.005);
  if (headgear === 1) {
    face.box(accent, 0.19, 0.021, 0.11, 0, 0.155, -0.155, true);
  } else {
    face.box(accent, 0.165, 0.035, 0.10, 0, 0.217, -0.09, true)
      .box(trim, 0.038, 0.054, 0.012, 0, 0.222, -0.145, true)
      .box(kit, 0.038, 0.09, 0.105, -0.14, 0.115, 0.005, true)
      .box(kit, 0.038, 0.09, 0.105, 0.14, 0.115, 0.005, true);
  }
  // Two separate lenses, bridge and straps keep the face readable at game scale.
  for (const side of [-1, 1]) {
    face.box(rubber, 0.10, 0.058, 0.035, side * 0.054, 0.097, -0.124, true, 0, side * 0.10)
      .box(0x799eaa, 0.078, 0.035, 0.012, side * 0.054, 0.101, -0.145, true, 0, side * 0.10)
      .box(kit, 0.019, 0.016, 0.20, side * 0.124, 0.102, -0.01, true);
  }
  face.box(rubber, 0.025, 0.024, 0.03, 0, 0.095, -0.136, true)
    .box(kit, 0.025, 0.052, 0.022, -0.12, 0.025, -0.05, true, 0.3)
    .box(kit, 0.06, 0.014, 0.016, -0.085, -0.004, -0.105, true)
    .box(rubber, 0.023, 0.023, 0.025, -0.054, -0.004, -0.116, true);
  head.add(face.finish(key('headgear')));

  const rig: Rig = {
    group, hips, legL: l.leg, kneeL: l.knee, footL: l.foot,
    legR: r.leg, kneeR: r.knee, footR: r.foot, torso, aim, head, gunMount, arms,
    phase: rng() * Math.PI * 2, air: 0, idleT: rng() * 10, lastWeapon: -1,
    run: 0, landing: 0, offGroundT: 0, previousGrounded: true, previousVy: 0,
    lastX: NaN, lastY: NaN, lastZ: NaN, moveYaw: NaN, bodyYaw: NaN, moving: false, backward: false, bulk, torsoHeight,
  };
  swapGun(rig, 1);
  poseLeg(rig.legL, rig.kneeL, rig.footL, 0, ANKLE_HEIGHT - HIP_HEIGHT, 0, 0);
  poseLeg(rig.legR, rig.kneeR, rig.footR, 0, ANKLE_HEIGHT - HIP_HEIGHT, 0, 0);
  return rig;
}

const DOWN = new THREE.Vector3(0, -1, 0);
const AIM_POSE = new THREE.Quaternion();
const AIM_PITCH_AXIS = new THREE.Vector3(1,0,0);
function poseArms(rig: Rig, weapon: number): void {
  const grips = weaponGripPoints(weapon);
  for (const arm of rig.arms) {
    const grip = arm.side > 0 ? grips.trigger : grips.support;
    const target = new THREE.Vector3(...grip).add(rig.gunMount.position);
    const shoulder = arm.upper.position;
    const direction = target.clone().sub(shoulder);
    const length = direction.length();
    direction.normalize();
    // Flex outwards and down, giving each wrist its actual weapon grip.
    const bend = new THREE.Vector3(arm.side * 0.8, -0.8, 0.25);
    bend.addScaledVector(direction, -bend.dot(direction)).normalize();
    const upperLength = 0.335, foreLength = 0.335;
    const reach = Math.min(length, upperLength + foreLength - 0.001);
    const along = (upperLength * upperLength - foreLength * foreLength + reach * reach) / (2 * reach);
    const height = Math.sqrt(Math.max(0, upperLength * upperLength - along * along));
    const elbow = shoulder.clone().addScaledVector(direction, along).addScaledVector(bend, height);
    arm.upper.quaternion.setFromUnitVectors(DOWN, elbow.clone().sub(shoulder).normalize());
    arm.forearm.position.copy(elbow);
    arm.forearm.quaternion.setFromUnitVectors(DOWN, target.clone().sub(elbow).normalize());
    arm.hand.position.copy(target);
    arm.hand.rotation.set(0, 0, arm.side > 0 ? 0 : -0.20);
  }
}

function swapGun(rig: Rig, weapon: number): void {
  rig.gunMount.clear();
  rig.gunMount.add(cloneWorldWeapon(weapon));
  rig.gunMount.userData.weapon = weapon;
  rig.lastWeapon = weapon;
  poseArms(rig, weapon);
}

function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** Feet solve back to a fixed floor during stance; knees flex for swing. */
function poseLeg(leg: THREE.Group, knee: THREE.Group, foot: THREE.Group,
  z: number, y: number, heading: number, air: number): void {
  const reach = Math.min(UPPER_LEG + LOWER_LEG - 0.0002, Math.hypot(z, y));
  const flex = Math.acos(THREE.MathUtils.clamp(
    (reach * reach - UPPER_LEG * UPPER_LEG - LOWER_LEG * LOWER_LEG) / (2 * UPPER_LEG * LOWER_LEG), -1, 1,
  ));
  const hip = Math.atan2(-z, -y) + Math.atan2(LOWER_LEG * Math.sin(flex), UPPER_LEG + LOWER_LEG * Math.cos(flex));
  leg.rotation.order = 'YXZ';
  leg.rotation.set(hip * (1 - air) - 0.18 * air, heading, 0, 'YXZ');
  knee.rotation.x = -flex * (1 - air) - 0.78 * air;
  foot.rotation.x = -(hip - flex) * (1 - air) + 0.35 * air;
}

/** Displayed displacement drives gait; authoritative contact drives airborne pose. */
export function animateRig(rig: Rig, v: PlayerView, dt: number): void {
  if (v.weapon !== rig.lastWeapon) swapGun(rig, v.weapon);
  dt = Math.min(0.1, Math.max(0, dt));
  const dx = v.x - rig.lastX, dy = v.y - rig.lastY, dz = v.z - rig.lastZ;
  const travel = Math.hypot(dx, dz);
  const continuous = Number.isFinite(travel + dy) && travel < Math.max(3, dt * PLAYER.MAX_SPEED * 1.5) && Math.abs(dy) < 5;
  const distance = continuous ? travel : 0;
  const speed = dt > 0 ? Math.min(PLAYER.MAX_SPEED, distance / dt) : 0;
  rig.lastX = v.x; rig.lastY = v.y; rig.lastZ = v.z;
  const running = Math.min(1, speed / PLAYER.RUN_SPEED);
  rig.run += (running - rig.run) * (1 - Math.exp(-dt * 18));
  rig.offGroundT = v.grounded ? 0 : rig.offGroundT + dt;
  const airTarget = !v.grounded && (rig.offGroundT > 0.07 || v.vy > 4) ? 1 : 0;
  rig.air += (airTarget - rig.air) * (1 - Math.exp(-dt * 14));
  if (v.grounded && !rig.previousGrounded && rig.air > 0.15) {
    rig.landing = Math.min(0.075, Math.max(0.025, -rig.previousVy * 0.005));
  }
  rig.previousGrounded = v.grounded;
  rig.previousVy = v.vy;
  rig.landing *= Math.exp(-dt * 12);
  const ground = 1 - rig.air;
  rig.idleT += dt;

  if(!Number.isFinite(rig.moveYaw)||!continuous){rig.moveYaw=v.yaw;rig.bodyYaw=v.yaw;rig.moving=false;rig.backward=false;}
  if(distance>0.00001){
    const direction=Math.atan2(-dx,-dz);
    if(!rig.moving)rig.backward=Math.cos(wrapAngle(direction-v.yaw))<-.35;
    else {
      // Direction is measured against the persistent lower-body frame, never
      // against a rapidly aiming mouse/bot. A deadband preserves sidesteps.
      const forwardness=Math.cos(wrapAngle(direction-rig.moveYaw));
      if(forwardness<-.45)rig.backward=true;
      else if(forwardness>.45)rig.backward=false;
    }
    const target=direction+(rig.backward?Math.PI:0);
    rig.moveYaw=wrapAngle(rig.moveYaw+THREE.MathUtils.clamp(wrapAngle(target-rig.moveYaw),-dt*5,dt*5));
    rig.moving=true;
  } else if(rig.run<.02){
    rig.moving=false;
    rig.moveYaw=wrapAngle(rig.moveYaw+THREE.MathUtils.clamp(wrapAngle(v.yaw-rig.moveYaw),-dt*3,dt*3));
  }
  const relative=wrapAngle(rig.moveYaw-v.yaw);
  // Roughly1.4m walking/3.2m sprinting cycles. Only displacement advances a
  // planted gait; aim jitter cannot reverse its phase at the strafe boundary.
  const cycleLength=1.4+Math.min(1,speed/PLAYER.RUN_SPEED)*1.8;
  if(v.grounded)rig.phase+=distance*Math.PI*2/cycleLength*(rig.backward?-1:1);
  rig.phase%=Math.PI*2;
  rig.hips.rotation.y=relative;
  const bodyTarget=rig.moving?rig.moveYaw+THREE.MathUtils.clamp(wrapAngle(v.yaw-rig.moveYaw),-.95,.95):v.yaw;
  rig.bodyYaw=wrapAngle(rig.bodyYaw+THREE.MathUtils.clamp(wrapAngle(bodyTarget-rig.bodyYaw),-dt*4,dt*4));
  rig.torso.rotation.y=wrapAngle(rig.bodyYaw-v.yaw);
  const stride = 0.37 * rig.run * ground;
  const bob = (1 - Math.cos(rig.phase * 2)) * 0.018 * rig.run * ground;
  const hipY = HIP_HEIGHT - rig.run * 0.075 * ground - rig.landing + bob;
  rig.hips.position.y = hipY;
  rig.torso.position.y = hipY;
  rig.group.position.y = 0;
  for (const [leg, knee, foot, offset] of [
    [rig.legL, rig.kneeL, rig.footL, 0],
    [rig.legR, rig.kneeR, rig.footR, Math.PI],
  ] as const) {
    const phase = ((rig.phase + offset) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    const stance = phase < Math.PI;
    const z = stance ? -stride + 2 * stride * phase / Math.PI : stride * Math.cos(phase - Math.PI);
    const lift = stance ? 0 : Math.sin(phase - Math.PI) * 0.16 * rig.run;
    poseLeg(leg, knee, foot, z, ANKLE_HEIGHT + lift - hipY, relative - rig.hips.rotation.y, rig.air);
  }

  const forward = distance > 0 ? (-dx * Math.sin(v.yaw) - dz * Math.cos(v.yaw)) / distance : 0;
  const lean = 0.10 * rig.run * ground * forward + v.pitch * 0.10 + rig.air * 0.05;
  rig.torso.rotation.x = lean;
  rig.torso.rotation.z = -Math.sin(relative) * 0.035 * rig.run * ground;
  // Upper aim cancels the body's eased yaw, lean and bank exactly. The gun
  // remains authoritative while hips and jacket follow a stable movement frame.
  rig.aim.quaternion.copy(rig.torso.quaternion).invert().multiply(AIM_POSE.setFromAxisAngle(AIM_PITCH_AXIS,v.pitch));
  rig.head.quaternion.copy(rig.torso.quaternion).invert().multiply(AIM_POSE.setFromAxisAngle(AIM_PITCH_AXIS,v.pitch*.48));
  // Breathing moves the shoulders, never the planted feet.
  rig.aim.position.y = 0.49 + rig.torsoHeight + Math.sin(rig.idleT * 1.7) * 0.004 * (1 - rig.run);
}

interface Model {
  root: THREE.Group;
  rig: Rig;
  tag: THREE.Sprite;
  name: string;
  deathT: number;
  dead: boolean;
  hull: THREE.Group | null;
  hullType: number;
  hullVariant: number;
  hullSeat: number;
  airMuzzle: THREE.Vector3 | null;
  crew: THREE.Group | null;
  crewType: number;
  crewVariant: number;
  /** Tank turret pivot inside the hull, if the hull has one. */
  turret: THREE.Object3D | null;
  /** Smoothed cosmetic hull attitude (radians). */
  attPitch: number;
  attRoll: number;
}

export interface LocalVehiclePose { vehicleId: number; x: number; y: number; z: number; rotation: Rotation }

export class PlayerModels {
  readonly group = new THREE.Group();
  private readonly models = new Map<number, Model>();

  private readonly factions = new Map<number, Faction>();
  setFactions(rows: { id: number; faction: Faction }[]): void {
    this.factions.clear(); for (const row of rows) this.factions.set(row.id, row.faction);
  }
  private ensure(id: number, name: string): Model {
    let m = this.models.get(id);
    if (m) return m;

    const root = new THREE.Group();
    const rig = buildRig(id);
    root.add(rig.group);

    const tag = makeNameSprite(name);
    tag.position.y = PLAYER.HEIGHT + 0.42;
    root.add(tag);

    m = { root, rig, tag, name, deathT: 0, dead: false, hull: null, hullType: 0, hullVariant: 0, hullSeat:0, airMuzzle:null, crew: null, crewType: 0, crewVariant: 0, turret: null, attPitch: 0, attRoll: 0 };
    this.models.set(id, m);
    this.group.add(root);
    return m;
  }

  /** Sync models to this frame's interpolated views. */
  update(views: PlayerView[], names: Map<number, string>, dt: number, localVehicle?: LocalVehiclePose): void {
    const present = new Set<number>();
    for (const v of views) {
      present.add(v.id);
      const m = this.ensure(v.id, names.get(v.id) ?? `#${v.id}`);
      m.tag.material.color.set(FACTIONS[this.factions.get(v.id) ?? 0].color);
      m.root.position.set(v.x, v.y, v.z);
      m.root.rotation.y = v.yaw;
      if (!v.dead) m.root.rotation.z = 0;

      // While driving, the character disappears inside a hull that follows
      // the replicated hull heading; the name tag rides along on top.
      const driving = v.vehicle !== VEHICLE.NONE && !v.dead;
      m.airMuzzle=driving&&v.vehicle===VEHICLE.JET&&v.seat===1?(m.airMuzzle??new THREE.Vector3()):null;
      const localHull = v.vehicleId !== undefined && v.vehicleId === localVehicle?.vehicleId;
      const hasDriver = v.vehicleId !== undefined && views.some(other=>other.vehicleId===v.vehicleId && (other.seat??0)===0 && !other.dead);
      const showHull = driving && !localHull && ((v.seat??0)===0 || !hasDriver);
      if (showHull && (m.hullType !== v.vehicle || m.hullVariant !== (v.vehicleVariant ?? 0) || m.hullSeat!==(v.seat??0))) {
        if (m.hull) disposeVehicleHull(m.hull);
        m.hull = v.seat===2?trainArtilleryModel():buildVehicleHull(v.vehicle as never, v.vehicleVariant);
        m.hullType = v.vehicle; m.hullVariant = v.vehicleVariant ?? 0;
        m.hullSeat=v.seat??0;
        m.turret = m.hull.getObjectByName('turret') ?? null;
        m.root.add(m.hull);
      }
      if (m.hull) {
        m.hull.visible = showHull;
        if (showHull) {
          // Hulls tilt with their motion: nose follows the velocity slope
          // (up a hill, down over a cliff edge) and the body rolls with
          // lateral slide. Jets render their separately replicated attitude;
          // the pilot can freely look around without rotating the airframe.
          const att = vehicleAttitude(
            v.vehicle as never, v.vx, v.vy, v.vz, v.heading,
          );
          const targetPitch = v.vehicle === VEHICLE.JET ? (v.vehiclePitch ?? 0) : att.pitch;
          const k = Math.min(1, dt * 10);
          m.attPitch = v.vehicle === VEHICLE.JET ? targetPitch : m.attPitch + (targetPitch - m.attPitch) * k;
          m.attRoll = v.vehicle === VEHICLE.JET ? (v.vehicleRoll ?? 0) : m.attRoll + (att.roll - m.attRoll) * k;
          if(v.seat===2)m.attPitch=m.attRoll=0;
          if (v.vehicle === VEHICLE.JET) {
            const q = vehicleQuaternion(v);
            m.hull.quaternion.set(q.x, q.y, q.z, q.w).premultiply(
              HULL_PARENT_ROTATION.set(0, Math.sin(-v.yaw / 2), 0, Math.cos(-v.yaw / 2)));
          } else m.hull.rotation.set(m.attPitch, v.heading - v.yaw, m.attRoll, 'YXZ');
          // The turret tracks the gunner's aim, not the tracks.
          aimVehicleWeapon(m.hull, v.seat===1?v.heading:v.yaw, v.seat===1?0:v.pitch);
          const forwardSpeed = -v.vx * Math.sin(v.heading) - v.vz * Math.cos(v.heading);
          const lateralSpeed = v.vx * Math.cos(v.heading) - v.vz * Math.sin(v.heading);
          updateVehicleHull(m.hull, {
            dt, speed: forwardSpeed,
            steering: Math.max(-1, Math.min(1, lateralSpeed * 0.15)),
            throttle: Math.min(1, Math.abs(forwardSpeed) / 25),
          });
        } else {
          m.attPitch = 0;
          m.attRoll = 0;
        }
      }
      const crew = driving && v.seat===1 && v.vehicle!==VEHICLE.JET;
      if(crew && (!m.crew || m.crewType!==v.vehicle || m.crewVariant!==(v.vehicleVariant??0))) {
        if(m.crew)disposeVehicleHull(m.crew);
        m.crew=buildCrewWeapon(v.vehicle as never,v.vehicleVariant);m.crewType=v.vehicle;m.crewVariant=v.vehicleVariant??0;
        m.root.add(m.crew);
      }
      if(m.crew)m.crew.visible=crew;
      m.rig.group.visible = !driving;
      m.tag.position.y = driving ? v.seat===1?4.1:3.4 : PLAYER.HEIGHT + 0.42;

      m.root.rotation.y = v.yaw;
      if (!driving && !v.dead) animateRig(m.rig, v, dt);
      else {
        // Entering a vehicle or dying breaks the displayed walking history.
        // Dismounts/respawns must not count that skipped travel as one stride.
        m.rig.lastX = m.rig.lastY = m.rig.lastZ = NaN;
        m.rig.moveYaw=m.rig.bodyYaw=NaN;m.rig.moving=false;m.rig.backward=false;
        m.rig.run = m.rig.air = m.rig.landing = m.rig.offGroundT = 0;
        m.rig.previousGrounded = v.grounded;
      }

      if (v.dead && !m.dead) { m.dead = true; m.deathT = 0; }
      if (!v.dead && m.dead) { m.dead = false; m.deathT = 0; m.root.rotation.z = 0; m.root.visible = true; }
      if (m.dead) {
        m.deathT += dt;
        const t = Math.min(1, m.deathT / 0.4);
        m.root.rotation.z = (Math.PI / 2) * t;
        m.root.position.y = v.y - 0.5 * Math.max(0, m.deathT - 0.4);
        m.root.visible = m.deathT < 2.5;
      }
    }
    // The gunner keeps independent aim, while their mount follows the exact
    // displayed hull pose (including a local driver's prediction, not the
    // intentionally delayed remote snapshot). Resolve after all hulls update.
    for(const v of views) {
      const m=this.models.get(v.id);if(!m||(!m.crew?.visible&&!m.airMuzzle))continue;
      const local=v.vehicleId!==undefined&&v.vehicleId===localVehicle?.vehicleId?localVehicle:undefined;
      const driver=views.find(other=>other.vehicleId!==undefined&&other.vehicleId===v.vehicleId&&(other.seat??0)===0&&!other.dead);
      const hull=driver?this.models.get(driver.id)?.hull:m.hull;
      if(m.airMuzzle) {
        const offset=aircraftCrewMuzzle({...v,vehicleRotation:local?.rotation??v.vehicleRotation});
        m.airMuzzle.set((local?.x??v.x)+offset.x,(local?.y??v.y)+offset.y,(local?.z??v.z)+offset.z);continue;
      }
      if(!m.crew)continue;
      if(local) {m.root.position.set(local.x,local.y,local.z);m.crew.quaternion.set(local.rotation.x,local.rotation.y,local.rotation.z,local.rotation.w);}
      else if(hull?.visible) {hull.getWorldPosition(m.root.position);hull.getWorldQuaternion(m.crew.quaternion);}
      else m.crew.quaternion.setFromAxisAngle(THREE.Object3D.DEFAULT_UP,v.heading);
      m.crew.quaternion.premultiply(HULL_PARENT_ROTATION.set(0,Math.sin(-v.yaw/2),0,Math.cos(-v.yaw/2)));
      aimVehicleWeapon(m.crew,v.yaw,v.pitch);updateVehicleHull(m.crew,{dt,speed:0});
    }
    for (const [id, m] of this.models) {
      if (!present.has(id)) {
        if (m.hull) disposeVehicleHull(m.hull);
        if (m.crew) disposeVehicleHull(m.crew);
        this.group.remove(m.root);
        this.models.delete(id);
      }
    }
  }

  /** Approximate muzzle position for a remote player's tracer. */
  muzzlePos(id: number): THREE.Vector3 | null {
    const m = this.models.get(id);
    if (!m) return null;
    const v = new THREE.Vector3();
    if(m.airMuzzle)return m.airMuzzle.clone();
    if (m.crew?.visible && vehicleMuzzlePosition(m.crew,v))return v;
    if (m.hull?.visible && vehicleMuzzlePosition(m.hull, v)) return v;
    const gun = m.rig.gunMount.children[0];
    const muzzle: number[] | undefined = gun?.userData.muzzle;
    v.fromArray(muzzle ?? [0, 0, -0.65]);
    m.rig.gunMount.localToWorld(v);
    return v;
  }

  flashVehicle(id: number): boolean {
    const model=this.models.get(id),hull=model?.crew?.visible?model.crew:model?.hull;
    return hull?.visible ? flashVehicleWeapon(hull) : false;
  }
}

function makeNameSprite(name: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 56;
  const g = canvas.getContext('2d')!;
  g.font = 'bold 30px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = 'rgba(8,10,14,0.55)';
  const w = Math.min(240, g.measureText(name).width + 22);
  g.beginPath();
  g.roundRect(128 - w / 2, 6, w, 44, 8);
  g.fill();
  g.fillStyle = '#e8edf5';
  g.fillText(name, 128, 29, 232);
  const tex = new THREE.CanvasTexture(canvas);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
  sprite.scale.set(1.7, 0.37, 1);
  return sprite;
}
