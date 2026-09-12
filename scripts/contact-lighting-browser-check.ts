import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';

const bundle = await build({ entryPoints: ['scripts/fixtures/contact-lighting.ts'], bundle: true,
  write: false, format: 'iife', tsconfig: 'tsconfig.json' });
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/fixture.js' ? bundle.outputFiles[0].contents : '<!doctype html><style>body{margin:0;background:#101820}</style><script defer src="/fixture.js"></script>');
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address() as { port: number };
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
await mkdir('artifacts', { recursive: true });
const results: unknown[] = [];
const errors: string[] = [];
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.waitForFunction(() => (window as any).contactFixture);
  assert.equal(await page.evaluate(() => (window as any).contactFixture.supported), true, 'GPU supports the HDR path');
  for (const touch of [false, true]) {
    if (touch) {
      await page.setViewportSize({ width: 393, height: 853 });
      await page.evaluate(() => (window as any).contactFixture.resize(393, 853, true));
    }
    const comparison = await page.evaluate(() => (window as any).contactFixture.compare());
    results.push({ touch, ...comparison });
    assert.ok(comparison.darkened > 150, 'actual contact pixels darken');
    assert.equal(comparison.brightened, 0, 'contact pass cannot brighten a surface');
    assert.ok(comparison.flatChange < .1, 'flat ground without nearby geometry must not self-shadow or stripe');
    assert.ok(comparison.redPixels > 100, 'stencil opening survives the depth resolve');
    assert.deepEqual(comparison.errors, [0, 0]);
    for (const mode of ['hdr', 'contact', 'direct'] as const) {
      const result = await page.evaluate(mode => (window as any).contactFixture.draw(mode), mode);
      assert.equal(result.error, 0); assert.ok(result.redPixels > 100);
      await page.screenshot({ path: `artifacts/contact-${touch ? 'touch' : 'desktop'}-${mode}.png` });
    }
  }
  assert.deepEqual(errors, []);
  await writeFile('artifacts/contact-lighting-browser-check.json', JSON.stringify({ results, errors }, null, 2));
  console.log(JSON.stringify({ results, errors }, null, 2));
} catch (error) { console.error(JSON.stringify({ errors, results }, null, 2)); throw error; }
finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
