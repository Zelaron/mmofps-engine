import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/worldgen.js';
import { capitalDistance, capitalSegmentDistance, capitalSegments, type CapitalPlan, type CapitalSegment } from '../src/capital-geometry.js';
import { capitalPlan } from '../src/cities.js';
import { mulberry32 } from '../src/rng.js';

function reference(segments: CapitalSegment[], x: number, y: number, z: number, distance: number): number {
  let d = Math.min(distance, 64);
  for (const s of segments) {
    d = Math.min(d, capitalSegmentDistance(s, x, y, z));
  }
  return d;
}

test('cached XYZ capital queries match brute force normalized tapers across cells and heights', () => {
  const world = new World(1337), rng = mulberry32(711);
  for (const city of world.collectCities().filter(c => c.theme)) {
    const plan = capitalPlan(city)!, segments = plan.sweeps.flatMap(s => s.points.slice(1).map((b, i) => ({ a: s.points[i], b })));
    for (let i = 0; i < 1100; i++) {
      const segment = segments[Math.floor(rng() * segments.length)], a = segment.a, b = segment.b, t = rng();
      const x = a.x + (b.x - a.x) * t + (rng() - .5) * 180;
      const y = a.y + (b.y - a.y) * t + (rng() - .5) * 180;
      const z = a.z + (b.z - a.z) * t + (rng() - .5) * 180;
      const limit = [-2, .05, 1.6, 10, 64, 400][i % 6];
      const expected = reference(segments, x, y, z, limit);
      assert.ok(Math.abs(capitalDistance(segments, x, y, z, limit) - expected) < 1e-8);
      if (i % 7 === 0) {
        const ix = Math.floor(x / 256) * 256, iz = Math.floor(z / 256) * 256;
        const regional = capitalSegments(plan, ix, ix + 256, iz, iz + 256);
        assert.ok(Math.abs(capitalDistance(regional, x, y, z, limit) - expected) < 1e-8, 'coarse region omitted a normalized taper');
      }
    }
  }
});

test('steep tapers retain normalized influence beyond the ordinary coarse-cell apron', () => {
  const plan: CapitalPlan = { solids: [], lifts: [], vehicles: [], rewards: [], sweeps: [{
    id: 1, kind: 'spire', color: 0, accent: 0,
    points: [{ x: 0, y: 0, z: 0, radius: 180 }, { x: 0, y: 18, z: 0, radius: 0 }],
  }] };
  const segment = { a: plan.sweeps[0].points[0], b: plan.sweeps[0].points[1] };
  for (const z of [-600, -512, 512, 600]) {
    const iz = Math.floor(z / 256) * 256, regional = capitalSegments(plan, 0, 256, iz, iz + 256);
    assert.equal(regional.length, 1);
    assert.ok(Math.abs(capitalDistance(regional, 0, 0, z, 64) - capitalSegmentDistance(segment, 0, 0, z)) < 1e-8);
  }
});

test('Aurelia upper-air shortcut retains exact terrain, outskirts and monument collision', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed), city = world.collectCities().find(c => c.theme === 'aurelia')!, rng = mulberry32(seed);
    for (let i = 0; i < 150; i++) {
      const angle = rng() * Math.PI * 2, radius = rng() * city.radius * 1.15;
      const x = city.x + Math.cos(angle) * radius, z = city.z + Math.sin(angle) * radius;
      const y = city.y + [-5, .02, .99, 1, 1.01, 2, 60, 400, 950][i % 9];
      const original = world.sdfCol(x, y, z, world.column(x, z), world.regionAt(x, z));
      assert.ok(Math.abs(world.sdf(x, y, z) - original) < 1e-8, `seed${seed} altered field at${x},${y},${z}`);
    }
  }
});
