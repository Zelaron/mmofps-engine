import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { startServer, defaultClientDir } from '../packages/server/src/server.js';
import { BTN } from '../packages/shared/src/movement.js';
import { PLAYER } from '../packages/shared/src/constants.js';
import { LOCK_LOCKED } from '../packages/shared/src/protocol.js';
import { VEHICLE, vehicleDefinition } from '../packages/shared/src/vehicles.js';
import { rotationFromEuler } from '../packages/shared/src/rotation.js';

// Private practice aircraft hold a known airborne pose while the fixture's
// launcher issues ordinary aim/fire commands. Locks, guidance, warning
// snapshots, client display and audio all run through the production pipeline.
const root = await mkdtemp(path.join(tmpdir(), 'mmofps-aircraft-browser-'));
const cleanRoot = async () => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('mmofps-aircraft-browser-'));
  await rm(root, { recursive: true, force: true });
};
const coordinator = new Coordinator(path.join(root, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
const server = await startServer({ port: 0, host: '127.0.0.1', targetPopulation: 0, dataDir: path.join(root, 'meridian'), log: false,
  node: { planet: 'meridian', id: 'aircraft-warning-fixture', secret, url: `http://127.0.0.1:${control.port}` } })
  .catch(async error => { await control.close(); coordinator.close(); await cleanRoot(); throw error; });
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() })
  .catch(async error => { await server.close(); await control.close(); coordinator.close(); await cleanRoot(); throw error; });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] })
  .catch(async error => { await gateway.close(); await server.close(); await control.close(); coordinator.close(); await cleanRoot(); throw error; });
const results: unknown[] = [], timers = new Set<NodeJS.Timeout>();
const until = async (condition: () => boolean, message: string, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(condition(), message);
};
await mkdir('artifacts', { recursive: true });
try {
  for (const mobile of [false, true]) {
    const device = mobile ? 'mobile-gunner' : 'desktop-pilot', errors: string[] = [];
    const context = await browser.newContext(mobile ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } });
    // Observe browser audio APIs without injecting or changing game state.
    await context.addInitScript(() => {
      const probe = (window as any).__aircraftAudio = { contexts: [] as AudioContext[], tones: [] as unknown[] };
      const NativeContext = window.AudioContext;
      window.AudioContext = new Proxy(NativeContext, { construct(Target, args) {
        const context = Reflect.construct(Target, args) as AudioContext;
        probe.contexts.push(context); return context;
      } });
      const create = NativeContext.prototype.createOscillator;
      NativeContext.prototype.createOscillator = function () {
        const oscillator = create.call(this), start = oscillator.start.bind(oscillator);
        let frequency = oscillator.frequency.value;
        const set = oscillator.frequency.setValueAtTime.bind(oscillator.frequency);
        oscillator.frequency.setValueAtTime = (value, when) => { frequency = value; return set(value, when); };
        oscillator.start = (when?: number) => {
          probe.tones.push({ type: oscillator.type, frequency, stage: document.querySelector('#aircraft-warning')?.getAttribute('data-stage') });
          start(when);
        };
        return oscillator;
      };
    });
    const page = await context.newPage(); page.setDefaultTimeout(30_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${gateway.port}${mobile ? '/?quality=low' : '/'}`);
    await page.waitForFunction(() => (window as any).__mmofps?.state.initialized && (window as any).__mmofps.state.rendering.worldPresented);
    // Instant-action touch mode may prepare a suspended context on arrival;
    // the actual gesture below must resume it before warning tones can play.
    const initialAudioStates = await page.evaluate(() => (window as any).__aircraftAudio.contexts.map((ctx: AudioContext) => ctx.state));
    if (!mobile) assert.equal(initialAudioStates.length, 0, 'desktop audio waits for a player gesture');
    if (mobile) await page.touchscreen.tap(420, 180);
    else await page.locator('#c').click({ position: { x: 700, y: 460 } });
    await page.waitForFunction(() => (window as any).__aircraftAudio.contexts.some((ctx: AudioContext) => ctx.state === 'running'));
    const id = await page.evaluate(() => (window as any).__mmofps.state.myId), player = server.game.players.get(id)!;
    const companion = server.game.addPlayer('Cockpit check crew', null), launcher = server.game.addPlayer('Cockpit check launcher', null);
    companion.faction = player.faction; launcher.faction = (player.faction % 3 + 1) as typeof launcher.faction;
    const hull = [...server.game.vehicles.values()].find(hull => hull.type === VEHICLE.JET && !hull.variant && hull.occupant < 0 && hull.respawnAtTick < 0)!;
    assert.ok(hull);
    const pilot = mobile ? companion : player, gunner = mobile ? player : companion;
    const x = hull.x, y = Math.max(600, server.game.world.terrainHeight(hull.x, hull.z) + 400), z = hull.z;
    Object.assign(hull, { x, y, z, heading: 0, health: vehicleDefinition(VEHICLE.JET)!.maxHealth,
      occupant: pilot.id, gunner: gunner.id, motionState: undefined, respawnAtTick: -1 });
    for (const occupant of [pilot, gunner]) {
      occupant.vehicleId = hull.id;
      Object.assign(occupant.state, { vehicle: VEHICLE.JET, vehicleVariant: 0, vehicleId: hull.id,
        seat: occupant === gunner ? 1 : undefined, px: x, py: y, pz: z, heading: 0,
        vehiclePitch: 0, vehicleRoll: 0, vehicleRotation: rotationFromEuler(0), grounded: false,
        vx: 0, vy: 0, vz: -132 });
    }
    let phase: 'acquiring' | 'locked' | 'fire' | 'clear' = 'acquiring', sentTick = -1, fired = false, easeLock = false;
    const timer = setInterval(() => {
      if (server.game.tick === sentTick) return;
      sentTick = server.game.tick;
      Object.assign(pilot.state, { px: x, py: y, pz: z, vx: 0, vy: 0, vz: -132,
        heading: 0, vehiclePitch: 0, vehicleRoll: 0, vehicleRotation: rotationFromEuler(0), grounded: false });
      Object.assign(launcher.state, { px: x + 160, py: y, pz: z + 820, vx: 0, vy: 0, vz: 0 });
      const dx = pilot.state.px - launcher.state.px,
        dy = pilot.state.py + vehicleDefinition(VEHICLE.JET)!.radius - launcher.state.py - PLAYER.EYE_HEIGHT,
        dz = pilot.state.pz - launcher.state.pz;
      if (launcher.lockTicks > 45) easeLock = true;
      else if (launcher.lockTicks < 20) easeLock = false;
      const yaw = Math.atan2(-dx, -dz) + (phase === 'acquiring' && easeLock ? .2 : 0);
      const fire = phase === 'fire' && !fired && launcher.lockState === LOCK_LOCKED;
      if (fire) fired = true;
      server.game.queueInput(launcher, { seq: launcher.lastQueuedSeq + 1, buttons: fire ? BTN.FIRE : 0,
        weapon: phase === 'clear' ? 1 : 3, yaw, pitch: Math.atan2(dy, Math.hypot(dx, dz)), renderTick: server.game.tick, renderFrac: 0 });
    }, 5);
    timers.add(timer);
    await page.keyboard.press('KeyM');
    await page.locator('#navigation-map').waitFor({ state: 'visible' });
    const capture = async (stage: 1 | 2 | 3, label = device) => {
      await page.waitForFunction(stage => {
        const warning = document.querySelector('#aircraft-warning') as HTMLElement | null;
        return warning && !warning.hidden && warning.dataset.stage === String(stage);
      }, stage);
      const type = stage === 1 ? 'sine' : stage === 2 ? 'triangle' : 'square';
      await page.waitForFunction(({ stage, type }) => (window as any).__aircraftAudio.tones.some((tone: any) =>
        tone.stage === String(stage) && tone.type === type && tone.frequency >= 700), { stage, type });
      const warning = page.locator('#aircraft-warning'), box = await warning.boundingBox(), viewport = page.viewportSize()!;
      assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height);
      for (const selector of ['#health', '#weapon', '#jet-aim', '#hud-vehicle', '#navigation-map',
        '.world-brand b', '.world-location', '#frontier-order', '#atlas-open', '#camp-open',
        ...(mobile ? ['#touch-stick', '#touch-actions'] : [])]) {
        const element = page.locator(selector).first();
        if (!await element.isVisible()) continue;
        const other = await element.evaluate((node, selector) => {
          // A block title's unused trailing space is not visible text.
          const range = document.createRange(); range.selectNodeContents(node);
          const rect = selector === '.world-location' ? range.getBoundingClientRect() : node.getBoundingClientRect();
          return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }, selector);
        assert.ok(!other || box.x + box.width <= other.x || other.x + other.width <= box.x ||
          box.y + box.height <= other.y || other.y + other.height <= box.y, `warning overlaps ${selector}`);
      }
      const text = await warning.textContent();
      assert.match(text ?? '', /O'CLOCK/);
      if (stage === 3) assert.match(text ?? '', /MISSILE INCOMING.*TO IMPACT/);
      await page.screenshot({ path: `artifacts/aircraft-warning-${label}-${stage}.png` });
      return { layout: label, stage, text, box };
    };
    const views = [await capture(1)];
    phase = 'locked'; await until(() => launcher.lockState === LOCK_LOCKED, 'real launcher aim acquires a full lock');
    views.push(await capture(2));
    phase = 'fire';
    await until(() => [...server.game.projectiles.values()].some(rocket => rocket.owner === launcher.id && rocket.homingVehicleId === hull.id), 'actual fire command launches a guided missile');
    views.push(await capture(3));
    phase = 'clear'; server.game.projectiles.clear();
    await until(() => launcher.lockTicks === 0, 'holstering clears the real lock');
    await page.locator('#aircraft-warning').waitFor({ state: 'hidden' });
    if (mobile) {
      await page.setViewportSize({ width: 393, height: 852 });
      phase = 'acquiring'; fired = false; easeLock = false;
      views.push(await capture(1, 'mobile-portrait-gunner'));
      phase = 'locked'; await until(() => launcher.lockState === LOCK_LOCKED, 'portrait fixture completes its own lock');
      views.push(await capture(2, 'mobile-portrait-gunner'));
      phase = 'fire'; await until(() => [...server.game.projectiles.values()].some(rocket => rocket.owner === launcher.id && rocket.homingVehicleId === hull.id), 'portrait warning follows a new missile launch');
      views.push(await capture(3, 'mobile-portrait-gunner'));
      phase = 'clear'; server.game.projectiles.clear();
      await until(() => launcher.lockTicks === 0, 'portrait lock clears after holstering');
      await page.locator('#aircraft-warning').waitFor({ state: 'hidden' });
    }
    assert.equal(player.state.alive, true, 'warning sequence leaves time to respond');
    const audio = await page.evaluate(() => ({ running: (window as any).__aircraftAudio.contexts.some((ctx: AudioContext) => ctx.state === 'running'),
      warningTones: (window as any).__aircraftAudio.tones.filter((tone: any) => tone.stage && tone.frequency >= 700) }));
    assert.deepEqual(errors, []);
    results.push({ device, seat: mobile ? 'gunner' : 'pilot', initialAudioStates, views, audio, warningCleared: true, errors });
    clearInterval(timer); timers.delete(timer);
    server.game.removePlayer(companion.id); server.game.removePlayer(launcher.id);
    await context.close();
    console.log(`${device}: tracking, full lock, incoming missile, directional HUD and gesture-unlocked warning tones passed`);
  }
  assert.equal(server.failure, null);
} catch (error) {
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (page) {
    await page.screenshot({ path: 'artifacts/aircraft-warning-browser-failure.png' }).catch(() => {});
    await writeFile('artifacts/aircraft-warning-browser-failure.json', JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined,
      ui: await page.evaluate(() => ({ state: (window as any).__mmofps?.state,
        warning: document.querySelector('#aircraft-warning')?.outerHTML,
        audio: (window as any).__aircraftAudio.tones })).catch(() => null),
      players: [...server.game.players.values()].map(p => ({ id: p.id, vehicle: p.vehicleId, weapon: p.weapon, lock: p.lockState, target: p.lockVehicleId, alive: p.state.alive })) }, null, 2));
  }
  throw error;
} finally {
  for (const timer of timers) clearInterval(timer);
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close();
  await cleanRoot();
}
await writeFile('artifacts/aircraft-warning-browser-check.json', JSON.stringify({ results, serverStopped: true }, null, 2));
console.log(JSON.stringify(results, null, 2));
