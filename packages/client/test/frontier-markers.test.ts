import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { FACTIONS, type FrontierState, type Territory } from '@shared/frontier';
import { FrontierMarkers } from '../src/render/frontier.js';

function fixture(): FrontierState {
  const center: Territory = { id: 'city-control', name: 'City exchange', kind: 'city',
    x: 120, y: 8, z: -300, radius: 42, owner: 1, influence: 1, contested: false, baseId: 'city' };
  return { revision: 1, you: { faction: 1, salvage: 0, discoveries: [], factionCooldown: 0 }, nearby: [],
    territories: [center, { ...center, id: 'approach', name: 'West approach', kind: 'relay', x: -100, radius: 30, owner: 3 }],
    bases: [{ id: 'city', name: 'City', kind: 'city', x: center.x, y: center.y, z: center.z,
      owner: 2, homeFaction: 2, controlIds: ['city-control', 'approach'], requiredPoints: 2 }] };
}

function renderedBoundaryRadius(group: THREE.Object3D): number {
  group.updateWorldMatrix(true, true);
  const ring = group.getObjectByName('capture-boundary') as THREE.Mesh;
  const vertices = ring.geometry.getAttribute('position'), position = new THREE.Vector3(), center = new THREE.Vector3();
  group.getWorldPosition(center);
  let radius = 0;
  for (let i = 0; i < vertices.count; i++) {
    position.fromBufferAttribute(vertices, i).applyMatrix4(ring.matrixWorld);
    radius = Math.max(radius, Math.hypot(position.x - center.x, position.z - center.z));
  }
  return radius;
}

test('a base and its center control share one world capture marker even when their owners differ', () => {
  const state = fixture(), markers = new FrontierMarkers();
  markers.receive(state);
  assert.equal(markers.group.children.length, state.territories.length, 'strategic bases must not add stacked capture circles or flags');
  const center = markers.group.getObjectByName('city-control')!;
  assert.ok(center);
  assert.equal(center.children.filter(child => (child as THREE.Mesh).geometry instanceof THREE.RingGeometry).length, 1);
  const expected = new THREE.Color(FACTIONS[1].color).getHex();
  for (const child of center.children) assert.equal(((child as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex(), expected);
  state.bases![0].owner = 3;
  markers.receive(state);
  assert.equal(markers.group.children.length, 2);
  for (const child of center.children) assert.equal(((child as THREE.Mesh).material as THREE.MeshBasicMaterial).color.getHex(), expected,
    'capturing the wider base must not repaint a still-held center control');
});

test('a refreshed control boundary follows its real radius, position and owner without duplicating geometry', () => {
  const state = fixture(), markers = new FrontierMarkers();
  markers.receive(state);
  const site = state.territories[0], group = markers.group.getObjectByName(site.id)!;
  const ring = group.getObjectByName('capture-boundary') as THREE.Mesh, geometry = ring.geometry;
  assert.ok(Math.abs(renderedBoundaryRadius(group) - 42) < .001);
  Object.assign(site, { x: 260, y: 12, z: -350, radius: 27, owner: 2 });
  markers.receive(state);
  assert.strictEqual(markers.group.getObjectByName(site.id), group);
  assert.strictEqual(ring.geometry, geometry, 'state refresh reuses the shared marker geometry');
  assert.deepEqual(group.position.toArray(), [260, 12, -350]);
  assert.ok(Math.abs(renderedBoundaryRadius(group) - 27) < .001, 'the visible edge must match the server capture boundary after a radius change');
  assert.equal((ring.material as THREE.MeshBasicMaterial).color.getHex(), new THREE.Color(FACTIONS[2].color).getHex());
});

test('removed controls leave no ghost markers when the strategic base still exists', () => {
  const state = fixture(), markers = new FrontierMarkers();
  markers.receive(state);
  const removed = markers.group.getObjectByName('city-control')!;
  state.territories = state.territories.slice(1);
  markers.receive(state);
  assert.equal(removed.parent, null);
  assert.deepEqual(markers.group.children.map(group => group.name), ['approach']);
  markers.update(-100, -300, 2);
  assert.equal(markers.group.children[0].visible, true);
  markers.update(5000, 5000, 3);
  assert.equal(markers.group.children[0].visible, false);
  state.territories = [];
  markers.receive(state);
  assert.equal(markers.group.children.length, 0, 'a base without reported controls never invents a capture zone');
});
