import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '@shared/worldgen';
import { BTN, createMoveState, copyMoveState, stepMove, type InputCmd, type MoveState } from '@shared/movement';
import { PLAYER, TICK_DT, TICK_RATE } from '@shared/constants';
import { VEHICLE } from '@shared/vehicles';
import { harborDockSide, transportPose, transportBoxes, type TransportRoute } from '@shared/transport';
import { transitDistance, transitLocal, transitWorld } from '@shared/transit-motion';
import { solidBoxDistance } from '@shared/box-field';
import { mulberry32 } from '@shared/rng';
import { wrapAngle } from '@shared/math';

const command = (buttons = 0, yaw = 0): InputCmd => ({ seq: 0, buttons, yaw, pitch: 0, weapon: 0, renderTick: 0, renderFrac: 0 });
function fixture(kind: 'ferry' | 'train', seconds = 0, car = 0, local = { x: 0, y: 2, z: 0 }) {
  seconds = Math.round(seconds * TICK_RATE) / TICK_RATE;
  const world = new World(1337), plan = world.collectTransportPlan();
  const route = plan.routes.find(r => r.kind === kind)!;
  const pose = transportPose(route, seconds, route.carOffsets[car]);
  const p = transitWorld(pose, local.x, local.y + .006, local.z), state = createMoveState(p.x, p.y, p.z);
  state.grounded = true; state.simulationTick = Math.round(seconds * TICK_RATE);
  world.motionTime = seconds;
  return { world, route, state, car };
}
function localPosition(route: TransportRoute, car: number, s: MoveState) {
  return transitLocal(transportPose(route, s.simulationTick! / TICK_RATE, route.carOffsets[car]), s.px, s.py, s.pz);
}
function straightCruiseTime(route: TransportRoute): number {
  const leg = route.legs[0];
  const i = leg.distances.findIndex((distance, i) => i > 0 && distance - leg.distances[i - 1] > 800);
  assert.ok(i > 0, 'the fixture needs a genuine straight cruising section');
  return route.dwell + 1.5 + (leg.distances[i - 1] + 300) / route.speed;
}
function walk(world: World, route: TransportRoute, car: number, state: MoveState, x: number, y: number, z: number) {
  let previous = localPosition(route, car, state);
  for (let i = 0; i < 500; i++) {
    const pose = transportPose(route, (state.simulationTick! + 1) / TICK_RATE, route.carOffsets[car]);
    const target = transitWorld(pose, x, y, z), dx = target.x - state.px, dz = target.z - state.pz;
    const result = stepMove(world, state, command(BTN.FORWARD, Math.atan2(-dx, -dz)), TICK_DT);
    previous = localPosition(route, car, state);
    assert.ok(result.impact < 8, `unexpected impact ${result.impact}`);
    if (Math.hypot(previous.x - x, previous.z - z) < .3 && Math.abs(previous.y - y) < .65) return;
  }
  assert.fail(`route ${route.id} car ${car} cannot walk to ${x},${y},${z}; stopped at ${JSON.stringify(previous)}`);
}

test('the real ferry stairs connect cargo deck, passenger floor and roof without jumping', () => {
  const { world, route, state } = fixture('ferry', 0, 0, { x: 10.85, y: 2, z: 28.8 });
  walk(world, route, 0, state, 10.85, 8, 12.5);
  walk(world, route, 0, state, 8, 8, 11);
  walk(world, route, 0, state, 0, 8, 14.5);
  walk(world, route, 0, state, -11.2, 8, 19.3);
  walk(world, route, 0, state, -11.2, 12, 9.25);
  walk(world, route, 0, state, -11.1, 12, 7.8);
  walk(world, route, 0, state, -8.8, 12, 7.8);
  assert.equal(state.grounded, true);
});

test('the real passenger train has a walkable staircase to its roof', () => {
  const { world, route, state } = fixture('train', 0, 1, { x: 3.2, y: 1.2, z: -12.15 });
  walk(world, route, 1, state, 3.2, 5.2, -1.75);
  walk(world, route, 1, state, 3.2, 5.5, 1);
  walk(world, route, 1, state, 0, 5.5, 1);
  assert.equal(state.grounded, true);
});

test('standing passengers retain their local deck position through acceleration, bends and return travel', () => {
  for (const kind of ['ferry', 'train'] as const) {
    const start = kind === 'ferry' ? 28 : 22, car = kind === 'train' ? 2 : 0, floor = kind === 'train' ? 1.2 : 2;
    const { world, route, state } = fixture(kind, start, car, { x: 0, y: floor, z: 0 });
    const durations = [12, 30];
    for (const seconds of durations) {
      for (let i = 0; i < seconds * TICK_RATE; i++) {
        const result = stepMove(world, state, command(), TICK_DT);
        const p = localPosition(route, car, state);
        assert.ok(Math.hypot(p.x, p.z) < .1, `${kind} drift at ${state.simulationTick}: ${JSON.stringify(p)}`);
        assert.ok(Math.abs(p.y - floor) < .04, `${kind} deck height at ${state.simulationTick}: ${JSON.stringify(p)}`);
        assert.equal(state.grounded, true);
        assert.ok(result.impact < 3);
      }
    }
    const returnStart = route.dwell + route.legs[0].length / route.speed + 3;
    const reverse = fixture(kind, returnStart + route.dwell - 1, car, { x: 0, y: floor, z: 0 });
    for (let i = 0; i < 360; i++) stepMove(reverse.world, reverse.state, command(), TICK_DT);
    const p = localPosition(reverse.route, car, reverse.state);
    assert.ok(Math.hypot(p.x, p.z) < .1);
    assert.ok(Math.abs(p.y - floor) < .04);
  }
});

test('static terrain samples stay static while physics column probes include moving decks', () => {
  const { world, route } = fixture('ferry');
  const seconds = straightCruiseTime(route), pose = transportPose(route, seconds);
  const p = transitWorld(pose, 0, 1.5, 0), col = world.column(p.x, p.z), region = world.regionAt(p.x, p.z);
  world.motionTime = undefined;
  const staticValue = world.sdf(p.x, p.y, p.z);
  assert.ok(staticValue > 3);
  world.motionTime = seconds;
  assert.ok(world.sdfCol(p.x, p.y, p.z, col, region) < 0);
  assert.equal(world.sdfCol(p.x, p.y, p.z, col, region), world.sdf(p.x, p.y, p.z));
  world.motionTime = undefined;
  assert.equal(world.sdf(p.x, p.y, p.z), staticValue);
});

test('the near-body index exactly matches a full moving-geometry field across cell edges and query radii', () => {
  const world = new World(1337), plan = world.collectTransportPlan(), rng = mulberry32(441);
  for(const seconds of [30,52.75]) {
    const bodies = plan.routes.flatMap(route=>route.carOffsets.map((offset,car)=>({route,car,pose:transportPose(route,seconds,offset)})));
    for(let i=0;i<450;i++) {
      const body=bodies[i%bodies.length], x=body.pose.x+(rng()-.5)*150, y=body.pose.y+(rng()-.5)*45, z=body.pose.z+(rng()-.5)*150;
      const limit=[-.5,.1,4,31.9,32,32.1,120][i%7];
      let expected=limit;
      for(const b of bodies) { const local=transitLocal(b.pose,x,y,z); expected=solidBoxDistance(transportBoxes(b.route,b.car),local.x,local.y,local.z,expected); }
      assert.ok(Math.abs(transitDistance(world,seconds,x,y,z,limit)-expected)<1e-8, `indexed body omitted at ${x},${y},${z}, radius${limit}`);
    }
  }
});

test('a tank drives across the real landward quay and boards the ferry cargo lane', () => {
  const { world, route, state } = fixture('ferry');
  const harbor = world.collectTransportPlan().harbors.find(h => h.id === route.stops[0].id)!;
  const side = harborDockSide(harbor), pose = transportPose(route, 0), start = transitWorld(pose, side * 24, 2.006, 0);
  Object.assign(state, { px: start.x, py: start.y, pz: start.z, vehicle: VEHICLE.TANK,
    heading: Math.atan2(start.x - pose.x, start.z - pose.z) });
  let boarded = false;
  for (let i = 0; i < 300; i++) {
    const result = stepMove(world, state, command(BTN.FORWARD, state.heading), TICK_DT);
    const p = localPosition(route, 0, state);
    assert.ok(result.impact < 8, `boarding impact ${result.impact}`);
    if (Math.abs(p.x) < 3) { boarded = true; break; }
  }
  assert.equal(boarded, true);
  assert.ok(Math.abs(localPosition(route, 0, state).y - 2) < .1);
});

test('a running train passenger preserves inherited speed above the ordinary movement cap', () => {
  const probe = new World(1337), route = probe.collectTransportPlan().routes.find(r => r.kind === 'train')!;
  const seconds = Math.round(straightCruiseTime(route) * TICK_RATE) / TICK_RATE;
  const { world, state } = fixture('train', seconds, 2, { x: 0, y: 1.2, z: 0 });
  const pose = transportPose(route, seconds, route.carOffsets[2]), next = transportPose(route, seconds + TICK_DT, route.carOffsets[2]);
  const dx = next.x - pose.x, dz = next.z - pose.z, length = Math.hypot(dx, dz);
  state.vx = dx / length * PLAYER.RUN_SPEED; state.vz = dz / length * PLAYER.RUN_SPEED;
  stepMove(world, state, command(BTN.FORWARD | BTN.JUMP, Math.atan2(-dx, -dz)), TICK_DT);
  assert.ok(Math.hypot(state.vx, state.vz) > PLAYER.MAX_SPEED + 1);
  const launchedSpeed = Math.hypot(state.vx, state.vz);
  for (let i = 0; i < 10; i++) stepMove(world, state, command(), TICK_DT);
  assert.ok(Math.abs(Math.hypot(state.vx, state.vz) - launchedSpeed) < .05);
});

test('an occupied tank rides a moving ferry and snapshot replay stays identical', () => {
  const { world, route, state } = fixture('ferry', 30, 0, { x: 0, y: 2, z: 0 });
  state.vehicle = VEHICLE.TANK; state.heading = transportPose(route, 30).yaw;
  const replay = createMoveState(0, 0, 0); copyMoveState(state, replay); copyMoveState(replay, state);
  for (let i = 0; i < 420; i++) {
    const tick = state.simulationTick! + 1;
    stepMove(world, state, command(), TICK_DT, tick);
    stepMove(world, replay, command(), TICK_DT);
    assert.deepEqual(replay, state);
    const p = localPosition(route, 0, state);
    assert.ok(Math.hypot(p.x, p.z) < .15, JSON.stringify(p));
    assert.ok(Math.abs(p.y - 2) < .08);
  }
});

test('jumping from a cruising deck inherits its horizontal speed and lands back on the deck', () => {
  for (const kind of ['ferry', 'train'] as const) {
    const probe = new World(1337), first = probe.collectTransportPlan().routes.find(r => r.kind === kind)!;
    const seconds = Math.round(straightCruiseTime(first) * TICK_RATE) / TICK_RATE, floor = kind === 'ferry' ? 2 : 1.2, car = kind === 'ferry' ? 0 : 2;
    const { world, route, state } = fixture(kind, seconds, car, { x: 0, y: floor, z: 0 });
    const pose = transportPose(route, seconds, route.carOffsets[car]);
    const next = transportPose(route, seconds + TICK_DT, route.carOffsets[car]);
    assert.ok(Math.hypot(pose.vx, pose.vz) > 25);
    const result = stepMove(world, state, command(BTN.JUMP), TICK_DT);
    assert.equal(result.jumped, true);
    assert.equal(state.grounded, false);
    assert.ok(Math.hypot(state.vx - (next.x - pose.x) / TICK_DT, state.vz - (next.z - pose.z) / TICK_DT) < .2, `${kind} jump lost carrier velocity`);
    let landed = false;
    for (let i = 0; i < 100; i++) { stepMove(world, state, command(), TICK_DT); if (state.grounded) { landed = true; break; } }
    assert.equal(landed, true, `${kind} jumper did not land back`);
    const local = localPosition(route, car, state);
    assert.ok(Math.abs(local.y - floor) < .05);
    assert.ok(Math.hypot(local.x, local.z) < 1.5);
    for (let i = 0; i < 90; i++) stepMove(world, state, command(), TICK_DT);
    const settled = localPosition(route, car, state);
    assert.ok(Math.hypot(settled.x - local.x, settled.z - local.z) < .2, 'landing must not double-add carrier travel');
  }
});

test('actual rounded rail bends retain gangway support during outbound and reverse crossings', () => {
  const world = new World(1337), routes = world.collectTransportPlan().routes;
  // These include the tightest actual adjacent-car angle and the forest
  // connector's broad U-turn. Derive times from the current route geometry.
  for (const id of [12,13]) for (const reverse of [false,true]) {
    const route = routes.find(r=>r.id===id)!, travel = route.legs[0].length/route.speed;
    const base = reverse ? route.dwell+travel+3 : 0;
    let bestTime = 0, bestAngle = 0;
    for (let t=base+route.dwell+4; t<base+route.dwell+travel-3; t+=.2) {
      const a = transportPose(route,t,route.carOffsets[3]), b = transportPose(route,t,route.carOffsets[2]);
      const angle = Math.abs(wrapAngle(a.yaw-b.yaw));
      if (angle>bestAngle) { bestAngle=angle; bestTime=t; }
    }
    assert.ok(bestAngle>.18,'the test must exercise an actual bend');
    const seconds = Math.round((bestTime-.2)*TICK_RATE)/TICK_RATE;
    const pose = transportPose(route,seconds,route.carOffsets[3]), p = transitWorld(pose,0,1.206,-12);
    const state = createMoveState(p.x,p.y,p.z); state.grounded=true; state.simulationTick=seconds*TICK_RATE;
    let reached = false, angleAtJoint = 0;
    for (let i=0; i<150; i++) {
      const before = state.simulationTick!/TICK_RATE;
      const target = transitWorld(transportPose(route,before,route.carOffsets[2]),0,1.2,11);
      const result = stepMove(world,state,command(BTN.FORWARD,Math.atan2(state.px-target.x,state.pz-target.z)),TICK_DT);
      const now = state.simulationTick!/TICK_RATE;
      const from = transportPose(route,now,route.carOffsets[3]), to = transportPose(route,now,route.carOffsets[2]);
      const localFrom = transitLocal(from,state.px,state.py,state.pz), localTo = transitLocal(to,state.px,state.py,state.pz);
      assert.equal(result.transitImpact,0,'a supported gangway transfer is never a runover');
      assert.ok(result.impact<1,'the connection must not fling the passenger');
      assert.equal(state.grounded,true,'both moving gangways must preserve a supported route');
      assert.ok(Math.abs(state.py-321.206)<.03);
      if (localFrom.z<-12.4 && localTo.z>12.4) angleAtJoint = Math.max(angleAtJoint,Math.abs(wrapAngle(from.yaw-to.yaw)));
      if (Math.hypot(localTo.x,localTo.z-11)<.4) { reached=true; break; }
    }
    assert.equal(reached,true,`route${id} reverse${reverse}: gangway was blocked`);
    assert.ok(angleAtJoint>.18,`route${id}: the passenger must cross while the cars are actually angled`);
  }
});
