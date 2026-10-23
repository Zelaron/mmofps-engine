import * as THREE from 'three';
import { CREATURE_DEFS, TICK_RATE, type CreatureState } from '@shared/index';

type Attack = NonNullable<CreatureState['rangedAttack']>;
const IMPACT_SECONDS = .65;
const attackTint = (species: number) => species === 11 ? 0xff873d : species === 13 ? 0x72e8fa : 0xc2efa3;

/** Playback follows committed server coordinates and ticks, never the current
 * camera, victim or moving caster. Late snapshots enter the existing flight. */
export function bossAttackPose(attack: Attack, tick: number) {
  if (tick < attack.fireTick) return { phase: 'charge' as const, x: attack.originX, y: attack.originY, z: attack.originZ, progress: 0 };
  if (tick >= attack.impactTick) return { phase: 'impact' as const, x: attack.x, y: attack.y, z: attack.z,
    progress: Math.min(1, (tick - attack.impactTick) / (TICK_RATE * IMPACT_SECONDS)) };
  const progress = Math.max(0, Math.min(1, (tick - attack.fireTick) / Math.max(1, attack.impactTick - attack.fireTick)));
  const distance = Math.hypot(attack.x - attack.originX, attack.y - attack.originY, attack.z - attack.originZ);
  const arc = Math.min(80, Math.max(8, distance * .08));
  return { phase: 'flight' as const, progress,
    x: attack.originX + (attack.x - attack.originX) * progress,
    y: attack.originY + (attack.y - attack.originY) * progress + 4 * arc * progress * (1 - progress),
    z: attack.originZ + (attack.z - attack.originZ) * progress };
}

/** Three fixed pools: target rings, charging/flying bolts and short impacts. */
export class BossAttackModels {
  private readonly ringMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: .95,
    depthWrite: false, side: THREE.DoubleSide });
  private readonly boltMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private readonly impactMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: .4,
    depthWrite: false, blending: THREE.AdditiveBlending });
  readonly rings: THREE.InstancedMesh;
  readonly bolts: THREE.InstancedMesh;
  readonly impacts: THREE.InstancedMesh;
  readonly meshes: readonly THREE.InstancedMesh[];
  private readonly attacks = new Map<number, { attack: Attack; species: number }>();
  private readonly transform = new THREE.Object3D();
  private readonly tint = new THREE.Color();
  constructor(private readonly capacity: number) {
    this.rings = new THREE.InstancedMesh(new THREE.RingGeometry(.9, 1, 48).rotateX(-Math.PI / 2), this.ringMaterial, capacity);
    this.bolts = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), this.boltMaterial, capacity);
    this.impacts = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 8), this.impactMaterial, capacity);
    this.meshes = [this.rings, this.bolts, this.impacts];
    for (const [i, mesh] of this.meshes.entries()) {
      mesh.name = ['boss-target-zones', 'boss-ranged-bolts', 'boss-ranged-impacts'][i];
      mesh.count = 0; mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    }
  }
  sync(creatures: readonly CreatureState[], tick: number): void {
    const seen = new Set<number>();
    for (const c of creatures.slice(0, this.capacity)) {
      seen.add(c.id);
      const a = c.rangedAttack;
      if (c.dead || !CREATURE_DEFS[c.species]?.boss) { this.attacks.delete(c.id); continue; }
      if (a && Object.values(a).every(Number.isFinite) && a.radius > 0 && a.impactTick > a.fireTick) {
        this.attacks.set(c.id, { attack: a, species: c.species });
      } else {
        const old = this.attacks.get(c.id);
        // An authoritative early disappearance is cancellation, not an impact.
        if (old && tick < old.attack.impactTick) this.attacks.delete(c.id);
      }
    }
    for (const id of this.attacks.keys()) if (!seen.has(id)) this.attacks.delete(id);
  }
  update(tick: number): void {
    this.rings.count = this.bolts.count = this.impacts.count = 0;
    if (!Number.isFinite(tick)) return;
    const place = (mesh: THREE.InstancedMesh, x: number, y: number, z: number, scale: number, color: THREE.Color) => {
      this.transform.position.set(x, y, z); this.transform.scale.setScalar(scale); this.transform.updateMatrix();
      mesh.setMatrixAt(mesh.count, this.transform.matrix); mesh.setColorAt(mesh.count++, color);
    };
    for (const [id, { attack, species }] of this.attacks) {
      const pose = bossAttackPose(attack, tick);
      this.tint.setHex(attackTint(species));
      if (pose.phase === 'impact') {
        if (pose.progress >= 1) { this.attacks.delete(id); continue; }
        place(this.impacts, pose.x, pose.y, pose.z, attack.radius * (.15 + .85 * pose.progress), this.tint.multiplyScalar(1 - pose.progress));
      } else {
        // The outline always marks the true damage radius; pulsing changes
        // brightness, not the apparent distance needed to dodge the attack.
        place(this.rings, attack.x, attack.y + .12, attack.z, attack.radius,
          this.tint.multiplyScalar(.78 + .22 * Math.sin(tick * .32)));
        this.tint.setHex(attackTint(species));
        const size = pose.phase === 'charge' ? 1.1 + .2 * Math.sin(tick * .24) : 1.3;
        place(this.bolts, pose.x, pose.y, pose.z, size, this.tint);
      }
    }
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (mesh.count) mesh.computeBoundingSphere();
    }
  }
  dispose(): void {
    this.attacks.clear();
    for (const mesh of this.meshes) { mesh.geometry.dispose(); mesh.dispose(); }
    this.ringMaterial.dispose(); this.boltMaterial.dispose(); this.impactMaterial.dispose();
  }
}
