import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CavePropKind, CavePOI } from '@shared/encounters';
import type { EncounterSource } from './encounter-stream.js';
import { renderProfile } from './device-profile.js';

export const CAVE_LANDMARK_LIMIT = 24;
const KINDS: readonly CavePropKind[] = ['shelter', 'rig', 'crystal', 'rack', 'beacon'];

/** Five reusable open-frame expedition silhouettes. Small cosmetic parts
 * surround a clear pickup lane; they do not present opaque defensive walls. */
function landmarkGeometry(kind: CavePropKind): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const color = new THREE.Color();
  const add = (g: THREE.BufferGeometry, hex: number, x = 0, y = 0, z = 0, rx = 0, rz = 0) => {
    g.rotateX(rx); g.rotateZ(rz); g.translate(x, y, z);
    const p = g.getAttribute('position'), colors = new Float32Array(p.count * 3);
    color.setHex(hex);
    for (let i = 0; i < p.count; i++) color.toArray(colors, i * 3);
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3)); parts.push(g);
  };
  const box = (w: number, h: number, d: number, hex: number, x: number, y: number, z: number, rx = 0, rz = 0) =>
    add(new THREE.BoxGeometry(w, h, d), hex, x, y, z, rx, rz);
  const rod = (radius: number, length: number, hex: number, x: number, y: number, z: number, rx = 0, rz = 0) =>
    add(new THREE.CylinderGeometry(radius, radius, length, 8), hex, x, y, z, rx, rz);
  const dark = 0x29383c, alloy = 0x829397, orange = 0xe4a24b, pale = 0xcbd7cb;
  if (kind === 'shelter') {
    for (const x of [-1.15, 1.15]) for (const z of [-0.75, 0.75]) rod(0.055, 2.45, alloy, x, 1.1, z, 0, -x * 0.08);
    box(2.65, 0.075, 1.95, 0x6c8379, 0, 2.3, 0, 0, 0.09);
    for (const z of [-0.8, 0.8]) box(2.4, 0.08, 0.08, dark, 0, 2.1, z);
    box(1.5, 0.045, 0.65, 0x768071, 0, 0.32, 0.1);
    for (const x of [-0.6, 0.6]) box(0.055, 0.65, 0.055, alloy, x, 0.12, 0.1, 0, x * 0.6);
    box(0.12, 0.12, 1.5, orange, 0.95, 2.35, 0);
    box(0.18, 0.24, 0.18, 0xffe2a2, -0.8, 1.85, -0.7);
  } else if (kind === 'rig') {
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3;
      rod(0.10, 1.6, dark, Math.cos(a) * 0.65, 0.55, Math.sin(a) * 0.65, -Math.sin(a) * 0.65, Math.cos(a) * 0.65);
      box(0.4, 0.12, 0.4, alloy, Math.cos(a) * 1.05, 0.02, Math.sin(a) * 1.05);
    }
    add(new THREE.CylinderGeometry(0.44, 0.5, 0.65, 12), 0x688178, 0, 1.2, 0);
    rod(0.14, 2.2, alloy, 0, 1.52, 0);
    for (let i = 0; i < 5; i++) add(new THREE.TorusGeometry(0.22, 0.035, 5, 10), orange, 0, 0.25 + i * 0.21, 0, Math.PI / 2);
    box(0.35, 0.75, 0.4, orange, 0.6, 1.5, 0);
    box(0.025, 0.20, 0.22, 0x98e5d1, 0.79, 1.65, 0);
    for (const x of [-0.25, 0.25]) rod(0.06, 0.8, dark, x, 2.5, 0, 0, -x);
  } else if (kind === 'crystal') {
    add(new THREE.CylinderGeometry(0.65, 0.85, 0.22, 8), dark, 0, 0.06, 0);
    for (let i = 0; i < 4; i++) {
      const a = i * 2.4, h = i ? 1.25 + i * 0.22 : 2.5;
      const g = new THREE.CylinderGeometry(0.015, i ? 0.19 : 0.27, h, 6);
      add(g, i % 2 ? 0x90d7cd : 0xa7bfe1, Math.cos(a) * (i ? 0.45 : 0), h * 0.5, Math.sin(a) * (i ? 0.45 : 0), i ? Math.sin(a) * 0.12 : 0, i ? Math.cos(a) * 0.16 : 0);
    }
    add(new THREE.TorusGeometry(0.86, 0.035, 5, 20), orange, 0, 0.16, 0, Math.PI / 2);
  } else if (kind === 'rack') {
    for (const x of [-0.8, 0.8]) { box(0.095, 2.2, 0.09, alloy, x, 1, 0); box(0.3, 0.1, 0.65, dark, x, -0.02, 0); }
    for (const y of [0.15, 1.0, 2.08]) box(1.7, 0.08, 0.1, dark, 0, y, 0);
    for (const x of [-0.45, 0, 0.45]) {
      rod(0.07, 0.92, dark, x, 1.3, 0.08, 0, -0.17);
      box(0.16, 0.3, 0.15, orange, x - 0.06, 0.9, 0.09);
    }
    box(0.9, 0.12, 0.65, dark, 0, 0.7, 0.42, -0.35);
    box(0.7, 0.018, 0.38, 0x7dc5bd, 0, 0.80, 0.42, -0.35);
    for (const x of [-0.28, 0.28]) box(0.16, 0.03, 0.03, pale, x, 1.9, 0.065);
  } else {
    rod(0.075, 2.45, alloy, 0, 1.0, 0);
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3;
      rod(0.045, 1.15, dark, Math.cos(a) * 0.24, 0.25, Math.sin(a) * 0.24, -Math.sin(a) * 0.75, Math.cos(a) * 0.75);
    }
    box(0.36, 0.46, 0.26, orange, 0, 1.62, 0);
    box(0.25, 0.3, 0.025, 0xc1f5df, 0, 1.66, 0.145);
    for (const y of [2.12, 2.38]) rod(0.025, y === 2.12 ? 0.9 : 0.5, pale, 0, y, 0, 0, Math.PI / 2);
  }
  const geometry = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  geometry.computeBoundingSphere();
  return geometry;
}

export class CaveLandmarkRenderer {
  readonly group = new THREE.Group();
  private readonly limit = renderProfile().touch ? 12 : CAVE_LANDMARK_LIMIT;
  private readonly material = new THREE.MeshLambertMaterial({ vertexColors: true,
    emissive: 0x1b2322, emissiveIntensity: 0.22 });
  private readonly pools = new Map<CavePropKind, THREE.InstancedMesh>();
  private readonly transform = new THREE.Object3D();
  private key = '';
  private count = 0;
  private disposed = false;

  constructor(private readonly field: EncounterSource) {
    this.group.name = 'cave-expedition-landmarks';
    for (const kind of KINDS) {
      const mesh = new THREE.InstancedMesh(landmarkGeometry(kind), this.material, this.limit * 4);
      mesh.name = `cave-landmark-${kind}`; mesh.count = 0;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.pools.set(kind, mesh); this.group.add(mesh);
    }
  }

  get stats() { return { discoveries: this.count, limit: this.limit,
    props: [...this.pools.values()].reduce((sum, mesh) => sum + mesh.count, 0), draws: this.pools.size }; }

  update(x: number, y: number, z: number): void {
    if (this.disposed || !Number.isFinite(x + y + z)) return;
    const key = `${this.field.revision}:${Math.floor(x / 24)},${Math.floor(y / 12)},${Math.floor(z / 24)}`;
    if (key === this.key) return;
    this.key = key;
    const candidates = (this.field.pois ?? []).map(poi => ({ poi, distance: this.distance(poi, x, y, z) }))
      .filter(p => p.distance < 330).sort((a, b) => a.distance - b.distance).slice(0, this.limit);
    this.count = candidates.length;
    for (const mesh of this.pools.values()) mesh.count = 0;
    for (const { poi } of candidates) for (const prop of poi.props) {
      const mesh = this.pools.get(prop.kind)!;
      if (mesh.count >= mesh.instanceMatrix.count) continue;
      this.transform.position.set(prop.x, prop.y, prop.z);
      this.transform.rotation.set(0, prop.yaw, 0); this.transform.scale.setScalar(prop.scale);
      this.transform.updateMatrix(); mesh.setMatrixAt(mesh.count++, this.transform.matrix);
    }
    for (const mesh of this.pools.values()) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.count) mesh.computeBoundingSphere();
    }
  }

  private distance(poi: CavePOI, x: number, y: number, z: number): number {
    return Math.hypot(poi.x - x, (poi.y - y) * 2, poi.z - z);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const mesh of this.pools.values()) { mesh.geometry.dispose(); mesh.dispose(); }
    this.material.dispose(); this.pools.clear(); this.group.clear();
  }
}
