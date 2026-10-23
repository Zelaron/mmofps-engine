import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cityLiftPose, carryCityLift, landOnCityLift } from '@shared/lifts';
import { createMoveState, copyMoveState, stepMove, BTN, type InputCmd } from '@shared/movement';
import { PLAYER, TICK_DT, TICK_RATE } from '@shared/constants';
import type { CityLiftSite } from '@shared/cities';
import { World } from '@shared/worldgen';
import { capsuleClearance } from '@shared/physics';

const site: CityLiftSite = { id: 1, cityId: 0, x: 0, z: 0, bottom: 0, top: 24, hx: 2.2, hz: 2.2, phase: 0, dwell: 3 };
function flatWorld(ceiling = Infinity): World {
  return {
    collectCityLifts: () => [site],
    column: () => ({}), regionAt: () => ({}),
    sdf: (_x: number, y: number, _z: number) => Math.min(y, ceiling - y),
    sdfCol: (_x: number, y: number, _z: number) => Math.min(y, ceiling - y),
    gradient: (_x: number, y: number, _z: number, out: { x: number; y: number; z: number }) => {
      out.x = 0; out.y = y < ceiling / 2 ? 1 : -1; out.z = 0; return out;
    },
  } as unknown as World;
}
const cmd = (buttons = 0): InputCmd => ({ seq: 0, buttons, weapon: 0, yaw: 0, pitch: 0, renderTick: 0, renderFrac: 0 });
function rider(seconds: number) {
  const s = createMoveState(0, cityLiftPose(site, seconds).y + .006, 0);
  s.grounded = true; s.simulationTick = seconds * TICK_RATE; return s;
}

test('lift clock pauses at both landings and wraps without drift', () => {
  for (const offset of [0, 18, 180000]) {
    assert.equal(cityLiftPose(site, offset + 2).y, 0);
    assert.equal(cityLiftPose(site, offset + 6).y, 12);
    assert.equal(cityLiftPose(site, offset + 10).y, 24);
    assert.equal(cityLiftPose(site, offset + 15).y, 12);
    assert.equal(cityLiftPose(site, offset + 10).waiting, true);
  }
});

test('standing rider completes an entire lift cycle without drift or fall damage', () => {
  const world = flatWorld(), s = rider(0);
  for (let tick = 1; tick <= 18 * TICK_RATE; tick++) {
    const result = stepMove(world, s, cmd(), TICK_DT, tick);
    assert.ok(Math.abs(s.py - cityLiftPose(site, tick / TICK_RATE).y - .006) < .025, `tick ${tick}: ${s.py}`);
    assert.equal(s.grounded, true, `tick ${tick}`);
    assert.ok(result.impact < 5, `unexpected impact ${result.impact}`);
  }
});

test('jumping from a rising lift inherits upward velocity and releases support', () => {
  const s = rider(6), start = s.py;
  const result = stepMove(flatWorld(), s, cmd(BTN.JUMP), TICK_DT);
  assert.equal(result.jumped, true);
  assert.equal(s.grounded, false);
  assert.ok(s.vy > 11);
  assert.ok(s.py > start + .15);
});

test('walking off a raised lift releases the player into a normal fall', () => {
  const s = rider(10), world = flatWorld(); s.px = 2;
  for (let i = 0; i < 25; i++) stepMove(world, s, cmd(BTN.RIGHT), TICK_DT);
  assert.ok(s.px > 3);
  assert.equal(s.grounded, false);
  assert.ok(s.py < 23);
});

test('relative sweep catches a fast fall but permits passage up from below', () => {
  const world = flatWorld(), falling = rider(6);
  falling.py = 11; falling.vy = -40; falling.grounded = false;
  const impact = landOnCityLift(world, falling, 13, 6, 6 + TICK_DT, null, false);
  assert.equal(falling.grounded, true);
  assert.ok(impact >= 40);
  const rising = rider(6); rising.py = 12.1; rising.vy = 12; rising.grounded = false;
  landOnCityLift(world, rising, 11.9, 6, 6 + TICK_DT, null, false);
  assert.equal(rising.grounded, false);
});

test('descending deck catches a crossing even when static collision already zeroed vertical velocity', () => {
  const s = rider(15); s.py = 11.88; s.vy = 0; s.grounded = false;
  landOnCityLift(flatWorld(), s, 12.02, 15, 15 + TICK_DT, null, false,
    { x: 0, z: 0, grounded: false, velocityY: -18 });
  assert.equal(s.grounded, true);
  assert.ok(Math.abs(s.py - cityLiftPose(site, 15 + TICK_DT).y - .006) < 1e-8);
});

test('grounded boarding snaps onto a nearby descending deck and keeps riding', () => {
  const world = flatWorld(), s = rider(15);
  s.py += .2; s.px = 1.95; s.vy = -.4; s.grounded = false;
  landOnCityLift(world, s, 12.206, 15, 15 + TICK_DT, null, false,
    { x: 2.25, z: 0, grounded: true, velocityY: -.4 });
  assert.equal(s.grounded, true);
  s.simulationTick = s.simulationTick! + 1;
  for (let i = 0; i < 70; i++) {
    stepMove(world, s, cmd(), TICK_DT);
    assert.ok(Math.abs(s.py - cityLiftPose(site, s.simulationTick! / TICK_RATE).y - .006) < .025);
  }
});

test('swept top contact does not catch a player who crossed below the deck outside its footprint', () => {
  const s = rider(15); s.py = 11.8; s.vy = -20; s.grounded = false;
  landOnCityLift(flatWorld(), s, 12.04, 15, 15 + TICK_DT, null, false,
    { x: 4, z: 0, grounded: false, velocityY: -20 });
  assert.equal(s.grounded, false);
});

test('jumping from a fast descending lift releases above its top instead of double-applying deck motion', () => {
  const tall = { ...site, top: 120 }, seconds = 19;
  const world = flatWorld(); world.collectCityLifts = () => [tall];
  const s = createMoveState(0, cityLiftPose(tall, seconds).y + .006, 0);
  s.simulationTick = seconds * TICK_RATE; s.grounded = true;
  const result = stepMove(world, s, cmd(BTN.JUMP), TICK_DT);
  assert.equal(result.jumped, true);
  assert.equal(s.grounded, false);
  assert.ok(s.py > cityLiftPose(tall, seconds + TICK_DT).y + .1);
  let landed = false;
  for (let i = 0; i < 120; i++) {
    stepMove(world, s, cmd(), TICK_DT);
    if (s.grounded) { landed = true; break; }
  }
  assert.equal(landed, true);
  assert.ok(Math.abs(s.py - cityLiftPose(tall, s.simulationTick! / TICK_RATE).y - .006) < .025);
});

test('blocked shaft never forces a carried rider into a ceiling', () => {
  const s = rider(6), before = s.py;
  const contact = carryCityLift(flatWorld(13.8), s, 6, 6 + TICK_DT);
  assert.equal(contact, null);
  assert.equal(s.py, before);
});

test('several commands in one authoritative tick carry a platform only once', () => {
  const world = flatWorld(), s = rider(6);
  for (let i = 0; i < 3; i++) stepMove(world, s, cmd(), TICK_DT, 361);
  assert.ok(Math.abs(s.py - cityLiftPose(site, 361 / TICK_RATE).y - .006) < .025);
});

test('snapshot clock and copied replay state keep lift prediction deterministic', () => {
  const world = flatWorld(), authoritative = rider(6), predicted = createMoveState(0, 0, 0);
  copyMoveState(authoritative, predicted);
  for (let tick = 361; tick < 520; tick++) {
    stepMove(world, authoritative, cmd(), TICK_DT, tick);
    stepMove(world, predicted, cmd(), TICK_DT);
    assert.equal(predicted.simulationTick, authoritative.simulationTick);
    assert.ok(Math.abs(predicted.py - authoritative.py) < 1e-8);
  }
});

function rideToSupportedExit(world: World, lift: CityLiftSite): void {
  let start = -1;
  for (let tick = 0; tick <= 90 * TICK_RATE; tick++) {
    const pose = cityLiftPose(lift, tick / TICK_RATE);
    if (pose.waiting && Math.abs(pose.y - lift.bottom) < .01 && pose.untilDeparture >= 1) { start = tick; break; }
  }
  assert.ok(start >= 0, 'lift never offers a lower landing');
  const s = createMoveState(lift.x, lift.bottom + .006, lift.z);
  s.grounded = true; s.simulationTick = start;
  let arrival = -1;
  for (let tick = start + 1; tick <= start + 90 * TICK_RATE; tick++) {
    stepMove(world, s, cmd(), TICK_DT, tick);
    const pose = cityLiftPose(lift, tick / TICK_RATE);
    assert.ok(Math.abs(s.py - pose.y - .006) < .035, `lift${lift.id} tick${tick} loses its rider`);
    if (pose.waiting && Math.abs(pose.y - lift.top) < .01) { arrival = tick; break; }
  }
  assert.ok(arrival >= 0, 'lift never reaches its upper landing');
  const exits = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const direction = exits.find(([dx, dz]) => {
    const distance = (dx ? lift.hx : lift.hz) + 3;
    const x = lift.x + dx * distance, z = lift.z + dz * distance;
    return world.sdf(x, lift.top - .08, z) < 0 && capsuleClearance(world, x, lift.top + .006, z) > -.01;
  });
  assert.ok(direction, 'upper landing has no supported exit');
  const [dx, dz] = direction, distance = (dx ? lift.hx : lift.hz) + 3;
  const x = lift.x + dx * distance, z = lift.z + dz * distance;
  for (let tick = arrival + 1; tick <= arrival + 180 && Math.hypot(s.px - x, s.pz - z) > .2; tick++)
    stepMove(world, s, { ...cmd(BTN.FORWARD), yaw: Math.atan2(-(x - s.px), -(z - s.pz)) }, TICK_DT, tick);
  assert.ok(Math.hypot(s.px - x, s.pz - z) < .25, 'rider cannot leave the force deck');
  // The ordinary-city ring has a shallow edge step. Let its normal step-up
  // impulse settle before asserting final support, as a real walking rider does.
  for (let i = 0; i < 30; i++) stepMove(world, s, cmd(), TICK_DT, s.simulationTick + 1);
  assert.ok(Math.abs(s.py - lift.top - .006) < .08 && s.grounded,
    `lift${lift.id} upper promenade loses support: feet${s.py}, top${lift.top}, grounded${s.grounded}`);
}

test('real city shafts carry riders through actual clock arrival and onto a supported promenade', () => {
  const world = new World(1337);
  for (const cityId of [0, 2, 3]) rideToSupportedExit(world, world.collectCityLifts().find(l => l.cityId === cityId)!);
});

test('each capital highest lift reaches its terrace and allows a physical supported exit', () => {
  const world = new World(1337);
  for (const city of world.collectCities().filter(c => c.theme)) {
    const lift = world.collectCityLifts().filter(l => l.cityId === city.id).sort((a, b) => b.top - a.top)[0];
    rideToSupportedExit(world, lift);
  }
});

test('walk from real upper landings onto departing downward decks, then remain above their moving surface', () => {
  const world = new World(1337);
  for (const cityId of [0, 2, 3]) {
    const lift = world.collectCityLifts().find(l => l.cityId === cityId)!;
    let start = -1;
    for (let tick = 0; tick < 90 * TICK_RATE; tick++) {
      const p = cityLiftPose(lift, tick / TICK_RATE);
      if (p.waiting && Math.abs(p.y - lift.top) < .01 && p.untilDeparture > .08 && p.untilDeparture < .12) { start = tick; break; }
    }
    assert.ok(start >= 0);
    const approach = [.6, 1.05, 1.4, 2].flatMap(margin => [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([dx, dz]) => ({dx, dz, distance: (dx ? lift.hx : lift.hz) + margin})))
      .find(({dx, dz, distance:d}) => capsuleClearance(world, lift.x + dx * d, lift.top + .006, lift.z + dz * d) >= -.01 &&
        world.sdf(lift.x + dx * d, lift.top - .08, lift.z + dz * d) < 0);
    assert.ok(approach, 'missing clear approach');
    const {dx, dz, distance} = approach;
    const s = createMoveState(lift.x + dx * distance, lift.top + .006, lift.z + dz * distance);
    s.grounded = true; s.simulationTick = start;
    s.vx = -dx * PLAYER.RUN_SPEED; s.vz = -dz * PLAYER.RUN_SPEED;
    const replay = createMoveState(0, 0, 0); copyMoveState(s, replay);
    let boarded = false, stopping = false;
    for (let tick = start + 1; tick <= start + 180; tick++) {
      stopping ||= Math.hypot(s.px - lift.x, s.pz - lift.z) < .5;
      const input = { ...cmd(stopping ? 0 : BTN.FORWARD), yaw: Math.atan2(dx, dz) };
      stepMove(world, s, input, TICK_DT, tick);
      stepMove(world, replay, input, TICK_DT);
      assert.ok(Math.abs(s.py - replay.py) < 1e-8, 'boarding replay diverged');
      const pose = cityLiftPose(lift, tick / TICK_RATE);
      if (Math.abs(s.py - pose.y - .006) < .03 && s.grounded && Math.abs(s.px-lift.x)<lift.hx-.2 && Math.abs(s.pz-lift.z)<lift.hz-.2) boarded = true;
      if (boarded) assert.ok(s.py >= pose.y - .03, `lift${lift.id} tick${tick} walked through deck: ${s.py} vs ${pose.y}, x${s.px-lift.x}, z${s.pz-lift.z}`);
    }
    assert.equal(boarded, true, `lift${lift.id} could not be boarded from its actual upper landing: ${JSON.stringify({s, lift, approach})}`);
  }
});

test('centimeter contact offsets and a skipped clock tick retain descending support', () => {
  for (const offset of [-.035, .035]) {
    const s = rider(15); s.py += offset;
    stepMove(flatWorld(), s, cmd(), TICK_DT, s.simulationTick! + 2);
    assert.equal(s.grounded, true);
    assert.ok(Math.abs(s.py - cityLiftPose(site, s.simulationTick! / TICK_RATE).y - .006) < 1e-8);
  }
});

function indexedLiftWorld(sites: CityLiftSite[]): World {
  const world = flatWorld();
  world.collectCities = () => [];
  world.collectTransportPlan = () => ({ lifts: sites }) as ReturnType<World['collectTransportPlan']>;
  world.collectCityLifts = World.prototype.collectCityLifts;
  return world;
}

function distantLifts(): CityLiftSite[] {
  return Array.from({ length: 120 }, (_, i) => ({ ...site, id: i + 10, x: 1000 + i * 128, z: -1000 }));
}

test('lift spatial selection preserves collection order when multiple decks overlap', () => {
  const first = { ...site, id: 900 }, second = { ...site, id: 2, bottom: .025, top: 24.025 };
  const world = indexedLiftWorld([...distantLifts(), first, second]);
  const standing = rider(6), contact = carryCityLift(world, standing, 6, 6 + TICK_DT);
  assert.equal(contact?.site, first, 'the first matching site wins regardless of numeric id');
  const falling = rider(6); falling.py = 11; falling.vy = -40; falling.grounded = false;
  landOnCityLift(world, falling, 13, 6, 6 + TICK_DT, null, false);
  assert.equal(falling.py, cityLiftPose(first, 6 + TICK_DT).y + .006);
});

test('lift spatial selection matches full scans at signed cell and capsule footprint boundaries', () => {
  for (const x of [-66.2, -64, -.2, 0, 63.8, 64, 128]) {
    const local = { ...site, id: 200, x, z: -x, hx: 67, hz: 3 };
    const sites = [...distantLifts(), local], indexed = indexedLiftWorld(sites), linear = flatWorld();
    linear.collectCityLifts = () => sites;
    for (const dx of [-local.hx - PLAYER.RADIUS * .5, -64, 0, 64, local.hx + PLAYER.RADIUS * .5,
      local.hx + PLAYER.RADIUS * .5 + .0001]) {
      for (const dz of [-local.hz - PLAYER.RADIUS * .5, 0, local.hz + PLAYER.RADIUS * .5]) {
        const a = rider(6); a.px = x + dx; a.pz = local.z + dz;
        const b = { ...a };
        assert.deepEqual(carryCityLift(indexed, a, 6, 6 + TICK_DT), carryCityLift(linear, b, 6, 6 + TICK_DT));
        assert.deepEqual(a, b);
        // The crossing starts in a different grid cell and below-footprint
        // crossings still obey the original swept one-way contact rule.
        for (const approachX of [a.px, a.px - 130]) {
          const left = rider(6); Object.assign(left, { px: a.px, pz: a.pz, py: 11, vy: -40, grounded: false });
          const right = { ...left }, approach = { x: approachX, z: a.pz, grounded: false, velocityY: -40 };
          assert.equal(landOnCityLift(indexed, left, 13, 6, 6 + TICK_DT, null, false, approach),
            landOnCityLift(linear, right, 13, 6, 6 + TICK_DT, null, false, approach));
          assert.deepEqual(left, right);
        }
      }
    }
  }
});

test('lift spatial selection keeps injected mutable collectors live after a generated collection was cached', () => {
  const original = { ...site }, world = indexedLiftWorld([...distantLifts(), original]);
  assert.equal(carryCityLift(world, rider(6), 6, 6 + TICK_DT)?.site, original);
  const injected = { ...site, id: 300, x: 500 }, sites = [...distantLifts(), injected];
  world.collectCityLifts = () => sites;
  assert.equal(carryCityLift(world, rider(6), 6, 6 + TICK_DT), null);
  injected.x = 0;
  assert.equal(carryCityLift(world, rider(6), 6, 6 + TICK_DT)?.site, injected,
    'in-place changes in a custom fixture cannot leave stale indexed bounds');
  sites.splice(sites.indexOf(injected), 1);
  assert.equal(carryCityLift(world, rider(6), 6, 6 + TICK_DT), null);
});

test('lift spatial selection avoids reading distant sites again after its initial cache build', () => {
  let reads = 0;
  const distant = distantLifts().map(original => ({ ...original, get x() { reads++; return original.x; } }));
  const world = indexedLiftWorld([...distant, { ...site }]);
  carryCityLift(world, rider(6), 6, 6 + TICK_DT);
  assert.ok(reads > 0, 'the initial index includes the whole generated collection');
  reads = 0;
  for (let i = 0; i < 20; i++) {
    const state = rider(6), contact = carryCityLift(world, state, 6, 6 + TICK_DT);
    landOnCityLift(world, state, 12.006, 6, 6 + TICK_DT, contact, false);
  }
  assert.equal(reads, 0, 'repeated carry and landing checks only inspect nearby sites');
});

test('lift spatial selection conservatively retains oversized decks without an unbounded grid', () => {
  const oversized = { ...site, hx: 100_000, hz: 100_000 }, world = indexedLiftWorld([...distantLifts(), oversized]);
  const state = rider(6); state.px = -90_000;
  assert.equal(carryCityLift(world, state, 6, 6 + TICK_DT)?.site, oversized);
});
