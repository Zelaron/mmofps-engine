import * as THREE from 'three';
import type { TeleporterPad } from '@shared/index';
import type { EncounterSource } from './encounter-stream.js';
import { renderProfile } from './device-profile.js';

/** Nearby transport uses three fixed instance pools, even as the world expands. */
export class TeleporterRenderer {
  readonly group = new THREE.Group();
  private readonly capacity = renderProfile().touch ? 32 : 48;
  private readonly ringMaterial = new THREE.MeshLambertMaterial({ color: 0x66747b });
  private readonly discMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.65,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  private readonly beamMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22,
    blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false });
  private readonly rings = new THREE.InstancedMesh(new THREE.TorusGeometry(2.1, 0.22, 8, 24), this.ringMaterial, this.capacity);
  private readonly discs = new THREE.InstancedMesh(new THREE.CircleGeometry(1.85, 24), this.discMaterial, this.capacity);
  private readonly beams = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.5, 0.9, 1, 10, 1, true), this.beamMaterial, this.capacity);
  private readonly transform = new THREE.Object3D();
  private readonly color = new THREE.Color();
  private key = '';
  private time = 0;

  constructor(readonly field: EncounterSource) {
    for (const mesh of [this.rings, this.discs, this.beams]) {
      mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.group.add(mesh);
    }
  }

  get stats() { return { ...this.field.stats, pads: this.field.pads.length, visible: this.rings.count }; }

  update(dt: number, x: number, y: number, z: number): void {
    this.field.update([{ x, z }], 0.8, 6);
    this.time += Math.min(0.1, dt);
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 2.2);
    this.discMaterial.opacity = 0.4 + 0.3 * pulse;
    this.beamMaterial.opacity = 0.15 + 0.1 * pulse;
    const key = `${this.field.revision}:${Math.floor(x / 64)},${Math.floor(y / 16)},${Math.floor(z / 64)}`;
    if (key === this.key) return;
    this.key = key;
    const pads = this.field.pads.map(p => ({ p, distance: Math.hypot(p.x - x, p.z - z, (p.y - y) * 1.5) }))
      .filter(v => v.distance < (v.p.cave ? 650 : 1400)).sort((a, b) => a.distance - b.distance).slice(0, this.capacity);
    this.rings.count = this.discs.count = this.beams.count = pads.length;
    const obj = this.transform;
    for (let i = 0; i < pads.length; i++) {
      const p = pads[i].p;
      obj.position.set(p.x, p.y + 0.12, p.z); obj.rotation.set(-Math.PI / 2, 0, 0); obj.scale.setScalar(1);
      obj.updateMatrix(); this.rings.setMatrixAt(i, obj.matrix);
      obj.position.y = p.y + 0.16; obj.updateMatrix(); this.discs.setMatrixAt(i, obj.matrix);
      this.color.setHex(p.cave || this.field.pads[p.partner]?.cave ? 0xffab3d : 0x53d8e8);
      this.discs.setColorAt(i, this.color); this.beams.setColorAt(i, this.color);
      // Compact cave beacons stay inside shallow rooms instead of piercing
      // their roofs and adding phantom "surface" teleporter columns.
      const height = p.cave ? 4.5 : 30;
      obj.position.y = p.y + height / 2 + 0.1; obj.rotation.set(0, 0, 0); obj.scale.set(1, height, 1);
      obj.updateMatrix(); this.beams.setMatrixAt(i, obj.matrix);
    }
    for (const mesh of [this.rings, this.discs, this.beams]) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      if (mesh.count) mesh.computeBoundingSphere();
    }
  }

  nearestReturn(x: number, y: number, z: number): TeleporterPad | null {
    let nearest: TeleporterPad | null = null, best = Infinity;
    for (const p of this.field.pads) {
      if (!p.cave) continue;
      const distance = Math.hypot(p.x - x, p.z - z), score = distance + Math.abs(p.y - y) * 8;
      if (distance < 900 && score < best) { nearest = p; best = score; }
    }
    return nearest;
  }

  dispose(): void {
    this.field.dispose?.();
    for (const mesh of [this.rings, this.discs, this.beams]) {
      mesh.geometry.dispose(); mesh.material.dispose(); mesh.dispose();
    }
    this.group.clear();
  }
}
