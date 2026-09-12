import * as THREE from 'three';
import { FACTIONS, type FrontierState } from '@shared/frontier';

/** Ground rings do not add collision; the existing city junction stays open. */
export class FrontierMarkers {
  readonly group = new THREE.Group();
  private readonly markers = new Map<string, THREE.Group>();
  private readonly ring = new THREE.RingGeometry(.98, 1, 80);
  private readonly mast = new THREE.CylinderGeometry(.08, .15, 8, 6);
  private readonly flag = new THREE.OctahedronGeometry(1.25, 0);
  private readonly materials = FACTIONS.map(f => new THREE.MeshBasicMaterial({ color: f.color, transparent: true, opacity: .65, side: THREE.DoubleSide, depthWrite: false }));
  receive(state: FrontierState): void {
    for (const site of state.territories) {
      let group = this.markers.get(site.id);
      if (!group) {
        group = new THREE.Group();
        const ring = new THREE.Mesh(this.ring, this.materials[site.owner]);
        ring.rotation.x = -Math.PI / 2; ring.scale.setScalar(site.radius); ring.position.y = .04;
        const mast = new THREE.Mesh(this.mast, this.materials[site.owner]); mast.position.y = 4;
        const flag = new THREE.Mesh(this.flag, this.materials[site.owner]); flag.position.y = 8.5;
        group.add(ring, mast, flag); this.markers.set(site.id, group); this.group.add(group);
      }
      group.position.set(site.x, site.y, site.z);
      for (const child of group.children) (child as THREE.Mesh).material = this.materials[site.owner];
    }
  }
  update(x: number, z: number, seconds: number): void {
    for (const group of this.markers.values()) {
      group.visible = Math.hypot(group.position.x - x, group.position.z - z) < 950;
      if (group.visible) group.children[2].rotation.y = seconds * .45;
    }
  }
}
