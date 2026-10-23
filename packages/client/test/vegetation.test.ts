import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import type { ScenerySource } from '../src/render/scenery-stream.js';
import {
  WEAPONS,
  VEGETATION_KIND,
  type VegetationPlacement,
  type World,
} from '@shared/index';
import {
  VEGETATION_RENDER_CELL_SIZE,
  VEGETATION_RENDER_RADIUS_CELLS,
  VegetationRenderer,
} from '../src/render/vegetation.js';

interface Query {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

class StubWorld {
  readonly calls: Query[] = [];

  constructor(readonly placements: VegetationPlacement[]) {}

  collectVegetation(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
  ): VegetationPlacement[] {
    this.calls.push({ minX, maxX, minZ, maxZ });
    // Deliberately return everything. The renderer must still enforce its
    // active bounds and visual ceiling at this client trust boundary.
    return this.placements;
  }
}

function placement(
  kind: VegetationPlacement['kind'],
  x: number,
  z: number,
  {
    y = 2,
    radius = 0.45,
    height = 6,
    canopyRadius = 1.8,
    yaw = 0,
  }: Partial<VegetationPlacement> = {},
): VegetationPlacement {
  return { x, y, z, radius, height, canopyRadius, kind, yaw };
}

function source(world: StubWorld): Pick<World, 'collectVegetation'> {
  return world as unknown as Pick<World, 'collectVegetation'>;
}

function instance(
  renderer: VegetationRenderer,
  name: string,
): THREE.InstancedMesh {
  const mesh = renderer.group.getObjectByName(name);
  assert.ok(mesh instanceof THREE.InstancedMesh, `missing pool ${name}`);
  return mesh;
}

test('far vegetation waits for full terrain footprints and refreshes stationary cached placements', () => {
  const plants = [
    placement(VEGETATION_KIND.CONIFER, 200, 32, { y: 7.25, height: 8, canopyRadius: 9 }),
    placement(VEGETATION_KIND.CONIFER, 350, 32, { y: 23.125, height: 8, canopyRadius: 5 }),
  ];
  const world = new StubWorld(plants);
  let reads = 0, checks = 0, ready = false, pending = false;
  const scenery = { failed: false, read: () => { reads++; return pending ? null : plants; } } as unknown as ScenerySource;
  const terrain = { sceneryCoverageRevision: 0,
    sceneryGroundReady(x: number, z: number, hx: number, hz: number) {
      checks++; assert.deepEqual([x, z, hx, hz], [350, 32, 5, 5]); return ready;
    } };
  const renderer = new VegetationRenderer(source(world), { nearDistance: 0 }, scenery, terrain);
  try {
    assert.equal(renderer.update(0, 32), true);
    assert.equal(renderer.count, 1, 'canopy footprint conservatively protects a nearby tree beyond128 m center distance');
    const stems = instance(renderer, 'vegetation-far-stems'), version = stems.instanceMatrix.version;
    assert.equal(renderer.update(63.9, 32), false);
    assert.equal(checks, 1);
    terrain.sceneryCoverageRevision++;
    assert.equal(renderer.update(63.9, 32), false);
    assert.equal(stems.instanceMatrix.version, version);
    ready = true; terrain.sceneryCoverageRevision++;
    assert.equal(renderer.update(63.9, 32), true);
    assert.equal(renderer.count, 2);
    assert.equal(reads, 1); assert.equal(world.calls.length, 0);
    const matrix = new THREE.Matrix4();
    for (let i = 0; i < stems.count; i++) {
      stems.getMatrixAt(i, matrix);
      const plant = plants.find(plant => plant.x === matrix.elements[12])!;
      assert.equal(matrix.elements[13] - matrix.elements[5] * .5, plant.y, 'the stem retains its canonical bottom Y');
    }
    ready = false; terrain.sceneryCoverageRevision++;
    assert.equal(renderer.update(63.9, 32), true); assert.equal(renderer.count, 1);
    pending = true;
    assert.equal(renderer.update(256, 32), true); assert.equal(renderer.count, 2, 'cached colliders remain protected during a delayed replacement');
    const settledChecks = checks;
    for (let i = 0; i < 100; i++) assert.equal(renderer.update(256, 32), false);
    assert.equal(checks, settledChecks);
  } finally { renderer.dispose(); }
});

test('default vegetation coverage exceeds every authoritative weapon range', () => {
  const maxRange = Math.max(...WEAPONS.map((weapon) => weapon.range));
  assert.ok(
    VEGETATION_RENDER_CELL_SIZE * VEGETATION_RENDER_RADIUS_CELLS > maxRange,
    `vegetation edge is inside maximum weapon range ${maxRange}m`,
  );
});

test('vegetation rebuilds only across bounded spatial cells', () => {
  const broadleaf = placement(VEGETATION_KIND.BROADLEAF, 0, 0, {
    y: 2,
    radius: 0.5,
    height: 6,
    canopyRadius: 2,
  });
  const conifer = placement(VEGETATION_KIND.CONIFER, 3, 0, {
    radius: 0.38,
    height: 8,
    canopyRadius: 1.7,
    yaw: 0.7,
  });
  const cactus = placement(VEGETATION_KIND.CACTUS, 5, 0, {
    radius: 0.42,
    height: 4.5,
    canopyRadius: 1.2,
    yaw: 1.1,
  });
  const world = new StubWorld([
    placement(VEGETATION_KIND.BROADLEAF, 20, 20),
    cactus,
    conifer,
    broadleaf,
    placement(VEGETATION_KIND.BROADLEAF, 64, 0),
    { ...placement(VEGETATION_KIND.CONIFER, 2, 2), y: Number.NaN },
    {
      ...placement(VEGETATION_KIND.BROADLEAF, 1, 1),
      kind: 255 as VegetationPlacement['kind'],
    },
  ]);
  const renderer = new VegetationRenderer(source(world), {
    cellSize: 32,
    radiusCells: 1,
    maxInstances: 3,
  });

  assert.equal(renderer.update(0, 0), true);
  assert.deepEqual(world.calls, [{
    minX: -32, maxX: 64, minZ: -32, maxZ: 64,
  }]);
  assert.deepEqual(renderer.bounds, {
    minX: -32, maxX: 64, minZ: -32, maxZ: 64,
  });
  assert.deepEqual(renderer.stats, {
    count: 3,
    broadleaf: 1,
    conifer: 1,
    cactus: 1,
  });
  assert.equal(renderer.count, 3);
  assert.equal(renderer.group.children.length, 12, 'pool count must stay fixed');
  assert.equal(instance(renderer, 'vegetation-woody-stems').count, 2);
  assert.equal(instance(renderer, 'vegetation-broadleaf-canopies').count, 1);
  assert.equal(instance(renderer, 'vegetation-conifer-canopies').count, 1);
  assert.equal(instance(renderer, 'vegetation-cactus-stems').count, 1);
  // Cosmetic satellites are deterministic per placement but bounded per plant.
  assert.ok(instance(renderer, 'vegetation-broadleaf-lobes').count <= 4);
  assert.ok(instance(renderer, 'vegetation-broadleaf-branches').count <= 2);
  assert.ok(instance(renderer, 'vegetation-conifer-tiers').count <= 3);
  const arms = instance(renderer, 'vegetation-cactus-arms').count;
  assert.ok(arms <= 3, `one cactus may grow at most three arms (${arms})`);
  assert.equal(instance(renderer, 'vegetation-cactus-tips').count, arms,
    'every rendered arm must carry exactly one vertical tip');
  // Everything here is inside the near ring; the far pools stay empty.
  assert.equal(instance(renderer, 'vegetation-far-stems').count, 0);
  assert.equal(instance(renderer, 'vegetation-far-broadleaf').count, 0);
  assert.equal(instance(renderer, 'vegetation-far-conifers').count, 0);

  // The first woody instance is the nearest broadleaf. Its unit cylinder is
  // transformed to precisely the shared collider's radius, height, and base.
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  instance(renderer, 'vegetation-woody-stems').getMatrixAt(0, matrix);
  matrix.decompose(position, rotation, scale);
  assert.ok(position.distanceTo(new THREE.Vector3(0, 5, 0)) < 1e-9);
  assert.ok(scale.distanceTo(new THREE.Vector3(0.5, 6, 0.5)) < 1e-9);

  assert.equal(renderer.update(31.999, 4), false);
  assert.equal(world.calls.length, 1, 'same-cell updates must not regenerate');

  assert.equal(renderer.update(32, 4), true);
  assert.deepEqual(world.calls[1], {
    minX: 0, maxX: 96, minZ: -32, maxZ: 64,
  });
  assert.equal(renderer.group.children.length, 12);
  renderer.dispose();
});

test('vegetation beyond the near ring renders through the far-LOD pools', () => {
  const world = new StubWorld([
    placement(VEGETATION_KIND.BROADLEAF, 4, 0),
    placement(VEGETATION_KIND.CONIFER, 8, 0),
    placement(VEGETATION_KIND.CACTUS, 12, 0),
    placement(VEGETATION_KIND.BROADLEAF, 200, 0),
    placement(VEGETATION_KIND.CONIFER, 210, 0),
    placement(VEGETATION_KIND.CACTUS, 220, 0),
  ]);
  const renderer = new VegetationRenderer(source(world), {
    cellSize: 256, radiusCells: 1, maxInstances: 16, nearDistance: 64,
  });
  renderer.update(0, 0);

  // Near plants keep their detailed parts; far plants collapse to one stem
  // plus at most one crown impostor, and species stats count both rings.
  assert.equal(instance(renderer, 'vegetation-woody-stems').count, 2);
  assert.equal(instance(renderer, 'vegetation-broadleaf-canopies').count, 1);
  assert.equal(instance(renderer, 'vegetation-conifer-canopies').count, 1);
  assert.equal(instance(renderer, 'vegetation-cactus-stems').count, 1);
  assert.equal(instance(renderer, 'vegetation-far-stems').count, 3);
  assert.equal(instance(renderer, 'vegetation-far-broadleaf').count, 1);
  assert.equal(instance(renderer, 'vegetation-far-conifers').count, 1);
  assert.deepEqual(renderer.stats, {
    count: 6, broadleaf: 2, conifer: 2, cactus: 2,
  });

  // The far stem must still match the authoritative collider exactly:
  // weapons out-range the near ring, so cover cannot lie at any distance.
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const rotation = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  instance(renderer, 'vegetation-far-stems').getMatrixAt(0, matrix);
  matrix.decompose(position, rotation, scale);
  // instanceMatrix stores Float32; 0.45 is not exactly representable.
  assert.ok(position.distanceTo(new THREE.Vector3(200, 5, 0)) < 1e-6);
  assert.ok(scale.distanceTo(new THREE.Vector3(0.45, 6, 0.45)) < 1e-6);
  renderer.dispose();
});

test('the near-detail budget spills the farthest plants into far pools', () => {
  const placements: VegetationPlacement[] = [];
  for (let i = 0; i < 8; i++) {
    placements.push(placement(VEGETATION_KIND.BROADLEAF, 2 + i * 6, 0));
  }
  const renderer = new VegetationRenderer(
    source(new StubWorld(placements)),
    {
      cellSize: 128, radiusCells: 0, maxInstances: 16,
      nearDistance: 1000, nearBudget: 3,
    },
  );
  renderer.update(0, 0);
  assert.equal(instance(renderer, 'vegetation-woody-stems').count, 3);
  assert.equal(instance(renderer, 'vegetation-broadleaf-canopies').count, 3);
  assert.equal(instance(renderer, 'vegetation-far-stems').count, 5);
  assert.equal(instance(renderer, 'vegetation-far-broadleaf').count, 5);
  // Distance sorting guarantees the detailed budget goes to the nearest.
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  instance(renderer, 'vegetation-woody-stems').getMatrixAt(0, matrix);
  position.setFromMatrixPosition(matrix);
  assert.equal(position.x, 2);
  renderer.dispose();
});

test('vegetation filters malformed and out-of-bounds placements', () => {
  const world = new StubWorld([
    placement(VEGETATION_KIND.BROADLEAF, -16, -16),
    placement(VEGETATION_KIND.CONIFER, 15.999, 15.999),
    placement(VEGETATION_KIND.CACTUS, 16, 0),
    placement(VEGETATION_KIND.BROADLEAF, 0, 16),
    placement(VEGETATION_KIND.CONIFER, -16.001, 0),
    { ...placement(VEGETATION_KIND.CACTUS, 0, 0), radius: -1 },
    { ...placement(VEGETATION_KIND.BROADLEAF, 0, 0), canopyRadius: 0 },
  ]);
  const renderer = new VegetationRenderer(source(world), {
    cellSize: 16,
    radiusCells: 0,
    maxInstances: 20,
  });

  renderer.update(-0.1, -0.1);
  assert.deepEqual(renderer.bounds, {
    minX: -16, maxX: 0, minZ: -16, maxZ: 0,
  });
  assert.deepEqual(renderer.stats, {
    count: 1,
    broadleaf: 1,
    conifer: 0,
    cactus: 0,
  });

  renderer.update(0, 0);
  assert.deepEqual(renderer.bounds, {
    minX: 0, maxX: 16, minZ: 0, maxZ: 16,
  });
  assert.deepEqual(renderer.stats, {
    count: 1,
    broadleaf: 0,
    conifer: 1,
    cactus: 0,
  });
  renderer.dispose();
});

test('vegetation disposes shared pools once and ignores later updates', () => {
  const world = new StubWorld([
    placement(VEGETATION_KIND.BROADLEAF, 1, 1),
    placement(VEGETATION_KIND.CONIFER, 2, 2),
    placement(VEGETATION_KIND.CACTUS, 3, 3),
  ]);
  const renderer = new VegetationRenderer(source(world), {
    cellSize: 32,
    radiusCells: 0,
    maxInstances: 8,
  });
  renderer.update(0, 0);

  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  for (const child of renderer.group.children) {
    assert.ok(child instanceof THREE.InstancedMesh);
    geometries.add(child.geometry);
    const material = child.material;
    if (Array.isArray(material)) {
      for (const entry of material) materials.add(entry);
    } else {
      materials.add(material);
    }
    if (child.customDepthMaterial) materials.add(child.customDepthMaterial);
  }
  assert.equal(geometries.size, 7);
  assert.equal(materials.size, 6);

  let geometryDisposals = 0;
  let materialDisposals = 0;
  for (const geometry of geometries) {
    geometry.addEventListener('dispose', () => { geometryDisposals++; });
  }
  for (const material of materials) {
    material.addEventListener('dispose', () => { materialDisposals++; });
  }

  renderer.dispose();
  renderer.dispose();
  assert.equal(geometryDisposals, geometries.size);
  assert.equal(materialDisposals, materials.size);
  assert.equal(renderer.group.children.length, 0);
  assert.equal(renderer.count, 0);
  assert.deepEqual(renderer.stats, {
    count: 0,
    broadleaf: 0,
    conifer: 0,
    cactus: 0,
  });
  assert.equal(renderer.bounds, null);

  const callsBefore = world.calls.length;
  assert.equal(renderer.update(64, 64), false);
  assert.equal(world.calls.length, callsBefore);
});

test('vegetation looks varied yet renders deterministically', () => {
  const placements: VegetationPlacement[] = [];
  for (let i = 0; i < 12; i++) {
    placements.push(placement(VEGETATION_KIND.BROADLEAF, 2 + i * 9, 3, {
      height: 8, canopyRadius: 3.4, yaw: i * 0.5,
    }));
    placements.push(placement(VEGETATION_KIND.CONIFER, 2 + i * 9, 40, {
      height: 10, canopyRadius: 2.6, yaw: i * 0.4,
    }));
    placements.push(placement(VEGETATION_KIND.CACTUS, 2 + i * 9, 80, {
      height: 4.5, canopyRadius: 1.1, yaw: i * 0.3,
    }));
  }
  const build = (): VegetationRenderer => {
    const renderer = new VegetationRenderer(
      source(new StubWorld(placements)),
      { cellSize: 128, radiusCells: 0, maxInstances: 64 },
    );
    renderer.update(64, 64);
    return renderer;
  };
  const a = build();
  const b = build();

  // Identical inputs must reproduce every cosmetic choice bit-for-bit: the
  // variation is a pure function of the placement, never of rebuild order,
  // wall time, or Math.random().
  for (const mesh of a.group.children) {
    assert.ok(mesh instanceof THREE.InstancedMesh);
    const twin = b.group.getObjectByName(mesh.name);
    assert.ok(twin instanceof THREE.InstancedMesh, `missing twin ${mesh.name}`);
    assert.equal(twin.count, mesh.count, `${mesh.name} count differs`);
    assert.deepEqual(
      Array.from(twin.instanceMatrix.array.slice(0, mesh.count * 16)),
      Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16)),
      `${mesh.name} matrices differ between identical builds`,
    );
    assert.ok(mesh.instanceColor && twin.instanceColor);
    assert.deepEqual(
      Array.from(twin.instanceColor.array.slice(0, mesh.count * 3)),
      Array.from(mesh.instanceColor.array.slice(0, mesh.count * 3)),
      `${mesh.name} colors differ between identical builds`,
    );
  }

  // With identical worldgen dimensions, individuals must still differ in
  // both silhouette and tint - the old renderer drew clone armies.
  const distinct = (
    mesh: THREE.InstancedMesh,
    stride: number,
    pick: (base: number) => string,
  ): number => {
    const seen = new Set<string>();
    for (let i = 0; i < mesh.count; i++) seen.add(pick(i * stride));
    return seen.size;
  };
  const canopies = instance(a, 'vegetation-broadleaf-canopies');
  assert.equal(canopies.count, 12);
  const matrixKey = (mesh: THREE.InstancedMesh) => (base: number): string =>
    Array.from(mesh.instanceMatrix.array.slice(base, base + 12))
      .map((v) => v.toFixed(4)).join(',');
  const colorKey = (mesh: THREE.InstancedMesh) => (base: number): string =>
    Array.from(mesh.instanceColor!.array.slice(base, base + 3))
      .map((v) => v.toFixed(4)).join(',');
  assert.ok(distinct(canopies, 16, matrixKey(canopies)) >= 8,
    'broadleaf crowns must differ in scale/orientation');
  assert.ok(distinct(canopies, 3, colorKey(canopies)) >= 8,
    'broadleaf crowns must differ in tint');
  const conifers = instance(a, 'vegetation-conifer-canopies');
  assert.ok(distinct(conifers, 3, colorKey(conifers)) >= 8,
    'conifer needles must differ in tint');

  // Cactus arm layouts must not be one mirrored glyph: with a dozen cacti,
  // arm counts and matrices must show real spread while staying bounded.
  const cactusArms = instance(a, 'vegetation-cactus-arms');
  const cactusTips = instance(a, 'vegetation-cactus-tips');
  assert.equal(cactusTips.count, cactusArms.count);
  assert.ok(cactusArms.count >= 1 && cactusArms.count <= 36);
  assert.ok(cactusArms.count !== 36,
    'twelve cacti must not all grow the maximum three arms');
  assert.ok(distinct(cactusArms, 16, matrixKey(cactusArms)) >= 6,
    'cactus arms must attach at varied heights/azimuths');

  // Every conifer stacks at least one extra tier and the stack geometry
  // itself must vary between individuals.
  const tiers = instance(a, 'vegetation-conifer-tiers');
  assert.ok(tiers.count >= 12 && tiers.count <= 36,
    `twelve conifers should stack 12-36 extra tiers (${tiers.count})`);
  assert.ok(distinct(tiers, 16, matrixKey(tiers)) >= 8,
    'conifer tiers must vary in size and placement');

  a.dispose();
  b.dispose();
});

test('detailed vegetation keeps a bounded triangle cost and GPU-only wind', () => {
  const renderer = new VegetationRenderer(source(new StubWorld([
    placement(VEGETATION_KIND.BROADLEAF, 4, 4),
    placement(VEGETATION_KIND.CONIFER, 8, 4),
  ])), { cellSize: 32, radiusCells: 0, maxInstances: 8 });
  renderer.update(0, 0);
  for (const name of ['vegetation-broadleaf-canopies', 'vegetation-conifer-canopies']) {
    const mesh = instance(renderer, name);
    const geometry = mesh.geometry;
    const triangles = (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
    assert.ok(triangles <= 224, 'curved close foliage stays within its bounded geometry budget');
    const colors = geometry.getAttribute('color');
    assert.ok(colors, 'foliage needs baked canopy depth even without dynamic shadows');
    assert.ok(Math.min(...Array.from(colors.array)) < 0.75);
    for (const attribute of ['position', 'normal', 'uv', 'color']) {
      assert.ok(Array.from(geometry.getAttribute(attribute).array).every(Number.isFinite),
        `foliage ${attribute} must remain finite`);
    }
    const material = mesh.material as THREE.MeshStandardMaterial;
    assert.equal(material.transparent, false, 'membranes retain depth writes and avoid transparent sorting');
    assert.equal(material.depthWrite, true);
    assert.equal(material.alphaTest, 0, 'the mesh supplies the silhouette without cutout overdraw');
    assert.ok(material.map instanceof THREE.DataTexture);
    const atlas = material.map.image;
    assert.equal(atlas.width, 128);
    assert.equal(atlas.height, 128);
    const alpha = Array.from(atlas.data).filter((_, i) => i % 4 === 3);
    const coverage = alpha.filter((v) => v > 128).length / alpha.length;
    assert.equal(coverage, 1, 'the tiny membrane texture supplies veins, not missing geometry');
    assert.ok(mesh.customDepthMaterial instanceof THREE.MeshDepthMaterial);
    const before = mesh.instanceMatrix.version;
    renderer.animate(12.5);
    renderer.animate(Number.NaN);
    assert.equal(mesh.instanceMatrix.version, before, 'wind must not upload instance matrices');
  }
  renderer.dispose();
});

test('distant native foliage retains open silhouettes within the fixed draw budget', () => {
  const renderer = new VegetationRenderer(source(new StubWorld([
    placement(VEGETATION_KIND.BROADLEAF, 100, 0),
    placement(VEGETATION_KIND.CONIFER, 120, 0),
  ])), { cellSize: 256, radiusCells: 0, maxInstances: 8, nearDistance: 0 });
  renderer.update(0, 0);
  try {
    for (const name of ['vegetation-far-stems', 'vegetation-far-broadleaf', 'vegetation-far-conifers']) {
      const mesh = instance(renderer, name), g = mesh.geometry;
      assert.ok(mesh.count > 0);
      assert.equal(mesh.castShadow, false, 'distant plants cannot expand the desktop shadow workload');
      assert.ok((g.index?.count ?? g.getAttribute('position').count) / 3 <= 72);
      for (const attribute of ['position', 'normal', 'color']) {
        assert.ok(g.getAttribute(attribute), 'every pool using vertex colors must supply them');
        assert.ok(Array.from(g.getAttribute(attribute).array).every(Number.isFinite));
      }
    }
    // A cone filled every ray through this footprint. Real separated
    // whorls preserve sky between leaves even in the distant representation.
    const g = instance(renderer, 'vegetation-far-conifers').geometry;
    const mesh = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    const ray = new THREE.Raycaster(), direction = new THREE.Vector3(0, -1, 0);
    let open = 0, total = 0;
    for (let x = -.8; x <= .8; x += .1) for (let z = -.8; z <= .8; z += .1) {
      if (Math.hypot(x, z) > .85) continue;
      ray.set(new THREE.Vector3(x, 2, z), direction); total++;
      if (ray.intersectObject(mesh).length === 0) open++;
    }
    mesh.material.dispose();
    assert.ok(open / total > .15 && open / total < .8, 'fronds keep both actual leaves and open sky');
  } finally { renderer.dispose(); }
});
