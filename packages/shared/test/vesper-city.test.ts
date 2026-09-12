import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVesperPlan, vesperDistricts, vesperRoutes } from '@shared/vesper-city';
import { capitalSegments, capitalSegmentDistance, type CapitalPlan } from '@shared/capital-geometry';
import { sdBox } from '@shared/sdf';
import { capsuleClearance } from '@shared/physics';
import type { World } from '@shared/worldgen';
import type { CityDistrict } from '@shared/cities';

const city = (seed: number): CityDistrict => ({ id: 2, name: 'Vesper Reach', theme: 'vesper', seed,
  x: -5120, y: seed % 2 ? 82 : 105, z: -5120, radius: 2000 });
function fixture(plan: CapitalPlan): World {
  return { sdf(x: number, y: number, z: number) {
    let value = Infinity;
    for (const b of plan.solids) value = Math.min(value, sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz));
    for (const segment of capitalSegments(plan, x, x, z, z)) value = Math.min(value, capitalSegmentDistance(segment, x, y, z));
    return value;
  } } as World;
}

test('Vesper spans a4000m abyss with deterministic varied curved mega-spires and bounded canonical cover', () => {
  for (const seed of [1, 1337, 424242]) {
    const c = city(seed), plan = buildVesperPlan(c), spires = plan.sweeps.filter(s => s.kind === 'spire');
    assert.equal(buildVesperPlan(c), plan, 'repeated region queries rebuild the capital');
    assert.ok(plan.solids.length < 400 && plan.sweeps.length < 380);
    assert.ok(spires.length >= 55 && spires.length <= 70);
    assert.ok(spires.filter(s => Math.max(...s.points.map(p => p.radius)) > 75).length >= 24,
      'the metropolis regressed to uniformly thin needle towers');
    assert.ok(spires.filter(s => Math.max(...s.points.map(p => p.radius)) > s.points[0].radius * 1.7).length >= 24,
      'flared citadels and suspended hive bodies lost their projecting silhouettes');
    assert.ok(Math.max(...spires.map(s => s.points.at(-1)!.y)) >= 1390);
    assert.ok(new Set(spires.map(s => Math.round(s.points.at(-1)!.y / 40))).size > 12);
    for (const s of spires) {
      const a = s.points[0], b = s.points.at(-1)!;
      assert.ok(b.y >= 700 && b.y <= 1400 && a.y < -65);
      assert.ok(Math.hypot(a.x - b.x, a.z - b.z) >= 90, 'spire lost its hooked silhouette');
      assert.ok(b.radius < 1 && a.radius > 25 && s.points.length >= 16);
    }
    assert.equal(vesperDistricts(c).length, 9);
    assert.equal(plan.lifts.length, 16);
    const rescues = plan.lifts.filter(lift => lift.bottom < 0);
    assert.equal(rescues.length, 3);
    for (const lift of rescues) assert.ok(Math.abs(lift.bottom -
      (-65 + 5 * Math.sin(lift.x * .008) * Math.cos(lift.z * .009) + .06)) < 1e-9);
    const routes = vesperRoutes(c);
    for (const [dx, dz] of [[-2000, 0], [2000, 0], [0, -2000], [0, 2000]]) {
      assert.ok(routes.some(r => Math.hypot(r.ax - c.x - dx, r.az - c.z - dz) < .01 && r.width >= 30));
    }
    assert.ok(plan.solids.every(b => b.hx > 0 && b.hy > 0 && b.hz > 0));
  }
});

test('every Vesper bridge has real support and clear capsule lanes; all lift shafts and rewards remain accessible', () => {
  for (const seed of [1, 1337, 424242]) {
    const c = city(seed), plan = buildVesperPlan(c), world = fixture(plan);
    for (const r of vesperRoutes(c)) {
      const dx = r.bx - r.ax, dz = r.bz - r.az, length = Math.hypot(dx, dz), n = Math.ceil(length / 36);
      for (let i = 0; i <= n; i++) for (const lane of [-r.width / 2 + 2, 0, r.width / 2 - 2]) {
        const x = r.ax + dx * i / n + dz / length * lane, z = r.az + dz * i / n - dx / length * lane;
        assert.ok(world.sdf(x, r.y - .03, z) < 0, 'bridge center or shoulder lacks a canonical deck');
        assert.ok(capsuleClearance(world, x, r.y + .04, z) > 0,
          `${seed} spire/arch obstructs bridge at${x-c.x},${r.y},${z-c.z}`);
      }
    }
    for (const lift of plan.lifts) {
      for (let y = lift.bottom + .04; y <= lift.top + 2; y += 12) {
        assert.ok(capsuleClearance(world, lift.x, y, lift.z) > 0, `${seed} tower or deck crosses lift${lift.id} at${y}`);
      }
      assert.ok(capsuleClearance(world, lift.x, lift.top + .04, lift.z) > 0, 'upper stop is capped by a street deck');
    }
    for (const reward of plan.rewards) for (const dx of [0, 1.7]) {
      assert.ok(world.sdf(reward.x + dx, reward.y - .03, reward.z) < 0);
      assert.ok(capsuleClearance(world, reward.x + dx, reward.y + .04, reward.z) > 0);
    }
  }
});
