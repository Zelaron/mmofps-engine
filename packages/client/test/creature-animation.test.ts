import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WildlifeModels } from '../src/render/wildlife.js';
import { CREATURE_DEFS, type CreatureState } from '@shared/wildlife';

const WANDER = (species: number) => species === 3 ? 1.35 : species === 5 ? .45 : .85;
const matrix = new THREE.Matrix4(), point = new THREE.Vector3(), sphere = new THREE.Sphere();
const mesh = (models: WildlifeModels, name: string) => models.group.getObjectByName(name) as THREE.InstancedMesh;
const speciesMeshes = (models: WildlifeModels, species: number) =>
  models.group.children.filter(object => object.name.startsWith(`creature-${species}-`)) as THREE.InstancedMesh[];
const tracks = (models: WildlifeModels) => (models as unknown as { tracks: Map<number, { phase: number; x: number; z: number }> }).tracks;

/** Server-like motion: 10 Hz AI steps, 30 Hz snapshots, 60 fps rendering. */
function drive(models: WildlifeModels, state: CreatureState, speed: number, frames: number, tick: { value: number },
  each?: (frame: number) => void): void {
  for (let frame = 0; frame < frames; frame++) {
    tick.value++;
    if (tick.value % 6 === 0) { state.z -= speed * .1; state.speed = speed; }
    if (tick.value % 2 === 0) models.sync([{ ...state }], tick.value);
    models.update(1 / 60, tick.value);
    each?.(frame);
  }
}
function lowestPoint(models: WildlifeModels, species: number): number {
  let lowest = Infinity;
  for (const part of speciesMeshes(models, species)) {
    const positions = part.geometry.getAttribute('position');
    for (let i = 0; i < part.count; i++) {
      part.getMatrixAt(i, matrix);
      for (let v = 0; v < positions.count; v++) lowest = Math.min(lowest, point.fromBufferAttribute(positions, v).applyMatrix4(matrix).y);
    }
  }
  return lowest;
}

test('planted feet do not skate while the body walks and runs', () => {
  for (const [species, speed] of [[0, WANDER(0)], [0, 5], [1, 5.5], [3, WANDER(3)], [3, 7.4], [4, 4.3], [6, 2.6], [7, 6.3], [8, WANDER(8)]]) {
    const models = new WildlifeModels(), tick = { value: 0 };
    try {
      const state: CreatureState = { id: 40 + species, species, x: 3, y: 0, z: 0, yaw: 0, speed: 0, alert: false };
      const feet = mesh(models, `creature-${species}-foot`);
      drive(models, state, speed, 120, tick);
      const history: THREE.Vector3[][] = [];
      drive(models, state, speed, 180, tick, () => {
        const frame: THREE.Vector3[] = [];
        for (let i = 0; i < feet.count; i++) { feet.getMatrixAt(i, matrix); frame.push(new THREE.Vector3().setFromMatrixPosition(matrix)); }
        history.push(frame);
      });
      const ground = Math.min(...history.flat().map(p => p.y));
      let planted = 0, slip = 0, frames = 0;
      for (let f = 1; f < history.length; f++) for (let i = 0; i < feet.count; i++) {
        frames++;
        const a = history[f - 1][i], b = history[f][i];
        if (a.y > ground + .004 || b.y > ground + .004) continue;
        planted++; slip += Math.hypot(b.x - a.x, b.z - a.z);
      }
      const travel = speed / 60;
      assert.ok(planted / frames > .2, `species ${species} at ${speed} m/s keeps feet on the ground part of the cycle`);
      assert.ok(slip / planted < travel * .2, `species ${species} at ${speed} m/s: planted feet slide ${(slip / planted).toFixed(4)} m/frame vs body ${travel.toFixed(4)}`);
    } finally { models.dispose(); }
  }
});

test('gait cadence and stride length both grow with speed', () => {
  const rate = (speed: number) => {
    const models = new WildlifeModels(), tick = { value: 0 };
    try {
      const state: CreatureState = { id: 5, species: 0, x: 0, y: 0, z: 0, yaw: 0, speed: 0, alert: false };
      drive(models, state, speed, 120, tick);
      const track = tracks(models).get(5)!, phase = track.phase, z = track.z;
      drive(models, state, speed, 120, tick);
      const cycles = (track.phase - phase) / (Math.PI * 2), metres = Math.abs(track.z - z);
      return { cadence: cycles / 2, stride: metres / cycles };
    } finally { models.dispose(); }
  };
  const walk = rate(WANDER(0)), run = rate(5);
  assert.ok(run.cadence > walk.cadence * 1.4, 'faster travel steps more often');
  assert.ok(run.stride > walk.stride * 1.5, 'faster travel takes longer strides');
});

test('deaths collapse over time onto the ground and then stay still', () => {
  const models = new WildlifeModels();
  try {
    const alive = CREATURE_DEFS.map((_def, species) => ({ id: 200 + species, species, x: species * 60, y: 5, z: 0, yaw: .3, speed: 0, alert: false }));
    models.sync(alive); models.update(1 / 60);
    const standing = CREATURE_DEFS.map((_def, species) => lowestPoint(models, species));
    models.sync(alive.map(c => ({ ...c, dead: true }))); models.update(.1);
    const torso = (species: number) => {
      const body = mesh(models, `creature-${species}-body`) ?? mesh(models, `creature-${species}-pelvis`);
      const pose = new THREE.Matrix4(); body.getMatrixAt(0, pose); return pose;
    };
    const early = CREATURE_DEFS.map((_def, species) => torso(species));
    for (let i = 0; i < 12; i++) models.update(.1);
    const up = new THREE.Vector3(), settledUp = new THREE.Vector3(), earlyAt = new THREE.Vector3();
    for (let species = 0; species < CREATURE_DEFS.length; species++) {
      const scale = species === 9 ? 5.3 : species === 11 ? 6 : species === 13 ? 7 : species === 8 ? 1.5 : species === 12 ? 1.2 : 1.1;
      const lowest = lowestPoint(models, species) - 5;
      assert.ok(lowest > -.05 * scale && lowest < .12 * scale, `${CREATURE_DEFS[species].name} corpse rests on the ground (${lowest.toFixed(3)})`);
      assert.ok(Math.abs(standing[species] - 5) < .06 * scale, `${CREATURE_DEFS[species].name} stands on the ground (${(standing[species] - 5).toFixed(3)})`);
      // 0.1 s after death the body is still on its way down: not snapped to the final pose.
      const final = torso(species);
      up.setFromMatrixColumn(early[species], 1).normalize(); settledUp.setFromMatrixColumn(final, 1).normalize();
      const travel = earlyAt.setFromMatrixPosition(early[species]).distanceTo(point.setFromMatrixPosition(final));
      assert.ok(up.angleTo(settledUp) > .12 || travel > .03 * scale, `${CREATURE_DEFS[species].name} falls over time instead of snapping down`);
    }
    const settled = models.group.children.filter(o => o.name.startsWith('creature-')).map(o => (o as THREE.InstancedMesh).instanceMatrix.array.slice());
    for (let i = 0; i < 5; i++) models.update(.1);
    models.group.children.filter(o => o.name.startsWith('creature-')).forEach((o, i) =>
      assert.deepEqual((o as THREE.InstancedMesh).instanceMatrix.array, settled[i], 'corpses stay static once collapsed'));
  } finally { models.dispose(); }
});

test('a creature first seen dead is already collapsed', () => {
  const models = new WildlifeModels();
  try {
    models.sync([{ id: 9, species: 0, x: 0, y: 0, z: 0, yaw: 0, speed: 0, alert: false, dead: true }]); models.update(1 / 60);
    assert.ok(Math.abs(lowestPoint(models, 0)) < .12);
  } finally { models.dispose(); }
});

test('wind-ups raise the arms and alert predators lower their heads', () => {
  const models = new WildlifeModels();
  try {
    const brute = { id: 1, species: 8, x: 0, y: 0, z: 0, yaw: 0, speed: 0, alert: true };
    const stalker = { id: 2, species: 1, x: 20, y: 0, z: 0, yaw: 0, speed: 0, alert: false };
    const height = (name: string, index: number) => { mesh(models, name).getMatrixAt(index, matrix); return point.setFromMatrixPosition(matrix).y; };
    models.sync([brute, stalker]); for (let i = 0; i < 20; i++) models.update(.05);
    const relaxed = height('creature-8-forearm', 0), calm = height('creature-1-head', 0);
    models.sync([{ ...brute, windingUp: true }, { ...stalker, alert: true }]); for (let i = 0; i < 20; i++) models.update(.05);
    assert.ok(height('creature-8-forearm', 0) > relaxed + .8, 'the brute rears its fists overhead before slamming');
    assert.ok(height('creature-1-head', 0) < calm - .03, 'an alert stalker drops into a crouch');
  } finally { models.dispose(); }
});

test('every species stays inside its triangle and draw budget', () => {
  for (let species = 0; species < CREATURE_DEFS.length; species++) {
    const models = new WildlifeModels();
    try {
      models.sync([{ id: 1, species, x: 0, y: 0, z: 0, yaw: 0, speed: 0, alert: false }]); models.update(1 / 60);
      const visible = models.group.children.filter(o => o.visible && (o as THREE.InstancedMesh).count > 0) as THREE.InstancedMesh[];
      const triangles = visible.reduce((sum, m) => sum + m.count * (m.geometry.index ? m.geometry.index.count : m.geometry.getAttribute('position').count) / 3, 0);
      assert.ok(visible.length <= 10, `${CREATURE_DEFS[species].name} draws ${visible.length} meshes`);
      assert.ok(triangles < (CREATURE_DEFS[species].boss ? 6000 : 4000), `${CREATURE_DEFS[species].name} renders ${triangles} triangles`);
    } finally { models.dispose(); }
  }
});

test('culling spheres contain every animated part instance', () => {
  const models = new WildlifeModels(), tick = { value: 0 };
  try {
    // Overhead slams (Brute, both colossi) and raised claws reach furthest from the body.
    for (const species of [0, 3, 7, 8, 9, 11, 13]) {
      const state: CreatureState = { id: 70 + species, species, x: 1000, y: 40, z: -3000, yaw: 1, speed: 0, alert: true,
        windingUp: !!CREATURE_DEFS[species].windup };
      drive(models, state, CREATURE_DEFS[species].speed, 50, tick, () => {
        for (const part of speciesMeshes(models, species)) {
          part.geometry.computeBoundingSphere();
          for (let i = 0; i < part.count; i++) {
            part.getMatrixAt(i, matrix); sphere.copy(part.geometry.boundingSphere!).applyMatrix4(matrix);
            assert.ok(part.boundingSphere!.center.distanceTo(sphere.center) + sphere.radius <= part.boundingSphere!.radius + 1e-3,
              `${part.name} instance ${i} escapes its culling sphere`);
          }
        }
      });
      models.sync([]); models.update(1 / 60);
    }
  } finally { models.dispose(); }
});
