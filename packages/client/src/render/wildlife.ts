import * as THREE from 'three';
import { MAX_VISIBLE_CREATURES, CREATURE_DEFS, type CreatureState } from '@shared/index';
import { VehicleGeometry } from './vehicle-geometry.js';
import { renderProfile } from './device-profile.js';

interface Track { target: CreatureState; x: number; y: number; z: number; yaw: number; phase: number }
const COLORS = [0x879674, 0xa7764c, 0x50636f, 0x619696, 0x716352, 0x4f827c];
const CORPSE_REST_HEIGHT = [.46, .40, .60, .32, .55, .5];
const SPECIES = CREATURE_DEFS.length;

/** At most twelve instanced draws for six species, with the same18/12 animal
 * cap. Joint motion stays local and
 * snapshot interpolation stops travel animation when movement stops. */
export class WildlifeModels {
  readonly group = new THREE.Group();
  private readonly capacity = renderProfile().touch ? 12 : MAX_VISIBLE_CREATURES;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly bodies: THREE.InstancedMesh[] = [];
  private readonly limbs: THREE.InstancedMesh[] = [];
  private readonly tracks = new Map<number, Track>();
  private readonly transform = new THREE.Object3D();
  private readonly root = new THREE.Object3D();
  private readonly matrix = new THREE.Matrix4();
  private readonly tint = new THREE.Color();

  constructor() {
    for (let species = 0; species < SPECIES; species++) {
      const body = new VehicleGeometry(), color = COLORS[species];
      const ellipsoid = (x: number, y: number, z: number, sx: number, sy: number, sz: number, tint: number) =>
        body.add(new THREE.IcosahedronGeometry(1, 1).scale(sx, sy, sz), tint, [x, y, z]);
      if (species === 0) {
        ellipsoid(0, 0.92, 0, 0.46, 0.46, 0.7, color);
        body.tube(0.18, [0, 0.94, -0.42], [0, 1.35, -0.62], color, 7, 0.13);
        ellipsoid(0, 1.32, -0.71, 0.24, 0.18, 0.28, 0xb5b592);
        for (const side of [-1, 1]) {
          body.tube(0.085, [side * .14, 1.4, -.65], [side * .27, 1.68, -.5], 0xd5c69d, 6, .015);
          ellipsoid(side * .18, 1.38, -.85, .055, .04, .06, 0x16211e);
        }
        body.tube(.055, [0, .99, .58], [0, .85, .94], color, 6, .018);
      } else if (species === 1) {
        ellipsoid(0, .68, 0, .4, .32, .7, color);
        ellipsoid(0, .79, -.64, .26, .25, .35, 0x694b38);
        for (const side of [-1, 1]) {
          ellipsoid(side * .2, .91, -.83, .065, .045, .06, 0xffbc57);
          body.tube(.07, [side * .15, .66, -.8], [side * .16, .48, -.91], 0xeadab6, 6, .015);
        }
        for (let i = 0; i < 5; i++) body.tube(.1, [0, .94, -.25 + i * .2], [0, 1.13, -.1 + i * .2], 0x4f453b, 5, .015);
        body.tube(.12, [0, .73, .57], [0, .6, 1.17], color, 7, .025);
      } else if (species === 2) {
        ellipsoid(0, .49, 0, .57, .32, .6, color);
        ellipsoid(0, .4, -.49, .28, .19, .22, 0x253b46);
        for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
          ellipsoid(side * (.1 + i * .09), .49, -.61 + i * .045, .042, .045, .04, 0x8debd7);
        }
        for (const side of [-1, 1]) body.tube(.07, [side * .17, .34, -.62], [side * .25, .19, -.82], 0xc2d4c7, 6, .015);
        body.tube(.07, [0, .6, .45], [0, .77, .82], 0x90b2bc, 6, .01);
      } else if (species === 3) {
        // A high-necked, two-legged runner reads differently from quadrupeds.
        ellipsoid(0, .98, .06, .32, .42, .47, color);
        body.tube(.11, [0, 1.12, -.22], [0, 1.72, -.35], 0x87b5a4, 7, .075);
        ellipsoid(0, 1.76, -.4, .16, .14, .2, 0xd0d4af);
        body.tube(.095, [0, 1.74, -.52], [0, 1.70, -.78], 0xc78b45, 6, .005);
        for (const side of [-1, 1]) {
          ellipsoid(side * .14, 1.8, -.48, .033, .04, .04, 0x112724);
          ellipsoid(side * .28, 1.0, .08, .11, .25, .32, 0x385c64);
        }
        for (let i = 0; i < 3; i++) {
          body.tube(.07, [(i - 1) * .07, 1.87, -.31], [(i - 1) * .14, 2.07 - Math.abs(i - 1) * .07, -.22], 0xddb46b, 5, .005);
          body.tube(.11, [(i - 1) * .1, 1.01, .4], [(i - 1) * .25, 1.28, .87], 0x36656c, 6, .02);
        }
      } else if (species === 4) {
        ellipsoid(0, .59, .03, .53, .45, .68, color);
        ellipsoid(0, .55, -.61, .32, .3, .4, 0x655044);
        ellipsoid(0, .48, -.9, .25, .16, .15, 0x9e8a72);
        for (const side of [-1, 1]) {
          ellipsoid(side * .28, .69, -.76, .047, .044, .05, 0x181a16);
          body.tube(.105, [side * .24, .4, -.76], [side * .4, .59, -.98], 0xe0cba4, 7, .015);
          body.tube(.13, [side * .28, .83, -.5], [side * .34, 1.07, -.39], 0x54433a, 6, .018);
        }
        for (let i = 0; i < 4; i++) {
          ellipsoid(0, .95, -.3 + i * .22, .4, .15, .18, i % 2 ? 0x7e735f : 0x594f45);
          body.tube(.075, [0, 1.03, -.28 + i * .23], [0, 1.21, -.2 + i * .23], 0xc1ad80, 5, .008);
        }
        body.tube(.06, [0, .72, .65], [0, .9, .91], 0x8d7b5e, 6, .02);
      } else {
        // Smooth luminous abdomen, split wing cases and long antennae.
        ellipsoid(0, .38, .1, .44, .3, .57, 0x4f9b91);
        for (const side of [-1, 1]) {
          ellipsoid(side * .2, .49, .1, .23, .18, .46, side < 0 ? 0x87d3a2 : 0x65bdad);
          body.tube(.035, [side * .14, .39, -.48], [side * .34, .77, -.84], 0xc6e8b0, 6, .01);
          ellipsoid(side * .35, .78, -.85, .05, .05, .05, 0xddeeb0);
          ellipsoid(side * .16, .37, -.65, .047, .05, .046, 0xf2d779);
        }
        ellipsoid(0, .3, -.43, .24, .18, .24, 0x324f53);
        for (let i = 0; i < 3; i++) ellipsoid(0, .67 - i * .015, -.12 + i * .18, .055, .035, .055, 0xe3e9a6);
      }
      const bodyMesh = body.mesh(this.material, 'creature-body');
      const legs = new VehicleGeometry();
      if (species === 3) {
        legs.tube(.07, [0, 0, 0], [0, -.34, .15], 0xa4ad89, 6, .045);
        legs.tube(.045, [0, -.34, .15], [0, -.76, -.04], 0xc6b98a, 6, .03);
        for (const toe of [-1, 0, 1]) legs.tube(.03, [0, -.77, -.03], [toe * .095, -.79, -.26], 0x847557, 5, .01);
      } else {
        legs.tube(.09, [0, 0, 0], [0, -.25, .11], color, 6, .065);
        legs.tube(.06, [0, -.25, .11], [0, -.5, -.02], color, 6, .035);
        legs.box(.15, .07, .24, 0, -.5, -.08, 0x263530);
      }
      const legMesh = legs.mesh(this.material, 'creature-limb');
      this.bodies.push(new THREE.InstancedMesh(bodyMesh.geometry, this.material, this.capacity));
      this.limbs.push(new THREE.InstancedMesh(legMesh.geometry, this.material, this.capacity * 6));
    }
    for (const mesh of [...this.bodies, ...this.limbs]) {
      mesh.count = 0; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(mesh);
    }
  }

  sync(creatures: readonly CreatureState[]): void {
    const ids = new Set<number>();
    for (const c of creatures.slice(0, this.capacity)) {
      if (!CREATURE_DEFS[c.species] || !Number.isFinite(c.x + c.y + c.z + c.yaw)) continue;
      ids.add(c.id);
      const existing = this.tracks.get(c.id);
      if (existing) existing.target = c;
      else this.tracks.set(c.id, { target: c, x: c.x, y: c.y, z: c.z, yaw: c.yaw, phase: ((c.id % 65536) * 2) % (Math.PI * 2) });
    }
    for (const id of this.tracks.keys()) if (!ids.has(id)) this.tracks.delete(id);
  }

  get count(): number { return this.tracks.size; }
  update(dt: number): void {
    const counts = Array(SPECIES).fill(0), legs = Array(SPECIES).fill(0), blend = 1 - Math.exp(-Math.max(0, dt) * 15);
    for (const c of this.tracks.values()) {
      const target = c.target, species = target.species;
      const previousX = c.x, previousZ = c.z;
      const factor = Math.hypot(c.x - target.x, c.y - target.y, c.z - target.z) > 8 ? 1 : blend;
      c.x += (target.x - c.x) * factor; c.y += (target.y - c.y) * factor; c.z += (target.z - c.z) * factor;
      c.yaw += Math.atan2(Math.sin(target.yaw - c.yaw), Math.cos(target.yaw - c.yaw)) * blend;
      const movement = Math.hypot(c.x - previousX, c.z - previousZ);
      c.phase += movement * 6;
      const stride = Math.min(1, movement / Math.max(.001, dt) / 2.5);
      this.root.position.set(c.x, c.y + (target.dead ? CORPSE_REST_HEIGHT[species] : 0), c.z);
      this.root.rotation.set(0, c.yaw, target.dead ? Math.PI / 2 : 0);
      this.root.updateMatrix(); this.bodies[species].setMatrixAt(counts[species], this.root.matrix);
      // Small fixed coat variations share the same models and materials.
      this.tint.setRGB(1, 1, 1).multiplyScalar(.84 + (target.id % 5) * .04);
      this.bodies[species].setColorAt(counts[species]++, this.tint);
      const arthropod = species === 2 || species === 5, pairs = arthropod ? 3 : species === 3 ? 1 : 2;
      for (let pair = 0; pair < pairs; pair++) for (const side of [-1, 1]) {
        this.transform.position.set(side * (arthropod ? species === 5 ? .37 : .5 : species === 3 ? .19 : .3),
          species === 0 ? .55 : species === 3 ? .8 : species === 5 ? .34 : .49,
          pairs === 1 ? .06 : (pair / (pairs - 1) - .5) * (species === 5 ? .68 : .85));
        const swing = Math.sin(c.phase + pair * Math.PI + (side > 0 ? Math.PI : 0)) * .55 * stride;
        this.transform.rotation.set(target.dead ? .8 : swing, 0, arthropod ? side * -.65 : 0);
        this.transform.scale.set(1, species === 2 ? 1.22 : species === 5 ? .82 : 1, 1);
        this.transform.updateMatrix(); this.matrix.multiplyMatrices(this.root.matrix, this.transform.matrix);
        this.limbs[species].setMatrixAt(legs[species]++, this.matrix);
      }
    }
    for (let i = 0; i < SPECIES; i++) {
      this.bodies[i].count = counts[i]; this.limbs[i].count = legs[i];
      for (const mesh of [this.bodies[i], this.limbs[i]]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        if (mesh.count) mesh.computeBoundingSphere();
      }
    }
  }

  dispose(): void {
    for (const mesh of [...this.bodies, ...this.limbs]) { mesh.geometry.dispose(); mesh.dispose(); }
    this.material.dispose(); this.group.clear(); this.tracks.clear();
  }
}
