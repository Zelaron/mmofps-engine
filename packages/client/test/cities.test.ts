import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '@shared/worldgen';
import { StructureRenderer, MAX_STRUCTURE_VISUALS } from '../src/render/structures.js';
import { meshColumnChunks, partitionChunkMeshes } from '../src/render/surfacenets.js';

test('whole cities retain bounded instance pools and facade metadata after union ownership', () => {
  const world = new World(1337);
  for (const city of world.collectCities().filter(c => !c.theme)) {
    const renderer = new StructureRenderer(world);
    renderer.update(city.x, city.z);
    const solids = renderer.group.getObjectByName('structure-solids') as THREE.InstancedMesh;
    assert.equal(renderer.group.children.length, 3);
    assert.equal(renderer.stats.truncated, 0);
    assert.ok(renderer.count > 1500 && renderer.count < 3500 && renderer.count < MAX_STRUCTURE_VISUALS / 2);
    const facade = solids.geometry.getAttribute('instanceFacade') as THREE.InstancedBufferAttribute;
    assert.equal(facade.array.byteLength, MAX_STRUCTURE_VISUALS * 2 * 4);
    let windows = 0;
    for (let i = 0; i < solids.count; i++) {
      const style = facade.getX(i) % 16;
      if (style < 1 || style > 3) continue;
      windows++;
      assert.ok(Math.abs(facade.getY(i) - city.y - .06) < .00001);
    }
    assert.ok(windows >= 50, 'union decomposition lost the authoritative facade style');
    renderer.update(city.x + 128, city.z);
    assert.equal(renderer.stats.truncated, 0);
    renderer.dispose();
  }
});

test('megacity renderers exclusively own their canonical bodies without generic duplicate walls', () => {
  const world = new World(1337), renderer = new StructureRenderer(world);
  for (const city of world.collectCities().filter(c => c.theme)) {
    renderer.update(city.x, city.z);
    const solids = renderer.group.getObjectByName('structure-solids') as THREE.InstancedMesh;
    assert.equal(renderer.stats.truncated, 0);
    const facade = solids.geometry.getAttribute('instanceFacade');
    for (let i = 0; i < solids.count; i++) assert.ok(facade.getX(i) < 16, 'generic structure pool duplicates the dedicated capital shell');
  }
  renderer.dispose();
});

test('city roads and sidewalks share one exact floor at each terrain resolution', () => {
  const world = new World(1337), city = world.collectCities()[0];
  let maximumStructureSolids = 0, fieldSamples = 0;
  const evaluate = world.sdfCol.bind(world);
  world.sdfCol = (...args) => {
    fieldSamples++;
    maximumStructureSolids = Math.max(maximumStructureSolids, args[4].solids.length);
    return evaluate(...args);
  };
  for (const step of [1, 4, 16]) {
    const width = 32 * step;
    const cx = Math.floor(city.x / width), cz = Math.floor(city.z / width);
    const before = fieldSamples;
    const chunks = partitionChunkMeshes(meshColumnChunks(world, cx, cz, false, step), cx * width, cz * width, width, 1);
    assert.ok(fieldSamples - before < 250_000, `city terrain mesh exceeded bounded sampling atstep${step}`);
    let street = 0, sidewalk = 0, floorArea = 0;
    for (const chunk of chunks) for (let i = 0; i < chunk.positions.length; i += 9) {
      const p = chunk.positions;
      if ([1, 4, 7].some(j => Math.abs(p[i + j] - city.y - .06) > .0001) || chunk.normals[i + 1] < .99) continue;
      const area = Math.abs((p[i + 3] - p[i]) * (p[i + 8] - p[i + 2]) - (p[i + 6] - p[i]) * (p[i + 5] - p[i + 2])) / 2;
      floorArea += area;
      if (chunk.colors[i] === 62) street += area;
      if (chunk.colors[i] === 161) sidewalk += area;
    }
    const inside = Math.min(city.radius, width);
    assert.ok(Math.abs(floorArea - inside * inside) < .1, `duplicate or missing city floor atstep${step}:${floorArea}`);
    assert.ok(street > 100 && sidewalk > 100, 'city pavement lost its street grid');
  }
  assert.equal(maximumStructureSolids, 0, 'skyline boxes entered the voxel field loop');
});

test('steep quiet summit tiles never perforate into hidden cave roofs at coarse resolution', () => {
  const world = new World(1337), x0 = 640, z0 = -640;
  const chunks = meshColumnChunks(world, x0 / 128, z0 / 128, false, 4);
  const positions = new Float32Array(chunks.reduce((n, chunk) => n + chunk.positions.length, 0));
  let offset = 0;
  for (const chunk of chunks) { positions.set(chunk.positions, offset); offset += chunk.positions.length; }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const material = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
  const mesh = new THREE.Mesh(geometry, material);
  const ray = new THREE.Raycaster(new THREE.Vector3(), new THREE.Vector3(0, -1, 0), 0, 400);
  let checks = 0, maximumError = 0;
  for (let z = z0 + 2; z < z0 + 126; z += 2.7) for (let x = x0 + 2; x < x0 + 126; x += 2.7) {
    const col = world.column(x, z);
    assert.equal(col.cave, undefined, 'fixture must be a quiet surface tile');
    ray.ray.origin.set(x, 300, z);
    const hit = ray.intersectObject(mesh, false)[0];
    assert.ok(hit, `steep terrain has a mesh hole at${x},${z}`);
    maximumError = Math.max(maximumError, Math.abs(hit.point.y - col.h));
    checks++;
  }
  assert.ok(checks > 2000);
  assert.ok(maximumError < 1.5, `surface ray escaped into a hidden cave roof:${maximumError}m`);
  geometry.dispose(); material.dispose();
});
