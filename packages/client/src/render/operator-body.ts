import * as THREE from 'three';

// Rigid parts keep their existing animated parents;
// a one-hot palette draws their concatenated triangles in one body submission.
interface PartSpan { readonly name: string; readonly start: number; readonly count: number }
interface Variant {
  readonly geometry: THREE.BufferGeometry;
  readonly inverses: readonly THREE.Matrix4[];
  readonly bounds: readonly THREE.Box3[];
  readonly spans: readonly PartSpan[];
}
const variants = new Map<number, Variant>();
const bodies = new WeakMap<THREE.Group, OperatorBody>();

class OperatorBody extends THREE.SkinnedMesh<THREE.BufferGeometry, THREE.Material> {
  private readonly actorInverse = new THREE.Matrix4();
  private readonly partBox = new THREE.Box3();
  private released = false;

  constructor(variant: Variant, material: THREE.Material,
    private readonly joints: readonly THREE.Bone[]) {
    super(variant.geometry, material);
    this.name = 'operator-body';
    this.bindMode = THREE.DetachedBindMode;
    this.boundingBox = new THREE.Box3();
    this.boundingSphere = new THREE.Sphere();
    // Each actor owns only its skeleton, proxy matrices and eventual bone texture.
    // Proxy matrices are actor-local: global world translation never enters the
    // Float32 palette and cannot be lost through large-coordinate cancellation.
    const proxies = joints.map(joint => {
      const bone = new THREE.Bone(); bone.name = joint.name;
      bone.matrixAutoUpdate = false; return bone;
    });
    this.bind(new THREE.Skeleton(proxies, variant.inverses.map(matrix => matrix.clone())), new THREE.Matrix4());
    this.userData.operatorParts = variant.spans;
    this.partBounds = variant.bounds;
  }

  private readonly partBounds: readonly THREE.Box3[];

  override updateMatrixWorld(force?: boolean): void {
    super.updateMatrixWorld(force);
    // This mesh is the last child of the rig, so all original joint branches
    // already have their current matrixWorld before these proxies are refreshed.
    this.actorInverse.copy(this.matrixWorld).invert();
    const box = this.boundingBox!;
    box.makeEmpty();
    for (let index = 0; index < this.joints.length; index++) {
      const matrix = this.skeleton.bones[index].matrixWorld;
      matrix.copy(this.joints[index].matrixWorld).premultiply(this.actorInverse);
      box.union(this.partBox.copy(this.partBounds[index]).applyMatrix4(matrix));
    }
    // Box-transformed original part extents conservatively contain every current
    // vertex. No per-vertex bounds traversal and no stale first-pose sphere.
    box.getBoundingSphere(this.boundingSphere!);
    this.boundingSphere!.radius += 1e-5;
    box.expandByScalar(1e-5);
  }

  override computeBoundingBox(): void {
    if (this.parent) { this.parent.updateWorldMatrix(true, false); this.parent.updateMatrixWorld(true); }
    else this.updateMatrixWorld(true);
  }
  override computeBoundingSphere(): void { this.computeBoundingBox(); }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.skeleton.dispose();
  }
}

function createVariant(parts: readonly THREE.Mesh[]): Variant {
  const count = parts.reduce((sum, part) => sum + part.geometry.getAttribute('position').count, 0);
  const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3), indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  const point = new THREE.Vector3(), direction = new THREE.Vector3(), normalMatrix = new THREE.Matrix3();
  const inverses: THREE.Matrix4[] = [], bounds: THREE.Box3[] = [], spans: PartSpan[] = [];
  let offset = 0;
  for (let bone = 0; bone < parts.length; bone++) {
    const part = parts[bone], geometry = part.geometry;
    if (geometry.index !== null) throw new Error('Operator body requires original nonindexed part order');
    const position = geometry.getAttribute('position'), normal = geometry.getAttribute('normal');
    const color = geometry.getAttribute('color');
    if (!normal || !color || normal.count !== position.count || color.count !== position.count) {
      throw new Error('Operator part attributes are incomplete');
    }
    inverses.push(part.matrixWorld.clone().invert());
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    bounds.push(geometry.boundingBox!.clone());
    spans.push(Object.freeze({ name: part.name, start: offset, count: position.count }));
    // In the existing rig each animated part transform is R(t) S with a fixed
    // leaf scale S (including the sibling upper/forearm length scale). Therefore
    // J(t) inverse(J(0)) = R(t) inverse(R(0)) is rigid. Baking the inverse-transpose
    // bind normal makes Three's ordinary skin-normal multiplication equivalent;
    // the qualification must reject future animated/inherited scale changes.
    normalMatrix.getNormalMatrix(part.matrixWorld);
    for (let vertex = 0; vertex < position.count; vertex++) {
      const i = offset + vertex;
      point.fromBufferAttribute(position, vertex).applyMatrix4(part.matrixWorld);
      direction.fromBufferAttribute(normal, vertex).applyMatrix3(normalMatrix).normalize();
      positions[i * 3] = point.x; positions[i * 3 + 1] = point.y; positions[i * 3 + 2] = point.z;
      normals[i * 3] = direction.x; normals[i * 3 + 1] = direction.y; normals[i * 3 + 2] = direction.z;
      colors[i * 3] = color.getX(vertex); colors[i * 3 + 1] = color.getY(vertex); colors[i * 3 + 2] = color.getZ(vertex);
      indices[i * 4] = bone; weights[i * 4] = 1;
    }
    offset += position.count;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('skinIndex', new THREE.BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.BufferAttribute(weights, 4));
  return { geometry, inverses, bounds, spans: Object.freeze(spans) };
}

export function installOperatorBody(group: THREE.Group, gunMount: THREE.Group, variantId: number): void {
  if (bodies.has(group) || group.parent || !Number.isInteger(variantId) || variantId < 0 || variantId >= 24) {
    throw new Error('Operator body must bind once to an unparented factory rig and a bounded variant');
  }
  const parts: THREE.Mesh[] = [];
  const collect = (object: THREE.Object3D): void => {
    if (object === gunMount) return;
    if (object instanceof THREE.Mesh) parts.push(object);
    for (const child of object.children) collect(child);
  };
  collect(group);
  if (parts.length !== 15 || parts.some(part => Array.isArray(part.material) || part.children.length > 0)) {
    throw new Error('Operator body expected fifteen independent material-sharing leaf parts');
  }
  const material = parts[0].material as THREE.Material;
  if (parts.some(part => part.material !== material)) throw new Error('Operator body materials diverged');
  group.updateMatrixWorld(true);
  let variant = variants.get(variantId);
  if (!variant) { variant = createVariant(parts); variants.set(variantId, variant); }
  for (let index = 0; index < parts.length; index++) {
    const span = variant.spans[index];
    if (span.name !== parts[index].name || span.count !== parts[index].geometry.getAttribute('position').count) {
      throw new Error('Operator variant part layout changed');
    }
  }
  const joints = parts.map(part => {
    const parent = part.parent!, index = parent.children.indexOf(part);
    const joint = new THREE.Bone(); joint.name = part.name;
    joint.position.copy(part.position); joint.quaternion.copy(part.quaternion); joint.scale.copy(part.scale);
    joint.updateMatrix(); joint.matrixAutoUpdate = false;
    parent.remove(part); parent.add(joint);
    parent.children.splice(parent.children.indexOf(joint), 1); parent.children.splice(index, 0, joint);
    return joint;
  });
  const body = new OperatorBody(variant, material, joints);
  group.add(body); bodies.set(group, body); group.updateMatrixWorld(true);
}

export function disposeOperatorBody(group: THREE.Group): void {
  bodies.get(group)?.release(); bodies.delete(group);
}
