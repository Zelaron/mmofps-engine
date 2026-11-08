import * as THREE from 'three';
import { VEHICLE, VEHICLE_VARIANT, type VehicleType } from '@shared/vehicles';
import { buildVehicleHull, disposeVehicleHull, trainArtilleryModel } from './vehicles.js';
import { takeDrawWarmupTemplates } from './draw-warmup-registry.js';

/** Some GPU backends (ANGLE on Direct3D 11 in particular) finish a shader
 * program only when it is first drawn. Compiling ahead of time (the scene's
 * shader preparation) is not enough: the first draw of a pooled mesh, of a
 * district that streams in, or of the first jet that flies past used to
 * freeze a frame for 50-480 ms in the middle of play.
 *
 * Before the world is presented, still behind the loading screen, this draws
 * one probe for every material, object kind and vertex layout in the scene,
 * plus every registered template, every vehicle hull and the plain material
 * families. Probes have degenerate geometry and sit behind the camera, so
 * they never produce a pixel, but each one issues a real draw call through
 * the real pipeline (lighting target, fog, shadows). */

const WHITE = new THREE.Color(1, 1, 1);
const layouts = new WeakMap<THREE.BufferGeometry, string>();

type Drawable = THREE.Mesh | THREE.Points | THREE.Line | THREE.Sprite;
const drawable = (object: THREE.Object3D): object is Drawable => {
  const o = object as Partial<THREE.Mesh & THREE.Points & THREE.Line & THREE.Sprite>;
  return !!(o.isMesh || o.isPoints || o.isLine || o.isSprite) && !!o.material;
};

function layoutOf(geometry: THREE.BufferGeometry): string {
  let key = layouts.get(geometry);
  if (key !== undefined) return key;
  key = '';
  for (const name in geometry.attributes) {
    const a = geometry.attributes[name] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    key += `${name}:${a.itemSize}:${a.array.constructor.name}:${a.normalized ? 1 : 0}:${isInstanced(a) ? 1 : 0};`;
  }
  if (Object.keys(geometry.morphAttributes).length) key += 'morph;';
  layouts.set(geometry, key);
  return key;
}

function isInstanced(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): boolean {
  return !!(a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute ||
    !!((a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && (a as THREE.InterleavedBufferAttribute).data instanceof THREE.InstancedInterleavedBuffer);
}

/** Same attribute names, item sizes, component types and normalization (so
 * the same driver vertex layout), but three zero vertices: a degenerate draw. */
function layoutClone(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const name in source.attributes) {
    const a = source.attributes[name] as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    const instanced = isInstanced(a), ArrayType = a.array.constructor as new (length: number) => THREE.TypedArray;
    const data = new ArrayType(a.itemSize * (instanced ? 1 : 3));
    const copy = instanced ? new THREE.InstancedBufferAttribute(data, a.itemSize, a.normalized) : new THREE.BufferAttribute(data, a.itemSize, a.normalized);
    const gpuType = (a as THREE.BufferAttribute).gpuType;
    if (gpuType !== undefined) copy.gpuType = gpuType;
    geometry.setAttribute(name, copy);
  }
  for (const group of source.groups) geometry.addGroup(0, 3, group.materialIndex);
  return geometry;
}

/** A degenerate stand-in for `object` that produces the same shader program. */
function probeFor(object: Drawable, instanceColor: boolean): THREE.Object3D | null {
  const material = object.material as THREE.Material | THREE.Material[];
  let probe: THREE.Object3D;
  if ((object as THREE.Sprite).isSprite) {
    probe = new THREE.Sprite(material as THREE.SpriteMaterial);
    probe.scale.setScalar(1e-4);
  } else {
    const geometry = layoutClone((object as THREE.Mesh).geometry);
    if ((object as THREE.InstancedMesh).isInstancedMesh) {
      const mesh = new THREE.InstancedMesh(geometry, material, 1);
      if (instanceColor) mesh.setColorAt(0, WHITE);
      probe = mesh;
    } else if ((object as THREE.Mesh).isMesh) probe = new THREE.Mesh(geometry, material);
    else if ((object as THREE.Points).isPoints) probe = new THREE.Points(geometry, material);
    else if ((object as THREE.LineSegments).isLineSegments) probe = new THREE.LineSegments(geometry, material);
    else if ((object as THREE.LineLoop).isLineLoop) probe = new THREE.LineLoop(geometry, material);
    else probe = new THREE.Line(geometry, material);
  }
  probe.castShadow = object.castShadow; probe.receiveShadow = object.receiveShadow;
  probe.layers.mask = object.layers.mask;
  probe.customDepthMaterial = object.customDepthMaterial; probe.customDistanceMaterial = object.customDistanceMaterial;
  probe.frustumCulled = false;
  probe.userData.drawWarmupProbe = true;
  return probe;
}

function disposeProbe(probe: THREE.Object3D): void {
  if ((probe as THREE.InstancedMesh).isInstancedMesh) (probe as THREE.InstancedMesh).dispose();
  if (!(probe as THREE.Sprite).isSprite) (probe as THREE.Mesh).geometry?.dispose();
}

export class DrawWarmup {
  private readonly group = new THREE.Group();
  /** Plain material families, kept alive so their programs stay linked after
   * the warm-up: streamed props that use the same variant reuse them. */
  private readonly families: THREE.Material[] = [];
  private readonly family = new THREE.BufferGeometry();
  private hulls: THREE.Group[] = [];
  private probes: THREE.Object3D[] = [];
  private readonly seen = new Set<string>();
  private frames = 0;
  private drawn = 0;
  done = false;

  constructor(private readonly scene: THREE.Scene, private readonly frameCount = 3) {
    this.group.name = 'draw-warmup';
    this.family.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    this.family.setAttribute('normal', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    this.family.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(9), 3));
    for (const Material of [THREE.MeshLambertMaterial, THREE.MeshPhongMaterial, THREE.MeshStandardMaterial])
      for (const vertexColors of [false, true]) this.families.push(new Material({ vertexColors }));
    this.arm();
  }

  /** Starts a warm-up pass (on load and whenever a new world is built). */
  arm(): void {
    this.finish();
    this.done = false; this.frames = 0; this.seen.clear();
    const kinds: [VehicleType, number][] = [
      [VEHICLE.JEEP, VEHICLE_VARIANT.COMMON], [VEHICLE.TANK, VEHICLE_VARIANT.COMMON], [VEHICLE.TANK, VEHICLE_VARIANT.BASTION],
      [VEHICLE.JET, VEHICLE_VARIANT.COMMON], [VEHICLE.JET, VEHICLE_VARIANT.NOCTURNE], [VEHICLE.GUNBOAT, VEHICLE_VARIANT.COMMON],
      [VEHICLE.GUNBOAT, VEHICLE_VARIANT.DESTROYER], [VEHICLE.JET, VEHICLE_VARIANT.CONDOR],
    ];
    for (const [type, variant] of kinds) this.hulls.push(buildVehicleHull(type, variant));
    this.hulls.push(trainArtilleryModel());
    for (const hull of this.hulls) {
      hull.scale.setScalar(1e-4);
      hull.traverse(object => { object.frustumCulled = false; });
      this.group.add(hull);
    }
    // Plain Lambert/Phong/Standard with and without vertex colors, as plain,
    // instanced and color-instanced meshes.
    for (const material of this.families) for (const kind of [0, 1, 2]) {
      const mesh = kind ? new THREE.InstancedMesh(this.family, material, 1) : new THREE.Mesh(this.family, material);
      if (kind === 2) (mesh as THREE.InstancedMesh).setColorAt(0, WHITE);
      mesh.receiveShadow = true; mesh.frustumCulled = false;
      this.probes.push(mesh); this.group.add(mesh);
    }
    this.scene.add(this.group);
  }

  /** Call every frame before rendering. `prepared` means the scene's shaders
   * are compiled and frames are being drawn (still behind the loading
   * screen); presentation waits until `done`. */
  update(camera: THREE.Camera, prepared: boolean): void {
    if (this.done) return;
    this.collect();
    // Behind the eye: every probe is clipped, but every draw call is issued.
    camera.getWorldDirection(this.group.position).multiplyScalar(-2).add(camera.position);
    if (!prepared || ++this.frames <= this.frameCount) return;
    this.finish();
    this.done = true;
  }

  /** Adds probes for combinations that appeared since the last frame. */
  private collect(): void {
    for (const template of takeDrawWarmupTemplates()) template.traverse(object => { if (drawable(object)) this.add(object); });
    const stack: THREE.Object3D[] = [this.scene];
    while (stack.length) {
      const object = stack.pop()!;
      if (object === this.group) continue;
      if (drawable(object) && !(object as THREE.SkinnedMesh).isSkinnedMesh && !(object as THREE.BatchedMesh).isBatchedMesh) this.add(object);
      for (const child of object.children) stack.push(child);
    }
  }

  private add(object: Drawable): void {
    const material = object.material as THREE.Material | THREE.Material[];
    const materials = Array.isArray(material) ? material.map(m => m.id).join('+') : `${material.id}`;
    const instanced = (object as THREE.InstancedMesh).isInstancedMesh === true;
    const kind = (object as THREE.Sprite).isSprite ? 's' : instanced ? 'i' : (object as THREE.Mesh).isMesh ? 'm'
      : (object as THREE.Points).isPoints ? 'p' : (object as THREE.LineSegments).isLineSegments ? 'ls' : (object as THREE.LineLoop).isLineLoop ? 'll' : 'l';
    const layout = (object as THREE.Sprite).isSprite ? '' : layoutOf((object as THREE.Mesh).geometry);
    // Pools usually receive their per-instance colors only when filled, which
    // switches them to a different program. Warm both variants of empty pools.
    const colored = instanced && !!(object as THREE.InstancedMesh).instanceColor;
    const variants = instanced && !colored && (object as THREE.InstancedMesh).count === 0 ? [false, true] : [colored];
    for (const instanceColor of variants) {
      const signature = `${kind}${instanceColor ? 'c' : ''}|${materials}|${layout}`;
      if (this.seen.has(signature)) continue;
      this.seen.add(signature);
      const probe = probeFor(object, instanceColor);
      if (probe) { this.probes.push(probe); this.group.add(probe); }
    }
  }

  private finish(): void {
    if (this.probes.length) this.drawn = this.probes.length;
    this.scene.remove(this.group);
    for (const hull of this.hulls) disposeVehicleHull(hull);
    for (const probe of this.probes) { probe.removeFromParent(); if (probe.userData.drawWarmupProbe) disposeProbe(probe); else if ((probe as THREE.InstancedMesh).isInstancedMesh) (probe as THREE.InstancedMesh).dispose(); }
    this.family.dispose();
    this.hulls = []; this.probes = [];
  }

  /** Probes in the current pass, or drawn by the last one (diagnostics). */
  get stats(): { probes: number; done: boolean } {
    return { probes: this.done ? this.drawn : this.probes.length, done: this.done };
  }
}
