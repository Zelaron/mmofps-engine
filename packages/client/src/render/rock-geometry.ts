import * as THREE from 'three';
import { ROCK_GRANITE_PLANES, ROCK_TALUS_LEFT, ROCK_TALUS_RIGHT, ROCK_TALUS_SHARED, type RockPlane } from '@shared/index';

type Plane = RockPlane;
interface Vertex { p: THREE.Vector3; n: THREE.Vector3 }
type Face = Vertex[];
const EPSILON = 1e-7;
const BOUNDS: Plane[] = [[1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1],
  [0, 0, 1, 1], [0, 0, -1, 1]];

function distance(p: THREE.Vector3, plane: Plane): number {
  return p.x * plane[0] + p.y * plane[1] + p.z * plane[2] - plane[3];
}

function cutFace(face: Face, plane: Plane, intersections?: THREE.Vector3[]): Face {
  const result: Face = [];
  for (let i = 0; i < face.length; i++) {
    const a = face[i], b = face[(i + 1) % face.length];
    const da = distance(a.p, plane), db = distance(b.p, plane);
    if (da <= EPSILON) result.push(a);
    if ((da < -EPSILON && db > EPSILON) || (da > EPSILON && db < -EPSILON)) {
      const t = da / (da - db);
      const p = a.p.clone().lerp(b.p, t);
      result.push({ p, n: a.n.clone().lerp(b.n, t).normalize() });
      intersections?.push(p);
    } else if (Math.abs(da) <= EPSILON) intersections?.push(a.p);
  }
  return result;
}

/** Clip and cap a closed convex surface. Caps follow collision fracture
 * planes exactly, so sharp corners are not replaced by sphere triangles. */
function clip(faces: Face[], planes: readonly Plane[]): Face[] {
  for (const plane of planes) {
    const intersections: THREE.Vector3[] = [];
    const remaining = faces.map((face) => cutFace(face, plane, intersections)).filter((face) => face.length >= 3);
    const points = [...new Map(intersections.map((p) => [
      `${Math.round(p.x * 1e6)},${Math.round(p.y * 1e6)},${Math.round(p.z * 1e6)}`, p,
    ])).values()];
    if (points.length >= 3) {
      const normal = new THREE.Vector3(plane[0], plane[1], plane[2]).normalize();
      const center = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length);
      const u = new THREE.Vector3(Math.abs(normal.y) > 0.8 ? 1 : 0, Math.abs(normal.y) > 0.8 ? 0 : 1, 0)
        .cross(normal).normalize();
      const v = normal.clone().cross(u);
      const angle = (p: THREE.Vector3) => Math.atan2(p.clone().sub(center).dot(v), p.clone().sub(center).dot(u));
      points.sort((a, b) => angle(a) - angle(b));
      remaining.push(points.map((p) => ({ p, n: normal })));
    }
    faces = remaining;
  }
  return faces;
}

function baseFaces(near: boolean, granite: boolean): Face[] {
  const geometry = granite ? new THREE.IcosahedronGeometry(1, near ? 3 : 1) : new THREE.BoxGeometry(2, 2, 2).toNonIndexed();
  const p = geometry.getAttribute('position'), n = geometry.getAttribute('normal');
  const faces: Face[] = [];
  const lean = (0.125 - 0.5) * 0.24;
  for (let i = 0; i < p.count; i += 3) {
    const face: Face = [];
    for (let j = i; j < i + 3; j++) {
      const point = new THREE.Vector3().fromBufferAttribute(p, j);
      const normal = new THREE.Vector3().fromBufferAttribute(n, j);
      if (granite) {
        const u = point.x * 1.04 / Math.sqrt(1.15);
        const y = point.y * 1.04 / Math.sqrt(0.90) - 0.10;
        const v = point.z * 1.04 / Math.sqrt(1.32);
        const x = (u - y * (lean - 0.0044) - v * 0.11) / 1.0143;
        point.set(x, y, v - y * 0.04 + x * 0.13);
        normal.set(u * 1.15 - v * 1.32 * 0.13,
          (y + 0.10) * 0.90 + u * 1.15 * lean + v * 1.32 * 0.04,
          u * 1.15 * 0.11 + v * 1.32).normalize();
      }
      face.push({ p: point, n: normal });
    }
    faces.push(face);
  }
  geometry.dispose();
  return faces;
}

function absolutePlanes(x: number, y: number, z: number, d: number): Plane[] {
  return [-1, 1].flatMap((sx) => [-1, 1].map((sz): Plane => [x * sx, y, z * sz, d]));
}

/** Remove the part of a face inside another convex solid. Each successive
 * plane partitions only the remaining inside region, avoiding overlap. */
function outside(faces: Face[], other: readonly Plane[], retainShared: boolean): Face[] {
  const result: Face[] = [];
  for (const face of faces) {
    if (retainShared && other.some((plane) => face.every(({ p }) => Math.abs(distance(p, plane)) < EPSILON))) {
      result.push(face);
      continue;
    }
    let remainder = face;
    for (const plane of other) {
      if (remainder.length < 3) break;
      // A face lying on this boundary belongs to the other copy of the solid.
      if (remainder.every(({ p }) => Math.abs(distance(p, plane)) < EPSILON)) continue;
      const inverted: Plane = [-plane[0], -plane[1], -plane[2], -plane[3]];
      const fragment = cutFace(remainder, inverted);
      if (fragment.length >= 3) result.push(fragment);
      remainder = cutFace(remainder, plane);
    }
  }
  return result;
}

/** Four geological families constructed from the same analytic envelopes as
 * rockProfile. Only granite has a curved core; other faces are exact planes. */
export function boulderGeometry(family: number, near: boolean): THREE.BufferGeometry {
  let faces: Face[];
  if (family === 0) {
    faces = clip(baseFaces(near, true), [...BOUNDS, ...ROCK_GRANITE_PLANES]);
  } else if (family === 1) {
    faces = clip(baseFaces(near, false), [[0.46, 1, -0.12, 0.36],
      ...absolutePlanes(0.88, 0.09, 0.47, 0.91), [-0.72, 0.26, 0.62, 0.94]]);
  } else if (family === 2) {
    faces = clip(baseFaces(near, false), [...absolutePlanes(0.92, 0.12, 0.38, 0.86),
      ...absolutePlanes(0.38, -0.08, 0.92, 0.86), [0.12, 1, -0.25, 0.83]]);
  } else {
    const shared = ROCK_TALUS_SHARED, left = ROCK_TALUS_LEFT, right = ROCK_TALUS_RIGHT;
    const a = clip(baseFaces(near, false), [...shared, ...left]);
    const b = clip(baseFaces(near, false), [...shared, ...right]);
    faces = [...outside(a, [...BOUNDS, ...shared, ...right], true),
      ...outside(b, [...BOUNDS, ...shared, ...left], false)];
  }
  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  for (const face of faces) {
    for (let i = 1; i < face.length - 1; i++) {
      const vertices = [face[0], face[i], face[i + 1]];
      if (vertices[1].p.clone().sub(vertices[0].p).cross(vertices[2].p.clone().sub(vertices[0].p)).lengthSq() < 1e-14) continue;
      for (const { p, n } of vertices) {
        positions.push(p.x, p.y, p.z); normals.push(n.x, n.y, n.z);
        const warmth = Math.sin(p.x * 9 + p.z * 7 + p.y * 5) * 0.025;
        const shade = 0.82 + (p.y + 1) * 0.09;
        colors.push(shade + warmth, shade, shade - warmth);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingBox();
  geometry.boundingBox!.expandByScalar(0.07);
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Math.sqrt(3));
  return geometry;
}
