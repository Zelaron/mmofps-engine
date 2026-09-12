import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutpostField, outpostCell, type Outpost } from '@shared/outposts';
import { OutpostReplica, type RegionalOutposts } from '../src/outpost-replica.js';

const bounds = { id: 'r0:0', minX: -1000, maxX: 0, minZ: -1000, maxZ: 1000 };
const site = (id: number, x = -20): Outpost => ({ id, owner: 1, faction: 1, type: 0, x, y: 10, z: 0, facing: 0 });
const view = (revision: number, sites: Outpost[] | null): RegionalOutposts => ({
  cursor: { authority: { id: 'west', epoch: 1 }, planet: 'meridian', region: bounds.id, layoutVersion: 2, revision }, bounds, sites,
});
function setup() {
  const field = new OutpostField(), replica = new OutpostReplica(field, { id: 'west', planet: 'meridian', region: bounds.id });
  replica.bind(1); replica.apply(view(0, [])); return { field, replica };
}
const commit = (replica: OutpostReplica, revision: number, location: Outpost, sites: Outpost[]) =>
  replica.commit({ key: outpostCell(location.x, location.z), revision, sites }, location);

test('an old regional snapshot cannot erase a newly committed wall', () => {
  const { field, replica } = setup(), built = site(1);
  commit(replica, 2, built, [built]);
  assert.equal(replica.apply(view(1, [])), true);
  assert.equal(field.sites.get(1), built);
  assert.equal(replica.cursor!.revision, 1, 'the rest of the region can advance while the newer wall is retained');
  assert.ok(field.distance(built.x, built.y, built.z, 100) < 0);
  assert.equal(replica.apply(view(2, [built])), true);
  assert.equal(replica.cursor!.revision, 2);
  assert.equal(replica.apply(view(2, null)), true);
});

test('independent delayed build receipts merge while removal tombstones prevent resurrection', () => {
  const { field, replica } = setup(), a = site(1), b = site(2, -200);
  commit(replica, 3, b, [b]); commit(replica, 2, a, [a]);
  assert.equal(field.sites.size, 2, 'a later reply for another module cannot discard the earlier commit');
  assert.equal(replica.apply(view(2, [a])), true);
  assert.equal(field.sites.size, 2);
  replica.apply(view(3, [a, b]));
  commit(replica, 4, a, []);
  assert.equal(commit(replica, 2, a, [a]), false);
  assert.equal(replica.apply(view(3, [a, b])), true);
  assert.equal(field.sites.has(a.id), false);
  replica.apply(view(4, [b]));
  assert.equal(commit(replica, 3, a, [a]), false, 'a newer complete snapshot also fences old callbacks');
  assert.equal(field.distance(a.x, a.y, a.z, 100) > 0, true);
});

test('a current snapshot outranks callbacks from a disconnected builder', () => {
  const { field, replica } = setup(), a = site(1), b = site(2, -40);
  replica.apply(view(6, [b]));
  assert.equal(commit(replica, 5, a, [a, b]), false);
  assert.equal(commit(replica, 4, b, []), false);
  assert.deepEqual([...field.sites.keys()], [b.id]);
});

test('neighbor modules participate in collision but their mutation receipts are rejected', () => {
  const { field, replica } = setup(), neighbor = site(1, .25);
  replica.apply(view(1, [neighbor]));
  assert.ok(field.distance(-.1, neighbor.y, neighbor.z, 100) < 0, 'the floor crosses the ownership seam');
  assert.throws(() => commit(replica, 2, neighbor, [neighbor]), /neighboring/);
  assert.throws(() => commit(replica, 2, neighbor, []), /neighboring/);
  replica.apply(view(2, []));
  assert.equal(field.distance(-.1, neighbor.y, neighbor.z, 100), 100, 'the owner can remove the replicated floor');
});

test('snapshot scope, baseline and complete geometry are validated before changing colliders', () => {
  const { field, replica } = setup(), a = site(1);
  replica.apply(view(1, [a]));
  const wrongEpoch = view(2, []); wrongEpoch.cursor.authority.epoch = 2;
  const wrongPlanet = view(2, []); wrongPlanet.cursor.planet = 'nacre';
  const wrongRegion = view(2, []); wrongRegion.cursor.region = 'r1:0';
  const changedLayout = view(2, []); changedLayout.cursor.layoutVersion++;
  for (const invalid of [wrongEpoch, wrongPlanet, wrongRegion, changedLayout, view(2, [site(2), site(2)]),
    view(2, [site(2, 1000)]), view(2, [site(2), { ...a, y: NaN }]), view(2, null)]) {
    assert.throws(() => replica.apply(invalid));
    assert.deepEqual([...field.sites.keys()], [a.id]);
  }
  const cold = new OutpostReplica(new OutpostField(), { id: 'west', planet: 'meridian', region: bounds.id });
  assert.throws(() => cold.apply(view(0, [])), /snapshot/);
  cold.bind(1); assert.throws(() => cold.apply(view(0, null)), /baseline/);
  assert.throws(() => cold.bind(2), /authority/);
});

test('large durable revisions remain exact and exposed cursors cannot alter the replica', () => {
  const { field, replica } = setup(), a = site(1), revision = Number.MAX_SAFE_INTEGER;
  replica.apply(view(revision - 1, []));
  commit(replica, revision, a, [a]);
  const cursor = replica.cursor!; cursor.revision = revision; cursor.authority.epoch = 500;
  assert.equal(replica.cursor!.revision, revision - 1);
  assert.equal(replica.cursor!.authority.epoch, 1);
  replica.apply(view(revision, [a]));
  assert.equal(field.sites.size, 1);
  assert.throws(() => commit(replica, revision + 1, a, []), /receipt/);
});

test('new snapshots preserve unchanged local cell stamps and invalidate actual geometry changes', () => {
  const { field, replica } = setup(), near = site(1), far = { ...site(2, -800), z: 800 };
  replica.apply(view(1, [near, far]));
  const stamp = field.stamp(near.x, near.z);
  replica.apply(view(2, [{ ...near }, { ...far }, { ...site(3, -900), z: 800 }]));
  assert.equal(field.stamp(near.x, near.z), stamp, 'distant changes cannot invalidate an unchanged local view');
  assert.equal(field.sites.get(near.id), near, 'unchanged colliders retain their identity');
  replica.apply(view(3, [{ ...near, facing: 1 }, far]));
  assert.notEqual(field.stamp(near.x, near.z), stamp);
  assert.equal(field.sites.has(3), false);
  assert.equal(field.sites.get(near.id)!.facing, 1);
});

test('a complete committed cell cannot resurrect an unseen module from an older full snapshot', () => {
  const { field, replica } = setup(), base = [site(10, -20), site(11, -40), site(12, -60)];
  const temporary = site(20, -90), built = site(30, -110);
  replica.apply(view(1, base));
  // A neighbor builds at revision 2, packs at 3, and this worker builds at 4.
  // The regional revision-2 response arrives only after the build receipt.
  commit(replica, 4, built, [...base, built]);
  assert.equal(replica.apply(view(2, [...base, temporary])), true);
  assert.equal(field.sites.has(temporary.id), false);
  assert.equal(field.sites.has(built.id), true);
  assert.equal(field.sites.size, 4, 'the old view cannot exceed the authoritative four-module cell budget');
  replica.apply(view(4, [...base, built]));
  assert.deepEqual([...field.sites.keys()], [...base.map(s => s.id), built.id]);
});

test('continuous construction cannot starve regional freshness acknowledgements', () => {
  const { field, replica } = setup();
  for (let i = 1; i <= 30; i++) {
    const built = site(i);
    commit(replica, i * 2, built, [built]);
    assert.equal(replica.apply(view(i * 2 - 1, [])), true, 'a fresh regional response can advance around a newer committed cell');
    assert.equal(replica.cursor!.revision, i * 2 - 1);
    assert.deepEqual([...field.sites.keys()], [built.id]);
  }
  replica.apply(view(60, [site(30)]));
  assert.equal(commit(replica, 2, site(1), [site(1)]), false);
});
