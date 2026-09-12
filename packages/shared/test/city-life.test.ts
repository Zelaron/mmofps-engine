import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, capsuleClearance, createMoveState, stepMove, BTN, TICK_DT } from '@shared/index';
import { cityLifePlan, cityCivilianPose, type CityVenue } from '@shared/city-life';

function local(v: CityVenue, x: number, z: number) {
  return { x: v.x + x * Math.cos(v.yaw) + z * Math.sin(v.yaw), z: v.z - x * Math.sin(v.yaw) + z * Math.cos(v.yaw) };
}

test('every city has street and elevated rooms with supported entrances, useful rewards, and clear civilian routes', () => {
  const world = new World(1337);
  for (const city of world.collectCities()) {
    const plan = cityLifePlan(city);
    assert.equal(cityLifePlan(city), plan, 'layout uses immutable shared cache');
    assert.ok(plan.venues.length >= 8 && plan.venues.length <= 28);
    assert.ok(new Set(plan.venues.map(v => v.kind)).size >= 6);
    assert.ok(plan.venues.some(v => v.y > city.y + 20));
    assert.equal(plan.civilians.length, plan.venues.length * 6);
    assert.equal(plan.rewards.length, plan.venues.length);
    assert.ok(plan.rewards.filter(r => r.weapon === 3).length >= 2, 'guided rockets and ammo are found in ordinary venues');
    assert.ok(plan.rewards.every(r => ![5, 6, 9].includes(r.weapon ?? -1)), 'cavern exclusives remain underground');
    for (const v of plan.venues) {
      for (let z = v.hz + 6; z >= -v.hz + 2; z--) {
        const p = local(v, 0, z);
        assert.ok(capsuleClearance(world, p.x, v.y + .04, p.z) >= -.01, `${city.name}/${v.id}: doorway ${z}`);
        assert.ok(world.sdf(p.x, v.y - .16, p.z) < 0, `${city.name}/${v.id}: unsupported entrance ${z}`);
      }
      const reward = plan.rewards.find(r => r.id === city.id * 1000 + 500 + plan.venues.indexOf(v))!;
      assert.ok(capsuleClearance(world, reward.x, reward.y + .04, reward.z) >= -.01);
    }
    for (const c of plan.civilians) for (let t = 0; t < 60; t += 3.7) {
      const p = cityCivilianPose(c, t);
      assert.ok(capsuleClearance(world, p.x, p.y + .04, p.z) >= -.01, `${city.name}: civilian ${c.id} crosses a solid at ${t}`);
      assert.ok(world.sdf(p.x, p.y - .16, p.z) < 0, `${city.name}: civilian ${c.id} leaves a platform`);
    }
  }
});

test('ordinary movement enters rooms, returns outside, and climbs venue roofs without a jump', () => {
  const world = new World(1337);
  for (const city of world.collectCities()) {
    const plan = cityLifePlan(city);
    for (const v of [plan.venues[1], plan.venues.find(v => v.y > city.y + 20)!]) {
      const start = local(v, 0, v.hz + 5), state = createMoveState(start.x, v.y + .12, start.z);
      let seq = 0;
      const walk = (lx: number, lz: number) => {
        const end = local(v, lx, lz);
        for (let tick = 0; tick < 800; tick++) {
          const dx = end.x - state.px, dz = end.z - state.pz;
          if (Math.hypot(dx, dz) < .2) return;
          stepMove(world, state, { seq: seq++, buttons: BTN.FORWARD, weapon: 0, yaw: Math.atan2(-dx, -dz), pitch: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
        }
        assert.fail(`${city.name}/${v.id}: cannot walk to ${lx},${lz}; feet ${state.py - v.y}`);
      };
      walk(0, -v.hz + 3); walk(0, v.hz + 5);
      assert.ok(Math.abs(state.py - v.y) < .15);
      walk(-v.hx - 1.8, v.hz + 5); walk(-v.hx - 1.8, v.hz - 9.7); walk(-v.hx + 2, v.hz - 9.7);
      assert.ok(Math.abs(state.py - v.y - 5.04) < .2, `${city.name}/${v.id}: roof ${state.py - v.y}`);
    }
  }
});

test('civilian pauses stop foot travel while walking follows deterministic world distance', () => {
  const c = { id: 1, cityId: 0, venueId: 1, style: 0, color: 0, speed: 1.25, phase: 0, activity: 'browse' as const,
    route: [{ x: 0, y: 0, z: 0, dwell: 3 }, { x: 10, y: 0, z: 0, dwell: 3 }] };
  assert.deepEqual(cityCivilianPose(c, 1), cityCivilianPose(c, 2));
  const a = cityCivilianPose(c, 4), b = cityCivilianPose(c, 5);
  assert.equal(a.moving, true); assert.equal(b.x - a.x, 1.25); assert.equal(b.stride - a.stride, 1.25);
  assert.deepEqual(cityCivilianPose(c, 5), cityCivilianPose(c, 5));
  const stopped = cityCivilianPose(c, 12); assert.equal(stopped.moving, false); assert.equal(stopped.stride, 10);
});

test('aerodrome wayfinding does not obstruct the enlarged Nocturne runway', () => {
  const city = new World(1337).collectCities().find(c => c.theme === 'vesper')!, plan = cityLifePlan(city);
  assert.equal(plan.markers.length, 5); assert.ok(plan.venues.some(v => v.kind === 'aerodrome'));
  for (const box of plan.solids) assert.ok(box.x + box.hx < city.x - 980 || box.x - box.hx > city.x - 920 ||
    box.z + box.hz < city.z - 1490 || box.z - box.hz > city.z - 1160, 'venue must not enter the 60m runway corridor');
});
