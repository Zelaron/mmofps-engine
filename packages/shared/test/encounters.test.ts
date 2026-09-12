import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/worldgen.js';
import { WORLD } from '../src/constants.js';
import { TICK_DT } from '../src/constants.js';
import { BTN, createMoveState, stepMove } from '../src/movement.js';
import { capsuleClearance, capsuleHasGroundSupport } from '../src/physics.js';
import { generateTeleporters, type TeleporterPad } from '../src/teleporters.js';
import {
  ENCOUNTER_CACHE_LIMIT, ENCOUNTER_REGION_SIZE, EncounterField,
  generateEncounterRegion, type EncounterRegion,
  findRescueSurfaceTarget,
} from '../src/encounters.js';

function generate(world: World, cx: number, cz: number, avoid: readonly TeleporterPad[] = []): EncounterRegion {
  const iterator = generateEncounterRegion(world, cx, cz, avoid);
  for (let steps = 0; steps < 1000; steps++) {
    const result = iterator.next();
    if (result.done) return result.value;
  }
  throw new Error(`district ${cx},${cz} exceeded its bounded candidate search`);
}

function checkLinks(pads: readonly TeleporterPad[]): void {
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i], destination = pads[pad.partner];
    assert.ok(destination, `missing destination for pad ${i}`);
    assert.notEqual(pad.partner, i);
    if (pad.cave) assert.equal(destination.cave, false, 'an underground return always leads to daylight');
  }
}

test('seed1337 districts near spawn and far across the larger world have useful local encounters', () => {
  const world = new World(1337);
  const base = generateTeleporters(world);
  for (const [cx, cz] of [[0, 0], [5, 5], [-6, 4], [3, -5]]) {
    const region = generate(world, cx, cz, base);
    assert.ok(region.pois.length >= 24, `${region.key}: frequent discoveries throughout cave travel`);
    assert.ok(region.pads.filter(p => p.cave).length === region.pois.length, `${region.key}: every discovery has a return`);
    assert.ok(region.loot.length >= region.pois.length, `${region.key}: every discovery has a reward`);
    checkLinks(region.pads);
    const surface = region.pads.filter(p => !p.cave);
    assert.equal(surface.length, 2, 'two surface anchors replace the previous eight');
    assert.ok(Math.hypot(surface[0].x - surface[1].x, surface[0].z - surface[1].z) >= 360);
    for (const pad of region.pads) {
      assert.ok(Math.abs(pad.x) < WORLD.BORDER - 50 && Math.abs(pad.z) < WORLD.BORDER - 50);
      assert.equal(world.roofedAbove(pad.x, pad.y + 1.6, pad.z), pad.cave);
      assert.ok(capsuleClearance(world, pad.x, pad.y + .06, pad.z) > -.025,
        `${region.key}: pad ${pad.x},${pad.y},${pad.z} must fit an arriving player`);
      assert.ok(capsuleHasGroundSupport(world, pad.x, pad.y + .06, pad.z), 'arrivals need real floor support');
    }
    for (const loot of region.loot) {
      assert.equal(world.roofedAbove(loot.x, loot.y + 1.6, loot.z), loot.cave);
      assert.ok(loot.cave ? [5, 6, 9].includes(loot.weapon) : [7, 8].includes(loot.weapon), 'rare cave weapons never appear as surface loot');
      assert.ok(world.sdf(loot.x, loot.y + 1.2, loot.z) > .75);
      assert.ok(world.sdf(loot.x, loot.y - .1, loot.z) < .05, 'loot should rest on the chamber floor');
    }
  }
});

/** Two real signed-distance slabs at the same XZ reproduce stacked cave
 * floors without searching thousands of terrain columns in a cache test. */
function layeredWorld(): { world: World; samples: { sites: number; columns: number } } {
  const samples = { sites: 0, columns: 0 };
  const sdf = (_x: number, y: number, _z: number): number => Math.max(
    y - 24, Math.min(y + 23, -16 - y), Math.min(y + 37, -30 - y),
  );
  const world = {
    seed: 1337,
    collectCaveSites() { samples.sites++; return []; },
    column() { samples.columns++; return { h: 24, entr: 0, volc: 0, lavaY: -1000 }; },
    groundY() { return 24; },
    roofedAbove(_x: number, y: number, _z: number) { return y < 24; },
    sdf,
    trace(x: number, y: number, z: number, dx: number, dy: number, dz: number, distance: number) {
      if (dy === 0) return { hit: false, x: x + dx * distance, y, z: z + dz * distance, nx: 0, ny: 0, nz: 0, dist: distance };
      const floor = [24, -23, -37].find(height => height < y && y - height <= distance);
      return { hit: floor !== undefined, x, y: floor ?? y - distance, z, nx: 0, ny: 1, nz: 0, dist: floor === undefined ? distance : y - floor };
    },
  } as unknown as World;
  return { world, samples };
}

test('district generation includes lower cave floors at the same XZ with independent daylight exits', () => {
  const { world } = layeredWorld();
  const region = generate(world, 0, 0), caves = region.pads.filter(p => p.cave);
  assert.equal(caves.length, 48);
  const columns = new Map<string, TeleporterPad[]>();
  for (const pad of caves) {
    const key = `${pad.x},${pad.z}`, column = columns.get(key) ?? [];
    column.push(pad); columns.set(key, column);
    assert.ok(world.sdf(pad.x, pad.y + 1.2, pad.z) > 1.05);
    assert.ok(world.sdf(pad.x, pad.y - .65, pad.z) < 0);
  }
  assert.ok(columns.size >= 36, 'discoveries cover the district instead of clustering near one entry');
  assert.ok(caves.filter(p => p.y < -30).length >= 12, 'lower landings receive substantial independent exits');
  assert.ok(caves.filter(p => p.y > -30).length >= 12, 'upper passages retain nearby exits too');
  checkLinks(region.pads);
  assert.equal(region.pois.length, 48);
  assert.equal(region.pads.filter(p => !p.cave).length, 2, 'all underground returns share sparse daylight anchors');
  for (const poi of region.pois) {
    assert.ok(Math.abs(poi.loot.y - poi.y) < 0.1);
    assert.ok(Math.hypot(poi.loot.x - poi.x, poi.loot.z - poi.z) >= 6, 'loot lies outside automatic return trigger');
    assert.ok(world.trace(poi.x, poi.y + 1.2, poi.z, (poi.loot.x-poi.x)/7, 0, (poi.loot.z-poi.z)/7, 7).hit === false);
    assert.ok(poi.props.length >= 2, 'a discovery has a visible landmark, not only an unmarked pickup');
  }
});

function finish(field: EncounterField, points: readonly { x: number; z: number }[]): void {
  for (let frame = 0; frame < 5000; frame++) {
    field.update(points, Infinity, 32);
    assert.ok(field.stats.cached <= ENCOUNTER_CACHE_LIMIT);
    assert.ok(field.stats.wanted <= ENCOUNTER_CACHE_LIMIT);
    if (field.regions.length === field.stats.wanted && field.stats.pending === null) return;
  }
  throw new Error('encounter field did not finish within its bounded search');
}

test('EncounterField respects step budgets, cancels stale work, and offsets paired indices around base pads', () => {
  const { world, samples } = layeredWorld();
  const base: TeleporterPad[] = [
    { x: 0, y: 24, z: 0, cave: false, partner: 1 },
    { x: 200, y: 24, z: 0, cave: false, partner: 0 },
  ];
  const field = new EncounterField(world, base);
  field.update([{ x: 20, z: 20 }], Infinity, 0);
  assert.equal(samples.sites, 0);
  assert.equal(field.stats.wanted, 9);
  field.update([{ x: 20, z: 20 }], Infinity, 3);
  assert.ok(samples.columns > 0 && samples.columns <= 15, 'three generator advances bound their surface footprint probes');
  const before = samples.columns + samples.sites;
  field.update([{ x: 20, z: 20 }], 0, 100);
  assert.ok(samples.columns + samples.sites - before <= 5, 'an expired time budget stops after its first candidate');
  const edge = WORLD.BORDER - 200, district = Math.floor(edge / ENCOUNTER_REGION_SIZE);
  field.update([{ x: edge, z: edge }], Infinity, 1);
  assert.equal(field.stats.pending, `${district},${district}`, 'obsolete district work must be discarded after a long trip');
  assert.ok(field.regions.every(region => region.key !== '0,0'));
  finish(field, [{ x: edge, z: edge }]);
  assert.equal(field.stats.wanted, 4, 'world-corner selection is clipped to valid districts');
  assert.deepEqual(field.pads.slice(0, 2), base);
  checkLinks(field.pads);
  const revision = field.revision;
  assert.equal(field.update([{ x: edge + 10, z: edge + 10 }], Infinity, 32), false);
  assert.equal(field.revision, revision, 'staying in a completed selection cannot rebuild pad arrays every frame');
});

test('EncounterField caps residency across many players and deterministic revisits survive eviction', () => {
  const { world } = layeredWorld(), field = new EncounterField(world);
  const origin = [{ x: 12, z: 12 }];
  finish(field, origin);
  const expected = structuredClone(field.regions.find(r => r.key === '0,0'));
  assert.ok(expected);
  const dispersed: { x: number; z: number }[] = [];
  for (let z = -8; z < 8; z++) for (let x = -8; x < 8; x++) dispersed.push({ x: x * 1024 + 512, z: z * 1024 + 512 });
  finish(field, dispersed);
  assert.equal(field.stats.cached, ENCOUNTER_CACHE_LIMIT);
  assert.equal(field.stats.wanted, ENCOUNTER_CACHE_LIMIT);
  assert.equal(field.regions.some(region => region.key === '0,0'), false,
    '96 completed desired regions must evict the old origin district before its revisit');
  checkLinks(field.pads);
  finish(field, origin);
  assert.deepEqual(field.regions.find(r => r.key === '0,0'), expected);
  checkLinks(field.pads);
  assert.equal(field.regions.length, 9);
});

test('independent client/server generation produces identical remote destinations despite different schedules', () => {
  const a = new World(1337), b = new World(1337);
  const expected = generate(a, 5, 5);
  const field = new EncounterField(b);
  for (let frame = 0; frame < 2000 && !field.regions.some(r => r.key === '5,5'); frame++) {
    field.update([{ x: 5400, z: 5400 }], 0, 1);
  }
  assert.deepEqual(field.regions.find(r => r.key === '5,5'), expected);
  const invalid = generate(a, 8, 8);
  assert.deepEqual(invalid, { key: '8,8', pads: [], loot: [], pois: [] });
});

test('empty or invalid player selections settle without repeated pad rebuilds or candidate work', () => {
  const { world, samples } = layeredWorld(), field = new EncounterField(world);
  field.update([], Infinity, 8);
  const revision = field.revision, pads = field.pads;
  for (let i = 0; i < 30; i++) {
    assert.equal(field.update([{ x: NaN, z: 0 }, { x: 0, z: Infinity }], Infinity, 8), false);
    assert.equal(field.revision, revision);
    assert.equal(field.pads, pads);
  }
  assert.deepEqual(field.stats, { cached: 0, wanted: 0, pending: null });
  assert.equal(samples.sites + samples.columns, 0);
});

test('real discovery rewards can be walked to and back from their return pads without jumping', () => {
  let visited = 0;
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed), region = generate(world, seed === 1337 ? 5 : 0, seed === 1337 ? 5 : 0);
    assert.ok(region.pois.length >= 20);
    for (const poi of region.pois.filter((_, index) => index % 8 === 0)) {
      const state = createMoveState(poi.returnPad.x, poi.returnPad.y + 0.1, poi.returnPad.z);
      for (const target of [poi.loot, poi.returnPad]) {
        let arrived = false;
        for (let tick = 0; tick < 180; tick++) {
          const distance = Math.hypot(target.x - state.px, target.z - state.pz);
          if (distance < 0.35) { arrived = true; break; }
          const yaw = Math.atan2(-(target.x - state.px), -(target.z - state.pz));
          const move = stepMove(world, state, { seq: tick, buttons: BTN.FORWARD, weapon: 0, yaw,
            pitch: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
          assert.equal(move.jumped, false);
          assert.ok(Math.abs(state.py - target.y) < 3, 'a reward route must not lead over a hidden drop');
        }
        assert.ok(arrived, `seed ${seed} discovery ${poi.id} must have a traversable reward/return lane`);
      }
      assert.ok(poi.props.every(prop => world.sdf(prop.x, prop.y - 0.05, prop.z) <= 0), 'landmarks have actual floor roots');
      const rescue = findRescueSurfaceTarget(region.pads, poi.x, poi.z);
      assert.ok(rescue && !world.roofedAbove(rescue.x, rescue.y + 1.6, rescue.z), 'emergency extraction always selects validated daylight');
      visited++;
    }
  }
  assert.ok(visited >= 15);
});
