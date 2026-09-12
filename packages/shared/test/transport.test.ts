import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, capsuleClearance } from '@shared/index';
import { transportPose, transportBoxes, RAIL_HEIGHT, type TransportRoute } from '@shared/transport';
import { liquidFootprint, surfaceLiquidVolumes } from '@shared/liquids';

const outwardTime = (route: TransportRoute) => route.dwell + route.legs[0].length / route.speed + 3;

test('eight reachable terminals and bounded viaducts avoid the four city skylines in three seeds', () => {
  for (const seed of [1, 1337, 424242]) {
    const world = new World(seed), plan = world.collectTransportPlan();
    assert.equal(plan.stations.length, 8); assert.equal(plan.pods.length, 8); assert.equal(plan.lifts.length, 8);
    assert.equal(plan.routes.filter(r => r.kind === 'ferry').length, 4);
    assert.ok(plan.solids.length < 7500, `static geometry ${plan.solids.length}`);
    assert.ok(plan.solids.every(b => b.hy > 0 && b.hx > 0 && b.hz > 0));
    for (const pod of plan.pods) {
      assert.ok(capsuleClearance(world, pod.x, pod.y + .04, pod.z) >= -.01, `pod ${pod.id} obstructed`);
      assert.ok(world.sdf(pod.x, pod.y - .15, pod.z) < 0, 'pod is supported');
      assert.equal(world.column(pod.x, pod.z).transport, true);
    }
    for (const lift of plan.lifts) for (let y = lift.bottom; y <= lift.top; y += 5) {
      assert.ok(capsuleClearance(world, lift.x, y + .04, lift.z) >= -.01, `station shaft${lift.id}/${y}`);
    }
    for (const route of plan.routes.filter(r => r.kind === 'train')) for (let t = route.dwell; t < outwardTime(route); t += 2) {
      const p = transportPose(route, t);
      assert.equal(p.y, RAIL_HEIGHT);
      for (const c of world.collectCities()) assert.ok(Math.abs(p.x - c.x) > c.radius + 50 || Math.abs(p.z - c.z) > c.radius + 50, `train ${route.id} crosses ${c.name}`);
      assert.ok(p.y > world.column(p.x, p.z).h + 18, 'viaduct clears natural terrain');
    }
  }
});

test('ferry routes remain in actual liquid footprints and dock in their quay orientation', () => {
  const seed = 1337, world = new World(seed), plan = world.collectTransportPlan();
  for (const route of plan.routes.filter(r => r.kind === 'ferry')) {
    for (let t = route.dwell; t <= outwardTime(route); t += 1.5) {
      const p = transportPose(route, t), wet = surfaceLiquidVolumes().map(v => liquidFootprint(v, seed, p.x, p.z))
        .filter(v => v.kind === 'water' && v.distance < -26);
      assert.ok(wet.length > 0, `${route.name}: not enough wet clearance ${p.x},${p.z}`);
      assert.ok(wet.some(v => Math.abs(v.surfaceY - p.y) < .75), `${route.name}: wrong water level`);
      // A liquid footprint alone does not prove the channel is navigable:
      // river-bank grading once raised dry sand through the ocean here.
      for (const dx of [-13, 0, 13]) for (const dz of [-27, 0, 27]) {
        const x=p.x+Math.cos(p.yaw)*dx+Math.sin(p.yaw)*dz;
        const z=p.z-Math.sin(p.yaw)*dx+Math.cos(p.yaw)*dz;
        assert.ok(world.column(x,z).h < p.y-3, `${route.name}: seabed crosses moving hull at ${x},${z}`);
        assert.ok(world.sdf(x,p.y+2.2,z) > 0, `${route.name}: quay crosses moving deck at ${x},${z}`);
      }
    }
    for (const t of [0, outwardTime(route) + .01]) {
      const p = transportPose(route, t), stop = route.stops[p.nextStop === route.stops[1].id ? 0 : 1], harbor = plan.harbors.find(h => h.id === stop.id)!;
      assert.ok(p.docked); assert.ok(Math.hypot(p.x - harbor.x, p.z - harbor.z) < .01);
      assert.ok(Math.abs(Math.sin(p.yaw - harbor.heading)) < .001, `${route.name}: quay misses cargo side door`);
      for (const dx of [-10, 0, 10]) for (const dz of [-24, 0, 24]) {
        const x = p.x + Math.cos(p.yaw) * dx + Math.sin(p.yaw) * dz, z = p.z - Math.sin(p.yaw) * dx + Math.cos(p.yaw) * dz;
        assert.ok(capsuleClearance(world, x, p.y + 2.04, z) >= -.01, `${route.name}: shore structure crosses cargo deck`);
      }
    }
  }
});

test('train cars do not teleport or rotate through riders when the timetable reverses direction', () => {
  const plan = new World(1337).collectTransportPlan();
  for (const route of plan.routes) for (const offset of route.carOffsets) {
    const end = outwardTime(route), a = transportPose(route, end - .00001, offset), b = transportPose(route, end + .00001, offset);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) < .001, 'car location remains continuous at terminus');
    assert.ok(Math.abs(Math.sin(a.yaw - b.yaw)) < .001 && Math.cos(a.yaw - b.yaw) > .999, 'car orientation remains continuous');
    assert.equal(b.docked, true); assert.ok(Math.abs(b.departureIn - route.dwell) < .001);
    assert.deepEqual(transportPose(route, 400.25, offset), transportPose(route, 400.25, offset));
  }
});

test('moving decks are broad enough for vehicles and expose real cargo portals', () => {
  const plan = new World(1337).collectTransportPlan(), ferry = plan.routes[0], train = plan.routes.find(r => r.kind === 'train')!;
  const ferryBoxes = transportBoxes(ferry);
  for (const x of [-12.6, 12.6]) assert.ok(ferryBoxes.every(b => !(Math.abs(x - b.x) < b.hx && Math.abs(b.z) < b.hz && b.y + b.hy > 2.2 && b.y - b.hy < 6)), 'side loading door stays open');
  const deck = transportBoxes(train, 2).find(b => b.hx === 4.9 && b.hz === 12.5)!;
  assert.equal(deck.y + deck.hy, 1.2);
  assert.ok(transportBoxes(train, 2).some(b => b.x > 4.9 && b.y + b.hy === 1.2), 'boarding plates bridge the gap to platform');
});
