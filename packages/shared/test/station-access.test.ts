import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { createMoveState, stepMove, BTN, type MoveState } from '@shared/movement';
import { TICK_DT, PLAYER } from '@shared/constants';
import { capsuleClearance } from '@shared/physics';
import { cityLiftPose } from '@shared/lifts';
import { transportPose } from '@shared/transport';
import { transitWorld, transitLocal } from '@shared/transit-motion';
import { TransportBridgeIndex, transportPrismDistance } from '@shared/transport-geometry';

function walk(world: World, state: MoveState, x: number, z: number, label: string, expectedY?: number) {
  const budget = Math.ceil(Math.hypot(state.px - x, state.pz - z) * 18 + 180);
  for (let i = 0; i < budget; i++) {
    if (Math.hypot(state.px - x, state.pz - z) < .25) {
      // Releasing movement at the landing allows a final stair stride to
      // settle before checking its support height.
      for (let settle = 0; settle < 60 && !state.grounded; settle++) stepMove(world, state,
        { seq: i + settle, buttons: 0, yaw: 0, pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
      if (expectedY !== undefined) assert.ok(Math.abs(state.py - expectedY) < .4, `${label}: wrong floor ${state.py}/${expectedY}`);
      return;
    }
    const result = stepMove(world, state, { seq: i, buttons: BTN.FORWARD, yaw: Math.atan2(state.px - x, state.pz - z), pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
    assert.ok(result.impact < PLAYER.FALL_DMG_MIN, `${label}: unsafe impact${result.impact} at${state.px},${state.py},${state.pz}`);
  }
  assert.fail(`${label}: stopped at ${state.px},${state.py},${state.pz}, target${x},${z}`);
}

test('all eight station approaches climb and descend their actual graded steps without jumping', () => {
  const world = new World(1337), plan = world.collectTransportPlan();
  for (const access of plan.accesses) {
    for (let i = 1; i < access.profile.length; i++) assert.ok(Math.abs(access.profile[i].y - access.profile[i - 1].y) <= .240001);
    const state = createMoveState(access.x, access.startY + .07, access.startZ - 1); state.grounded = true;
    walk(world, state, access.x, access.endZ - .3, `station${access.stationId} outbound`, access.endY);
    state.vx = state.vz = 0;
    walk(world, state, access.x, access.startZ - 1, `station${access.stationId} return`, access.startY);
  }
});

test('access feather blends continuously with the hall grade, including the old Sun Pyramid seam', () => {
  for (const seed of [1337, 7, 42]) {
    const world = new World(seed), plan = world.collectTransportPlan();
    for (const a of plan.accesses) for (const z of [a.startZ - 16, a.endZ + 16]) {
      const before = world.column(a.x, z - .001).h, after = world.column(a.x, z + .001).h;
      assert.ok(Math.abs(before - after) < .02, `seed${seed} station${a.stationId}: feather step${before}→${after}`);
    }
  }
});

test('Sun Pyramid access banks keep the original field-march slope bound at the deep-cut witness', () => {
  const world = new World(424242);
  const slope = (x: number, z: number) => Math.hypot(world.terrainHeight(x + .5, z) - world.terrainHeight(x - .5, z),
    world.terrainHeight(x, z + .5) - world.terrainHeight(x, z - .5));
  assert.ok(slope(1504, 1568) < 1.8, 'old32m feather produced slope3.522 at this exact coordinate');
  // Survey the neighbouring cut face, rather than only protecting one sample.
  for (let z = 1488; z <= 1648; z += 4) for (let x = 1456; x <= 1552; x += 4)
    assert.ok(slope(x, z) < 2.8, `bank slope exceeded the unchanged march envelope at${x},${z}`);
});

test('seed7 pyramid stairs keep their full walking width clear of a widened bridge footing', () => {
  const world = new World(7), plan = world.collectTransportPlan();
  const x = 1396.711661, y = 182.595095, z = 1695.167383;
  assert.ok(capsuleClearance(world, x, y + .04, z) >= -.01, 'old8m-halfwidth footing blocked this western stair lane');
  assert.ok(world.sdf(x, y - .12, z) < 0, 'removing the pier must retain actual tread support');
  const floor = (pz: number) => Math.max(...plan.solids.filter(b => [123, 125].includes(b.facade ?? 0) &&
    Math.abs(x - b.x) <= b.hx && Math.abs(pz - b.z) <= b.hz && b.y < 250).map(b => b.y + b.hy));
  const access = plan.accesses.find(a => a.stationId === 6)!;
  const startZ = Math.max(z - 12, access.startZ + .5), endZ = z;
  assert.ok(Number.isFinite(floor(startZ)) && Number.isFinite(floor(endZ)), 'walk endpoints must remain on authored treads');
  const state = createMoveState(x, floor(startZ) + .04, startZ); state.grounded = true;
  walk(world, state, x, endZ, 'seed7 western stair lane');
  // A released stair stride can carry forward while settling; compare with
  // the tread under the final feet, rather than the original waypoint.
  assert.ok(Math.abs(state.py - floor(state.pz)) < .4, 'walking through the former footing must finish supported on the stairs');
});

test('Vesper tracks have walkable outward escape stairs and a stopped flatcar can be boarded', () => {
  const world = new World(1337), plan = world.collectTransportPlan(), station = plan.stations.find(s => s.id === 3)!;
  for (const side of [-1, 1]) for (const z of [-100, 100]) {
    const state = createMoveState(station.x + side * 12, 318.806, station.z + z); state.grounded = true;
    walk(world, state, station.x + side * 31, station.z + z, `track${side}/${z} escape`, 321.2);
  }
  const route = plan.routes.find(r => r.kind === 'train' && r.stops[0].id === station.id)!;
  const pose = transportPose(route, 0, route.carOffsets[2]), start = transitWorld(pose, 10, 1.206, 0);
  const state = createMoveState(start.x, start.y, start.z); state.grounded = true; state.simulationTick = 0;
  const target = transitWorld(pose, 0, 1.2, 0); world.motionTime = 0;
  walk(world, state, target.x, target.z, 'stopped train boarding', target.y);
  const local = transitLocal(pose, state.px, state.py, state.pz); assert.ok(Math.abs(local.x) < .3);
});

test('continuous diagonal viaduct collision matches its actual ribbon and exposes no giant square shoulders', () => {
  const world = new World(1337), plan = world.collectTransportPlan(), index = new TransportBridgeIndex(plan.bridges);
  const pieces = plan.bridges.filter(p => !p.rail).filter(p => {
    const a = p.corners[0], b = p.corners[1]; return Math.abs(a.x - b.x) > 8 && Math.abs(a.z - b.z) > 8;
  }).slice(0, 25);
  assert.ok(pieces.length >= 10);
  for (const p of pieces) {
    const x = p.corners.reduce((n, c) => n + c.x, 0) / 4, z = p.corners.reduce((n, c) => n + c.z, 0) / 4;
    const col = world.column(x, z), region = world.regionAt(x, z);
    assert.ok(world.sdf(x, p.top - .1, z) < 0);
    assert.equal(world.sdfCol(x, p.top - .1, z, col, region), world.sdf(x, p.top - .1, z));
    assert.ok(capsuleClearance(world, x, p.top + .03, z) >= -.01);
    const hit = world.trace(x, p.top + 10, z, 0, -1, 0, 20); assert.ok(hit.hit && Math.abs(hit.dist - 10) < .15);
    for (const [dx, dz] of [[0, 0], [20, 0], [-20, 20]]) {
      const expected = plan.bridges.reduce((d, b) => Math.min(d, transportPrismDistance(b, x + dx, p.top + 2, z + dz)), Infinity);
      assert.ok(Math.abs(index.distance(x + dx, p.top + 2, z + dz, Infinity) - expected) < 1e-7);
    }
  }
});

test('city and station elevators leave a longer boarding window at both ends', () => {
  const world = new World(1337);
  for (const lift of world.collectCityLifts()) {
    const dwell = lift.dwell ?? 6, span = lift.top - lift.bottom, speed = span > 80 ? Math.min(12, span / 10) : 4;
    assert.ok(dwell >= 6);
    assert.equal(cityLiftPose(lift, -lift.phase + dwell - .1).waiting, true);
    const top = cityLiftPose(lift, -lift.phase + dwell + span / speed + dwell - .1);
    assert.equal(top.waiting, true); assert.ok(Math.abs(top.y - lift.top) < 1e-6);
  }
});
