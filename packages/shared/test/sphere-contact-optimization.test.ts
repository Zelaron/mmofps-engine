import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, cavePathPoint } from '@shared/worldgen';
import { sphereFieldContact, type SphereFieldContact } from '@shared/physics';

const skin = .006, diagonal = 1 / Math.sqrt(3);
const directions = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1],
  [-diagonal, -diagonal, -diagonal], [-diagonal, -diagonal, diagonal],
  [-diagonal, diagonal, -diagonal], [-diagonal, diagonal, diagonal],
  [diagonal, -diagonal, -diagonal], [diagonal, -diagonal, diagonal],
  [diagonal, diagonal, -diagonal], [diagonal, diagonal, diagonal]] as const;

// Frozen original contact evaluator. It intentionally computes a normal for
// every solid shell ray, including those that lose the closest-ray comparison.
function originalContact(world: World, x: number, y: number, z: number, radius: number): SphereFieldContact | null {
  const centerD = world.sdf(x, y, z), reach = radius + skin;
  if (centerD >= radius + 1.2) return null;
  const normal = (x: number, y: number, z: number) => {
    const n = { x: 0, y: 1, z: 0 }; world.gradient(x, y, z, n); return n;
  };
  const contact = (depth: number, n: { x: number; y: number; z: number }, movement = n): SphereFieldContact => ({
    depth, nx: n.x, ny: n.y, nz: n.z, mx: movement.x, my: movement.y, mz: movement.z,
  });
  const bracket = (dx: number, dy: number, dz: number, maxDist: number, knownEndD?: number) => {
    if (!(centerD > 0) || maxDist <= 0) return null;
    const endD = knownEndD ?? world.sdf(x + dx * maxDist, y + dy * maxDist, z + dz * maxDist);
    if (endD > 0) return null;
    let lo = 0, hi = maxDist;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) * .5;
      if (world.sdf(x + dx * mid, y + dy * mid, z + dz * mid) > 0) lo = mid;
      else hi = mid;
    }
    return { dist: hi, normal: normal(x + dx * hi, y + dy * hi, z + dz * hi) };
  };
  if (centerD <= 0) {
    const direction = normal(x, y, z);
    let lo = 0, hi = .05;
    while (hi < 192 && world.sdf(x + direction.x * hi, y + direction.y * hi, z + direction.z * hi) <= 0) {
      lo = hi; hi *= 2;
    }
    if (hi > 192) hi = 192;
    if (world.sdf(x + direction.x * hi, y + direction.y * hi, z + direction.z * hi) <= 0) return null;
    for (let i = 0; i < 10; i++) {
      const mid = (lo + hi) * .5;
      if (world.sdf(x + direction.x * mid, y + direction.y * mid, z + direction.z * mid) <= 0) lo = mid;
      else hi = mid;
    }
    return contact(hi + radius + skin, normal(x + direction.x * hi, y + direction.y * hi, z + direction.z * hi), direction);
  }
  const toward = normal(x, y, z);
  const first = bracket(-toward.x, -toward.y, -toward.z, reach);
  if (first && reach - first.dist > .0005) return contact(reach - first.dist, first.normal);
  let bestDist = Infinity, bestNormal = { x: 0, y: 1, z: 0 };
  for (const d of directions) {
    const endD = world.sdf(x + d[0] * radius, y + d[1] * radius, z + d[2] * radius);
    if (endD > 0) continue;
    const hit = bracket(d[0], d[1], d[2], radius, endD);
    if (hit && hit.dist < bestDist) { bestDist = hit.dist; bestNormal = hit.normal; }
  }
  return bestDist !== Infinity && reach - bestDist > .0005 ? contact(reach - bestDist, bestNormal) : null;
}

function compare(world: World, x: number, y: number, z: number, radius: number): void {
  const expected = originalContact(world, x, y, z, radius);
  const actual = sphereFieldContact(world, x, y, z, radius);
  assert.deepEqual(actual && { ...actual }, expected, `contact changed at ${x},${y},${z}; radius ${radius}`);
}

test('losing shell gradients are skipped without changing contact depth, normals or ties', () => {
  const world = new World(1);
  // Real intersecting walls plus a positive non-distance minimum that points
  // the initial gradient into air, as can happen at a carved CSG branch.
  world.sdf = (x, y, z) => Math.min(.15 + y * y * .3, .8 - Math.abs(x), 1.05 - Math.abs(z));
  const gradient = world.gradient.bind(world);
  const sample = world.sdf.bind(world);
  let gradients = 0, samples = 0;
  world.sdf = (x, y, z) => { samples++; return sample(x, y, z); };
  world.gradient = (x, y, z, out) => { gradients++; gradient(x, y, z, out); };
  const expected = originalContact(world, 0, 0, 0, 1.9), originalGradients = gradients, originalSamples = samples;
  gradients = 0; samples = 0;
  const actual = sphereFieldContact(world, 0, 0, 0, 1.9);
  assert.deepEqual(actual && { ...actual }, expected);
  assert.ok(expected && expected.nx > .99, 'equal opposing walls keep the first shell ray');
  assert.ok(originalGradients >= 5, 'witness needs several losing solid shell rays');
  assert.equal(gradients, 2, 'only the initial direction and winning wall need gradients');
  assert.ok(gradients < originalGradients);
  assert.ok(samples < originalSamples - (originalGradients - gradients) * 6,
    'losing bisections stop early in addition to skipping their six normal samples');
});

test('optimized sphere contacts match the original on mixed walls, slopes, creases and native cave mouths', () => {
  const fields = [
    (x: number, y: number, z: number) => y + x * .35 - z * .22,
    (x: number, y: number, z: number) => Math.min(y, 1.3 - Math.abs(x), 1.7 - z),
    (x: number, y: number, z: number) => Math.min(.08 + y * y, 1.1 - Math.abs(x + z * .3), .9 - Math.abs(z)),
    (x: number, y: number, z: number) => Math.max(y, Math.min(1.2 - Math.hypot(x, z), y + 4)),
  ];
  for (const field of fields) {
    const world = new World(1); world.sdf = field;
    for (const radius of [.42, 1.35, 1.9, 2.95]) {
      for (const x of [-.4, 0, .7]) for (const y of [-.15, .2, .8, 1.4, 3.4]) for (const z of [-.5, 0, .8]) {
        compare(world, x, y, z, radius);
      }
    }
  }
  const world = new World(7331), caves = world.collectCaveSites(-640, 640, -640, 640);
  assert.ok(caves.length >= 2);
  for (const cave of caves.slice(0, 2)) for (const along of [0, cave.mouthLength - 3, cave.mouthLength + 4, cave.length]) {
    const point = cavePathPoint(cave, along);
    for (const radius of [1.35, 1.9, 2.95]) for (const offset of [-.08, .006, .4]) {
      compare(world, point.x, point.y + radius + offset, point.z, radius);
    }
  }
});
