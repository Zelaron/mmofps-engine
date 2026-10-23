import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium, firefox } from '@playwright/test';

/** A branch of terrain-browser-check: native renderer/streamers with an
 * explicitly controlled ground camera, no world server and no save access. */
export async function checkFastGroundTerrain() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const browserName = process.argv.find(arg => arg.startsWith('--browser='))?.slice(10) ?? 'firefox';
  assert.ok(browserName === 'firefox' || browserName === 'chromium');
  const label = process.argv.find(arg => arg.startsWith('--label='))?.slice(8) ?? `terrain-vesper-drive-${browserName}`;
  const route = process.argv.find(arg => arg.startsWith('--route='))?.slice(8) ?? 'curved';
  assert.ok(route === 'curved' || route === 'abrupt' || route === 'respawn' || route === 'respawn-warm');
  const warmRespawn = route === 'respawn-warm';
  const coldRespawn = route === 'respawn' || warmRespawn;
  const headless = !process.argv.includes('--headed');
  assert.match(label, /^[a-z0-9-]{1,70}$/);
  const width = 3840, height = 2160, assets = path.join(root, 'packages/client/dist');
  const bundleDir = path.join(root, 'artifacts', `${label}-client`);
  await mkdir(path.dirname(bundleDir), { recursive: true });
  await mkdir(bundleDir); // Unique labels preserve earlier compiled evidence.
  const entryPoints = { 'fixture.js': 'scripts/fixtures/terrain-drive.ts',
    'mesher.worker.js': 'packages/client/src/render/mesher.worker.ts',
    'scenery.worker.js': 'packages/client/src/render/scenery.worker.ts' };
  const bundles = new Map<string, Uint8Array>(), sourceHashes: Record<string, string> = {};
  for (const [name, entry] of Object.entries(entryPoints)) {
    const result = await build({ entryPoints: [path.join(root, entry)], bundle: true, format: 'iife',
      target: 'es2020', minify: false, write: false, metafile: true, tsconfig: path.join(root, 'tsconfig.json'), logLevel: 'warning' });
    bundles.set('/' + name, result.outputFiles[0].contents);
    await writeFile(path.join(bundleDir, name), result.outputFiles[0].contents);
    for (const input of Object.keys(result.metafile.inputs)) {
      if (input.startsWith('node_modules/')) continue;
      sourceHashes[input] = createHash('sha256').update(await readFile(path.resolve(root, input))).digest('hex');
    }
  }
  // Private in-memory bundles do not overwrite dev/production dist or its
  // compression files. Static assets alone are read from the existing build.
  const server = createServer(async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      if (pathname === '/') {
        res.setHeader('Content-Type', 'text/html');
        res.end('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000}canvas{width:100%;height:100%;display:block}</style></head><body><canvas></canvas><script src="fixture.js"></script></body></html>'); return;
      }
      if (bundles.has(pathname)) { res.setHeader('Content-Type', 'text/javascript'); res.end(bundles.get(pathname)); return; }
      if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      const target = path.resolve(assets, '.' + decodeURIComponent(pathname));
      if (!target.startsWith(assets + path.sep)) { res.writeHead(403); res.end(); return; }
      res.end(await readFile(target));
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await mkdir(path.join(root, 'artifacts'), { recursive: true });
  const browser = await (browserName === 'firefox' ? firefox : chromium).launch({ headless,
    ...(browserName === 'chromium' && process.platform === 'win32'
      ? { args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } : {}) });
  const errors: string[] = [], workerEvents: unknown[] = [], screenshots: string[] = [];
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await context.newPage(); page.setDefaultTimeout(45_000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await context.addInitScript(() => {
    const NativeWorker = Worker, records: unknown[] = [];
    (window as any).__terrainWorkerEvents = records;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        const name = String(url);
        records.push({ at: performance.now(), type: 'created', name });
        this.addEventListener('message', ({ data }) => records.push({ at: performance.now(), name,
          type: data.type, reqId: data.reqId ?? data.id, cx: data.cx, cz: data.cz, step: data.step,
          preview: data.preview, caveDetail: data.caveDetail, workMs: data.workMs, elapsedMs: data.elapsedMs, maxSliceMs: data.maxSliceMs, paced: data.paced }));
      }
      override postMessage(message: any, transfer?: Transferable[]) {
        records.push({ at: performance.now(), type: 'sent', messageType: message.type,
          reqId: message.reqId ?? message.id, cx: message.cx, cz: message.cz, step: message.step,
          urgent: message.urgentCoverage, preview: message.preview, caveDetail: message.caveDetail });
        super.postMessage(message, transfer ?? []);
      }
    };
  });
  let result: any, failure: unknown, initial: unknown, preloadAudit: unknown, initialAudit: unknown, loadedAudit: unknown;
  const capture = async (name: string) => {
    const file = `artifacts/${label}-${name}.png`; await page.screenshot({ path: path.join(root, file) }); screenshots.push(file);
  };
  try {
    await page.goto(`http://127.0.0.1:${address.port}/?route=${route}`);
    await page.waitForFunction(() => !!(window as any).__terrainDrive, null, { timeout: 45_000 });
    initial = await page.evaluate(() => (window as any).__terrainDrive.state());
    await capture('initial');
    if (warmRespawn) {
      await page.waitForFunction(() => {
        const s = (window as any).__terrainDrive.state();
        return s.failures.length || s.rendering.worldPresented && !s.rendering.shadersPending &&
          s.streaming.groundNeighborhood?.covered && s.rocks > 0 && s.scenery.pending === 0;
      }, null, { timeout: 60_000 });
      preloadAudit = await page.evaluate(() => (window as any).__terrainDrive.auditPreload());
      await capture('old-location-loaded');
      // Keep every renderer, World, worker and owed-rest deadline. The next
      // frame jumps to the cold target and starts walking without a target wait.
      await page.evaluate(() => (window as any).__terrainDrive.begin());
    } else if (!coldRespawn) {
      await page.waitForFunction(() => {
        const s = (window as any).__terrainDrive.state();
        return s.failures.length || (s.rendering.worldPresented && s.streaming.currentGroundCovered &&
          s.streaming.aheadGroundCovered && s.rocks > 0 && s.scenery.pending === 0);
      }, null, { timeout: 60_000 });
      initialAudit = await page.evaluate(() => (window as any).__terrainDrive.audit());
      await capture('loaded-start');
      await page.evaluate(() => (window as any).__terrainDrive.begin());
    }
    await page.waitForFunction(() => {
      const s = (window as any).__terrainDrive.state(); return s.phase === 'finished' || s.failures.length;
    }, null, { timeout: 45_000 });
    await capture('route-end');
    if (coldRespawn) initialAudit = await page.evaluate(() => (window as any).__terrainDrive.audit());
    await page.evaluate(() => (window as any).__terrainDrive.review());
    await page.waitForFunction(({ cold, warm }: { cold: boolean; warm: boolean }) => {
      const s = (window as any).__terrainDrive.state();
      return s.failures.length || s.reviewReady && s.streaming.currentGroundCovered && s.streaming.aheadGroundCovered &&
        (!cold || s.streaming.groundNeighborhood?.covered && s.scenery.pending === 0) &&
        (!warm || s.seams.currentFineCovered);
    }, { cold: coldRespawn, warm: warmRespawn }, { timeout: 45_000 });
    loadedAudit = await page.evaluate(() => (window as any).__terrainDrive.audit());
    await capture('loaded-review');
    result = await page.evaluate(() => (window as any).__terrainDrive.result());
    if (result.firstMissing?.png) {
      const file = `artifacts/${label}-first-missing.png`;
      await writeFile(path.join(root, file), Buffer.from(result.firstMissing.png.split(',')[1], 'base64'));
      screenshots.push(file); delete result.firstMissing.png;
    }
    assert.deepEqual(errors, []); assert.deepEqual(result.failures, []);
    assert.equal(result.rockMismatch, 0, 'installed rock instance Y equals its canonical source Y');
    assert.ok(result.rockChecks > 0, 'the scenery height check exercised actual rocks');
    assert.ok(result.nonlinear.error > .01, 'route exercises a nonlinear preview/terrain height difference');
    if (warmRespawn) {
      assert.equal(result.preload.state.streaming.groundNeighborhood.covered, true);
      assert.deepEqual(result.transition.targetSelected, [], 'no cold-target tile was preloaded or requested');
      assert.deepEqual(result.retainedWorkers, { terrain: true, scenery: true }, 'respawn keeps its warmed workers');
      assert.ok(result.preload.samples.length > 0 && result.samples.length > 0, 'old and new location samples remain separate');
      assert.ok(result.seams.edges > 0 && result.seams.currentFineCovered,
        'the settled image must exercise the actual fine/middle transition, not stop before fine terrain arrives');
      assert.equal(result.seams.deferred, 0, 'native surrounding contours must not be rejected');
    }
    if (coldRespawn) assert.equal(result.streaming.groundNeighborhood.covered, true,
      'all nine surrounding canonical tiles finish after the cold walk; transient gaps remain measured');
    else assert.equal(result.missingFrames, 0, 'canonical terrain stays beneath the 81 m/s camera after warmup');
  } catch (error) {
    failure = String(error); await capture('failure').catch(() => {});
  } finally {
    result ??= await page.evaluate(() => (window as any).__terrainDrive?.result()).catch(() => null);
    if (result?.firstMissing?.png) {
      const file = `artifacts/${label}-first-missing.png`;
      await writeFile(path.join(root, file), Buffer.from(result.firstMissing.png.split(',')[1], 'base64'));
      screenshots.push(file); delete result.firstMissing.png;
    }
    if (result?.firstExposed?.png) {
      const file = `artifacts/${label}-first-exposed.png`;
      await writeFile(path.join(root, file), Buffer.from(result.firstExposed.png.split(',')[1], 'base64'));
      screenshots.push(file); delete result.firstExposed.png;
    }
    workerEvents.push(...await page.evaluate(() => (window as any).__terrainWorkerEvents ?? []).catch(() => []));
    await page.evaluate(() => (window as any).__terrainDrive?.dispose()).catch(() => {});
    await context.close(); await browser.close();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await writeFile(path.join(root, 'artifacts', `${label}.json`), JSON.stringify({ browserName, headless,
      sourceHashes, initial, preloadAudit, initialAudit, loadedAudit, result, errors, failure, screenshots, workerEvents, servicesStopped: true }, null, 2));
  }
  assert.equal(failure, undefined, String(failure));
  console.log(`${label}: native ${coldRespawn ? 'cold respawn walk and surrounding coverage' : 'fast-ground terrain'} and prop heights passed`);
}
