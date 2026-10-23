import * as THREE from 'three';
import { MAX_VISIBLE_CREATURES, CREATURE_DEFS, type CreatureState } from '@shared/index';
import { VehicleGeometry } from './vehicle-geometry.js';
import { renderProfile } from './device-profile.js';
import { BossAttackModels } from './boss-attacks.js';

interface Track { target: CreatureState; x: number; y: number; z: number; yaw: number; phase: number }
const COLORS = [0x879674, 0xa7764c, 0x50636f, 0x619696, 0x716352, 0x4f827c,
  0x82906b, 0x766480, 0x6c8064, 0xc6bea4, 0x493b35, 0x4d4640, 0x4f929a, 0x487c83];
const CORPSE_REST_HEIGHT = [.46, .40, .60, .32, .55, .5, .3, .3, .5, 2, .5, 2.3, .5, 2];
const SPECIES = CREATURE_DEFS.length;

/** Only occupied species draw. Creature count and geometry stay bounded;
 * snapshot interpolation stops travel animation when movement stops. */
export class WildlifeModels {
  readonly group = new THREE.Group();
  private readonly capacity = renderProfile().touch ? 16 : MAX_VISIBLE_CREATURES;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly bodies: THREE.InstancedMesh[] = [];
  private readonly limbs: THREE.InstancedMesh[] = [];
  private readonly tracks = new Map<number, Track>();
  private readonly transform = new THREE.Object3D();
  private readonly root = new THREE.Object3D();
  private readonly matrix = new THREE.Matrix4();
  private readonly tint = new THREE.Color();
  private readonly warningMaterial = new THREE.MeshBasicMaterial({ color: 0xff873d, transparent: true, opacity: .85, depthWrite: false, side: THREE.DoubleSide });
  private readonly warnings = new THREE.InstancedMesh(new THREE.RingGeometry(.93, 1, 48).rotateX(-Math.PI / 2), this.warningMaterial, this.capacity);
  private readonly attacks = new BossAttackModels(this.capacity);
  private readonly labels = new Map<number, { sprite: THREE.Sprite; canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; health: number; status: string }>();

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
      } else if (species === 5) {
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
      } else if (CREATURE_DEFS[species].undead || species === 11) {
        // Tall skeletal silhouettes, ragged clothing and forward-reaching arms
        // distinguish infestations from the existing grazing animals.
        const giant = CREATURE_DEFS[species].boss, brute = species === 8, scale = giant ? species === 11 ? 6 : 5.3 : brute ? 1.5 : species === 7 ? .86 : 1;
        ellipsoid(0, 1.12 * scale, 0, .29 * scale, .4 * scale, .2 * scale, color);
        ellipsoid(0, 1.68 * scale, -.08 * scale, .22 * scale, .24 * scale, .2 * scale, giant ? 0xcac1a8 : 0xaaa98b);
        for (const side of [-1, 1]) {
          body.tube(.11 * scale, [side * .3 * scale, 1.36 * scale, 0], [side * .45 * scale, 1.05 * scale, -.4 * scale], color, 6, .085 * scale);
          body.tube(.085 * scale, [side * .45 * scale, 1.05 * scale, -.4 * scale], [side * .35 * scale, .98 * scale, -.74 * scale], giant ? 0xc5b89a : 0x969c7c, 6, .07 * scale);
          ellipsoid(side * .1 * scale, 1.74 * scale, -.245 * scale, .06 * scale, .055 * scale, .035 * scale, species === 11 ? 0xff681e : 0xe8c468);
          if (giant) for (let rib = 0; rib < 4; rib++)
            body.tube(.055 * scale, [side * .04 * scale, (1.05 + rib * .13) * scale, -.2 * scale], [side * .29 * scale, (1.01 + rib * .13) * scale, -.12 * scale], species === 11 ? 0xff9137 : 0xe2d3ae, 5, .03 * scale);
        }
        if (giant) for (let spike = -2; spike <= 2; spike++)
          body.tube(.1 * scale, [spike * .1 * scale, 1.83 * scale, 0], [spike * .2 * scale, (2.1 - Math.abs(spike) * .05) * scale, .1 * scale], species === 11 ? 0xb06937 : 0xddd1ac, 5, .005);
        else body.box(.52 * scale, .45 * scale, .37 * scale, 0, 1.03 * scale, .02 * scale, species === 7 ? 0x463f4b : 0x485143);
      } else {
        // Cinder and Nacre keep distinct mineral/crustacean life; neither world
        // inherits Meridian's humanoid undead roster.
        const giant = CREATURE_DEFS[species].boss, scale = giant ? 7 : species === 12 ? 1.2 : 1;
        ellipsoid(0, .67 * scale, .08 * scale, .63 * scale, .43 * scale, .78 * scale, color);
        ellipsoid(0, .56 * scale, -.63 * scale, .31 * scale, .25 * scale, .3 * scale, species === 10 ? 0x6c4436 : 0x88afa2);
        for (const side of [-1, 1]) {
          body.tube(.14 * scale, [side * .44 * scale, .61 * scale, -.25 * scale], [side * .83 * scale, .5 * scale, -.91 * scale], color, 6, .1 * scale);
          body.tube(.13 * scale, [side * .83 * scale, .5 * scale, -.91 * scale], [side * .61 * scale, .62 * scale, -1.09 * scale], 0xbcbda0, 6, .015 * scale);
          ellipsoid(side * .16 * scale, .74 * scale, -.82 * scale, .07 * scale, .075 * scale, .065 * scale, species === 10 ? 0xff9635 : 0xb9f3e2);
        }
        for (let spike = 0; spike < 4; spike++)
          body.tube(.16 * scale, [0, .96 * scale, (-.35 + spike * .3) * scale], [0, (1.2 + spike * .04) * scale, (-.2 + spike * .3) * scale], species === 10 ? 0xd67b3e : 0x9cccc4, 5, .015 * scale);
      }
      const bodyMesh = body.mesh(this.material, 'creature-body');
      const legs = new VehicleGeometry();
      if (CREATURE_DEFS[species].undead || species === 11) {
        legs.tube(.105, [0, 0, 0], [0, -.36, .07], 0x68665a, 6, .08);
        legs.tube(.075, [0, -.36, .07], [0, -.72, -.02], color, 6, .05);
        legs.box(.19, .11, .3, 0, -.72, -.09, 0x383a33);
      } else if (species === 3) {
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
    this.warnings.count = 0; this.warnings.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(this.warnings);
    this.group.add(...this.attacks.meshes);
  }

  sync(creatures: readonly CreatureState[], tick = 0): void {
    this.attacks.sync(creatures, tick);
    const ids = new Set<number>();
    for (const c of creatures.slice(0, this.capacity)) {
      if (!CREATURE_DEFS[c.species] || !Number.isFinite(c.x + c.y + c.z + c.yaw)) continue;
      ids.add(c.id);
      const existing = this.tracks.get(c.id);
      if (existing) existing.target = c;
      else this.tracks.set(c.id, { target: c, x: c.x, y: c.y, z: c.z, yaw: c.yaw, phase: ((c.id % 65536) * 2) % (Math.PI * 2) });
    }
    for (const id of this.tracks.keys()) if (!ids.has(id)) this.tracks.delete(id);
    for (const [id, label] of this.labels) if (!ids.has(id)) {
      label.sprite.material.map?.dispose(); label.sprite.material.dispose(); this.group.remove(label.sprite); this.labels.delete(id);
    }
  }

  get count(): number { return this.tracks.size; }
  get attackStats() { return { targetZones: this.attacks.rings.count, bolts: this.attacks.bolts.count, impacts: this.attacks.impacts.count }; }
  update(dt: number, tick = 0): void {
    this.attacks.update(tick);
    const counts = Array(SPECIES).fill(0), legs = Array(SPECIES).fill(0), blend = 1 - Math.exp(-Math.max(0, dt) * 15);
    let warningCount = 0;
    for (const c of this.tracks.values()) {
      const target = c.target, species = target.species, def = CREATURE_DEFS[species];
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
      const humanoid = def.undead || species === 11, arthropod = species === 2 || species === 5 || species >= 10 && !humanoid;
      const pairs = arthropod ? 3 : species === 3 || humanoid ? 1 : 2;
      const scale = humanoid ? def.boss ? species === 11 ? 6 : 5.3 : species === 8 ? 1.5 : species === 7 ? .86 : 1 :
        species === 13 ? 7 : species === 12 ? 1.2 : 1;
      for (let pair = 0; pair < pairs; pair++) for (const side of [-1, 1]) {
        this.transform.position.set(side * (arthropod ? species === 5 ? .37 : .5 : species === 3 || humanoid ? .19 : .3) * scale,
          (humanoid ? .76 : species === 0 ? .55 : species === 3 ? .8 : species === 5 ? .34 : .49) * scale,
          (pairs === 1 ? .06 : (pair / (pairs - 1) - .5) * (species === 5 ? .68 : .85)) * scale);
        const swing = Math.sin(c.phase + pair * Math.PI + (side > 0 ? Math.PI : 0)) * .55 * stride;
        this.transform.rotation.set(target.dead ? .8 : swing, 0, arthropod ? side * -.65 : 0);
        this.transform.scale.set(scale, scale * (species === 2 ? 1.22 : species === 5 ? .82 : 1), scale);
        this.transform.updateMatrix(); this.matrix.multiplyMatrices(this.root.matrix, this.transform.matrix);
        this.limbs[species].setMatrixAt(legs[species]++, this.matrix);
      }
      if (target.windingUp && !target.dead) {
        this.transform.position.set(c.x, c.y + .12, c.z); this.transform.rotation.set(0, 0, 0);
        this.transform.scale.setScalar(def.reach ?? 1.7); this.transform.updateMatrix();
        this.warnings.setMatrixAt(warningCount++, this.transform.matrix);
      }
      if (def.boss) this.updateBossLabel(c, tick);
    }
    this.warnings.count = warningCount; this.warnings.instanceMatrix.needsUpdate = true;
    if (warningCount) this.warnings.computeBoundingSphere();
    for (let i = 0; i < SPECIES; i++) {
      this.bodies[i].count = counts[i]; this.limbs[i].count = legs[i];
      for (const mesh of [this.bodies[i], this.limbs[i]]) {
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
        if (mesh.count) mesh.computeBoundingSphere();
      }
    }
  }

  private updateBossLabel(track: Track, tick: number): void {
    if (typeof document === 'undefined') return;
    const c = track.target, def = CREATURE_DEFS[c.species];
    let label = this.labels.get(c.id);
    if (!label) {
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
      const context = canvas.getContext('2d'); if (!context) return;
      const texture = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
      sprite.scale.set(16, 4, 1); this.group.add(sprite);
      label = { sprite, canvas, context, health: -1, status: '' }; this.labels.set(c.id, label);
    }
    label.sprite.position.set(track.x, track.y + def.height + 2.8, track.z); label.sprite.visible = !c.dead;
    const health = Math.round(Math.max(0, Math.min(1, c.health ?? 1)) * 100);
    const ranged = c.rangedAttack && tick < c.rangedAttack.impactTick;
    const status = c.windingUp ? 'SLAM INCOMING — LEAVE THE RING' : ranged
      ? 'RANGED ATTACK — MOVE OUT OF THE MARKER' : health + '% · TEAM THREAT';
    if (health === label.health && status === label.status) return;
    label.health = health; label.status = status;
    const ctx = label.context; ctx.clearRect(0, 0, 512, 128);
    ctx.fillStyle = '#15211ce8'; ctx.fillRect(0, 0, 512, 128);
    ctx.fillStyle = '#faf0d8'; ctx.textAlign = 'center'; ctx.font = 'bold 30px sans-serif';
    ctx.fillText(def.name.toUpperCase(), 256, 36);
    ctx.fillStyle = '#43362e'; ctx.fillRect(20, 51, 472, 18);
    ctx.fillStyle = '#df9b51'; ctx.fillRect(20, 51, 472 * health / 100, 18);
    ctx.font = `bold ${ranged ? 18 : 22}px sans-serif`; ctx.fillStyle = c.windingUp || ranged ? '#ffac68' : '#d9ddce';
    ctx.fillText(status, 256, 104);
    label.sprite.material.map!.needsUpdate = true;
  }

  dispose(): void {
    this.attacks.dispose();
    for (const mesh of [...this.bodies, ...this.limbs]) { mesh.geometry.dispose(); mesh.dispose(); }
    for (const label of this.labels.values()) { label.sprite.material.map?.dispose(); label.sprite.material.dispose(); }
    this.labels.clear(); this.warnings.geometry.dispose(); this.warnings.dispose(); this.warningMaterial.dispose();
    this.material.dispose(); this.group.clear(); this.tracks.clear();
  }
}
