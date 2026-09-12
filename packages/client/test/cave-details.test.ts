import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World, generateTeleporters, type CaveSite, type TraceHit } from '@shared/index';
import { CaveDetails, CAVE_DECORATION_BUDGET, CAVE_ANCHOR_CACHE_LIMIT } from '../src/render/cave-details.js';
import { caveColumn } from '../../shared/src/caves.js';

test('cave detail samples real supporting surfaces within fixed frame and GPU budgets', () => {
  const world = new World(1337);
  const site = world.collectCaveSites(0, 959, 0, 959)[0];
  assert.ok(site);
  let traces = 0, queries = 0;
  const details = new CaveDetails({
    sdf: world.sdf.bind(world),
    trace: (...args) => { traces++; return world.trace(...args); },
    collectCaveSites: (...args) => { queries++; return world.collectCaveSites(...args); },
  });
  for (let frame = 0; frame < 40; frame++) {
    const before = traces;
    details.update(site.x, site.z);
    assert.ok(traces - before <= 6, 'surface probes cannot spike on a single frame');
  }
  assert.equal(details.stats.pending, 0);
  assert.ok(details.stats.formations > 0, 'real cave ceiling should acquire formations');
  assert.ok(details.stats.fungi > 0, 'real supported alcove floors should acquire fungi');
  assert.equal(details.group.children.length, 4);
  let totalCapacity = 0;
  for (const child of details.group.children) {
    const mesh = child as THREE.InstancedMesh;
    totalCapacity += mesh.instanceMatrix.count;
    assert.ok(mesh.count <= mesh.instanceMatrix.count);
    assert.ok(mesh.boundingSphere && Number.isFinite(mesh.boundingSphere.radius));
    assert.ok(Array.from(mesh.instanceMatrix.array).every(Number.isFinite));
  }
  assert.equal(totalCapacity, CAVE_DECORATION_BUDGET);
  const before = {traces, queries};
  for (let frame = 0; frame < 120; frame++) details.update(site.x, site.z);
  assert.deepEqual({traces, queries}, before, 'steady frames do no cave sampling');
  details.dispose(); details.dispose();
  details.update(site.x + 1000, site.z);
  assert.equal(details.group.children.length, 0);
  assert.deepEqual({traces, queries}, before);
});

test('gallery waymarkers point uphill to the actual entrance inside the existing instance budget', () => {
  const site: CaveSite = { x: 0, y: 0, z: 0, dx: 1, dz: 0, length: 80, depth: 20,
    width: 10, mouthLength: 16, chamberRadius: 16, height: 14, bend: 0, seed: 1337 };
  const details = new CaveDetails({ seed: 1337, sdf: () => 3, collectCaveSites: () => [site], trace: sampleRoom });
  for (let frame = 0; frame < 20; frame++) details.update(30, 0);
  const markers = details.group.getObjectByName('cave-exit-waymarkers') as THREE.InstancedMesh;
  assert.equal(markers.count, 6, 'both gallery shoulders have regular exit cues');
  const matrix = new THREE.Matrix4(), direction = new THREE.Vector3();
  for (let i = 0; i < markers.count; i++) {
    markers.getMatrixAt(i, matrix);
    direction.set(0, 0, -1).transformDirection(matrix);
    assert.ok(direction.x < -0.99, 'arrows point along the ascending gallery toward daylight');
    assert.ok(Math.abs(matrix.elements[14]) > 3.5, 'central combat/walking lane stays clear');
  }
  assert.equal(details.group.children.reduce((sum, child) => sum + (child as THREE.InstancedMesh).instanceMatrix.count, 0), CAVE_DECORATION_BUDGET);
  details.dispose();
});

test('authored galleries below sea level retain their uphill exit waymarkers', () => {
  const site: CaveSite = { x: 0, y: -2, z: 0, dx: 1, dz: 0, length: 80, depth: 20,
    width: 10, mouthLength: 16, chamberRadius: 16, height: 14, bend: 0, seed: 1337 };
  const column = new World(1).column(0, 0);
  const details = new CaveDetails({ seed: 1337, sdf: () => 3, collectCaveSites: () => [site], trace: sampleRoom,
    column: (x, z) => ({ ...column, cave: caveColumn(site, x, z) }) });
  for (let frame = 0; frame < 120; frame++) details.update(60, 0, -17);
  const markers = details.group.getObjectByName('cave-exit-waymarkers') as THREE.InstancedMesh;
  assert.equal(markers.count, 6, 'a low altitude cannot remove the gallery exit cues');
  details.dispose();
});

test('two approaches share one set of chamber formations instead of overlapping duplicate roots', () => {
  const first: CaveSite = { x: 0, y: 0, z: 0, dx: 1, dz: 0, length: 80, depth: 20,
    width: 10, mouthLength: 16, chamberRadius: 16, height: 14, bend: 0, seed: 1337 };
  const second: CaveSite = { ...first, x: 80, z: 80, dx: 0, dz: -1 };
  const details = new CaveDetails({ seed: 1337, sdf: () => 3, collectCaveSites: () => [first, second], trace: sampleRoom });
  for (let frame = 0; frame < 40; frame++) details.update(50, 10);
  assert.equal(details.stats.cached, 22, 'six shoulder anchors per approach plus one shared ten-anchor chamber');
  assert.equal(details.stats.formations, 22, 'a shared ceiling root must render once');
  details.dispose();
});

test('teleporter-only deep chambers receive local formations independently of hillside sites', () => {
  const world = new World(1337);
  const pad = generateTeleporters(world).find(p => p.cave);
  assert.ok(pad);
  let traces = 0;
  const details = new CaveDetails({ seed: world.seed, sdf: world.sdf.bind(world),
    trace: (...args) => { traces++; return world.trace(...args); },
    collectCaveSites: () => { throw new Error('deep decoration must not depend on a hillside entrance'); },
  });
  for (let i = 0; i < 120; i++) {
    const before = traces;
    details.update(pad.x,pad.z,pad.y+1.8);
    assert.ok(traces-before <= 6);
  }
  assert.equal(details.stats.pending,0,'overlapping fixed vertical layers finish within the bounded probe window');
  assert.ok(details.stats.formations >= 12,'deep rooms should have visible hanging clusters');
  assert.ok(details.stats.fungi >= 12,'deep floor should receive colonies');
  const count = traces;
  for (let i = 0; i < 90; i++) details.update(pad.x,pad.z,pad.y+1.8);
  assert.equal(traces,count,'standing still cannot keep resampling cave surfaces');
  details.dispose();
});

test('cluster offsets stay attached to sloping floor and wall tangent planes', () => {
  const site: CaveSite = { x: 0, y: 0, z: 0, dx: 1, dz: 0, length: 80, depth: 20,
    width: 10, mouthLength: 16, chamberRadius: 16, height: 14, bend: 0, seed: 1337 };
  const floors: TraceHit[] = [], walls: TraceHit[] = [];
  const floorNormal = new THREE.Vector3(-0.4, 1, -0.3).normalize();
  const wallNormal = new THREE.Vector3(0.8, 0.3, 0.52).normalize();
  const details = new CaveDetails({
    sdf: () => 3,
    collectCaveSites: () => [site],
    trace: (x, y, z, dx, dy, dz) => {
      const n = dy < 0 ? floorNormal : wallNormal;
      const hit = { hit: dy <= 0, dist: 3, x: x + dx * 3, y: y + dy * 3, z: z + dz * 3,
        nx: n.x, ny: n.y, nz: n.z };
      if (dy < 0) floors.push(hit);
      if (dy === 0) walls.push(hit);
      return hit;
    },
  });
  details.update(0, 0);
  const matrix = new THREE.Matrix4(), position = new THREE.Vector3();
  const fungi = details.group.getObjectByName('cave-fungi') as THREE.InstancedMesh;
  const minerals = details.group.getObjectByName('cave-minerals') as THREE.InstancedMesh;
  assert.equal(fungi.count, floors.length * 3);
  assert.equal(minerals.count, walls.length * 4);
  for (let i = 0; i < fungi.count; i++) {
    fungi.getMatrixAt(i, matrix); position.setFromMatrixPosition(matrix);
    const floor = floors[Math.floor(i / 3)];
    const height = position.y - floor.y +
      (floor.nx * (position.x - floor.x) + floor.nz * (position.z - floor.z)) / floor.ny;
    assert.ok(Math.abs(height + 0.03) < 0.00001, 'each stalk must retain its small floor embed');
  }
  for (let i = 0; i < minerals.count; i++) {
    minerals.getMatrixAt(i, matrix); position.setFromMatrixPosition(matrix);
    const wall = walls[Math.floor(i / 4)];
    const depth = wall.nx * (position.x - wall.x) + wall.ny * (position.y - wall.y) +
      wall.nz * (position.z - wall.z);
    assert.ok(Math.abs(depth + 0.10) < 0.00001, 'each mineral root must remain behind the wall');
  }
  details.dispose();
});

function visibleTransforms(details: CaveDetails, x?: number, z?: number, radius = Infinity): Set<string> {
  const result = new Set<string>();
  const matrix = new THREE.Matrix4();
  for (const child of details.group.children) {
    const mesh = child as THREE.InstancedMesh;
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      if (x !== undefined && z !== undefined && Math.hypot(matrix.elements[12] - x, matrix.elements[14] - z) > radius) continue;
      result.add(`${mesh.name}:${matrix.elements.join(',')}`);
    }
  }
  return result;
}

function sampleRoom(x: number, y: number, z: number, dx: number, dy: number, dz: number, _range?: number): TraceHit {
  const dist = dy > 0 ? 12 : dy < 0 ? 3 : 6;
  return { hit: true, dist, x: x + dx * dist, y: y + dy * dist, z: z + dz * dist,
    nx: dy === 0 ? -dx : 0, ny: -dy, nz: dy === 0 ? -dz : 0 };
}

test('walking across horizontal, vertical, and mode boundaries retains nearby decoration transforms', () => {
  let traces = 0;
  const details = new CaveDetails({ seed: 1337, sdf: () => 3, collectCaveSites: () => [],
    trace: (...args) => { traces++; return sampleRoom(...args); } });
  for (let i = 0; i < 120; i++) details.update(31.8, 31.8, -17.2);
  const nearby = visibleTransforms(details, 31.8, 31.8, 40);
  assert.ok(nearby.size > 30, 'the initial neighborhood has substantial visible detail');
  const positions = [[32.2, 32.2, -15.8], [63.8, 31.8, -9.1], [64.2, 32.2, -8.9],
    [63.8, 31.8, -12.1], [32.2, 32.2, -11.9], [31.8, 31.8, -3.9],
    [31.8, 31.8, -12.1], [31.8, 31.8, -17.2]];
  for (const [x, z, y] of positions) {
    const before = traces;
    details.update(x, z, y);
    assert.ok(traces - before <= 6, 'moving over a boundary retains the per-frame probe budget');
    const current = visibleTransforms(details);
    for (const transform of nearby) assert.ok(current.has(transform),
      'nearby formations keep the same world-space transform across a cell/layer/mode boundary');
  }
  // Finish the small newly exposed fringe, then revisit both sides. Cached
  // geometry must reappear immediately without a new round of surface rays.
  for (let i = 0; i < 200; i++) details.update(31.8, 31.8, -17.2);
  const before = traces;
  details.update(64.2, 32.2, -8.9);
  details.update(31.8, 31.8, -17.2);
  assert.equal(traces, before, 'backtracking through overlapping sampled cells does not regenerate formations');
  details.dispose();
});

test('changing the nearest hillside site retains formations in the overlapping cave', () => {
  const first: CaveSite = { x: 0, y: 0, z: 0, dx: 1, dz: 0, length: 80, depth: 20,
    width: 10, mouthLength: 16, chamberRadius: 16, height: 14, bend: 0, seed: 1337 };
  const second = { ...first, x: 120, seed: 42 };
  const details = new CaveDetails({ sdf: () => 3, trace: sampleRoom,
    collectCaveSites: minX => minX < -138 ? [first] : [second] });
  for (let i = 0; i < 20; i++) details.update(31.8, 0);
  const before = visibleTransforms(details);
  assert.ok(before.size > 20, 'first cave contains visible supporting-surface detail');
  details.update(32.2, 0);
  const after = visibleTransforms(details);
  for (const transform of before) assert.ok(after.has(transform),
    'a nearest-site list change cannot erase a cave that is still nearby');
  details.dispose();
});

test('extended cave travel keeps sampled-anchor memory and frame work bounded', () => {
  let traces = 0;
  const details = new CaveDetails({ seed: 42, sdf: () => 3, collectCaveSites: () => [],
    trace: (...args) => { traces++; return sampleRoom(...args); } });
  for (let step = 0; step < 160; step++) {
    for (let frame = 0; frame < 4; frame++) {
      const before = traces;
      details.update(step * 32, (step % 5) * 16, -17 - (step % 3) * 16);
      assert.ok(traces - before <= 6, 'long traversal cannot accumulate a burst of deferred traces');
      assert.ok(details.stats.cached <= CAVE_ANCHOR_CACHE_LIMIT, 'sampled anchors must evict outside the bounded cache');
      assert.ok(details.stats.pending <= 384, 'pending work is bounded by the active neighborhood');
      assert.ok(details.stats.formations + details.stats.minerals + details.stats.fungi <= CAVE_DECORATION_BUDGET,
        'retaining overlapping anchors must not increase GPU instance capacity');
    }
  }
  details.dispose();
});
