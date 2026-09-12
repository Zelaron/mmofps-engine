import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { TeleporterRenderer } from '../src/render/teleporters.js';
import type { EncounterSource } from '../src/render/encounter-stream.js';
import type { TeleporterPad } from '@shared/index';

function fixture(pads: TeleporterPad[]) {
  let disposed = 0;
  const field = { pads, revision: 1, stats: { cached: 9, wanted: 9, pending: null },
    update: () => false, dispose: () => { disposed++; } } satisfies EncounterSource;
  return { field, disposed: () => disposed };
}

test('regional teleporters retain three bounded draw pools while crossing and revisiting districts', () => {
  const pads: TeleporterPad[] = Array.from({ length: 400 }, (_, i) =>
    ({ x: i * 4, y: 10, z: i % 4 * 5, cave: false, partner: i ^ 1 }));
  const f = fixture(pads), renderer = new TeleporterRenderer(f.field);
  const meshes = renderer.group.children as THREE.InstancedMesh[];
  assert.equal(meshes.length, 3);
  for (const x of [0, 400, 800, 1200, 20000, 0]) {
    renderer.update(1 / 60, x, 12, 0);
    for (const mesh of meshes) {
      assert.ok(mesh.count <= 48);
      assert.ok(mesh.instanceMatrix.array.every(Number.isFinite));
    }
    if (x === 20000) assert.equal(renderer.stats.visible, 0);
    else assert.equal(renderer.stats.visible, 48);
  }
  let released = 0;
  for (const mesh of meshes) mesh.geometry.addEventListener('dispose', () => released++);
  renderer.dispose();
  assert.equal(released, 3);
  assert.equal(f.disposed(), 1);
});

test('return guide favors the current cave floor and excludes surface pads', () => {
  const pads = [
    { x: 0, y: 30, z: 0, cave: false, partner: 1 },
    { x: 4, y: -5, z: 0, cave: true, partner: 0 },
    { x: 100, y: -30, z: 0, cave: true, partner: 0 },
  ];
  const renderer = new TeleporterRenderer(fixture(pads).field);
  assert.equal(renderer.nearestReturn(0, -30, 0), pads[2]);
  assert.equal(renderer.nearestReturn(0, -5, 0), pads[1]);
  assert.equal(renderer.nearestReturn(3000, -5, 0), null);
  renderer.dispose();
});
