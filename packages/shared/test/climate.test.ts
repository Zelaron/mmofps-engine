import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, MAT, VEGETATION_KIND, type ColumnData } from '../src/worldgen.js';
import { snowCover } from '../src/climate.js';

const empty = { sites: [], pads: [], solids: [], cuts: [], boulders: [], vegetation: [] };

test('ordinary warm hills stay green while cold regions and alpine summits retain snow', () => {
  const world = new World(1337);
  const base: ColumnData = { h: 110, temp: .6, moist: .8, desert: 0, volc: 0, lavaY: -1000, entr: 0, entrRaw: 0 };
  for (const col of [base, { ...base, h: 160, temp: .84, rainforest: 1 }]) {
    assert.equal(snowCover(col), 0);
    assert.equal(world.material(0, col.h, 0, col, 1, empty, false), MAT.GRASS);
    const color = new Float32Array(3);
    world.vertexColor(MAT.GRASS, 0, col.h, 0, col, color, 0, 1, false);
    assert.ok(color[1] > color[0] * 1.15 && color[1] > color[2] * 1.4, 'leafy hills have green ground, including rainforest overrides');
  }
  for (const col of [{ ...base, h: 30, temp: .08 }, { ...base, h: 270, temp: .5 }]) {
    assert.equal(snowCover(col), 1);
    assert.equal(world.material(0, col.h, 0, col, 1, empty, false), MAT.SNOW);
    assert.equal(snowCover(col, col.h, .25), 0, 'snow does not coat sheer rock faces');
  }
});

test('snow is a minority biome on each playable planet, including the rendered palette', () => {
  for (const seed of [1337, 7331, 20077]) {
    const world = new World(seed); let land = 0, snow = 0, white = 0, alpine = 0;
    const color = new Float32Array(3);
    for (let z = -7680; z <= 7680; z += 256) for (let x = -7680; x <= 7680; x += 256) {
      const col = world.column(x, z);
      if (col.city || col.transport || col.temple || col.volc > .4 || world.liquidAt(x, col.h + .05, z)) continue;
      const mat = world.material(x, col.h, z, col, 1, empty, false);
      land++; if (mat === MAT.SNOW) { snow++; if (col.h > 180) alpine++; }
      world.vertexColor(mat, x, col.h, z, col, color, 0, 1, false);
      if (Math.min(...color) > .75) white++;
    }
    assert.ok(land > 2500 && alpine > 5, `seed ${seed}: broad survey includes real snowy peaks`);
    assert.ok(snow / land > .08 && snow / land < .35, `seed ${seed}: ${snow}/${land} snowy columns`);
    assert.ok(white / land < .35, `seed ${seed}: the visual palette must agree with the climate labels`);
  }
});

test('generated broadleaf trees and cacti never occupy snowy ground', () => {
  let broadleaf = 0, conifer = 0, cactus = 0, rainforest = 0;
  for (const seed of [1337, 7331, 20077]) {
    const world = new World(seed);
    for (const [x, z] of [[3670, -2494], [600, 1650], [3100, 3900], [-2000, -3000], [1000, -6000], [-3000, 1000]]) {
      for (const plant of world.collectVegetation(x - 192, x + 192, z - 192, z + 192)) {
        if (plant.kind === VEGETATION_KIND.CONIFER) { conifer++; continue; }
        if (plant.kind === VEGETATION_KIND.BROADLEAF) broadleaf++; else cactus++;
        if (plant.rainforest) rainforest++;
        const col = world.column(plant.x, plant.z);
        assert.equal(snowCover(col, plant.y), 0, `seed ${seed}: warm-climate plant on snow at ${plant.x},${plant.z}`);
      }
    }
  }
  assert.ok(broadleaf > 100 && rainforest > 100 && conifer > 20 && cactus > 10,
    `all climates exercised: ${JSON.stringify({ broadleaf, conifer, cactus, rainforest })}`);
});
