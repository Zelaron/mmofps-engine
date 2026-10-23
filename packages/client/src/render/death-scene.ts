import * as THREE from 'three';
import type { DeathMotion } from '@shared/protocol';
import type { World } from '@shared/worldgen';
import { buildRig, disposeRig, type Rig } from './players.js';
import { createCorpseMotion, DEATH_CAMERA_SECONDS, stepCorpseMotion, type CorpseMotion } from '../death-motion.js';

interface Body { root: THREE.Group; rig: Rig; motion: CorpseMotion }
const limbEnd = new THREE.Vector3();

/** Live aiming uses sibling arm segments. Keep each elbow and wrist attached
 * while relaxing that pose, using the same joint lengths as the live rig. */
function poseCorpseArms(rig: Rig, fall: number): void {
  for (const arm of rig.arms) {
    arm.upper.rotation.set(.12 * fall, 0, arm.side * .55 * fall);
    arm.forearm.position.copy(arm.upper.position)
      .add(limbEnd.set(0, -.335, 0).applyQuaternion(arm.upper.quaternion));
    arm.forearm.rotation.set(.24 + .2 * fall, 0, arm.side * .55 * fall);
    arm.hand.position.copy(arm.forearm.position)
      .add(limbEnd.set(0, -.335, 0).applyQuaternion(arm.forearm.quaternion));
    arm.hand.quaternion.copy(arm.forearm.quaternion);
  }
}

export class DeathScene {
  readonly group = new THREE.Group();
  private readonly bodies = new Map<number, Body>();
  private localId = -1;
  private began = -1;
  private readonly from = new THREE.Vector3();
  private readonly fromRotation = new THREE.Quaternion();
  private readonly lookRotation = new THREE.Quaternion();
  private readonly settledRotation = new THREE.Quaternion();
  private readonly pose = new THREE.Euler(0, 0, 0, 'YXZ');
  private readonly target = new THREE.Vector3();
  private readonly eye = new THREE.Vector3();
  private readonly caption = document.createElement('aside');

  constructor() {
    this.caption.id = 'death-moment'; this.caption.hidden = true;
    this.caption.style.cssText = 'position:fixed;left:50%;bottom:12%;transform:translateX(-50%);z-index:18;text-align:center;pointer-events:none;color:#fff2de;text-shadow:0 2px 8px #000;font:500 16px Barlow,sans-serif;letter-spacing:.08em';
    document.body.append(this.caption);
  }

  has(id: number): boolean { return this.bodies.has(id); }
  get active(): boolean { return this.localId >= 0 && this.bodies.has(this.localId); }
  get cameraActive(): boolean { return !this.caption.hidden; }
  get position(): CorpseMotion | undefined { return this.bodies.get(this.localId)?.motion; }

  begin(id: number, motion: DeathMotion, local: boolean, camera: THREE.Camera, now: number, cause = ''): void {
    this.remove(id);
    const root = new THREE.Group(), rig = buildRig(id);
    rig.group.position.y = -.9; root.add(rig.group); this.group.add(root);
    const body = { root, rig, motion: createCorpseMotion(motion) }; this.bodies.set(id, body);
    root.position.set(body.motion.x, body.motion.y, body.motion.z);
    rig.gunMount.visible = false;
    poseCorpseArms(rig, 0);
    if (local) {
      this.localId = id; this.began = now; this.from.copy(camera.position); this.fromRotation.copy(camera.quaternion);
      this.caption.textContent = cause ? `ELIMINATED · ${cause}` : 'ELIMINATED'; this.caption.hidden = false;
    }
    while (this.bodies.size > 24) {
      const oldest = [...this.bodies.keys()].find(key => key !== this.localId);
      if (oldest === undefined) break; this.remove(oldest);
    }
  }

  remove(id: number): void {
    const body = this.bodies.get(id); if (body) { disposeRig(body.rig); this.group.remove(body.root); }
    this.bodies.delete(id);
    if (id === this.localId) { this.localId = -1; this.caption.hidden = true; }
    // Rig meshes share the live-player geometry/material cache.
  }
  clear(): void { for (const id of this.bodies.keys()) this.remove(id); this.caption.hidden = true; }

  update(world: World, camera: THREE.PerspectiveCamera, dt: number, now: number, showCamera: boolean): void {
    for (const [id, body] of this.bodies) {
      const m = body.motion; stepCorpseMotion(m, world, dt);
      if (m.age > 5) { this.remove(id); continue; }
      body.root.position.set(m.x, m.y, m.z);
      const fall = Math.min(1, m.age / .65), easing = fall * fall * (3 - 2 * fall);
      const tumble = m.airborne && !m.grounded ? m.age * 2.8 : 0;
      this.pose.set(m.airborne && !m.grounded ? Math.sin(tumble) * .8 : .12 * easing, m.yaw, Math.PI * .5 * easing + tumble, 'YXZ');
      if (m.airborne && m.grounded) {
        this.settledRotation.setFromEuler(this.pose);
        body.root.quaternion.slerp(this.settledRotation, 1 - Math.exp(-14 * dt));
      } else body.root.rotation.copy(this.pose);
      body.rig.head.rotation.x = .25 * easing;
      body.rig.kneeL.rotation.x = .35 * easing; body.rig.kneeR.rotation.x = .7 * easing;
      poseCorpseArms(body.rig, easing);
    }
    const local = this.bodies.get(this.localId), elapsed = now - this.began;
    this.caption.hidden = !showCamera || !local || elapsed >= DEATH_CAMERA_SECONDS;
    if (!local || !showCamera || elapsed >= DEATH_CAMERA_SECONDS) return;
    const m = local.motion;
    this.target.set(m.x, m.y + .25, m.z);
    this.eye.set(m.x + Math.sin(m.yaw) * 5 + Math.cos(m.yaw) * 2,
      m.y + 2.8, m.z + Math.cos(m.yaw) * 5 - Math.sin(m.yaw) * 2);
    const blend = Math.min(1, Math.max(0, elapsed / .32));
    this.eye.lerpVectors(this.from, this.eye, blend * blend * (3 - 2 * blend));
    const delta = this.eye.clone().sub(this.target), length = delta.length();
    if (length > .01) {
      delta.divideScalar(length);
      const hit = world.trace(this.target.x, this.target.y, this.target.z, delta.x, delta.y, delta.z, length);
      if (hit.hit) this.eye.copy(this.target).addScaledVector(delta, Math.max(.35, hit.dist - .25));
    }
    camera.position.copy(this.eye); camera.lookAt(this.target);
    this.lookRotation.copy(camera.quaternion);
    camera.quaternion.slerpQuaternions(this.fromRotation, this.lookRotation, blend * blend * (3 - 2 * blend));
  }
}
