import { build } from 'esbuild';
import { chromium, firefox } from '@playwright/test';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const bundle = await build({ entryPoints: ['scripts/fixtures/shader-preparation.ts'], bundle: true,
  write: false, format: 'iife', tsconfig: 'tsconfig.json' });
const server = createServer((req, res) => {
  const script = req.url === '/fixture.js';
  res.setHeader('Content-Type', script ? 'text/javascript' : 'text/html');
  res.end(script ? bundle.outputFiles[0].contents : '<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;background:#101820}canvas{display:block;width:100vw;height:100vh}</style><script defer src="/fixture.js"></script>');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
await mkdir('artifacts', { recursive: true });
const results: unknown[] = [];
const useFirefox = process.argv.includes('--firefox');
const artifactPrefix = useFirefox ? 'shader-firefox' : 'shader';
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = useFirefox ? await firefox.launch({ headless: false }) :
    await chromium.launch({ headless: true, args: process.platform === 'win32'
      ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
  for (const mode of (useFirefox ? ['high', 'low'] : ['high', 'low', 'no-parallel']) as ('high' | 'low' | 'no-parallel')[]) {
    const context = await browser.newContext({ viewport: { width: 960, height: 640 } });
    if (mode === 'no-parallel') await context.addInitScript(() => {
      const get = WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension = function(name: string) {
        return name === 'KHR_parallel_shader_compile' ? null : get.call(this, name);
      };
    });
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?quality=${mode === 'low' ? 'low' : 'high'}`);
    await page.waitForFunction(() => (window as any).shaderFixture?.state.worldPresented);
    const capture = () => page.evaluate(() => (window as any).shaderFixture.capture());
    const initial = await capture();
    assert.equal(initial.shadersPending, false); assert.equal(initial.error, 0);
    assert.equal(initial.shaderQueueFallbacks, 0, 'the GPU command queue settles without its failure fallback');
    assert.ok(initial.lit > initial.width * initial.height * .8, 'a complete illuminated scene is drawn');
    assert.ok(initial.copper > 300, 'the metallic ordinary and instanced objects are visible');
    assert.equal(initial.contactShadowPasses, mode === 'low' ? 0 : 2);
    const parallel = await page.evaluate(() => (window as any).shaderFixture.parallel);
    if (!useFirefox || mode === 'no-parallel') assert.equal(parallel, mode !== 'no-parallel');
    const invalidated = await page.evaluate(() => (window as any).shaderFixture.reseed());
    assert.equal(invalidated.worldPresented, false); assert.equal(invalidated.shadersPending, true);
    const reseeded = await capture(); assert.equal(reseeded.checksum, initial.checksum);
    await page.evaluate(() => (window as any).shaderFixture.setPlayable(false));
    await page.waitForFunction(() => !(window as any).shaderFixture.state.worldPresented);
    const waiting = await page.evaluate(() => (window as any).shaderFixture.state);
    assert.equal(waiting.calls, 0, 'waiting for a snapshot does not draw the placeholder world');
    assert.equal(waiting.shadersPending, true, 'joining must prepare the current world again');
    await page.evaluate(() => (window as any).shaderFixture.setPlayable(true));
    const rejoined = await capture(); assert.equal(rejoined.checksum, initial.checksum);
    await page.screenshot({ path: `artifacts/${artifactPrefix}-${mode}-before-loss.png` });
    await page.evaluate(() => (window as any).shaderFixture.lose());
    await page.waitForFunction(() => (window as any).shaderFixture.state.lost === 1);
    const lost = await page.evaluate(() => (window as any).shaderFixture.state);
    // Context-loss errors are consumed by WebGL itself; none may remain once restored.
    await page.evaluate(() => (window as any).shaderFixture.restore());
    await page.waitForFunction(() => (window as any).shaderFixture.state.restored === 1);
    const restored = await capture();
    await page.screenshot({ path: `artifacts/${artifactPrefix}-${mode}-restored.png` });
    results.push({ mode, parallel, initial, lost, restored, errors });
    assert.equal(lost.worldPresented, false, 'a lost context cannot report a visible world');
    assert.equal(restored.error, 0); assert.equal(restored.shadersPending, false);
    assert.equal(restored.shaderQueueFallbacks, 0);
    assert.equal(restored.checksum, initial.checksum, 'restored framebuffer retains the lighting and geometry');
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  await writeFile(`artifacts/${useFirefox ? 'shader-preparation-firefox' : 'shader-preparation-browser'}-check.json`, JSON.stringify(results, null, 2));
  await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve()));
}
console.log(JSON.stringify(results, null, 2));
