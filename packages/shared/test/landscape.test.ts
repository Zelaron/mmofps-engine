import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, MAT, type RoadSegment } from '@shared/worldgen';
import { createMoveState, stepMove, BTN } from '@shared/movement';
import { capsuleClearance } from '@shared/physics';
import { TICK_DT } from '@shared/constants';

function trails(world: World): RoadSegment[][] {
  const groups = new Map<string, RoadSegment[]>();
  for (const segment of world.collectRoadSegments(-1024, 1024, -1024, 1024)) {
    if (!segment.trail) continue;
    if (!groups.has(segment.id)) groups.set(segment.id, []);
    groups.get(segment.id)!.push(segment);
  }
  return [...groups.values()].filter(segments => !segments[0].dramatic && segments.length === 78);
}

test('connected roads and mountain switchbacks are deterministic and graded', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed), other = new World(seed);
    const roads = world.collectRoadSegments(-1024, 1024, -1024, 1024);
    assert.deepEqual(roads, other.collectRoadSegments(-1024, 1024, -1024, 1024));
    const trunk = roads.filter((segment) => !segment.trail);
    for (const trail of trails(world)) {
      assert.ok(trunk.some((segment) => Math.hypot(segment.b.x - trail[0].a.x, segment.b.z - trail[0].a.z) < 0.001),
        'switchback must join a connected trunk road at exactly the same point');
      const gain = trail[trail.length - 1].b.y - trail[0].a.y;
      assert.ok(gain > 65, `switchback only gains ${gain}m`);
      for (const segment of trail) {
        const grade = Math.abs(segment.b.y - segment.a.y) / Math.hypot(segment.b.x - segment.a.x, segment.b.z - segment.a.z);
        assert.ok(grade < 0.7, `impassable mountain trail grade ${grade}`);
        for (let t = 0.1; t < 1; t += 0.2) {
          const x = segment.a.x + (segment.b.x - segment.a.x) * t;
          const z = segment.a.z + (segment.b.z - segment.a.z) * t;
          const col = world.column(x, z);
          assert.ok(col.road && (col.road.distance < .001 || (!col.road.trail && col.road.distance < col.road.width)),
            'a rounded trail stays on its lane or inside its wider trunk junction');
          assert.ok(col.entr < 0.72, 'a cave mouth must never break the road lane');
          assert.ok(Math.abs(world.groundY(x, z) - col.h) < 0.2, 'road has real supported terrain');
        }
      }
    }
  }
});

test('players can walk a complete winding mountain trail from trunk road to summit', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed);
    const trail = trails(world)[0];
    assert.ok(trail);
    const s = createMoveState(trail[0].a.x, trail[0].a.y + 0.1, trail[0].a.z);
    const startY = s.py;
    let waypoint = 0;
    for (let tick = 0; tick < 16000 && waypoint < trail.length; tick++) {
      const target = trail[waypoint].b;
      if (Math.hypot(target.x - s.px, target.z - s.pz) < 1.8) { waypoint++; continue; }
      const yaw = Math.atan2(-(target.x - s.px), -(target.z - s.pz));
      stepMove(world, s, { seq: tick, buttons: BTN.FORWARD, yaw, pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
      if (tick % 60 === 0) assert.ok(capsuleClearance(world, s.px, s.py, s.pz) > -0.02);
    }
    assert.equal(waypoint, trail.length, `seed ${seed} stuck on switchback ${waypoint} at ${s.px},${s.py},${s.pz}`);
    assert.ok(s.py - startY > 65, 'walk must reach the elevated summit');
  }
});

test('gravel shoulders have continuous color across triangle material boundaries', () => {
  const world = new World(1337);
  const col = { ...world.column(0, 0), h: 0, temp: 0.8, desert: 1,
    road: { distance: 6.3, height: 0, width: 5.8, trail: false, dx: 1, dz: 0, gradeWeight: 1 } };
  const road = new Float32Array(3), sand = new Float32Array(3);
  world.vertexColor(MAT.ROAD, 0, 0, 0, col, road, 0);
  world.vertexColor(MAT.SAND, 0, 0, 0, col, sand, 0);
  assert.deepEqual(road, sand, 'material-id quantization must not make a dark sawtooth at the road edge');
});

test('selected trunk roads use gradual S-bends while preserving connected graded junctions', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed);
    const groups = new Map<string, RoadSegment[]>();
    for (const road of world.collectRoadSegments(-2048, 2048, -2048, 2048)) {
      if (road.trail || road.id.startsWith('city')) continue;
      const group = groups.get(road.id) ?? [];
      group.push(road); groups.set(road.id, group);
    }
    let curved = 0;
    for (const roads of groups.values()) {
      if (roads.length !== 32) continue;
      const first = roads[0].a, last = roads[roads.length - 1].b;
      const dx = last.x - first.x, dz = last.z - first.z, length = Math.hypot(dx, dz);
      let left = 0, right = 0;
      for (let i = 0; i < roads.length; i++) {
        const r = roads[i];
        const offset = ((r.b.x - first.x) * dz - (r.b.z - first.z) * dx) / length;
        left = Math.min(left, offset); right = Math.max(right, offset);
        assert.ok(Math.abs(r.b.y - r.a.y) / Math.hypot(r.b.x - r.a.x, r.b.z - r.a.z) < .7);
        if (i > 0) {
          assert.deepEqual(r.a, roads[i - 1].b, 'curved road has a disconnected junction');
          const a = roads[i - 1], ax = a.b.x - a.a.x, az = a.b.z - a.a.z;
          const bx = r.b.x - r.a.x, bz = r.b.z - r.a.z;
          const turn = Math.acos(Math.max(-1, Math.min(1, (ax * bx + az * bz) / Math.hypot(ax, az) / Math.hypot(bx, bz))));
          assert.ok(turn < .30, `road chord makes an abrupt ${turn}radian turn`);
        }
      }
      if (left < -12 && right > 12) curved++;
    }
    assert.ok(curved >= 3, `seed${seed} has only${curved} curved trunk roads`);
  }
});

test('planetary roads keep their entire lane and verge out of lava after all terrain grading', () => {
  for (const seed of [1337, 7331, 20077]) {
    const world = new World(seed);
    let volcanic = 0;
    for (const road of world.collectRoadSegments(-8704, 8704, -8704, 8704)) {
      const dx = road.b.x - road.a.x, dz = road.b.z - road.a.z, length = Math.hypot(dx, dz);
      const steps = Math.max(1, Math.ceil(length / 8));
      for (let i = 0; i <= steps; i++) {
        const x = road.a.x + dx * i / steps, z = road.a.z + dz * i / steps;
        const center = world.column(x, z);
        if (center.volc < .3) continue;
        volcanic++;
        for (const offset of [0, -road.width - 2, road.width + 2]) {
          const px = x - dz / length * offset, pz = z + dx / length * offset, col = world.column(px, pz);
          assert.ok(col.lavaY < -999 || col.h >= col.lavaY,
            `seed ${seed}: ${road.id} flooded at ${px},${pz}: road ${col.h}, lava ${col.lavaY}`);
          assert.notEqual(world.liquidAt(px, col.h + .05, pz)?.kind, 'lava');
        }
      }
    }
    assert.ok(volcanic > 1000, `seed ${seed}: real volcanic routes must remain available`);
  }
});

test('players can follow the rerouted lava crossings from junction to junction', () => {
  for (const [seed, id, x, z] of [[1337, '3,4,1', 3072, 4608], [7331, '5,0,1', 5120, 512]] as const) {
    const world = new World(seed);
    const route = world.collectRoadSegments(x - 1600, x + 1600, z - 1600, z + 1600).filter(r => r.id === id);
    assert.ok(route.length > 0, `seed ${seed}: the detour retains a complete link`);
    const other = new World(seed);
    assert.deepEqual(route, other.collectRoadSegments(x - 1600, x + 1600, z - 1600, z + 1600).filter(r => r.id === id));
    for (let i = 1; i < route.length; i++) assert.deepEqual(route[i].a, route[i - 1].b);
    const first = route[0].a, state = createMoveState(first.x, world.column(first.x, first.z).h + .05, first.z);
    let waypoint = 0;
    for (let tick = 0; tick < 22000 && waypoint < route.length; tick++) {
      const target = route[waypoint].b;
      if (Math.hypot(target.x - state.px, target.z - state.pz) < 2) { waypoint++; continue; }
      stepMove(world, state, { seq: tick, buttons: BTN.FORWARD, weapon: 0,
        yaw: Math.atan2(state.px - target.x, state.pz - target.z), pitch: 0, renderTick: 0, renderFrac: 0 }, TICK_DT);
      assert.notEqual(world.liquidAt(state.px, state.py + .05, state.pz)?.kind, 'lava');
      assert.equal(state.swimming, false, 'detours remain walkable on solid ground');
    }
    assert.equal(waypoint, route.length, `seed ${seed}: stuck at ${state.px},${state.py},${state.pz} before waypoint ${waypoint}`);
  }
});
