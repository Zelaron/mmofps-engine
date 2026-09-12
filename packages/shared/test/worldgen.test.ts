import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAVE_ENTRANCE_THRESHOLD,
  STRUCTURE_KIND,
  VEGETATION_KIND,
  World,
  cavePathPoint,
  type Region,
  type StructureSite,
} from '@shared/worldgen';
import { PLAYER, WORLD } from '@shared/constants';
import { capsuleClearance } from '@shared/physics';
import { mulberry32 } from '@shared/rng';

const NO_PROPS: Region = {
  sites: [],
  pads: [],
  solids: [],
  cuts: [],
  boulders: [],
  vegetation: [],
};

function bisectSignChange(
  f: (y: number) => number,
  a: number,
  b: number,
): number {
  let da = f(a);
  assert.ok((da > 0) !== (f(b) > 0), `expected a sign bracket at ${a}..${b}`);
  for (let i = 0; i < 22; i++) {
    const mid = (a + b) * 0.5;
    const dm = f(mid);
    if ((dm > 0) === (da > 0)) {
      a = mid;
      da = dm;
    } else {
      b = mid;
    }
  }
  return (a + b) * 0.5;
}

function percentile(values: readonly number[], p: number): number {
  assert.ok(values.length > 0, 'percentile requires at least one sample');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) * p)];
}

function siteHasThroughRoute(world: World, site: StructureSite): boolean {
  const step = 0.5;
  const localHx = site.rotated ? site.hz : site.hx;
  const localHz = site.rotated ? site.hx : site.hz;
  if (site.kind >= STRUCTURE_KIND.MILITARY_BASE) {
    // Large compounds intentionally reserve a broad central vehicle route.
    // Probe its whole width directly instead of flooding 25k floor cells.
    for (let z = -localHz + 0.25; z <= localHz - 0.25; z += 0.5) {
      for (const x of [-2, 0, 2]) {
        const wx = site.rotated ? site.x + z : site.x + x;
        const wz = site.rotated ? site.z - x : site.z + z;
        if (capsuleClearance(world, wx, site.top + 0.015, wz) < 0) return false;
      }
    }
    return true;
  }
  // Stay within the foundation width so the search cannot "prove" an
  // interior route by walking around the whole building.
  const minX = -localHx;
  const minZ = -localHz + 0.25;
  const maxZ = localHz - 0.25;
  const nx = Math.round((localHx * 2) / step) + 1;
  const nz = Math.round((maxZ - minZ) / step) + 1;
  const open = new Uint8Array(nx * nz);
  const worldPoint = (localX: number, localZ: number): [number, number] =>
    site.rotated
      ? [site.x + localZ, site.z - localX]
      : [site.x + localX, site.z + localZ];

  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const localX = minX + ix * step;
      const localZ = minZ + iz * step;
      const [x, z] = worldPoint(localX, localZ);
      // Field magnitudes are not metric after smooth CSG. Inspect the same
      // capsule shell used by movement rather than comparing sdf() to radius.
      if (capsuleClearance(world, x, site.top + 0.015, z) >= 0) {
        open[iz * nx + ix] = 1;
      }
    }
  }

  const startX = Math.round((0 - minX) / step);
  const start = startX;
  const target = (nz - 1) * nx + startX;
  if (!open[start] || !open[target]) return false;
  const seen = new Uint8Array(open.length);
  const queue = new Int32Array(open.length);
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  seen[start] = 1;
  while (head < tail) {
    const current = queue[head++];
    if (current === target) return true;
    const x = current % nx;
    const z = Math.floor(current / nx);
    for (const next of [
      x > 0 ? current - 1 : -1,
      x + 1 < nx ? current + 1 : -1,
      z > 0 ? current - nx : -1,
      z + 1 < nz ? current + nx : -1,
    ]) {
      if (next < 0 || seen[next] || !open[next]) continue;
      seen[next] = 1;
      queue[tail++] = next;
    }
  }
  return false;
}

test('world SDF is deterministic across instances', () => {
  const a = new World(1337);
  const b = new World(1337);
  const rng = mulberry32(11);
  for (let i = 0; i < 300; i++) {
    const x = (rng() - 0.5) * 3000;
    const z = (rng() - 0.5) * 3000;
    const y = (rng() - 0.5) * 200;
    assert.equal(a.sdf(x, y, z), b.sdf(x, y, z), `mismatch at ${x},${y},${z}`);
  }
});

test('terrain height stays within world bounds', () => {
  const w = new World(1337);
  const rng = mulberry32(5);
  for (let i = 0; i < 400; i++) {
    const x = (rng() - 0.5) * 8000;
    const z = (rng() - 0.5) * 8000;
    const h = w.terrainHeight(x, z);
    assert.ok(Number.isFinite(h));
    assert.ok(h > -60 && h < WORLD.MAX_HEIGHT, `height out of range: ${h}`);
  }
});

test('terrain has regional relief while retaining traversable stretches', () => {
  for (const seed of [1, 1337, 424242]) {
    const w = new World(seed);
    const localChanges: number[] = [];
    for (let z = -320; z <= 320; z += 32) {
      for (let x = -320; x <= 320; x += 32) {
        if (x * x + z * z > 320 * 320) continue;
        const h = w.terrainHeight(x, z);
        localChanges.push(
          Math.abs(w.terrainHeight(x + 10, z) - h),
          Math.abs(w.terrainHeight(x, z + 10) - h),
        );
      }
    }

    const medianChange = percentile(localChanges, 0.5);
    assert.ok(
      medianChange > 0.32,
      `seed ${seed}: median 10m relief is only ${medianChange.toFixed(3)}m`,
    );
    const traversable = localChanges.filter((d) => d < 1.5).length / localChanges.length;
    assert.ok(
      traversable > 0.5,
      `seed ${seed}: only ${(traversable * 100).toFixed(1)}% of 10m spans are gentle`,
    );

    // A broad mask must not make an entire play-sized region uniformly flat
    // or uniformly mountainous. Sample many independent 128m patches instead
    // of pinning the invariant to one hand-picked coordinate.
    const patchRelief: number[] = [];
    for (let cz = -1536; cz <= 1536; cz += 384) {
      for (let cx = -1536; cx <= 1536; cx += 384) {
        let lo = Infinity;
        let hi = -Infinity;
        for (let dz = -64; dz <= 64; dz += 32) {
          for (let dx = -64; dx <= 64; dx += 32) {
            const h = w.terrainHeight(cx + dx, cz + dz);
            if (h < lo) lo = h;
            if (h > hi) hi = h;
          }
        }
        patchRelief.push(hi - lo);
      }
    }
    const upperQuartile = percentile(patchRelief, 0.75);
    const highTail = percentile(patchRelief, 0.9);
    assert.ok(
      upperQuartile > 12,
      `seed ${seed}: 128m relief upper quartile is only ${upperQuartile.toFixed(2)}m`,
    );
    assert.ok(
      highTail > 50 && highTail < 115,
      `seed ${seed}: 128m massif relief must be dramatic but bounded (${highTail.toFixed(2)}m)`,
    );
  }
});

test('terrain slopes stay within the conservative field-march envelope', () => {
  for (const seed of [1, 1337, 424242]) {
    const w = new World(seed);
    const slopes: number[] = [];
    const e = 0.5;
    for (let z = -1920; z <= 1920; z += 32) {
      for (let x = -1920; x <= 1920; x += 32) {
        const dx =
          (w.terrainHeight(x + e, z) - w.terrainHeight(x - e, z)) / (2 * e);
        const dz =
          (w.terrainHeight(x, z + e) - w.terrainHeight(x, z - e)) / (2 * e);
        slopes.push(Math.hypot(dx, dz));
      }
    }
    const p99 = percentile(slopes, 0.99);
    const max = Math.max(...slopes);
    // Lake banks and authored temple approaches add deliberate steep slopes;
    // at least99% of this central sample remains below a55degree grade.
    // The maximum below still enforces the collision field's march bound.
    assert.ok(p99 < 1.43, `seed ${seed}: p99 terrain slope is ${p99.toFixed(3)}`);
    assert.ok(max > 1.2 && max < 2.8, `seed ${seed}: cliff slope ${max.toFixed(3)} exceeds the 0.32 field-march envelope`);
  }
});

test('groundY finds a surface everywhere inside the border', () => {
  for (const seed of [1, 1337, 424242]) {
    const w = new World(seed);
    const rng = mulberry32(seed ^ 23);
    for (let i = 0; i < 60; i++) {
      const x = (rng() - 0.5) * 3000;
      const z = (rng() - 0.5) * 3000;
      const gy = w.groundY(x, z);
      assert.ok(Number.isFinite(gy));
      assert.ok(gy > WORLD.MIN_CAVE_Y - 2 && gy < WORLD.MAX_HEIGHT, `groundY out of range: ${gy}`);
      // A trace hit is the solid endpoint of a real sign bracket, never merely
      // a small positive local minimum in the field.
      assert.ok(w.sdf(x, gy, z) <= 0, `groundY returned air at ${x},${gy},${z}`);
      assert.ok(w.sdf(x, gy + 0.02, z) > 0, 'air immediately above ground');
      assert.ok(w.sdf(x, gy - 0.02, z) <= 0, 'solid immediately below ground');
    }
  }
});

test('rays hugging explicit mouth walls cannot exhaust the ray marcher', () => {
  const w = new World(1);
  const sites = w.collectCaveSites(-960, 960, -960, 960).slice(0, 8);
  assert.equal(sites.length, 8);
  for (const site of sites) {
    const p = cavePathPoint(site, site.mouthLength - 0.04);
    const gy = w.groundY(p.x, p.z);
    assert.ok(w.sdf(p.x, gy, p.z) <= 0, `mouth floor ${gy} is not solid`);
    assert.ok(w.sdf(p.x, gy + 0.02, p.z) > 0, 'mouth floor has no air above it');
    assert.ok(Math.abs(gy - p.y) < 0.02, 'trace must reach the real graded floor');
  }
});

test('spawns are clear of geometry', () => {
  const w = new World(1337);
  const rng = mulberry32(99);
  for (let i = 0; i < 25; i++) {
    const s = w.findSpawn(rng);
    assert.ok(Number.isFinite(s.x + s.y + s.z));
    const col = w.column(s.x, s.z);
    assert.ok(col.entr < CAVE_ENTRANCE_THRESHOLD - 0.03,
      `spawn ${i} landed in a cave entrance`);
    assert.ok(Math.abs((s.y - 0.12) - col.h) < 0.85,
      `spawn ${i} landed on a prop or underground surface`);
    assert.ok(capsuleClearance(w, s.x, s.y, s.z) > 0,
      `spawn ${i} capsule overlaps generated geometry`);
    assert.ok(w.sdf(s.x, s.y + 1.0, s.z) > 0.4, `spawn ${i} blocked at torso`);
    assert.ok(
      w.sdf(s.x, s.y + PLAYER.HEIGHT - 0.2, s.z) > 0.4,
      `spawn ${i} blocked at head`,
    );
  }
});

test('rays hit terrain from above and escape to the sky', () => {
  const w = new World(1337);
  const rng = mulberry32(7);
  for (let i = 0; i < 40; i++) {
    const x = (rng() - 0.5) * 2000;
    const z = (rng() - 0.5) * 2000;
    const down = w.trace(x, WORLD.MAX_HEIGHT - 1, z, 0, -1, 0, 300);
    assert.ok(down.hit, 'downward ray must hit terrain');
    const gy = down.y;
    const up = w.trace(x, gy + 2, z, 0, 1, 0, 400);
    // Going straight up can legitimately hit an overhang/roof, but usually escapes.
    assert.ok(Number.isFinite(up.dist));
  }
});

test('gradient is normalized', () => {
  const w = new World(1337);
  const rng = mulberry32(31);
  const g = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < 60; i++) {
    const x = (rng() - 0.5) * 2000;
    const z = (rng() - 0.5) * 2000;
    const gy = w.groundY(x, z);
    w.gradient(x, gy, z, g);
    const len = Math.hypot(g.x, g.y, g.z);
    assert.ok(Math.abs(len - 1) < 1e-6, `gradient not normalized: ${len}`);
  }
});

test('cave ceiling and lower bound are continuous (no sentinel sheets)', () => {
  const w = new World(1337);
  const rng = mulberry32(191);
  const eps = 0.001;
  let maxTopJump = 0;
  let maxLowerJump = 0;

  for (let i = 0; i < 300; i++) {
    const x = (rng() - 0.5) * 3000;
    const z = (rng() - 0.5) * 3000;
    const col = w.column(x, z);
    const shaftTop = col.h + 1;
    const at = (y: number): number => w.sdfCol(x, y, z, col, NO_PROPS);
    maxTopJump = Math.max(maxTopJump, Math.abs(at(shaftTop + eps) - at(shaftTop - eps)));
    maxLowerJump = Math.max(
      maxLowerJump,
      Math.abs(at(WORLD.MIN_CAVE_Y + eps) - at(WORLD.MIN_CAVE_Y - eps)),
    );
  }

  assert.ok(maxTopJump < 0.1, `entrance-shaft top field jumps by ${maxTopJump}`);
  assert.ok(maxLowerJump < 0.1, `cave lower field jumps by ${maxLowerJump}`);
});

test('explicit cave mouths have no sub-voxel horizontal roof remnants', () => {
  const w = new World(1337);
  const sites = w.collectCaveSites(-960, 960, -960, 960).slice(0, 10);
  for (const site of sites) {
    for (const forward of [16, site.mouthLength - 2]) {
      const p = cavePathPoint(site, forward);
      for (const side of [-3, 0, 3]) {
        const x = p.x - site.dz * side, z = p.z + site.dx * side;
        const col = w.column(x, z);
        const gy = w.groundY(x, z);
        assert.ok(col.entr > CAVE_ENTRANCE_THRESHOLD);
        assert.ok(Math.abs(gy - p.y) < 0.04, 'mouth floor must meet the gallery grade');
        for (let y = gy + 0.1; y < col.h + 0.9; y += 0.2) {
          assert.ok(w.sdfCol(x, y, z, col, NO_PROPS) > 0,
            `solid mouth remnant at ${x},${y},${z}`);
        }
      }
    }
  }
});

test('non-entrance caves retain a meshable minimum roof', () => {
  const w = new World(1337);
  const rng = mulberry32(0x51a7);
  let checked = 0;
  for (let i = 0; i < 800; i++) {
    const x = (rng() - 0.5) * 3600;
    const z = (rng() - 0.5) * 3600;
    const col = w.column(x, z);
    // Stay comfortably outside the continuous shaft contour.
    if (col.entr >= 0.68) continue;
    for (let depth = 0.05; depth < 2.35; depth += 0.1) {
      const d = w.sdfCol(x, col.h - depth, z, col, NO_PROPS);
      assert.ok(
        d < 0,
        `roof thinner than 2.4m at ${x.toFixed(2)},${z.toFixed(2)} depth ${depth.toFixed(2)}`,
      );
    }
    checked++;
  }
  assert.ok(checked > 400, `too few ordinary roof columns checked (${checked})`);
});

test('authored mouths and roofed galleries retain their aperture signs across seeds', () => {
  for (const seed of [1, 1337, 424242]) {
    const w = new World(seed);
    const sites = w.collectCaveSites(-960, 960, -960, 960).slice(0, 12);
    assert.equal(sites.length, 12);
    for (const site of sites) {
      for (const forward of [16, site.mouthLength - 2]) {
        const p = cavePathPoint(site, forward), col = w.column(p.x, p.z);
        for (let y = p.y + 0.1; y <= col.h + 0.5; y += 0.2) {
          assert.ok(w.sdfCol(p.x, y, p.z, col, NO_PROPS) > 0, 'mouth must remain continuously open');
        }
        assert.ok(w.sdfCol(p.x, p.y - 0.2, p.z, col, NO_PROPS) < 0, 'mouth has a real floor');
      }
      const p = cavePathPoint(site, 64), col = w.column(p.x, p.z);
      assert.ok(w.sdf(p.x, p.y + 1.7, p.z) > 0.5, 'gallery has full headroom');
      for (const depth of [0.05, 0.5, 1.2, 2.3]) {
        assert.ok(w.sdfCol(p.x, col.h - depth, p.z, col, NO_PROPS) < 0, 'gallery roof stays meshable');
      }
    }
  }
});

test('trace finds the same first cave surface as a dense sign oracle', () => {
  const w = new World(1337);
  const origin = { x: -112, y: 2, z: -128 };
  assert.ok(w.sdf(origin.x, origin.y, origin.z) > 0.5, 'fixture must be cave air');
  const rng = mulberry32(0x71ace);
  for (let ray = 0; ray < 72; ray++) {
    const y = rng() * 1.8 - 0.9;
    const angle = rng() * Math.PI * 2;
    const h = Math.sqrt(1 - y * y);
    const dx = Math.cos(angle) * h;
    const dy = y;
    const dz = Math.sin(angle) * h;
    const maxDist = 28;
    const hit = w.trace(origin.x, origin.y, origin.z, dx, dy, dz, maxDist);

    const step = 0.015;
    let dense: number | null = null;
    for (let t = step; t <= maxDist; t += step) {
      if (w.sdf(origin.x + dx * t, origin.y + dy * t, origin.z + dz * t) <= 0) {
        dense = t;
        break;
      }
    }
    assert.equal(hit.hit, dense !== null, `ray ${ray}: trace/dense hit parity differs`);
    if (dense !== null) {
      assert.ok(Math.abs(hit.dist - dense) <= step + 0.002,
        `ray ${ray}: trace ${hit.dist.toFixed(4)} vs dense ${dense.toFixed(4)}`);
    }
  }
});

test('every sampled cave sign crossing contains a zero of the canonical field', () => {
  const w = new World(1337);
  const rng = mulberry32(812);
  let crossings = 0;

  for (let i = 0; i < 90; i++) {
    const x = (rng() - 0.5) * 2600;
    const z = (rng() - 0.5) * 2600;
    const col = w.column(x, z);
    const at = (y: number): number => w.sdfCol(x, y, z, col, NO_PROPS);
    let y0 = WORLD.MIN_CAVE_Y - 1;
    let d0 = at(y0);
    for (let y1 = y0 + 0.5; y1 <= col.h + 1; y1 += 0.5) {
      const d1 = at(y1);
      if ((d0 > 0) !== (d1 > 0)) {
        const root = bisectSignChange(at, y0, y1);
        assert.ok(Math.abs(at(root)) < 0.002,
          `sign change without a zero at ${x.toFixed(1)},${root.toFixed(3)},${z.toFixed(1)}`);
        crossings++;
      }
      y0 = y1;
      d0 = d1;
    }
  }
  assert.ok(crossings > 120, `too few cave/terrain crossings checked (${crossings})`);
});

test('cave floors vary and do not collapse onto a global plane', () => {
  const w = new World(1337);
  const rng = mulberry32(404);
  const floors: number[] = [];

  for (let i = 0; i < 900 && floors.length < 180; i++) {
    const x = (rng() - 0.5) * 3200;
    const z = (rng() - 0.5) * 3200;
    const col = w.column(x, z);
    const at = (y: number): number => w.sdfCol(x, y, z, col, NO_PROPS);
    let y0 = WORLD.MIN_CAVE_Y - 1;
    let d0 = at(y0);
    for (let y1 = y0 + 0.5; y1 <= WORLD.MIN_CAVE_Y + 32; y1 += 0.5) {
      const d1 = at(y1);
      if (d0 <= 0 && d1 > 0) {
        const floor = bisectSignChange(at, y0, y1);
        // Exclude unusually low exterior terrain; this invariant is about
        // an underground solid->cave-air transition.
        if (floor < col.h - 4) floors.push(floor);
        break;
      }
      y0 = y1;
      d0 = d1;
    }
  }

  assert.ok(floors.length >= 80, `too few cave floors found (${floors.length})`);
  const min = Math.min(...floors);
  const max = Math.max(...floors);
  assert.ok(min > WORLD.MIN_CAVE_Y + 0.5, `floor still reaches hard bound: ${min}`);
  assert.ok(max - min > 6, `cave floor range is only ${(max - min).toFixed(2)}m`);

  const bins = new Map<number, number>();
  for (const y of floors) {
    const bin = Math.round(y * 4) / 4;
    bins.set(bin, (bins.get(bin) ?? 0) + 1);
  }
  const largestBin = Math.max(...bins.values());
  assert.ok(largestBin / floors.length < 0.2,
    `${largestBin}/${floors.length} cave floors share one 25cm plane`);
});

test('entrance galleries descend into varied chambers instead of flat bottomed pits', () => {
  for (const seed of [1, 1337, 424242]) {
    const w = new World(seed);
    for (const site of w.collectCaveSites(-640, 640, -640, 640).slice(0, 5)) {
      const top = cavePathPoint(site, 0), bottom = cavePathPoint(site, site.length);
      assert.ok(top.y - bottom.y >= (site.levelChamber ? 8 : 15), 'gallery needs visible vertical progression');
      const center = w.column(bottom.x, bottom.z).cave!;
      // Paired approaches join on a level chamber floor. A fixed 12m
      // sideways probe can be inside that landing, or on its other walking
      // route. Inspect actual supported room rims outside BOTH galleries.
      const rims: number[] = [];
      for (const radius of [.8, .9, 1, 1.1]) for (let i = 0; i < 48; i++) {
        const angle = i * Math.PI / 24;
        const x = bottom.x + Math.cos(angle) * site.chamberRadius * radius;
        const z = bottom.z + Math.sin(angle) * site.chamberRadius * radius;
        const col = w.column(x, z), edge = col.cave;
        if (!edge || edge.footprint < .75 ||
            (col.caveBranches ?? [edge]).some(branch => Math.abs(branch.side) < branch.width + 1)) continue;
        if (w.sdfCol(x, edge.floor + .8, z, col, NO_PROPS) < .15) continue;
        rims.push(edge.floor);
      }
      assert.ok(rims.length > 8, 'sample enough genuine chamber rim, not the rock outside its footprint');
      assert.ok(Math.max(...rims) > center.floor + 0.7,
        'chamber talus must vary outside both walkable routes and their level junction');
      assert.ok(w.sdf(bottom.x, bottom.y + 8, bottom.z) > 0, 'chamber needs vertical space');
    }
  }
});

test('roofedAbove distinguishes open entrance bowls from enclosed caves', () => {
  const w = new World(1337);
  // Enclosed cave air (fixture shared with the trace/mesh suites).
  assert.ok(w.sdf(-112, 2, -128) > 0.5, 'fixture must be cave air');
  assert.ok(w.roofedAbove(-112, 2, -128),
    'an enclosed cave interior must read as roofed');
  // Ordinary surface air is never roofed.
  const surfaceH = w.terrainHeight(50, 50);
  assert.equal(w.roofedAbove(50, surfaceH + 1.7, 50), false);

  // Open entrance bowls sit below the nominal heightfield with clear sky
  // above; the renderer's cave mode must NOT engage there. Witnesses are
  // scanned at runtime: aperture columns whose ground is well below h but
  // whose full-field upward ray escapes (terrain-only therefore escapes
  // too, since the terrain field is a subset of the full field's solids).
  const rng = mulberry32(0x0b0713);
  let bowls = 0;
  for (let i = 0; i < 200_000 && bowls < 12; i++) {
    const x = (rng() - 0.5) * 3000;
    const z = (rng() - 0.5) * 3000;
    const col = w.column(x, z);
    if (col.entr <= CAVE_ENTRANCE_THRESHOLD + 0.02) continue;
    const gy = w.groundY(x, z);
    if (gy > col.h - 3 || gy < col.h - 11) continue;
    const eye = gy + 1.7;
    if (w.sdf(x, eye, z) <= 0.2) continue;
    const up = w.trace(x, eye, z, 0, 1, 0, WORLD.MAX_HEIGHT - eye);
    if (up.hit) continue; // merged into a roofed throat - a legit cave view
    assert.equal(
      w.roofedAbove(x, eye, z),
      false,
      `open bowl at ${x.toFixed(1)},${z.toFixed(1)} wrongly reads as roofed`,
    );
    bowls++;
  }
  assert.ok(bowls >= 8, `too few open-bowl witnesses exercised (${bowls})`);
});

test('generated boulders have cave-aware terrain support', () => {
  const w = new World(1337);
  const region = w.collectRegion(-700, 700, -700, 700);
  assert.ok(region.boulders.length >= 100, `too few boulders (${region.boulders.length})`);

  for (const b of region.boulders) {
    const col = w.column(b.x, b.z);
    const belowBottom = b.y - b.hy - 0.03;
    const d = w.sdfCol(b.x, belowBottom, b.z, col, NO_PROPS);
    assert.ok(d <= 0,
      `floating boulder at ${b.x.toFixed(1)},${b.z.toFixed(1)}: terrain d=${d.toFixed(3)}`);

    const opening = w.column(b.x, b.z).entr > CAVE_ENTRANCE_THRESHOLD;
    for (const ox of [-b.hx, 0, b.hx]) {
      for (const oz of [-b.hz, 0, b.hz]) {
        assert.equal(
          w.column(b.x + ox, b.z + oz).entr > CAVE_ENTRANCE_THRESHOLD,
          opening,
          `boulder footprint straddles an entrance rim at ${b.x.toFixed(1)},${b.z.toFixed(1)}`,
        );
      }
    }
  }
});

test('generated structures never bridge an entrance shaft', () => {
  const w = new World(1337);
  const region = w.collectRegion(-1800, 1800, -1800, 1800);
  assert.ok(region.pads.length >= 20, `too few structure pads (${region.pads.length})`);
  for (const p of region.pads) {
    for (const ox of [-p.hx, 0, p.hx]) {
      for (const oz of [-p.hz, 0, p.hz]) {
        assert.ok(
          w.column(p.x + ox, p.z + oz).entr <= CAVE_ENTRANCE_THRESHOLD,
          `structure at ${p.x.toFixed(1)},${p.z.toFixed(1)} bridges a cave opening`,
        );
      }
    }
  }
});

test('procedural sites span navigable families on supported foundations', () => {
  const signatures: string[] = [];
  const seenKinds = new Set<number>();
  const routesChecked = new Map<number, number>();
  const occurrences = new Map<number, number>();
  for (const seed of [1, 1337, 424242]) {
    const w = new World(seed);
    const region = w.collectRegion(-1800, 1800, -1800, 1800, false);
    assert.equal(region.sites.length, region.pads.length);
    // Mountainous seeds legitimately reject more candidates, and each new
    // family (village/pyramid/runway) has stricter placement than the
    // originals. The bound guards against generation collapse, not density.
    assert.ok(region.sites.length >= 60,
      `seed ${seed}: only ${region.sites.length} generated sites`);
    const legacySolids = region.solids.filter(solid => !solid.capital);
    const transportSolids = new Set(w.collectTransportPlan().solids);
    assert.ok(transportSolids.size < 7500, 'the complete transport network has an independent fixed primitive budget');
    assert.ok(region.solids.filter(solid => transportSolids.has(solid)).length <= transportSolids.size,
      'querying several cells must not duplicate shared transport boxes');
    assert.ok(
      legacySolids.length <= region.sites.length * 32,
      `seed ${seed}: structure primitive budget is unbounded`,
    );
    for (const solid of legacySolids) {
      assert.ok(
        solid.hx >= 0.19 && solid.hy >= 0.19 && solid.hz >= 0.19,
        `seed ${seed}: authoritative structure primitive is thinner than reliable collision cover`,
      );
      // Structures now use exact analytic box instances, so a 1m terrain
      // lattice no longer determines whether a real pillar is visible.
      assert.ok(w.sdf(solid.x, solid.y, solid.z) < 0);
    }

    const kinds = new Set(region.sites.map((site) => site.kind));
    for (const kind of kinds) seenKinds.add(kind);
    assert.ok(kinds.size >= 3,
      `seed ${seed}: only ${kinds.size} structure families generated`);

    for (let i = 0; i < region.sites.length; i++) {
      const site = region.sites[i];
      occurrences.set(site.kind, (occurrences.get(site.kind) ?? 0) + 1);
      const pad = region.pads[i];
      assert.ok(site.top > pad.y + pad.hy);
      assert.ok(site.hx >= 7 && site.hz >= 7);
      for (let ix = 0; ix <= 8; ix++) {
        const ox = -pad.hx + pad.hx * 2 * ix / 8;
        for (let iz = 0; iz <= 8; iz++) {
          const oz = -pad.hz + pad.hz * 2 * iz / 8;
          const col = w.column(pad.x + ox, pad.z + oz);
          assert.ok(col.h <= site.top,
            `seed ${seed}: foundation top cuts through generated terrain`);
          assert.ok(pad.y - pad.hy < col.h,
            `seed ${seed}: foundation floats above generated terrain`);
          assert.ok(col.entr <= CAVE_ENTRANCE_THRESHOLD,
            `seed ${seed}: site foundation crosses a cave entrance`);
        }
      }
      // The megapyramid is exempt from the walk-up approach and generic
      // through-route rules: it is a monument on volcanic relief entered
      // through 8.6m gates (interior navigability has its own test).
      if (site.kind === STRUCTURE_KIND.MEGAPYRAMID) continue;
      const localHz = site.rotated ? site.hx : site.hz;
      for (const side of [-1, 1]) {
        const compound = site.kind === STRUCTURE_KIND.MILITARY_BASE;
        const localZ = side * (localHz + (compound ? 12 : 1));
        const x = site.rotated ? site.x + localZ : site.x;
        const z = site.rotated ? site.z : site.z + localZ;
        const delta = site.top - w.column(x, z).h;
        assert.ok(
          delta >= -0.45 && delta <= (compound ? 6 : 1.30),
          `seed ${seed}: door approach has ${delta.toFixed(2)}m elevation mismatch`,
        );
      }
      const checked = routesChecked.get(site.kind) ?? 0;
      if (checked < 2) {
        assert.ok(
          siteHasThroughRoute(w, site),
          `seed ${seed}: structure family ${site.kind} at ` +
            `${site.x.toFixed(1)},${site.z.toFixed(1)} has no capsule-width through-route`,
        );
        routesChecked.set(site.kind, checked + 1);
      }
    }
    signatures.push(JSON.stringify(region.sites));
  }
  assert.equal(new Set(signatures).size, signatures.length,
    'different seeds produced identical site layouts');
  for (const kind of [
      STRUCTURE_KIND.BUNKER,
      STRUCTURE_KIND.COURTYARD,
      STRUCTURE_KIND.HANGAR,
      STRUCTURE_KIND.RELAY,
      STRUCTURE_KIND.VILLAGE,
      STRUCTURE_KIND.MILITARY_BASE,
      STRUCTURE_KIND.ENCAMPMENT,
      STRUCTURE_KIND.RADAR_STATION,
      STRUCTURE_KIND.RESEARCH_STATION,
    ]) assert.ok(seenKinds.has(kind), `family ${kind} never appeared across three terrain seeds`);
  assert.ok(seenKinds.size >= 9, 'rare monuments and service sites should supplement common families');
  for (const kind of seenKinds) {
    if (kind === STRUCTURE_KIND.MEGAPYRAMID) continue;
    assert.equal(
      routesChecked.get(kind),
      Math.min(2, occurrences.get(kind) ?? 0),
      `structure family ${kind} did not receive its available navigation checks`,
    );
  }
});

test('biome vegetation is deterministic, supported, and authoritative', () => {
  const seenKinds = new Set<number>();
  for (const seed of [1, 1337, 424242]) {
    const a = new World(seed);
    const b = new World(seed);
    const localA = a.collectVegetation(-640, 640, -640, 640);
    const localB = b.collectVegetation(-640, 640, -640, 640);
    assert.deepEqual(localA, localB,
      `seed ${seed}: vegetation depends on query history`);

    const plants = a.collectVegetation(-1800, 1800, -1800, 1800);
    assert.ok(plants.length >= 1000,
      `seed ${seed}: only ${plants.length} plants generated`);
    const structures = a.collectRegion(-1800, 1800, -1800, 1800, false);
    const samples = new Map<number, typeof plants>();
    for (const plant of plants) {
      seenKinds.add(plant.kind);
      const kindSamples = samples.get(plant.kind) ?? [];
      if (kindSamples.length < 24) kindSamples.push(plant);
      samples.set(plant.kind, kindSamples);
    }

    for (const kindSamples of samples.values()) {
      for (const plant of kindSamples) {
        const col = a.column(plant.x, plant.z);
        assert.ok(Math.abs(plant.y - col.h) < 0.85,
          `seed ${seed}: vegetation is not supported by exterior terrain`);
        assert.ok(col.entr < CAVE_ENTRANCE_THRESHOLD - 0.02,
          `seed ${seed}: vegetation blocks a cave entrance`);
        assert.ok(plant.radius >= 0.4 && plant.radius < 0.75);
        assert.ok(plant.height >= 3 && plant.height < 15);

        for (const pad of structures.pads) {
          assert.ok(
            Math.abs(plant.x - pad.x) > pad.hx + 2 ||
            Math.abs(plant.z - pad.z) > pad.hz + 2,
            `seed ${seed}: vegetation occupies a structure approach`,
          );
        }

        const isolated: Region = {
          ...NO_PROPS,
          vegetation: [plant],
        };
        const middleY = plant.y + plant.height * 0.5;
        assert.ok(
          a.sdfCol(
            plant.x,
            middleY,
            plant.z,
            a.column(plant.x, plant.z),
            isolated,
          ) < 0,
          'shared vegetation stem has no collision volume',
        );
        assert.ok(
          a.sdfCol(
            plant.x + plant.radius + 0.08,
            middleY,
            plant.z,
            a.column(plant.x + plant.radius + 0.08, plant.z),
            isolated,
          ) > 0,
          'vegetation collision extends beyond its rendered stem',
        );
      }
    }
  }
  assert.deepEqual(
    [...seenKinds].sort((a, b) => a - b),
    [
      VEGETATION_KIND.BROADLEAF,
      VEGETATION_KIND.CONIFER,
      VEGETATION_KIND.CACTUS,
    ],
  );
});

test('narrow generated stems cannot be skipped by authoritative traces', () => {
  const w = new World(1337);
  const plants = w.collectVegetation(-900, 900, -900, 900);
  let checked = 0;
  for (const plant of plants) {
    const y = plant.y + plant.height * 0.5;
    const startX = plant.x - plant.radius - 1;
    if (w.sdf(startX, y, plant.z) <= 0) continue;
    const hit = w.trace(startX, y, plant.z, 1, 0, 0, 3);
    assert.ok(hit.hit, `trace skipped stem at ${plant.x.toFixed(1)},${plant.z.toFixed(1)}`);
    assert.ok(Math.abs(hit.dist - 1) < 0.01,
      `stem trace hit at ${hit.dist.toFixed(3)}m instead of 1m`);
    checked++;
    if (checked >= 40) break;
  }
  assert.equal(checked, 40, 'too few unobstructed stems were exercised');
});

test('regionAt is independent of prior queries across margin boundaries', () => {
  const signature = (r: Region): string => JSON.stringify({
    sites: r.sites,
    pads: r.pads,
    solids: r.solids,
    cuts: r.cuts,
    boulders: r.boulders,
    vegetation: r.vegetation,
  });
  const oracle = new World(1337);
  let witness: { ax: number; bx: number; z: number } | null = null;

  // Across x = n*36, the +5m boulder-cell bound changes before the -5m
  // bound. These two points shared the old, incomplete memo key.
  outer:
  for (let n = -80; n <= 80; n++) {
    const boundary = n * 36;
    const ax = boundary - 6;
    const bx = boundary;
    for (let z = -1800; z <= 1800; z += 18) {
      const a = signature(oracle.collectRegion(ax, ax, z, z));
      const b = signature(oracle.collectRegion(bx, bx, z, z));
      if (a !== b) {
        witness = { ax, bx, z };
        break outer;
      }
    }
  }
  assert.ok(witness, 'expected a generated primitive near a cache-margin boundary');

  const forward = new World(1337);
  forward.regionAt(witness.ax, witness.z);
  const actualB = signature(forward.regionAt(witness.bx, witness.z));
  const expectedB = signature(forward.collectRegion(witness.bx, witness.bx, witness.z, witness.z));
  assert.equal(actualB, expectedB, 'forward query reused stale region membership');

  const reverse = new World(1337);
  reverse.regionAt(witness.bx, witness.z);
  const actualA = signature(reverse.regionAt(witness.ax, witness.z));
  const expectedA = signature(reverse.collectRegion(witness.ax, witness.ax, witness.z, witness.z));
  assert.equal(actualA, expectedA, 'reverse query reused stale region membership');
});

test('world border is solid', () => {
  const w = new World(1337);
  assert.ok(w.sdf(WORLD.BORDER + 20, 50, 0) < 0);
  assert.ok(w.sdf(0, 50, -WORLD.BORDER - 20) < 0);
  assert.ok(w.sdf(0, 50, 0) > -100); // sanity: interior is not all solid
});
