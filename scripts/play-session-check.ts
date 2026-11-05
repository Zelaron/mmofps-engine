import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Coordinator } from '../packages/server/src/coordinator.js';
import { startControlPlane } from '../packages/server/src/control-plane.js';
import { startGateway } from '../packages/server/src/gateway.js';
import { startServer, defaultClientDir } from '../packages/server/src/server.js';
import { inCaptureRange } from '../packages/shared/src/frontier.js';

// A scripted human plays a real session in a real browser: it joins through
// the URL like a player, then only uses the game's own controls (pointer-lock
// mouse look, WASD, jump, fire). Each tenth of a second it either walks to
// its current order or engages the nearest enemy soldier it can see. Like a
// player reading the HUD's "G → DEPLOY NOW" hint, it redeploys from the
// tactical map when its order is out of walking range and it is out of combat. The
// report covers the questions a playtest asks: how fast you reach a fight,
// how often you fight, whether the front moves, and how smooth it runs.
// Requires `npm run build`. PLAY_MINUTES (default 10), BOTS (default 80),
// PLAY_WARMUP_SECONDS (default 150: the war runs before the player joins),
// PLAY_ROTATE_AFTER (seconds; starts the next war then, to measure how soon a
// player redeployed into a new war meets the enemy).
const minutes = Number(process.env.PLAY_MINUTES ?? 10), bots = Number(process.env.BOTS ?? 80);
const root = await mkdtemp(path.join(tmpdir(), 'mmofps-play-session-'));
const coordinator = new Coordinator(path.join(root, 'universe.sqlite')), secret = randomBytes(32).toString('hex');
coordinator.enablePlanets(['meridian']);
const control = await startControlPlane(coordinator, secret);
const server = await startServer({ port: 0, host: '127.0.0.1', targetPopulation: bots, dataDir: path.join(root, 'meridian'), log: false,
  node: { planet: 'meridian', id: 'play-session', secret, url: `http://127.0.0.1:${control.port}` } });
const gateway = await startGateway(coordinator, { port: 0, host: '127.0.0.1', secret, clientDir: defaultClientDir() });
// A live server is mid-war when a player arrives: let the bots fight first.
const warmupSeconds = Number(process.env.PLAY_WARMUP_SECONDS ?? 150);
await new Promise(resolve => setTimeout(resolve, warmupSeconds * 1000));
const browser = await chromium.launch({ headless: !process.argv.includes('--headed'),
  args: process.platform === 'win32' ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
await mkdir('artifacts', { recursive: true });

interface Enemy { id: number; x: number; y: number; z: number; vehicle: boolean; d: number }
interface View {
  alive: boolean; health: number; vehicle: number;
  cam: { x: number; y: number; z: number; yaw: number; pitch: number };
  order: { x: number; z: number; name?: string } | null; enemies: Enemy[];
}
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const report: Record<string, unknown> = { minutes, bots, warmupSeconds };
try {
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript(`window.__frames = []; (function () { let last = performance.now();
    function f(now) { window.__frames.push(now - last); last = now; requestAnimationFrame(f); } requestAnimationFrame(f); })();`);
  const started = Date.now();
  await page.goto(`http://127.0.0.1:${gateway.port}`);
  await page.waitForFunction(`!!window.__mmofps?.state.initialized && !!window.__mmofps.state.rendering.worldPresented`, null, { timeout: 120_000 });
  report.joinMs = Date.now() - started;
  const id = await page.evaluate(`window.__mmofps.state.myId`) as number;
  const player = server.game.players.get(id)!;
  assert.ok(player && !player.isBot);
  const frontier = server.game.frontier!;
  const owners = () => Object.fromEntries(frontier.bases.map(b => [b.name, b.owner]));
  const startOwners = owners();
  // Where the automatic first deployment put the player.
  const where = () => {
    const s = player.state, order = frontier.order(player);
    const battles = frontier.battleReports(server.game.tick);
    const enemies = [...server.game.players.values()].filter(q => q.state.alive && q.faction && q.faction !== player.faction);
    // The order's control: whether standing there can capture anything.
    const site = order ? frontier.territories.find(t => t.id === order.targetId) : undefined;
    const control = site ? { id: site.id, owner: site.owner, faction: player.faction, progress: +(site.captureProgress ?? 0).toFixed(2),
      contested: !!site.contested, inRing: inCaptureRange(site, s.px, s.py, s.pz, true), dy: Math.round(s.py - site.y) } : null;
    return { alive: s.alive, order: order?.name ?? null, control,
      orderMetres: order ? Math.round(Math.hypot(order.x - s.px, order.z - s.pz)) : null,
      nearestBattleMetres: battles.length ? Math.round(Math.min(...battles.map(b => Math.hypot(b.x - s.px, b.z - s.pz)))) : null,
      nearestEnemyMetres: enemies.length ? Math.round(Math.min(...enemies.map(q => Math.hypot(q.state.px - s.px, q.state.pz - s.pz)))) : null };
  };
  report.spawn = where();
  await page.locator('#c').click({ position: { x: 800, y: 450 } });
  await page.waitForTimeout(400);
  await page.evaluate(`window.__frames.length = 0`);

  // Calibrate mouse-look sensitivity through the real input path.
  const yawOf = async () => (await page.evaluate(`window.__mmofps.state.camera.yaw`)) as number;
  const look = (dx: number, dy: number) => page.evaluate(`document.dispatchEvent(new MouseEvent('mousemove', { movementX: ${dx}, movementY: ${dy}, bubbles: true }))`);
  const before = await yawOf(); await look(100, 0); await page.waitForTimeout(60);
  const sensitivity = Math.abs(wrap(await yawOf() - before)) / 100 || 0.0022;

  const held = new Set<string>();
  const hold = async (keys: string[]) => {
    for (const key of [...held]) if (!keys.includes(key)) { await page.keyboard.up(key); held.delete(key); }
    for (const key of keys) if (!held.has(key)) { await page.keyboard.down(key); held.add(key); }
  };
  let firing = false;
  const fire = async (on: boolean) => {
    if (on === firing) return;
    if (on) await page.mouse.down(); else await page.mouse.up();
    firing = on;
  };

  const t0 = Date.now(), end = t0 + minutes * 60_000;
  const timeline: unknown[] = [];
  let lastSecond = -1, lastPos: { x: number; z: number } | null = null, stuckSince = 0, strafeAt = 0, strafe = 'KeyA';
  let walked = 0, combatTicks = 0, aliveTicks = 0, quietSince = t0, longestQuiet = 0, enemySeenAt: number | null = null;
  // A quiet stretch ends at a sighting, a death or the end of the session.
  let wasAlive = false;
  let baseFlips = 0, lastOwners = owners(), controlFlips = 0;
  const controlOwners = () => frontier.territories.map(t => t.owner).join(',');
  let lastControls = controlOwners();
  let firstDamageAt: number | null = null, firstKillAt: number | null = null, lastHealthBlock = player.regenBlockUntil;
  let lastDeployAt = 0, deploys = 0, cliffTurns = 0;
  // Like a player who can see a drop: never walk off a cliff or a deck edge.
  const cliffAhead = (yaw: number) => {
    const s = player.state, x = s.px - Math.sin(yaw) * 3.5, z = s.pz - Math.cos(yaw) * 3.5;
    return !server.game.world.trace(x, s.py + 1.5, z, 0, -1, 0, 9, false).hit;
  };
  const walk = async (keys: string[], yaw: number) => {
    if (keys.includes('KeyW') && cliffAhead(yaw)) { cliffTurns++; keys = ['KeyS']; await look(Math.round(1.05 / sensitivity), 0); }
    await hold(keys);
  };
  const kills0 = player.frags, deaths0 = player.deaths, xp0 = player.xp, captures0 = player.captures;
  // Every death: who or what dealt the last damage (environmental damage is
  // self-inflicted with weapon 255, so the calling subsystem is recorded).
  const hits: { t: number; amount: number; by: string; weapon: number; via: string }[] = [];
  const deathLog: { t: number; x: number; z: number; y: number; ground: number; last: typeof hits }[] = [];
  const internals = server.game as unknown as { damage(p: unknown, amount: number, attacker: { id: number; name: string; isBot: boolean }, weapon: number, ...rest: unknown[]): unknown;
    kill(p: unknown, attacker: unknown, weapon: number): unknown };
  const damage = internals.damage.bind(server.game), killFn = internals.kill.bind(server.game);
  internals.damage = (p, amount, attacker, weapon, ...rest) => {
    if (p === player) {
      const via = (new Error().stack ?? '').split(String.fromCharCode(10)).slice(2, 4).map(l => l.trim().replace(/^at /, '').split(' ')[0]).join(' < ');
      hits.push({ t: +((Date.now() - t0) / 1000).toFixed(1), amount: Math.round(amount), by: attacker.id === player.id ? 'self' : `${attacker.isBot ? 'bot' : 'human'} ${attacker.name}`, weapon, via });
      if (hits.length > 40) hits.shift();
    }
    return damage(p, amount, attacker, weapon, ...rest);
  };
  internals.kill = (p, attacker, weapon) => {
    if (p === player) deathLog.push({ t: +((Date.now() - t0) / 1000).toFixed(1), x: Math.round(player.state.px), z: Math.round(player.state.pz),
      y: Math.round(player.state.py), ground: Math.round(server.game.world.groundY(player.state.px, player.state.pz)), last: hits.slice(-3) });
    return killFn(p, attacker, weapon);
  };
  const rotateAfter = Number(process.env.PLAY_ROTATE_AFTER ?? NaN) * 1000;
  let rotatedAt: number | null = null;
  const rotation: { redeployedS?: number; spawn?: ReturnType<typeof where>; firstEnemyS?: number; firstDamageS?: number } = {};
  while (Date.now() < end) {
    const now = Date.now();
    if (rotatedAt === null && now - t0 >= rotateAfter) {
      rotatedAt = now;
      frontier.startWar(frontier.war.number + 1, server.game.tick);
    }
    const v = await page.evaluate(`(() => { const m = window.__mmofps, s = m.state;
      return { alive: s.alive, health: s.health, vehicle: s.myVehicle ?? 0, cam: s.camera,
        order: s.order ? { x: s.order.x, z: s.order.z, name: s.order.name } : null, enemies: m.enemies(160) }; })()`) as View;
    if (rotatedAt !== null && v.alive && rotation.redeployedS === undefined && now - rotatedAt > 1000) {
      rotation.redeployedS = +((now - rotatedAt) / 1000).toFixed(1); rotation.spawn = where();
    }
    if (rotation.redeployedS !== undefined && v.alive) {
      if (v.enemies.length) rotation.firstEnemyS ??= +((now - rotatedAt!) / 1000).toFixed(1);
      if (player.regenBlockUntil !== lastHealthBlock) rotation.firstDamageS ??= +((now - rotatedAt!) / 1000).toFixed(1);
    }
    if (!v.alive) {
      if (wasAlive) longestQuiet = Math.max(longestQuiet, now - quietSince);
      wasAlive = false;
      await hold([]); await fire(false); lastPos = null; quietSince = now;
      await page.waitForTimeout(250); continue;
    }
    aliveTicks++; wasAlive = true;
    if (v.vehicle) { await hold(['KeyE']); await page.waitForTimeout(150); await hold([]); continue; }
    if (lastPos) walked += Math.hypot(v.cam.x - lastPos.x, v.cam.z - lastPos.z);
    const moved = lastPos ? Math.hypot(v.cam.x - lastPos.x, v.cam.z - lastPos.z) : 1;
    lastPos = { x: v.cam.x, z: v.cam.z };
    const target = v.enemies.find(e => !e.vehicle && e.d < 120);
    if (v.enemies.length) { enemySeenAt ??= now - t0; longestQuiet = Math.max(longestQuiet, now - quietSince); quietSince = now; }
    let aimX: number, aimY: number, aimZ: number;
    if (target) {
      combatTicks++;
      aimX = target.x; aimY = target.y + 1.25; aimZ = target.z;
    } else if (v.order) {
      aimX = v.order.x; aimY = v.cam.y; aimZ = v.order.z;
    } else { aimX = v.cam.x + 10; aimY = v.cam.y; aimZ = v.cam.z; }
    const dx = aimX - v.cam.x, dz = aimZ - v.cam.z, dy = aimY - v.cam.y;
    const yawError = wrap(Math.atan2(-dx, -dz) - v.cam.yaw), pitchError = Math.atan2(dy, Math.hypot(dx, dz)) - v.cam.pitch;
    // A human-like flick: most of the error per tick, capped.
    const turn = Math.max(-.45, Math.min(.45, yawError * .75)), tilt = Math.max(-.3, Math.min(.3, pitchError * .75));
    await look(Math.round(-turn / sensitivity), Math.round(-tilt / sensitivity));
    if (target) {
      if (now > strafeAt) { strafe = strafe === 'KeyA' ? 'KeyD' : 'KeyA'; strafeAt = now + 700 + Math.random() * 900; }
      await walk(target.d > 45 ? ['KeyW', strafe] : [strafe], v.cam.yaw);
      await fire(Math.abs(yawError) < .07 && Math.abs(pitchError) < .09);
    } else {
      await fire(false);
      const distance = v.order ? Math.hypot(v.order.x - v.cam.x, v.order.z - v.cam.z) : Infinity;
      if (v.order && distance > 1200 && now - quietSince > 3000 && now - lastDeployAt > 20_000 && player.regenBlockUntil <= server.game.tick) {
        lastDeployAt = now;
        await hold([]);
        await page.keyboard.press('KeyG');
        const deploy = page.locator('.respawn-choices button.deploy-now:not([disabled])');
        if (await deploy.count()) { await deploy.first().click(); deploys++; } else await page.keyboard.press('KeyG');
        await page.waitForTimeout(400);
        await page.locator('#c').click({ position: { x: 800, y: 450 } });
        lastPos = null;
        continue;
      }
      if (moved < .05) { if (!stuckSince) stuckSince = now; } else stuckSince = 0;
      const stuck = stuckSince && now - stuckSince > 1500;
      await walk(distance > 12 ? (stuck ? ['KeyW', 'Space', strafe] : ['KeyW']) : [strafe], v.cam.yaw);
      if (stuck && now - stuckSince > 3000) { strafe = strafe === 'KeyA' ? 'KeyD' : 'KeyA'; stuckSince = now; }
    }
    const block = player.regenBlockUntil;
    if (block !== lastHealthBlock) { firstDamageAt ??= now - t0; lastHealthBlock = block; }
    if (player.frags > kills0) firstKillAt ??= now - t0;
    const ownersNow = owners();
    for (const name of Object.keys(ownersNow)) if (ownersNow[name] !== lastOwners[name]) baseFlips++;
    lastOwners = ownersNow;
    const controlsNow = controlOwners();
    if (controlsNow !== lastControls) { const a = controlsNow.split(','), b = lastControls.split(','); controlFlips += a.filter((o, i) => o !== b[i]).length; lastControls = controlsNow; }
    const second = Math.floor((now - t0) / 1000);
    if (second !== lastSecond && second % 30 === 0) {
      lastSecond = second;
      timeline.push({ s: second, kills: player.frags - kills0, deaths: player.deaths - deaths0, xp: player.xp - xp0,
        captures: player.captures - captures0, enemiesInSight: v.enemies.length, ...where() });
      if (second % 120 === 0) await page.screenshot({ path: `artifacts/play-session-${String(second).padStart(3, '0')}.png` });
    }
    await page.waitForTimeout(80);
  }
  await hold([]); await fire(false);
  if (wasAlive) longestQuiet = Math.max(longestQuiet, Date.now() - quietSince);
  const frames = (await page.evaluate(`window.__frames.slice()`) as number[]).sort((a, b) => a - b);
  const q = (p: number) => +frames[Math.min(frames.length - 1, Math.floor(frames.length * p))].toFixed(1);
  const longFrames = (await page.evaluate(`window.__mmofps.longFrames()`) as { ms: number; sections: Record<string, number> }[])
    .sort((a, b) => b.ms - a.ms).slice(0, 8);
  const endOwners = owners();
  const elapsedMinutes = (Date.now() - t0) / 60_000;
  Object.assign(report, {
    sensitivity: +sensitivity.toFixed(5),
    kills: player.frags - kills0, deaths: player.deaths - deaths0, xpEarned: player.xp - xp0,
    captures: player.captures - captures0, rank: player.xp,
    killsPerMinute: +((player.frags - kills0) / elapsedMinutes).toFixed(2),
    secondsToFirstEnemyInSight: enemySeenAt === null ? null : +(enemySeenAt / 1000).toFixed(1),
    secondsToFirstDamageTaken: firstDamageAt === null ? null : +(firstDamageAt / 1000).toFixed(1),
    secondsToFirstKill: firstKillAt === null ? null : +(firstKillAt / 1000).toFixed(1),
    combatShare: +(combatTicks / Math.max(1, aliveTicks)).toFixed(2), deploysUsed: deploys, cliffTurns,
    longestQuietSecondsAlive: +(longestQuiet / 1000).toFixed(1),
    metresOnFoot: Math.round(walked),
    baseOwnersStart: startOwners, baseOwnersEnd: endOwners,
    basesChangedHands: Object.keys(startOwners).filter(name => startOwners[name] !== endOwners[name]).length,
    baseFlipsDuringSession: baseFlips, controlFlipsDuringSession: controlFlips,
    ...(rotatedAt !== null ? { warRotation: rotation } : {}),
    war: { number: frontier.war.number },
    frames: { count: frames.length, p50: q(.5), p95: q(.95), p99: q(.99), max: q(1), over50: frames.filter(d => d > 50).length, over100: frames.filter(d => d > 100).length },
    longFrames, timeline, deaths: deathLog, errors: errors.slice(0, 10),
  });
  assert.deepEqual(errors, [], 'no page errors during play');
  assert.equal(server.failure, null);
  await context.close();
} finally {
  await browser.close(); await gateway.close(); await server.close(); await control.close(); coordinator.close();
  assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith('mmofps-play-session-'));
  await rm(root, { recursive: true, force: true });
}
await writeFile('artifacts/play-session-check.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
