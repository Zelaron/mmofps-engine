import { chromium, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { World } from '../packages/shared/src/worldgen.js';
import { VegetationRenderer } from '../packages/client/src/render/vegetation.js';
import { StructureRenderer } from '../packages/client/src/render/structures.js';
import { RockRenderer } from '../packages/client/src/render/rocks.js';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { startServer, defaultClientDir } from '../packages/server/src/server.js';

// Isolated real game, deterministic road/forest witnesses, and the built client.
// Private fixture actors move on the server; user saves and public APIs are untouched.
const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) ?? 'final';
assert.match(label, /^[a-z0-9-]{1,40}$/);
const baseline = process.argv.includes('--baseline');
const world = new World(1337);
const locations = [
  { name: 'road', x: 2102.495, z: -658.759 },
  { name: 'forest', x: 3381.9114, z: -2424.0414 },
].map(location => {
  const vegetation = new VegetationRenderer(world), structures = new StructureRenderer(world), rocks = new RockRenderer(world);
  try {
    for (const renderer of [vegetation, structures, rocks]) renderer.update(location.x, location.z);
    const road = world.column(location.x, location.z).road;
    return { ...location, y: world.groundY(location.x, location.z),
      yaw: location.name === 'road' && road ? Math.atan2(-road.dx, -road.dz) : 0,
      expected: { vegetation: { ...vegetation.stats }, structures: { ...structures.stats }, rocks: rocks.count } };
  } finally { vegetation.dispose(); structures.dispose(); rocks.dispose(); }
});
const coordinator = new Coordinator(':memory:'), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
const server = await startServer({ port: 0, host: '127.0.0.1', seed: 1337, targetPopulation: 0, log: false,
  node: { id: `scenery:${randomUUID()}`, planet: 'meridian', secret, url: `http://127.0.0.1:${control.port}` } });
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret,
  clientDir: process.env.SCENERY_CLIENT_DIR ?? defaultClientDir() });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32'
  ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const results: unknown[] = [];
await mkdir('artifacts', { recursive: true });
const counts = (state: any) => ({ vegetation: state.vegetation, structures: state.structures, rocks: state.rocks });
const stateOf = (page: Page) => page.evaluate(() => (window as any).__mmofps.state);
try {
  const cases = baseline ? [{ name: 'desktop-high', mobile: false, low: false, unavailable: false }] : [
    { name: 'desktop-high', mobile: false, low: false, unavailable: false },
    { name: 'touch-high', mobile: true, low: false, unavailable: false },
    { name: 'desktop-low', mobile: false, low: true, unavailable: false },
    { name: 'desktop-fallback', mobile: false, low: false, unavailable: true },
  ];
  for (const scenario of cases) {
    const context = await browser.newContext(scenario.mobile
      ? { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } });
    if (!baseline) await context.addInitScript(unavailable => {
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(url: string | URL, options?: WorkerOptions) {
          const scenery = new URL(String(url), location.href).pathname.endsWith('/scenery.worker.js');
          if (scenery && unavailable) throw new Error('Fixture: worker creation unavailable');
          super(url, options);
          if (scenery) (window as any).__sceneryFixtureWorker = this;
        }
      };
    }, scenario.unavailable);
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(45_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    try {
      await page.goto(`http://127.0.0.1:${gateway.port}/?quality=${scenario.low ? 'low' : 'high'}`);
      await page.waitForFunction(() => {
        const s = (window as any).__mmofps?.state;
        return s?.initialized && s.rendering.worldPresented && s.structures.count > 0;
      });
      const player = server.game.players.get((await stateOf(page)).myId)!;
      const move = async (location: typeof locations[number]) => {
        Object.assign(player.state, { px: location.x, py: location.y + .05, pz: location.z, vx: 0, vy: 0, vz: 0 });
        player.teleportCdUntil = server.game.tick + 3600;
        await page.waitForFunction(({ x, z }) => {
          const p = (window as any).__mmofps.state.pos; return Math.hypot(p.x - x, p.z - z) < 1;
        }, location);
      };
      const settled = async (location: typeof locations[number]) => {
        await page.waitForFunction(expected => {
          const s = (window as any).__mmofps.state;
          return JSON.stringify({ vegetation: s.vegetation, structures: s.structures, rocks: s.rocks }) === JSON.stringify(expected)
            && (!s.scenery || s.scenery.failed || (s.scenery.pending === 0 && s.scenery.ready === 3))
            && s.streaming.installed.lod0 > 0;
        }, location.expected);
        const state = await stateOf(page);
        assert.deepEqual(counts(state), location.expected, 'real worker/fallback instances match synchronous world generation');
        assert.ok(state.connected && state.alive && state.streaming.currentCovered);
        assert.equal(state.rendering.contactShadowPasses, scenario.low ? 0 : 2);
        if (!baseline) {
          assert.ok(state.scenery.pending <= 3 && state.scenery.ready <= 3);
          assert.equal(state.scenery.failed, scenario.unavailable);
        }
        return state;
      };
      const views = [];
      for (const location of locations) {
        await move(location);
        const state = await settled(location);
        if (location.name === 'road') {
          // Actual input aims down the witness road on both desktop and touch.
          const camera = state.camera;
          const yawDelta = Math.atan2(Math.sin(camera.yaw - location.yaw), Math.cos(camera.yaw - location.yaw));
          const dx = Math.round(yawDelta / .0022), dy = Math.round((camera.pitch + .18) / .0022);
          if (scenario.mobile) {
            const cdp = await context.newCDPSession(page);
            const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 70));
            for (let step = 0; step < steps; step++) {
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 490, y: 215, id: 1 }] });
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 490 + dx / steps, y: 215 + dy / steps, id: 1 }] });
              await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            }
            await cdp.detach();
          } else {
            await page.locator('#c').click({ position: { x: 720, y: 500 } });
            await page.waitForFunction(() => !!document.pointerLockElement);
            await page.evaluate(({ dx, dy }) => document.dispatchEvent(new MouseEvent('mousemove',
              { movementX: dx, movementY: dy, bubbles: true })), { dx, dy });
          }
          await page.waitForTimeout(2500);
          const aimed = (await stateOf(page)).camera;
          assert.ok(Math.abs(aimed.pitch + .18) < .025);
          assert.ok(Math.abs(Math.atan2(Math.sin(aimed.yaw - location.yaw), Math.cos(aimed.yaw - location.yaw))) < .025);
          await page.screenshot({ path: `artifacts/scenery-${label}-${scenario.name}-road.png` });
        }
        views.push({ location: location.name, expected: location.expected, observed: counts(state), scenery: state.scenery,
          streaming: state.streaming });
      }
      let watchdog;
      if (!baseline && scenario.mobile) {
        // A genuinely terminated worker cannot answer. Preserve the old cover
        // while moving, then require the production watchdog and sync fallback.
        const before = await stateOf(page);
        await page.evaluate(() => (window as any).__sceneryFixtureWorker.terminate());
        const began = performance.now();
        await move(locations[0]);
        await page.waitForFunction(() => (window as any).__mmofps.state.scenery.pending > 0);
        assert.deepEqual(counts(await stateOf(page)), counts(before), 'pending replacement retains existing visible cover');
        await page.waitForFunction(() => (window as any).__mmofps.state.scenery.failed, null, { timeout: 30_000 });
        await page.waitForFunction(expected => {
          const s = (window as any).__mmofps.state;
          return JSON.stringify({ vegetation: s.vegetation, structures: s.structures, rocks: s.rocks }) === JSON.stringify(expected);
        }, locations[0].expected);
        const recovered = await stateOf(page);
        assert.deepEqual(recovered.scenery, { worker: false, failed: true, pending: 0, ready: 0 });
        watchdog = { elapsedMs: performance.now() - began, retainedCover: true, observed: counts(recovered) };
        await page.reload();
        await page.waitForFunction(() => {
          const s = (window as any).__mmofps?.state;
          return s?.initialized && s.scenery.worker && !s.scenery.failed && s.scenery.ready === 3;
        });
      }
      assert.deepEqual(errors, []);
      results.push({ scenario: scenario.name, baseline, views, watchdog, errors });
      await writeFile(`artifacts/scenery-${label}.json`, JSON.stringify(results, null, 2));
    } catch (error) {
      await writeFile(`artifacts/scenery-${label}-failure.json`, JSON.stringify({ scenario, error: String(error), errors,
        state: await stateOf(page).catch(() => null), locations }, null, 2));
      await page.screenshot({ path: `artifacts/scenery-${label}-failure.png` }).catch(() => {});
      throw error;
    } finally { await context.close(); }
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close();
}
