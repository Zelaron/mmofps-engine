import * as THREE from 'three';
import { RESOURCE_VISIBLE_LIMIT, type ResourceSnapshot } from '@shared/resources';

/** Shared geometry keeps a nearby deposit field to three draw calls. */
export class ResourceModels {
  readonly group = new THREE.Group();
  private readonly rockGeometry = new THREE.IcosahedronGeometry(1, 1);
  private readonly crystalGeometry = new THREE.CylinderGeometry(.04, .18, 1.25, 5, 1);
  private readonly rockMaterial = new THREE.MeshStandardMaterial({ color: 0x344942, roughness: .95 });
  private readonly liveMaterial = new THREE.MeshStandardMaterial({ color: 0x8affe0, emissive: 0x0c775b, emissiveIntensity: .65, roughness: .25, metalness: .3 });
  private readonly spentMaterial = new THREE.MeshStandardMaterial({ color: 0x526a61, roughness: .9 });
  private readonly rocks = new THREE.InstancedMesh(this.rockGeometry, this.rockMaterial, RESOURCE_VISIBLE_LIMIT);
  private readonly live = new THREE.InstancedMesh(this.crystalGeometry, this.liveMaterial, RESOURCE_VISIBLE_LIMIT * 5);
  private readonly spent = new THREE.InstancedMesh(this.crystalGeometry, this.spentMaterial, RESOURCE_VISIBLE_LIMIT * 5);
  constructor() {
    this.crystalGeometry.translate(0, .625, 0);
    for (const mesh of [this.rocks, this.live, this.spent]) {
      mesh.count = 0; mesh.frustumCulled = false; mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); this.group.add(mesh);
    }
    this.group.name = 'xenolite-deposits';
  }
  receive(state: ResourceSnapshot): void {
    const transform = new THREE.Object3D(); let rock = 0, live = 0, spent = 0;
    for (const node of state.nodes.slice(0, RESOURCE_VISIBLE_LIMIT)) {
      const ready = node.remaining <= 0, phase = (node.x * .73 + node.z * .31) % (Math.PI * 2);
      transform.position.set(node.x, node.y + .1, node.z); transform.rotation.set(.1, phase, .08);
      transform.scale.set(1.1, .35, .85); transform.updateMatrix(); this.rocks.setMatrixAt(rock++, transform.matrix);
      for (let i = 0; i < 5; i++) {
        const angle = phase + i * 2.4, radius = i ? .42 : 0;
        transform.position.set(node.x + Math.cos(angle) * radius, node.y + .2, node.z + Math.sin(angle) * radius);
        transform.rotation.set(Math.cos(angle) * .28, angle, Math.sin(angle) * .28);
        transform.scale.set(1, ready ? 1 - i * .1 : .19, 1); transform.updateMatrix();
        if (ready) this.live.setMatrixAt(live++, transform.matrix); else this.spent.setMatrixAt(spent++, transform.matrix);
      }
    }
    this.rocks.count = rock; this.live.count = live; this.spent.count = spent;
    for (const mesh of [this.rocks, this.live, this.spent]) mesh.instanceMatrix.needsUpdate = true;
  }
  clear(): void { this.rocks.count = this.live.count = this.spent.count = 0; }
  dispose(): void {
    this.clear(); this.group.removeFromParent();
    for (const mesh of [this.rocks, this.live, this.spent]) mesh.dispose();
    this.rockGeometry.dispose(); this.crystalGeometry.dispose();
    this.rockMaterial.dispose(); this.liveMaterial.dispose(); this.spentMaterial.dispose();
  }
}
