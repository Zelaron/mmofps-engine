import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '@shared/worldgen';
import { TransportRenderer, TRANSPORT_DRAW_BUDGET } from '../src/render/transport.js';
import { transportPose } from '@shared/transport';

test('nearby ferries, rail consists and stations share bounded geometry pools', () => {
  const world = new World(1337), plan = world.collectTransportPlan(), render = new TransportRenderer(world);
  const views = [...plan.stations.flatMap(s => [{ x: s.x + 80, y: s.y + 2, z: s.z + 80 }, { x: s.x, y: 322.8, z: s.z }]),
    ...plan.harbors.map(h => ({ x: h.x, y: h.y + 3.7, z: h.z }))];
  let maximumTriangles = 0;
  for (const view of views) for (const time of [0, 80, 180]) {
    render.update(time, view.x, view.y, view.z);
    assert.ok(render.stats.draws <= TRANSPORT_DRAW_BUDGET);
    maximumTriangles = Math.max(maximumTriangles, render.stats.triangles);
    render.group.traverse(object => {
      if (!(object instanceof THREE.InstancedMesh)) return;
      assert.ok(object.count <= object.instanceMatrix.count);
      assert.ok(object.instanceMatrix.array.every(Number.isFinite));
      assert.equal(object.geometry.groups.length <= 6, true);
    });
  }
  assert.ok(maximumTriangles < 180000, `whole network plus local detail ${maximumTriangles} triangles`);
  assert.ok(render.group.children.length <= 11, 'draw pools do not grow per station or carriage');
  render.update(0, -11000, 2000, 11000); assert.equal(render.stats.bodies, 0);
  assert.equal(render.stats.draws, 2, 'complete structural boxes and ribbons remain resident beyond the fog horizon');
  render.dispose(); assert.equal(render.group.children.length, 0);
});

test('all four train cars render at their individual deterministic poses, including return journeys', () => {
  const world = new World(1337), plan = world.collectTransportPlan(), route = plan.routes.find(r => r.kind === 'train')!;
  const render = new TransportRenderer(world), time = route.dwell + route.legs[0].length / route.speed + 45;
  const lead = transportPose(route, time); render.update(time, lead.x, lead.y + 5, lead.z);
  const matrix = new THREE.Matrix4(), actual = new THREE.Vector3();
  for (let car = 0; car < 4; car++) {
    const mesh = render.group.getObjectByName(`train-${car}`) as THREE.InstancedMesh;
    assert.ok(mesh.count > 0);
    mesh.getMatrixAt(0, matrix); actual.setFromMatrixPosition(matrix);
    const expected = transportPose(route, time, route.carOffsets[car]);
    assert.ok(actual.distanceTo(new THREE.Vector3(expected.x, expected.y, expected.z)) < .001);
  }
  assert.equal(render.group.getObjectByName('train-artillery'), undefined, 'mounted gun is owned by replicated vehicle renderer');
  render.dispose();
});

test('pod launch axes clear the visible entry arch and elevated platform at every terminal',()=>{
  const world=new World(1337),render=new TransportRenderer(world),plan=world.collectTransportPlan();
  try {
    for(const pod of plan.pods) {
      render.update(0,pod.x,pod.y+2,pod.z);render.group.updateMatrixWorld(true);
      const ray=new THREE.Raycaster(new THREE.Vector3(pod.x,pod.y+1.7,pod.z),new THREE.Vector3(0,1,0),0,340-pod.y);
      const hits=ray.intersectObjects(render.group.children,false);
      assert.equal(hits.length,0,`${pod.name}: launch passes through visible station geometry`);
    }
  }finally{render.dispose();}
});
