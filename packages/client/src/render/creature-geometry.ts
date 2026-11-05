import * as THREE from 'three';

export type V3 = readonly [number, number, number];
/** Vertex paint: a fixed color, or a function of the part-space position and
 * smooth normal (countershading, stripes, mottling). Writes linear RGB. */
export type Paint = number | ((out: THREE.Color, p: THREE.Vector3, n: THREE.Vector3) => void);

/** One loft cross-section. `w` is the half width, `h`/`hb` the half heights
 * above/below the path (egg-shaped bellies), `sq` a superellipse exponent. */
export interface Ring { p: V3; w: number; h: number; hb?: number; sq?: number }

export interface LoftOptions {
  segments?: number;
  /** Reference "up" used to orient sections; must not be parallel to the path. */
  up?: V3;
  /** Dome lengths at either end; 0 closes with a flat fan. */
  capStart?: number; capEnd?: number;
  /** Intermediate dome rings per cap (0 = pole only). */
  capSegments?: number;
  /** Extra Catmull-Rom rings between authored sections (smoother silhouettes,
   * enough vertices for painted stripes and markings). */
  subdivide?: number;
  /** Optional per-vertex reshaping (ragged hems, ridges). */
  displace?: (ring: number, index: number, v: THREE.Vector3, rings: number, segments: number) => void;
  matrix?: THREE.Matrix4;
}

const _color = new THREE.Color();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

const catmull = (a: number, b: number, c: number, d: number, t: number) =>
  .5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (3 * b - a - 3 * c + d) * t * t * t);
function subdivideRings(rings: readonly Ring[], steps: number): Ring[] {
  const out: Ring[] = [];
  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[Math.max(0, i - 1)], b = rings[i], c = rings[i + 1], d = rings[Math.min(rings.length - 1, i + 2)];
    for (let k = 0; k <= steps; k++) {
      const t = k / (steps + 1);
      const value = (key: (r: Ring) => number) => catmull(key(a), key(b), key(c), key(d), t);
      out.push({ p: [value(r => r.p[0]), value(r => r.p[1]), value(r => r.p[2])], w: Math.max(.002, value(r => r.w)),
        h: Math.max(.002, value(r => r.h)), hb: Math.max(.002, value(r => r.hb ?? r.h)), sq: b.sq === undefined && c.sq === undefined ? undefined
          : (b.sq ?? 2) + ((c.sq ?? 2) - (b.sq ?? 2)) * t });
    }
  }
  out.push(rings[rings.length - 1]);
  return out;
}

/** Deterministic value noise in [0, 1) for mottled coats. */
export function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}
export function smoothNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  const fx = x - ix, fy = y - iy, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy), uz = fz * fz * (3 - 2 * fz);
  let total = 0;
  for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
    total += hash3(ix + dx, iy + dy, iz + dz) * (dx ? ux : 1 - ux) * (dy ? uy : 1 - uy) * (dz ? uz : 1 - uz);
  }
  return total;
}

/** Dark back, base flanks and pale belly by surface normal, lightly mottled. */
export function countershade(back: number, flank: number, belly: number, mottle = .07, grain = 9): Paint {
  const top = new THREE.Color(back), side = new THREE.Color(flank), under = new THREE.Color(belly);
  return (out, p, n) => {
    if (n.y >= 0) out.copy(side).lerp(top, Math.pow(n.y, .9));
    else out.copy(side).lerp(under, Math.pow(-n.y, .75));
    if (mottle) out.multiplyScalar(1 - mottle + 2 * mottle * smoothNoise(p.x * grain, p.y * grain, p.z * grain));
  };
}

/** Blend two paints by a 0..1 weight function of position/normal. */
export function blendPaint(a: Paint, b: Paint, weight: (p: THREE.Vector3, n: THREE.Vector3) => number): Paint {
  const ca = new THREE.Color(), cb = new THREE.Color();
  return (out, p, n) => {
    paintInto(ca, a, p, n); paintInto(cb, b, p, n);
    out.copy(ca).lerp(cb, Math.max(0, Math.min(1, weight(p, n))));
  };
}
export function paintInto(out: THREE.Color, paint: Paint, p: THREE.Vector3, n: THREE.Vector3): void {
  if (typeof paint === 'number') out.setHex(paint); else paint(out, p, n);
}
export const smooth01 = (edge0: number, edge1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/**
 * Indexed, smooth-shaded vertex-colored geometry for organic creature parts.
 * Every primitive keeps its own smooth normals (no flat faceting) and parts
 * merge into one indexed buffer with identical position/normal/color layout.
 */
export class CreatureGeometry {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];
  private readonly indices: number[] = [];

  get vertexCount(): number { return this.positions.length / 3; }
  get triangleCount(): number { return this.indices.length / 3; }

  /** Smooth tube through cross-sections; domed or fanned ends keep it closed. */
  loft(authored: readonly Ring[], paint: Paint, options: LoftOptions = {}): void {
    const segments = options.segments ?? 10, up = new THREE.Vector3(...(options.up ?? [0, 1, 0]));
    const rings = options.subdivide ? subdivideRings(authored, options.subdivide) : authored;
    const count = rings.length;
    const centers = rings.map(ring => new THREE.Vector3(...ring.p));
    const frames: { x: THREE.Vector3; y: THREE.Vector3; t: THREE.Vector3 }[] = [];
    for (let i = 0; i < count; i++) {
      const t = new THREE.Vector3().subVectors(centers[Math.min(count - 1, i + 1)], centers[Math.max(0, i - 1)]).normalize();
      let x = new THREE.Vector3().crossVectors(t, up);
      if (x.lengthSq() < 1e-8) x = new THREE.Vector3().crossVectors(t, new THREE.Vector3(0, 0, 1));
      if (x.lengthSq() < 1e-8) x = new THREE.Vector3().crossVectors(t, new THREE.Vector3(1, 0, 0));
      x.normalize();
      frames.push({ x, y: new THREE.Vector3().crossVectors(x, t).normalize(), t });
    }
    const vertices: THREE.Vector3[] = [];
    const ringPoint = (ring: Ring, frame: typeof frames[number], center: THREE.Vector3, j: number, scale = 1) => {
      const angle = j / segments * Math.PI * 2, c = Math.cos(angle), s = Math.sin(angle), e = 2 / (ring.sq ?? 2);
      const px = Math.sign(c) * Math.pow(Math.abs(c), e) * ring.w * scale;
      const py = Math.sign(s) * Math.pow(Math.abs(s), e) * (s >= 0 ? ring.h : ring.hb ?? ring.h) * scale;
      return center.clone().addScaledVector(frame.x, px).addScaledVector(frame.y, py);
    };
    // Domed caps: two shrinking rings and a pole beyond each end section.
    const capRings = (end: 0 | 1, length: number) => {
      const index = end ? count - 1 : 0, ring = rings[index], frame = frames[index], center = centers[index];
      const direction = frame.t.clone().multiplyScalar(end ? 1 : -1), list: THREE.Vector3[][] = [];
      const phis = (options.capSegments ?? 2) >= 2 ? [.45, .95] : options.capSegments === 1 ? [.8] : [];
      if (length > 0) for (const phi of phis) {
        const ringCenter = center.clone().addScaledVector(direction, Math.sin(phi) * length);
        const points: THREE.Vector3[] = [];
        for (let j = 0; j < segments; j++) points.push(ringPoint(ring, frame, ringCenter, j, Math.cos(phi)));
        list.push(points);
      }
      return { list, pole: center.clone().addScaledVector(direction, length) };
    };
    const start = capRings(0, options.capStart ?? 0), end = capRings(1, options.capEnd ?? 0);
    const allRings: THREE.Vector3[][] = [...start.list.reverse()];
    for (let i = 0; i < count; i++) {
      const points: THREE.Vector3[] = [];
      for (let j = 0; j < segments; j++) points.push(ringPoint(rings[i], frames[i], centers[i], j));
      allRings.push(points);
    }
    allRings.push(...end.list);
    const total = allRings.length;
    if (options.displace) allRings.forEach((points, r) => points.forEach((v, j) => options.displace!(r, j, v, total, segments)));
    for (const points of allRings) vertices.push(...points);
    const startPole = vertices.length; vertices.push(start.pole);
    const endPole = vertices.length; vertices.push(end.pole);
    const indices: number[] = [];
    for (let r = 0; r < total - 1; r++) for (let j = 0; j < segments; j++) {
      const a = r * segments + j, b = r * segments + (j + 1) % segments, c = (r + 1) * segments + (j + 1) % segments, d = (r + 1) * segments + j;
      indices.push(a, b, c, a, c, d);
    }
    for (let j = 0; j < segments; j++) {
      indices.push(startPole, (j + 1) % segments, j);
      const last = (total - 1) * segments;
      indices.push(endPole, last + j, last + (j + 1) % segments);
    }
    // Orient outward: compare one side triangle with its radial direction.
    const middle = Math.floor(total / 2), probe = middle * segments;
    _a.subVectors(vertices[probe + 1], vertices[probe]); _b.subVectors(vertices[probe + segments + 1], vertices[probe]);
    _c.crossVectors(_a, _b);
    const ringCenter = new THREE.Vector3();
    for (let j = 0; j < segments; j++) ringCenter.add(vertices[probe + j]);
    ringCenter.multiplyScalar(1 / segments);
    if (_c.dot(_a.subVectors(vertices[probe], ringCenter)) < 0) {
      for (let i = 0; i < indices.length; i += 3) { const swap = indices[i + 1]; indices[i + 1] = indices[i + 2]; indices[i + 2] = swap; }
    }
    this.append(vertices, indices, paint, options.matrix);
  }

  /** Ellipsoid as a closed lathe along local Z, then rotated (radians) and moved. */
  ellipsoid(center: V3, radii: V3, paint: Paint, rotation: V3 = [0, 0, 0], segments = 10, slices = 7): void {
    const rings: Ring[] = [];
    for (let i = 1; i < slices; i++) {
      const theta = i / slices * Math.PI, s = Math.sin(theta);
      rings.push({ p: [0, 0, -Math.cos(theta) * radii[2]], w: radii[0] * s, h: radii[1] * s });
    }
    const matrix = new THREE.Matrix4().compose(new THREE.Vector3(...center),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2], 'YXZ')), new THREE.Vector3(1, 1, 1));
    const cap = radii[2] * (1 - Math.cos(Math.PI / slices));
    this.loft(rings, paint, { segments, capStart: cap, capEnd: cap, capSegments: 0, matrix });
  }

  /** Tapered horn, claw, quill or tooth along a polyline, ending in a point. */
  spike(points: readonly V3[], radius: number, paint: Paint, segments = 6, tip = .08, ridges = 0, flatten = 1, up: V3 = [0, 1, 0]): void {
    const rings: Ring[] = points.map((p, i) => {
      const t = i / (points.length - 1), r = radius * (1 - t * (1 - tip));
      const ridge = ridges ? 1 + .18 * Math.max(0, Math.sin(t * ridges * Math.PI * 2)) : 1;
      return { p, w: r * ridge, h: r * ridge * flatten };
    });
    const last = points[points.length - 1], previous = points[points.length - 2];
    const length = Math.hypot(last[0] - previous[0], last[1] - previous[1], last[2] - previous[2]);
    this.loft(rings, paint, { segments, capStart: radius * .4, capEnd: Math.max(length * .6, radius * tip * 3), capSegments: 0, up });
  }

  /** Smooth curve helper: quadratic Bezier sampled into points. */
  static curve(a: V3, control: V3, b: V3, samples: number): V3[] {
    const out: V3[] = [];
    for (let i = 0; i <= samples; i++) {
      const t = i / samples, u = 1 - t;
      out.push([u * u * a[0] + 2 * u * t * control[0] + t * t * b[0], u * u * a[1] + 2 * u * t * control[1] + t * t * b[1],
        u * u * a[2] + 2 * u * t * control[2] + t * t * b[2]]);
    }
    return out;
  }

  private append(vertices: readonly THREE.Vector3[], indices: readonly number[], paint: Paint, matrix?: THREE.Matrix4): void {
    const normals = vertices.map(() => new THREE.Vector3());
    for (let i = 0; i < indices.length; i += 3) {
      const a = vertices[indices[i]], b = vertices[indices[i + 1]], c = vertices[indices[i + 2]];
      _a.subVectors(b, a); _b.subVectors(c, a); _c.crossVectors(_a, _b);
      normals[indices[i]].add(_c); normals[indices[i + 1]].add(_c); normals[indices[i + 2]].add(_c);
    }
    const normalMatrix = matrix ? new THREE.Matrix3().getNormalMatrix(matrix) : undefined;
    const offset = this.positions.length / 3;
    for (let i = 0; i < vertices.length; i++) {
      const p = vertices[i].clone(), n = normals[i];
      if (n.lengthSq() < 1e-20) n.set(0, 1, 0);
      n.normalize();
      if (matrix) { p.applyMatrix4(matrix); n.applyMatrix3(normalMatrix!).normalize(); }
      paintInto(_color, paint, p, n);
      this.positions.push(p.x, p.y, p.z); this.normals.push(n.x, n.y, n.z);
      this.colors.push(_color.r, _color.g, _color.b);
    }
    for (const index of indices) this.indices.push(index + offset);
  }

  /** Bake into a static indexed buffer; the builder can then be discarded. */
  build(): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setIndex(this.positions.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(this.indices, 1)
      : new THREE.Uint16BufferAttribute(this.indices, 1));
    geometry.computeBoundingSphere(); geometry.computeBoundingBox();
    return geometry;
  }
}
