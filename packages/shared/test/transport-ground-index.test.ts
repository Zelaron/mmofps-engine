import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTransportPlan, transportGroundAt, type TransportPlan } from '@shared/transport';

function fixture() {
  const cities = [[-500, -512], [-412, -448], [-4600, -3700], [3500, 3700]].map(([x, z], id) =>
    ({ id, x, z, y: 20, seed: 1337, radius: 32, name: `Station ${id}` }));
  const plan = buildTransportPlan({ seed: 1337, cities, temples: [],
    sampleHeight: (x, z) => 20 + Math.sin(x * .01) * 7 + Math.cos(z * .01) * 5 });
  // A distinct plan is deliberately unregistered and uses the original full
  // scan. Freeze its grading data so the comparison cannot drift with edits.
  const reference: TransportPlan = { ...plan,
    stations: plan.stations.map(station => ({ ...station })),
    accesses: plan.accesses.map(access => ({ ...access, profile: access.profile.map(point => ({ ...point })) })) };
  for (const station of reference.stations) Object.freeze(station);
  for (const access of reference.accesses) {
    for (const point of access.profile) Object.freeze(point);
    Object.freeze(access.profile); Object.freeze(access);
  }
  Object.freeze(reference.stations); Object.freeze(reference.accesses); Object.freeze(reference);
  return { plan, reference };
}

test('indexed transport grading exactly matches frozen full scans at station and signed cell boundaries', () => {
  const { plan, reference } = fixture();
  const offsets = [-114.000001, -114, -113.999999, -72, -42, 0, 42, 72, 113.999999, 114, 114.000001];
  for (const station of plan.stations) {
    const xs = offsets.map(offset => station.x + 80 + offset), zs = offsets.map(offset => station.z + 80 + offset);
    for (const edge of [-256, 0, 256]) {
      xs.push(Math.floor(station.x / 256) * 256 + edge - 1e-8, Math.floor(station.x / 256) * 256 + edge + 1e-8);
      zs.push(Math.floor(station.z / 256) * 256 + edge - 1e-8, Math.floor(station.z / 256) * 256 + edge + 1e-8);
    }
    for (const x of xs) for (const z of zs) for (const base of [-50, 37.125, 250])
      assert.deepEqual(transportGroundAt(plan, x, z, base), transportGroundAt(reference, x, z, base), `${x},${z}; base ${base}`);
  }
});

test('indexed transport access feathers and profile segments preserve exact graded heights', () => {
  const { plan, reference } = fixture();
  for (const access of plan.accesses) {
    const zs = [access.startZ - 256.000001, access.startZ - 256, access.startZ - 255.999999,
      access.startZ, access.startZ + .001, (access.startZ + access.endZ) / 2,
      access.endZ - .001, access.endZ, access.endZ + 255.999999, access.endZ + 256, access.endZ + 256.000001];
    for (const point of access.profile) zs.push(point.z - 1e-7, point.z, point.z + 1e-7);
    for (const dx of [-270.000001, -270, -269.999999, -100, -14, 0, 14, 100, 269.999999, 270, 270.000001])
      for (const z of zs) for (const base of [-300, 15, 300]) {
        const x = access.x + dx;
        assert.deepEqual(transportGroundAt(plan, x, z, base), transportGroundAt(reference, x, z, base), `${access.stationId}: ${x},${z}; base ${base}`);
      }
  }
});

test('overlapping transport grades retain source ordering and cell memoization never caches the supplied base height', () => {
  const { plan, reference } = fixture();
  const reversed = { ...reference, stations: [...reference.stations].reverse(), accesses: [...reference.accesses].reverse() };
  let orderMatters = false;
  for (let x = -200; x <= 60; x += 10) for (let z = -440; z <= -200; z += 10) {
    const expected = transportGroundAt(reference, x, z, 100);
    assert.deepEqual(transportGroundAt(plan, x, z, 100), expected);
    if (expected?.height !== transportGroundAt(reversed, x, z, 100)?.height) orderMatters = true;
  }
  assert.ok(orderMatters, 'the fixture exercises order-dependent overlapping clearings');
  const access = plan.accesses[2], x = access.x + 100, z = (access.startZ + access.endZ) / 2;
  const low = transportGroundAt(plan, x, z, -300), high = transportGroundAt(plan, x, z, 300);
  assert.notEqual(low?.height, high?.height, 'repeating one cell with a different base retains its different grade');
  assert.deepEqual(low, transportGroundAt(reference, x, z, -300));
  assert.deepEqual(high, transportGroundAt(reference, x, z, 300));
});

test('custom mutable transport plans continue to reflect moved, added and removed grading sites immediately', () => {
  const plan: TransportPlan = { stations: [{ id: 1, name: 'Fixture', kind: 'forest', x: 0, y: 25, z: 0, railY: 320, airlift: true }],
    accesses: [], routes: [], harbors: [], bridges: [], solids: [], pods: [], lifts: [] };
  assert.deepEqual(transportGroundAt(plan, 80, 80, 0), { height: 24.94, weight: 1 });
  plan.stations[0].x = 1000;
  assert.equal(transportGroundAt(plan, 80, 80, 0), undefined);
  plan.stations.push({ ...plan.stations[0], id: 2, x: 0, y: 40 });
  assert.deepEqual(transportGroundAt(plan, 80, 80, 0), { height: 39.94, weight: 1 });
  plan.stations.splice(1, 1);
  assert.equal(transportGroundAt(plan, 80, 80, 0), undefined);
});

test('queries outside native transport footprints do not repeatedly inspect every grading site', () => {
  const { plan } = fixture();
  let reads = 0;
  for (const site of [...plan.stations, ...plan.accesses]) {
    const x = site.x;
    Object.defineProperty(site, 'x', { get: () => { reads++; return x; }, configurable: true });
  }
  for (let i = 0; i < 100; i++) assert.equal(transportGroundAt(plan, -20_000 + i * .1, 20_000, i), undefined);
  assert.equal(reads, 0, 'the native broadphase rejects wilderness without reading station/access coordinates');
});

test('station blend has exact ordered half-weight grades and independent public results', () => {
  const station = { id: 1, name: 'Blend fixture', kind: 'forest' as const,
    x: -80, y: .06, z: -80, railY: 320, airlift: true };
  const plan: TransportPlan = {
    // At (0, 0), these clearings have weights 1, 1/2 and 0 respectively.
    // The first two floors are exactly 0 and 2; the zero-weight floor is ignored.
    stations: [station, { ...station, id: 2, x: -2, y: 2.06 }, { ...station, id: 3, x: 34, y: 999 }],
    accesses: [], routes: [], harbors: [], bridges: [], solids: [], pods: [], lifts: [],
  };
  const first = transportGroundAt(plan, 0, 0, 4), second = transportGroundAt(plan, 0, 0, 4);
  assert.deepEqual(first, { height: 1, weight: 1 });
  assert.deepEqual(second, { height: 1, weight: 1 });
  assert.ok(first && second);
  assert.notEqual(first, second, 'each public query owns its result');
  first.height = 999; first.weight = -1;
  Object.freeze(second);
  assert.deepEqual(transportGroundAt(plan, 0, 0, 4), { height: 1, weight: 1 });
  assert.deepEqual(second, { height: 1, weight: 1 }, 'later calls and other result mutations cannot change it');
  plan.stations.reverse();
  assert.deepEqual(transportGroundAt(plan, 0, 0, 4), { height: 0, weight: 1 });
});
