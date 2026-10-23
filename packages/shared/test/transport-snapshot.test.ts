import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, TRANSPORT_SNAPSHOT_VERSION, type TransportSnapshot } from '@shared/worldgen';
import { restoreTransportPlan, transportGroundAt, type TransportPlan } from '@shared/transport';

const sources = new Map<number, { world: World; snapshot: TransportSnapshot }>();
function source(seed = 1337) {
  let value = sources.get(seed);
  if (!value) {
    const world = new World(seed), snapshot = world.transportSnapshot()!;
    assert.ok(snapshot); value = { world, snapshot }; sources.set(seed, value);
  }
  return value;
}

test('native transport snapshots adopt all three planets with exact grading and indexed bridge/solid geometry', () => {
  for (const seed of [1337, 7331, 20077]) {
    const { world, snapshot } = source(seed), adopted = new World(seed, snapshot);
    assert.equal(snapshot.version, TRANSPORT_SNAPSHOT_VERSION);
    const restored = restoreTransportPlan(snapshot.plan);
    assert.ok(restored, 'native generated plans qualify for reuse');
    const plan = adopted.collectTransportPlan(); assert.deepEqual(plan, world.collectTransportPlan());
    assert.notEqual(plan, snapshot.plan);
    for (const station of plan.stations) for (const dx of [-35, 0, 80, 194]) {
      const x = station.x + dx, z = station.z + 80;
      assert.deepEqual(adopted.column(x, z), world.column(x, z));
      assert.deepEqual(transportGroundAt(plan, x, z, 37), transportGroundAt(world.collectTransportPlan(), x, z, 37));
    }
    for (const access of plan.accesses) {
      const z = (access.startZ + access.endZ) / 2;
      assert.deepEqual(adopted.column(access.x, z), world.column(access.x, z));
    }
    for (const box of plan.solids.filter((_, i) => i % 997 === 0)) for (const y of [box.y, box.y + box.hy + .01])
      assert.equal(adopted.sdf(box.x, y, box.z), world.sdf(box.x, y, box.z));
    for (const bridge of plan.bridges.filter((_, i) => i % 509 === 0)) {
      const x = bridge.corners.reduce((sum, p) => sum + p.x, 0) / 4, z = bridge.corners.reduce((sum, p) => sum + p.z, 0) / 4;
      assert.equal(adopted.sdf(x, bridge.top - .01, z), world.sdf(x, bridge.top - .01, z));
    }
  }
});

test('two Worlds given one snapshot privately clone it and preserve internal route aliases', () => {
  const { world, snapshot } = source(), a = new World(1337, snapshot), b = new World(1337, snapshot);
  const first = a.collectTransportPlan(), second = b.collectTransportPlan();
  assert.notEqual(first, second); assert.notEqual(first.solids[0], second.solids[0]);
  assert.equal(first.routes[0].legs[0].from, first.routes[0].stops[0], 'within-plan aliases survive structured cloning');
  assert.deepEqual(second, snapshot.plan);
  first.stations[0].x += 1000; first.routes[0].legs[0].points[0].x += 1000;
  assert.deepEqual(second, world.collectTransportPlan()); assert.deepEqual(snapshot.plan, world.collectTransportPlan());
  const again = b.transportSnapshot()!; again.plan.stations[0].name = 'local mutation';
  assert.notEqual(second.stations[0].name, again.plan.stations[0].name);
  assert.equal((a as unknown as { pendingTransportSnapshot?: unknown }).pendingTransportSnapshot, undefined);
});

test('World actually adopts a valid snapshot instead of silently regenerating an equal native plan', () => {
  const { world, snapshot } = source(), marked = structuredClone(snapshot);
  const nativeName = marked.plan.stations[0].name;
  marked.plan.stations[0].name = `Adopted snapshot: ${nativeName}`;
  const receiver = new World(1337, marked), plan = receiver.collectTransportPlan();
  assert.equal(plan.stations[0].name, marked.plan.stations[0].name,
    'canonical regeneration cannot reproduce the snapshot-only metadata marker');
  assert.notEqual(plan, marked.plan, 'adoption still creates a private clone');
  assert.equal(snapshot.plan.stations[0].name, nativeName);
  assert.equal(world.collectTransportPlan().stations[0].name, nativeName);
  assert.deepEqual(plan.solids, snapshot.plan.solids, 'the marker leaves canonical geometry unchanged');
});

test('snapshot adoption stays lazy and changed providers retain canonical generation', () => {
  const { snapshot } = source(), expected = new World(1337), actual = new World(1337, snapshot);
  assert.equal((actual as unknown as { transportPlan?: unknown }).transportPlan, undefined);
  const inject = (world: World) => {
    const cities = world.collectCities;
    world.collectCities = () => cities.call(world).map(city => ({ ...city, name: `Injected ${city.name}` }));
  };
  inject(expected); inject(actual);
  assert.equal(actual.transportSnapshot(), undefined);
  assert.deepEqual(actual.collectTransportPlan(), expected.collectTransportPlan());
  assert.notEqual(actual.collectTransportPlan().stations[0].name, snapshot.plan.stations[0].name);
  assert.equal((actual as unknown as { pendingTransportSnapshot?: unknown }).pendingTransportSnapshot, undefined);
});

test('restoring providers cannot certify an injected cached plan or bypass the saved native guard', () => {
  const world = new World(1337), cities = world.collectCities;
  world.collectCities = () => cities.call(world).map(city => ({ ...city, name: `Injected ${city.name}` }));
  world.collectTransportPlan(); world.collectCities = cities;
  assert.equal(world.transportSnapshot(), undefined);
  const bypass = new World(1337, source().snapshot);
  // Structural cast only: production calls the saved function, not this
  // replaced virtual method, so it still notices the provider override.
  (bypass as unknown as { nativeTransportProviders: () => boolean }).nativeTransportProviders = () => true;
  assert.equal(bypass.transportSnapshot(), undefined);
});

test('wrong seed, wrong generator revision and malformed snapshots fall back without partial published indexes', () => {
  const { snapshot } = source();
  const cases: TransportSnapshot[] = [
    { ...snapshot, seed: 7331, plan: undefined as unknown as TransportPlan },
    { ...snapshot, version: TRANSPORT_SNAPSHOT_VERSION + 1, plan: undefined as unknown as TransportPlan },
    { ...snapshot, plan: undefined as unknown as TransportPlan },
    { ...snapshot, plan: { ...snapshot.plan, solids: new Array(1) } },
    { ...snapshot, plan: { ...snapshot.plan, bridges: new Array(1) } },
  ];
  for (const payload of cases) {
    const world = new World(1337, payload);
    assert.deepEqual(world.collectTransportPlan(), snapshot.plan);
    assert.deepEqual(world.column(-1280, 2080), source().world.column(-1280, 2080));
    const box = snapshot.plan.solids[0];
    assert.equal(world.sdf(box.x, box.y, box.z), source().world.sdf(box.x, box.y, box.z));
  }
});

test('restoration rejects sparse nested data, nonfinite or unbounded index extents and uncloneable values', () => {
  const { snapshot } = source();
  const invalid: TransportPlan[] = [
    { ...snapshot.plan, routes: new Array(1) },
    { ...snapshot.plan, solids: [{ ...snapshot.plan.solids[0], x: Infinity }] },
    { ...snapshot.plan, solids: [{ ...snapshot.plan.solids[0], hx: 1e12 }] },
    { ...snapshot.plan, bridges: [{ ...snapshot.plan.bridges[0], corners: new Array(4) }] },
    { ...snapshot.plan, routes: [{ ...snapshot.plan.routes[0], legs: [{ ...snapshot.plan.routes[0].legs[0], points: new Array(2) }, snapshot.plan.routes[0].legs[1]] }] },
    { ...snapshot.plan, accesses: [{ ...snapshot.plan.accesses[0], profile: new Array(2) }] },
    { ...snapshot.plan, extra: () => undefined } as TransportPlan,
  ];
  for (const plan of invalid) assert.equal(restoreTransportPlan(plan), undefined);
});
