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
import { advanceDaily, awardXp } from '../packages/server/src/progression.js';
import { XP_REASON, dailyDay, dailyOrders } from '../packages/shared/src/progression.js';
import { encodeTeleport } from '../packages/shared/src/protocol.js';
import { FINAL_PUSH_SECONDS } from '../packages/shared/src/frontier.js';
import { TICK_RATE } from '../packages/shared/src/constants.js';

// Real single-world universe (gateway, coordinator, world, client bundle).
// Rewards are granted through the server's own progression path; the war
// turnover is the frontier's own startWar. Requires `npm run build`.
const root = await mkdtemp(path.join(tmpdir(), 'mmofps-progression-browser-'));
const coordinator = new Coordinator(path.join(root, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
coordinator.enablePlanets(['meridian']);
const control = await startControlPlane(coordinator, secret);
const server = await startServer({ port: 0, host: '127.0.0.1', targetPopulation: 0, dataDir: path.join(root, 'meridian'), log: false,
  node: { planet: 'meridian', id: 'progression-fixture', secret, url: `http://127.0.0.1:${control.port}` } });
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const results: unknown[] = [];
await mkdir('artifacts', { recursive: true });
type Hook = { state: { myId: number; alive: boolean; deathCamera: boolean; progress: { xp: number } | null; war: { number: number } | null } };
const hook = () => (window as unknown as { __mmofps: Hook }).__mmofps;
try {
  for (const mobile of [false, true]) {
    const device = mobile ? 'mobile' : 'desktop', errors: string[] = [];
    const context = await browser.newContext(mobile ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(25_000);
    page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`http://127.0.0.1:${gateway.port}`);
    await page.waitForFunction(() => {
      const state = (window as unknown as { __mmofps?: { state: { initialized: boolean; rendering: { worldPresented?: boolean } } } }).__mmofps?.state;
      return !!state?.initialized && !!state.rendering.worldPresented;
    });
    // One world: no star-system travel button, no orbital chart.
    await page.waitForFunction(() => document.body.classList.contains('single-world'));
    assert.equal(await page.locator('#system-open').isVisible(), false, 'the star chart stays hidden with one world');
    const warNumber = server.game.frontier!.war.number;
    await page.waitForFunction(n => document.querySelector('#war-strip:not([hidden])')?.textContent?.includes(`WAR ${n}`), warNumber);

    const id = await page.evaluate(() => (window as unknown as { __mmofps: Hook }).__mmofps.state.myId);
    const player = server.game.players.get(id)!;
    assert.ok(player && !player.isBot);
    awardXp(player, 100, XP_REASON.KILL);
    await page.waitForFunction(() => [...document.querySelectorAll('.xp-ribbon')].some(e => e.textContent?.includes('+100') && e.textContent.includes('ENEMY ELIMINATED')));
    await page.waitForFunction(() => document.querySelector('.rank-badge')?.textContent === '1');
    awardXp(player, 1200, XP_REASON.CAPTURE);
    await page.waitForFunction(() => document.querySelector('.rank-badge')?.textContent === '2');
    await page.waitForFunction(() => document.querySelector('#war-banner:not([hidden]) b')?.textContent === 'PROMOTED');
    // The 1 Hz strategic snapshot reports the same persistent total.
    await page.waitForFunction(xp => (window as unknown as { __mmofps: Hook }).__mmofps.state.progress?.xp === xp, player.xp);
    await page.screenshot({ path: `artifacts/progression-xp-${device}.png` });

    // Daily orders: a compact line in the rank panel; finishing one pays a bonus.
    await page.waitForFunction(() => /^DAILY 0\/3$/.test(document.querySelector('.rank-daily:not([hidden]) b')?.textContent ?? ''));
    const kills = dailyOrders(dailyDay())[0];
    advanceDaily(player, 'kills', kills.goal);
    await page.waitForFunction(() => document.querySelector('#war-banner:not([hidden]) b')?.textContent === 'ORDER COMPLETE');
    await page.waitForFunction(() => document.querySelector('.rank-daily b')?.textContent === 'DAILY 1/3');
    await page.screenshot({ path: `artifacts/progression-daily-${device}.png` });

    // A decided war: a debrief card beside the action during the intermission.
    (server.game.frontier! as unknown as { decideWar(victor: number, tick: number, reason: string): void })
      .decideWar(player.faction, server.game.tick, 'browser check');
    await page.waitForFunction(n => {
      const card = document.querySelector('#war-debrief:not([hidden])');
      return !!card && card.textContent!.includes(`WAR ${n} DEBRIEF`) && /eliminations/.test(card.textContent!);
    }, warNumber);
    await page.screenshot({ path: `artifacts/progression-debrief-${device}.png` });

    // A new war: everyone redeploys into rotated homes without a death screen.
    const feedBefore = await page.locator('#feed .feed-line').count();
    const before = { x: player.state.px, z: player.state.pz };
    server.game.frontier!.startWar(warNumber + 1, server.game.tick);
    await page.waitForFunction(n => new RegExp(`WAR ${n} BEGINS|REDEPLOYING`).test(document.querySelector('#war-banner')?.textContent ?? ''), warNumber + 1);
    let deathCamera = false, alive = false;
    for (let i = 0; i < 80 && !alive; i++) {
      const state = await page.evaluate(() => { const s = (window as unknown as { __mmofps: Hook }).__mmofps.state; return { alive: s.alive, deathCamera: s.deathCamera }; });
      deathCamera ||= state.deathCamera; alive = state.alive && i > 3;
      await page.waitForTimeout(200);
    }
    assert.equal(deathCamera, false, 'a war redeploy never plays the death camera');
    assert.equal(alive, true, 'the soldier deploys into the new war');
    await page.waitForFunction(n => document.querySelector('#war-strip')?.textContent?.includes(`WAR ${n}`), warNumber + 1);
    await page.waitForFunction(() => document.querySelector('#war-debrief')?.hasAttribute('hidden'), null);
    const lines = await page.locator('#feed .feed-line').allTextContents();
    assert.ok(!lines.slice(0, Math.max(0, lines.length - feedBefore + 1)).some(line => /died/.test(line)), 'no kill-feed line for the redeploy');
    const moved = Math.hypot(player.state.px - before.x, player.state.pz - before.z);
    await page.screenshot({ path: `artifacts/progression-war-${device}.png` });

    // A stalled front: a final push (its clock is unit-tested; this server is
    // too young to have stalled) shows on the war strip and as a banner, and
    // a base changing hands calls it off.
    server.game.frontier!.war.pushEndsAt = server.game.tick + FINAL_PUSH_SECONDS * TICK_RATE;
    await page.waitForFunction(() => document.querySelector('#war-strip')?.textContent?.includes('FINAL PUSH'), null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelector('#war-banner:not([hidden]) b')?.textContent === 'FINAL PUSH');
    assert.ok(server.game.frontier!.war.pushEndsAt > server.game.tick, 'the final push is running');
    await page.screenshot({ path: `artifacts/progression-final-push-${device}.png` });
    (server.game.frontier! as unknown as { frontMoved(base: object): void }).frontMoved(server.game.frontier!.bases[0]);
    await page.waitForFunction(() => document.querySelector('#war-banner:not([hidden]) b')?.textContent === 'DEADLOCK BROKEN');
    await page.waitForFunction(n => document.querySelector('#war-strip')?.textContent?.includes(`WAR ${n}`), warNumber + 1);
    assert.equal(server.game.frontier!.war.pushEndsAt, -1, 'a base flip calls the push off');

    // DEPLOY NOW from far away: the map's button takes the soldier to the
    // staging of their current order (what the HUD's "HOLD Q: DEPLOY NOW" means).
    const f = server.game.frontier!, firstOrder = f.order(player)!;
    const rear = f.bases.filter(b => b.owner === player.faction)
      .sort((a, b) => Math.hypot(b.x - firstOrder.x, b.z - firstOrder.z) - Math.hypot(a.x - firstOrder.x, a.z - firstOrder.z))[0];
    const s = player.state, from = { x: s.px, y: s.py, z: s.pz };
    s.px = rear.x + 25; s.pz = rear.z + 25; s.py = server.game.world.groundY(s.px, s.pz) + .3; s.vx = s.vy = s.vz = 0;
    (server.game as unknown as { events: { bytes: Uint8Array }[] }).events.push({ bytes: encodeTeleport({ id,
      fromX: from.x, fromY: from.y, fromZ: from.z, toX: s.px, toY: s.py, toZ: s.pz }) });
    player.regenBlockUntil = 0; player.deployReadyAt = 0; player.preferredSpawnId = '';
    await page.waitForTimeout(2500);
    const order = f.order(player)!, usable = f.reinforcementOptions(player).filter(o => o.available !== false && o.kind !== 'air');
    const expected = usable.find(o => o.controlId === order.targetId) ?? usable.find(o => (o.baseId ?? o.id) === order.baseId);
    assert.ok(expected, `the order (${order.name}) has a deployment point`);
    const startDistance = Math.hypot(s.px - expected.x, s.pz - expected.z);
    // As a player would: G while the mouse is captured, the map button on touch.
    if (await page.evaluate('!!document.pointerLockElement')) await page.keyboard.press('KeyG');
    else await page.locator('#atlas-open').click();
    const deploy = page.locator('.respawn-choices button.deploy-now:not([disabled])');
    await deploy.waitFor();
    assert.ok((await deploy.textContent())!.includes(expected.name), `DEPLOY NOW names ${expected.name}`);
    await deploy.click();
    for (let i = 0; i < 40 && Math.hypot(player.state.px - expected.x, player.state.pz - expected.z) > 60; i++) await page.waitForTimeout(100);
    const arrived = Math.hypot(player.state.px - expected.x, player.state.pz - expected.z);
    assert.ok(arrived <= 60, `deployed to ${expected.name} (${Math.round(arrived)} m away, from ${Math.round(startDistance)} m)`);
    assert.equal(player.preferredSpawnId, '', 'a deployment does not become the remembered respawn choice');
    await page.waitForFunction(() => !document.querySelector('.atlas.open, #atlas.open'), null).catch(() => {});
    assert.deepEqual(errors, []);
    results.push({ device, xp: player.xp, rank: 2, promotion: true, war: warNumber + 1, redeployMoved: Math.round(moved), deathCamera,
      deployNow: { order: order.name, to: expected.name, fromMetres: Math.round(startDistance), arrivedMetres: Math.round(arrived) }, errors });
    await context.close();
    console.log(`${device}: progression and war checks passed`);
  }
  assert.equal(server.failure, null);
} finally {
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('mmofps-progression-browser-'));
  await rm(root, { recursive: true, force: true });
}
await writeFile('artifacts/progression-browser-check.json', JSON.stringify({ results, serverStopped: true }, null, 2));
console.log(JSON.stringify(results, null, 2));
