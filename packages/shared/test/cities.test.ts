import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, STRUCTURE_KIND } from '@shared/worldgen';
import { buildCityBlock, cityParcelKind, cityLiftSites, cityRewardSites, capitalPlan } from '@shared/cities';
import { CAPITAL_SKY_HEIGHT } from '@shared/capital-geometry';
import { cityLifePlan } from '@shared/city-life';
import { capsuleClearance } from '@shared/physics';
import { createMoveState, stepMove, BTN } from '@shared/movement';
import { TICK_DT, WORLD } from '@shared/constants';

test('two themed capitals stay separated, bounded and physically navigable across seeds', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed), all = world.collectCities();
    assert.deepEqual(all.filter(c => c.theme).map(c => c.theme).sort(), ['aurelia', 'vesper']);
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++)
      assert.ok(Math.hypot(all[i].x - all[j].x, all[i].z - all[j].z) > 3000, 'cities need wilderness between them');
    for (const city of all.filter(c => c.theme)) {
      const plan = capitalPlan(city)!;
      const canonical = new Set([...plan.solids, ...cityLifePlan(city).solids]);
      assert.ok(city.radius >= 1600 && (city.radius / 384) ** 2 >= 15);
      assert.ok(plan.solids.length < 4000 && plan.sweeps.length < 1600);
      let count = 0, tallest = 0;
      for (let ix = Math.floor((city.x - city.radius) / 256); ix < Math.ceil((city.x + city.radius) / 256); ix++)
        for (let iz = Math.floor((city.z - city.radius) / 256); iz < Math.ceil((city.z + city.radius) / 256); iz++) {
          const block = buildCityBlock(city, ix, iz);
          if (!block) continue;
          assert.ok(block.solids.length < 700);
          count += block.solids.length;
          for (const box of block.solids) {
            assert.ok(box.x - box.hx <= (ix + 1) * 256 && box.x + box.hx >= ix * 256);
            assert.ok(box.z - box.hz <= (iz + 1) * 256 && box.z + box.hz >= iz * 256);
            assert.ok(canonical.has(box), 'capital cells must retain full canonical skyline/venue boxes without internal zero seams');
            assert.ok(Math.min(box.hx, box.hy, box.hz) > 0);
            assert.ok(box.y + box.hy < CAPITAL_SKY_HEIGHT);
            tallest = Math.max(tallest, box.y + box.hy - city.y);
          }
        }
      tallest = Math.max(tallest, ...plan.sweeps.flatMap(s => s.points.map(p => p.y + p.radius - city.y)));
      assert.ok(count > 300 && count < 8000 && tallest > 600 && tallest < CAPITAL_SKY_HEIGHT);
      assert.ok(Math.max(Math.abs(city.x), Math.abs(city.z)) + city.radius < WORLD.BORDER);
      for (const lift of cityLiftSites(city)) for (let y = lift.bottom; y <= lift.top; y += .75)
        assert.ok(capsuleClearance(world, lift.x, y + .006, lift.z) > -.01, 'lift shaft must stay open');
      for (const reward of cityRewardSites(city)) for (const dx of [0, 1.7]) {
        assert.ok(capsuleClearance(world, reward.x + dx, reward.y + .006, reward.z) >= -.01);
        assert.ok(world.sdf(reward.x + dx, reward.y - .08, reward.z) < 0);
      }
    }
  }
});

test('ordinary cities retain bounded districts with plazas, arcades and varied skylines', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed), all = world.collectCities(), cities = all.filter(c => !c.theme);
    assert.equal(all.length, 4);
    assert.equal(cities.length, 2);
    assert.deepEqual(all, new World(seed).collectCities());
    assert.ok(Math.hypot(cities[0].x - cities[1].x, cities[0].z - cities[1].z) > 4000);
    for (const city of cities) {
      let solids = 0, upper = 0, maxHeight = 0, area = 0;
      const heights = new Set<number>();
      for (let ix = Math.floor((city.x - city.radius) / 256); ix < Math.ceil((city.x + city.radius) / 256); ix++) for (let iz = Math.floor((city.z - city.radius) / 256); iz < Math.ceil((city.z + city.radius) / 256); iz++) {
        const block = buildCityBlock(city, ix, iz)!;
        assert.equal(block.site.kind, STRUCTURE_KIND.CITY_BLOCK);
        assert.deepEqual(block, buildCityBlock(city, ix, iz));
        assert.ok(block.solids.length <= 380, 'district exceeds staircase collision budget');
        solids += block.solids.length;
        area += block.pad.hx * block.pad.hz * 4;
        for (const box of block.solids) {
          assert.ok(box.x - box.hx >= ix * 256 && box.x + box.hx <= (ix + 1) * 256);
          assert.ok(box.z - box.hz >= iz * 256 && box.z + box.hz <= (iz + 1) * 256);
          assert.ok(Math.min(box.hx, box.hy, box.hz) >= .19);
          maxHeight = Math.max(maxHeight, box.y + box.hy - city.y);
          if (box.facade! < 4 && box.hy > 4) { upper++; heights.add(Math.round(box.y + box.hy - city.y)); }
        }
        for (const sx of [-1, 0, 1]) for (const sz of [-1, 0, 1]) {
          const x = block.pad.x + sx * block.pad.hx, z = block.pad.z + sz * block.pad.hz;
          assert.ok(Math.abs(world.column(x, z).h - city.y) < .00001, 'a hill trail lifts the clipped city boundary');
        }
      }
      assert.equal(area, 768 ** 2, 'clipped boundary cells overlap or leave gaps');
      assert.ok(solids > 900 && solids < 2400);
      assert.ok(upper >= 30 && heights.size >= 8 && maxHeight > 90 && city.y + maxHeight < WORLD.MAX_HEIGHT);
      const neighborhoods = new Map<string, number>();
      for (let bx = -6; bx < 6; bx++) for (let bz = -6; bz < 6; bz++) {
        const kind = cityParcelKind(city, bx, bz);
        neighborhoods.set(kind, (neighborhoods.get(kind) ?? 0) + 1);
      }
      for (const kind of ['terrace', 'warehouse', 'civic', 'market', 'roof', 'park']) assert.ok(neighborhoods.get(kind)! >= 4, `missing ${kind} district`);
      for (let p = -378; p <= 378; p += 4) for (const lateral of [-3, 0, 3]) {
        for (const [x, z] of [[city.x + p, city.z + lateral], [city.x + lateral, city.z + p]]) {
          assert.ok(capsuleClearance(world, x, city.y + .075, z) >= 0, `city avenue obstructed at${x},${z}`);
          // Walkable bridge decks are valid upper ground too; check the
          // street's own support from below the elevated promenade.
          const street = world.trace(x, city.y + 2, z, 0, -1, 0, 4);
          assert.ok(street.hit && Math.abs(street.y - city.y - .06) < .03);
        }
      }
      const roads = world.collectRoadSegments(city.x - 650, city.x + 650, city.z - 650, city.z + 650);
      const accesses = roads.filter(road => road.id === `city-access:${city.id}`);
      assert.equal(accesses.length, 4);
      for (const road of accesses) {
        const dx = road.b.x - road.a.x, dz = road.b.z - road.a.z, length = Math.hypot(dx, dz);
        assert.ok(roads.some(other => !other.trail && !other.id.startsWith('city') &&
          [other.a, other.b].some(p => Math.hypot(p.x - road.b.x, p.z - road.b.z) < .001)), 'city access lost the existing trunk network');
        for (let t = .02; t < 1; t += .04) {
          const x = road.a.x + dx * t, z = road.a.z + dz * t;
          const grade = Math.abs(world.terrainHeight(x + dx / length, z + dz / length) -
            world.terrainHeight(x - dx / length, z - dz / length)) * .5;
          assert.ok(grade < .7, `city access is too steep: ${grade}`);
        }
      }
      // A real high-rise lobby can be crossed in either direction, while
      // upper floors and door wings remain authoritative cover.
      const x = city.x + 96, z = city.z - 32;
      for (let p = -28; p <= 28; p += 1) {
        assert.ok(capsuleClearance(world, x + p, city.y + .075, z) >= 0);
        assert.ok(capsuleClearance(world, x, city.y + .075, z + p) >= 0);
      }
      assert.ok(world.sdf(x, city.y + 9, z) < 0);
      const inside = (p: {x:number;z:number}) => Math.max(Math.abs(p.x - city.x), Math.abs(p.z - city.z)) < 378;
      assert.equal(world.collectBoulders(city.x - 378, city.x + 378, city.z - 378, city.z + 378).filter(inside).length, 0);
      assert.equal(world.collectVegetation(city.x - 378, city.x + 378, city.z - 378, city.z + 378).filter(inside).length, 0);
    }
  }
});

test('rare summits reach250m and keep every cliff inside the field-march envelope', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed);
    const mountains = world.collectMountains(-6144, 7168, -6144, 6144).filter(m => m.dramatic);
    assert.equal(mountains.length, 4);
    for (const m of mountains) {
      assert.ok(world.column(m.x, m.z).h >= 250 && world.column(m.x, m.z).h < 275);
      let steepest = 0;
      for (let z = Math.floor(m.z / 32) * 32 - 480; z < m.z + 480; z += 16) {
        for (let x = Math.floor(m.x / 32) * 32 - 480; x < m.x + 480; x += 16) {
          const slope = Math.hypot(world.terrainHeight(x + .5, z) - world.terrainHeight(x - .5, z),
            world.terrainHeight(x, z + .5) - world.terrainHeight(x, z - .5));
          steepest = Math.max(steepest, slope);
        }
      }
      assert.ok(steepest > 1.5 && steepest < 2.8, `seed${seed} summit${m.ix},${m.iz} slope${steepest}`);
    }
  }
});

test('city roof stairs connect the ground to a supported playable rooftop', () => {
  const world = new World(1337), city = world.collectCities()[0];
  const blocks = buildCityBlock(city, city.x / 256 - 1, city.z / 256 - 1)!;
  const first = blocks.solids.find(box => box.hx === 1.3 && box.hy === .19)!;
  assert.ok(first, 'missing accessible low rooftop');
  const state = createMoveState(first.x, city.y + .08, first.z + 3);
  const targets = [[first.x, first.z - 8.25], [first.x - 6, first.z - 8.25]];
  let waypoint = 0;
  for (let tick = 0; tick < 600 && waypoint < targets.length; tick++) {
    const [x, z] = targets[waypoint];
    if (Math.hypot(x - state.px, z - state.pz) < .25) { waypoint++; continue; }
    stepMove(world, state, { seq: tick, buttons: BTN.FORWARD, yaw: Math.atan2(-(x - state.px), -(z - state.pz)),
      pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
  }
  assert.equal(waypoint, targets.length, 'roof stair or landing is obstructed');
  assert.ok(Math.abs(state.py - city.y - 4.26) < .12);
  assert.ok(capsuleClearance(world, state.px, state.py, state.pz) > -.02);
});

test('players walk rare mountain switchbacks continuously from trunk to summit', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed);
    const m = world.collectMountains(-2048, 1023, -2048, 1023).find(m => m.dramatic)!;
    const roads = world.collectRoadSegments(m.x - 600, m.x + 600, m.z - 600, m.z + 600);
    const trail = roads.filter(r => r.id === `trail:${m.ix},${m.iz}`);
    assert.equal(trail.length, 122, 'short chords round all eleven hairpins');
    assert.ok(roads.some(r => !r.trail && Math.hypot(r.b.x - trail[0].a.x, r.b.z - trail[0].a.z) < .001));
    const state = createMoveState(trail[0].a.x, trail[0].a.y + .1, trail[0].a.z);
    let waypoint = 0;
    for (let tick = 0; tick < 22000 && waypoint < trail.length; tick++) {
      const target = trail[waypoint].b;
      if (Math.hypot(target.x - state.px, target.z - state.pz) < 1.6) { waypoint++; continue; }
      const yaw = Math.atan2(-(target.x - state.px), -(target.z - state.pz));
      stepMove(world, state, { seq: tick, buttons: BTN.FORWARD, yaw, pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
      if (tick % 60 === 0) assert.ok(capsuleClearance(world, state.px, state.py, state.pz) > -.025);
    }
    assert.equal(waypoint, trail.length, `seed${seed} stuck on leg${waypoint} at${state.px},${state.py},${state.pz}`);
    assert.ok(state.py >= 248);
  }
});
