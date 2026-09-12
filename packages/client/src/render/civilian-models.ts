import * as THREE from 'three';
import type { CityCivilian, CityCivilianPose } from '@shared/city-life';
import { VehicleGeometry } from './vehicle-geometry.js';

export const MAX_VISIBLE_CIVILIANS = 48;
export interface CivilianRenderItem { civilian: CityCivilian; pose: CityCivilianPose }
const CLOTH = [0xad7543, 0x467570, 0x805b76], SKIN = [0xca9c75, 0x9e7359, 0xe0b99a];

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

  constructor() {
    this.group.name = 'city-civilians';
    for (let style = 0; style < 3; style++) {
      const body = new VehicleGeometry(), coat = CLOTH[style], skin = SKIN[style];
      body.add(new THREE.CylinderGeometry(.21, .24, .53, 10), coat, [0, 1.18, 0]);
      body.box(.40, .13, .29, 0, .90, 0, 0x3b3b42);
      body.box(.045, .5, .035, 0, 1.2, -.216, 0xc2bd9c);
      for (const side of [-1, 1]) body.box(.13, .13, .035, side * .125, 1.22, -.213, 0x545a58);
      body.add(new THREE.CylinderGeometry(.07, .08, .11, 8), skin, [0, 1.49, 0]);
      body.add(new THREE.SphereGeometry(1, 12, 8).scale(.145, .185, .14), skin, [0, 1.66, -.005]);
      body.box(.047, .064, .065, 0, 1.65, -.14, skin);
      for (const side of [-1, 1]) {
        body.add(new THREE.SphereGeometry(.023, 7, 5), 0x171b21, [side * .055, 1.698, -.133]);
        body.box(.057, .015, .02, side * .055, 1.738, -.127, 0x342d2a);
      }
      body.box(.075, .012, .015, 0, 1.595, -.137, 0x714d43);
      if (style === 0) {
        body.add(new THREE.SphereGeometry(.157, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0xd0a342, [0, 1.755, 0]);
        body.add(new THREE.CylinderGeometry(.185, .185, .04, 12), 0xc89835, [0, 1.758, 0]);
        body.box(.12, .17, .12, .20, .97, .03, 0x383f45);
        body.box(.05, .23, .055, .20, 1.09, .03, 0x9caaa7);
      } else if (style === 1) {
        body.add(new THREE.CylinderGeometry(.23, .31, .33, 10), coat, [0, .96, .02]);
        body.box(.24, .42, .035, 0, 1.05, -.235, 0xc4bd97);
        body.add(new THREE.SphereGeometry(.154, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0x392e29, [0, 1.765, 0]);
      } else {
        body.box(.31, .36, .14, 0, 1.16, .23, 0x494652);
        for (const side of [-1, 1]) body.box(.042, .48, .035, side * .15, 1.2, -.216, 0xb4ac88);
        body.add(new THREE.CylinderGeometry(.18, .15, .09, 10), 0x554050, [0, 1.805, .015]);
        body.box(.12, .10, .03, -.12, 1.35, -.23, 0xcda64d);
      }
      const upper = new VehicleGeometry(), lower = new VehicleGeometry(), arm = new VehicleGeometry();
      upper.tube(.085, [0, 0, 0], [0, -.44, 0], 0x454b50, 9, .075);
      upper.add(new THREE.SphereGeometry(.079, 9, 6), 0x41484d, [0, -.44, 0]);
      lower.tube(.073, [0, 0, 0], [0, -.35, 0], 0x40494d, 9, .065);
      lower.box(.15, .105, .28, 0, -.39, -.055, 0x272d32);
      lower.box(.16, .035, .30, 0, -.43, -.055, 0x1e2226);
      arm.tube(.083, [0, 0, 0], [0, -.27, 0], coat, 9, .063);
      arm.tube(.065, [0, -.27, 0], [0, -.49, -.08], coat, 9, .052);
      arm.add(new THREE.SphereGeometry(1, 9, 6).scale(.056, .075, .047), skin, [0, -.53, -.09]);
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
    for (const { civilian, pose } of items.slice(0, MAX_VISIBLE_CIVILIANS)) {
      const pools = this.pools[civilian.style % 3], size = .94 + (civilian.color % 5) * .027;
      this.root.position.set(pose.x, pose.y, pose.z); this.root.rotation.set(0, pose.yaw, 0); this.root.scale.setScalar(size); this.root.updateMatrix();
      const shade = .82 + civilian.color * .025; this.tint.setRGB(shade, .86 + civilian.color % 3 * .065, .88 + civilian.color % 4 * .045);
      const emit = (index: number, x: number, y: number, z: number, rx = 0, rz = 0): void => {
        const mesh = pools[index]; this.part.position.set(x, y, z); this.part.rotation.set(rx, 0, rz); this.part.updateMatrix();
        this.matrix.multiplyMatrices(this.root.matrix, this.part.matrix); mesh.setMatrixAt(mesh.count, this.matrix); mesh.setColorAt(mesh.count++, this.tint);
      };
      const phase = pose.stride * 4.5, bob = pose.moving ? Math.sin(phase * 2) * .015 : Math.sin(seconds * 1.2 + civilian.id) * .006;
      emit(0, 0, bob, 0);
      for (const side of [-1, 1]) {
        const swing = pose.moving ? Math.sin(phase + (side > 0 ? Math.PI : 0)) * .42 : 0;
        const knee = pose.moving ? Math.max(0, -Math.sin(phase + (side > 0 ? Math.PI : 0))) * .5 : .025;
        emit(1, side * .115, .89, 0, swing);
        emit(2, side * .115, .89 - .44 * Math.cos(swing), -.44 * Math.sin(swing), swing + knee);
        let gesture = -swing * .7;
        if (!pose.moving && pose.activity === 'repair') gesture = -.95 + Math.sin(seconds * 2 + side) * .12;
        else if (!pose.moving && pose.activity === 'talk' && side > 0) gesture = -.65 + Math.sin(seconds * 1.7) * .18;
        else if (!pose.moving && pose.activity === 'browse') gesture = -.3;
        emit(3, side * .275, 1.39 + bob, 0, gesture, side * .07);
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
