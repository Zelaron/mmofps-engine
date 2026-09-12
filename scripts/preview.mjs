import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
const browser = await chromium.launch({ headless: true,
  args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const report = {};
await mkdir('artifacts', { recursive: true });
try {
  for (const mobile of [false, true]) {
    const context = await browser.newContext({ viewport: mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('http://127.0.0.1:8081');
    await page.waitForTimeout(25000);
    const key = mobile ? 'mobile' : 'desktop';
    await page.screenshot({ path: `artifacts/${key}-arrival.png` });
    report[key] = { errors, title: await page.title(), stats: await page.locator('#stats').innerText(), center: await page.locator('#center-wrap').innerText(), centerHidden: await page.locator('#center-wrap').evaluate(e => e.classList.contains('hide')), game: await page.evaluate(() => window.__mmofps.state), touch: mobile ? await page.locator('#touch-controls').getAttribute('class') : null, viewport: await page.evaluate(() => ({ width: innerWidth, client: document.documentElement.clientWidth, height: innerHeight })) };
    await page.locator('#atlas-open').click();
    await page.screenshot({ path: `artifacts/${key}-atlas.png` });
    await page.locator('button[data-faction="1"]').click();
    await page.waitForTimeout(1200);
    report[key].faction = await page.locator('button[data-faction="1"]').getAttribute('aria-pressed');
    await page.locator('#atlas-close').click();
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForTimeout(12000);
    report[key].restored = await page.locator('#frontier-status').innerText();
    await context.close();
  }
} finally { await browser.close(); }
await writeFile('artifacts/preview.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
