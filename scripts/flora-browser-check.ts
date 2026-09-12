import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { startServer, defaultClientDir } from '../packages/server/src/server.js';

// Real deterministic groves, real terrain, and the production client shaders.
// The private fixture moves its own actor; no public camera/teleport API exists.
const label = process.argv.find(a => a.startsWith('--label='))?.slice(8) ?? 'current';
assert.match(label, /^[a-z0-9-]{1,40}$/);
const low = process.argv.includes('--low');
const clientDir = process.env.FLORA_CLIENT_DIR ?? defaultClientDir();
const coordinator = new Coordinator(':memory:'), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
const server = await startServer({ port: 0, host: '127.0.0.1', seed: 1337, targetPopulation: 0, log: false,
  node: { id: `flora:${randomUUID()}`, planet: 'meridian', secret, url: `http://127.0.0.1:${control.port}` } });
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32'
  ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const results: unknown[] = [];
await mkdir('artifacts', { recursive: true });
try {
  for (const mobile of [false, true]) {
    const device = mobile ? 'mobile' : 'desktop';
    const context = await browser.newContext(mobile
      ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(45_000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${gateway.port}/${low ? '?quality=low' : ''}`);
    await page.waitForFunction(() => (window as any).__mmofps?.state.initialized);
    const state = () => page.evaluate(() => (window as any).__mmofps.state);
    const player = server.game.players.get((await state()).myId)!;
    const cdp = mobile ? await context.newCDPSession(page) : undefined;
    if (!mobile) {
      await page.locator('#c').click({ position: { x: 720, y: 500 } });
      await page.waitForFunction(() => !!document.pointerLockElement);
    }
    for (const [view, x, z, pitch] of [
      ['canopy', 3381.9114, -2424.0414, .267],
      ['fronds', 3670.4146, -2493.7106, .24],
      ['horizon', 3501.6, -2110, .04],
    ] as const) {
      const y = server.game.world.groundY(x, z);
      Object.assign(player.state, { px: x, py: y + .05, pz: z, vx: 0, vy: 0, vz: 0 });
      player.teleportCdUntil = server.game.tick + 3600;
      await page.waitForFunction(({ x, z }) => {
        const p = (window as any).__mmofps.state.pos; return Math.hypot(p.x - x, p.z - z) < 1;
      }, { x, z });
      const camera = (await state()).camera;
      const dx = Math.round(camera.yaw / .0022), dy = Math.round((camera.pitch - pitch) / .0022);
      if (cdp) {
        // Keep the drag in the actual look area, clear of action buttons.
        const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 70));
        for (let step = 0; step < steps; step++) {
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 490, y: 215, id: 1 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 490 + dx / steps, y: 215 + dy / steps, id: 1 }] });
          await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        }
      } else {
        await page.evaluate(({ dx, dy }) => document.dispatchEvent(new MouseEvent('mousemove',
          { movementX: dx, movementY: dy, bubbles: true })), { dx, dy });
      }
      await page.waitForTimeout(8000);
      const observed = await state();
      assert.deepEqual(errors, []);
      assert.ok(observed.connected && observed.alive && observed.vegetation.count > 50);
      assert.ok(Math.abs(observed.camera.pitch - pitch) < .02, 'the requested canopy is in the camera view');
      assert.equal(observed.rendering.contactShadowPasses, low ? 0 : 2);
      const cadence = await page.evaluate(async () => {
        const frames: number[] = []; let previous = performance.now();
        for (let i = 0; i < 121; i++) {
          const now = await new Promise<number>(resolve => requestAnimationFrame(resolve));
          if (i) frames.push(now - previous); previous = now;
        }
        frames.sort((a, b) => a - b);
        return { medianMs: frames[59], p95Ms: frames[113], p99Ms: frames[118] };
      });
      await page.screenshot({ path: `artifacts/flora-${label}-${view}-${device}.png` });
      assert.deepEqual(errors, []);
      results.push({ device, view, quality: low ? 'low' : 'auto', camera: observed.camera,
        vegetation: observed.vegetation, rendering: observed.rendering, cadence, errors: [...errors] });
      await writeFile(`artifacts/flora-${label}.json`, JSON.stringify(results, null, 2));
    }
    await context.close();
  }
  await writeFile(`artifacts/flora-${label}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close();
}
