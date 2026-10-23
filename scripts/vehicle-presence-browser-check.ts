import { chromium, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { startServer, defaultClientDir } from '../packages/server/src/server.js';
import type { ServerPlayer } from '../packages/server/src/game.js';
import { airliftPose } from '../packages/shared/src/airlift.js';
import { PLAYER, TICK_RATE } from '../packages/shared/src/constants.js';
import { capsuleClearance } from '../packages/shared/src/physics.js';
import { encodeTeleport } from '../packages/shared/src/protocol.js';
import { VEHICLE, vehicleDefinition } from '../packages/shared/src/vehicles.js';

// Only this fixture's actors/hulls are positioned. W/E and pod destinations
// use the actual browser controls, packets, simulation and prediction.
const temporary = await mkdtemp(path.join(tmpdir(), 'mmofps-vehicle-presence-'));
const clean = async () => {
  assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()));
  assert.ok(path.basename(temporary).startsWith('mmofps-vehicle-presence-'));
  await rm(temporary, { recursive: true, force: true });
};
const coordinator = new Coordinator(path.join(temporary, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
const server = await startServer({ port: 0, host: '127.0.0.1', targetPopulation: 0, dataDir: path.join(temporary, 'meridian'), log: false,
  node: { planet: 'meridian', id: 'vehicle-presence-fixture', secret, url: `http://127.0.0.1:${control.port}` } })
  .catch(async error => { await control.close(); coordinator.close(); await clean(); throw error; });
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() })
  .catch(async error => { await server.close(); await control.close(); coordinator.close(); await clean(); throw error; });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] })
  .catch(async error => { await gateway.close(); await server.close(); await control.close(); coordinator.close(); await clean(); throw error; });
const results: Record<string, unknown> = {}, errors: string[] = [];
let page: Page | undefined;
const until = async (check: () => boolean, label: string, timeout = 15_000) => {
  const deadline = performance.now() + timeout;
  while (!check() && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(check(), label);
};
const angle = (radians: number) => Math.atan2(Math.sin(radians), Math.cos(radians));
await mkdir('artifacts', { recursive: true });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(() => localStorage.setItem('mmofps-sens', '0.0022'));
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${gateway.port}`);
  await page.waitForFunction(() => (window as any).__mmofps?.state.initialized && (window as any).__mmofps.state.rendering.worldPresented);
  const state = () => page!.evaluate(() => (window as any).__mmofps.state);
  const player = server.game.players.get((await state()).myId)!;
  assert.ok(player);
  const lock = async () => {
    if (!await page!.evaluate(() => !!document.pointerLockElement)) await page!.locator('#c').click({ position: { x: 720, y: 450 } });
    await page!.waitForFunction(() => !!document.pointerLockElement);
  };
  const look = async (yaw: number, pitch = 0) => {
    await lock();
    const camera = (await state()).camera;
    // Relative mouse events pass through the normal locked FPS Input handler;
    // no camera or simulation transform is written by the fixture.
    await page!.evaluate(({ dx, dy }) => document.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY: dy, bubbles: true })),
      { dx: -angle(yaw - camera.yaw) / .0022, dy: -(pitch - camera.pitch) / .0022 });
    await page!.waitForFunction(({ yaw, pitch }) => {
      const camera = (window as any).__mmofps.state.camera;
      return Math.abs(Math.atan2(Math.sin(camera.yaw - yaw), Math.cos(camera.yaw - yaw))) < .025 && Math.abs(camera.pitch - pitch) < .025;
    }, { yaw, pitch });
  };
  const place = async (x: number, y: number, z: number) => {
    const previous = { x: player.state.px, y: player.state.py, z: player.state.pz };
    player.inputQueue.length = 0; player.lastCmd = null;
    Object.assign(player.state, { px: x, py: y, pz: z, vx: 0, vy: 0, vz: 0, grounded: true });
    player.teleportArmed = false; player.teleportCdUntil = server.game.tick + 10 * TICK_RATE;
    player.spawnProtectedUntil = server.game.tick + 120 * TICK_RATE;
    player.sink?.send(encodeTeleport({ id: player.id, fromX: previous.x, fromY: previous.y, fromZ: previous.z, toX: x, toY: y, toZ: z }));
    await page!.waitForFunction(({ x, z }) => {
      const pos = (window as any).__mmofps.state.pos; return pos && Math.hypot(pos.x - x, pos.z - z) < .35;
    }, { x, z });
    await page!.waitForTimeout(350);
  };

  // A real pod selection starts the ordinary charge and authored trajectory.
  const plan = server.game.world.collectTransportPlan();
  const source = [...plan.pods].sort((a, b) => Math.hypot(a.x - player.state.px, a.z - player.state.pz) - Math.hypot(b.x - player.state.px, b.z - player.state.pz))[0];
  const destination = [...plan.pods].filter(pod => pod.id !== source.id).sort((a, b) => Math.hypot(b.x - source.x, b.z - source.z) - Math.hypot(a.x - source.x, a.z - source.z))[0];
  await place(source.x, source.y + .08, source.z); await lock();
  await page.keyboard.press('KeyE'); await page.locator('#airlift-map').waitFor({ state: 'visible' });
  await page.locator('#airlift-map nav button').filter({ has: page.locator('strong', { hasText: destination.name }) }).click();
  await until(() => !!player.state.airlift, 'real pod charging completes');
  await page.locator('#airlift-flight').waitFor({ state: 'visible' }); await lock();
  const flight = { ...player.state.airlift! }, route = airliftPose(plan, flight, server.game.tick)!;
  const views: Record<string, unknown>[] = [];
  for (const [name, yawOffset, pitch] of [
    ['forward', 0, 0], ['side', Math.PI / 2, 0], ['back', Math.PI, 0], ['roof', 0, 1.1], ['floor', 0, -1.05],
  ] as const) {
    await look(route.heading + yawOffset, pitch); await page.waitForTimeout(120);
    const view = await state(), pod = view.airliftPod;
    assert.ok(view.airlift && pod.visible, `pod remains visible in ${name} view`);
    assert.ok(Math.abs(angle(pod.heading - route.heading)) < .001, 'looking around never rotates the pod in the world');
    assert.ok(Math.hypot(pod.cameraLocal.x, pod.cameraLocal.y, pod.cameraLocal.z) < .35, 'camera remains inside the cabin with clearance to its surfaces');
    if (name === 'forward') assert.ok(pod.viewForward.z < -.95, 'windscreen is in front of the forward view');
    if (name === 'side') assert.ok(Math.abs(pod.viewForward.x) > .95 && Math.abs(pod.viewForward.z) < .08, 'side view rotates relative to the world-aligned pod');
    if (name === 'back') assert.ok(pod.viewForward.z > .95, 'backward view faces the rear cabin');
    views.push({ name, camera: view.camera, pod });
    await page.screenshot({ path: `artifacts/vehicle-presence-pod-${name}.png` });
  }
  await look(route.heading, -.1);
  await until(() => !player.state.airlift, 'pod lands at its chosen destination', 40_000);
  await page.waitForFunction(() => !(window as any).__mmofps.state.airlift && !(window as any).__mmofps.state.airliftPod.visible);
  assert.equal(await page.locator('#airlift-flight').isVisible(), false, 'pod progress UI clears after landing');
  assert.ok(Math.hypot(player.state.px - destination.x, player.state.pz - destination.z) < 1, 'arrival uses the authored destination');
  assert.equal((await state()).viewmodelVisible, true, 'on-foot view returns after landing');
  await page.screenshot({ path: 'artifacts/vehicle-presence-pod-landed.png' });
  results.pod = { source: source.name, destination: destination.name, views, landingClear: true };

  // Find an actual level city lane, with continuous support and clearance for
  // the same on-foot crossing before and after parking the hull.
  const world = server.game.world;
  const cities = [...world.collectCities()].sort((a, b) => Math.hypot(a.x - player.state.px, a.z - player.state.pz) - Math.hypot(b.x - player.state.px, b.z - player.state.pz));
  let lane: { x: number; y: number; z: number } | undefined;
  findLane: for (const city of cities) {
    for (const dx of [0, -64, 64, -128, 128]) for (const dz of [0, -64, 64, -128, 128]) {
      const candidate = { x: city.x + dx, y: city.y + .08, z: city.z + dz };
      let clear = true;
      for (const ox of [-3, 0, 3]) for (let oz = -16; oz <= 16 && clear; oz += 2) {
        const x = candidate.x + ox, z = candidate.z + oz;
        if (world.liquidAt(x, candidate.y, z) || world.sdf(x, candidate.y - .2, z) > 0 ||
          capsuleClearance(world, x, candidate.y, z) < -.025 || world.sdf(x, candidate.y + 2.8, z) < .2) clear = false;
      }
      if (clear) { lane = candidate; break findLane; }
    }
  }
  assert.ok(lane, 'fixture finds a level, supported city lane');
  const hulls = [VEHICLE.JEEP, VEHICLE.TANK].map(type => [...server.game.vehicles.values()].find(hull => hull.type === type && !hull.variant && hull.occupant < 0 && hull.respawnAtTick < 0)!);
  assert.ok(hulls.every(Boolean), 'fixture has a common jeep and tank');
  const clearLane = (keep = -1) => {
    for (const hull of server.game.vehicles.values()) if (hull.id !== keep && Math.hypot(hull.x - lane!.x, hull.z - lane!.z) < 80) server.game.vehicles.delete(hull.id);
  };
  const walk = async () => {
    const trail: { client: { x: number; y: number; z: number }; server: { x: number; y: number; z: number } }[] = [];
    await look(0); await page!.keyboard.down('KeyW');
    try {
      const end = performance.now() + 1900;
      while (performance.now() < end) {
        trail.push({ client: (await state()).pos, server: { x: player.state.px, y: player.state.py, z: player.state.pz } });
        await page!.waitForTimeout(100);
      }
    } finally { await page!.keyboard.up('KeyW'); }
    await page!.waitForTimeout(200); return trail;
  };
  clearLane(); await place(lane.x, lane.y, lane.z + 10); await walk();
  assert.ok(player.state.pz < lane.z - 4, 'the empty lane can be crossed before adding a vehicle');
  const vehicles: Record<string, unknown>[] = [];
  for (const hull of hulls) {
    // The center-line tank body ends before its wider, outboard tracks.
    const name = hull.type === VEHICLE.JEEP ? 'jeep' : 'tank', rear = hull.type === VEHICLE.JEEP ? 2.04 : 2.2;
    clearLane(hull.id); server.game.vehicles.set(hull.id, hull);
    Object.assign(hull, { x: lane.x, y: lane.y - .03, z: lane.z, heading: 0, pitch: 0, roll: 0,
      health: vehicleDefinition(hull.type)!.maxHealth, occupant: -1, gunner: -1, motionState: undefined,
      respawnAtTick: -1, campaignFaction: player.faction });
    await place(lane.x, lane.y, lane.z + 10);
    await page.waitForFunction(id => (window as any).__mmofps.state.vehicleIds.includes(id), hull.id);
    const trail = await walk();
    assert.ok(player.state.pz < lane.z + 4, `${name}: W approaches the hull`);
    assert.ok(trail.every(point => point.server.z >= lane!.z + rear + PLAYER.RADIUS - .12), `${name}: server walking stops outside the body`);
    assert.ok(trail.every(point => point.client.z >= lane!.z + rear + PLAYER.RADIUS - .22), `${name}: local prediction also stops outside the body`);
    const stopped = await state();
    assert.ok(Math.hypot(stopped.pos.x - player.state.px, stopped.pos.z - player.state.pz) < .45, `${name}: client and server agree at contact`);
    await page.screenshot({ path: `artifacts/vehicle-presence-${name}-blocked.png` });
    await page.keyboard.press('KeyE'); await until(() => player.state.vehicle === hull.type, `${name}: E boards from outside the solid body`);
    await page.waitForFunction(type => (window as any).__mmofps.state.myVehicle === type, hull.type);
    await page.waitForTimeout(400); await page.keyboard.press('KeyE');
    await until(() => player.state.vehicle === VEHICLE.NONE, `${name}: E exits`);
    await page.waitForFunction(() => (window as any).__mmofps.state.myVehicle === 0);
    assert.ok(Math.hypot(player.state.px - hull.x, player.state.pz - hull.z) > 2, `${name}: exit leaves the body`);
    await place(lane.x, lane.y, lane.z + 10);
    server.game.damageVehicle(hull, hull.health + 1, null, 255);
    assert.ok(hull.respawnAtTick > server.game.tick);
    await page.waitForFunction(id => !(window as any).__mmofps.state.vehicleIds.includes(id), hull.id);
    await walk();
    assert.ok(player.state.pz < lane.z - 4 && (await state()).pos.z < lane.z - 3.7, `${name}: the destroyed body no longer blocks walking`);
    assert.equal(player.state.alive, true);
    await page.screenshot({ path: `artifacts/vehicle-presence-${name}-destroyed.png` });
    vehicles.push({ name, id: hull.id, trail, blocked: true, predictionMatches: true, boarded: true, exited: true, destroyedAndPassable: true });
  }
  results.vehicles = { lane, checks: vehicles }; assert.deepEqual(errors, []); assert.equal(server.failure, null);
} catch (error) {
  await page?.screenshot({ path: 'artifacts/vehicle-presence-failure.png' }).catch(() => {});
  await writeFile('artifacts/vehicle-presence-failure.json', JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined,
    state: await page?.evaluate(() => (window as any).__mmofps?.state).catch(() => null), results, errors, serverFailure: server.failure?.message,
    players: [...server.game.players.values()].map((player: ServerPlayer) => ({ id: player.id, state: player.state, health: player.health })) }, null, 2));
  throw error;
} finally {
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close(); await clean();
}
await writeFile('artifacts/vehicle-presence-browser-check.json', JSON.stringify({ ...results, errors, serverStopped: true }, null, 2));
console.log('Pod free-look, landing, solid vehicles and destruction checks passed; isolated servers stopped.');
