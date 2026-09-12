import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { ByteReader, decodeWelcome, decodeSnapshot, Msg } from '../packages/shared/src/protocol.js';
import { PROTOCOL_VERSION } from '../packages/shared/src/constants.js';
import { DYNAMIC_ENTITY_BASE, MAX_CHARACTER_ID, isEntityId } from '../packages/shared/src/entity-id.js';

// Exercises the built browser against a running coordinated universe, including
// actual WebSocket frames and the models produced by the browser decoder.
const browser = await chromium.launch({ headless: true,
  args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const results: unknown[] = [];
await mkdir('artifacts', { recursive: true });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    const page = await context.newPage(), errors: string[] = [], ids = new Set<number>();
    let snapshots = 0, version = 0, characterId = 0, wireVehicles = 0, basePads = 0, welcomeBytes = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('websocket', socket => socket.on('framereceived', event => {
      try {
        if (typeof event.payload === 'string') return;
        const r = new ByteReader(event.payload), kind = r.u8();
        if (kind === Msg.SWelcome) {
          const welcome = decodeWelcome(r); version = welcome.version; characterId = welcome.yourId;
          basePads = welcome.teleporters.length; welcomeBytes = event.payload.length;
          assert.equal(r.remaining, 0);
        }
        if (kind !== Msg.SSnapshot) return;
        const snapshot = decodeSnapshot(r); snapshots++; assert.equal(r.remaining, 0);
        const references = [...snapshot.ents, ...snapshot.vehicles ?? [], ...snapshot.pickups ?? [], ...snapshot.creatures ?? []].map(e => e.id);
        for (const id of references) {
          assert.ok(isEntityId(id));
          if (id >= DYNAMIC_ENTITY_BASE && ids.size < 1000) ids.add(id);
        }
        wireVehicles = Math.max(wireVehicles, snapshot.vehicles?.length ?? 0);
      } catch (error) { errors.push(`Wire decode: ${(error as Error).message}`); }
    }));
    const began = performance.now();
    await page.goto(process.env.GAME_URL ?? 'http://127.0.0.1:8081');
    await page.waitForFunction(() => (window as any).__mmofps?.state.initialized, undefined, { timeout: 30_000 });
    const entryMs = performance.now() - began;
    await page.waitForFunction(() => (window as any).__mmofps.state.vehiclesVisible > 0, undefined, { timeout: 20_000 });
    const state = await page.evaluate(() => {
      const s = (window as any).__mmofps.state;
      return { initialized: s.initialized, vehiclesVisible: s.vehiclesVisible, players: s.players, touch: s.touch };
    });
    assert.equal(version, PROTOCOL_VERSION); assert.ok(characterId > 0 && characterId <= MAX_CHARACTER_ID);
    assert.ok(basePads > 0 && basePads <= 255); assert.ok(welcomeBytes < 1100);
    assert.ok(snapshots > 0 && wireVehicles > 0 && state.vehiclesVisible > 0);
    assert.ok(ids.size > 0, 'This check requires a coordinated worker with reserved dynamic IDs');
    assert.deepEqual(errors, []);
    results.push({ device: mobile ? 'touch-emulated' : 'desktop', entryMs, version, characterId, snapshots, basePads, welcomeBytes,
      dynamicIds: ids.size, minDynamicId: Math.min(...ids), maxDynamicId: Math.max(...ids), wireVehicles, state, errors });
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile('artifacts/entity-browser-check.json', JSON.stringify(results, null, 2));
}
console.log(JSON.stringify(results, null, 2));
