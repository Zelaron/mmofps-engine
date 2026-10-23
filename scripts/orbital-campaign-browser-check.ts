import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const bundle = await build({ bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022',
  stdin: { resolveDir: process.cwd(), loader: 'ts', contents: `
import { OrbitalUI } from './packages/client/src/orbital.ts';
const launches = [], ui = new OrbitalUI(destination => launches.push(destination), () => {}, () => {});
ui.setWorld({seed:1337,collectTransportPlan:()=>({pods:[{id:1,name:'Test transit',x:0,y:0,z:0}]})});
const frontier = {territories:[],you:{faction:1,salvage:180,discoveries:[],factionCooldown:0,campaignRewards:[1337]}};
ui.receiveFrontier(frontier); ui.update(0,0,0,0,true,1);
window.fixture = {ui,frontier,launches};
` } });
const status = { system: 'Helios', stars: ['Helios A', 'Helios B'], planets: ['meridian', 'cinder', 'nacre'].map((id, i) => ({
  id, available: true, players: i + 1, capacity: 64, ownership: [.1, .3, .4, .2],
  campaign: { botPopulation: [0, 64, 64, 64], threatenedBases: i === 1 ? 2 : 0, inboundSquads: i === 1 ? 1 : 0 },
})) };
const [frontierCss, orbitalCss] = await Promise.all(['frontier', 'orbital'].map(name => readFile(`packages/client/public/${name}.css`)));
const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/frontier.css"><link rel="stylesheet" href="/orbital.css"><style>body{margin:0;background:#101b25;--line:#a4b8b933;--paper:#e7eee6}</style><body><script src="/fixture.js"></script>';
const server = createServer(async (req, res) => {
  if (req.url === '/api/universe') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(status)); }
  else if (req.url === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(bundle.outputFiles[0].contents); }
  else if (req.url === '/frontier.css' || req.url === '/orbital.css') { res.setHeader('content-type', 'text/css'); res.end(req.url === '/frontier.css' ? frontierCss : orbitalCss); }
  else if (req.url?.startsWith('/fonts/') && /^\/fonts\/[a-z-]+\.ttf$/.test(req.url)) {
    try { res.end(await readFile(`packages/client/public${req.url}`)); } catch { res.writeHead(404).end(); }
  } else { res.setHeader('content-type', 'text/html'); res.end(html); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address(); assert.ok(address && typeof address !== 'string');
const browser = await chromium.launch({ headless: true });
const reports: unknown[] = [];
await mkdir('artifacts', { recursive: true });
try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ viewport }), page = await context.newPage(), errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(() => !!(window as any).fixture);
    await page.keyboard.press('KeyO');
    await page.locator('.orbit-campaign p').filter({ hasText: '2 bases are under attack' }).waitFor();
    assert.equal(await page.locator('.orbit-contract b').innerText(), '+150 SALVAGE');
    assert.match(await page.locator('.orbit-campaign p').innerText(), /192 soldiers deployed.*1 incoming squad/);
    assert.equal(await page.locator('[data-planet="1"] small').innerText(), '2 UNDER ATTACK');
    await page.locator('.orbit-launch').click();
    assert.deepEqual(await page.evaluate(() => (window as any).fixture.launches), [1]);
    await page.locator('.orbit-contract').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `artifacts/orbital-campaign-${viewport.width}.png` });
    await page.evaluate(() => { const f = (window as any).fixture; f.frontier.you.campaignRewards.push(7331); f.ui.receiveFrontier(f.frontier); });
    assert.equal(await page.locator('.orbit-contract b').innerText(), 'CONTRACT COMPLETE');
    await page.locator('[data-planet="2"]').click();
    assert.equal(await page.locator('.orbit-contract b').innerText(), '+150 SALVAGE');
    assert.match(await page.locator('.orbit-campaign p').innerText(), /No active distress calls/);
    assert.deepEqual(errors, []); reports.push({ viewport, contracts: true, dispatch: true, launch: true, errors });
    await context.close();
  }
  await writeFile('artifacts/orbital-campaign-report.json', JSON.stringify(reports, null, 2));
  console.log(JSON.stringify(reports));
} finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
