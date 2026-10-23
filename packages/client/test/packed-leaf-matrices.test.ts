import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WEAPONS } from '@shared/weapons';
import type { World } from '@shared/worldgen';
import type { PlayerView } from '../src/interp.js';
import { buildRig, animateRig } from '../src/render/players.js';
import { buildWeaponModel, cloneWorldWeapon, poseWeaponReload } from '../src/render/weapon-models.js';
import { DeathScene } from '../src/render/death-scene.js';

function ordinaryMatrices(root: THREE.Object3D): void {
  root.traverse(object => { object.matrixAutoUpdate = true; });
}
function state(root: THREE.Object3D): unknown[] {
  const result: unknown[] = [];
  root.traverse(object => result.push({ name: object.name, type: object.type, visible: object.visible,
    local: [...object.matrix.elements], world: [...object.matrixWorld.elements] }));
  return result;
}
function parent(root: THREE.Object3D): THREE.Group {
  const group = new THREE.Group(); group.add(root); return group;
}
function moveParent(group: THREE.Object3D, frame: number): void {
  group.position.set(1200 + frame * .3, 50 - frame * .07, -2300 + frame * .11);
  group.rotation.set(Math.sin(frame * .13) * .3, frame * .019, -.18, 'YXZ');
  group.scale.set(1.1, .85, frame % 2 ? -1.25 : 1.25);
}
function compare(a: THREE.Object3D, b: THREE.Object3D): void {
  a.updateMatrixWorld(); b.updateMatrixWorld();
  assert.deepEqual(state(a), state(b));
}
function frozenLeaves(root: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  root.traverse(object => {
    if (object instanceof THREE.Bone) {
      assert.equal(object.matrixAutoUpdate, false, 'fixed operator part: ' + object.name);
      assert.equal(object.matrixWorldAutoUpdate, true, 'fixed parts must follow animated joints');
    } else if (object instanceof THREE.SkinnedMesh) {
      assert.equal(object.name, 'operator-body');
      assert.equal(object.matrixAutoUpdate, true, 'skinned body keeps its ordinary matrix update');
      assert.equal(object.matrixWorldAutoUpdate, true, 'skinned body follows the rig');
    } else if (object instanceof THREE.Mesh) {
      assert.equal(object.matrixAutoUpdate, false, object.name);
      assert.equal(object.matrixWorldAutoUpdate, true, 'decorations must follow moving parents');
      meshes.push(object);
    } else assert.equal(object.matrixAutoUpdate, true, 'articulated groups remain dynamic');
  });
  return meshes;
}
function frozenOperatorParts(root: THREE.Object3D): THREE.Bone[] {
  const body = root.getObjectByName('operator-body');
  assert.ok(body instanceof THREE.SkinnedMesh);
  const joints: THREE.Bone[] = [];
  root.traverse(object => { if (object instanceof THREE.Bone) joints.push(object); });
  assert.equal(joints.length, 15, 'all original rigid part transforms remain in the rig');
  const spans = body.userData.operatorParts as { name: string }[];
  assert.equal(spans.length, 15);
  assert.deepEqual(joints.map(joint => joint.name), spans.map(span => span.name));
  return joints;
}

test('packed operator leaves retain every matrix through travel, aiming, weapon changes and reparenting', () => {
  for (const id of [0, 7, 23]) {
    const cached = buildRig(id), ordinary = buildRig(id);
    let a = parent(cached.group), b = parent(ordinary.group);
    const view: PlayerView = { id, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, dead: false, grounded: true,
      weapon: 1, vehicle: 0, heading: 0, vx: 0, vy: 0, vz: 0 };
    for (let frame = 0; frame < 120; frame++) {
      view.x += .07; view.z -= .11; view.y = Math.sin(frame * .1) * .2;
      view.yaw = Math.sin(frame * .3); view.pitch = Math.sin(frame * .2) * .9;
      view.grounded = frame < 30 || frame > 55; view.vy = view.grounded ? 0 : 6 - (frame - 30) * .5;
      view.weapon = Math.floor(frame / 12) % WEAPONS.length;
      for (const rig of [cached, ordinary]) {
        rig.group.position.set(view.x, view.y, view.z); rig.group.rotation.y = view.yaw;
        animateRig(rig, view, 1 / 60);
      }
      ordinaryMatrices(ordinary.group); // Also restore canonical updates on newly swapped weapon clones.
      if (frame === 60) { a = parent(cached.group); b = parent(ordinary.group); }
      moveParent(a, frame); moveParent(b, frame); compare(a, b);
      frozenLeaves(cached.group); frozenOperatorParts(cached.group);
    }
  }
});

test('all weapon reload pivots stay dynamic while packed leaves and world clones preserve exact matrices', () => {
  for (let weapon = 0; weapon < WEAPONS.length; weapon++) {
    for (const detail of [false, true]) {
      const cached = buildWeaponModel(weapon, detail), ordinary = buildWeaponModel(weapon, detail);
      ordinaryMatrices(ordinary.group);
      let a = parent(cached.group), b = parent(ordinary.group);
      for (let frame = 0; frame <= 40; frame++) {
        const progress = frame === 40 ? -1 : frame / 39, kick = Math.max(0, 1 - frame / 8);
        poseWeaponReload(cached, weapon, progress, kick); poseWeaponReload(ordinary, weapon, progress, kick);
        if (frame === 20) { a = parent(cached.group); b = parent(ordinary.group); }
        moveParent(a, frame); moveParent(b, frame); compare(a, b);
      }
      frozenLeaves(cached.group);
      for (const rest of cached.rests) assert.equal(rest.obj.matrixAutoUpdate, true, rest.obj.name);
    }
    const first = cloneWorldWeapon(weapon), second = cloneWorldWeapon(weapon), cloned = first.clone(true);
    const leaves = frozenLeaves(first), copyLeaves = frozenLeaves(cloned);
    assert.equal(leaves.length, copyLeaves.length);
    for (let i = 0; i < leaves.length; i++) {
      assert.equal(leaves[i].geometry, copyLeaves[i].geometry, 'Three clone preserves shared packed geometry');
      assert.notEqual(leaves[i].matrix, copyLeaves[i].matrix, 'clone owns its local matrix');
    }
    ordinaryMatrices(second);
    const a = parent(cloned), b = parent(second); moveParent(a, weapon + 8); moveParent(b, weapon + 8); compare(a, b);
  }
});

test('actual corpse falling and camera poses retain exact matrices with cached decorative leaves', t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: () => ({ hidden: true, style: {}, textContent: '' }), body: { append() {} },
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document'); });
  const a = new DeathScene(), b = new DeathScene(), cameraA = new THREE.PerspectiveCamera(), cameraB = new THREE.PerspectiveCamera();
  const world = { trace(x: number, y: number, z: number, dx: number, dy: number, dz: number, distance: number) {
    const floor = dy < 0 ? -y / dy : Infinity, hit = floor >= 0 && floor <= distance, dist = hit ? floor : distance;
    return { hit, dist, x: x + dx * dist, y: y + dy * dist, z: z + dz * dist, nx: 0, ny: 1, nz: 0 };
  } } as World;
  for (const scene of [a, b]) for (const id of [3, 8]) scene.begin(id,
    { x: id, y: 3, z: 0, vx: id === 3 ? 20 : 0, vy: id === 3 ? 12 : 0, vz: 2, yaw: .4 },
    id === 8, scene === a ? cameraA : cameraB, 0);
  ordinaryMatrices(b.group);
  let pa = parent(a.group), pb = parent(b.group);
  for (let frame = 0; frame < 100; frame++) {
    a.update(world, cameraA, .03, frame * .03, true); b.update(world, cameraB, .03, frame * .03, true);
    if (frame === 50) { pa = parent(a.group); pb = parent(b.group); }
    moveParent(pa, frame); moveParent(pb, frame); compare(pa, pb);
    cameraA.updateMatrixWorld(); cameraB.updateMatrixWorld(); assert.deepEqual(state(cameraA), state(cameraB));
  }
  frozenLeaves(a.group); a.clear(); b.clear();
});

test('cached leaves eliminate local compose calls without suppressing joint or world updates', () => {
  const cached = buildRig(5), ordinary = buildRig(5);
  ordinaryMatrices(ordinary.group);
  let cachedCalls = 0, ordinaryCalls = 0;
  for (const [rig, count] of [[cached, () => { cachedCalls++; }], [ordinary, () => { ordinaryCalls++; }]] as const)
    rig.group.traverse(object => {
      if (!(object instanceof THREE.Bone) && !(object instanceof THREE.Mesh && !(object instanceof THREE.SkinnedMesh))) return;
      const original = object.updateMatrix;
      object.updateMatrix = function() { count(); original.call(this); };
    });
  const a = parent(cached.group), b = parent(ordinary.group);
  const leaves = frozenLeaves(cached.group).length + frozenOperatorParts(cached.group).length;
  for (let frame = 0; frame < 30; frame++) { moveParent(a, frame); moveParent(b, frame); compare(a, b); }
  assert.equal(cachedCalls, 0); assert.equal(ordinaryCalls, leaves * 30);
  assert.notDeepEqual(cached.group.children[0].matrixWorld.elements, new THREE.Matrix4().elements,
    'world transforms continue following the parent');
});
