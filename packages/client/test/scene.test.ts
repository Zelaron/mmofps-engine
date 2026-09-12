import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { World } from '@shared/worldgen';
import {
  CAVE_FOG_FAR, CAVE_HORIZON_RADIUS, CAVE_MESH_RADIUS,
} from '@shared/constants';
import {
  CAVE_HORIZON_RENDER_ORDER, createCaveHorizon, configureCaveHorizon, SKY_RENDER_ORDER,
} from '../src/render/scene.js';
import {
  CAVE_PORTAL_RENDER_ORDER, CAVE_PORTAL_STENCIL_REF,
  createEntrancePortalMaterial,
} from '../src/render/cave-visibility.js';
import { meshColumnWithPortals } from '../src/render/surfacenets.js';

test('cave horizon preserves depth-visible canonical entrance pixels', () => {
  const horizon = createCaveHorizon();
  const terrain = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshLambertMaterial(),
  );
  const material = horizon.material;
  configureCaveHorizon(material, true);
  const portal = createEntrancePortalMaterial();

  assert.equal(material.transparent, false, 'horizon must use the opaque render pass');
  assert.equal(material.depthTest, true, 'near terrain must pass the horizon depth test');
  assert.equal(material.depthWrite, true, 'horizon must preserve the bounded cave cutoff');
  assert.equal(material.side, THREE.BackSide);
  assert.equal(material.fog, false);
  assert.equal(material.stencilWrite, true, 'stencil testing must be enabled');
  assert.equal(material.stencilWriteMask, 0, 'horizon must not alter portal marks');
  assert.equal(material.stencilRef, CAVE_PORTAL_STENCIL_REF);
  assert.equal(material.stencilFunc, THREE.NotEqualStencilFunc,
    'marked entrance pixels must keep the already-rendered sky/outside terrain');

  assert.equal(portal.colorWrite, false, 'portal caps are invisible');
  assert.equal(portal.depthTest, true, 'near cave terrain must occlude portal marks');
  assert.equal(portal.depthWrite, false, 'portal caps cannot become collision-like depth sheets');
  assert.equal(portal.side, THREE.DoubleSide);
  assert.equal(portal.stencilWrite, true);
  assert.equal(portal.stencilRef, CAVE_PORTAL_STENCIL_REF);
  assert.equal(portal.stencilFunc, THREE.AlwaysStencilFunc);
  assert.equal(portal.stencilZPass, THREE.InvertStencilOp);
  assert.equal(portal.stencilWriteMask, CAVE_PORTAL_STENCIL_REF);
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\nvoid main(){\n#include <project_vertex>\n}',
    fragmentShader:
      '#include <common>\nvoid main(){\n#include <clipping_planes_fragment>\n}',
  };
  (portal.onBeforeCompile as unknown as (s: typeof shader) => void)(shader);
  assert.equal(
    shader.uniforms.cavePortalMaxDistance?.value,
    CAVE_HORIZON_RADIUS,
    'caps must stop at the nearer cave-horizon sphere',
  );
  assert.match(shader.vertexShader, /vCavePortalViewPosition = mvPosition\.xyz/);
  assert.match(shader.fragmentShader,
    /length\(vCavePortalViewPosition\) >= cavePortalMaxDistance\) discard/);

  assert.equal(horizon.renderOrder, CAVE_HORIZON_RENDER_ORDER);
  assert.ok(SKY_RENDER_ORDER < horizon.renderOrder, 'horizon must be drawn after the sky');
  assert.ok(terrain.renderOrder < CAVE_PORTAL_RENDER_ORDER,
    'terrain depth must be present before entrance caps');
  assert.ok(CAVE_PORTAL_RENDER_ORDER < horizon.renderOrder,
    'entrance stencil must be present before the horizon');

  assert.equal(horizon.geometry.parameters.radius, CAVE_HORIZON_RADIUS,
    'horizon geometry must use the configured radius');
  assert.ok(CAVE_FOG_FAR < CAVE_HORIZON_RADIUS,
    'the backdrop must begin beyond fully saturated fog');
  assert.ok(CAVE_HORIZON_RADIUS < CAVE_MESH_RADIUS,
    'near cave terrain must extend behind the backdrop depth');

  horizon.geometry.dispose();
  material.dispose();
  portal.dispose();
  terrain.geometry.dispose();
  terrain.material.dispose();
});

test('entrance crossing parity protects sky on both sides of the surface envelope', () => {
  const horizon = createCaveHorizon();
  const portal = createEntrancePortalMaterial();
  const cases = [
    { label: 'ordinary outdoor sky', below: false, crossings: 0, occluded: false },
    { label: 'outside through entrance to distant cave cutoff', below: false, crossings: 1, occluded: true },
    { label: 'enclosed underground far direction', below: true, crossings: 0, occluded: true },
    { label: 'underground through exit to real sky', below: true, crossings: 1, occluded: false },
    { label: 'outside through entry and exit', below: false, crossings: 2, occluded: false },
    { label: 'underground exit followed by another entrance', below: true, crossings: 2, occluded: true },
  ];
  assert.equal(horizon.visible, true, 'exterior entrance rays also need a bounded horizon');
  for (const c of cases) {
    configureCaveHorizon(horizon.material, c.below);
    let stencil = 0;
    for (let i = 0; i < c.crossings; i++) {
      assert.equal(portal.stencilZPass, THREE.InvertStencilOp);
      stencil ^= portal.stencilWriteMask;
    }
    const equal = (stencil & horizon.material.stencilFuncMask) === horizon.material.stencilRef;
    const occluded = horizon.material.stencilFunc === THREE.EqualStencilFunc ? equal : !equal;
    assert.equal(occluded, c.occluded, c.label);
  }
  horizon.geometry.dispose();
  horizon.material.dispose();
  portal.dispose();
});

test('moving cave-horizon rays use the same radial depth as the entrance cutoff', () => {
  const horizon = createCaveHorizon();
  horizon.updateMatrixWorld();
  const camera = new THREE.PerspectiveCamera(92, 1.6, 0.08, 6000);
  const shader = { uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: '#include <common>\nvoid main(){\n#include <project_vertex>\n}',
    fragmentShader: '#include <common>\nvoid main(){\n#include <opaque_fragment>\n}' };
  (horizon.material.onBeforeCompile as unknown as (s: typeof shader) => void)(shader);
  assert.equal(shader.uniforms.caveHorizonRadius?.value, CAVE_HORIZON_RADIUS);
  assert.match(shader.fragmentShader, /normalize\(vCaveHorizonViewPosition\) \* caveHorizonRadius/);
  assert.match(shader.fragmentShader, /gl_FragDepth = \(sphereClip\.z \/ sphereClip\.w\) \* 0\.5 \+ 0\.5/);
  let previouslyWrong = 0;
  // Sweep the sightline through several dome facets, as a sideways-moving
  // exterior camera does. Its nearby terrain must occlude the dark backdrop
  // even when a visible entrance cap has set stencil for the same pixel.
  for (let x = -0.45; x <= 0.45; x += 0.03) {
    const direction = new THREE.Vector3(x, 0.16, -1).normalize();
    const facet = new THREE.Raycaster(new THREE.Vector3(), direction).intersectObject(horizon)[0];
    assert.ok(facet, 'the dome must cover every tested viewing direction');
    const groundDistance = CAVE_HORIZON_RADIUS - 2;
    if (facet.distance < groundDistance) previouslyWrong++;
    const project = (distance: number): number => {
      const p = direction.clone().multiplyScalar(distance).project(camera);
      return p.z * 0.5 + 0.5;
    };
    assert.ok(project(CAVE_HORIZON_RADIUS) > project(groundDistance),
      'analytic horizon depth must remain behind the exterior surface');
  }
  assert.ok(previouslyWrong > 20,
    `the regression must expose the original inward-facet mask error (${previouslyWrong} rays)`);
  horizon.geometry.dispose(); horizon.material.dispose();
});

test('moving past a seeded hillside entrance never lets the horizon cover nearer terrain', () => {
  const world = new World(1337);
  // Look west into the seeded hillside gallery at (-408, -488). Its first
  // wall is five metres beyond this ray's old dome facet; advancing the eye
  // therefore reproduces the original terrain-to-black flicker transition.
  const origin = new THREE.Vector3(22.281160271889917, 217.27660648437444, -447.1430584643754);
  const direction = new THREE.Vector3(-0.9694584179118516, -0.23267002029884437, -0.07755667343294813);
  assert.equal(world.roofedAbove(origin.x, origin.y, origin.z), false);
  const terrainMaterial = new THREE.MeshBasicMaterial({ side: THREE.FrontSide });
  const capMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const terrain: THREE.Mesh[] = [], caps: THREE.Mesh[] = [];
  const mesh = (positions: Float32Array, material: THREE.Material): THREE.Mesh =>
    new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(positions, 3)), material);
  // Include every traversed tile, so a closer cap or terrain face can reject
  // the witness exactly as depth testing does in the game.
  for (const [cx, cz] of [[0, -4], [-1, -4], [-2, -4], [-3, -4], [-4, -4]]) {
    const bundle = meshColumnWithPortals(world, cx, cz, true, 4);
    terrain.push(...bundle.chunks.map(c => mesh(c.positions, terrainMaterial)));
    caps.push(mesh(bundle.portals.positions, capMaterial));
  }
  const horizon = createCaveHorizon();
  const oldDepth = new THREE.Raycaster(new THREE.Vector3(), direction).intersectObject(horizon)[0].distance;
  assert.ok(oldDepth > CAVE_HORIZON_RADIUS - 15 && oldDepth < CAVE_HORIZON_RADIUS - 5,
    'the original dome facet is well inside its configured sphere');
  let oldOccluded = 0, oldVisible = 0;
  let initialHit: THREE.Vector3 | null = null;
  for (const advance of [0, 2, 4, 6, 8, 10]) {
    const eye = origin.clone().addScaledVector(direction, advance);
    const ray = new THREE.Raycaster(eye, direction, 0.01, CAVE_HORIZON_RADIUS);
    const hit = ray.intersectObjects(terrain)[0];
    assert.ok(hit, 'each moving sightline must hit real rendered terrain before the horizon');
    if (!initialHit) {
      initialHit = hit.point.clone();
      assert.ok(hit.distance > oldDepth + 4 && hit.distance < CAVE_HORIZON_RADIUS - 1,
        'the real wall must begin inside the horizon depth gap, not merely hit any nearby terrain');
    }
    assert.ok(hit.point.distanceTo(initialHit) < 0.01,
      'advancing the camera must keep testing the same actual terrain point');
    const crossings = ray.intersectObjects(caps).map(h => h.distance)
      .filter((distance, i, all) => distance < hit.distance && (i === 0 || distance - all[i - 1] > 1e-3));
    assert.equal(crossings.length, 1, 'a visible canonical entrance marks this actual terrain pixel');
    if (oldDepth < hit.distance) oldOccluded++; else oldVisible++;
    assert.ok(CAVE_HORIZON_RADIUS > hit.distance,
      'analytic sphere depth must keep the nearer terrain visible throughout the camera movement');
  }
  assert.ok(oldOccluded > 0 && oldVisible > 0,
    'the same real terrain must change from masked to visible with the original faceted depth');
  for (const object of [...terrain, ...caps, horizon]) object.geometry.dispose();
  terrainMaterial.dispose(); capMaterial.dispose(); horizon.material.dispose();
});
