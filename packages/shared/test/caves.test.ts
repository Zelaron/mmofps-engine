import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, cavePathPoint } from '@shared/worldgen';
import { createMoveState, stepMove, BTN } from '@shared/movement';
import { capsuleClearance, capsuleHasGroundSupport } from '@shared/physics';
import { TICK_DT } from '@shared/constants';
import { caveBiomeAt, caveBiomeColor, sampleCaveFloorLayers } from '../src/caves.js';

test('gallery grades retain solid support and headroom across local hillside hollows', () => {
  const empty = { sites: [], pads: [], solids: [], cuts: [], boulders: [], vegetation: [] };
  let checked = 0;
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed);
    for (const site of world.collectCaveSites(-3200, 3200, -3200, 3200)) {
      for (let forward = 0; forward <= site.length; forward += 3) {
        const p = cavePathPoint(site, forward), col = world.column(p.x, p.z);
        assert.ok(world.sdfCol(p.x, p.y - 0.1, p.z, col, empty) < 0,
          `seed ${seed} unsupported grade at ${p.x},${p.z}`);
        assert.ok(world.sdfCol(p.x, p.y + 1.8, p.z, col, empty) >= 0.1,
          `seed ${seed} low gallery ceiling at ${p.x},${p.z}`);
        checked++;
      }
    }
  }
  assert.ok(checked > 15000, 'cover hundreds of caves, including rare local hollows');
});

test('generated cave galleries can be walked down and back to daylight without jumping', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed);
    const sites = world.collectCaveSites(-640, 640, -640, 640);
    assert.ok(sites.length >= 4);
    for (const site of [sites[0], sites[2], sites[sites.length - 2], sites[sites.length - 1]]) {
      const start = cavePathPoint(site, 0);
      const state = createMoveState(start.x, start.y + 0.1, start.z);
      let groundedTicks = 0;
      for (const direction of [1, -1]) {
        const destination = direction === 1 ? site.length : 0;
        let arrived = false;
        for (let tick = 0; tick < 900; tick++) {
          const forward = (state.px - site.x) * site.dx + (state.pz - site.z) * site.dz;
          const target = cavePathPoint(site, Math.max(0, Math.min(site.length, forward + direction * 3)));
          const yaw = Math.atan2(-(target.x - state.px), -(target.z - state.pz));
          const move = stepMove(world, state, {
            seq: tick, buttons: BTN.FORWARD, weapon: 0, yaw, pitch: 0, renderTick: 0, renderFrac: 0,
          }, TICK_DT);
          assert.equal(move.jumped, false);
          if (state.grounded) groundedTicks++;
          if (tick % 15 === 0) {
            assert.ok(capsuleClearance(world, state.px, state.py, state.pz) > -0.01,
              `seed ${seed} capsule overlap at gallery ${forward.toFixed(2)}`);
            if (state.grounded) assert.ok(capsuleHasGroundSupport(world, state.px, state.py, state.pz));
            const expected = cavePathPoint(site, forward);
            assert.ok(Math.abs(state.py - expected.y) < 0.5,
              `seed ${seed} gallery floor discontinuity ${state.py - expected.y} at ${forward}`);
          }
          if (Math.abs(forward - destination) < 0.5) { arrived = true; break; }
        }
        assert.ok(arrived, `seed ${seed} stuck walking ${direction > 0 ? 'in' : 'out'} at ${state.px},${state.py},${state.pz}; site ${site.x},${site.z}`);
        assert.equal(world.roofedAbove(state.px, state.py + 1.6, state.pz), direction === 1,
          'chamber must be roofed and exterior must show real daylight');
      }
      assert.ok(groundedTicks > 100, 'walk test must exercise grounded movement');
    }
  }
});

test('site lookup and cave shapes are deterministic and continuous across cell edges', () => {
  const a = new World(1337), b = new World(1337);
  const sites = a.collectCaveSites(-960, 960, -960, 960);
  assert.deepEqual(sites, b.collectCaveSites(-960, 960, -960, 960));
  for (let edge = -640; edge <= 640; edge += 320) {
    for (let offset = -640; offset <= 640; offset += 23) {
      for (const [x, z] of [[edge, offset], [offset, edge]]) {
        const h = a.terrainHeight(x, z);
        for (const y of [h - 30, h - 8, h]) {
          assert.ok(Math.abs(a.sdf(x - 0.001, y, z) - a.sdf(x + 0.001, y, z)) < 0.05);
          assert.ok(Math.abs(a.sdf(x, y, z - 0.001) - a.sdf(x, y, z + 0.001)) < 0.05);
        }
      }
    }
  }
});

test('deep chambers contain substantial bedrock ribs without lowering the cave floor', () => {
  const world = new World(1337);
  const empty = { sites: [], pads: [], solids: [], cuts: [], boulders: [], vegetation: [] };
  let ribs = 0;
  for (let iz = -5; iz <= 5; iz++) {
    for (let ix = -5; ix <= 5; ix++) {
      for (const offset of [-8, 0, 8]) {
        const x = (ix + 0.5) * 96 + offset, z = (iz + 0.5) * 96;
        const col = world.column(x, z);
        if (col.deepRock === undefined || col.deepRock > -1.5 || col.cave) continue;
        const undecorated = { ...col, deepRock: undefined };
        for (const y of [-24, -12, 0]) {
          if (y >= col.h - 10 || world.sdfCol(x, y, z, undecorated, empty) < 0.5) continue;
          assert.ok(world.sdfCol(x, y, z, col, empty) < 0, 'bedrock rib must be real collidable terrain');
          assert.ok(world.sdfCol(x, -46, z, col, empty) < 0, 'rib may not open the lower cave boundary');
          ribs++;
        }
      }
    }
  }
  assert.ok(ribs >= 15, 'deep networks need large visible formations in many independent rooms');
});

test('through-caves join distinct entrances on a level chamber and can be crossed without jumping', () => {
  let through = 0, singles = 0;
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed);
    const sites = world.collectCaveSites(-960, 960, -960, 960);
    const pairs = sites.filter(site => site.exit);
    through += pairs.length;
    singles += sites.filter(site => !site.levelChamber).length;
    assert.ok(pairs.length >= 8, `seed ${seed} must offer frequent alternate physical exits`);
    for (const site of [pairs[0], pairs[Math.floor(pairs.length / 2)], pairs[pairs.length - 1]]) {
      const exit = site.exit!;
      const center = cavePathPoint(site, site.length), otherCenter = cavePathPoint(exit, exit.length);
      assert.ok(Math.hypot(center.x - otherCenter.x, center.y - otherCenter.y, center.z - otherCenter.z) < 0.0001);
      assert.ok(Math.hypot(site.x - exit.x, site.z - exit.z) > 90, 'alternate entrances face separate hillsides');
      const start = cavePathPoint(site, 0), state = createMoveState(start.x, start.y + 0.1, start.z);
      for (const [route, direction] of [[site, 1], [exit, -1], [exit, 1], [site, -1]] as const) {
        let arrived = false;
        for (let tick = 0; tick < 900; tick++) {
          const forward = (state.px - route.x) * route.dx + (state.pz - route.z) * route.dz;
          const point = cavePathPoint(route, Math.max(0, Math.min(route.length, forward + direction * 3)));
          const yaw = Math.atan2(-(point.x - state.px), -(point.z - state.pz));
          const result = stepMove(world, state, { seq: tick, buttons: BTN.FORWARD, weapon: 0,
            yaw, pitch: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
          assert.equal(result.jumped, false);
          assert.ok(state.py > center.y - 0.6, 'the shared junction cannot drop into a deeper noise cavity');
          if (Math.abs(forward - (direction > 0 ? route.length : 0)) < 0.5) { arrived = true; break; }
        }
        assert.ok(arrived, `seed ${seed}: could not traverse ${direction > 0 ? 'into' : 'out of'} alternate gallery`);
        assert.equal(world.roofedAbove(state.px, state.py + 1.6, state.pz), direction > 0);
      }
    }
  }
  assert.ok(through > singles / 2, 'through-caves should be a common discovery, not a rare exception');
});

test('cave geology varies by seeded province with smooth color across province boundaries', () => {
  const biomes = new Set<number>(), a = [0, 0, 0], b = [0, 0, 0];
  for (const seed of [1, 1337, 424242]) {
    for (let x = -2048; x <= 2048; x += 512) {
      for (let z = -2048; z <= 2048; z += 173) {
        biomes.add(caveBiomeAt(seed, x, z));
        caveBiomeColor(seed, x - 0.001, z, a); caveBiomeColor(seed, x + 0.001, z, b);
        for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 0.00001);
        caveBiomeColor(seed, z, x - 0.001, a); caveBiomeColor(seed, z, x + 0.001, b);
        for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 0.00001);
      }
    }
  }
  assert.equal(biomes.size, 4);
});

test('deep floor sampling discovers lower landing levels and rejects unsupported pad ledges', () => {
  const column = new World(1).column(0, 0);
  let calls = 0;
  const field = (x: number, y: number) => {
    calls++;
    const topFloor = Math.abs(x) > 1 ? -24 : -20;
    return Math.max(Math.min(y - topFloor, -16 - y), Math.min(y + 31, -25 - y), Math.min(y + 43, -36 - y));
  };
  const world = { column: () => ({ ...column, h: 20 }), sdf: field, roofedAbove: () => true };
  const spots = sampleCaveFloorLayers(world, 0, 0);
  assert.deepEqual(spots.map(p => Math.round(p.y)), [-31, -43],
    'the narrow upper ledge cannot hide supported lower return-pad landings');
  assert.ok(calls < 150, 'a single column has a fixed small vertical probe budget');
  assert.equal(sampleCaveFloorLayers(world, 0, 0, 1).length, 1);
  assert.deepEqual(sampleCaveFloorLayers(world, Infinity, 0), []);
});

test('sampled cave landing pads support a standing capsule across independent worlds', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed);
    let checked = 0;
    for (let i = 0; i < 48 && checked < 8; i++) {
      const x = (i % 8) * 53 - 190, z = Math.floor(i / 8) * 77 - 160;
      for (const spot of sampleCaveFloorLayers(world, x, z)) {
        const state = createMoveState(spot.x, spot.y + 0.05, spot.z);
        for (let tick = 0; tick < 45; tick++) stepMove(world, state, { seq: tick, buttons: 0, weapon: 0,
          yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
        assert.ok(state.grounded, 'return-pad arrivals must settle onto solid cave floor');
        assert.ok(Math.abs(state.py - spot.y) < 0.3, 'arrival cannot drop into another cave level');
        assert.ok(capsuleClearance(world, state.px, state.py, state.pz) > -0.01);
        checked++;
      }
    }
    assert.ok(checked >= 8, `seed ${seed} needs usable deep landings near ordinary travel`);
  }
});
