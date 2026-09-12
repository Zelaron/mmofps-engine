import { chromium } from '@playwright/test';
import { SourceMap } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { startupFixture } from './startup-fixture.mjs';

const args = process.argv.slice(2);
let label = 'startup-profile', mobile = false, cpu = true, serveClientDir, storageFile, timeoutMs = 60000;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--mobile') mobile = true;
  else if (args[i] === '--no-cpu') cpu = false;
  else if (args[i] === '--client-dir' && args[i + 1]) serveClientDir = path.resolve(args[++i]);
  else if (args[i] === '--storage-state' && args[i + 1]) storageFile = path.resolve(args[++i]);
  else if (args[i] === '--timeout-ms' && args[i + 1]) timeoutMs = Number(args[++i]);
  else if (args[i] === '--label' && args[i + 1]) label = args[++i];
  else throw new Error(`Unknown startup profile argument: ${args[i]}`);
}
assert.match(label, /^[a-z0-9][a-z0-9-]{0,63}$/);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 120000);
const base = new URL(process.env.GAME_URL ?? 'http://127.0.0.1:8081');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname), 'Startup fixture requires a local preview');
const clientDir = serveClientDir ?? process.env.STARTUP_CLIENT_DIR ?? 'packages/client/dist';
const app = await readFile(path.join(clientDir, 'app.js'));
const sourceMap = new SourceMap(JSON.parse(await readFile(path.join(clientDir, 'app.js.map'), 'utf8')));
await mkdir('artifacts', { recursive: true });
const fixture = serveClientDir ? await startupFixture(base, serveClientDir) : undefined;
const gameURL = fixture?.url ?? base;

// Capture only the new fixture tab. CPU samples cover its main thread;
// worker time, GPU time and physical-phone performance require other probes.
const errors = [], network = { documentAt: null, firstSocketFrameAt: null, receivedBytes: 0 };
let browser, cdp, page, profile, captured, elapsedMs, profiling = false;
try {
  browser = await chromium.launch({ headless: true, args: process.platform === 'win32'
    ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
  let storageState;
  if (storageFile) {
    try { storageState = JSON.parse(await readFile(storageFile, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    // The fixture's ephemeral port changes between runs; keep this isolated
    // test character's local preferences attached to the current app origin.
    if (fixture) for (const origin of storageState?.origins ?? []) {
      if (new URL(origin.origin).hostname === gameURL.hostname) origin.origin = gameURL.origin;
    }
  }
  const context = await browser.newContext({ ...(mobile
    ? { viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
    : { viewport: { width: 1440, height: 900 } }), storageState });
  await context.addInitScript(() => {
    const trace = window.__startupTrace = { initializedAt: null, renderedAt: null, localTerrainAt: null, frames: [], longTasks: [] };
    let presentationPending = false;
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) if (trace.longTasks.length < 512)
        trace.longTasks.push({ at: entry.startTime, duration: entry.duration });
    }).observe({ type: 'longtask', buffered: true });
    const frame = () => {
      if (trace.frames.length < 1200) trace.frames.push(performance.now());
      const state = window.__mmofps?.state;
      if (state?.initialized && trace.initializedAt === null) trace.initializedAt = performance.now();
      if (state?.streaming?.installed.lod0 > 0 && trace.localTerrainAt === null) trace.localTerrainAt = performance.now();
      if (!presentationPending && state?.initialized && (state.rendering.worldPresented ?? true)) {
        presentationPending = true;
        // Allow the game's own render callback to run after admission.
        requestAnimationFrame(() => requestAnimationFrame(() => { trace.renderedAt = performance.now(); }));
      }
      if (trace.renderedAt === null || trace.localTerrainAt === null) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  page = await context.newPage(); page.setDefaultTimeout(timeoutMs);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  cdp.on('Network.requestWillBeSent', event => {
    if (event.type === 'Document' && network.documentAt === null) network.documentAt = event.timestamp;
  });
  cdp.on('Network.webSocketFrameReceived', event => { network.firstSocketFrameAt ??= event.timestamp; });
  cdp.on('Network.loadingFinished', event => { network.receivedBytes += event.encodedDataLength; });
  if (cpu) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
    await cdp.send('Profiler.start'); profiling = true;
  }
  const began = performance.now();
  await page.goto(gameURL.href, { waitUntil: 'commit' });
  await page.waitForFunction(() => window.__startupTrace?.renderedAt !== null && window.__mmofps?.state.initialized);
  elapsedMs = performance.now() - began;
  if (profiling) { profile = (await cdp.send('Profiler.stop')).profile; profiling = false; }
  captured = await page.evaluate(() => ({ trace: window.__startupTrace, state: window.__mmofps.state,
    navigation: performance.getEntriesByType('navigation')[0]?.toJSON(),
    parallelShaderCompile: !!document.getElementById('c')?.getContext('webgl2')?.getExtension('KHR_parallel_shader_compile'),
    resources: performance.getEntriesByType('resource').map(r => ({ name: r.name, startTime: r.startTime,
      duration: r.duration, transferSize: r.transferSize, encodedBodySize: r.encodedBodySize })) }));
  await page.screenshot({ path: `artifacts/${label}-first.png` });
  await page.waitForTimeout(2000);
  await page.waitForFunction(() => window.__startupTrace?.localTerrainAt !== null);
  Object.assign(captured, await page.evaluate(() => ({ localTerrainAt: window.__startupTrace.localTerrainAt,
    settledState: window.__mmofps.state })));
  await page.screenshot({ path: `artifacts/${label}-settled.png` });
  if (storageFile) {
    await mkdir(path.dirname(storageFile), { recursive: true });
    await context.storageState({ path: storageFile });
  }
  assert.deepEqual(errors, []); assert.equal(captured.state.initialized, true);
} catch (error) {
  let diagnostic;
  try { diagnostic = await page?.evaluate(() => ({ trace: window.__startupTrace, state: window.__mmofps?.state,
    body: document.body?.innerText.slice(0, 1200) })); } catch {}
  await writeFile(`artifacts/${label}-failure.json`, JSON.stringify({ error: String(error), errors, network, diagnostic }, null, 2));
  try { await page?.screenshot({ path: `artifacts/${label}-failure.png`, timeout: 5000 }); } catch {}
  throw error;
} finally {
  if (profiling) { try { profile = (await cdp.send('Profiler.stop')).profile; } catch {} }
  await browser?.close();
  await fixture?.close();
  if (profile) await writeFile(`artifacts/${label}.cpuprofile`, JSON.stringify(profile));
}

const sampled = new Map();
for (let i = 0; i < (profile?.samples?.length ?? 0); i++) {
  const id = profile.samples[i]; sampled.set(id, (sampled.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 1000) / 1000);
}
const functions = new Map();
for (const node of profile?.nodes ?? []) {
  const f = node.callFrame;
  const mapped = f.url?.startsWith(gameURL.origin + '/app.js') ? sourceMap.findEntry(f.lineNumber, f.columnNumber) : undefined;
  const file = mapped?.originalSource ?? f.url, line = (mapped?.originalLine ?? f.lineNumber) + 1;
  const name = mapped?.name ?? f.functionName, key = `${file}:${line}:${name}`;
  const metric = functions.get(key) ?? { name, generatedName: f.functionName, file, line, selfMs: 0 };
  metric.selfMs += sampled.get(node.id) ?? 0; functions.set(key, metric);
}
const report = { at: new Date().toISOString(), device: mobile ? 'touch-emulation' : 'desktop', cpuProfile: cpu, servedClientDir: serveClientDir,
  persistentFixture: !!storageFile,
  scope: 'New local browser context, optional main-thread CPU profiling; two render callbacks after the initialized world is presented. Archived assets use a real loopback HTTP fixture with the same gateway. Screenshots occur after timing ends.',
  appHash: createHash('sha256').update(app).digest('hex'), elapsedMs, network: { ...network,
    firstSocketFrameMs: network.firstSocketFrameAt === null ? null : (network.firstSocketFrameAt - network.documentAt) * 1000 },
  ...captured, errors, functions: [...functions.values()].sort((a, b) => b.selfMs - a.selfMs).slice(0, 50) };
await writeFile(`artifacts/${label}.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ device: report.device, elapsedMs, initializedAt: captured.trace.initializedAt,
  renderedAt: captured.trace.renderedAt, firstSocketFrameMs: report.network.firstSocketFrameMs,
  longTasks: captured.trace.longTasks, functions: report.functions.slice(0, 12), errors }, null, 2));
