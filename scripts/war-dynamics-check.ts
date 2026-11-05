import { writeFileSync, mkdirSync } from 'node:fs';
import { Bot, botName } from '../packages/server/src/bots.js';
import { Game } from '../packages/server/src/game.js';
import { VEHICLE, BTN, NET } from '../packages/shared/src/index.js';

// Headless war-dynamics probe. It runs the real campaign (terrain, movement,
// bots, vehicles, capture) without a server and reports whether the war moves:
// ownership changes, how concentrated the fighting is, how quickly fresh
// soldiers reach a fight and whether respawns stall. Compare runs before and
// after a campaign change with the same seed, population and duration.
const arg = (name: string, fallback: string) => process.argv.find(a => a.startsWith(`--${name}=`))?.split('=')[1] ?? fallback;
const seconds = Number(arg('seconds', '300')), seed = Number(arg('seed', '1337'));
const population = Number(arg('population', '192')), windowSeconds = Number(arg('window', '30'));
const output = arg('output', 'war-dynamics');
// --observer=x,z places a stationary, invulnerable stand-in human there (or
// --observer=hot to follow the hottest battle every 30 s) so nearby bots
// run their full-detail paths, as they do around a real player.
const observerArg = arg('observer', '');
if (!/^[a-z0-9-]+$/i.test(output) || !(seconds >= 10 && seconds <= 3600) || !(population >= 3 && population <= 384)) throw new Error('Invalid arguments');

const started = performance.now();
// The observer stand-in relies on playtest hyperspeed's invulnerability.
const game = new Game(seed, { vehicles: true, teleporters: true, wildlife: true, frontier: true, hyperspeed: !!observerArg });
const frontier = game.frontier!;
const bots = Array.from({ length: population }, (_, i) => new Bot(game.addPlayer(botName(i), null, true), seed));
const observer = observerArg ? game.addPlayer('Observer', null, false) : null;
let observerSeq = 0;
const placeObserver = (x: number, z: number) => {
  if (!observer) return;
  const y = game.world.groundY(x, z) + .1;
  Object.assign(observer.state, { px: x, py: y, pz: z, vx: 0, vy: 0, vz: 0, alive: true });
  observer.health = 100;
};
const moveObserverToFight = () => {
  if (!observer) return;
  if (observerArg !== 'hot') { const [x, z] = observerArg.split(',').map(Number); placeObserver(x, z); return; }
  const hottest = frontier.battleReports(game.tick)[0];
  if (hottest) placeObserver(hottest.x, hottest.z);
};
moveObserverToFight();
const spawnKinds = new Map<string, number>();
const internals = game as unknown as { pickSpawn(id: number): { x: number; y: number; z: number } | null };
const originalPick = internals.pickSpawn.bind(game);
internals.pickSpawn = (id: number) => {
  const player = game.players.get(id), point = originalPick(id);
  if (player && point && player.isBot) {
    const options = frontier.spawnOptions(player, game.tick);
    let best = 'none', d = Infinity;
    for (const o of options) { const e = Math.hypot(o.x - point.x, o.z - point.z); if (e < d) { d = e; best = o.id.startsWith('assault-') ? 'assault' : o.id.startsWith('mobile-') ? 'mobile' : o.id.startsWith('reserve-') ? 'reserve' : 'base'; } }
    spawnKinds.set(best, (spawnKinds.get(best) ?? 0) + 1);
  }
  return point;
};
const owners = new Map(frontier.territories.map(t => [t.id, t.owner]));
const baseOwners = new Map(frontier.bases.map(b => [b.id, b.owner]));
const firstFight = new Map<number, number>(), spawnedAt = new Map<number, number>(), alive = new Map<number, boolean>();
const spawnBlock = new Map<number, number>();
let lastKills = 0, windowFlips = 0, windowBaseFlips = 0, totalFlips = 0, totalBaseFlips = 0;
let stalledSamples = 0, deadSamples = 0, samples = 0, contestedSamples = 0;
const flipLog: { t: number; id: string; from: number; to: number }[] = [];
const windows: unknown[] = [];
const fightDelays: number[] = [];
let botMs = 0, simMs = 0;

const nearestBase = (x: number, z: number) => {
  let best = frontier.bases[0], d = Infinity;
  for (const b of frontier.bases) { const e = Math.hypot(b.x - x, b.z - z); if (e < d) { d = e; best = b; } }
  return { base: best, distance: d };
};

const report = () => {
  const living = bots.filter(b => b.player.state.alive);
  const infantry = living.filter(b => b.player.state.vehicle === VEHICLE.NONE);
  const byBase = new Map<string, number>();
  for (const b of infantry) {
    const { base, distance } = nearestBase(b.player.state.px, b.player.state.pz);
    const key = distance < 1300 ? base.id : 'field';
    byBase.set(key, (byBase.get(key) ?? 0) + 1);
  }
  const ranked = [...byBase].filter(([k]) => k !== 'field').sort((a, b) => b[1] - a[1]);
  const top = ranked[0] ?? ['none', 0];
  const share = [0, 0, 0, 0];
  for (const t of frontier.territories) share[t.owner]++;
  const battles = frontier.battleReports(game.tick);
  const orderDistance = living.map(b => {
    const o = frontier.order(b.player); return o ? Math.hypot(o.x - b.player.state.px, o.z - b.player.state.pz) : NaN;
  }).filter(Number.isFinite).sort((a, b) => a - b);
  const kills = game.stats.kills - lastKills; lastKills = game.stats.kills;
  const row = {
    t: Math.round(game.tick / 60), wall: +((performance.now() - started) / 1000).toFixed(1),
    living: living.length, kills, killsPerMin: +(kills * 60 / windowSeconds).toFixed(1),
    flips: windowFlips, baseFlips: windowBaseFlips,
    controls: { unclaimed: share[0], accord: share[1], helix: share[2], vanguard: share[3] },
    topBase: top[0], topShare: +(Number(top[1]) / Math.max(1, infantry.length)).toFixed(2), occupiedBases: ranked.filter(([, n]) => n >= 3).length,
    field: byBase.get('field') ?? 0,
    battles: battles.length, hotBattles: battles.filter(b => b.intensity > .4).length,
    contested: frontier.territories.filter(t => t.contested).length,
    medianOrderKm: orderDistance.length ? +(orderDistance[orderDistance.length >> 1] / 1000).toFixed(2) : null,
    stalledRespawns: bots.filter(b => !b.player.state.alive && b.player.respawnAtTick >= 0 && game.tick > b.player.respawnAtTick + 120).length,
    meanBotMs: +(botMs / Math.max(1, game.tick)).toFixed(2), meanSimMs: +(simMs / Math.max(1, game.tick)).toFixed(2),
    spawns: Object.fromEntries(spawnKinds),
    ops: ([1, 2, 3] as const).map(f => (frontier as unknown as { director: { operations(f: number): { target: { id: string }; defending: boolean; squads: number }[] } }).director.operations(f).map(o => `${o.defending ? 'D' : 'A'}:${o.target.id}x${o.squads}`).join(' ')),
    war: frontier.warStatus(game.tick),
    // Who stands in the busiest capture rings (bots count 1 here).
    rings: frontier.territories.map(t => {
      const n = [0, 0, 0, 0];
      for (const b of living) { const q = b.player.state; if (b.player.faction && !q.vehicle && Math.abs(q.py - t.y) <= 6 && Math.hypot(q.px - t.x, q.pz - t.z) <= t.radius) n[b.player.faction]++; }
      const near = [0, 0, 0, 0];
      for (const b of living) { const q = b.player.state; if (b.player.faction && Math.hypot(q.px - t.x, q.pz - t.z) <= 250) near[b.player.faction]++; }
      return { id: t.id, owner: t.owner, inRing: n.slice(1).join('/'), within250: near.slice(1).join('/'), progress: +(t.captureProgress ?? 0).toFixed(2), by: t.captureFaction };
    }).filter(r => r.within250 !== '0/0/0').sort((a, b) => b.within250.split('/').reduce((n, x) => n + +x, 0) - a.within250.split('/').reduce((n, x) => n + +x, 0)).slice(0, 6),
  };
  spawnKinds.clear();
  windowFlips = windowBaseFlips = 0;
  windows.push(row); console.log(JSON.stringify(row));
};

// Sieges: two or more factions (2+ soldiers each) fighting within 250 m of a
// base's controls, continuously (gaps up to 30 s). A siege ends when the
// base changes hands (captured) or the fighting stops (repelled/abandoned).
const sieges = new Map<string, { start: number; last: number; owner: number }>();
const siegeLog: { id: string; seconds: number; outcome: 'captured' | 'ended' | 'ongoing' }[] = [];
const baseControls = new Map(frontier.bases.map(b => [b.id, frontier.territories.filter(t => b.controlIds.includes(t.id))]));
function trackSieges(tick: number): void {
  for (const b of frontier.bases) {
    const counts = [0, 0, 0, 0], controls = baseControls.get(b.id)!;
    for (const bot of bots) {
      const p = bot.player, q = p.state;
      if (!q.alive || !p.faction || !controls.some(t => Math.hypot(q.px - t.x, q.pz - t.z) <= 250)) continue;
      counts[p.faction]++;
    }
    const battle = counts.filter((n, f) => f > 0 && n >= 2).length >= 2;
    const siege = sieges.get(b.id);
    if (battle) { if (siege) siege.last = tick; else sieges.set(b.id, { start: tick, last: tick, owner: b.owner }); }
    const current = sieges.get(b.id);
    if (current && (b.owner !== current.owner || tick - current.last > 30 * 60)) {
      siegeLog.push({ id: b.id, seconds: Math.round((current.last - current.start) / 60), outcome: b.owner !== current.owner ? 'captured' : 'ended' });
      sieges.delete(b.id);
    }
  }
}

for (let tick = 0; tick < seconds * 60; tick++) {
  const t0 = performance.now();
  for (const bot of bots) game.queueInput(bot.player, bot.think(game));
  if (observer) {
    if (!observer.state.alive) { observer.respawnAtTick = -1; moveObserverToFight(); }
    game.queueInput(observer, { seq: ++observerSeq, buttons: BTN.HYPER, weapon: 1, yaw: 0, pitch: 0, renderTick: Math.max(0, game.tick - NET.INTERP_TICKS), renderFrac: 0 });
  }
  const t1 = performance.now(); game.step(); const t2 = performance.now();
  botMs += t1 - t0; simMs += t2 - t1;
  for (const t of frontier.territories) {
    const old = owners.get(t.id)!;
    if (old !== t.owner) { windowFlips++; totalFlips++; flipLog.push({ t: Math.round(game.tick / 60), id: t.id, from: old, to: t.owner }); owners.set(t.id, t.owner); }
  }
  for (const b of frontier.bases) {
    const old = baseOwners.get(b.id)!;
    if (old !== b.owner) { windowBaseFlips++; totalBaseFlips++; baseOwners.set(b.id, b.owner); }
  }
  if (game.tick % 30 === 0) {
    trackSieges(game.tick);
    samples++;
    contestedSamples += frontier.territories.filter(t => t.contested).length;
    for (const bot of bots) {
      const p = bot.player, was = alive.get(p.id) ?? false;
      if (p.state.alive && !was) { spawnedAt.set(p.id, game.tick); spawnBlock.set(p.id, p.regenBlockUntil); firstFight.delete(p.id); }
      alive.set(p.id, p.state.alive);
      if (!p.state.alive) { deadSamples++; if (p.respawnAtTick >= 0 && game.tick > p.respawnAtTick + 120) stalledSamples++; continue; }
      // A soldier is "in the fight" once it has recently taken damage.
      if (!firstFight.has(p.id) && p.regenBlockUntil > game.tick && p.regenBlockUntil !== spawnBlock.get(p.id) && spawnedAt.has(p.id)) {
        firstFight.set(p.id, game.tick); fightDelays.push((game.tick - spawnedAt.get(p.id)!) / 60);
      }
    }
  }
  if (game.tick % (windowSeconds * 60) === 0) { report(); moveObserverToFight(); await new Promise<void>(r => setImmediate(r)); }
}
fightDelays.sort((a, b) => a - b);
for (const [id, siege] of sieges) siegeLog.push({ id, seconds: Math.round((game.tick - siege.start) / 60), outcome: 'ongoing' });
const siegeSeconds = siegeLog.filter(s => s.seconds >= 30).map(s => s.seconds).sort((a, b) => a - b);
const summary = {
  seed, seconds, population, wallSeconds: +((performance.now() - started) / 1000).toFixed(1),
  totalKills: game.stats.kills, killsPerMin: +(game.stats.kills * 60 / seconds).toFixed(1),
  controlFlips: totalFlips, baseFlips: totalBaseFlips,
  meanContestedControls: +(contestedSamples / Math.max(1, samples)).toFixed(2),
  stalledRespawnShare: +(stalledSamples / Math.max(1, deadSamples)).toFixed(2),
  medianSecondsToFirstFight: fightDelays.length ? +fightDelays[fightDelays.length >> 1].toFixed(1) : null,
  p75SecondsToFirstFight: fightDelays.length ? +fightDelays[Math.floor(fightDelays.length * .75)].toFixed(1) : null,
  respawnsReachingFight: fightDelays.length,
  meanBotMs: +(botMs / Math.max(1, game.tick)).toFixed(2), meanSimMs: +(simMs / Math.max(1, game.tick)).toFixed(2),
  finalBases: frontier.bases.map(b => ({ id: b.id, owner: b.owner })),
  // Battles at bases lasting 30 s or more: how long and how they ended.
  sieges: { count: siegeSeconds.length, captured: siegeLog.filter(s => s.seconds >= 30 && s.outcome === 'captured').length,
    ended: siegeLog.filter(s => s.seconds >= 30 && s.outcome === 'ended').length, ongoing: siegeLog.filter(s => s.outcome === 'ongoing').map(s => `${s.id} ${s.seconds}s`),
    medianSeconds: siegeSeconds[siegeSeconds.length >> 1] ?? null, p90Seconds: siegeSeconds[Math.floor(siegeSeconds.length * .9)] ?? null,
    longest: siegeLog.sort((a, b) => b.seconds - a.seconds).slice(0, 5).map(s => `${s.id} ${s.seconds}s ${s.outcome}`) },
};
console.log(JSON.stringify(summary, null, 1));
mkdirSync('artifacts', { recursive: true });
writeFileSync(`artifacts/${output}.json`, JSON.stringify({ summary, windows, flips: flipLog }, null, 1));
