// Actual main-frame source with real Prediction/SceneMgr preparation and recovery.
// No browser, live server, production mutation, renderer constructor or GL work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';
import * as THREE from 'three';
import { World, PLAYER, TICK_RATE, clamp, createFullAmmoLoadout,
  type InputCmd, type Snapshot } from '@shared/index';
import { Prediction } from '../src/prediction.js';
import { SceneMgr, createSky } from '../src/render/scene.js';
import { ShaderPreparation } from '../src/render/shader-preparation.js';
import { CLOSE_OUTDATED } from '../src/net.js';

const candidate = readFileSync('packages/client/src/main.ts', 'utf8').replaceAll('\r\n', '\n');
// Keep the historical failing baseline local to this regression. The current
// production path is executed directly; only the exact reviewed latch is undone.
const latch = [
  '  // A frame-local clock reset retains the authoritative pose already used',
  '  // to place this frame\'s camera; it must not prevent initial shader work.',
  '  const frameHasSnapshot = !!pred?.initialized;',
].join('\n') + '\n';
const predictionBranch = '  if (pred && pred.initialized) {';
const latchedRender = '    sceneMgr.render(frameHasSnapshot);';
const legacyRender = '    sceneMgr.render(!!pred?.initialized);';
assert.equal(candidate.split(latch).length, 2, 'One exact frame-local latch');
assert.equal(candidate.split(predictionBranch).length, 2, 'One prediction branch');
assert.equal(candidate.includes(latch + predictionBranch), true, 'Latch precedes frame prediction');
assert.equal(candidate.split(latchedRender).length, 2, 'One latched presentation call');
assert.equal(candidate.includes(legacyRender), false);
const original = candidate.replace(latch, '').replace(latchedRender, legacyRender);
assert.equal(original.includes('frameHasSnapshot'), false, 'No readiness latch remains in legacy source');
assert.equal(original.replace(predictionBranch, latch + predictionBranch)
  .replace(legacyRender, latchedRender), candidate, 'Exact reversible two-site legacy reconstruction');
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, from);
  const end = source.indexOf(to, start + from.length);
  assert.ok(end > start, to);
  return source.slice(start, end);
}
function line(source: string, text: string): string {
  const matches = source.split('\n').filter(value => value.trim() === text);
  assert.equal(matches.length, 1, text);
  return matches[0];
}
function sourceHarness(source: string): string {
  const main = source.replaceAll('\r\n', '\n');
  const prefix = between(main, 'function frame(): void {', '    // Camera.');
  assert.equal(prefix.includes('pred.hardResync();'), true);
  assert.equal(prefix.includes('guard < 3 && net.snapshotAgeMs < 500'), true);
  const pose = between(main, '    const rp = pred.renderPos();', '    const shake = effects.shake;');
  const camera = between(main, '    cam.position.set(\n      rp.x', '    input.setVehicleMode(pred.state.vehicle');
  const draw = between(main, '  if (!frontier?.open || !sceneMgr.renderStats.worldPresented',
    '  if (sceneMgr.renderStats.worldPresented !== overlayWorldPresented)');
  const close = between(main, '  onClose(code): void {', '\n  },\n});') + '\n  }';
  const recovery = between(main, '    if ((!wasInit && pred.initialized) || resyncVersion !== pred.resyncVersion) {',
    '    // Death/respawn overlay');
  const welcome = [
    line(main, 'interp.clearAll(); names.clear(); scores = []; predTick = -1; tickAccum = 0; seq = 1;'),
    line(main, 'world = new World(msg.seed);'),
    // onWelcome is the only exact assignment to false in this source.
    line(main, 'disconnected = false;'),
    line(main, 'sceneMgr.setWorldSeed(msg.seed);'),
    line(main, 'pred = new Prediction(world);'),
  ].join('\n');
  return `
    let world = new World(1337), pred = new Prediction(world);
    let predTick = -1, tickAccum = 0, seq = 1, fps = 60, lastFrame = 0, lastSceneDraw = -Infinity;
    let disconnected = false, reconnectStopped = false, reconnects = 0, clientOutdated = false;
    const CLOSE_OUTDATED = ${CLOSE_OUTDATED};
    let nearbyCreatures = [], latestFrontierState = null, resourceState = null, scores = [];
    const names = new Map(), inputs = [], pendingVehicleShots = { clear() {} };
    const chat = undefined, resourcesUI = undefined, airlift = undefined, camps = undefined;
    const frontier = { open: false, clearIntel() {} }, navigationMap = { clearIntel() {} };
    const wildlifeModels = { sync() {} }, resourceModels = { clear() {} }, pickupModels = { clear() {} };
    const artilleryFeedback = { clear() {} }, audio = { stopLift() {} }, interp = { clearAll() {} };
    const performance = { now: () => clock.now }, requestAnimationFrame = () => {};
    const vehicleEyeOffset = new THREE.Vector3(0, PLAYER.EYE_HEIGHT, 0), shake = 0;
    const net = { rttMs: 0, snapshotAgeMs: 0, estServerTick: () => clock.tick };
    const updateOverlay = () => {}, scheduleReconnect = () => { reconnects++; };
    const frameSections = { begin() {}, mark() {}, end() {} };
    function leadTicks() { return clamp(net.rttMs / (1000 / TICK_RATE) + 2, 2, 30); }
    function doPredictedTick() {
      const cmd = { seq: seq++, buttons: 0, weapon: 0, yaw: 0, pitch: 0, renderTick: clock.tick, renderFrac: 0 };
      inputs.push(cmd); pred.applyLocal(cmd);
    }
    ${prefix}
    ${pose}
    ${camera}
      }
    ${draw}
    }
    function receive(snap) {
      const wasInit = pred.initialized, resyncVersion = pred.resyncVersion;
      pred.onSnapshot(snap);
      ${recovery}
    }
    const handlers = { ${close} };
    function welcome(seed) { const msg = { seed }; ${welcome} }
    return { frame, receive, close: handlers.onClose, welcome,
      explicitReset() { pred.hardResync(); predTick = -1; tickAccum = 0; },
      get pred() { return pred; }, get inputs() { return inputs; },
      get disconnected() { return disconnected; }, get reconnects() { return reconnects; } };
  `;
}

function rendererBoundary() {
  const sky = createSky();
  let submissions = 0, draws = 0, ready = false;
  const preparation = new ShaderPreparation(() => { submissions++; }, () => ready);
  const info = { render: { calls: 0, triangles: 0 }, memory: { geometries: 0, textures: 0 }, programs: [],
    reset() { this.render.calls = 0; } };
  const manager: SceneMgr = Object.assign(Object.create(SceneMgr.prototype), {
    scene: new THREE.Scene(), camera: new THREE.PerspectiveCamera(), sky,
    caveHorizon: new THREE.Object3D(), atmosphereFog: new THREE.Fog(0x888888, 90, 4600),
    cityAtmosphere: { seed: 0, update() {} }, qualityMode: 'high',
    sun: new THREE.DirectionalLight(), lightDirection: new THREE.Vector3(),
    renderer: { info, getPixelRatio: () => 1 }, shaderPreparation: preparation,
    shaderCommands: { fallbackCount: 0 }, lastPlayable: false, worldPresented: false, contextLost: false,
    contactLighting: { active: false, render() { draws++; info.render.calls++; } },
  });
  return { manager, preparation, setReady(value: boolean) { ready = value; },
    get submissions() { return submissions; }, get draws() { return draws; },
    dispose() { sky.geometry.dispose(); sky.material.uniforms.cloudNoise.value.dispose(); sky.material.dispose(); } };
}
interface Harness {
  frame(): void; receive(snapshot: Snapshot): void; close(code: number): void;
  welcome(seed: number): void; explicitReset(): void;
  pred: Prediction; inputs: InputCmd[]; disconnected: boolean; reconnects: number;
}
function fixture(source: string) {
  const render = rendererBoundary(), clock = { now: 0, tick: 1000 };
  const body = transformSync('function createHarness() {\n' + sourceHarness(source) + '\n}',
    { loader: 'ts', target: 'es2022' }).code;
  const run = new Function('World', 'Prediction', 'THREE', 'PLAYER', 'TICK_RATE', 'clamp', 'sceneMgr', 'clock',
    body + '\nreturn createHarness();');
  const h = run(World, Prediction, THREE, PLAYER, TICK_RATE, clamp, render.manager, clock) as Harness;
  function receive(tick: number, x = 12): void {
    clock.tick = tick;
    h.receive({ tick, lastSeq: h.inputs.at(-1)?.seq ?? 0,
      you: { px: x, py: 400, pz: 20, vx: 0, vy: 0, vz: 0, grounded: false, alive: true,
        dodgeCd: 0, health: 100, weapon: 0, cooldown: 0, ammo: createFullAmmoLoadout(),
        reloadWeapon: -1, reloadCooldown: 0, reloadHeld: false, vehicle: 0,
        heading: 0, boostFuel: 1, vehicleHealth: 0, lockState: 0 }, ents: [] });
  }
  function slowFrame(seconds: number, x: number): void {
    // The first post-reset snapshot repairs predTick. Later snapshots keep
    // arriving normally while the RAF clock is delayed, as in the saved run.
    receive(clock.tick + 2, x);
    receive(clock.tick + seconds * 60, x);
    clock.now += seconds * 1000;
    h.frame();
  }
  return { h, render, clock, receive, slowFrame };
}

test('actual slow main-frame clock resets no longer starve real scene shader preparation', () => {
  const before = fixture(original), after = fixture(candidate);
  try {
    for (const f of [before, after]) { f.h.frame(); assert.equal(f.render.submissions, 0); }
    for (const [index, seconds] of [2, 4, 8, 16].entries()) {
      for (const f of [before, after]) {
        f.render.setReady(index >= 1); f.slowFrame(seconds, 12 + index);
        assert.equal(f.h.pred.initialized, false, 'hardResync remains unchanged');
        assert.deepEqual(f.render.manager.camera.position.toArray(),
          [f.h.pred.state.px, f.h.pred.state.py + PLAYER.EYE_HEIGHT, f.h.pred.state.pz]);
      }
      assert.deepEqual(after.h.pred.state, before.h.pred.state, 'identical actual shared movement');
      assert.deepEqual(after.h.pred.weaponState, before.h.pred.weaponState);
      assert.deepEqual(after.h.inputs, before.h.inputs, 'same three-input catch-up bound');
    }
    assert.equal(before.render.submissions, 0, 'baseline repeats render(false), never submitting shaders');
    assert.equal(before.render.draws, 0);
    assert.equal(after.render.submissions, 2, 'one batch then verification through real ShaderPreparation');
    assert.equal(after.render.draws, 3);
    assert.equal(after.render.manager.renderStats.worldPresented, true);
    assert.equal(after.h.inputs.length, 12);
  } finally { before.render.dispose(); after.render.dispose(); }
});

test('actual close callback retains the backdrop, while a following explicit reset revokes presentation', () => {
  const f = fixture(candidate);
  try {
    f.render.setReady(true); f.receive(1000); f.h.frame();
    assert.equal(f.render.draws, 1);
    f.h.close(4001); // Real onClose body: retain Prediction; no automatic reconnect.
    assert.equal(f.h.disconnected, true); assert.equal(f.h.reconnects, 0);
    assert.equal(f.h.pred.initialized, true);
    f.clock.now += 16; f.h.frame();
    assert.equal(f.render.draws, 2, 'existing disconnected-world backdrop policy is unchanged');
    f.h.explicitReset(); f.clock.now += 16; f.h.frame();
    assert.equal(f.render.draws, 2);
    assert.equal(f.render.manager.renderStats.worldPresented, false);
    assert.equal(f.render.preparation.pending, true);
    f.clock.now += 16; f.h.frame();
    assert.equal(f.render.draws, 2, 'latch does not survive the next frame');
  } finally { f.render.dispose(); }
});

test('actual welcome Prediction replacement and world invalidation require a new authoritative snapshot', () => {
  const f = fixture(candidate);
  try {
    f.render.setReady(true); f.receive(1000); f.h.frame();
    const old = f.h.pred, submissions = f.render.submissions, draws = f.render.draws;
    f.h.welcome(7331);
    assert.notEqual(f.h.pred, old); assert.equal(f.h.pred.initialized, false);
    assert.equal(f.render.manager.renderStats.worldPresented, false);
    for (let i = 0; i < 3; i++) { f.clock.now += 2000; f.h.frame(); }
    assert.equal(f.render.submissions, submissions); assert.equal(f.render.draws, draws);
    f.render.setReady(false); f.slowFrame(2, -200);
    assert.equal(f.render.submissions, submissions + 1);
    assert.equal(f.render.draws, draws, 'new world still waits for real shader preparation');
    f.render.setReady(true); f.slowFrame(4, -201);
    assert.equal(f.render.draws, draws + 1);
    assert.equal(f.render.manager.renderStats.worldPresented, true);
  } finally { f.render.dispose(); }
});
