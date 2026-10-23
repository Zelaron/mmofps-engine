import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { buildRig, animateRig, disposeRig, PlayerModels } from '../src/render/players.js';
import { DeathScene } from '../src/render/death-scene.js';
import type { PlayerView } from '../src/interp.js';

function body(root: THREE.Object3D): THREE.SkinnedMesh {
  const mesh = root.getObjectByName('operator-body');
  assert.ok(mesh instanceof THREE.SkinnedMesh);
  return mesh;
}

function view(id: number, extra: Partial<PlayerView> = {}): PlayerView {
  return { id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, dead: false, grounded: true,
    weapon: 1, vehicle: 0, heading: 0, vx: 0, vy: 0, vz: 0, ...extra };
}

function palette(mesh: THREE.SkinnedMesh, index: number): THREE.Matrix4 {
  return new THREE.Matrix4().fromArray(mesh.skeleton.boneMatrices, index * 16)
    .premultiply(mesh.bindMatrixInverse).multiply(mesh.bindMatrix);
}

function contained(mesh: THREE.SkinnedMesh, point: THREE.Vector3): void {
  assert.ok(mesh.boundingBox && mesh.boundingSphere, 'bounds are provided by the current pose update');
  assert.ok(mesh.boundingBox.distanceToPoint(point) <= 2e-6, 'packed vertex remains inside the current box');
  assert.ok(point.distanceTo(mesh.boundingSphere.center) <= mesh.boundingSphere.radius + 2e-6,
    'packed vertex remains inside the current sphere');
}

test('rigid skin preserves fixed limb scales, normals and winding under animated and far-world transforms', async () => {
  // A separate ESM instance isolates the bounded 0..23 variant cache from the
  // genuine buildRig integration tests. No production cache/reset hook is needed.
  const syntheticUrl = new URL('../src/render/operator-body.ts?synthetic-rigid-test', import.meta.url);
  const helper = await import(syntheticUrl.href) as typeof import('../src/render/operator-body.js');
  const group = new THREE.Group(), gunMount = new THREE.Group(), root = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -.13, -.21, .04, .19, .03, -.12, .02, .31, .24,
  ], 3));
  geometry.computeVertexNormals();
  geometry.setAttribute('color', new THREE.Float32BufferAttribute([.2, .4, .6, .3, .5, .7, .4, .6, .8], 3));
  const material = new THREE.MeshLambertMaterial({ vertexColors: true });
  const originals = Array.from({ length: 15 }, (_, index) => {
    const joint = new THREE.Group(), mesh = new THREE.Mesh(geometry, material);
    joint.position.set((index % 3 - 1) * .35, index * .09, (index % 2) * .1);
    joint.rotation.set(.03 * index, -.02 * index, .01 * index);
    joint.scale.set(1, index % 3 === 0 ? .335 : index % 3 === 1 ? .29 : 1, 1);
    mesh.name = `part-${index}`;
    joint.add(mesh); group.add(joint);
    return { joint, mesh };
  });
  group.add(gunMount);
  helper.installOperatorBody(group, gunMount, 0);
  root.add(group);
  const merged = body(group), p = merged.geometry.getAttribute('position'), n = merged.geometry.getAttribute('normal');
  const sourcePosition = geometry.getAttribute('position'), sourceNormal = geometry.getAttribute('normal');
  const spans = merged.userData.operatorParts as { name: string; start: number; count: number }[];
  assert.equal(spans.length, 15); assert.equal(merged.geometry.index, null);
  assert.equal(merged.frustumCulled, true);
  const expected = new THREE.Vector3(), actual = new THREE.Vector3();
  const expectedNormal = new THREE.Vector3(), actualNormal = new THREE.Vector3();
  const triangleA = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const triangleB = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const normalA = new THREE.Vector3(), normalB = new THREE.Vector3(), edge = new THREE.Vector3();
  try {
    for (let pose = 0; pose < 4; pose++) {
      root.position.set(pose ? -2990 : 0, pose ? 60 : 0, pose ? -5223 : 0);
      root.rotation.set(.2 * pose, -.4 * pose, .1 * pose, 'YXZ');
      root.scale.set(pose === 3 ? 1.2 : 1, pose === 3 ? .8 : 1, pose === 3 ? 1.1 : 1);
      for (let index = 0; index < originals.length; index++) {
        const joint = originals[index].joint;
        joint.rotation.set(.03 * index + .3 * pose, -.02 * index - .2 * pose, .01 * index + .4 * pose);
        joint.position.z = index % 2 * .1 + .05 * pose;
      }
      root.updateMatrixWorld(true); merged.skeleton.update();
      const modelNormal = new THREE.Matrix3().getNormalMatrix(merged.matrixWorld);
      for (let index = 0; index < originals.length; index++) {
        const original = originals[index], span = spans[index], skin = palette(merged, index);
        const originalWorld = new THREE.Matrix4().multiplyMatrices(original.joint.matrixWorld, original.mesh.matrix);
        const originalNormal = new THREE.Matrix3().getNormalMatrix(originalWorld);
        assert.equal(span.name, original.mesh.name); assert.equal(span.start, index * 3); assert.equal(span.count, 3);
        for (let vertex = 0; vertex < 3; vertex++) {
          const at = span.start + vertex;
          expected.fromBufferAttribute(sourcePosition, vertex).applyMatrix4(originalWorld);
          actual.fromBufferAttribute(p, at).applyMatrix4(skin);
          contained(merged, actual);
          actual.applyMatrix4(merged.matrixWorld);
          assert.ok(expected.distanceTo(actual) < 5e-6, 'Float32 palette preserves original rigid vertex');
          expectedNormal.fromBufferAttribute(sourceNormal, vertex).applyMatrix3(originalNormal).normalize();
          // Skin normals use the linear palette, not its inverse transpose.
          actualNormal.fromBufferAttribute(n, at).transformDirection(skin).applyMatrix3(modelNormal).normalize();
          assert.ok(expectedNormal.distanceTo(actualNormal) < 2e-5, 'fixed nonuniform limb scale cancels correctly');
          triangleA[vertex].copy(expected); triangleB[vertex].copy(actual);
          for (const component of ['getX', 'getY', 'getZ'] as const) {
            assert.equal(merged.geometry.getAttribute('color')[component](at), geometry.getAttribute('color')[component](vertex));
          }
        }
        normalA.subVectors(triangleA[1], triangleA[0]).cross(edge.subVectors(triangleA[2], triangleA[0])).normalize();
        normalB.subVectors(triangleB[1], triangleB[0]).cross(edge.subVectors(triangleB[2], triangleB[0])).normalize();
        assert.ok(normalA.dot(normalB) > .99999, 'triangle winding remains outward');
      }
    }
  } finally { helper.disposeOperatorBody(group); geometry.dispose(); material.dispose(); }
});

test('all 24 uniforms share bounded geometry while each actor owns its palette and inverses', () => {
  const rigs = Array.from({ length: 48 }, (_, id) => buildRig(id));
  try {
    const meshes = rigs.map(rig => body(rig.group));
    assert.equal(new Set(meshes.map(mesh => mesh.geometry)).size, 24);
    for (let index = 0; index < 24; index++) {
      const a = meshes[index], b = meshes[index + 24];
      assert.equal(a.geometry, b.geometry);
      assert.notEqual(a.skeleton, b.skeleton); assert.notEqual(a.skeleton.boneMatrices, b.skeleton.boneMatrices);
      assert.equal(a.userData.operatorParts.length, 15);
      for (let part = 0; part < 15; part++) {
        assert.notEqual(a.skeleton.bones[part], b.skeleton.bones[part]);
        assert.notEqual(a.skeleton.boneInverses[part], b.skeleton.boneInverses[part]);
        assert.equal(a.skeleton.bones[part].parent, null);
      }
    }
    rigs[24].group.updateMatrixWorld(true); meshes[24].skeleton.update();
    const savedPalette = meshes[24].skeleton.boneMatrices.slice();
    animateRig(rigs[0], view(0, { weapon: 7, pitch: -1.4, grounded: false, vy: 8 }), .1);
    rigs[0].group.position.set(10600, 719, -10000); rigs[0].group.updateMatrixWorld(true); meshes[0].skeleton.update();
    assert.deepEqual(meshes[24].skeleton.boneMatrices, savedPalette);
    for (const number of meshes[0].skeleton.boneMatrices) assert.ok(Number.isFinite(number) && Math.abs(number) < 5,
      'world translation never enters the local Float32 palette');
  } finally { for (const rig of rigs) disposeRig(rig); }
});

test('real walking, aim, airborne and landing poses update conservative skin bounds', () => {
  const rig = buildRig(5), root = new THREE.Group(); root.add(rig.group);
  root.position.set(-2990, 60, -5223); root.rotation.set(.2, 1.3, -.1);
  const merged = body(rig.group), positions = merged.geometry.getAttribute('position');
  const weights = merged.geometry.getAttribute('skinWeight'), indices = merged.geometry.getAttribute('skinIndex');
  const states = [view(5, { z: -.5, vz: -8 }), view(5, { x: .5, z: -.5, vx: 8, pitch: 1.5, weapon: 9 }),
    view(5, { x: 1, y: .7, grounded: false, vy: 8, pitch: -1.5, weapon: 3 }),
    view(5, { x: 1.1, y: .2, grounded: false, vy: -12 }), view(5, { x: 1.1 })];
  const boxes = new Set<string>(), point = new THREE.Vector3();
  try {
    for (const state of states) {
      animateRig(rig, state, .1); root.updateMatrixWorld(true); merged.skeleton.update();
      assert.equal(merged.frustumCulled, true);
      const matrices = merged.skeleton.bones.map((_, index) => palette(merged, index));
      for (let vertex = 0; vertex < positions.count; vertex++) {
        const part = indices.getX(vertex);
        assert.equal(weights.getX(vertex), 1); assert.equal(weights.getY(vertex) + weights.getZ(vertex) + weights.getW(vertex), 0);
        assert.ok(Number.isInteger(part) && part >= 0 && part < 15);
        point.fromBufferAttribute(positions, vertex).applyMatrix4(matrices[part]); contained(merged, point);
      }
      boxes.add(JSON.stringify([merged.boundingBox!.min.toArray(), merged.boundingBox!.max.toArray()]));
    }
    assert.ok(boxes.size > 2, 'bounds track animation rather than retaining the bind pose');
  } finally { disposeRig(rig); }
});

test('actor departure, population reset and corpse replacement release only owned skin resources once', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const context = { measureText: () => ({ width: 100 }), beginPath() {}, roundRect() {}, fill() {}, fillText() {} };
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ width: 256, height: 56, hidden: true, style: { cssText: '' }, getContext: () => context }),
    body: { append() {} },
  } });
  const models = new PlayerModels(), deaths = new DeathScene();
  const watched = new Set<THREE.BufferGeometry | THREE.Material>();
  let sharedDisposals = 0;
  const sharedDisposed = () => sharedDisposals++;
  const watch = (mesh: THREE.SkinnedMesh): (() => number) => {
    mesh.skeleton.computeBoneTexture(); const texture = mesh.skeleton.boneTexture!; let disposed = 0;
    texture.addEventListener('dispose', () => disposed++);
    for (const resource of [mesh.geometry, ...(Array.isArray(mesh.material) ? mesh.material : [mesh.material])]) {
      if (!watched.has(resource)) { watched.add(resource); resource.addEventListener('dispose', sharedDisposed); }
    }
    return () => disposed;
  };
  try {
    models.update([view(1), view(25)], new Map(), 1 / 60);
    const first = body(models.group.children[0]), survivor = body(models.group.children[1]);
    const departed = watch(first), remaining = watch(survivor);
    models.update([view(25)], new Map(), 1 / 60);
    assert.equal(departed(), 1); assert.equal(remaining(), 0);
    models.remove(1); assert.equal(departed(), 1);
    models.clear(); models.clear(); assert.equal(remaining(), 1);
    models.update([view(1)], new Map(), 1 / 60);
    const returned = body(models.group), returnedDisposed = watch(returned);
    assert.equal(returned.geometry, first.geometry); assert.notEqual(returned.skeleton, first.skeleton);
    models.clear(); assert.equal(returnedDisposed(), 1);

    const camera = new THREE.PerspectiveCamera(), motion = { x: 0, y: 2, z: 0, vx: 0, vy: 6, vz: 0, yaw: .2 };
    deaths.begin(1, motion, false, camera, 0); const replaced = watch(body(deaths.group));
    deaths.begin(1, motion, false, camera, 0); assert.equal(replaced(), 1);
    const replacement = watch(body(deaths.group));
    deaths.remove(1); deaths.remove(1); assert.equal(replacement(), 1);
    deaths.begin(2, motion, false, camera, 0); const cleared = watch(body(deaths.group));
    deaths.clear(); deaths.clear(); assert.equal(cleared(), 1);
    assert.equal(sharedDisposals, 0, 'shared uniform geometry and material survive every owned cleanup');
  } finally {
    models.clear(); deaths.clear();
    for (const resource of watched) resource.removeEventListener('dispose', sharedDisposed);
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});
