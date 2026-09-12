import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, MAT, STRUCTURE_KIND } from '../src/worldgen.js';
import { WORLD } from '../src/constants.js';

const NO_PROPS = {
  sites: [], pads: [], solids: [], cuts: [], boulders: [], vegetation: [],
} as never;

// The hottest volcanic zone on the default seed (found by survey scan).
const ZX = -3936, ZZ = 2464;

test('volcanic highlands: tall, bounded, ash-black, with flat lava pools', () => {
  const w = new World(1337);
  let volcMax = 0, peak = -Infinity, lavaCols = 0, maxSlope = 0, gradedLava = 0;
  let lavaSample: { x: number; z: number } | null = null;
  let basaltSample: { x: number; z: number } | null = null;
  for (let x = ZX - 500; x <= ZX + 500; x += 8) {
    for (let z = ZZ - 500; z <= ZZ + 500; z += 8) {
      const col = w.column(x, z);
      if (col.volc > volcMax) volcMax = col.volc;
      if (col.h > peak) peak = col.h;
      if (col.lavaY > -999) {
        lavaCols++;
        if (!lavaSample) lavaSample = { x, z };
        // An explicit liquid surface covers a real basin, leaving enough
        // depth to immerse the player while lower caves remain dry.
        assert.ok(col.h < col.lavaY && col.lavaY - col.h < 24, 'lava has a bounded solid bed');
        if (col.road && col.road.gradeWeight > 0) {
          gradedLava++;
          assert.equal(w.material(x, col.lavaY, z, col, 1, NO_PROPS), MAT.LAVA,
            'road grading must preserve a visible lava surface wherever contact is hazardous');
        }
      } else if (col.volc > 0.6 && !basaltSample) {
        basaltSample = { x, z };
      }
      const hx = w.column(x + 2, z).h - w.column(x - 2, z).h;
      const hz = w.column(x, z + 2).h - w.column(x, z - 2).h;
      maxSlope = Math.max(maxSlope, Math.hypot(hx, hz) / 4);
    }
  }
  assert.ok(volcMax > 0.9, `zone must be a full volcanic province (${volcMax})`);
  assert.ok(peak > 110, `volcanic terrain towers (peak ${peak.toFixed(1)})`);
  assert.ok(peak < WORLD.MAX_HEIGHT - 20, 'asymptotic clamp holds under the sky guarantee');
  assert.ok(lavaCols > 300, `the province has real lava fields (${lavaCols} cols)`);
  assert.ok(gradedLava > 10, 'survey exercises road shoulders reshaping real lava basins');
  // Steep cliffs are the point, but the field-march envelope (slope < 1.96)
  // and near-walkability must survive.
  assert.ok(maxSlope < 1.96, `slope ${maxSlope.toFixed(2)} busts the ray-march envelope`);

  assert.ok(lavaSample && basaltSample, 'both surface kinds sampled');
  const lc = w.column(lavaSample.x, lavaSample.z);
  assert.equal(
    w.material(lavaSample.x, lc.lavaY, lavaSample.z, lc, 1, NO_PROPS), MAT.LAVA,
    'pool surfaces read as lava',
  );
  const bc = w.column(basaltSample.x, basaltSample.z);
  assert.equal(
    w.material(basaltSample.x, bc.h, basaltSample.z, bc, 1, NO_PROPS), MAT.BASALT,
    'volcanic ground reads as basalt (never snow, sand, or grass)',
  );
});

test('the megapyramid rises in the volcanic province with real interiors', () => {
  const w = new World(1337);
  const region = w.collectStructures(-4096, 4096, -4096, 4096);
  const pyramids = region.sites.filter(
    (s) => s.kind === STRUCTURE_KIND.MEGAPYRAMID,
  );
  assert.ok(pyramids.length >= 1, 'seed 1337 generates at least one colossus');
  for (const site of pyramids) {
    assert.ok(Math.max(Math.abs(site.x), Math.abs(site.z)) < WORLD.BORDER - 150,
      'colossus stands inside the playable border');
    const col = w.column(site.x, site.z);
    assert.ok(col.volc > 0.4, 'colossus stands on volcanic ground');
    const t = site.top;
    // Grand hall: air across two tiers, under a solid core.
    assert.ok(w.sdf(site.x, t + 8, site.z) > 0.4, 'grand hall is open air');
    assert.ok(w.sdf(site.x, t + 15, site.z) > 0.4, 'hall is two tiers tall');
    assert.ok(w.sdf(site.x + 30, t + 4, site.z + 30) < 0,
      'tier walls are solid');
    // Gates: walkable air just inside each face's doorway.
    for (const [dx, dz] of [[0, 39], [0, -39], [39, 0], [-39, 0]] as const) {
      assert.ok(w.sdf(site.x + dx, t + 1.2, site.z + dz) > 0.2,
        `gate at ${dx},${dz} is open`);
    }
    // Shaft + summit chamber above the hall ceiling.
    assert.ok(w.sdf(site.x, t + 40, site.z) > 0.2, 'core shaft is open');
    assert.ok(w.sdf(site.x, t + 63, site.z) > 0.4, 'summit chamber is open');
    assert.ok(w.sdf(site.x, t + 80, site.z) < 0, 'capstone above is solid');
    assert.ok(t + 86 < WORLD.MAX_HEIGHT - 1,
      'the colossus stays under the sky guarantee');
  }
});

test('players never spawn in the volcanic province', () => {
  const w = new World(1337);
  // findSpawnNear anchored inside the zone must refuse to place anyone
  // on basalt or lava even when the search is centered there.
  let rejected = true;
  const rng = (() => { let s = 1; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
  const spawn = w.findSpawnNear(ZX, ZZ, rng, 10, 200);
  if (spawn) {
    const col = w.column(spawn.x, spawn.z);
    rejected = col.volc <= 0.35 && col.lavaY <= -999;
  }
  assert.ok(rejected, 'spawn search must never land inside the province');
});
