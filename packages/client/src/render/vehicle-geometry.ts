import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

type Vec3 = readonly [number, number, number];

/** Bake small, colored mechanical parts into one draw, once per vehicle type. */
export class VehicleGeometry {
  private readonly parts: THREE.BufferGeometry[] = [];

  add(geometry: THREE.BufferGeometry, color: number, position: Vec3 = [0, 0, 0], rotation: Vec3 = [0, 0, 0]): void {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    if (flat !== geometry) geometry.dispose();
    // Every part has exactly the same attributes before merging. No textures,
    // tangents or material groups: detail changes triangles, never draw calls.
    for (const name of Object.keys(flat.attributes)) {
      if (name !== 'position' && name !== 'normal') flat.deleteAttribute(name);
    }
    // Keep authored smooth normals on cylinders, nozzles and domes. Boxes
    // already carry hard face normals; hand-built prisms generate theirs here.
    if (!flat.getAttribute('normal')) flat.computeVertexNormals();
    flat.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
      new THREE.Vector3(1, 1, 1),
    ));
    const rgb = new THREE.Color(color);
    const colors = new Float32Array(flat.getAttribute('position').count * 3);
    for (let i = 0; i < colors.length; i += 3) {
      colors[i] = rgb.r; colors[i + 1] = rgb.g; colors[i + 2] = rgb.b;
    }
    flat.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    this.parts.push(flat);
  }

  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, rx = 0, ry = 0, rz = 0): void {
    this.add(new THREE.BoxGeometry(w, h, d), color, [x, y, z], [rx, ry, rz]);
  }

  tube(radius: number, start: Vec3, end: Vec3, color: number, sides = 10, endRadius = radius): void {
    const a = new THREE.Vector3(...start), b = new THREE.Vector3(...end);
    const axis = b.clone().sub(a);
    const geometry = new THREE.CylinderGeometry(endRadius, radius, axis.length(), sides);
    geometry.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize()));
    geometry.translate(...a.add(b).multiplyScalar(0.5).toArray() as [number, number, number]);
    this.add(geometry, color);
  }

  /** Convex extruded polygon. Used for swept wings and bevelled track profiles. */
  prism(points: readonly Vec3[], depth: Vec3, color: number): void {
    const a = new THREE.Vector3(...points[0]);
    const normal = new THREE.Vector3(...points[1]).sub(a).cross(new THREE.Vector3(...points[2]).sub(a));
    const ring = normal.dot(new THREE.Vector3(...depth)) < 0 ? [...points].reverse() : points;
    const vertices = [...ring, ...ring.map((p): Vec3 => [p[0] + depth[0], p[1] + depth[1], p[2] + depth[2]])];
    const indices: number[] = [];
    const n = points.length;
    for (let i = 1; i < n - 1; i++) {
      indices.push(0, i + 1, i, n, n + i, n + i + 1);
    }
    for (let i = 0; i < n; i++) {
      const next = (i + 1) % n;
      indices.push(i, next, next + n, i, next + n, i + n);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3));
    geometry.setIndex(indices);
    this.add(geometry, color);
  }

  /** Eight-sided cross-sections running along Z; gives actual shaped silhouettes. */
  loft(sections: readonly { z: number; y: number; w: number; h: number }[], color: number, offsetX = 0): void {
    const cross = [[-0.72, -1], [0.72, -1], [1, -0.55], [1, 0.55], [0.72, 1], [-0.72, 1], [-1, 0.55], [-1, -0.55]];
    const positions: number[] = [], indices: number[] = [];
    for (const section of sections) {
      for (const [x, y] of cross) positions.push(offsetX + x * section.w, section.y + y * section.h, section.z);
    }
    for (let ring = 0; ring < sections.length - 1; ring++) {
      for (let i = 0; i < 8; i++) {
        const a = ring * 8 + i, b = ring * 8 + (i + 1) % 8;
        indices.push(a, b, b + 8, a, b + 8, a + 8);
      }
    }
    const last = (sections.length - 1) * 8;
    for (let i = 1; i < 7; i++) indices.push(0, i + 1, i, last, last + i, last + i + 1);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    this.add(geometry, color);
  }

  mesh(material: THREE.Material, name: string): THREE.Mesh {
    const geometry = mergeGeometries(this.parts, false)!;
    for (const part of this.parts) part.dispose();
    this.parts.length = 0;
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }
}
