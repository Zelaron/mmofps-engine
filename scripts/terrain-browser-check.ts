import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { startServer, defaultClientDir } from '../packages/server/src/server.js';
import { snowCover } from '../packages/shared/src/climate.js';

const requestedView = process.argv.find(arg => arg.startsWith('--view='))?.slice(7);
if (requestedView === 'vesper-drive') {
  await (await import('./terrain-drive-browser-check.js')).checkFastGroundTerrain();
} else {
// Real world generation, production meshes and shaders, and a private world.
// Fixed cameras make the biome and lava-road regressions easy to inspect.
const root = await mkdtemp(path.join(tmpdir(), 'mmofps-terrain-browser-'));
const coordinator = new Coordinator(path.join(root, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
const server = await startServer({ port: 0, host: '127.0.0.1', targetPopulation: 0, log: false, dataDir: path.join(root, 'meridian'),
  node: { planet: 'meridian', id: 'terrain-fixture', secret, url: `http://127.0.0.1:${control.port}` } });
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32'
  ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const results: unknown[] = [];
await mkdir('artifacts', { recursive: true });
try {
  const world = server.game.world;
  const views = [
    { name: 'warm-hills', x: 3670, z: -2494, y: world.column(3670, -2494).h + 5, yaw: .2, pitch: -.12 },
    { name: 'rainforest', x: 3100, z: 3900, y: world.column(3100, 3900).h + 6, yaw: 0, pitch: -.10 },
    { name: 'snowy-summit', x: 1524, z: 3890, y: 300, yaw: 0, pitch: -.18 },
    { name: 'lava-detour', x: 3200, z: 5450, y: 240, yaw: .74, pitch: -.385 },
  ];
  if (requestedView) assert.ok(views.some(view => view.name === requestedView), 'choose an existing terrain view');
  assert.equal(snowCover(world.column(3670, -2494)), 0);
  assert.equal(snowCover(world.column(3100, 3900)), 0);
  assert.ok(snowCover(world.column(1524, 3580)) > .9);
  for (const mobile of [false, true]) {
    const device = mobile ? 'mobile' : 'desktop';
    const context = await browser.newContext(mobile
      ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(45_000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    for (const view of views) {
      if (requestedView && view.name !== requestedView) continue;
      if (mobile && view.name !== 'warm-hills' && view.name !== 'lava-detour') continue;
      const query = new URLSearchParams({ spectate: `${view.x},${view.y},${view.z}`, yaw: String(view.yaw),
        pitch: String(view.pitch), spin: '0', clean: '1', ...(mobile ? { quality: 'low' } : {}) });
      await page.goto(`http://127.0.0.1:${gateway.port}/?${query}`);
      await page.waitForFunction(() => (window as any).__mmofps?.state.initialized && (window as any).__mmofps.state.rendering.worldPresented);
      await page.waitForTimeout(8000);
      const state = await page.evaluate(() => (window as any).__mmofps.state);
      assert.deepEqual(errors, []);
      assert.equal(state.seed, 1337);
      assert.ok(state.connected && state.rendering.calls > 5 && state.rendering.triangles > 10_000);
      assert.ok(Math.abs(state.camera.x - view.x) < .01 && Math.abs(state.camera.y - view.y) < .01);
      if (view.name === 'warm-hills' || view.name === 'rainforest') assert.ok(state.vegetation.count > 50);
      await page.screenshot({ path: `artifacts/terrain-${view.name}-${device}.png` });
      results.push({ device, view: view.name, camera: state.camera, rendering: state.rendering,
        vegetation: state.vegetation, errors: [...errors] });
      console.log(`${device}: ${view.name} rendered without errors`);
    }
    await context.close();
  }
} finally {
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close();
  assert.equal(path.dirname(root), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('mmofps-terrain-browser-'));
  await rm(root, { recursive: true, force: true });
}
await writeFile(`artifacts/terrain-browser${requestedView ? `-${requestedView}` : '-check'}.json`, JSON.stringify({ results, serverStopped: true }, null, 2));
}
