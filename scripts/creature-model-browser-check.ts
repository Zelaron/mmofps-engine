import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

// A small isolated WebGL scene exercises the actual reusable game models,
// mobile pool, boss labels and warning rings without changing a live world.
const entry = `
import * as THREE from 'three';
import { WildlifeModels } from './packages/client/src/render/wildlife.ts';
import { CREATURE_DEFS } from './packages/shared/src/wildlife.ts';
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setClearColor(0xadbcb7); document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, .1, 400);
camera.position.set(32, 22, 60); camera.lookAt(0, 3, 0);
scene.add(new THREE.HemisphereLight(0xe3f3f0, 0x384c30, 2.2));
const sun = new THREE.DirectionalLight(0xffe7be, 2.6); sun.position.set(-30, 50, 20); scene.add(sun);
const ground = new THREE.Mesh(new THREE.PlaneGeometry(250, 250), new THREE.MeshLambertMaterial({ color: 0x627356 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = -.02; scene.add(ground);
const models = new WildlifeModels(); scene.add(models.group);
const params = new URLSearchParams(location.search), species = Number(params.get('species') ?? 9);
const roster = params.has('lineup') ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12] : [species, 6, 7, 8];
const states = roster.map((species, i) => ({ id: i + 1, species, x: params.has('lineup') ? (i - 5) * 3.2 : i ? -11 + i * 4 : 0,
  y: 0, z: params.has('lineup') ? 0 : i ? 12 : 0, yaw: .2, speed: 0, alert: true, health: .64, windingUp: i === 0 && !params.has('lineup') }));
if (params.has('lineup')) { camera.position.set(14, 12, 32); camera.lookAt(0, 1, 0); }
models.sync(states); models.update(.1);
renderer.render(scene, camera);
window.fixture = { count: models.count, expected: roster.length, species: states.map(s => CREATURE_DEFS[s.species].name),
  sprites: models.group.children.filter(o => o.isSprite).length, drawCalls: renderer.info.render.calls };
window.renderAgain = () => { models.update(.1); renderer.render(scene, camera); };
`;
const bundle = await build({ stdin: { contents: entry, resolveDir: path.resolve('.'), loader: 'ts' }, bundle: true, write: false, format: 'esm' });
const javascript = bundle.outputFiles[0].text;
const server = createServer((request, response) => {
  if (request.url?.startsWith('/bundle.js')) { response.setHeader('content-type', 'text/javascript'); response.end(javascript); }
  else if (request.url === '/favicon.ico') { response.statusCode = 204; response.end(); }
  else { response.setHeader('content-type', 'text/html'); response.end('<!doctype html><html><body style="margin:0;overflow:hidden"><script type="module" src="/bundle.js"></script></body></html>'); }
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const browser = await chromium.launch({ headless: true, args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
const results: unknown[] = [];
await mkdir('artifacts', { recursive: true });
try {
  for (const mobile of [false, true]) for (const view of ['lineup=1', 'species=9', 'species=11', 'species=13']) {
    const errors: string[] = [], context = await browser.newContext({ viewport: mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 },
      hasTouch: mobile, isMobile: mobile });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('http://127.0.0.1:' + port + '/?' + view + (mobile ? '&touch=1' : ''));
    await page.waitForFunction(() => (window as any).fixture);
    await page.evaluate(() => (window as any).renderAgain());
    const state = await page.evaluate(() => (window as any).fixture);
    assert.equal(state.count, state.expected); assert.equal(state.sprites, view.startsWith('species') ? 1 : 0); assert.deepEqual(errors, []);
    await page.screenshot({ path: 'artifacts/creature-' + (mobile ? 'mobile-' : 'desktop-') + view.replace('=', '-') + '.png' });
    results.push({ mobile, view, ...state, errors }); await context.close();
  }
} finally {
  await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
await writeFile('artifacts/creature-model-browser-check.json', JSON.stringify({ results, serverStopped: true }, null, 2));
console.log(JSON.stringify({ results, serverStopped: true }, null, 2));
