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
import type { ServerPlayer } from '../packages/server/src/game.js';
import { FACTIONS, type Faction } from '../packages/shared/src/frontier.js';
import { PLAYER, TICK_RATE } from '../packages/shared/src/constants.js';
import { VEHICLE, vehicleDefinition } from '../packages/shared/src/vehicles.js';

// Isolated fixtures place their own actors and advance near-complete controls.
// Capture, death timing, selection packets, spawn validation and UI remain real.
const root = await mkdtemp(path.join(tmpdir(), 'mmofps-campaign-browser-'));
const cleanRoot = async () => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('mmofps-campaign-browser-'));
  await rm(root, { recursive: true, force: true });
};
const coordinator = new Coordinator(path.join(root, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
const server = await startServer({ port: 0, host: '127.0.0.1', targetPopulation: 0, dataDir: path.join(root, 'meridian'), log: false,
  node: { planet: 'meridian', id: 'campaign-fixture', secret, url: `http://127.0.0.1:${control.port}` } })
  .catch(async error => { await control.close(); coordinator.close(); await cleanRoot(); throw error; });
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() })
  .catch(async error => { await server.close(); await control.close(); coordinator.close(); await cleanRoot(); throw error; });
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] })
  .catch(async error => { await gateway.close(); await server.close(); await control.close(); coordinator.close(); await cleanRoot(); throw error; });
const frontier = server.game.frontier!, baseline = structuredClone(frontier.save()), results: unknown[] = [];
const reinforcementOptions = (player: ServerPlayer) => frontier.snapshot(player, server.game.players.values(), server.game.tick).reinforcements?.options ?? [];
const until = async (condition: () => boolean, message: string, timeout = 20_000) => {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(condition(), message);
};
const kill = (player: ServerPlayer, explosive = false) => {
  if (explosive) (server.game as unknown as { damage(victim: ServerPlayer, amount: number, attacker: ServerPlayer, weapon: number, x: number, y: number, z: number): void })
    .damage(player, 999, player, 3, 14, 16, 4);
  else (server.game as unknown as { kill(victim: ServerPlayer, attacker: ServerPlayer, weapon: number): void }).kill(player, player, 255);
  return server.game.tick;
};
await mkdir('artifacts', { recursive: true });
try {
  for (const mobile of [false, true]) {
    frontier.restore(baseline);
    const device = mobile ? 'mobile' : 'desktop', errors: string[] = [];
    const context = await browser.newContext(mobile ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(25_000);
    page.on('pageerror', error => { errors.push(error.message); console.error('Browser error:', error.message); }); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${gateway.port}`);
    await page.waitForFunction(() => (window as any).__mmofps?.state.initialized && (window as any).__mmofps.state.rendering.worldPresented);
    const id = await page.evaluate(() => (window as any).__mmofps.state.myId), player = server.game.players.get(id)!;
    assert.ok(player.faction >= 1 && player.faction <= 3, 'instant arrival assigns a combat faction');
    assert.equal(await page.locator('#frontier-atlas').isVisible(), false, 'no mandatory initial menu');
    await page.keyboard.press('KeyG'); await page.locator('#frontier-atlas').waitFor({ state: 'visible' });
    assert.match(await page.locator('#atlas-open').textContent() ?? '', /TACTICAL MAP/);
    assert.equal(await page.locator('.faction-choices [data-faction="0"]').count(), 0, 'unclaimed is not a playable faction');
    await page.locator('.faction-choices [data-faction="3"]').click(); await until(() => player.faction === 3, 'third faction can enlist');
    await page.locator('#atlas-close').click();

    const base = frontier.bases.find(base => base.kind === 'city' && base.owner === 0)!;
    assert.ok(base, 'fixture has an unclaimed city');
    const controls = frontier.territories.filter(site => base.controlIds.includes(site.id));
    for (const [index, site] of controls.slice(0, base.requiredPoints).entries()) {
      Object.assign(site, { owner: 0, influence: .99, captureFaction: player.faction, captureProgress: .99, pressureFaction: player.faction, progressRate: 0 });
      Object.assign(player.state, { px: site.x, py: site.y + .02, pz: site.z, vx: 0, vy: 0, vz: 0, grounded: true });
      player.spawnProtectedUntil = server.game.tick + 10 * TICK_RATE;
      await until(() => site.owner === player.faction, 'player captures the real control point');
      if (index + 1 < base.requiredPoints) {
        assert.notEqual(base.owner, player.faction, 'one point cannot claim the whole city');
        await page.keyboard.press('KeyG');
        await page.waitForFunction(baseId => document.querySelector(`.respawn-choices [data-spawn="${baseId}"]`)?.hasAttribute('disabled'), base.id);
        assert.match(await page.locator(`.reinforcement-local[data-base="${base.id}"]`).textContent() ?? '', /Capture 1 more.*2 of 3 controls/);
        assert.equal(await page.locator('.reinforcement-heading').isVisible(), true, 'G shows next-respawn choices while alive');
        assert.equal(await page.locator('.redeploy-countdown').isVisible(), false);
        await page.screenshot({ path: `artifacts/campaign-partial-${device}.png` });
        await page.locator('#atlas-close').click();
      }
    }
    await until(() => base.owner === player.faction, 'control majority unlocks the city');
    assert.ok(frontier.spawnOptions(player).some(option => option.id === base.id));
    await page.keyboard.press('KeyG');
    await page.locator(`.respawn-choices [data-spawn="${base.id}"]`).waitFor({ state: 'visible' });
    const beforePreference = { x: player.state.px, z: player.state.pz };
    await page.locator(`.respawn-choices [data-spawn="${base.id}"]`).click();
    await until(() => player.preferredSpawnId === base.id, 'living player can choose the next reinforcement spawn');
    assert.ok(Math.hypot(player.state.px - beforePreference.x, player.state.pz - beforePreference.z) < 1, 'choosing while alive never teleports');
    assert.equal(await page.locator('.respawn-choices button').first().getAttribute('data-spawn'), base.id, 'local city appears before distant bases');
    assert.match(await page.locator('#respawn-detail').textContent() ?? '', /does not move you now/);
    await page.screenshot({ path: `artifacts/campaign-living-reinforcements-${device}.png` });

    const blockers = controls.filter(site => site.owner === player.faction).map((site, index) => {
      const enemy = server.game.addPlayer(`Rally pressure ${index}`, null, true); enemy.faction = (player.faction % 3 + 1) as Faction;
      Object.assign(enemy.state, { px: site.x, py: site.y + .02, pz: site.z, vx: 0, vy: 0, vz: 0, grounded: true }); return enemy;
    });
    try {
      frontier.step(server.game.players.values(), server.game.tick, .2);
      await page.waitForFunction(baseId => document.querySelector(`.respawn-choices [data-spawn="${baseId}"]`)?.hasAttribute('disabled'), base.id);
      assert.equal(base.owner, player.faction, 'unsafe reinforcement area does not revoke base ownership');
      assert.equal(player.preferredSpawnId, base.id, 'temporarily blocked preference is remembered');
      assert.match(await page.locator('#respawn-detail').textContent() ?? '', /unavailable.*safe fallback.*preference is remembered/);
      assert.match(await page.locator(`.reinforcement-local[data-base="${base.id}"]`).textContent() ?? '', /SECURED.*THREATENED/);
      await page.screenshot({ path: `artifacts/campaign-threatened-reinforcements-${device}.png` });
    } finally { for (const enemy of blockers) server.game.removePlayer(enemy.id); }
    await until(() => frontier.spawnOptions(player).some(option => option.id === base.id), 'city reinforcements recover after the quiet period', 25_000);
    await page.waitForFunction(baseId => !document.querySelector(`.respawn-choices [data-spawn="${baseId}"]`)?.hasAttribute('disabled'), base.id);
    for (let report = 0; report < 8; report++) frontier.recordCombat(base.x + 100, base.z + 100, [player.faction, 2], server.game.tick);
    await page.locator('.battle-marker').first().waitFor({ state: 'visible' });
    assert.equal(await page.locator('.atlas-map-key').isVisible(), true, 'combat, death and navigation have a visible legend');
    const aliveSpawnChoice = player.preferredSpawnId;
    await page.locator('.atlas-battle').first().click();
    assert.equal(await page.locator('.atlas-zoom').textContent(), '4×', 'fight report focuses the battlefield');
    assert.equal(await page.locator('.atlas-map svg').getAttribute('viewBox'), await page.locator('.atlas-pins').getAttribute('viewBox'), 'terrain and live pins share the same zoom');
    assert.equal(player.state.alive, true); assert.equal(player.preferredSpawnId, aliveSpawnChoice, 'living map never changes the respawn choice');
    await page.locator('[data-map="world"]').click();
    await page.waitForFunction(({ ids, owner }) => ids.some(id => document.querySelector(`.territory-regions [data-territory="${id}"]`)?.getAttribute('data-owner') === String(owner)), { ids: controls.slice(0, base.requiredPoints).map(site => site.id), owner: player.faction });
    assert.equal(await page.locator('.atlas-ownership .ownership-meter i').count(), FACTIONS.length);
    await page.screenshot({ path: `artifacts/campaign-territories-${device}.png` });
    await page.locator('#atlas-close').click();
    await page.keyboard.press('KeyO'); await page.locator('#orbital-map').waitFor({ state: 'visible' });
    await page.locator('.orbit-planets [data-planet="0"]').click();
    assert.equal(await page.locator('.orbit-ownership .ownership-meter i').count(), FACTIONS.length);
    await page.screenshot({ path: `artifacts/campaign-planets-${device}.png` });
    await page.locator('.orbit-close').click();

    const selectedRally = { ...frontier.spawnOptions(player).find(option => option.id === base.id)! };
    const deathOrigin = { x: player.state.px, y: player.state.py, z: player.state.pz };
    const deathTick = kill(player, mobile), deathStarted = Date.now();
    await page.waitForFunction(() => !(window as any).__mmofps.state.alive);
    assert.equal(await page.locator('#frontier-atlas').isVisible(), false, 'death scene precedes the map');
    await page.waitForTimeout(650);
    const deathScene = await page.evaluate(() => ({ active: (window as any).__mmofps.state.deathCamera, body: (window as any).__mmofps.state.deathBody }));
    assert.ok(deathScene.active && deathScene.body, 'corpse camera is visible before deployment');
    if (mobile) {
      assert.equal(await page.locator('#touch-start').isVisible(), false, 'resume prompt stays hidden during the death scene');
      assert.ok(deathScene.body.y - deathOrigin.y > 2, 'explosive death launches the rendered corpse above the ground');
      assert.ok(Math.hypot(deathScene.body.x - deathOrigin.x, deathScene.body.z - deathOrigin.z) > 2, 'lethal server impulse carries through the death packet to visible body motion');
    }
    assert.equal(await page.locator('#frontier-atlas').isVisible(), false);
    await page.screenshot({ path: `artifacts/campaign-death-scene-${device}.png` });
    await page.locator('#frontier-atlas.redeploy-active').waitFor({ state: 'visible' });
    assert.ok(Date.now() - deathStarted >= 1400, 'map waits for the corpse camera');
    assert.equal(await page.locator('.death-marker').count(), 1, 'map marks where the player fell');
    assert.equal(await page.evaluate(() => !!document.pointerLockElement), false, 'death releases pointer lock');
    await page.locator(`.respawn-choices [data-spawn="${base.id}"]`).click();
    await until(() => player.preferredSpawnId === base.id, 'respawn choice reaches authority');
    assert.ok(Number(await page.locator('#respawn-countdown').textContent()) <= 10);
    assert.equal(await page.locator('.respawn-pin').count(), reinforcementOptions(player).length);
    const hitTargets = await page.locator('.respawn-hit').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
    assert.ok(hitTargets.every(width => width >= 43), `map spawn targets remain finger-sized: ${hitTargets.join(', ')}`);
    const deathClear = await page.evaluate(() => {
      const death = document.querySelector('.death-marker circle')!.getBoundingClientRect(), x = death.x + death.width / 2, y = death.y + death.height / 2;
      return [...document.querySelectorAll('.respawn-pin circle:not(.respawn-hit)')].every(node => {
        const r = node.getBoundingClientRect(); return Math.hypot(r.x + r.width / 2 - x, r.y + r.height / 2 - y) > 30;
      });
    });
    assert.ok(deathClear, 'spawn markers leave the last death cross visible');
    const controlsClear = await page.evaluate(() => {
      const tools = document.querySelector('.atlas-map-tools')!.getBoundingClientRect(), key = document.querySelector('.atlas-map-key')!.getBoundingClientRect();
      const map = document.querySelector('.atlas-cartography')!.getBoundingClientRect();
      return tools.bottom <= map.top + 1 && key.top >= map.bottom - 1;
    });
    assert.ok(controlsClear, 'map controls and legend cannot cover northern or coastal spawns');
    await page.keyboard.press('KeyO'); assert.equal(await page.locator('#orbital-map').isVisible(), false, 'death map retains exclusive controls');
    await page.screenshot({ path: `artifacts/campaign-respawn-${device}.png` });
    if (mobile) {
      await page.setViewportSize({ width: 393, height: 852 });
      await page.waitForFunction(() => [...document.querySelectorAll('.respawn-hit')].every(node => {
        const width = node.getBoundingClientRect().width; return width >= 43 && width <= 45;
      }), undefined, { timeout: 1000 });
      const list = await page.locator('.respawn-choices').boundingBox();
      assert.ok(list && list.x >= 0 && list.x + list.width <= 393, 'portrait selection fits viewport');
      await page.screenshot({ path: 'artifacts/campaign-respawn-portrait.png' });
      await page.locator('.atlas-cartography').scrollIntoViewIfNeeded();
      await page.screenshot({ path: 'artifacts/campaign-respawn-portrait-map.png' });
    }
    await page.waitForFunction(() => (window as any).__mmofps.state.alive);
    assert.ok(server.game.tick - deathTick >= PLAYER.RESPAWN_SECONDS * TICK_RATE, 'authoritative ten-second wait');
    assert.ok(Math.hypot(player.state.px - selectedRally.x, player.state.pz - selectedRally.z) < 250, 'chosen city reinforcement rally determines spawn');
    assert.ok(frontier.territories.every(site => Math.hypot(player.state.px - site.x, player.state.pz - site.z) > site.radius), 'reinforcements arrive outside capture rings');
    await page.locator('#frontier-atlas').waitFor({ state: 'hidden' });
    await page.keyboard.press('KeyG');
    assert.equal(await page.locator('.death-marker').count(), 1, 'the last death remains on the living tactical map');
    await page.locator('[data-map="death"]').click();
    assert.equal(await page.locator('.atlas-zoom').textContent(), '4×');
    await page.locator('#atlas-close').click();

    kill(player); await page.locator('#frontier-atlas.redeploy-active').waitFor({ state: 'visible' });
    await page.waitForFunction(baseId => document.querySelector(`.respawn-choices [data-spawn="${baseId}"]`)?.getAttribute('aria-pressed') === 'true', base.id);
    const enemy = (player.faction % 3 + 1) as Faction;
    for (const site of controls) Object.assign(site, { owner: enemy, influence: enemy === 1 ? -1 : 1, captureFaction: enemy, captureProgress: 1 });
    await until(() => base.owner === enemy, 'lost network removes base ownership');
    await page.waitForFunction(baseId => {
      const option = document.querySelector(`.respawn-choices [data-spawn="${baseId}"]`); return !option || option.hasAttribute('disabled');
    }, base.id);
    await page.waitForFunction(() => (window as any).__mmofps.state.alive);
    assert.ok(frontier.spawnOptions(player).filter(option => (option.baseId ?? option.id) !== base.id).some(option => Math.hypot(player.state.px - option.x, player.state.pz - option.z) < 250), 'lost selected base falls back to an available spawn');

    let mobileSpawnChecked = false;
    if (!mobile) {
      const jeep = [...server.game.vehicles.values()].find(vehicle => vehicle.type === VEHICLE.JEEP && vehicle.occupant < 0)!;
      const spot = selectedRally;
      Object.assign(jeep, { x: spot.x, y: spot.y, z: spot.z, health: vehicleDefinition(VEHICLE.JEEP)!.maxHealth,
        campaignFaction: player.faction, occupant: -1, gunner: -1, motionState: undefined, respawnAtTick: -1 });
      await until(() => frontier.spawnOptions(player).some(option => option.id === `mobile-${jeep.id}`), 'parked friendly jeep offers a mobile spawn');
      kill(player); await page.locator('#frontier-atlas.redeploy-active').waitFor({ state: 'visible' });
      await page.locator(`.respawn-pin[data-spawn="mobile-${jeep.id}"] .respawn-hit`).click();
      await until(() => player.preferredSpawnId === `mobile-${jeep.id}`, 'map marker selects mobile spawn');
      jeep.health = 0; jeep.respawnAtTick = server.game.tick + 30 * TICK_RATE;
      await page.locator(`.respawn-choices [data-spawn="mobile-${jeep.id}"]`).waitFor({ state: 'detached' });
      await page.waitForFunction(() => (window as any).__mmofps.state.alive);
      assert.ok(frontier.spawnOptions(player).filter(option => option.kind === 'base').some(option => Math.hypot(option.x - player.state.px, option.z - player.state.pz) < 250));
      mobileSpawnChecked = true;
    }
    assert.deepEqual(errors, []);
    results.push({ device, faction: player.faction, majorityUnlock: true, ownershipMap: true, planetShares: true,
      tenSecondRespawn: true, rememberedSelection: true, lostBaseFallback: true, mobileSpawnChecked,
      delayedDeathMap: true, explosiveDeathCamera: mobile, persistentDeathMarker: true, recentCombatReports: true, livingMapZoom: true,
      livingPreferenceWithoutTeleport: true, partialBaseExplanation: true, threatenedRallyExplanation: true, quietRallyRecovery: true, reinforcementOutsideCapture: true, errors });
    await context.close(); console.log(`${device}: campaign, ownership and respawn checks passed`);
  }
  assert.equal(server.failure, null);
} catch (error) {
  const page = browser.contexts().flatMap(context => context.pages())[0];
  if (page) {
    await page.screenshot({ path: 'artifacts/campaign-browser-failure.png' }).catch(() => {});
    const ui = await page.evaluate(() => ({ initialized: (window as any).__mmofps?.state.initialized,
      alive: (window as any).__mmofps?.state.alive, atlas: document.querySelector('#frontier-atlas')?.getAttribute('class'),
      mapLayout: { bounds: document.querySelector('.atlas-pins')?.getBoundingClientRect().toJSON(),
        viewBox: document.querySelector('.atlas-pins')?.getAttribute('viewBox'),
        targets: [...document.querySelectorAll('.respawn-hit')].map(node => ({ r: node.getAttribute('r'), box: node.getBoundingClientRect().toJSON() })) },
      regions: [...document.querySelectorAll('.territory-regions polygon')].map(region => ({ id: region.getAttribute('data-territory'), owner: region.getAttribute('data-owner') })),
      respawn: document.querySelector('.respawn-panel')?.textContent })).catch(error => ({ browserClosed: String(error) }));
    await writeFile('artifacts/campaign-browser-failure.json', JSON.stringify({ error: String(error), stack: error instanceof Error ? error.stack : undefined,
      serverFailure: server.failure?.message, players: [...server.game.players.values()].map(player => ({ id: player.id, faction: player.faction, alive: player.state.alive, selected: player.preferredSpawnId })), ui,
      controls: frontier.territories.map(site => ({ id: site.id, x: site.x, z: site.z, owner: site.owner })) }, null, 2));
  }
  throw error;
} finally {
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close();
  await cleanRoot();
}
await writeFile('artifacts/campaign-browser-check.json', JSON.stringify({ results, serverStopped: true }, null, 2));
console.log(JSON.stringify(results, null, 2));
