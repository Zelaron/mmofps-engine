import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { defaultClientDir, type RunningServer } from '../packages/server/src/server.js';
import { startWorldFixtures } from '../packages/server/test/world-fixture.js';
import { PLANETS } from '../packages/shared/src/universe.js';
import type { PlayerConn } from '../packages/server/src/conn.js';
import { ByteReader, decodeWelcome, Msg } from '../packages/shared/src/protocol.js';
import { PROTOCOL_VERSION } from '../packages/shared/src/constants.js';

const failEncounterInit = process.argv.includes('--fail-encounter-init');
const failSceneryInit = process.argv.includes('--fail-scenery-init');
const root = await mkdtemp(path.join(tmpdir(), 'the-mmofps-browser-planets-'));
const coordinator = new Coordinator(path.join(root, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
const control = await startControlPlane(coordinator, secret);
const worlds: RunningServer[] = [];
let gateway: Awaited<ReturnType<typeof startGateway>> | null = null;
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
await mkdir('artifacts', { recursive: true });
const results: unknown[] = [];
try {
  worlds.push(...await startWorldFixtures(PLANETS.map(planet => ({ port: 0, host: '127.0.0.1', seed: planet.seed, targetPopulation: 0, log: false, dataDir: path.join(root, planet.id),
    node: { url: `http://127.0.0.1:${control.port}`, secret, id: planet.id, planet: planet.id } }))));
  for (const world of worlds) assert.equal(world.failure, null);
  gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', clientDir: defaultClientDir(), secret });
  for (const mobile of [false, true]) {
    const context = await browser.newContext(mobile ? { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { viewport: { width: 1440, height: 900 } });
    await context.addInitScript(({ fail, failScenery }) => {
      const BaseWorker = Worker, sceneryWorkers: { seed?: number; terminated: boolean }[] = [];
      (window as any).__sceneryWorkers = sceneryWorkers;
      (window as any).Worker = class extends BaseWorker {
        private record?: { seed?: number; terminated: boolean };
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          if (String(url).endsWith('scenery.worker.js')) {
            this.record = { terminated: false }; sceneryWorkers.push(this.record);
          }
        }
        postMessage(message: any, options?: any) {
          if (this.record && message?.type === 'init') {
            this.record.seed = message.seed;
            if (failScenery) throw new Error('Fixture: scenery initialization unavailable');
          }
          super.postMessage(message, options);
        }
        terminate() { if (this.record) this.record.terminated = true; super.terminate(); }
      };
      const post = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function(message: any, options?: any) {
        if (message?.type === 'init' && Array.isArray(message.base)) {
          (window as any).__baseLayout = structuredClone(message);
          if (fail) throw new Error('Fixture: encounter initialization unavailable');
        }
        return post.call(this, message, options);
      };
    }, { fail: failEncounterInit, failScenery: failSceneryInit });
    const page = await context.newPage(), errors: string[] = [];
    const welcomePackets: { seed: number; pads: number; bytes: number; version: number }[] = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('websocket', socket => socket.on('framereceived', event => {
      if (typeof event.payload === 'string') return;
      try {
        const r = new ByteReader(event.payload); if (r.u8() !== Msg.SWelcome) return;
        const welcome = decodeWelcome(r), world = worlds.find(world => world.game.seed === welcome.seed);
        assert.ok(world); assert.equal(welcome.version, PROTOCOL_VERSION); assert.equal(r.remaining, 0);
        assert.deepEqual(welcome.teleporters, world.game.baseTeleporterPads);
        welcomePackets.push({ seed: welcome.seed, pads: welcome.teleporters.length, bytes: event.payload.length, version: welcome.version });
      } catch (error) { errors.push(`Welcome decode: ${(error as Error).message}`); }
    }));
    page.setDefaultTimeout(20_000);
    const state = () => page.evaluate(() => (window as any).__mmofps.state);
    const openChart = async () => { if (await page.evaluate(() => !!document.pointerLockElement)) await page.keyboard.press('KeyO'); else await page.locator('#system-open').click(); };
    await page.goto(`http://127.0.0.1:${gateway.port}`);
    await page.waitForFunction(() => (window as any).__mmofps?.state.initialized);
    await page.waitForTimeout(4000);
    await openChart();
    await page.waitForFunction(() => document.querySelector('.orbit-availability')?.textContent?.includes('OPEN'));
    assert.equal(await page.locator('.orbit-launch').isDisabled(), true, 'a distant explorer is directed to a physical port');
    await page.screenshot({ path: `artifacts/orbital-${mobile ? 'mobile' : 'desktop'}.png` });
    await page.locator('.orbit-guide').click();
    await page.waitForFunction(() => !document.querySelector<HTMLElement>('#orbital-beacon')?.hidden);
    assert.ok((await page.locator('#orbital-beacon').innerText()).includes(' m'));
    if (mobile) {
      assert.equal((await state()).touch.active, true, 'closing chart restores touch controls');
      await page.setViewportSize({ width: 393, height: 852 }); await openChart();
      await page.screenshot({ path: 'artifacts/orbital-portrait.png' });
      assert.equal(await page.evaluate(() => document.documentElement.clientWidth), 393);
      await page.locator('.orbit-close').click(); await page.setViewportSize({ width: 844, height: 390 });
    }
    const verifyLayout = async () => {
      await page.waitForFunction(failed => {
        const s = (window as any).__mmofps.state;
        return s.rendering.worldPresented && s.structures.count > 0 && s.rocks > 0 &&
          (failed ? s.scenery.failed : s.scenery.ready === 3 && s.scenery.pending === 0);
      }, failSceneryInit);
      const sceneryWorkers = await page.evaluate(() => (window as any).__sceneryWorkers);
      const active = sceneryWorkers.filter((worker: any) => !worker.terminated);
      assert.equal(active.length, failSceneryInit ? 0 : 1, 'old world scenery workers are released on travel and reconnect');
      assert.equal(sceneryWorkers.at(-1).seed, (await state()).seed);
      const installed = await page.evaluate(() => (window as any).__baseLayout);
      const world = worlds.find(world => world.game.seed === installed?.seed);
      assert.ok(world, 'the client installed the current planet layout');
      assert.deepEqual(installed.base, world.game.baseTeleporterPads, 'the exact admission coordinates reach the rendering worker');
      const stats = (await state()).teleporters;
      if (failEncounterInit) {
        assert.equal(stats.failed, true); assert.equal(stats.worker, false);
        assert.equal(stats.pads, installed.base.length, 'all base transport survives an unavailable encounter worker');
      }
      return { seed: installed.seed, basePads: installed.base.length, failed: stats.failed,
        scenery: (await state()).scenery, sceneryWorkers };
    };
    const initialLayout = await verifyLayout();
    const sourceId = (await state()).myId, source = worlds[0].game.players.get(sourceId)!;
    const pod = worlds[0].game.world.collectTransportPlan().pods[0];
    // A local test fixture positions this newly created character at the pod.
    // The public game has no test teleport endpoint or writable debug handle.
    Object.assign(source.state, { px: pod.x, py: pod.y + .12, pz: pod.z, vx: 0, vy: 0, vz: 0 });
    source.salvage = 137; source.faction = 1; source.ammo[1].magazine = 7; source.discoveries.add('1337:city-2');
    await page.waitForFunction(({ x, z }) => { const p = (window as any).__mmofps.state.pos; return Math.hypot(p.x - x, p.z - z) < 1; }, { x: pod.x, z: pod.z });
    await openChart();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.orbit-launch')?.disabled);
    assert.equal(await page.locator('#orbital-map h2').innerText(), 'Cinder');
    await page.locator('.orbit-launch').click();
    await page.waitForFunction(() => document.querySelector('.orbit-launch')?.textContent?.includes('HOLD POSITION'));
    await page.waitForURL(`http://127.0.0.1:${gateway.port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).__mmofps?.state.seed === 7331 && (window as any).__mmofps?.state.initialized, undefined, { timeout: 25_000 });
    await page.waitForTimeout(5000);
    const arrived = await state(), destination = worlds[1].game.players.get(arrived.myId)!;
    const arrivalLayout = await verifyLayout();
    assert.equal(worlds[0].game.players.has(sourceId), false);
    assert.equal(arrived.myId, sourceId, 'character ID survives travel');
    assert.equal(destination.ammo[1].magazine, 7); assert.ok(destination.salvage >= 137); assert.equal(destination.faction, 1);
    assert.ok(destination.discoveries.has('1337:city-2')); assert.deepEqual(errors, []);
    await page.screenshot({ path: `artifacts/cinder-arrival-${mobile ? 'mobile' : 'desktop'}.png` });
    await openChart(); await page.locator('button[data-planet="1"]').click();
    assert.equal(await page.locator('.orbit-launch').innerText(), 'YOU ARE ON THIS WORLD');
    (destination.sink as PlayerConn).disconnect(1013, 'World reconnect check');
    await page.waitForFunction(() => !(window as any).__mmofps.state.connected);
    await page.waitForFunction(() => { const s = (window as any).__mmofps.state; return s.connected && s.initialized; });
    const reconnected = await state();
    const reconnectLayout = await verifyLayout();
    assert.equal(reconnected.myId, sourceId);
    assert.notEqual(worlds[1].game.players.get(reconnected.myId), destination, 'a new connection restores the same durable character ID');
    assert.equal(worlds[1].game.players.get(reconnected.myId)!.ammo[1].magazine, 7);
    let baseReturnUsed: boolean | undefined;
    if (failEncounterInit) {
      await page.locator('.orbit-close').click();
      const game = worlds[1].game, player = game.players.get(reconnected.myId)!;
      const cave = game.baseTeleporterPads.find(pad => pad.cave)!;
      const surface = game.baseTeleporterPads[cave.partner];
      assert.equal(surface.cave, false);
      // Position only this fixture's actor on a canonical cave pad. The
      // production simulation and teleport event perform the actual return.
      Object.assign(player.state, { px: cave.x, py: cave.y + .1, pz: cave.z, vx: 0, vy: 0, vz: 0 });
      player.teleportArmed = true; player.teleportCdUntil = 0;
      await page.waitForFunction(({ x, z }) => {
        const s = (window as any).__mmofps.state;
        return Math.hypot(s.pos.x - x, s.pos.z - z) < 1 && s.teleporters.visible > 0;
      }, { x: surface.x, z: surface.z });
      baseReturnUsed = true;
      await page.screenshot({ path: `artifacts/bootstrap-return-${mobile ? 'touch' : 'desktop'}.png` });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(welcomePackets.map(packet => packet.seed), [1337, 7331, 7331]);
    results.push({ device: mobile ? 'mobile-emulation' : 'desktop', arrivalSeed: arrived.seed, orbitalLaunchFromUI: true,
      cargoAndFactionPreserved: true, sourceActorRemoved: true, stableCharacterId: true, automaticReconnect: true, portraitChecked: mobile,
      failEncounterInit, failSceneryInit, baseReturnUsed, welcomePackets, layouts: [initialLayout, arrivalLayout, reconnectLayout], rendering: arrived.rendering, errors });
    await context.close();
  }
} finally {
  await browser.close(); await gateway?.close(); for (const world of worlds) await world.close(); await control.close(); coordinator.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('the-mmofps-browser-planets-'));
  await rm(root, { recursive: true, force: true });
}
await writeFile(`artifacts/${failSceneryInit ? 'planetary-scenery-worker-failure' : failEncounterInit ? 'planetary-bootstrap-worker-failure' : 'planetary-browser-check'}.json`, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));
