import * as THREE from 'three';

/** Content that is built only when it streams in (for example the Vesper
 * citadels) has no mesh in the scene during loading. Its renderer registers a
 * template made with the real material, object type and vertex attributes. */
const templates: THREE.Object3D[] = [];
export function registerDrawWarmup(...objects: THREE.Object3D[]): void { templates.push(...objects); }

/** Hands the registered templates to the next warm-up pass. */
export function takeDrawWarmupTemplates(): THREE.Object3D[] { return templates.splice(0); }

/** A template geometry with float attributes of the given item sizes
 * (per-vertex, and optionally per-instance). Only the layout matters. */
export function warmupLayout(attributes: Record<string, number>, instanced: Record<string, number> = {}): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  for (const [name, size] of Object.entries(attributes)) geometry.setAttribute(name, new THREE.Float32BufferAttribute(new Float32Array(size * 3), size));
  for (const [name, size] of Object.entries(instanced)) geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(size), size));
  return geometry;
}
