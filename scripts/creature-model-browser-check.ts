import { chromium } from '@playwright/test';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import path from 'node:path';

// A small isolated WebGL scene exercises the actual reusable game models,
// mobile pool, boss labels and warning rings without changing a live world.
// `?sheet=1` additionally exposes a deterministic review harness: contact
// sheets, gait filmstrips (server-like 10 Hz steps, 30 Hz snapshots, 60 fps
// rendering), alert/wind-up poses, death collapses and per-species budgets.
const entry = `
import * as THREE from 'three';
import { WildlifeModels } from './packages/client/src/render/wildlife.ts';
import { CREATURE_DEFS } from './packages/shared/src/wildlife.ts';
const params = new URLSearchParams(location.search);
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(innerWidth, innerHeight); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const models = new WildlifeModels(); scene.add(models.group);
if (!params.has('sheet')) {
  renderer.setClearColor(0xadbcb7);
  const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, .1, 400);
  camera.position.set(32, 22, 60); camera.lookAt(0, 3, 0);
  scene.add(new THREE.HemisphereLight(0xe3f3f0, 0x384c30, 2.2));
  const sun = new THREE.DirectionalLight(0xffe7be, 2.6); sun.position.set(-30, 50, 20); scene.add(sun);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(250, 250), new THREE.MeshLambertMaterial({ color: 0x627356 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.02; scene.add(ground);
  const species = Number(params.get('species') ?? 9);
  const roster = params.has('lineup') ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 12] : [species, 6, 7, 8];
  const states = roster.map((species, i) => ({ id: i + 1, species, x: params.has('lineup') ? (i - 5) * 3.2 : i ? -11 + i * 4 : 0,
    y: 0, z: params.has('lineup') ? 0 : i ? 12 : 0, yaw: .2, speed: 0, alert: true, health: .64, windingUp: i === 0 && !params.has('lineup') }));
  if (params.has('lineup')) { camera.position.set(14, 12, 32); camera.lookAt(0, 1, 0); }
  models.sync(states); models.update(.1);
  renderer.render(scene, camera);
  window.fixture = { count: models.count, expected: roster.length, species: states.map(s => CREATURE_DEFS[s.species].name),
    sprites: models.group.children.filter(o => o.isSprite).length, drawCalls: renderer.info.render.calls };
  window.renderAgain = () => { models.update(.1); renderer.render(scene, camera); };
} else {
  // Game lighting: ACES, hemisphere + warm key light (packages/client/src/render/scene.ts).
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.2;
  renderer.setClearColor(0xa7b9c0);
  scene.add(new THREE.HemisphereLight(0xc5ddeb, 0x514939, 1.05));
  const sun = new THREE.DirectionalLight(0xffe5bf, 1.65); sun.position.set(.55, .75, .3); scene.add(sun);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = '#7d8b67'; g.fillRect(0, 0, 64, 64); g.fillStyle = '#717f5c'; g.fillRect(0, 0, 32, 32); g.fillRect(32, 32, 32, 32);
  const checker = new THREE.CanvasTexture(canvas); checker.wrapS = checker.wrapT = THREE.RepeatWrapping;
  checker.repeat.set(2000, 2000); checker.colorSpace = THREE.SRGBColorSpace; checker.magFilter = THREE.NearestFilter;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ map: checker }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -.005; scene.add(ground);
  const camera = new THREE.PerspectiveCamera(30, 1, .05, 3000);
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;pointer-events:none;font:12px sans-serif;color:#10181c';
  document.body.appendChild(overlay);
  const WANDER = s => s === 3 ? 1.35 : s === 5 ? .45 : .85;
  let tick = 1000, nextId = 1;
  const tracks = () => models.tracks;
  const displayed = state => { const t = tracks()?.get(state.id); return t ? { x: t.x, y: t.y, z: t.z } : state; };
  // Visual framing size per species: tall bosses and long arthropods.
  const frame = s => { const d = CREATURE_DEFS[s]; return Math.max(d.height * 1.35, d.radius * 3.6, 1.6); };
  function place(state, view, zoom, cell) {
    const d = CREATURE_DEFS[state.species], p = displayed(state), size = frame(state.species) * (zoom ?? 1);
    const distance = size / 2 / Math.tan(camera.fov * Math.PI / 360) * Math.max(1, cell.h / cell.w * 1.1);
    const fx = -Math.sin(state.yaw), fz = -Math.cos(state.yaw), rx = Math.cos(state.yaw), rz = -Math.sin(state.yaw);
    const cy = d.height * .48;
    let ox = rx, oz = rz, oy = .12;
    if (view === 'quarter') { ox = rx * .72 + fx * .72; oz = rz * .72 + fz * .72; oy = .32; }
    else if (view === 'front') { ox = fx; oz = fz; oy = .18; }
    else if (view === 'rear') { ox = -fx * .7 + rx * .5; oz = -fz * .7 + rz * .5; oy = .3; }
    else if (view === 'top') { ox = rx * .35; oz = rz * .35; oy = 1.6; }
    const n = Math.hypot(ox, oy, oz);
    camera.position.set(p.x + ox / n * distance, p.y + cy + oy / n * distance, p.z + oz / n * distance);
    camera.lookAt(p.x, p.y + cy, p.z);
  }
  function label(text, x, y) {
    const div = document.createElement('div'); div.textContent = text;
    div.style.cssText = 'position:absolute;left:' + (x + 4) + 'px;top:' + (y + 3) + 'px;background:#ffffffb0;padding:1px 4px;border-radius:3px';
    overlay.appendChild(div);
  }
  function simulate(states, seconds) {
    const frames = Math.round(seconds * 60);
    for (let f = 0; f < frames; f++) {
      tick++;
      if (tick % 6 === 0) for (const s of states) {
        if (s.dieAt !== undefined && s.time >= s.dieAt && !s.dead) { s.dead = true; s.speed = 0; s.alert = false; s.windingUp = false; s.health = 0; }
        if (s.dead || !s.move) continue;
        const step = s.move * .1;
        s.x += -Math.sin(s.yaw) * step; s.z += -Math.cos(s.yaw) * step;
        if (s.turn) s.yaw += s.turn * .1;
        s.speed = s.move;
      }
      for (const s of states) s.time += 1 / 60;
      if (tick % 2 === 0) models.sync(states.map(s => ({ id: s.id, species: s.species, x: s.x, y: s.y, z: s.z, yaw: s.yaw,
        speed: s.speed, alert: s.alert, dead: s.dead || undefined, health: s.health, windingUp: s.windingUp || undefined })), tick);
      models.update(1 / 60, tick);
    }
  }
  function makeStates(entries) {
    return entries.map((e, i) => {
      const d = CREATURE_DEFS[e.species];
      const move = e.gait === 'walk' ? WANDER(e.species) : e.gait === 'run' ? (e.runSpeed ?? d.speed) : 0;
      return { id: nextId++, species: e.species, x: (e.lane ?? i) * 70 + (e.dx ?? 0), y: e.y ?? 0, z: (e.lane ?? i) * 260 + (e.dz ?? 0), yaw: e.yaw ?? 0,
        speed: 0, move, turn: e.turn ?? 0, alert: !!e.alert, windingUp: !!e.windingUp, health: e.health ?? 1,
        dieAt: e.dieAt, dead: false, time: 0 };
    });
  }
  window.runScene = cfg => {
    overlay.textContent = '';
    models.sync([], tick); models.update(1 / 60, tick);
    const states = makeStates(cfg.entries);
    models.sync(states.map(s => ({ ...s })), tick); models.update(1 / 60, tick);
    simulate(states, cfg.warmup ?? 1);
    const W = innerWidth, H = innerHeight;
    renderer.setScissorTest(true);
    if (cfg.layout === 'film') {
      const samples = cfg.samples ?? 8, rows = states.length, cw = W / samples, ch = H / rows;
      for (let k = 0; k < samples; k++) {
        if (k) simulate(states, cfg.interval ?? .1);
        for (let r = 0; r < rows; r++) {
          const s = states[r], cell = { w: cw, h: ch };
          camera.aspect = cw / ch; camera.updateProjectionMatrix();
          // Film cameras stay fixed to each lane's start so planted feet and
          // body travel read against the checker floor.
          place(cfg.follow === false ? { ...s, x: cfg.entries[r].fixX ?? s.x, z: s.z } : s, cfg.view ?? 'side', cfg.zoom, cell);
          const x = k * cw, y = H - (r + 1) * ch;
          renderer.setViewport(x, y, cw, ch); renderer.setScissor(x, y, cw, ch); renderer.render(scene, camera);
          if (k === 0) label(CREATURE_DEFS[s.species].name + ' ' + (cfg.title ?? ''), x, r * ch);
          else if (r === 0 && cfg.timeLabels) label('+' + ((cfg.interval ?? .1) * k).toFixed(2) + 's', x, 0);
        }
      }
    } else {
      const cols = cfg.cols ?? 4, rows = Math.ceil(states.length / cols), cw = W / cols, ch = H / rows;
      for (let i = 0; i < states.length; i++) {
        const s = states[i], c = i % cols, r = Math.floor(i / cols), cell = { w: cw, h: ch };
        camera.aspect = cw / ch; camera.updateProjectionMatrix();
        place(s, cfg.entries[i].view ?? cfg.view ?? 'quarter', cfg.entries[i].zoom ?? cfg.zoom, cell);
        const x = c * cw, y = H - (r + 1) * ch;
        renderer.setViewport(x, y, cw, ch); renderer.setScissor(x, y, cw, ch); renderer.render(scene, camera);
        label(CREATURE_DEFS[s.species].name + (cfg.entries[i].note ? ' · ' + cfg.entries[i].note : ''), x, r * ch);
      }
    }
    renderer.setScissorTest(false); renderer.setViewport(0, 0, W, H);
    return { count: models.count };
  };
  // A first-person game camera (92 degree FOV) at eye height reviewing groups.
  window.runGameView = cfg => {
    overlay.textContent = '';
    models.sync([], tick); models.update(1 / 60, tick);
    const states = makeStates(cfg.entries);
    simulate(states, cfg.warmup ?? 1.5);
    const gameCamera = new THREE.PerspectiveCamera(cfg.fov ?? 92, innerWidth / innerHeight, .08, 3000);
    gameCamera.position.set(...cfg.eye); gameCamera.lookAt(...cfg.look);
    renderer.setViewport(0, 0, innerWidth, innerHeight); renderer.render(scene, gameCamera);
    label(cfg.title ?? '', 0, 0);
    return { count: models.count };
  };
  // Model-only budget per species: renderer-counted draws/triangles for one
  // standing creature, minus the floor, plus the static geometry of its parts.
  window.measure = () => {
    const out = [];
    renderer.setScissorTest(false); renderer.setViewport(0, 0, innerWidth, innerHeight);
    const measureCamera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, .05, 3000);
    for (let s = 0; s < CREATURE_DEFS.length; s++) {
      models.sync([], tick); models.update(1 / 60, tick);
      const state = { id: nextId++, species: s, x: 0, y: 0, z: 0, yaw: 0, speed: 0, alert: false, health: 1 };
      models.sync([state], tick); models.update(1 / 60, tick);
      const size = frame(s) * 1.6;
      measureCamera.position.set(size * 1.2, size * .6, size * 1.2); measureCamera.lookAt(0, CREATURE_DEFS[s].height * .4, 0);
      ground.visible = false;
      renderer.render(scene, measureCamera);
      const sprites = models.group.children.filter(o => o.isSprite && o.visible).length;
      let meshes = 0, triangles = 0;
      models.group.traverse(o => {
        if (!o.isMesh || !o.visible || o.isSprite) return;
        const count = o.isInstancedMesh ? o.count : 1; if (!count) return;
        const g = o.geometry, tris = (g.index ? g.index.count : g.getAttribute('position').count) / 3;
        meshes++; triangles += tris * count;
      });
      out.push({ species: s, name: CREATURE_DEFS[s].name, drawCalls: renderer.info.render.calls - sprites,
        renderedTriangles: renderer.info.render.triangles - sprites * 2, meshesWithInstances: meshes, instancedTriangles: triangles });
      ground.visible = true;
    }
    models.sync([], tick); models.update(1 / 60, tick);
    return out;
  };
  window.fixture = { ready: true };
}
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
const out = process.env.CREATURE_ARTIFACTS ?? 'artifacts';
const only = process.env.CREATURE_ONLY?.split(',');
const want = (name: string) => !only || only.some(prefix => name.startsWith(prefix));
await mkdir(out, { recursive: true });

type Entry = Record<string, unknown> & { species: number };
const ALL = Array.from({ length: 14 }, (_, species) => species);
const MERIDIAN = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const WINDUP = new Set([8, 9, 11, 13]);
const sheets: { name: string; width: number; height: number; scene?: Record<string, unknown>; game?: Record<string, unknown> }[] = [
  { name: 'sheet-quarter-idle', width: 1600, height: 1200, scene: { layout: 'grid', cols: 4, view: 'quarter', warmup: 1.2,
    entries: ALL.map(species => ({ species })) } },
  { name: 'sheet-side-idle', width: 1600, height: 1200, scene: { layout: 'grid', cols: 4, view: 'side', warmup: 1.2,
    entries: ALL.map(species => ({ species })) } },
  { name: 'sheet-front-idle', width: 1600, height: 1200, scene: { layout: 'grid', cols: 4, view: 'front', warmup: 1.2,
    entries: ALL.map(species => ({ species })) } },
  { name: 'sheet-alert-windup', width: 1600, height: 1200, scene: { layout: 'grid', cols: 4, view: 'quarter', warmup: .45,
    entries: ALL.map(species => ({ species, alert: true, windingUp: WINDUP.has(species), note: WINDUP.has(species) ? 'winding up' : 'alert' })) } },
  { name: 'sheet-dead', width: 1600, height: 1200, scene: { layout: 'grid', cols: 4, view: 'quarter', warmup: 2.2,
    entries: ALL.map(species => ({ species, dieAt: .5, note: 'dead 1.7s' })) } },
  { name: 'sheet-run-quarter', width: 1600, height: 1200, scene: { layout: 'grid', cols: 4, view: 'quarter', warmup: 1.37,
    entries: ALL.map(species => ({ species, gait: 'run', alert: true })) } },
  { name: 'film-walk-a', width: 1760, height: 1500, scene: { layout: 'film', samples: 8, interval: .12, warmup: 1.5, view: 'side', title: 'walk',
    timeLabels: true, entries: [0, 1, 2, 3, 4].map(species => ({ species, gait: 'walk' })) } },
  { name: 'film-walk-b', width: 1760, height: 1500, scene: { layout: 'film', samples: 8, interval: .12, warmup: 1.5, view: 'side', title: 'walk',
    timeLabels: true, entries: [5, 6, 7, 8, 9].map(species => ({ species, gait: 'walk' })) } },
  { name: 'film-run-a', width: 1760, height: 1500, scene: { layout: 'film', samples: 8, interval: .05, warmup: 1.5, view: 'side', title: 'run',
    timeLabels: true, entries: [0, 1, 2, 3, 4].map(species => ({ species, gait: 'run' })) } },
  { name: 'film-run-b', width: 1760, height: 1500, scene: { layout: 'film', samples: 8, interval: .06, warmup: 1.5, view: 'side', title: 'run',
    timeLabels: true, entries: [5, 6, 7, 8, 9].map(species => ({ species, gait: 'run', alert: true })) } },
  { name: 'film-other-worlds', width: 1760, height: 1300, scene: { layout: 'film', samples: 8, interval: .07, warmup: 1.5, view: 'side', title: 'run',
    timeLabels: true, entries: [10, 11, 12, 13].map(species => ({ species, gait: 'run', alert: true })) } },
  { name: 'film-death-a', width: 1760, height: 1500, scene: { layout: 'film', samples: 8, interval: .1, warmup: .6, view: 'quarter', title: 'death',
    timeLabels: true, entries: [0, 1, 2, 3, 4].map(species => ({ species, dieAt: .5 })) } },
  { name: 'film-death-b', width: 1760, height: 1500, scene: { layout: 'film', samples: 8, interval: .1, warmup: .6, view: 'quarter', title: 'death',
    timeLabels: true, entries: [5, 6, 7, 8, 9].map(species => ({ species, dieAt: .5, gait: species === 7 ? 'run' : undefined })) } },
  { name: 'film-windup', width: 1760, height: 1300, scene: { layout: 'film', samples: 8, interval: .2, warmup: .1, view: 'side', title: 'wind-up',
    timeLabels: true, entries: [8, 9, 11, 13].map(species => ({ species, alert: true, windingUp: true })) } },
  { name: 'film-idle', width: 1760, height: 1500, scene: { layout: 'film', samples: 8, interval: .6, warmup: .5, view: 'quarter', title: 'idle',
    timeLabels: true, entries: [0, 1, 3, 4, 6].map(species => ({ species })) } },
  ...MERIDIAN.map(species => ({ name: 'closeup-' + species, width: 1200, height: 800, scene: { layout: 'grid', cols: 2, warmup: 1.3,
    entries: [{ species, view: 'quarter', zoom: .8, note: 'idle' }, { species, view: 'side', zoom: .8, gait: 'run', note: 'run', lane: 1, alert: true },
      { species, view: 'front', zoom: .8, alert: true, windingUp: WINDUP.has(species), lane: 2, note: 'alert' },
      { species, view: 'rear', zoom: .8, gait: 'walk', lane: 3, note: 'walk' }] } })),
  { name: 'game-wildlife', width: 1440, height: 900, game: { eye: [0, 1.7, 0], look: [0, 1, -14], warmup: 2.4, title: 'game camera: wildlife herd',
    entries: [{ species: 0, lane: 0, dx: -3, dz: -9, yaw: .4 }, { species: 0, lane: 0, dx: -6, dz: -13, yaw: 1.2, gait: 'walk' },
      { species: 3, lane: 0, dx: 3, dz: -11, yaw: -.6, gait: 'walk' }, { species: 4, lane: 0, dx: 7, dz: -16, yaw: 2.2 },
      { species: 1, lane: 0, dx: -1, dz: -20, yaw: -.3, gait: 'run', alert: true }, { species: 5, lane: 0, dx: 1.6, dz: -6, yaw: 2.6 },
      { species: 2, lane: 0, dx: -2.5, dz: -5.5, yaw: .9, alert: true }] } },
  { name: 'game-undead', width: 1440, height: 900, game: { eye: [0, 1.7, 0], look: [0, 2.5, -20], warmup: 2.4, title: 'game camera: undead push',
    entries: [{ species: 6, lane: 0, dx: -2, dz: -17, yaw: Math.PI, gait: 'run', alert: true }, { species: 6, lane: 0, dx: 1.5, dz: -14, yaw: Math.PI - .1, gait: 'walk' },
      { species: 6, lane: 0, dx: 4, dz: -10, yaw: Math.PI + .5, alert: true }, { species: 7, lane: 0, dx: -5, dz: -30, yaw: Math.PI + .1, gait: 'run', alert: true },
      { species: 8, lane: 0, dx: 6, dz: -27, yaw: Math.PI - .3, gait: 'run', alert: true }, { species: 9, lane: 0, dx: -12, dz: -60, yaw: Math.PI - .5, gait: 'walk' }] } },
];
try {
  for (const mobile of [false, true]) for (const view of ['lineup=1', 'species=9', 'species=11', 'species=13']) {
    if (!want('original')) continue;
    const errors: string[] = [], context = await browser.newContext({ viewport: mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 },
      hasTouch: mobile, isMobile: mobile });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('http://127.0.0.1:' + port + '/?' + view + (mobile ? '&touch=1' : ''));
    await page.waitForFunction(() => (window as any).fixture);
    await page.evaluate(() => (window as any).renderAgain());
    const state = await page.evaluate(() => (window as any).fixture);
    assert.equal(state.count, state.expected); assert.equal(state.sprites, view.startsWith('species') ? 1 : 0); assert.deepEqual(errors, []);
    await page.screenshot({ path: out + '/creature-' + (mobile ? 'mobile-' : 'desktop-') + view.replace('=', '-') + '.png' });
    results.push({ mobile, view, ...state, errors }); await context.close();
  }
  for (const sheet of sheets) {
    if (!want(sheet.name)) continue;
    const errors: string[] = [], context = await browser.newContext({ viewport: { width: sheet.width, height: sheet.height } });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('http://127.0.0.1:' + port + '/?sheet=1');
    await page.waitForFunction(() => (window as any).fixture?.ready);
    const state = sheet.scene ? await page.evaluate(cfg => (window as any).runScene(cfg), sheet.scene)
      : await page.evaluate(cfg => (window as any).runGameView(cfg), sheet.game);
    const entries = (sheet.scene ?? sheet.game)!.entries as Entry[];
    assert.equal(state.count, entries.length); assert.deepEqual(errors, []);
    await page.screenshot({ path: out + '/creature-' + sheet.name + '.png' });
    results.push({ sheet: sheet.name, ...state, errors }); await context.close();
  }
  if (want('budget')) {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 } }), page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + port + '/?sheet=1');
    await page.waitForFunction(() => (window as any).fixture?.ready);
    const budget = await page.evaluate(() => (window as any).measure());
    assert.deepEqual(errors, []);
    console.table(budget); results.push({ budget }); await context.close();
  }
} finally {
  await browser.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
await writeFile(out + '/creature-model-browser-check.json', JSON.stringify({ results, serverStopped: true }, null, 2));
console.log(JSON.stringify(results.filter(r => !(r as { budget?: unknown }).budget).map(r => ({ ...(r as object), errors: undefined })), null, 0));
