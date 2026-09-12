import { chromium, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { startServer, defaultClientDir } from '../packages/server/src/server.js';
import { ResourceField, type ResourceNode } from '../packages/shared/src/resources.js';
import { capsuleClearance } from '../packages/shared/src/physics.js';
import { planOutpost } from '../packages/shared/src/outposts.js';

// Fresh local characters start with zero salvage. Every credit and camp payment
// then travels through the rendered controls and production persistence path.
const root = await mkdtemp(path.join(tmpdir(), 'mmofps-resource-browser-'));
const coordinator = new Coordinator(path.join(root, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
let dropNext = false, dropped = 0;
const proxy = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const response = await fetch(`http://127.0.0.1:${control.port}${req.url}`, { method: 'POST',
      headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' }, body: Buffer.concat(chunks) });
    const body = await response.text();
    if (dropNext && req.url === '/resources/harvest' && response.ok) { dropNext = false; dropped++; res.destroy(); return; }
    res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(body);
  } catch { res.writeHead(503).end('{}'); }
});
await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
const proxyAddress = proxy.address(); assert.ok(proxyAddress && typeof proxyAddress !== 'string');
const startWorld = () => startServer({ port: 0, host: '127.0.0.1', seed: 1337, targetPopulation: 0, log: false,
  node: { id: `meridian:${randomUUID()}`, planet: 'meridian', secret, url: `http://127.0.0.1:${proxyAddress.port}` } });
let server = await startWorld();
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const results: unknown[] = [], used = new Set<string>();
await mkdir('artifacts', { recursive: true });
try {
  for (const mobile of [false, true]) {
    const device = mobile ? 'touch' : 'desktop', errors: string[] = [];
    const context = await browser.newContext(mobile ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
    const prepare = async () => {
      const page = await context.newPage(); page.setDefaultTimeout(25000);
      page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(`http://127.0.0.1:${gateway.port}`);
      await page.waitForFunction(() => (window as any).__mmofps?.state.initialized && (window as any).__mmofps.state.camps?.enabled && (window as any).__mmofps.state.rendering.worldPresented);
      return page;
    };
    let page = await prepare();
    const state = () => page.evaluate(() => (window as any).__mmofps.state);
    const id = (await state()).myId;
    server.game.players.get(id)!.salvage = 0;
    const field = new ResourceField(server.game.world);
    const choose = (): ResourceNode => {
      for (let cx = -13; cx <= -9; cx++) for (let cz = 13; cz <= 17; cz++) {
        const node = field.get(`${cx},${cz}`); if (!node || used.has(node.id)) continue;
        const z = node.z + 2.7, y = server.game.world.groundY(node.x, z) + .03;
        if (Math.abs(y - node.y) > .5 || capsuleClearance(server.game.world, node.x, y, z) < -.02) continue;
        used.add(node.id); return node;
      }
      throw new Error('No supported resource fixture');
    };
    const place = async (node: ResourceNode) => {
      const player = server.game.players.get(id)!;
      Object.assign(player.state, { px: node.x, py: server.game.world.groundY(node.x, node.z + 2.7) + .03, pz: node.z + 2.7, vx: 0, vy: 0, vz: 0, grounded: true });
      player.regenBlockUntil = 0;
      await page.waitForFunction(id => (window as any).__mmofps.state.resources?.target === id, node.id);
      if (!mobile && !await page.evaluate(() => !!document.pointerLockElement)) await page.locator('#c').click({ position: { x: 700, y: 450 } });
      await page.locator('#resource-harvest').waitFor({ state: 'visible' });
      await page.waitForFunction(() => !(document.querySelector('#resource-harvest') as HTMLButtonElement).disabled);
    };
    let touchSession: Awaited<ReturnType<typeof context.newCDPSession>> | null = null;
    const held = async (pressed: boolean) => {
      if (!mobile) { if (pressed) await page.keyboard.down('KeyF'); else await page.keyboard.up('KeyF'); return; }
      const cdp = touchSession ??= await context.newCDPSession(page);
      if (pressed) {
        const bounds = await page.locator('#resource-harvest').boundingBox(); assert.ok(bounds);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, id: 7 }] });
      } else await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const first = choose(); await place(first);
    await page.waitForFunction(() => (window as any).__mmofps.state.salvage === 0);
    await page.screenshot({ path: `artifacts/resources-${device}-ready.png` });
    await held(true); await page.waitForFunction(() => (window as any).__mmofps.state.resources.progress > 0);
    await page.waitForTimeout(700); await page.screenshot({ path: `artifacts/resources-${device}-extracting.png` }); await held(false); await page.waitForTimeout(500);
    assert.equal((await state()).salvage, 0, 'releasing a partial extraction gives no salvage');
    if (!mobile) dropNext = true;
    await held(true); await page.waitForFunction(() => (window as any).__mmofps.state.salvage === 12); await held(false);
    await page.waitForFunction(() => (window as any).__mmofps.state.resources.nodes.some((n: any) => n.id === (window as any).__mmofps.state.resources.target && n.remaining > 0));
    await page.screenshot({ path: `artifacts/resources-${device}-depleted.png` });
    await page.reload(); await page.waitForFunction(() => (window as any).__mmofps?.state.initialized && (window as any).__mmofps.state.salvage === 12);
    if (!mobile) { await page.close(); await server.close(); server = await startWorld(); page = await prepare(); }
    assert.equal((await state()).myId, id);
    await page.waitForFunction(id => (window as any).__mmofps.state.resources?.nodes.some((n: any) => n.id === id && n.remaining > 0), first.id);
    assert.equal((await state()).salvage, 12, 'the lost reply and worker replacement cannot duplicate the credit');
    const second = choose(); await place(second);
    if (mobile) {
      await page.setViewportSize({ width: 393, height: 852 }); await page.waitForTimeout(500);
      const hit = await page.locator('#resource-harvest').evaluate(button => {
        const r = button.getBoundingClientRect(); return { width: innerWidth, height: r.height, hit: document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2) === button };
      });
      assert.equal(hit.width, 393); assert.ok(hit.height >= 44 && hit.hit);
      await page.screenshot({ path: 'artifacts/resources-touch-portrait.png' });
    }
    await held(true); await page.waitForFunction(() => (window as any).__mmofps.state.salvage === 24); await held(false);
    if (mobile) await page.setViewportSize({ width: 844, height: 390 });
    const plan = planOutpost(server.game.world, 0, -1494, 1888, 0); assert.equal(plan.reason, null);
    const player = server.game.players.get(id)!;
    Object.assign(player.state, { px: plan.site.x, py: server.game.world.groundY(plan.site.x, plan.site.z + 7) + .03, pz: plan.site.z + 7, vx: 0, vy: 0, vz: 0, grounded: true });
    await page.waitForFunction(({ x, z }) => Math.hypot((window as any).__mmofps.state.pos.x - x, (window as any).__mmofps.state.pos.z - z) < .5, { x: plan.site.x, z: plan.site.z + 7 });
    if (mobile) await page.locator('#camp-open').click(); else await page.keyboard.press('KeyB');
    await page.waitForFunction(() => !(document.querySelector('#camp-place') as HTMLButtonElement).disabled);
    await page.locator('#camp-place').click();
    await page.waitForFunction(() => (window as any).__mmofps.state.salvage === 4);
    const built = (await state()).camps.sites.find((s: any) => s.owner === id); assert.ok(built);
    assert.ok(coordinator.outposts('meridian').some(s => s.id === built.id));
    await page.locator('#camp-close').click(); await page.waitForTimeout(500);
    await page.screenshot({ path: `artifacts/resources-${device}-camp.png` });
    if (mobile) await page.locator('#camp-open').click(); else await page.keyboard.press('KeyB');
    await page.locator(`[data-pack="${built.id}"]`).click();
    await page.waitForFunction(id => !(window as any).__mmofps.state.camps.sites.some((s: any) => s.id === id), built.id);
    assert.deepEqual(errors, []);
    results.push({ device, deposits: [first.id, second.id], partialCancelled: true, earned: 24, campCost: 20, balance: 4, reloadPreserved: true, workerRestart: !mobile, lostCommitReplies: mobile ? 0 : dropped, errors });
    await context.close();
  }
  assert.equal(dropped, 1);
  await writeFile('artifacts/resources-browser.json', JSON.stringify(results, null, 2)); console.log(JSON.stringify(results, null, 2));
} catch (error) {
  for (const context of browser.contexts()) for (const page of context.pages()) {
    await page.screenshot({ path: 'artifacts/resources-browser-failure.png' }).catch(() => {});
    await writeFile('artifacts/resources-browser-failure.json', JSON.stringify(await page.evaluate(() => (window as any).__mmofps?.state).catch(() => null), null, 2));
  }
  throw error;
} finally {
  await browser.close(); await gateway.close(); await server.close();
  await new Promise<void>(resolve => proxy.close(() => resolve())); await control.close(); coordinator.close();
  assert.equal(path.dirname(root), path.resolve(tmpdir())); await rm(root, { recursive: true, force: true });
}
