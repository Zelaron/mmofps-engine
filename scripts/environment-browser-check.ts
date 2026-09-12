import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { startServer, defaultClientDir } from '../packages/server/src/server.js';
import { VEHICLE } from '../packages/shared/src/vehicles.js';

// Private in-process fixture: observe real browser shaders at real generated
// vehicles, geology and caves. There is no writable public debug endpoint.
const lowQuality = process.argv.includes('--low');
const suffix = lowQuality ? '-low' : '';
const coordinator = new Coordinator(':memory:'), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
const server = await startServer({ port: 0, host: '127.0.0.1', seed: 1337, targetPopulation: 0, log: false,
  node: { id: 'meridian', planet: 'meridian', secret, url: `http://127.0.0.1:${control.port}` } });
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const results: unknown[] = [];
await mkdir('artifacts', { recursive: true });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(30_000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${gateway.port}/${lowQuality ? '?quality=low' : ''}`);
    await page.waitForFunction(() => (window as any).__mmofps?.state.initialized);
    const state = () => page.evaluate(() => (window as any).__mmofps.state);
    const player = server.game.players.get((await state()).myId)!;
    const capture = async (name: string, x: number, y: number, z: number) => {
      Object.assign(player.state, { px: x, py: y + .15, pz: z, vx: 0, vy: 0, vz: 0 });
      player.teleportCdUntil = server.game.tick + 3600;
      await page.waitForFunction(({ x, z }) => { const p = (window as any).__mmofps.state.pos; return Math.hypot(p.x - x, p.z - z) < 2; }, { x, z });
      await page.waitForTimeout(7000);
      const observed = await state(); assert.deepEqual(errors, []);
      assert.ok(observed.connected && observed.alive, `${name}: exploration stays playable`);
      assert.ok(observed.rendering.calls > 5 && observed.rendering.triangles > 10_000);
      assert.equal(observed.rendering.contactShadowPasses, lowQuality ? 0 : 2);
      const cadence = await page.evaluate(async () => {
        const frames: number[] = []; let previous = 0;
        for (let i = 0; i < 46; i++) {
          const now = await new Promise<number>(resolve => requestAnimationFrame(resolve));
          if (previous) frames.push(now - previous); previous = now;
        }
        frames.sort((a, b) => a - b); return { medianMs: frames[22], p95Ms: frames[42] };
      });
      await page.screenshot({ path: `artifacts/environment-${name}-${mobile ? 'mobile' : 'desktop'}${suffix}.png` });
      assert.deepEqual(errors, []);
      results.push({ device: mobile ? 'mobile-emulation' : 'desktop', quality: lowQuality ? 'low' : 'auto',
        view: name, rendering: observed.rendering, cadence,
        vehiclesVisible: observed.vehiclesVisible, rocks: observed.rocks, underground: observed.underground, errors: [...errors] });
      return observed;
    };
    for (const [name, type] of [['armor', VEHICLE.TANK], ['aircraft', VEHICLE.JET]] as const) {
      const hull = [...server.game.vehicles.values()].find(v => v.type === type && v.occupant < 0 && v.health > 0)!;
      assert.ok(hull, `${name}: an actual generated hull exists`);
      const x = hull.x - 4, z = hull.z + (type === VEHICLE.JET ? 19 : 12);
      const observed = await capture(name, x, server.game.world.groundY(x, z), z);
      assert.ok(observed.vehiclesVisible > 0, `${name}: the authoritative vehicle reached the browser`);
    }
    const cave = server.game.teleporterPads.find(p => p.cave)!;
    assert.ok(cave);
    const underground = await capture('cavern', cave.x + 3, cave.y, cave.z);
    assert.equal(underground.underground, true, 'the cave material and horizon render inside an actual cavern');
    await context.close();
  }
  await writeFile(`artifacts/environment-browser-check${suffix}.json`, JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close();
}
