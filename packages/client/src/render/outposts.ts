import * as THREE from 'three';
import { outpostBoxes, OUTPOST_VISIBLE_LIMIT, type Outpost, type OutpostSite } from '@shared/outposts';
import { VehicleGeometry } from './vehicle-geometry.js';
import { createIndustrialMaterial } from './industrial-material.js';

function model(type: number, material: THREE.Material, lit: boolean): THREE.BufferGeometry {
  const m = new VehicleGeometry(), white = 0xaabcb8, dark = 0x243c48, trim = 0xcba95e;
  const accent = type === 1 ? 0x8de5b6 : 0x80d8f2;
  if (!lit) {
    const boxes = outpostBoxes({ type, x: 0, y: 0, z: 0, facing: 0 });
    for (const b of boxes) {
      if (b.top !== undefined) {
        const left = b.x - b.hx, back = b.z - b.hz, front = b.z + b.hz, bottom = b.y - b.hy;
        m.prism([[left, bottom, back], [left, b.top + b.hz * b.slopeZ!, back], [left, b.top - b.hz * b.slopeZ!, front], [left, bottom, front]], [b.hx * 2, 0, 0], dark);
      } else m.box(b.hx * 2, b.hy * 2, b.hz * 2, b.x, b.y, b.z, b.hy > .7 ? white : dark);
    }
    if (type === 0) {
      for (const x of [-2.5, 2.5]) for (const z of [-2.5, 2.5]) {
        m.add(new THREE.CylinderGeometry(.42, .52, .12, 12), trim, [x, -.52, z]);
        m.box(.5, .12, .5, x, .24, z, trim);
      }
      for (const x of [-1.52, 1.52]) for (const z of [-1.5, 0, 1.5]) {
        m.box(2.75, .07, 1.3, x, 3.34, z, 0x244b67);
        for (let n = -1; n <= 1; n++) m.box(.025, .075, 1.3, x + n * .82, 3.345, z, 0x648b9a);
      }
      for (const x of [-2.4, 2.4]) m.box(.55, .38, 3.5, x, .39, -.4, dark);
      m.box(1.2, .3, .8, 0, .35, -2.3, trim);
    } else {
      for (const x of [-.9, .9]) m.add(new THREE.CylinderGeometry(.15, .2, 1.45, 10), white, [x, .98, .4]);
      m.box(1.35, .35, .12, 0, 1.36, .69, 0x102b36, -.15);
      for (let y = .45; y <= 1.01; y += .14) m.box(1.15, .05, .04, 0, y, -.68, dark);
      m.box(.9, .2, .15, 0, .35, .74, trim);
      m.box(.09, 1.1, .09, .9, 2.3, -.8, dark);
      m.box(2.4, .07, 1.15, 0, 2.8, -.6, 0x244b67, .15);
    }
  } else if (type === 0) {
    for (const x of [-2.65, 2.65]) m.box(.035, .07, 4.8, x, 3, 0, accent);
    for (const x of [-1.1, 1.1]) m.box(.5, .015, .06, x, .21, 2.7, trim);
  } else {
    m.box(1.08, .22, .035, 0, 1.36, .76, accent, -.15);
    if (type === 1) { m.box(.55, .15, .04, 0, .78, .68, accent); m.box(.15, .55, .04, 0, .78, .685, accent); }
    else for (const x of [-.25, 0, .25]) m.box(.12, .4, .04, x, .78, .685, accent);
    m.add(new THREE.SphereGeometry(.1, 8, 6), accent, [.9, 2.87, -.8]);
  }
  return m.mesh(material, 'field-camp').geometry;
}
export class OutpostRenderer {
  readonly group = new THREE.Group();
  private readonly metal = createIndustrialMaterial();
  private readonly lamps = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
  private readonly ghostMaterial = new THREE.MeshBasicMaterial({ color: 0x6dedd2, transparent: true, opacity: .28, depthWrite: false });
  private readonly bodies: THREE.InstancedMesh[] = [];
  private readonly lights: THREE.InstancedMesh[] = [];
  private readonly ghosts: THREE.Mesh[] = [];
  private readonly transform = new THREE.Object3D();
  constructor() {
    this.group.name = 'player-field-camps';
    for (let type = 0; type < 3; type++) {
      const geometry = model(type, this.metal, false), glow = model(type, this.lamps, true);
      const body = new THREE.InstancedMesh(geometry, this.metal, OUTPOST_VISIBLE_LIMIT), light = new THREE.InstancedMesh(glow, this.lamps, OUTPOST_VISIBLE_LIMIT);
      body.count = light.count = 0; body.visible = light.visible = false; body.castShadow = body.receiveShadow = true;
      const ghost = new THREE.Mesh(geometry, this.ghostMaterial); ghost.visible = false;
      this.bodies.push(body); this.lights.push(light); this.ghosts.push(ghost); this.group.add(body, light, ghost);
    }
  }
  receive(sites: readonly Outpost[]): void {
    for (const mesh of [...this.bodies, ...this.lights]) mesh.count = 0;
    for (const s of sites) {
      this.transform.position.set(s.x, s.y, s.z); this.transform.rotation.set(0, s.facing * Math.PI / 2, 0); this.transform.updateMatrix();
      for (const mesh of [this.bodies[s.type], this.lights[s.type]]) mesh.setMatrixAt(mesh.count++, this.transform.matrix);
    }
    for (const mesh of [...this.bodies, ...this.lights]) {
      mesh.visible = mesh.count > 0; mesh.instanceMatrix.needsUpdate = true; if (mesh.count) mesh.computeBoundingSphere();
    }
  }
  preview(site: OutpostSite | null, valid: boolean): void {
    for (const ghost of this.ghosts) ghost.visible = false;
    if (!site) return;
    const ghost = this.ghosts[site.type]; ghost.visible = true; ghost.position.set(site.x, site.y, site.z); ghost.rotation.y = site.facing * Math.PI / 2;
    this.ghostMaterial.color.setHex(valid ? 0x6dedd2 : 0xffac72);
  }
  dispose(): void {
    for (const mesh of [...this.bodies, ...this.lights]) { mesh.geometry.dispose(); mesh.dispose(); }
    this.metal.dispose(); this.lamps.dispose(); this.ghostMaterial.dispose(); this.group.clear();
  }
}
