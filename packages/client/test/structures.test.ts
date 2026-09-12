import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { disjointStructureBoxes } from '@shared/structures';
import {
  WEAPONS,
  type Box,
  World,
} from '@shared/index';
import {
  MAX_STRUCTURE_VISUALS,
  STRUCTURE_RENDER_CELL_SIZE,
  STRUCTURE_RENDER_RADIUS_CELLS,
  STRUCTURE_DETAIL_BUDGET,
  STRUCTURE_TRIMS_PER_DETAIL,
  STRUCTURE_CACHE_CELLS,
  StructureRenderer,
} from '../src/render/structures.js';

interface Query {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

class StubWorld {
  readonly calls: Query[] = [];

  constructor(
    readonly solids: Box[],
    readonly pads: Box[] = [],
    readonly foundations: Box[] = [],
  ) {}

  collectStructures(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ) {
    this.calls.push({ minX, maxX, minZ, maxZ });
    // Deliberately return every box. The renderer is the final bounded client
    // trust boundary and must reject values outside its active rectangle.
    return {
      sites: [],
      pads: this.pads,
      solids: this.solids,
      cuts: [],
      foundations: this.foundations,
    };
  }
}

function box(
  x: number,
  y: number,
  z: number,
  hx = 0.5,
  hy = 1,
  hz = 1.5,
): Box {
  return { x, y, z, hx, hy, hz };
}

function source(world: StubWorld): Pick<World, 'collectStructures'> {
  return world as unknown as Pick<World, 'collectStructures'>;
}

function pool(renderer: StructureRenderer): THREE.InstancedMesh {
  const mesh = renderer.group.getObjectByName('structure-solids');
  assert.ok(mesh instanceof THREE.InstancedMesh, 'missing structure pool');
  return mesh;
}

test('default structure coverage exceeds every authoritative weapon range', () => {
  const maxRange = Math.max(...WEAPONS.map((weapon) => weapon.range));
  const leastCoveredDistance =
    STRUCTURE_RENDER_CELL_SIZE * STRUCTURE_RENDER_RADIUS_CELLS;
  assert.ok(
    leastCoveredDistance > maxRange,
    `structure edge is inside maximum weapon range ${maxRange}m`,
  );
  assert.ok(
    MAX_STRUCTURE_VISUALS >= 8 * 8 * 30,
    'pool must cover the generator maximum for the default query footprint',
  );
});

test('structures rebuild only across bounded spatial cells', () => {
  const world = new StubWorld([box(0, 3, 0)]);
  const renderer = new StructureRenderer(source(world), {
    cellSize: 128,
    radiusCells: 1,
    maxInstances: 8,
  });

  assert.equal(renderer.update(Number.NaN, 0), false);
  assert.equal(world.calls.length, 0);
  assert.equal(renderer.update(0, 0), true);
  assert.ok(world.calls.length > 0 && world.calls.length <= 9,
    'the bounded footprint is fetched through a small number of generation cells');
  assert.ok(world.calls.every(q => q.minX === q.maxX && q.minZ === q.maxZ),
    'cold generation probes one structure cell at a time');
  assert.deepEqual(renderer.bounds, {
    minX: -128,
    maxX: 256,
    minZ: -128,
    maxZ: 256,
  });

  assert.equal(renderer.update(127.999, 12), false);
  for (let i = 0; i < 64; i++) {
    const before = world.calls.length;
    assert.equal(renderer.update(127.999, 12), false);
    assert.ok(world.calls.length - before <= 1, 'idle calls warm at most one frontier cell');
  }
  const before = world.calls.length;
  assert.equal(renderer.update(127.999, 12), false);
  assert.equal(world.calls.length, before, 'steady frames do no work after the bounded frontier is warm');

  assert.equal(renderer.update(128, 12), true);
  assert.equal(world.calls.length, before, 'overlapping cached cells cover the next renderer boundary');
  assert.equal(new Set(world.calls.map(q => `${q.minX},${q.minZ}`)).size, world.calls.length,
    'overlapping districts are never regenerated while cached');
  assert.equal(renderer.group.children.length, 3, 'pool count must stay fixed');
  renderer.dispose();
});

test('structure boxes have exact transforms, a hard ceiling, and dispose once', () => {
  const nearest = box(2, 3, 1, 0.55, 1.7, 6.25);
  const second = box(4, 8, 1, 2.5, 0.56, 9.45);
  const third = box(12, 4, 1, 1, 2, 3);
  const pad = box(1, -2, 1, 9, 2, 9);
  const world = new StubWorld([
    third,
    { ...box(5, 2, 2), hx: 0 },
    second,
    box(30, 2, 1),
    { ...box(6, 2, 2), y: Number.NaN },
    nearest,
  ], [pad]);
  const renderer = new StructureRenderer(source(world), {
    cellSize: 16,
    radiusCells: 0,
    maxInstances: 2,
  });

  assert.equal(renderer.update(0, 0), true);
  assert.deepEqual(renderer.stats, {
    count: 2,
    rejected: 3,
    truncated: 1,
  });
  assert.equal(renderer.count, 2);
  assert.equal(renderer.group.children.length, 3);

  const mesh = pool(renderer);
  assert.equal(mesh.count, 2);
  assert.equal(mesh.instanceMatrix.count, 2, 'GPU allocation must stay capped');
  assert.ok(mesh.geometry instanceof THREE.BoxGeometry);
  mesh.geometry.computeBoundingBox();
  assert.ok(mesh.geometry.boundingBox);
  assert.ok(
    mesh.geometry.boundingBox.min.distanceTo(new THREE.Vector3(-1, -1, -1)) <
      1e-9,
  );
  assert.ok(
    mesh.geometry.boundingBox.max.distanceTo(new THREE.Vector3(1, 1, 1)) <
      1e-9,
  );

  // Input order is intentionally scrambled. The nearest authoritative box is
  // retained first and a 2x2x2 primitive scaled by half extents matches sdBox.
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  mesh.getMatrixAt(0, matrix);
  matrix.decompose(position, rotation, scale);
  assert.ok(position.distanceTo(new THREE.Vector3(2, 3, 1)) < 1e-9);
  assert.ok(scale.distanceTo(new THREE.Vector3(0.55, 1.7, 6.25)) < 1e-6);
  mesh.getMatrixAt(1, matrix);
  matrix.decompose(position, rotation, scale);
  assert.ok(position.distanceTo(new THREE.Vector3(4, 8, 1)) < 1e-9);
  assert.ok(scale.distanceTo(new THREE.Vector3(2.5, 0.56, 9.45)) < 1e-6);

  assert.ok(mesh.material instanceof THREE.MeshStandardMaterial, 'structural surfaces use roughness-aware lighting');
  assert.ok(mesh.instanceColor, 'the concrete palette is shared per site');
  let geometryDisposals = 0;
  let materialDisposals = 0;
  mesh.geometry.addEventListener('dispose', () => geometryDisposals++);
  mesh.material.addEventListener('dispose', () => materialDisposals++);

  renderer.dispose();
  assert.equal(renderer.group.children.length, 0);
  assert.equal(mesh.count, 0);
  assert.equal(renderer.count, 0);
  assert.equal(renderer.bounds, null);
  assert.equal(geometryDisposals, 1);
  assert.equal(materialDisposals, 1);
  assert.equal(renderer.update(32, 32), false);

  renderer.dispose();
  assert.equal(geometryDisposals, 1, 'dispose must be idempotent');
  assert.equal(materialDisposals, 1, 'dispose must be idempotent');
});

test('architectural fittings stay capped, nearby, and inside each wall opening boundary', () => {
  const wall = box(4, 2, 4, 3, 2, 0.6);
  const solids = [wall];
  for (let i = 0; i < 500; i++) {
    solids.push(box(8 + i % 20 * 3, 2, 8 + Math.floor(i / 20) * 3, 0.6, 2, 2));
  }
  solids.push(box(450, 2, 450, 3, 2, 0.6));
  const renderer = new StructureRenderer(source(new StubWorld(solids)), {
    cellSize: 512, radiusCells: 0, maxInstances: 1024,
  });
  renderer.update(0, 0);
  const trim = renderer.group.getObjectByName('structure-metal-trim') as THREE.InstancedMesh;
  const lights = renderer.group.getObjectByName('structure-marker-lights') as THREE.InstancedMesh;
  assert.ok(trim.count <= STRUCTURE_DETAIL_BUDGET * STRUCTURE_TRIMS_PER_DETAIL);
  assert.ok(trim.count >= STRUCTURE_DETAIL_BUDGET * 2, 'detail caps should still populate nearby buildings');
  assert.equal(lights.count, STRUCTURE_DETAIL_BUDGET * 2);
  assert.equal(trim.instanceMatrix.count, STRUCTURE_DETAIL_BUDGET * STRUCTURE_TRIMS_PER_DETAIL);
  assert.equal(lights.instanceMatrix.count, STRUCTURE_DETAIL_BUDGET * 2);
  assert.equal(renderer.count, solids.length, 'detail caps never remove real cover');
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  for (let i = 0; i < 4; i++) {
    trim.getMatrixAt(i, matrix);
    matrix.decompose(position, rotation, scale);
    assert.ok(position.x - scale.x >= wall.x - wall.hx - 1e-6);
    assert.ok(position.x + scale.x <= wall.x + wall.hx + 1e-6,
      'trim must never extend into a neighboring door opening');
  }
  let poolDisposals = 0;
  for (const mesh of renderer.group.children) {
    mesh.addEventListener('dispose' as never, () => poolDisposals++);
  }
  renderer.dispose();
  renderer.dispose();
  assert.equal(poolDisposals, 3, 'instance GPU buffers dispose once');
});

test('overlapping wall and roof boxes have one visible owner and preserve occupied cover', () => {
  const original = [box(0, 2, 0, 4, 2, 0.5), box(2, 2, 0, 4, 2, 0.5),
    box(0, 4, 0, 4, 0.4, 3), box(0, 2, 0, 4, 2, 0.5)];
  const owned = disjointStructureBoxes(original);
  const contains = (b: Box, x: number, y: number, z: number): boolean =>
    Math.abs(x - b.x) < b.hx && Math.abs(y - b.y) < b.hy && Math.abs(z - b.z) < b.hz;
  for (let x = -4.9; x < 7; x += 0.37) for (let y = -0.1; y < 5; y += 0.29) {
    for (const z of [-2.7, -0.31, 0.13, 0.49, 1.9]) {
      const matches = owned.filter((b) => contains(b, x, y, z)).length;
      assert.equal(matches, original.some((b) => contains(b, x, y, z)) ? 1 : 0,
        'render pieces must own exactly the same occupied volume as collision');
    }
    // These camera rays approach the same wall plane through its overlapping
    // originals. There must be one front-facing patch at z=0.5, not several.
    const fronts = owned.filter((b) => Math.abs(b.z + b.hz - 0.5) < 1e-7 &&
      Math.abs(x - b.x) < b.hx && Math.abs(y - b.y) < b.hy);
    assert.ok(fronts.length <= 1, 'a depth pixel has duplicate coplanar wall owners');
  }
  for (let i = 0; i < owned.length; i++) for (let j = i + 1; j < owned.length; j++) {
    const a = owned[i], b = owned[j];
    const overlap = Math.min(a.x + a.hx, b.x + b.hx) - Math.max(a.x - a.hx, b.x - b.hx);
    const vertical = Math.min(a.y + a.hy, b.y + b.hy) - Math.max(a.y - a.hy, b.y - b.hy);
    const depth = Math.min(a.z + a.hz, b.z + b.hz) - Math.max(a.z - a.hz, b.z - b.hz);
    assert.ok(Math.min(overlap, vertical, depth) <= 1e-7, 'render union overlaps itself');
  }
});

test('chunk-owned plinths are omitted from close structure instances', () => {
  const floor = box(4, -1, 4, 8, 1, 8), wall = box(4, 2, 4, 3, 2, 0.5);
  const renderer = new StructureRenderer(source(new StubWorld([floor, wall], [], [{ ...floor }])),
    { cellSize: 32, radiusCells: 0, maxInstances: 8 });
  renderer.update(0, 0);
  assert.equal(renderer.count, 1, 'chunk-owned floor must not have a second close-range owner');
  const matrix = new THREE.Matrix4(); pool(renderer).getMatrixAt(0, matrix);
  assert.equal(matrix.elements[13], wall.y);
  renderer.dispose();
});

test('visible trim end caps never share coplanar patches with hangar walls or other trim', () => {
  const renderer = new StructureRenderer(new World(1337), { cellSize: 128, radiusCells: 0, maxInstances: 128 });
  renderer.update(191.18930950164795, -57.72590675354003);
  const boxes: { name: string; c: number[]; h: number[] }[] = [];
  const matrix = new THREE.Matrix4();
  for (const child of renderer.group.children) {
    const pool = child as THREE.InstancedMesh;
    for (let i = 0; i < pool.count; i++) {
      pool.getMatrixAt(i, matrix);
      const e = matrix.elements;
      boxes.push({ name: pool.name, c: [e[12], e[13], e[14]], h: [e[0], e[5], e[10]] });
    }
  }
  assert.ok(boxes.filter((b) => b.name === 'structure-metal-trim').length > 20,
    'the camera fixture must contain real fitted hangar corners');
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (a.name === 'structure-solids' && b.name === 'structure-solids') continue;
    for (let axis = 0; axis < 3; axis++) for (const sign of [-1, 1]) {
      if (Math.abs(a.c[axis] + sign * a.h[axis] - b.c[axis] - sign * b.h[axis]) > 2e-5) continue;
      const u = (axis + 1) % 3, v = (axis + 2) % 3;
      const overlapU = Math.min(a.c[u] + a.h[u], b.c[u] + b.h[u]) - Math.max(a.c[u] - a.h[u], b.c[u] - b.h[u]);
      const overlapV = Math.min(a.c[v] + a.h[v], b.c[v] + b.h[v]) - Math.max(a.c[v] - a.h[v], b.c[v] - b.h[v]);
      assert.ok(overlapU < 2e-5 || overlapV < 2e-5,
        `${a.name}/${b.name} share a visible coplanar patch on axis ${axis}, normal ${sign}`);
    }
  }
  renderer.dispose();
});

test('cached cells retain exactly one owner of canonical cover while crossing and backtracking', () => {
  const world = new World(1337);
  const renderer = new StructureRenderer(world, { radiusCells: 1 });
  const read = (): Box[] => {
    const mesh = pool(renderer), matrix = new THREE.Matrix4(), boxes: Box[] = [];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix); const e = matrix.elements;
      boxes.push(box(e[12], e[13], e[14], e[0], e[5], e[10]));
    }
    return boxes;
  };
  const key = (b: Box): string => [b.x, b.y, b.z, b.hx, b.hy, b.hz].join(',');
  const contains = (b: Box, x: number, y: number, z: number): boolean =>
    Math.abs(b.x - x) < b.hx + 1e-5 && Math.abs(b.y - y) < b.hy + 1e-5 && Math.abs(b.z - z) < b.hz + 1e-5;
  let witnesses = 0;
  let initial: string[] = [];
  for (const x of [0, 128, 256, 384, 256, 128, 0]) {
    renderer.update(x, 0);
    const bounds = renderer.bounds!;
    const region = world.collectStructures(bounds.minX, bounds.maxX, bounds.minZ, bounds.maxZ);
    const floors = new Set((region.foundations ?? []).map(key));
    const original = region.solids.filter(b => !floors.has(key(b)));
    const rendered = read();
    for (const b of original) {
      const minX = Math.max(b.x - b.hx, bounds.minX), maxX = Math.min(b.x + b.hx, bounds.maxX);
      const minZ = Math.max(b.z - b.hz, bounds.minZ), maxZ = Math.min(b.z + b.hz, bounds.maxZ);
      if (maxX - minX < 0.01 || maxZ - minZ < 0.01) continue;
      const px = minX + (maxX - minX) * 0.37, py = b.y + b.hy * 0.13, pz = minZ + (maxZ - minZ) * 0.61;
      assert.equal(rendered.filter(piece => contains(piece, px, py, pz)).length, 1,
        'every sampled collidable wall/roof point retains exactly one visible owner');
      witnesses++;
    }
    for (const b of rendered) assert.ok(original.some(source => contains(source, b.x, b.y, b.z)),
      'cached render pieces cannot invent occupied cover outside the canonical primitives');
    const snapshot = rendered.map(key).sort();
    if (initial.length === 0) initial = snapshot;
    else if (x === 0) assert.deepEqual(snapshot, initial,
      'backtracking restores identical geometry independent of cached cell query history');
  }
  assert.ok(witnesses > 100, 'cover ownership audit must exercise real varied structures');
  renderer.dispose();
});

test('structure cell and ownership caches stay bounded during extended traversal', () => {
  const renderer = new StructureRenderer({ collectStructures: (x, _maxX, z) => {
    const wall = box(x + 8, 3, z + 8, 4, 3, 0.5);
    return { sites: [], pads: [], foundations: [], cuts: [], solids: [wall] };
  } }, { radiusCells: 0, maxInstances: 16 });
  for (let i = 0; i < 340; i++) {
    renderer.update(i * 256, (i % 7) * 256);
    const stats = renderer.cacheStats;
    assert.ok(stats.cells <= STRUCTURE_CACHE_CELLS && stats.solids <= STRUCTURE_CACHE_CELLS &&
      stats.trims <= STRUCTURE_CACHE_CELLS, 'all reusable geometry caches need a fixed traversal-independent ceiling');
  }
  renderer.dispose();
  assert.deepEqual(renderer.cacheStats, { cells: 0, solids: 0, trims: 0, pending: 0 },
    'dispose releases cached CPU geometry as well as instance pools');
});

test('oversized custom footprints do not prefetch cells that immediately evict active data', () => {
  let queries = 0;
  const renderer = new StructureRenderer({ collectStructures: () => {
    queries++;
    return { sites: [], pads: [], foundations: [], cuts: [], solids: [] };
  } }, { cellSize: 512, radiusCells: 12 });
  renderer.update(0, 0);
  const before = queries;
  assert.ok(before > STRUCTURE_CACHE_CELLS, 'fixture exercises a custom footprint larger than the source cache');
  for (let i = 0; i < 250; i++) renderer.update(0, 0);
  assert.equal(queries, before, 'oversized stationary views must not generate a useless speculative frontier');
  assert.equal(renderer.cacheStats.pending, 0, 'frontier prefetch is disabled when its working set cannot fit');
  assert.ok(renderer.cacheStats.cells <= STRUCTURE_CACHE_CELLS, 'custom options retain the fixed memory ceiling');
  renderer.dispose();
});
