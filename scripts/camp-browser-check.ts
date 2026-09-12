import { chromium, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { startServer, defaultClientDir } from '../packages/server/src/server.js';
import { planOutpost } from '../packages/shared/src/outposts.js';

// Private fixture positions a fresh player in actual wilderness; all build,
// spend, pack and reconnect actions use the production UI and wire protocol.
const root = await mkdtemp(path.join(tmpdir(), 'mmofps-camp-browser-'));
const coordinator = new Coordinator(path.join(root, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
const options = { port: 0, host: '127.0.0.1', seed: 1337, targetPopulation: 0, log: false,
  node: { planet: 'meridian' as const, secret, url: `http://127.0.0.1:${control.port}` } };
const startWorld = () => startServer({ ...options, node: { ...options.node, id: `meridian:${randomUUID()}` } });
let server = await startWorld();
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const results: unknown[] = [];
await mkdir('artifacts', { recursive: true });
try {
  for (const mobile of [false, true]) {
    const device = mobile ? 'mobile' : 'desktop', errors: string[] = [];
    const context = await browser.newContext(mobile ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } });
    const preparePage = async () => {
      const page = await context.newPage(); page.setDefaultTimeout(30_000);
      page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(`http://127.0.0.1:${gateway.port}`);
      await page.waitForFunction(() => (window as any).__mmofps?.state.initialized && (window as any).__mmofps.state.camps?.enabled);
      return page;
    };
    let page = await preparePage();
    const state = () => page.evaluate(() => (window as any).__mmofps.state);
    const openCamp = async () => { if (mobile) await page.locator('#camp-open').click(); else await page.keyboard.press('KeyB'); };
    const id = (await state()).myId;
    const proposed = planOutpost(server.game.world, 0, -1494, 1888, 0); assert.equal(proposed.reason, null);
    const site = proposed.site;
    const placePlayer = async (z: number) => {
      const p = server.game.players.get(id)!;
      Object.assign(p.state, { px: site.x, py: server.game.world.groundY(site.x, z) + .03, pz: z, vx: 0, vy: 0, vz: 0, grounded: true });
      await page.waitForFunction(({ x, z }) => { const p = (window as any).__mmofps.state.pos; return Math.hypot(p.x - x, p.z - z) < .5; }, { x: site.x, z });
      await page.waitForTimeout(1800);
    };
    await placePlayer(site.z + 7);
    await page.waitForFunction(() => (window as any).__mmofps.state.salvage >= 30);
    const initialSalvage = (await state()).salvage;
    await openCamp();
    await page.waitForFunction(() => !(document.querySelector('#camp-place') as HTMLButtonElement)?.disabled);
    await page.screenshot({ path: `artifacts/camp-preview-${device}.png` });
    await page.locator('#camp-place').click();
    await page.waitForFunction(id => (window as any).__mmofps.state.camps.sites.some((s: any) => s.owner === id && s.type === 0), id);
    await page.waitForFunction(expected => (window as any).__mmofps.state.salvage === expected, initialSalvage - 20);
    const shelterId = (await state()).camps.sites.find((s: any) => s.owner === id && s.type === 0).id;
    await page.locator('#camp-close').click(); await page.waitForTimeout(700);
    await page.screenshot({ path: `artifacts/camp-built-${device}.png` });
    if (mobile) {
      const stick = await page.locator('#touch-stick').boundingBox(); assert.ok(stick);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: stick.x + stick.width / 2, y: stick.y + 10, id: 1 }] });
      await page.waitForTimeout(1600); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.waitForFunction(() => !!document.pointerLockElement);
      await page.keyboard.down('KeyW'); await page.waitForTimeout(1600); await page.keyboard.up('KeyW');
    }
    await page.waitForTimeout(200);
    const inside = await state();
    assert.ok(inside.pos.z < site.z + 2.5 && inside.pos.z > site.z - 2.5, `Entered shelter and stopped at its back wall: ${JSON.stringify(inside.pos)}`);
    assert.ok(inside.alive && inside.health > 0);
    await page.screenshot({ path: `artifacts/camp-interior-${device}.png` });
    await placePlayer(site.z + 7);
    if (!mobile) {
      await page.close(); await server.close(); server = await startWorld();
      page = await preparePage();
    } else { await page.reload(); await page.waitForFunction(() => (window as any).__mmofps?.state.initialized); }
    await page.waitForFunction(id => (window as any).__mmofps.state.camps.sites.some((s: any) => s.id === id), shelterId);
    assert.equal((await state()).myId, id); assert.equal((await state()).salvage, initialSalvage - 20);
    await openCamp();
    if (mobile) {
      await page.setViewportSize({ width: 393, height: 852 }); await page.waitForTimeout(500);
      const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, panel: document.querySelector('#camp-builder')!.getBoundingClientRect().right }));
      assert.equal(layout.width, 393); assert.equal(layout.scroll, 393); assert.ok(layout.panel <= 393);
      await page.screenshot({ path: 'artifacts/camp-builder-portrait.png' });
    }
    await page.locator(`[data-pack="${shelterId}"]`).click();
    await page.waitForFunction(id => !(window as any).__mmofps.state.camps.sites.some((s: any) => s.id === id), shelterId);
    assert.equal(coordinator.outposts('meridian').some(s => s.id === shelterId), false);
    assert.equal((await state()).salvage, initialSalvage - 20);
    await page.locator('#camp-close').click();
    if (mobile) assert.equal((await state()).touch.active, true, 'closing the builder restores touch controls');
    if (mobile) { await page.setViewportSize({ width: 844, height: 390 }); await page.waitForTimeout(400); }
    await placePlayer(site.z + 7);
    const utilityType = mobile ? 2 : 1, utilityCost = mobile ? 30 : 25;
    await openCamp(); await page.locator(`[data-blueprint="${utilityType}"]`).click();
    await page.waitForFunction(() => !(document.querySelector('#camp-place') as HTMLButtonElement)?.disabled);
    await page.locator('#camp-place').click();
    await page.waitForFunction(type => (window as any).__mmofps.state.camps.sites.some((s: any) => s.type === type), utilityType);
    await page.waitForFunction(expected => (window as any).__mmofps.state.salvage === expected, initialSalvage - 20 - utilityCost);
    const utilityId = (await state()).camps.sites.find((s: any) => s.type === utilityType).id;
    await page.locator('#camp-close').click(); await placePlayer(site.z + 3.8);
    const served = server.game.players.get(id)!;
    served.health = 40; served.regenBlockUntil = 0; served.ammo[1].reserve = 0;
    await page.waitForTimeout(2300);
    const supplied = await state();
    if (utilityType === 1) assert.ok(supplied.health >= 50, 'the medical station restores more than passive regeneration');
    else assert.ok(supplied.ammo[1].reserve > 0, 'the fabricator replenishes actual weapon reserves');
    await page.screenshot({ path: `artifacts/camp-${mobile ? 'ammunition' : 'medical'}-${device}.png` });
    await openCamp(); await page.locator(`[data-pack="${utilityId}"]`).click();
    await page.waitForFunction(id => !(window as any).__mmofps.state.camps.sites.some((s: any) => s.id === id), utilityId);
    await page.locator('#camp-close').click();
    assert.deepEqual(errors, []);
    results.push({ device, initialSalvage, spent: 20 + utilityCost, shelterId, walkedInside: true, stoppedAtWall: true, retainedAfterReload: true, worldRestart: !mobile, packed: true,
      utility: utilityType === 1 ? 'medical' : 'ammunition', serviceObserved: true, rendering: supplied.rendering, errors });
    await context.close();
  }
  await writeFile('artifacts/camp-browser-check.json', JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close();
  assert.ok(path.resolve(root).startsWith(path.join(path.resolve(tmpdir()), 'mmofps-camp-browser-')));
  await rm(root, { recursive: true, force: true });
}
