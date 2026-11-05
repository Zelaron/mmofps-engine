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
import { BTN, HYPERSPEED_ENABLED } from '../packages/shared/src/index.js';

// Positions and competing presence belong to this isolated fixture. Actual
// capture ticks, network snapshots, input, UI and persistence use game code.
const root = await mkdtemp(path.join(tmpdir(), 'mmofps-capture-browser-'));
const coordinator = new Coordinator(path.join(root, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
const server = await startServer({ port: 0, host: '127.0.0.1', targetPopulation: 0, dataDir: path.join(root, 'meridian'), log: false,
  node: { planet: 'meridian', id: 'capture-fixture', secret, url: `http://127.0.0.1:${control.port}` } });
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const results: unknown[] = [];
await mkdir('artifacts', { recursive: true });
try {
  for (const mobile of [false, true]) {
    const device = mobile ? 'mobile' : 'desktop', errors: string[] = [];
    const context = await browser.newContext(mobile ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(25_000);
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${gateway.port}`);
    await page.waitForFunction(() => (window as any).__mmofps?.state.initialized && (window as any).__mmofps.state.rendering.worldPresented);
    const id = await page.evaluate(() => (window as any).__mmofps.state.myId), player = server.game.players.get(id)!;
    let hyperDistance = 0;
    if (!mobile && HYPERSPEED_ENABLED) {
      await page.locator('#c').click({ position: { x: 710, y: 460 } });
      await page.waitForFunction(() => !!document.pointerLockElement);
      await page.keyboard.press('KeyH'); await page.locator('#hyperspeed-status').waitFor({ state: 'visible' });
      await page.waitForTimeout(250);
      assert.ok(player.lastCmd!.buttons & BTN.HYPER, 'normal URL transmits hyperspeed to the server');
      const before = { x: player.state.px, z: player.state.pz };
      await page.keyboard.down('KeyW'); await page.waitForTimeout(450); await page.keyboard.up('KeyW');
      hyperDistance = Math.hypot(player.state.px - before.x, player.state.pz - before.z);
      assert.ok(hyperDistance > 25, `hyperspeed moved ${hyperDistance} m in 450 ms`);
      await page.screenshot({ path: 'artifacts/capture-hyperspeed-desktop.png' });
      await page.keyboard.press('KeyH'); await page.locator('#hyperspeed-status').waitFor({ state: 'hidden' });
      await page.waitForTimeout(200); assert.equal(player.lastCmd!.buttons & BTN.HYPER, 0);
    }
    const frontier = server.game.frontier!, site = frontier.territories[1], sign = player.faction === 1 ? -1 : 1;
    const place = async (x: number, y: number, z: number) => {
      Object.assign(player.state, { px: x, py: y, pz: z, vx: 0, vy: 0, vz: 0, grounded: true });
      await page.waitForFunction(({ x, z }) => { const p = (window as any).__mmofps.state.pos; return Math.hypot(p.x - x, p.z - z) < .75; }, { x, z });
    };
    site.owner = player.faction === 1 ? 2 : 1; site.captureFaction = site.owner; site.captureProgress = .15; site.influence = site.owner === 1 ? -.15 : .15;
    await place(site.x, site.y + .02, site.z + 8);
    await page.waitForFunction(() => document.querySelector('#capture-phase')?.textContent === 'NEUTRALIZING');
    await page.waitForFunction(() => document.querySelector('#capture-phase')?.textContent === 'CAPTURING');
    assert.equal(site.owner, 0);
    await page.waitForFunction(() => Number(document.querySelector('.capture-track')?.getAttribute('aria-valuenow')) >= 5);
    await page.screenshot({ path: `artifacts/capture-progress-${device}.png` });

    const defender = server.game.addPlayer('Capture test defender', null);
    defender.faction = player.faction === 1 ? 2 : 1;
    Object.assign(defender.state, { px: site.x + 8, py: site.y + .02, pz: site.z + 8, vx: 0, vy: 0, vz: 0, grounded: true });
    try {
      await page.waitForFunction(() => document.querySelector('#capture-status')?.getAttribute('data-state') === 'contested');
      const paused = site.influence; await page.waitForTimeout(1250);
      assert.equal(site.influence, paused, 'enemy presence pauses authoritative progress');
      await page.screenshot({ path: `artifacts/capture-contested-${device}.png` });
      if (mobile) {
        const panel = await page.locator('#capture-status').boundingBox(), stick = await page.locator('#touch-stick').boundingBox();
        assert.ok(panel && stick); assert.ok(panel.y + panel.height <= stick.y || panel.x >= stick.x + stick.width, 'capture panel stays clear of the movement stick');
      }
    } finally { server.game.removePlayer(defender.id); }
    await page.waitForFunction(() => document.querySelector('#capture-phase')?.textContent === 'CAPTURING');
    await place(site.x, site.y + .02, site.z + site.radius + 18);
    await page.waitForFunction(() => document.querySelector('#capture-status')?.getAttribute('data-state') === 'approach');
    await page.waitForTimeout(300); const pausedOutside = site.influence; await page.waitForTimeout(700);
    assert.equal(site.influence, pausedOutside, 'leaving the ring stops capture');
    await place(site.x, site.y + .02, site.z + 8);
    // Desktop completes the entire neutral-to-owned interval at normal speed.
    // Mobile starts near completion after verifying the same live progression.
    if (mobile) { site.influence = sign * .9; site.captureFaction = player.faction; site.captureProgress = .9; }
    await page.waitForFunction(() => document.querySelector('#capture-phase')?.textContent === 'CONTROL POINT SECURED', undefined, { timeout: 45_000 });
    assert.equal(site.owner, player.faction);
    await page.screenshot({ path: `artifacts/capture-secured-${device}.png` });
    if (!mobile) {
      await page.reload(); await page.waitForFunction(() => (window as any).__mmofps?.state.initialized);
      await page.waitForFunction(() => document.querySelector('#capture-phase')?.textContent === 'CONTROL POINT SECURED');
    }

    const currentId = await page.evaluate(() => (window as any).__mmofps.state.myId), current = server.game.players.get(currentId)!;
    const harbor = frontier.territories.find(t => t.kind === 'harbor')!;
    harbor.owner = 0; harbor.influence = 0;
    Object.assign(current.state, { px: harbor.x + 4, py: harbor.y + .02, pz: harbor.z + 4, vx: 0, vy: 0, vz: 0, grounded: true });
    await page.waitForFunction(harborId => document.querySelector('#capture-status')?.getAttribute('data-territory') === harborId && document.querySelector('#capture-phase')?.textContent === 'CAPTURING', harbor.id);
    await page.waitForTimeout(1500); assert.ok(Math.abs(harbor.influence) > .02, 'standing on the quay advances harbor capture');
    assert.equal(server.game.world.liquidAt(current.state.px, current.state.py, current.state.pz), undefined);
    if (mobile) {
      await page.setViewportSize({ width: 393, height: 852 }); await page.waitForTimeout(800);
      const panel = await page.locator('#capture-status').boundingBox(); assert.ok(panel && panel.x >= 0 && panel.x + panel.width <= 393);
    }
    await page.screenshot({ path: `artifacts/capture-harbor-${device}.png` });
    assert.deepEqual(errors, []);
    results.push({ device, hyperDistance, neutralization: true, contestedPause: true, outsidePause: true, captured: true, harborCapture: true, errors });
    await context.close();
    console.log(`${device}: capture and input checks passed`);
  }
  assert.equal(server.failure, null);
} finally {
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('mmofps-capture-browser-'));
  await rm(root, { recursive: true, force: true });
}
await writeFile('artifacts/capture-browser-check.json', JSON.stringify({ results, serverStopped: true }, null, 2));
console.log(JSON.stringify(results, null, 2));
