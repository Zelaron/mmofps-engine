import * as THREE from 'three';
import type { CityCivilian, CityCivilianPose } from '@shared/city-life';
import { VehicleGeometry } from './vehicle-geometry.js';

export const MAX_VISIBLE_CIVILIANS = 48;
/** A civilian knocked down `elapsed` seconds ago, falling away along dir. */
export interface CivilianFall { elapsed: number; dirX: number; dirZ: number }
export interface CivilianRenderItem { civilian: CityCivilian; pose: CityCivilianPose; fall?: CivilianFall }

/** A fallen civilian tips over in FALL_SECONDS, lies still, then sinks out of
 * sight between SINK_FROM and CIVILIAN_DOWN_SECONDS. */
export const CIVILIAN_DOWN_SECONDS = 9;
export const CIVILIAN_RETURN_SECONDS = 75;
const FALL_SECONDS = .55, SINK_FROM = 7.4;

interface Wardrobe {
  skin: number; hair: number; shirt: number; sleeve: number; pants: number; shoe: number; sole: number;
}
// Worker in a high-visibility vest, clinic staff in a white coat, a citizen
// in a jacket with a backpack. Each wardrobe is one set of instance pools.
const WARDROBES: readonly Wardrobe[] = [
  { skin: 0xc99a76, hair: 0x2d221c, shirt: 0x2f4a6b, sleeve: 0x2f4a6b, pants: 0x4a4a3c, shoe: 0x5b3a22, sole: 0x231a14 },
  { skin: 0x8f6448, hair: 0x15110f, shirt: 0x4f9a93, sleeve: 0xe6ebe8, pants: 0x9aa3a6, shoe: 0xe9ece8, sole: 0x9a9f9d },
  { skin: 0xe2bc9c, hair: 0x9a6b3a, shirt: 0x7e3b45, sleeve: 0x7e3b45, pants: 0x34507a, shoe: 0xdfe3e6, sole: 0x55595d },
];
const HIP_Y = .89, THIGH = .44, SHOULDER_X = .255, SHOULDER_Y = 1.43;
const UP = new THREE.Vector3(0, 1, 0);

function ellipse(radiusTop: number, radiusBottom: number, height: number, depth: number, segments = 12): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments).scale(1, 1, depth);
}
function ovoid(x: number, y: number, z: number, segments = 12, rings = 9): THREE.BufferGeometry {
  return new THREE.SphereGeometry(1, segments, rings).scale(x, y, z);
}

function buildBody(style: number, w: Wardrobe): VehicleGeometry {
  const body = new VehicleGeometry();
  // Pelvis, belt, a torso that tapers to the waist and rounded shoulders.
  body.add(ellipse(.165, .18, .2, .72), w.pants, [0, .93, 0]);
  body.add(ellipse(.172, .172, .045, .72), 0x2a2622, [0, 1.035, 0]);
  body.add(ellipse(.215, .175, .46, .64, 14), w.shirt, [0, 1.28, 0]);
  body.add(new THREE.CapsuleGeometry(.082, .34, 4, 10).rotateZ(Math.PI / 2).scale(1, 1, .9), w.shirt, [0, 1.462, 0]);
  // Neck and head: a smaller, oval head with ears and a quiet face.
  body.add(new THREE.CylinderGeometry(.05, .058, .1, 10), w.skin, [0, 1.545, 0]);
  body.add(ovoid(.112, .135, .122, 16, 12), w.skin, [0, 1.665, 0]);
  for (const side of [-1, 1]) {
    body.add(ovoid(.016, .032, .024, 8, 6), w.skin, [side * .111, 1.665, .005]);
    body.add(new THREE.SphereGeometry(.0135, 7, 5), 0x1b1c20, [side * .041, 1.682, -.108]);
    body.box(.04, .009, .012, side * .042, 1.705, -.114, w.hair);
  }
  body.add(ovoid(.017, .028, .022, 8, 6), w.skin, [0, 1.654, -.122]);
  body.box(.038, .006, .01, 0, 1.617, -.114, 0x8a5a50);
  // Hair (or a hat) is a crown cap plus a cap over the back of the head, so
  // it never covers the face.
  const crown = (scale: number) => new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI * .4).scale(.119 * scale, .143 * scale, .129 * scale);
  const back = (drop: number) => new THREE.SphereGeometry(1, 12, 8, 0, Math.PI * 2, 0, Math.PI * .45).rotateX(Math.PI / 2).scale(.118, .14 + drop, .13);
  if (style === 0) {
    // Hard hat with a brim; vest with two reflective bands.
    body.add(new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2).scale(.132, .1, .142), 0xe8b726, [0, 1.718, 0]);
    body.add(ellipse(.158, .158, .016, 1.08, 16), 0xd9a91f, [0, 1.72, -.01]);
    body.add(ellipse(.223, .183, .4, .66, 14), 0xf08a24, [0, 1.27, 0]);
    for (const y of [1.19, 1.33]) {
      const r = .183 + .04 * (y - 1.07) / .4 + .004;
      body.add(ellipse(r, r, .034, .67, 14), 0xd6dad4, [0, y, 0]);
    }
  } else if (style === 1) {
    // Short hair; a long, open clinic coat over a teal top, and a badge.
    body.add(crown(1), w.hair, [0, 1.672, .004]);
    body.add(back(0), w.hair, [0, 1.665, .008]);
    body.add(ellipse(.224, .248, .66, .67, 14), w.sleeve, [0, 1.12, .006]);
    body.box(.1, .085, .01, 0, 1.415, -.142, w.shirt);
    body.box(.006, .62, .02, 0, 1.12, -.166, 0x9fb0ad);
    body.box(.05, .065, .008, -.09, 1.33, -.142, 0x2f6f99);
  } else {
    // Longer hair; jacket with a zip and a backpack on two straps.
    body.add(crown(1.03), w.hair, [0, 1.672, .006]);
    body.add(back(.03), w.hair, [0, 1.645, .012]);
    body.add(ellipse(.222, .184, .44, .66, 14), w.shirt, [0, 1.275, 0]);
    body.box(.008, .4, .012, 0, 1.275, -.143, 0x2a2226);
    body.box(.27, .32, .12, 0, 1.28, .175, 0x3e4a3a);
    body.add(new THREE.CapsuleGeometry(.06, .17, 4, 8).rotateZ(Math.PI / 2), 0x3e4a3a, [0, 1.44, .175]);
    for (const side of [-1, 1]) body.box(.034, .3, .02, side * .095, 1.31, -.138, 0x2f382c);
  }
  return body;
}

/** Three articulated civilian wardrobes share twelve fixed instance pools. */
export class CivilianModels {
  readonly group = new THREE.Group();
  readonly stats = { count: 0, triangles: 0, draws: 0 };
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly pools: THREE.InstancedMesh[][] = [];
  private readonly root = new THREE.Object3D();
  private readonly part = new THREE.Object3D();
  private readonly matrix = new THREE.Matrix4();
  private readonly tint = new THREE.Color();
  private readonly fallAxis = new THREE.Vector3();
  private readonly fallTurn = new THREE.Quaternion();
  private readonly yawTurn = new THREE.Quaternion();

  constructor() {
    this.group.name = 'city-civilians';
    for (let style = 0; style < 3; style++) {
      const w = WARDROBES[style], body = buildBody(style, w);
      const upper = new VehicleGeometry(), lower = new VehicleGeometry(), arm = new VehicleGeometry();
      upper.tube(.082, [0, 0, 0], [0, -THIGH, 0], w.pants, 10, .067);
      upper.add(new THREE.SphereGeometry(.068, 9, 6), w.pants, [0, -THIGH, 0]);
      lower.tube(.066, [0, 0, 0], [0, -.37, 0], w.pants, 10, .052);
      lower.box(.098, .075, .235, 0, -.405, -.045, w.shoe);
      lower.add(ovoid(.05, .04, .058, 9, 6), w.shoe, [0, -.41, -.155]);
      lower.box(.104, .02, .255, 0, -.443, -.05, w.sole);
      arm.tube(.058, [0, 0, 0], [0, -.28, 0], w.sleeve, 9, .05);
      arm.add(new THREE.SphereGeometry(.05, 8, 6), w.sleeve, [0, -.28, 0]);
      arm.tube(.048, [0, -.28, 0], [0, -.5, -.05], w.sleeve, 9, .04);
      arm.add(ovoid(.042, .056, .03, 9, 6), w.skin, [0, -.54, -.06]);
      const meshes = [body, upper, lower, arm].map((part, index) => {
        const template = part.mesh(this.material, 'civilian-part');
        const mesh = new THREE.InstancedMesh(template.geometry, this.material, MAX_VISIBLE_CIVILIANS * (index ? 2 : 1));
        mesh.name = `civilian-${style}-${index}`; mesh.count = 0; mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(mesh); return mesh;
      });
      this.pools.push(meshes);
    }
  }

  update(items: readonly CivilianRenderItem[], seconds: number): void {
    for (const pools of this.pools) for (const mesh of pools) mesh.count = 0;
    this.stats.count = this.stats.triangles = this.stats.draws = 0;
    for (const { civilian, pose, fall } of items.slice(0, MAX_VISIBLE_CIVILIANS)) {
      const pools = this.pools[civilian.style % 3], size = .94 + (civilian.color % 5) * .027;
      // A fallen civilian tips over away from what hit them, then sinks.
      const tip = fall ? Math.min(1, fall.elapsed / FALL_SECONDS) : 0;
      const sink = fall && fall.elapsed > SINK_FROM ? Math.min(1, (fall.elapsed - SINK_FROM) / (CIVILIAN_DOWN_SECONDS - SINK_FROM)) * .5 : 0;
      this.root.position.set(pose.x, pose.y - sink, pose.z);
      this.yawTurn.setFromAxisAngle(UP, pose.yaw);
      if (fall) {
        this.fallAxis.set(fall.dirZ, 0, -fall.dirX).normalize();
        this.fallTurn.setFromAxisAngle(this.fallAxis, (Math.PI / 2 - .06) * tip * tip);
        this.root.quaternion.copy(this.fallTurn).multiply(this.yawTurn);
      } else this.root.quaternion.copy(this.yawTurn);
      this.root.scale.setScalar(size); this.root.updateMatrix();
      const shade = .9 + civilian.color % 5 * .025; this.tint.setRGB(shade, .92 + civilian.color % 3 * .04, .92 + civilian.color % 4 * .027);
      const emit = (index: number, x: number, y: number, z: number, rx = 0, rz = 0): void => {
        const mesh = pools[index]; this.part.position.set(x, y, z); this.part.rotation.set(rx, 0, rz); this.part.updateMatrix();
        this.matrix.multiplyMatrices(this.root.matrix, this.part.matrix); mesh.setMatrixAt(mesh.count, this.matrix); mesh.setColorAt(mesh.count++, this.tint);
      };
      const moving = pose.moving && !fall;
      const phase = pose.stride * 4.5, bob = moving ? Math.sin(phase * 2) * .015 : fall ? 0 : Math.sin(seconds * 1.2 + civilian.id) * .006;
      emit(0, 0, bob, 0);
      for (const side of [-1, 1]) {
        const swing = moving ? Math.sin(phase + (side > 0 ? Math.PI : 0)) * .42 : fall ? side * .06 * tip : 0;
        const knee = moving ? Math.max(0, -Math.sin(phase + (side > 0 ? Math.PI : 0))) * .5 : fall ? .12 * tip : .025;
        emit(1, side * .11, HIP_Y, 0, swing);
        emit(2, side * .11, HIP_Y - THIGH * Math.cos(swing), -THIGH * Math.sin(swing), swing + knee);
        let gesture = -swing * .7, spread = side * .07;
        if (fall) { gesture = -1.1 * tip; spread = side * (.07 + .5 * tip); }
        else if (!pose.moving && pose.activity === 'repair') gesture = -.95 + Math.sin(seconds * 2 + side) * .12;
        else if (!pose.moving && pose.activity === 'talk' && side > 0) gesture = -.65 + Math.sin(seconds * 1.7) * .18;
        else if (!pose.moving && pose.activity === 'browse') gesture = -.3;
        emit(3, side * SHOULDER_X, SHOULDER_Y + bob, 0, gesture, spread);
      }
      this.stats.count++;
    }
    for (const pools of this.pools) for (const mesh of pools) {
      mesh.visible = mesh.count > 0;
      if (!mesh.count) continue;
      mesh.instanceMatrix.needsUpdate = true; if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.stats.draws++; this.stats.triangles += mesh.count * (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
    }
  }
  dispose(): void {
    for (const pools of this.pools) for (const mesh of pools) { mesh.geometry.dispose(); mesh.dispose(); }
    this.material.dispose(); this.group.clear();
  }
}
