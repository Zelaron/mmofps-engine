import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { capitalPlan } from '@shared/cities';
import { capitalBoundary, capitalSegmentDistance } from '@shared/capital-geometry';

test('giant capital shells collide above the terrain height without meshing sky', () => {
  const world = new World(1337);
  for (const city of world.collectCities().filter(c => c.theme)) {
    const plan = capitalPlan(city)!;
    const sweep = plan.sweeps.find(s => s.points.some(p => p.y > 800 && p.radius > 5))!;
    const point = sweep.points.find(p => p.y > 800 && p.radius > 5)!;
    assert.ok(world.sdf(point.x, point.y, point.z) < 0, 'high tower collider missing');
    const region = world.collectStructures(point.x, point.x, point.z, point.z);
    assert.ok(region.capitalSegments!.length > 0 && region.capitalSegments!.length < 1500);
    assert.ok(world.trace(point.x + point.radius + 30, point.y, point.z, -1, 0, 0, point.radius * 2 + 60).hit);
  }
});

test('Vesper is an open irregular abyss, with no cave sky mask or blanket floor', () => {
  const world = new World(1337), city = world.collectCities().find(c => c.theme === 'vesper')!;
  const x = city.x + 450, z = city.z + 460;
  assert.ok(city.radius >= 1900);
  assert.ok(world.column(x, z).h < -55);
  assert.equal(world.roofedAbove(x, city.y, z), false);
  assert.ok(world.terrainHeight(city.x + 2000, city.z) > city.y - .1, 'outer approach requires dry ground');
  assert.notEqual(capitalBoundary(city, city.x + 1900, city.z), capitalBoundary(city, city.x, city.z + 1900));
});

test('tapered segment distance preserves cover and bounded marching hints', () => {
  const s = { a: { x: 0, y: 0, z: 0, radius: 20 }, b: { x: 10, y: 100, z: 0, radius: 5 } };
  assert.ok(capitalSegmentDistance(s, 5, 50, 0) < 0);
  assert.ok(capitalSegmentDistance(s, 50, 50, 0) > 0);
});
