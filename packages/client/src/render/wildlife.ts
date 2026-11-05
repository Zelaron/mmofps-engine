import * as THREE from 'three';
import { MAX_VISIBLE_CREATURES, CREATURE_DEFS, type CreatureState } from '@shared/index';
import { renderProfile } from './device-profile.js';
import { BossAttackModels } from './boss-attacks.js';
import { buildSpeciesModel, type GlowPoint } from './creature-models.js';
import { RigPoser, animateTrackSecondary, deathVariant, hash01, strideLength, type CreatureTrack } from './creature-rigs.js';

const SPECIES = CREATURE_DEFS.length;
const TAU = Math.PI * 2;
/** Glow points (eyes, lures, embers) per creature never exceed this. */
const MAX_GLOW = 12;
const approach = (step: number, rate: number) => 1 - Math.exp(-step * rate);

interface SpeciesRender {
  poser: RigPoser;
  meshes: THREE.InstancedMesh[];
  /** First pose slot of each part mesh. */
  bases: number[];
  glow: GlowPoint[];
  glowSlots: number[];
  glowColors: THREE.Color[];
  /** One conservative sphere shared by every part mesh of the species. */
  sphere: THREE.Sphere;
  centerY: number; radius: number;
  count: number;
}

/**
 * Articulated procedural wildlife. Each species owns one InstancedMesh per
 * body part (torso, neck, head, tail, limb segments...) posed every frame from
 * a tiny CPU skeleton: planted-foot gaits with two-bone IK, idle breathing and
 * looking, alert/wind-up postures and a grounded death collapse. Only occupied
 * species draw; per-frame work allocates nothing.
 */
export class WildlifeModels {
  readonly group = new THREE.Group();
  private readonly capacity = renderProfile().touch ? 16 : MAX_VISIBLE_CREATURES;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true });
  private readonly glowMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private readonly species: SpeciesRender[] = [];
  private readonly glow: THREE.InstancedMesh;
  private readonly tracks = new Map<number, CreatureTrack>();
  /** Insertion-ordered tracks for allocation-free iteration in update(). */
  private readonly list: CreatureTrack[] = [];
  private readonly seen = new Set<number>();
  private readonly slots: THREE.Matrix4[] = [];
  private readonly root = new THREE.Matrix4();
  private readonly matrix = new THREE.Matrix4();
  private readonly transform = new THREE.Object3D();
  private readonly position = new THREE.Vector3();
  private readonly rotation = new THREE.Quaternion();
  private readonly size = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly tint = new THREE.Color();
  private readonly sphere = new THREE.Sphere();
  private readonly glowSphere = new THREE.Sphere();
  private readonly warningMaterial = new THREE.MeshBasicMaterial({ color: 0xff873d, transparent: true, opacity: .85, depthWrite: false, side: THREE.DoubleSide });
  private readonly warnings = new THREE.InstancedMesh(new THREE.RingGeometry(.93, 1, 48).rotateX(-Math.PI / 2), this.warningMaterial, this.capacity);
  private readonly attacks = new BossAttackModels(this.capacity);
  private readonly labels = new Map<number, { sprite: THREE.Sprite; canvas: HTMLCanvasElement; context: CanvasRenderingContext2D; health: number; status: string }>();

  constructor() {
    let maxSlots = 0;
    const white = new THREE.Color(1, 1, 1);
    for (let species = 0; species < SPECIES; species++) {
      const model = buildSpeciesModel(species), poser = new RigPoser(model.rig);
      maxSlots = Math.max(maxSlots, poser.slots);
      const meshes: THREE.InstancedMesh[] = [], bases: number[] = [];
      let base = 0;
      for (const part of poser.layout) {
        const geometry = model.parts[part.name];
        if (!geometry) throw new Error(`creature ${species} lacks part ${part.name}`);
        const mesh = new THREE.InstancedMesh(geometry, this.material, this.capacity * part.instances);
        mesh.name = `creature-${species}-${part.name}`;
        mesh.count = 0; mesh.visible = false; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        // Allocate instance colors now; update() only rewrites them.
        mesh.setColorAt(0, white); mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
        meshes.push(mesh); bases.push(base); base += part.instances;
        this.group.add(mesh);
      }
      const glowSlots = model.glow.map(point => {
        const index = poser.layout.findIndex(part => part.name === point.part);
        if (index < 0) throw new Error(`creature ${species} glow on missing part ${point.part}`);
        return bases[index] + (point.instance ?? 0);
      });
      this.species.push({ poser, meshes, bases, glow: model.glow, glowSlots, glowColors: model.glow.map(point => new THREE.Color(point.color)),
        sphere: new THREE.Sphere(), centerY: 0, radius: 1, count: 0 });
      for (const mesh of meshes) mesh.boundingSphere = this.species[species].sphere;
    }
    for (let i = 0; i < maxSlots; i++) this.slots.push(new THREE.Matrix4());
    for (let species = 0; species < SPECIES; species++) this.calibrate(this.species[species], species);
    this.glow = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), this.glowMaterial, this.capacity * MAX_GLOW);
    this.glow.name = 'creature-glow'; this.glow.count = 0; this.glow.visible = false;
    this.glow.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.glow.setColorAt(0, white);
    this.glow.instanceColor!.setUsage(THREE.DynamicDrawUsage); this.glow.boundingSphere = this.glowSphere;
    this.group.add(this.glow);
    this.warnings.name = 'creature-warnings';
    this.warnings.count = 0; this.warnings.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(this.warnings);
    this.group.add(...this.attacks.meshes);
    // Instances carry every pose; the meshes themselves never move.
    for (const mesh of this.group.children) { mesh.updateMatrix(); mesh.matrixAutoUpdate = false; }
  }

  /** Rest corpses on the ground from actual vertices, and size culling spheres. */
  private calibrate(render: SpeciesRender, species: number): void {
    const rig = render.poser.rig, track = this.createTrack({ id: 0, species, x: 0, y: 0, z: 0, yaw: 0, speed: 0, alert: false }, 0);
    track.scale = 1; this.root.identity();
    const box = new THREE.Box3(), part = new THREE.Box3(), point = new THREE.Vector3();
    // Culling bounds use transformed part boxes; the corpse rest height uses exact vertices.
    const bounds = () => {
      render.poser.pose(track, this.root, this.slots);
      render.meshes.forEach((mesh, index) => {
        for (let k = 0; k < render.poser.layout[index].instances; k++)
          box.union(part.copy(mesh.geometry.boundingBox!).applyMatrix4(this.slots[render.bases[index] + k]));
      });
    };
    const lowest = () => {
      render.poser.pose(track, this.root, this.slots);
      let low = Infinity;
      render.meshes.forEach((mesh, index) => {
        const positions = mesh.geometry.getAttribute('position');
        for (let k = 0; k < render.poser.layout[index].instances; k++) {
          const slot = this.slots[render.bases[index] + k];
          for (let i = 0; i < positions.count; i++) low = Math.min(low, point.fromBufferAttribute(positions, i).applyMatrix4(slot).y);
        }
      });
      return low;
    };
    bounds();
    track.dead = 10; track.target = { ...track.target, dead: true };
    for (let variant = 0; variant < 2; variant++) {
      track.side = variant ? 1 : -1; track.seed = variant ? .75 : .25;
      if (deathVariant(rig, track) !== variant) throw new Error('death variant mismatch');
      rig.deadDrop[variant] = .3;
      rig.deadDrop[variant] += .012 - lowest();
      bounds();
    }
    // Animation (gallops, raised arms, lunges) stays inside a padded sphere.
    const center = box.getCenter(point);
    render.centerY = center.y;
    render.radius = box.getSize(new THREE.Vector3()).length() * .5 * 1.3 + Math.hypot(center.x, center.z);
  }

  private createTrack(c: CreatureState, phase: number): CreatureTrack {
    const seed = hash01(c.id % 65536, Math.floor(c.id / 65536) % 65536);
    const def = CREATURE_DEFS[c.species];
    return { target: c, x: c.x, y: c.y, z: c.z, yaw: c.yaw, phase, speed: 0, move: 0, turn: 0, climb: 0,
      alert: c.alert && !c.dead ? 1 : 0, windup: 0, strike: 0, strikeTime: -1, cast: 0,
      dead: c.dead ? 10 : -1, side: seed > .5 ? 1 : -1, time: seed * 20, seed,
      scale: def?.boss ? 1 : .96 + .08 * hash01(seed * 97, 5), lookYaw: 0, lookPitch: 0, tail: 0, tailVelocity: 0, tail2: 0,
      winding: !!c.windingUp };
  }

  sync(creatures: readonly CreatureState[], tick = 0): void {
    this.attacks.sync(creatures, tick);
    const ids = this.seen; ids.clear();
    const limit = Math.min(creatures.length, this.capacity);
    for (let i = 0; i < limit; i++) {
      const c = creatures[i];
      if (!CREATURE_DEFS[c.species] || !Number.isFinite(c.x + c.y + c.z + c.yaw)) continue;
      ids.add(c.id);
      const existing = this.tracks.get(c.id);
      if (existing) existing.target = c;
      else this.tracks.set(c.id, this.createTrack(c, ((c.id % 65536) * 2) % TAU));
    }
    for (const id of this.tracks.keys()) if (!ids.has(id)) this.tracks.delete(id);
    this.list.length = 0;
    for (const track of this.tracks.values()) this.list.push(track);
    for (const [id, label] of this.labels) if (!ids.has(id)) {
      label.sprite.material.map?.dispose(); label.sprite.material.dispose(); this.group.remove(label.sprite); this.labels.delete(id);
    }
  }

  get count(): number { return this.tracks.size; }
  get attackStats() { return { targetZones: this.attacks.rings.count, bolts: this.attacks.bolts.count, impacts: this.attacks.impacts.count }; }

  /** Ease displayed state toward the snapshot and derive gait inputs from actual travel. */
  private advance(c: CreatureTrack, step: number, blend: number, tick: number): void {
    const target = c.target, render = this.species[target.species], rig = render.poser.rig;
    const previousX = c.x, previousY = c.y, previousZ = c.z;
    const gx = c.x - target.x, gy = c.y - target.y, gz = c.z - target.z, jump = gx * gx + gy * gy + gz * gz > 64;
    const factor = jump ? 1 : blend;
    c.x += (target.x - c.x) * factor; c.y += (target.y - c.y) * factor; c.z += (target.z - c.z) * factor;
    const yawStep = Math.atan2(Math.sin(target.yaw - c.yaw), Math.cos(target.yaw - c.yaw)) * factor;
    c.yaw += yawStep;
    const dead = !!target.dead;
    if (!jump && step > 0) {
      const mx = c.x - previousX, mz = c.z - previousZ, moved = Math.sqrt(mx * mx + mz * mz);
      // Phase follows displayed travel (and in-place turning steps), so
      // planted feet never skate regardless of the snapshot speed field.
      const stride = strideLength(rig.gait, c.speed) * rig.scale * c.scale;
      if (!dead) c.phase += (moved + Math.abs(yawStep) * .35 * rig.scale * c.scale) * TAU / stride;
      const k = 1 - Math.exp(-step * 5);
      c.speed += (Math.min(30, moved / step / (rig.scale * c.scale)) - c.speed) * k;
      c.turn += (yawStep / step - c.turn) * (1 - Math.exp(-step * 6));
      const slope = moved > 1e-4 ? Math.atan2(c.y - previousY, moved) : 0;
      c.climb += (Math.max(-.5, Math.min(.5, slope)) - c.climb) * (1 - Math.exp(-step * 3));
    }
    const moving = !dead && (c.speed > .12 || Math.abs(c.turn) > .6);
    c.move += ((moving ? 1 : 0) - c.move) * approach(step, moving ? 5 : 3.5);
    c.alert += ((target.alert && !dead ? 1 : 0) - c.alert) * approach(step, 4);
    c.windup += ((target.windingUp && !dead ? 1 : 0) - c.windup) * approach(step, 6);
    const ranged = target.rangedAttack;
    // Arms rise while a ranged bolt charges and come down when it is released.
    c.cast += ((ranged && !dead && tick < ranged.fireTick ? 1 : 0) - c.cast) * approach(step, 4);
    if (c.winding && !target.windingUp && !dead) c.strikeTime = 0;
    c.winding = !!target.windingUp;
    if (c.strikeTime >= 0) {
      c.strikeTime += step;
      c.strike = c.strikeTime < .5 ? Math.sin(Math.PI * c.strikeTime / .5) : 0;
      if (c.strikeTime >= .5) c.strikeTime = -1;
    }
    if (dead) c.dead = c.dead < 0 ? 0 : c.dead + step; else c.dead = -1;
    c.time += step;
    animateTrackSecondary(c, step, rig.look);
  }

  update(dt: number, tick = 0): void {
    this.attacks.update(tick);
    const step = Math.max(0, dt), blend = 1 - Math.exp(-step * 15);
    for (let s = 0; s < SPECIES; s++) this.species[s].count = 0;
    let warningCount = 0, glowCount = 0;
    this.glowSphere.makeEmpty();
    for (let i = 0; i < this.list.length; i++) {
      const c = this.list[i], target = c.target, species = target.species, def = CREATURE_DEFS[species];
      const render = this.species[species], poser = render.poser;
      this.advance(c, step, blend, tick);
      const scale = poser.rig.scale * c.scale;
      this.rotation.setFromAxisAngle(this.up, c.yaw);
      this.root.compose(this.position.set(c.x, c.y, c.z), this.rotation, this.size.set(scale, scale, scale));
      poser.pose(c, this.root, this.slots);
      const n = render.count++;
      // Small fixed coat variations share the same models and materials.
      this.tint.setRGB(1, 1, 1).multiplyScalar(.86 + (target.id % 5) * .035);
      for (let p = 0; p < render.meshes.length; p++) {
        const mesh = render.meshes[p], per = poser.layout[p].instances, base = render.bases[p];
        for (let k = 0; k < per; k++) { mesh.setMatrixAt(n * per + k, this.slots[base + k]); mesh.setColorAt(n * per + k, this.tint); }
      }
      // Eyes and lures stay lit while alive and fade out with the collapse.
      const lit = c.dead < 0 ? 1 : Math.max(.12, 1 - c.dead / .6);
      for (let g = 0; g < render.glow.length && glowCount < this.glow.instanceMatrix.count; g++) {
        const point = render.glow[g];
        this.transform.position.set(point.at[0], point.at[1], point.at[2]); this.transform.rotation.set(0, 0, 0);
        this.transform.scale.set(point.size[0], point.size[1], point.size[2]); this.transform.updateMatrix();
        this.matrix.multiplyMatrices(this.slots[render.glowSlots[g]], this.transform.matrix);
        this.glow.setMatrixAt(glowCount, this.matrix);
        const pulse = point.pulse ? .75 + .25 * Math.sin(c.time * point.pulse + c.seed * 9) : 1;
        this.tint.copy(render.glowColors[g]).multiplyScalar(lit * pulse);
        this.glow.setColorAt(glowCount++, this.tint);
      }
      this.sphere.center.set(c.x, c.y + render.centerY * scale, c.z); this.sphere.radius = render.radius * scale;
      if (n === 0) render.sphere.copy(this.sphere); else render.sphere.union(this.sphere);
      if (render.glow.length) this.glowSphere.union(this.sphere);
      if (target.windingUp && !target.dead) {
        this.transform.position.set(c.x, c.y + .12, c.z); this.transform.rotation.set(0, 0, 0);
        this.transform.scale.setScalar(def.reach ?? 1.7); this.transform.updateMatrix();
        this.warnings.setMatrixAt(warningCount++, this.transform.matrix);
      }
      if (def.boss) this.updateBossLabel(c, tick);
    }
    this.warnings.count = warningCount; this.warnings.visible = warningCount > 0;
    if (warningCount) { this.warnings.instanceMatrix.needsUpdate = true; this.warnings.computeBoundingSphere(); }
    this.glow.count = glowCount; this.glow.visible = glowCount > 0;
    if (glowCount) { this.glow.instanceMatrix.needsUpdate = true; this.glow.instanceColor!.needsUpdate = true; }
    for (let s = 0; s < SPECIES; s++) {
      const render = this.species[s], count = render.count;
      for (let p = 0; p < render.meshes.length; p++) {
        const mesh = render.meshes[p];
        mesh.count = count * render.poser.layout[p].instances; mesh.visible = count > 0;
        if (count) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor!.needsUpdate = true; }
      }
    }
  }

  private updateBossLabel(track: CreatureTrack, tick: number): void {
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
    for (const render of this.species) for (const mesh of render.meshes) { mesh.geometry.dispose(); mesh.dispose(); }
    this.glow.geometry.dispose(); this.glow.dispose(); this.glowMaterial.dispose();
    for (const label of this.labels.values()) { label.sprite.material.map?.dispose(); label.sprite.material.dispose(); }
    this.labels.clear(); this.warnings.geometry.dispose(); this.warnings.dispose(); this.warningMaterial.dispose();
    this.material.dispose(); this.group.clear(); this.tracks.clear(); this.list.length = 0;
  }
}
