import * as THREE from 'three';
import { World } from '../../packages/shared/src/worldgen.js';
import { ChunkManager } from '../../packages/client/src/render/chunks.js';
import { SceneMgr } from '../../packages/client/src/render/scene.js';
import { SceneryStream, type SceneryData, type ScenerySource } from '../../packages/client/src/render/scenery-stream.js';
import { SceneryScheduler } from '../../packages/client/src/render/scenery-scheduler.js';
import { SCENERY_PROTECTED_DISTANCE } from '../../packages/client/src/render/scenery-readiness.js';
import { RockRenderer } from '../../packages/client/src/render/rocks.js';
import { VegetationRenderer } from '../../packages/client/src/render/vegetation.js';
import { StructureRenderer } from '../../packages/client/src/render/structures.js';
import { VesperCity } from '../../packages/client/src/render/vesper-city.js';

// Browser-only subsystem fixture. The camera follows canonical support; it
// deliberately does not claim to simulate jeep controls or server capacity.
const routeName = new URLSearchParams(location.search).get('route') ?? 'curved';
const warmRespawn = routeName === 'respawn-warm';
const respawn = routeName === 'respawn' || warmRespawn, curved = routeName !== 'abrupt';
const seed = 1337, duration = respawn ? 10.65 : 28;
const respawnStart = { x: -2982.702260770055, z: 2249.0824978198793 };
const respawnEnd = { x: -2896.815771355089, z: 2252.027399066521 };
const oldLocation = { x: -90.1407241821289, z: 8537.35546875, vx: 0, vz: 0, leg: -1 };
const speed = respawn ? Math.hypot(respawnEnd.x - respawnStart.x, respawnEnd.z - respawnStart.z) / duration : 81;
const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
const world = new World(seed);
world.collectTransportPlan();
const snapshot = world.transportSnapshot();
const city = world.collectCities().find(candidate => candidate.theme === 'vesper')!;
const scene = new SceneMgr(canvas);
scene.setWorldSeed(seed); scene.setCities(world.collectCities());
const chunks = new ChunkManager(seed, 0, 45_000, snapshot);
const stream = new SceneryStream(seed, undefined, true, snapshot);
let rockSource: SceneryData['rocks'] = [], rockChecks = 0, rockMismatch = 0;
const source: ScenerySource = {
  get failed() { return stream.failed; },
  read(kind, bounds) {
    const data = stream.read(kind, bounds);
    if (kind === 'rocks' && data) rockSource = data as SceneryData['rocks'];
    return data;
  },
};
const rocks = new RockRenderer(world, source, chunks, chunks.setSceneryGroundSupport.bind(chunks));
const vegetation = new VegetationRenderer(world, {}, source, chunks);
const structures = new StructureRenderer(world, {}, source);
const skyline = new VesperCity(world);
scene.scene.add(chunks.group, rocks.group, vegetation.group, structures.group, skyline.group);
const matrix = new THREE.Matrix4();
function checkRockY() {
  const expected = new Map(rockSource.map(({ rock }) =>
    [`${Math.fround(rock.x)},${Math.fround(rock.z)}`, Math.fround(rock.y)]));
  for (const mesh of rocks.group.children as THREE.InstancedMesh[]) {
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, matrix);
      const e = matrix.elements, y = expected.get(`${e[12]},${e[14]}`);
      rockChecks++;
      if (y === undefined || !Object.is(y, e[13])) rockMismatch++;
    }
  }
}
const scenery = new SceneryScheduler([
  (x, z) => vegetation.update(x, z),
  (x, z) => structures.update(x, z),
  (x, z) => { if (rocks.update(x, z)) checkRockY(); },
]);

// The route skirts Vesper's eastern terrain; the skyline stays beside the
// road-height camera. Two right-angle turns exercise stale in-flight work.
const start = respawn ? respawnStart : { x: city.x + city.radius * 1.06, z: city.z + city.radius * .25 };
function route(seconds: number) {
  const t = Math.max(0, Math.min(duration, seconds));
  if (respawn) {
    const vx = (respawnEnd.x - start.x) / duration, vz = (respawnEnd.z - start.z) / duration;
    return { x: start.x + vx * t, z: start.z + vz * t, vx, vz, leg: 0 };
  }
  if (curved) {
    // 0.30 rad/s changes heading by 90deg over 5.24s, a 270m
    // radius at 81m/s. Keep the abrupt route as an adverse diagnostic.
    const rate = .30, turn = Math.PI / (2 * rate), radius = speed / rate;
    if (t < 8) return { x: start.x, z: start.z - t * speed, vx: 0, vz: -speed, leg: 0 };
    if (t < 8 + turn) {
      const a = (t - 8) * rate;
      return { x: start.x + radius * (1 - Math.cos(a)), z: start.z - 8 * speed - radius * Math.sin(a),
        vx: speed * Math.sin(a), vz: -speed * Math.cos(a), leg: 1 };
    }
    if (t < 16 + turn) return { x: start.x + radius + (t - 8 - turn) * speed,
      z: start.z - 8 * speed - radius, vx: speed, vz: 0, leg: 2 };
    if (t < 16 + turn * 2) {
      const a = (t - 16 - turn) * rate;
      return { x: start.x + radius + 8 * speed + radius * Math.sin(a),
        z: start.z - 8 * speed - radius * Math.cos(a), vx: speed * Math.cos(a), vz: speed * Math.sin(a), leg: 3 };
    }
    return { x: start.x + 2 * radius + 8 * speed, z: start.z - 8 * speed + (t - 16 - 2 * turn) * speed,
      vx: 0, vz: speed, leg: 4 };
  }
  if (t < 10) return { x: start.x, z: start.z - t * speed, vx: 0, vz: -speed, leg: 0 };
  if (t < 18) return { x: start.x + (t - 10) * speed, z: start.z - 10 * speed, vx: speed, vz: 0, leg: 1 };
  return { x: start.x + 8 * speed, z: start.z - 10 * speed + (t - 18) * speed, vx: 0, vz: speed, leg: 2 };
}
function previewY(x: number, z: number) {
  // The actual preview uses these two linear triangles, not a bilinear patch.
  const x0 = Math.floor(x / 64) * 64, z0 = Math.floor(z / 64) * 64;
  const u = (x - x0) / 64, v = (z - z0) / 64;
  const a = world.column(x0, z0).h, b = world.column(x0 + 64, z0).h;
  const c = world.column(x0, z0 + 64).h, d = world.column(x0 + 64, z0 + 64).h;
  return u + v <= 1 ? a + u * (b - a) + v * (c - a) : d + (1 - u) * (c - d) + (1 - v) * (b - d);
}
function measureNonlinearity() {
  return Array.from({ length: 113 }, (_, i) => {
    const p = route(i * duration / 112), h = world.column(p.x, p.z).h;
    return { ...p, h, previewY: previewY(p.x, p.z), error: Math.abs(h - previewY(p.x, p.z)) };
  }).sort((a, b) => b.error - a.error)[0];
}
// Do not sample the new location while warming the old one. The warm-respawn
// route's optional height audit runs only after the cold-target walk ends.
let nonlinear = warmRespawn ? null : measureNonlinearity();

type Pose = ReturnType<typeof route>;
// The respawn route starts on its first animation frame, before any terrain
// readiness wait. Existing boosted routes retain their explicit warmup.
let phase: 'warmup' | 'drive' | 'finished' | 'review' = respawn && !warmRespawn ? 'drive' : 'warmup';
let fixedPose: Pose | undefined, driveStarted = performance.now(), elapsed = 0, last = driveStarted, lastSample = 0;
const fixtureStarted = driveStarted;
let preload: unknown = null, transition: { atMs: number; targetSelected: string[]; targetInstalled: string[]; targetRequested: string[] } | null = null;
let terrainWorkersBefore: Worker[] = [], sceneryWorkerBefore: Worker | null = null;
let frames = 0, driveFrames = 0, driveWallMs = 0, missingFrames = 0, aheadMissingFrames = 0;
let coarseMissingFrames = 0, aheadCoarseMissingFrames = 0;
let missingMs = 0, longestMissingMs = 0, missingBegan: number | null = null;
let firstMissing: { pose: Pose; at: number; png: string } | null = null;
let firstExposed: { pose: Pose; at: number; png: string } | null = null;
let neighborhoodMissingFrames = 0;
const samples: unknown[] = [], frameIntervals: number[] = [], failures: string[] = [];
// Low-frequency fixture-only timing of atomic uploads. This records the new
// boundary work without wrapping the per-frame World or mesh-worker hot paths.
const meshInstalls: { atMs: number; phase: string; key: string; ms: number; accepted: boolean }[] = [];
const stagedUploads: { atMs: number; ms: number; members: string[]; remaining: number }[] = [];
const chunkInternals = chunks as any, installGeometry = chunkInternals.installGeometry;
chunkInternals.installGeometry = function(st: { key: string }, ...args: unknown[]) {
  const before = performance.now();
  const accepted = installGeometry.call(this, st, ...args);
  if (meshInstalls.length < 512) meshInstalls.push({ atMs: before, phase, key: st.key,
    ms: performance.now() - before, accepted });
  return accepted;
};
const retryDeferredSeam = chunkInternals.retryDeferredSeam;
chunkInternals.retryDeferredSeam = function() {
  const before = performance.now();
  const members = this.seamTransaction?.members.map((p: any) => p.state.key) ?? [];
  const advanced = retryDeferredSeam.call(this);
  if (advanced && stagedUploads.length < 512) stagedUploads.push({ atMs: before,
    ms: performance.now() - before, members: members.length ? members :
      this.seamTransaction?.members.map((p: any) => p.state.key) ?? [], remaining: this.seamDeferred.size });
  return advanced;
};
let current = warmRespawn ? oldLocation : route(0), stopped = false;
let reviewAfterFrame = Infinity;
type ExposedPlacement = { kind: string; x: number; z: number; baseY: number; hx: number; hz: number };
const exposureAuditPoints: ExposedPlacement[] = [];
let exposureCache: { revision: number; cellX: number; cellZ: number; rocks: unknown; vegetation: unknown;
  value: { rocks: number; vegetation: number; examples: ExposedPlacement[] } } | null = null;
function exposedScenery() {
  const drawnRocks = (rocks as any).visible as { rock: { x: number; y: number; z: number; hx: number; hy: number; hz: number } }[];
  const drawnPlants = (vegetation as any).visible as { x: number; y: number; z: number; radius: number; canopyRadius: number }[];
  const revision = chunks.sceneryCoverageRevision;
  const cellX = Math.floor(current.x / 64), cellZ = Math.floor(current.z / 64);
  if (exposureCache?.revision === revision && exposureCache.cellX === cellX && exposureCache.cellZ === cellZ &&
      exposureCache.rocks === drawnRocks && exposureCache.vegetation === drawnPlants)
    return exposureCache.value;
  // After a teleport the renderer can retain old instances until its new
  // worker result arrives. Those far-away, fogged instances are not nearby
  // floating scenery. Match the production 64m-cell collision protection.
  const nearby = (x: number, z: number, hx: number, hz: number) => {
    const dx = Math.max(cellX * 64 - x - hx, x - hx - (cellX + 1) * 64, 0);
    const dz = Math.max(cellZ * 64 - z - hz, z - hz - (cellZ + 1) * 64, 0);
    return dx * dx + dz * dz <= SCENERY_PROTECTED_DISTANCE ** 2;
  };
  const examples: ExposedPlacement[] = []; let rockCount = 0, plantCount = 0;
  const record = (p: ExposedPlacement) => {
    if (examples.filter(row => row.kind === p.kind).length < 12) examples.push(p);
    if (exposureAuditPoints.filter(row => row.kind === p.kind).length < 12 &&
        !exposureAuditPoints.some(row => row.kind === p.kind && row.x === p.x && row.z === p.z)) exposureAuditPoints.push(p);
  };
  for (const { rock } of drawnRocks) if (nearby(rock.x, rock.z, rock.hx, rock.hz) &&
      !chunks.sceneryGroundReady(rock.x, rock.z, rock.hx, rock.hz)) {
    rockCount++; record({ kind: 'rock', x: rock.x, z: rock.z, baseY: rock.y - rock.hy, hx: rock.hx, hz: rock.hz });
  }
  for (const plant of drawnPlants) {
    const radius = Math.max(plant.radius, plant.canopyRadius);
    if (nearby(plant.x, plant.z, radius, radius) && !chunks.sceneryGroundReady(plant.x, plant.z, radius, radius)) {
      plantCount++; record({ kind: 'vegetation', x: plant.x, z: plant.z, baseY: plant.y, hx: radius, hz: radius });
    }
  }
  const value = { rocks: rockCount, vegetation: plantCount, examples };
  exposureCache = { revision, cellX, cellZ, rocks: drawnRocks, vegetation: drawnPlants, value };
  return value;
}
function visiblePoints() {
  const yaw = scene.camera.rotation.y, fx = -Math.sin(yaw), fz = -Math.cos(yaw);
  return [16, 48, 96, 160].flatMap(distance => [-.75, 0, .75].map(side => ({
    x: current.x + distance * (fx - fz * side), z: current.z + distance * (fz + fx * side), distance, side,
  })));
}

function state() {
  const admission = chunks as unknown as { coveredAt(x: number, z: number, cave: boolean, canonical: boolean): boolean };
  const visible = visiblePoints().map(point => ({ ...point,
    canonical: admission.coveredAt(point.x, point.z, chunks.isUnderground, true) }));
  const seamState = chunks as any;
  const seamGroups = [...seamState.seamGroups.values()] as { terrain?: THREE.Mesh; portal?: THREE.Mesh }[];
  return { phase, elapsed, pose: { ...current, y: scene.camera.position.y }, city, speed, duration,
    route: routeName, coldStart: respawn, retainedWorkerRespawn: warmRespawn, underground: chunks.isUnderground,
    caveApproach: (chunks as any).lastUnderground, belowEnvelope: chunks.isBelowSurfaceEnvelope,
    forecastTurnRate: (chunks as any).groundTurnRate,
    streaming: chunks.streaming, rendering: { ...scene.renderStats }, scenery: { ...stream.stats },
    rocks: rocks.count, vegetation: { ...vegetation.stats }, rockChecks, rockMismatch,
    frames, driveFrames, driveWallMs, missingFrames, aheadMissingFrames, coarseMissingFrames, aheadCoarseMissingFrames, missingMs, longestMissingMs,
    nonlinear, visible, exposedScenery: exposedScenery(), neighborhoodMissingFrames,
    seams: { edges: seamState.seamEdges.size, groups: seamGroups.length, deferred: seamState.seamDeferred.size,
      triangles: seamGroups.reduce((n, group) => n + (group.terrain?.geometry.getAttribute('position').count ?? 0) / 3, 0),
      currentFineCovered: seamState.columns.get(`0:${Math.floor(current.x / 32)},${Math.floor(current.z / 32)}`)?.installed === true },
    reviewReady: phase === 'review' && frames >= reviewAfterFrame, failures };
}
const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
function renderedGround(x: number, z: number) {
  // Only terrain meshes covering this XZ, with their live draw masks. Entrance
  // stencil meshes are excluded. This read-only audit runs outside travel.
  const internals = chunks as unknown as { columns: Map<string, { meshes: THREE.Mesh[] }> };
  const meshes: THREE.Mesh[] = [];
  for (const [lod, size] of [[0, 32], [1, 128], [2, 512]]) {
    for (const mesh of internals.columns.get(`${lod}:${Math.floor(x / size)},${Math.floor(z / size)}`)?.meshes ?? []) {
      if (mesh.visible) meshes.push(mesh);
    }
  }
  for (const group of (chunks as any).seamGroups.values()) if (group.terrain) meshes.push(group.terrain);
  chunks.group.updateMatrixWorld(true);
  const canonical = world.groundY(x, z);
  ray.set(new THREE.Vector3(x, canonical + 1500, z), down);
  const hits = ray.intersectObjects(meshes, false);
  const distinct = [...new Set(hits.map(hit => Math.round(hit.point.y * 1000) / 1000))];
  return { x, z, canonical, preview: previewY(x, z), rendered: hits[0]?.point.y ?? null,
    delta: hits[0] ? hits[0].point.y - canonical : null, surfaceHeights: distinct.slice(0, 8) };
}
function seamAudit(measureRoute = true) {
  if (measureRoute) nonlinear ??= measureNonlinearity();
  const points = [{ x: current.x, z: current.z }];
  // Both sides of the nearest fine and middle X/Z boundaries expose ownership
  // holes or stacked cover without changing any production mask or material.
  for (const size of [32, 128]) {
    const bx = Math.round(current.x / size) * size, bz = Math.round(current.z / size) * size;
    points.push({ x: bx - .1, z: current.z }, { x: bx + .1, z: current.z },
      { x: current.x, z: bz - .1 }, { x: current.x, z: bz + .1 });
  }
  // Source-only field/ray comparison at the left-side depression seen in the
  // review image. This runs after travel, never inside the frame workload.
  const internals = chunks as unknown as { columns: Map<string, { meshes: THREE.Mesh[] }> };
  const meshKeys = new Map<THREE.Mesh, string>();
  for (const [key, column] of internals.columns) for (const mesh of column.meshes)
    if (mesh.visible) meshKeys.set(mesh, key);
  for (const [owner, group] of (chunks as any).seamGroups)
    if (group.terrain) meshKeys.set(group.terrain, `seam:${owner.key}`);
  const meshes = [...meshKeys.keys()];
  chunks.group.updateMatrixWorld(true); scene.camera.updateMatrixWorld();
  const terrain = world as unknown as { terrainSdf(x: number, y: number, z: number): number };
  const screenRay = (x: number, y: number) => {
    ray.setFromCamera(new THREE.Vector2(x * 2 - 1, 1 - y * 2), scene.camera);
    const hit = ray.intersectObjects(meshes, false)[0], o = ray.ray.origin, d = ray.ray.direction;
    const canonical = world.trace(o.x, o.y, o.z, d.x, d.y, d.z, 1200, false);
    const p = hit?.point, col = p ? world.column(p.x, p.z) : undefined;
    return { x, y, meshKey: hit ? meshKeys.get(hit.object as THREE.Mesh) : null,
      rendered: p ? { x: p.x, y: p.y, z: p.z, distance: hit.distance,
        terrainField: terrain.terrainSdf(p.x, p.y, p.z), envelope: col!.h,
        entrance: col!.entr, cave: col!.cave ? { floor: col!.cave.floor,
          mouth: col!.cave.mouth, footprint: col!.cave.footprint, chamber: col!.cave.chamber } : null } : null,
      canonical, distanceDelta: hit && canonical.hit ? hit.distance - canonical.dist : null };
  };
  const screen = [.17, .20, .23].flatMap(x => [.40, .43, .46].map(y => screenRay(x, y)));
  // These grazing rays straddle the thin blue fine/middle slits in the
  // recorded warm-respawn image. Existing broad ground probes missed them.
  const seamScreen = [.48, .52, .56, .60, .64].flatMap(x => [.395, .405, .415].map(y => screenRay(x, y)));
  return { exposedScenery: exposedScenery(),
    exposedBases: exposureAuditPoints.map(prop => {
      const ground = renderedGround(prop.x, prop.z);
      return { ...prop, ...ground, baseGap: ground.rendered === null ? null : prop.baseY - ground.rendered };
    }), boundaries: points.map(point => renderedGround(point.x, point.z)),
    visible: visiblePoints().map(point => ({ ...point, ...renderedGround(point.x, point.z) })), screen, seamScreen };
}

function frame(now: number) {
  if (stopped) return;
  const dt = Math.max(0, (now - last) / 1000); last = now; frames++;
  try {
    if (phase === 'drive') {
      elapsed = Math.max(0, Math.min(duration, (now - driveStarted) / 1000));
      current = route(elapsed); driveFrames++; driveWallMs += dt * 1000; frameIntervals.push(dt * 1000);
      if (elapsed >= duration) phase = 'finished';
    } else current = fixedPose ?? (warmRespawn && phase === 'warmup' ? oldLocation : route(phase === 'finished' ? duration : 0));
    scene.camera.position.set(current.x, world.groundY(current.x, current.z) + (respawn ? 1.62 : 2.4), current.z);
    scene.camera.rotation.set(respawn ? -.0946 : -.10, Math.atan2(-current.vx, -current.vz) + (respawn ? 0 : .35), 0);
    scene.updateFrame(dt, now / 1000);
    chunks.update(current.x, scene.camera.position.y, current.z, { vx: current.vx, vz: current.vz, flight: false });
    if (chunks.currentCoverageReady) stream.start();
    scenery.update(current.x, current.z); vegetation.animate(now / 1000);
    skyline.update(current.x, scene.camera.position.y, current.z);
    scene.setCaveView(chunks.isBelowSurfaceEnvelope);
    scene.render(true);
    if (phase === 'drive') {
      const coverage = chunks.streaming;
      if (!coverage.currentGroundCovered) {
        missingFrames++; missingMs += dt * 1000; missingBegan ??= now;
        longestMissingMs = Math.max(longestMissingMs, now - missingBegan);
        // One deliberate diagnostic screenshot; report this overhead rather
        // than treating this subsystem's FPS as full-game performance.
        firstMissing ??= { pose: { ...current }, at: elapsed, png: canvas.toDataURL('image/png') };
      } else missingBegan = null;
      if (!coverage.aheadGroundCovered) aheadMissingFrames++;
      if (!coverage.currentCovered) coarseMissingFrames++;
      if (!coverage.aheadCovered) aheadCoarseMissingFrames++;
      if (!coverage.groundNeighborhood?.covered) neighborhoodMissingFrames++;
    }
    if (now - lastSample >= 250) {
      const sample = state(); samples.push({ atMs: now, ...sample }); lastSample = now;
      if (respawn && phase !== 'warmup' && !firstExposed && sample.streaming.currentGroundCovered &&
          sample.exposedScenery.rocks + sample.exposedScenery.vegetation > 0)
        firstExposed = { pose: { ...current }, at: elapsed, png: canvas.toDataURL('image/png') };
    }
  } catch (error) { failures.push(String(error)); stopped = true; }
  requestAnimationFrame(frame);
}
(window as any).__terrainDrive = {
  state,
  begin() {
    if (warmRespawn) {
      const now = performance.now();
      preload = structuredClone({ startedAtMs: fixtureStarted, completedAtMs: now, state: state(), samples });
      const internals = chunks as any, cx = Math.floor(start.x / 128), cz = Math.floor(start.z / 128);
      const targetSelected: string[] = [], targetInstalled: string[] = [], targetRequested: string[] = [];
      for (const tile of internals.columns.values()) {
        const size = tile.lod === 0 ? 32 : tile.lod === 1 ? 128 : 512;
        if ((tile.cx + 1) * size <= (cx - 1) * 128 || tile.cx * size >= (cx + 2) * 128 ||
            (tile.cz + 1) * size <= (cz - 1) * 128 || tile.cz * size >= (cz + 2) * 128) continue;
        targetSelected.push(tile.key);
        if (tile.installed) targetInstalled.push(tile.key);
        if (tile.requestId !== null) targetRequested.push(tile.key);
      }
      transition = { atMs: now, targetSelected, targetInstalled, targetRequested };
      terrainWorkersBefore = internals.workers.map((slot: { worker: Worker }) => slot.worker);
      sceneryWorkerBefore = (stream as any).worker;
      if (targetSelected.length) failures.push('old-location preload touched cold target terrain');
      samples.length = 0; exposureAuditPoints.length = 0; exposureCache = null;
      rockChecks = rockMismatch = 0; firstMissing = firstExposed = null;
      current = route(0); lastSample = 0;
    }
    phase = 'drive'; elapsed = 0; driveStarted = performance.now(); last = driveStarted;
  },
  review() { fixedPose = respawn ? route(duration) : firstMissing?.pose ?? nonlinear ?? route(0); phase = 'review'; reviewAfterFrame = frames + 1; return fixedPose; },
  audit: seamAudit,
  auditPreload() {
    if (!warmRespawn || phase !== 'warmup') throw new Error('preload audit requires the old-location warmup');
    return seamAudit(false);
  },
  result() {
    const gl = scene.renderer.getContext(), debug = gl.getExtension('WEBGL_debug_renderer_info');
    return { ...state(), driveStartedAtMs: driveStarted, samples, frameIntervals, meshInstalls, stagedUploads, firstMissing, firstExposed, preload, transition,
      retainedWorkers: !warmRespawn || !transition ? null : {
        terrain: terrainWorkersBefore.every((worker, i) => (chunks as any).workers[i]?.worker === worker),
        scenery: sceneryWorkerBefore !== null && (stream as any).worker === sceneryWorkerBefore },
      environment: { userAgent: navigator.userAgent, width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
        renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
        vendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR) },
      limitations: 'Subsystem camera follows canonical ground; no jeep physics, full game, server load or capacity claim. A missing-frame PNG and post-drive ray audits are diagnostic work. Renderer strings may be sanitized.' };
  },
  dispose() { stopped = true; chunks.dispose(); stream.dispose(); rocks.dispose(); vegetation.dispose(); structures.dispose(); skyline.dispose(); scene.renderer.dispose(); },
};
requestAnimationFrame(frame);
