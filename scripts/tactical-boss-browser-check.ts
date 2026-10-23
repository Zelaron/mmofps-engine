import { chromium, type Page } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { startServer, defaultClientDir } from '../packages/server/src/server.js';
import { Game, type ServerPickup, type ServerPlayer } from '../packages/server/src/game.js';
import { CREATURE, CREATURE_DEFS } from '../packages/shared/src/wildlife.js';
import { PICKUP_WEAPON, type PickupKind } from '../packages/shared/src/protocol.js';
import { NUKE_LAUNCHER_ID, RAILGUN_ID } from '../packages/shared/src/weapons.js';
import { VEHICLE, vehicleDefinition } from '../packages/shared/src/vehicles.js';
import { TICK_RATE } from '../packages/shared/src/constants.js';

// Private fixture actors hold known positions on real, generated terrain.
// We arrange ownership, boss health and damage to reach the desired encounter
// quickly; maps, attacks, rewards, pickup contact, wire messages, rendering and
// character checkpoints all use the production pipeline. No user data is read.
type Point = { x: number; y: number; z: number };
type LootAccess = { spawnPickup(kind: PickupKind, weapon: number, victim: ServerPlayer): ServerPickup | null };
const began = Date.now();
const results: unknown[] = [];
const timers = new Set<NodeJS.Timeout>();
const until = async (condition: () => boolean, message: string, timeout = 15_000) => {
  const deadline = Date.now() + timeout;
  while (!condition() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(condition(), message);
};

// Search before starting any authoritative clock. The second World used by
// the real server has the same seed and geometry, without synthetic floors.
function findArena(): { boss: Point; player: Point; controlId: string } {
  const game = new Game(1337, { frontier: true });
  const world = game.world, frontier = game.frontier!;
  const base = frontier.bases.find(b => b.kind === 'city' && !b.owner) ?? frontier.bases[0];
  for (const radius of [700, 1000, 1400, 1800, 2200]) for (let i = 0; i < 24; i++) {
    const angle = i * Math.PI / 12, x = base.x + Math.cos(angle) * radius, z = base.z + Math.sin(angle) * radius;
    if (frontier.bases.some(b => Math.hypot(b.x - x, b.z - z) < 340)) continue;
    const column = world.column(x, z), y = world.groundY(x, z);
    if (column.city || Math.abs(column.h - y) > 2 || world.liquidAt(x, y + .08, z)) continue;
    if ([0, 1, 2, 3].some(j => {
      const px = x + Math.cos(j * Math.PI / 2) * 5, pz = z + Math.sin(j * Math.PI / 2) * 5;
      return Math.abs(world.groundY(px, pz) - y) > 1.5 || !!world.liquidAt(px, y + .08, pz);
    })) continue;
    const player = { x, y: world.groundY(x, z + 140) + .04, z: z + 140 };
    if (frontier.bases.some(b => Math.hypot(b.x - player.x, b.z - player.z) < 120) ||
        world.liquidAt(player.x, player.y + .08, player.z) || world.sdf(player.x, player.y + 1, player.z) < .5) continue;
    const originY = y + CREATURE_DEFS[CREATURE.OSSUARY_TITAN].height * .65;
    const dy = player.y + 1 - originY, length = Math.hypot(140, dy);
    if (world.trace(x, originY, z, 0, dy / length, 140 / length, length - .2).hit) continue;
    const control = [...frontier.territories].sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z))[0];
    return { boss: { x, y: y + .03, z }, player, controlId: control.id };
  }
  throw new Error('No real-terrain boss test clearing with a clear firing line was found');
}
const arena = findArena();
console.log('Prepared real-terrain tactical fixture', arena);
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.join(tmpdir(), 'mmofps-tactical-boss-'));
const cleanup: (() => Promise<unknown> | unknown)[] = [async () => {
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
  assert.ok(path.basename(root).startsWith('mmofps-tactical-boss-'));
  await rm(root, { recursive: true, force: true });
}];
let activePage: Page | undefined;
try {
  const coordinator = new Coordinator(path.join(root, 'universe.sqlite'));
  cleanup.push(() => coordinator.close());
  const secret = randomBytes(32).toString('hex');
  const control = await startControlPlane(coordinator, secret);
  cleanup.push(() => control.close());
  const server = await startServer({ port: 0, host: '127.0.0.1', targetPopulation: 0,
    dataDir: path.join(root, 'meridian'), log: false,
    node: { planet: 'meridian', id: 'tactical-boss-fixture', secret, url: `http://127.0.0.1:${control.port}` } });
  cleanup.push(() => server.close());
  const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() });
  cleanup.push(() => gateway.close());
  const browser = await chromium.launch({ headless: true,
    args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
  cleanup.push(() => browser.close());
  const frontier = server.game.frontier!;
  const territory = frontier.territories.find(t => t.id === arena.controlId)!;
  const baseline = structuredClone(frontier.save());
  for (const mobile of [false, true]) {
    frontier.restore(baseline);
    const device = mobile ? 'mobile' : 'desktop', errors: string[] = [];
    const context = await browser.newContext(mobile
      ? { viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
      : { viewport: { width: 1440, height: 900 } });
    const page = activePage = await context.newPage();
    page.setDefaultTimeout(25_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${gateway.port}${mobile ? '/?quality=low' : '/'}`);
    await page.waitForFunction(() => (window as any).__mmofps?.state.initialized);
    const player = server.game.players.get(await page.evaluate(() => (window as any).__mmofps.state.myId))!;
    assert.ok(player && !player.isBot);
    const position = (p: ServerPlayer, at: Point) => Object.assign(p.state, { px: at.x, py: at.y, pz: at.z,
      vx: 0, vy: 0, vz: 0, grounded: true, vehicle: VEHICLE.NONE, alive: true });
    position(player, arena.player); player.health = 100; player.spawnProtectedUntil = -1;
    const ground = (x: number, z: number): Point => ({ x, y: server.game.world.groundY(x, z) + .04, z });
    const anchors: { p: ServerPlayer; at: Point }[] = [];
    const actor = (name: string, faction: ServerPlayer['faction'], at: Point) => {
      const p = server.game.addPlayer(name, null, true); p.faction = faction; p.health = 100;
      if (p.vehicleId >= 0) (server.game as unknown as { exitVehicle(p: ServerPlayer): void }).exitVehicle(p);
      position(p, at); anchors.push({ p, at }); return p;
    };
    const enemyFaction = (player.faction % 3 + 1) as ServerPlayer['faction'];
    actor('Map friendly', player.faction, ground(arena.player.x + 165, arena.player.z + 30));
    actor('Map enemy', enemyFaction, ground(arena.player.x - 160, arena.player.z + 65));
    actor('Control defender', player.faction, { x: territory.x - 3, y: territory.y + .05, z: territory.z });
    actor('Control attacker', enemyFaction, { x: territory.x + 3, y: territory.y + .05, z: territory.z });
    Object.assign(territory, { owner: player.faction, captureFaction: player.faction, captureProgress: .55,
      influence: player.faction === 1 ? -.55 : .55 });
    const adjacent = frontier.territories.filter(t => t.id !== territory.id)
      .sort((a, b) => Math.hypot(a.x - territory.x, a.z - territory.z) - Math.hypot(b.x - territory.x, b.z - territory.z))[0];
    Object.assign(adjacent, { owner: enemyFaction, captureFaction: enemyFaction, captureProgress: 1,
      influence: enemyFaction === 1 ? -1 : 1 });
    const hull = [...server.game.vehicles.values()].find(v => v.type === VEHICLE.JEEP && v.occupant < 0 && v.respawnAtTick < 0)!;
    assert.ok(hull);
    const originalHull = { ...hull };
    Object.assign(hull, ground(arena.player.x + 110, arena.player.z + 205), {
      health: vehicleDefinition(VEHICLE.JEEP)!.maxHealth, occupant: -1, gunner: -1,
      campaignFaction: player.faction, respawnAtTick: -1, motionState: undefined });
    const preview = (server.game as unknown as LootAccess).spawnPickup(PICKUP_WEAPON, RAILGUN_ID,
      { state: { px: arena.player.x + 85, py: server.game.world.groundY(arena.player.x + 85, arena.player.z - 60), pz: arena.player.z - 60 } } as ServerPlayer);
    assert.ok(preview); preview.expiresAtTick = server.game.tick + 180 * TICK_RATE;
    const boss = server.game.wildlife.spawn(CREATURE.OSSUARY_TITAN, arena.boss);
    assert.ok(boss, 'real clearing is dry and outside protected bases');
    boss.health = CREATURE_DEFS[boss.species].health * .75; boss.turnAt = Number.MAX_SAFE_INTEGER;
    let lastBattle = -1;
    const timer = setInterval(() => {
      for (const { p, at } of anchors) { position(p, at); p.health = 100; }
      // This focused fixture supplies its boss explicitly; ambient encounter
      // waves are covered by the ecology suites and would obscure screenshots.
      for (const id of server.game.wildlife.creatures.keys()) if (id !== boss.id) server.game.wildlife.creatures.delete(id);
      if (server.game.tick - lastBattle >= 30) {
        lastBattle = server.game.tick;
        frontier.recordCombat(territory.x, territory.z, [player.faction, enemyFaction], server.game.tick);
      }
    }, 40);
    timers.add(timer);
    try {
      await page.waitForFunction(at => {
        const s = (window as any).__mmofps?.state;
        return s?.rendering.worldPresented && Math.hypot(s.pos.x - at.x, s.pos.z - at.z) < 8;
      }, arena.player, { timeout: 50_000 });
      await page.waitForFunction(() => (window as any).__mmofps.state.mapArtwork?.ready, undefined, { timeout: 55_000 });
      assert.equal((await page.evaluate(() => (window as any).__mmofps.state.mapArtwork)).failed, false);
      await page.keyboard.press('KeyM');
      await page.locator('#navigation-map').waitFor({ state: 'visible' });
      await page.waitForFunction(() => /[1-9]\d* FRIENDLY/.test(document.querySelector('.navigation-status')?.textContent ?? '') &&
        /[1-9]\d* HOSTILE/.test(document.querySelector('.navigation-status')?.textContent ?? ''));
      const minimap = await page.locator('#navigation-map').boundingBox(), viewport = page.viewportSize()!;
      assert.ok(minimap && minimap.x >= 0 && minimap.y >= 0 && minimap.x + minimap.width <= viewport.width + 1 &&
        minimap.y + minimap.height <= viewport.height + 1, 'minimap fits the viewport');
      const canvasColors = await page.locator('#navigation-map canvas').evaluate((node: HTMLCanvasElement) => {
        const bytes = node.getContext('2d')!.getImageData(0, 0, node.width, node.height).data, colors = new Set<number>();
        for (let i = 0; i < bytes.length; i += 16) colors.add(bytes[i] * 65536 + bytes[i + 1] * 256 + bytes[i + 2]);
        return colors.size;
      });
      assert.ok(canvasColors > 100, 'minimap has rendered terrain and tactical detail');
      await page.screenshot({ path: `artifacts/tactical-minimap-${device}.png` });
      console.log(`${device}: minimap screenshot ready`);

      await page.keyboard.press('KeyG');
      await page.locator('#frontier-atlas').waitFor({ state: 'visible' });
      await page.locator('[data-map="world"]').click();
      const contact = '.atlas-live-pins .map-contact';
      for (const selector of [`${contact}[data-kind="vehicle"]`,
        `${contact}[data-kind="boss"]`, '.map-frontline', '.atlas-order-card'])
        await page.locator(selector).first().waitFor({ state: 'visible' });
      const threat = page.locator(`.atlas-threat[data-threat="${boss.id}"]`);
      await threat.waitFor({ state: 'visible' });
      assert.match(await threat.textContent() ?? '', /Ossuary Titan.*75% HP/);
      assert.equal(await threat.locator('i').evaluate(node => (node as HTMLElement).style.getPropertyValue('--threat-health')), '75%');
      await page.locator('.atlas-cartography').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `artifacts/tactical-atlas-world-${device}.png` });
      console.log(`${device}: world atlas screenshot ready`);
      await threat.click();
      await page.waitForFunction(() => document.querySelector('.atlas-zoom')?.textContent?.startsWith('4'));
      for (const selector of [`${contact}[data-kind="infantry"][data-relation="friendly"]`,
        `${contact}[data-kind="infantry"][data-relation="hostile"]`, `${contact}[data-kind="loot"]`])
        await page.locator(selector).first().waitFor({ state: 'visible' });
      await until(() => territory.contested, 'the fixture control remains contested');
      await page.waitForFunction(name => [...document.querySelectorAll('.map-site title')]
        .some(node => node.textContent?.includes(name) && node.textContent.includes('CONTESTED')), territory.name);
      await page.locator('.map-control-active').first().waitFor({ state: 'visible' });
      await page.locator('.map-control-status').first().waitFor({ state: 'visible' });
      const views = await page.locator('.atlas-map svg, .atlas-pins, .atlas-live-pins').evaluateAll(nodes => nodes.map(n => n.getAttribute('viewBox')));
      assert.ok(views.length >= 3 && views.every(v => v === views[0]), 'terrain, strategic state and live units share the focused viewport');
      await page.locator('.atlas-cartography').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `artifacts/tactical-atlas-local-${device}.png` });
      console.log(`${device}: focused atlas screenshot ready`);
      const mapLabels = await page.locator('.map-placed-label text').evaluateAll(nodes => nodes.map(node => ({
        text: node.textContent, box: node.getBoundingClientRect().toJSON(),
      })));
      for (let i = 0; i < mapLabels.length; i++) for (let j = i + 1; j < mapLabels.length; j++) {
        const a = mapLabels[i].box, b = mapLabels[j].box;
        assert.ok(a.right <= b.left + .5 || b.right <= a.left + .5 || a.bottom <= b.top + .5 || b.bottom <= a.top + .5,
          `map labels overlap: ${mapLabels[i].text} / ${mapLabels[j].text}`);
      }
      const glyphs = await page.locator('.atlas-live-pins .map-contact > path').evaluateAll(nodes => nodes.map(node => ({
        kind: (node.parentElement as unknown as HTMLElement).dataset.kind, height: node.getBoundingClientRect().height,
      })));
      assert.ok(glyphs.length && glyphs.every(glyph => glyph.height >= 4 && glyph.height <= 24),
        'unit glyphs keep legible screen sizes at local zoom');
      const mapReadout = await page.locator('.atlas-contact-readout').textContent();
      await page.locator('#atlas-close').click();

      // Damage from outside the ordinary notice radius provokes a real cast.
      // The server chooses its target and publishes its committed trajectory.
      boss.rangedAt = 0; boss.attackAt = 0;
      server.game.wildlife.damage(boss, 180, player.id, server.game.tick);
      await until(() => !!boss.rangedAttack, 'distant damage provokes a ranged attack');
      const attack = { ...boss.rangedAttack! };
      assert.ok(Math.hypot(player.state.px - boss.x, player.state.pz - boss.z) > CREATURE_DEFS[boss.species].notice);
      await page.waitForFunction(() => {
        const s = (window as any).__mmofps.state;
        return s.bossAttacks.targetZones > 0 && s.bossAttacks.bolts > 0 && !(document.querySelector('#boss-warning') as HTMLElement)?.hidden;
      }, undefined, { timeout: 7000 });
      const warning = await page.locator('#boss-warning').textContent();
      assert.match(warning ?? '', /Ossuary|TITAN|BLAST/i);
      await page.screenshot({ path: `artifacts/tactical-boss-warning-${device}.png` });
      // Reposition only this fixture actor to leave the already committed aim
      // point. The warning disappears through normal movement snapshots.
      const escaped = ground(player.state.px + attack.radius + 20, player.state.pz);
      const healthBefore = player.health;
      position(player, escaped);
      await page.waitForFunction(() => (document.querySelector('#boss-warning') as HTMLElement)?.hidden === true);
      await until(() => server.game.tick >= attack.fireTick + 6, 'the cast reaches its real release tick');
      const renderedBolt = await page.evaluate(() => (window as any).__mmofps.state.bossAttacks.bolts);
      assert.ok(renderedBolt > 0, 'the real attack snapshot renders a flying bolt');
      await page.screenshot({ path: `artifacts/tactical-boss-bolt-${device}.png` });
      await until(() => server.game.tick > attack.impactTick + 12, 'committed impact resolves');
      assert.equal(player.health, healthBefore, 'leaving the committed target avoids the blast');

      const salvageBefore = player.salvage;
      server.game.wildlife.damage(boss, boss.health, player.id, server.game.tick);
      await page.locator('.announce-line.announce-bounty').waitFor({ state: 'visible' });
      const announcement = await page.locator('.announce-line.announce-bounty').textContent();
      assert.match(announcement ?? '', /PLANET BOUNTY:.*Ossuary Titan.*Nuke Launcher/);
      const cache = [...server.game.pickups.values()].find(p => p.kind === PICKUP_WEAPON && p.weapon === NUKE_LAUNCHER_ID && p.rewardFor?.has(player.id));
      assert.ok(cache, 'boss created a participant-reserved real weapon pickup');
      await page.screenshot({ path: `artifacts/tactical-boss-bounty-${device}.png` });
      position(player, { x: boss.x, y: server.game.world.groundY(boss.x, boss.z) + .04, z: boss.z });
      await until(() => player.ammo[NUKE_LAUNCHER_ID].magazine === 5 && player.ammo[NUKE_LAUNCHER_ID].reserve === 4,
        'ordinary authoritative pickup contact loads the boss weapon and ammo');
      await page.waitForFunction(expected => {
        const s = (window as any).__mmofps.state;
        return s.salvage === expected && s.ammo[6]?.magazine === 5 && s.ammo[6]?.reserve === 4;
      }, salvageBefore + 500);
      assert.ok(!server.game.pickups.has(cache.id));
      assert.deepEqual(errors, []);
      assert.equal(server.failure, null);
      const cookies = await context.cookies(), cookie = cookies.find(c => c.name === 'mmofps-session');
      assert.ok(cookie);
      const key = createHash('sha256').update(cookie.value).digest('hex');
      const expectedSalvage = player.salvage;
      await context.close(); activePage = undefined;
      await until(() => coordinator.locate(key)?.state?.salvage === expectedSalvage &&
        coordinator.locate(key)?.state?.ammo[NUKE_LAUNCHER_ID]?.magazine === 5,
      'real disconnect checkpoint persists the bounty and collected launcher');
      results.push({ device, viewport, minimap, canvasColors, mapReadout, normalizedBossHealth: .75,
        focusedViewBox: views[0], mapLabels, glyphs, rangedAttack: attack, warning, renderedBolt, escapedWithoutDamage: true,
        announcement, rewardSalvage: player.salvage - salvageBefore, nukeAmmo: player.ammo[NUKE_LAUNCHER_ID],
        characterCheckpoint: true, browserErrors: errors });
      console.log(`${device}: tactical maps, ranged boss, reward and persistence passed`);
    } catch (error) {
      if (!page.isClosed()) {
        await page.screenshot({ path: 'artifacts/tactical-boss-active-failure.png' }).catch(() => {});
        const layout = await page.evaluate(() => {
          const svg = document.querySelector<SVGSVGElement>('.atlas-pins'), matrix = svg?.getScreenCTM();
          return { bounds: svg?.getBoundingClientRect().toJSON(), viewBox: svg?.getAttribute('viewBox'),
            matrix: matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : null,
            status: document.querySelector('.atlas-situation')?.textContent,
            active: [...document.querySelectorAll('.map-control-active')].map(node => ({ x: node.getAttribute('cx'),
              y: node.getAttribute('cy'), box: node.getBoundingClientRect().toJSON() })),
            labels: [...document.querySelectorAll('.map-placed-label text')].map(node => ({ text: node.textContent,
              box: node.getBoundingClientRect().toJSON() })) };
        }).catch(() => null);
        await writeFile('artifacts/tactical-boss-active-failure.json', JSON.stringify({ device, error: String(error),
          territory: { id: territory.id, contested: territory.contested }, layout }, null, 2));
      }
      throw error;
    } finally {
      clearInterval(timer); timers.delete(timer);
      for (const { p } of anchors) server.game.removePlayer(p.id);
      server.game.pickups.delete(preview.id); server.game.wildlife.creatures.delete(boss.id);
      Object.assign(hull, originalHull);
    }
  }
  assert.equal(server.failure, null);
  const health = await fetch(`http://127.0.0.1:${server.port}/healthz`).then(r => r.json());
  await writeFile('artifacts/tactical-boss-browser-check.json', JSON.stringify({ results, arena, health,
    elapsedSeconds: (Date.now() - began) / 1000, isolatedData: true }, null, 2));
} catch (error) {
  await activePage?.screenshot({ path: 'artifacts/tactical-boss-browser-failure.png' }).catch(() => {});
  const ui = await activePage?.evaluate(() => ({ state: (window as any).__mmofps?.state,
    atlas: document.querySelector('#frontier-atlas')?.textContent,
    warning: document.querySelector('#boss-warning')?.textContent })).catch(() => undefined);
  await writeFile('artifacts/tactical-boss-browser-failure.json', JSON.stringify({ error: String(error),
    stack: error instanceof Error ? error.stack : undefined, ui, results, arena }, null, 2));
  throw error;
} finally {
  for (const timer of timers) clearInterval(timer);
  const cleanupErrors: unknown[] = [];
  for (const close of cleanup.reverse()) {
    try { await close(); } catch (error) { cleanupErrors.push(error); }
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Tactical fixture cleanup failed');
}
console.log(JSON.stringify({ results, stopped: true, elapsedSeconds: (Date.now() - began) / 1000 }, null, 2));
