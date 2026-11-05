import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '@shared/worldgen';
import { cityLifePlan, cityCivilianPose } from '@shared/city-life';
import { CityLife, MAX_VISIBLE_VENUES, rayCivilian } from '../src/render/city-life.js';
import { CivilianModels, CIVILIAN_DOWN_SECONDS, CIVILIAN_RETURN_SECONDS, MAX_VISIBLE_CIVILIANS } from '../src/render/civilian-models.js';

test('city interiors and civilian detail stay within fixed local pools and disappear outside cities', () => {
  const world = new World(1337), render = new CityLife(world);
  for (const city of world.collectCities()) for (const venue of cityLifePlan(city).venues) {
    render.update(venue.x, venue.y + 1.7, venue.z + venue.hz + 4, 35);
    assert.ok(render.stats.venues > 0 && render.stats.venues <= MAX_VISIBLE_VENUES);
    assert.ok(render.stats.civilians >= 6 && render.stats.civilians <= MAX_VISIBLE_CIVILIANS);
    assert.ok(render.stats.draws <= 22, `draws ${render.stats.draws}`);
    assert.ok(render.stats.triangles < 120000, `triangles ${render.stats.triangles}`);
    render.group.traverse(object => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      assert.ok(object.count <= object.instanceMatrix.count);
      assert.ok(object.instanceMatrix.array.every(Number.isFinite));
    });
  }
  render.update(10500, 1000, 10500, 40);
  assert.equal(render.stats.venues, 0); assert.equal(render.stats.civilians, 0); assert.equal(render.stats.draws, 0);
  render.dispose(); assert.equal(render.group.children.length, 0);
});

test('articulated civilian wardrobes retain planted feet at rest and reuse all twelve geometry pools', () => {
  const plan = cityLifePlan(new World(1337).collectCities()[0]), models = new CivilianModels();
  const items = Array.from({ length: 70 }, (_, i) => {
    const civilian = { ...plan.civilians[i % plan.civilians.length], id: i, style: i % 3, phase: 0 };
    return { civilian, pose: { ...cityCivilianPose(civilian, 0), x: i * 2, y: 10, z: 0, yaw: 0, moving: false, stride: 0 } };
  });
  models.update(items, 0);
  assert.equal(models.stats.count, 48); assert.equal(models.stats.draws, 12);
  const meshes = models.group.children as THREE.InstancedMesh[], geometry = meshes.map(m => m.geometry);
  const feet = meshes.filter(m => m.name.endsWith('-2')), original = feet.map(m => m.instanceMatrix.array.slice());
  const point = new THREE.Vector3(), matrix = new THREE.Matrix4();
  for (const mesh of feet) for (let i = 0; i < mesh.count; i++) {
    mesh.getMatrixAt(i, matrix); let minimum = Infinity;
    const p = mesh.geometry.attributes.position;
    for (let j = 0; j < p.count; j++) minimum = Math.min(minimum, point.fromBufferAttribute(p, j).applyMatrix4(matrix).y);
    assert.ok(minimum >= 9.99 && minimum < 10.04, `resting boot bottom ${minimum}`);
  }
  models.update(items, 120);
  for (let i = 0; i < feet.length; i++) assert.deepEqual(feet[i].instanceMatrix.array, original[i], 'idle arms may gesture while feet stay planted');
  assert.deepEqual(meshes.map(m => m.geometry), geometry);
  models.update([], 125); assert.equal(models.stats.draws, 0);
  models.dispose(); assert.equal(models.group.children.length, 0);
});

test('a shot or a blast fells civilians on this client; they lie down, vanish, then return', () => {
  assert.ok(Math.abs(rayCivilian(-5, 1, 0, 1, 0, 0, 0, 0, 0)! - 4.7) < 1e-9, 'a shot meets the body at its edge');
  assert.equal(rayCivilian(-5, 2.2, 0, 1, 0, 0, 0, 0, 0), null, 'over the head misses');
  assert.equal(rayCivilian(0, 5, 0, 0, -1, 0, 0, 0, 0), null, 'a vertical ray has no side to hit');
  const world = new World(1337), render = new CityLife(world);
  const venue = cityLifePlan(world.collectCities()[0]).venues[0];
  const at = (seconds: number) => render.update(venue.x, venue.y + 1.7, venue.z + venue.hz + 4, seconds);
  type Standing = { civilian: { id: number }; pose: { x: number; y: number; z: number } };
  const internals = render as unknown as { standing: Standing[]; fallen: Map<number, unknown> };
  at(35);
  const target = internals.standing[0], id = target.civilian.id;
  const ox = target.pose.x - 1, oy = target.pose.y + 1.2, oz = target.pose.z;
  assert.equal(render.shoot(ox, oy, oz, 1, 0, 0, .5), null, 'beyond the range of the shot');
  const hit = render.shoot(ox, oy, oz, 1, 0, 0, 2);
  assert.ok(hit && hit.x <= target.pose.x, 'the shot stops at the civilian');
  assert.ok(internals.fallen.has(id) && !internals.standing.some(item => item.civilian.id === id));
  at(36); assert.ok(!internals.standing.some(item => item.civilian.id === id), 'still down, drawn falling');
  at(35 + CIVILIAN_DOWN_SECONDS + 1); assert.ok(internals.fallen.has(id), 'gone from view until the return');
  at(35 + CIVILIAN_RETURN_SECONDS + 1); assert.ok(!internals.fallen.has(id), 'back after the return delay');
  const standing = internals.standing.length, p = internals.standing[0].pose;
  assert.ok(render.blast(p.x, p.y + 1, p.z, 400) === standing && internals.standing.length === 0, 'a blast fells everyone in its radius');
  render.dispose();
});
