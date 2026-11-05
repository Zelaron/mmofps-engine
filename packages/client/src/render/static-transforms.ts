import type * as THREE from 'three';

/** Freeze local transforms that never change after construction. Three.js
 * otherwise recomposes every object's matrix each frame; thousands of static
 * sub-parts (loot crates, flags, empty instanced meshes) add up. World
 * matrices still follow their animated parents. */
export function freezeStatic(object: THREE.Object3D, includeRoot = false): void {
  object.traverse(child => {
    if (child === object && !includeRoot) return;
    child.updateMatrix();
    child.matrixAutoUpdate = false;
  });
}
