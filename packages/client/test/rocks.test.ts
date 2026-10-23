import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { rockProfile, type World, type RBox } from '@shared/index';
import { boulderGeometry, RockRenderer, ROCK_NEAR_BUDGET, ROCK_RENDER_RADIUS } from '../src/render/rocks.js';
import type { ScenerySource } from '../src/render/scenery-stream.js';

function projectGranite(point: THREE.Vector3, variation: number): THREE.Vector3 {
  let low = 0, high = 2;
  for (let step = 0; step < 24; step++) {
    const scale = (low + high) * 0.5;
    if (rockProfile(point.x * scale, point.y * scale, point.z * scale, variation) < 0) low = scale;
    else high = scale;
  }
  return point.multiplyScalar((low + high) * 0.5);
}

test('rock meshes retain exact fracture faces and follow continuous granite variation', () => {
  for (let family = 0; family < 4; family++) {
    for (const near of [false, true]) {
      const geometry = boulderGeometry(family, near);
      const p = geometry.getAttribute('position');
      const normal = geometry.getAttribute('normal');
      assert.ok(p.count / 3 <= (near ? 400 : 180));
      let maxError = 0;
      let faceError = 0;
      for (const t of family === 0 ? [0, 0.2, 0.4, 0.6, 0.8, 1] : [0]) {
        const variation = family === 0 ? t * 0.249999 : (family + 0.5) / 4;
        for (let i = 0; i < p.count; i++) {
          const point = new THREE.Vector3().fromBufferAttribute(p, i);
          if (family === 0) projectGranite(point, variation);
          assert.ok(Number.isFinite(point.length()));
          assert.ok(Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z)) < 1.0001);
          assert.ok(Math.abs(new THREE.Vector3().fromBufferAttribute(normal, i).length() - 1) < 0.001);
          maxError = Math.max(maxError, Math.abs(rockProfile(point.x, point.y, point.z, variation)));
        }
        for (let i = 0; i < p.count; i += 3) {
          const midpoint = new THREE.Vector3();
          for (let k = i; k < i + 3; k++) {
            const point = new THREE.Vector3().fromBufferAttribute(p, k);
            midpoint.add(family === 0 ? projectGranite(point, variation) : point);
          }
          midpoint.multiplyScalar(1 / 3);
          faceError = Math.max(faceError, Math.abs(rockProfile(midpoint.x, midpoint.y, midpoint.z, variation)));
        }
      }
      assert.ok(maxError < 0.00001, `family ${family}, near ${near}: vertex surface error ${maxError}`);
      assert.ok(faceError < (family ? 0.00001 : near ? 0.03 : 0.075),
        `family ${family}, near ${near}: face approximation ${faceError}`);
      geometry.dispose();
    }
  }
});

test('clipped rocks are closed, outward-facing, and retain the concave talus crown', () => {
  const ray = new THREE.Raycaster();
  for (let family = 0; family < 4; family++) {
    const geometry = boulderGeometry(family, true);
    const positions = geometry.getAttribute('position');
    if (family === 0) {
      for (let i = 0; i < positions.count; i++) {
        const p = projectGranite(new THREE.Vector3().fromBufferAttribute(positions, i), 0.125);
        positions.setXYZ(i, p.x, p.y, p.z);
      }
    }
    const material = new THREE.MeshBasicMaterial();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.updateMatrixWorld();
    for (let sample = 0; sample < 500; sample++) {
      const y = 1 - (sample + 0.5) / 250;
      const width = Math.sqrt(1 - y * y), angle = sample * 2.399963;
      const direction = new THREE.Vector3(Math.cos(angle) * width, y, Math.sin(angle) * width);
      ray.set(direction.clone().multiplyScalar(4), direction.clone().negate());
      const hit = ray.intersectObject(mesh, false)[0];
      assert.ok(hit, `family ${family} has a missing or inverted surface at ray ${sample}`);
      const p = hit.point;
      const deviation = Math.abs(rockProfile(p.x, p.y, p.z, (family + 0.5) / 4));
      assert.ok(deviation < (family === 0 ? 0.027 : 0.00001),
        `family ${family}: rendered surface deviates from collision by ${deviation}`);
    }
    geometry.dispose(); material.dispose();
  }
});

test('rock detail budget preserves all distant gameplay cover and does no same-cell work', () => {
  const rocks: RBox[] = [];
  for (let i = 0; i < ROCK_NEAR_BUDGET + 60; i++) {
    rocks.push({ x: i % 20 * 7, y: 3, z: Math.floor(i / 20) * 9, hx: 1 + i * 0.01, hy: 2, hz: 2, r: 0.3 });
  }
  rocks.push({ x: 32 + 900, y: 3, z: 32, hx: 3, hy: 2, hz: 2, r: 0.3 });
  let queries = 0;
  const world = {
    collectBoulders: () => { queries++; return rocks; },
    column: () => ({ desert: 0 }),
  } as unknown as Pick<World, 'collectBoulders' | 'column'>;
  const renderer = new RockRenderer(world);
  assert.equal(renderer.update(Number.NaN, 0), false);
  renderer.update(0, 0);
  assert.equal(renderer.group.children.length, 8);
  assert.equal(renderer.count, rocks.length, 'the near cap must fall back to far geometry, never remove collision cover');
  let nearCount = 0;
  let farCount = 0;
  const seen = new Set<string>();
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  for (const child of renderer.group.children) {
    const mesh = child as THREE.InstancedMesh;
    assert.equal(mesh.castShadow, false);
    assert.ok(mesh.count <= mesh.instanceMatrix.count);
    if (mesh.name.includes('-near-')) nearCount += mesh.count;
    else farCount += mesh.count;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      position.setFromMatrixPosition(matrix); scale.setFromMatrixScale(matrix);
      const key = `${position.x},${position.z}`;
      assert.ok(!seen.has(key), 'one and only one LOD renders each rock');
      seen.add(key);
      const original = rocks.find((rock) => rock.x === position.x && rock.z === position.z)!;
      assert.equal(position.y, original.y);
      assert.ok(Math.abs(scale.x - original.hx) < 0.00001);
      assert.equal(scale.y, original.hy); assert.equal(scale.z, original.hz);
    }
  }
  assert.equal(nearCount, ROCK_NEAR_BUDGET);
  assert.equal(farCount, rocks.length - ROCK_NEAR_BUDGET);
  assert.ok(ROCK_RENDER_RADIUS - Math.SQRT2 * 32 > 840,
    'every weapon must finish its possible path before visible cover disappears');
  assert.equal(renderer.update(63, 63), false);
  assert.equal(queries, 1);
  renderer.update(64, 63);
  assert.equal(queries, 2);
  const geometries = renderer.group.children.map((child) => (child as THREE.Mesh).geometry);
  let disposed = 0;
  geometries.forEach((g) => g.addEventListener('dispose', () => disposed++));
  renderer.dispose(); renderer.dispose();
  assert.equal(disposed, 8);
  assert.equal(renderer.count, 0);
  assert.equal(renderer.update(0, 0), false);
});

test('far rocks wait for terrain while protected footprints and stationary arrivals keep exact heights', () => {
  const rocks: RBox[] = [
    { x: 190, y: 7.25, z: 32, hx: 4, hy: 3, hz: 4, r: .2 },
    { x: 202, y: 11.5, z: 32, hx: 11, hy: 4, hz: 3, r: .2 },
    { x: 350, y: 23.125, z: 32, hx: 5, hy: 6, hz: 7, r: .2 },
  ];
  let reads = 0, checks = 0, ready = false, pending = false;
  const terrain = { sceneryCoverageRevision: 0,
    sceneryGroundReady(x: number, z: number, hx: number, hz: number) {
      checks++; assert.deepEqual([x, z, hx, hz], [350, 32, 5, 7]); return ready;
    } };
  const scenery = { failed: false, read: () => { reads++; return pending ? null : rocks.map(rock => ({ rock, desert: false })); } } as unknown as ScenerySource;
  const world = { collectBoulders() { throw new Error('unexpected world query'); },
    column() { throw new Error('unexpected terrain sample'); } } as unknown as Pick<World, 'collectBoulders' | 'column'>;
  const renderer = new RockRenderer(world, scenery, terrain);
  const version = () => renderer.group.children.map(mesh => (mesh as THREE.InstancedMesh).instanceMatrix.version);
  try {
    assert.equal(renderer.update(0, 32), true);
    assert.equal(renderer.count, 2, 'the entire camera cell plus128 m and each rock footprint is protected');
    const before = version();
    assert.equal(renderer.update(63.9, 32), false, 'same-cell approach needs no rebuild to preserve near collision cover');
    assert.equal(checks, 1);
    terrain.sceneryCoverageRevision++;
    assert.equal(renderer.update(63.9, 32), false, 'an unrelated terrain completion does not upload unchanged instances');
    assert.deepEqual(version(), before);
    ready = true; terrain.sceneryCoverageRevision++;
    assert.equal(renderer.update(63.9, 32), true);
    assert.equal(renderer.count, 3, 'terrain completion releases the cached far rock without moving the camera');
    assert.equal(reads, 1, 'terrain revisions reuse scenery data without another query');
    const matrix = new THREE.Matrix4();
    for (const mesh of renderer.group.children as THREE.InstancedMesh[]) for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      const original = rocks.find(rock => rock.x === matrix.elements[12])!;
      assert.equal(matrix.elements[13], Math.fround(original.y));
    }
    ready = false; terrain.sceneryCoverageRevision++;
    assert.equal(renderer.update(63.9, 32), true);
    assert.equal(renderer.count, 2, 'terrain eviction defers only the far rock');
    pending = true;
    assert.equal(renderer.update(256, 32), true);
    assert.equal(renderer.count, 3, 'cached approaching colliders become visible even while the next worker footprint is pending');
    const settledChecks = checks;
    for (let i = 0; i < 100; i++) assert.equal(renderer.update(256, 32), false);
    assert.equal(checks, settledChecks, 'stationary frames do not repeat readiness work');
  } finally { renderer.dispose(); }
});
