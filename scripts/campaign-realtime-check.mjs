import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, freemem, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

// Real wall-clock regression, separate from accelerated simulation profiles.
// Every worker runs the existing production bundle with its normal scheduler.
// The fixture owns its coordinator, ports, processes and temporary saves.
const args = process.argv.slice(2), options = new Map();
if (args.length === 1 && args[0] === '--help') {
  console.log('node --no-warnings --experimental-sqlite scripts/campaign-realtime-check.mjs [--population 192] [--seconds 240] [--client-seconds 15] [--browser-seconds 0] [--browser-engine chromium|firefox] [--browser-mode headless|windowed] [--browser-activity walk|drive] [--viewport 1440x900] [--source-data data] [--server-entry path] [--label campaign-realtime]');
  console.log('Requires npm run build. Runs three isolated worlds with the requested population, then optional raw-socket and rendering-browser play checks. --source-data requires the source server stopped and Python sqlite3: DB/WAL files are copied and checked before a backup is read from staging. Campaign saves are copied into the temporary fixture; the original DB is never opened by SQLite. Writes raw samples and assertions under artifacts/.');
  process.exit(0);
}
for (let i = 0; i < args.length; i += 2) {
  const key = args[i], value = args[i + 1];
  assert.ok(['--population', '--seconds', '--client-seconds', '--browser-seconds', '--browser-engine', '--browser-mode', '--browser-activity', '--viewport', '--source-data', '--server-entry', '--label'].includes(key) && value !== undefined && !options.has(key), `Invalid option: ${key}`);
  options.set(key, value);
}
const seconds = Number(options.get('--seconds') ?? 240), clientSeconds = Number(options.get('--client-seconds') ?? 15);
const browserSeconds = Number(options.get('--browser-seconds') ?? 0);
const browserEngine = options.get('--browser-engine') ?? 'chromium';
assert.ok(['chromium', 'firefox'].includes(browserEngine), 'Browser engine must be chromium or firefox');
const browserMode = options.get('--browser-mode') ?? 'headless';
assert.ok(['headless','windowed'].includes(browserMode), 'Browser mode must be headless or windowed');
const browserActivity = options.get('--browser-activity') ?? 'walk';
assert.ok(['walk','drive'].includes(browserActivity), 'Browser activity must be walk or drive');
assert.ok(browserActivity !== 'drive' || browserSeconds >= 120, 'Driving needs at least 120 browser seconds for bounded boarding and travel');
const viewportMatch = /^(\d+)x(\d+)$/.exec(options.get('--viewport') ?? '1440x900');
assert.ok(viewportMatch, 'Viewport must be WIDTHxHEIGHT');
const viewport = { width: Number(viewportMatch[1]), height: Number(viewportMatch[2]) };
assert.ok(viewport.width >= 640 && viewport.width <= 7680 && viewport.height >= 360 && viewport.height <= 4320, 'Viewport is outside supported bounds');
const population = Number(options.get('--population') ?? 192);
assert.ok(Number.isInteger(population) && population >= 1 && population <= 384, 'Population must be 1..384');
const startupSeconds = 30;
const label = options.get('--label') ?? 'campaign-realtime';
assert.ok(Number.isInteger(seconds) && seconds >= 30 && seconds <= 1800, 'Duration must be 30..1800 seconds');
assert.ok(Number.isInteger(clientSeconds) && (clientSeconds === 0 || clientSeconds >= 10 && clientSeconds <= 120), 'Client phase must be 0 or 10..120 seconds');
assert.ok(Number.isInteger(browserSeconds) && (browserSeconds === 0 || browserSeconds >= 30 && browserSeconds <= 1800), 'Browser phase must be 0 or 30..1800 seconds');
assert.match(label, /^[a-z0-9]+(?:-[a-z0-9]+)*$/); assert.ok(label.length <= 64);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), artifacts = path.join(root, 'artifacts');
const entry = path.resolve(root, options.get('--server-entry') ?? 'packages/server/dist/server.cjs');
await access(entry); await mkdir(artifacts, { recursive: true });
const helper = path.join(artifacts, `${label}.fixture.cjs`);
await build({ stdin: { contents: `export { startCluster } from './packages/server/src/cluster.ts';
  export { PLANETS } from './packages/shared/src/universe.ts';
  export { ByteReader, Msg, decodeWelcome, decodeSnapshot, decodeFire, encodeHello, encodeInput } from './packages/shared/src/protocol.ts';
  export { decodeFrontierState } from './packages/shared/src/frontier-wire.ts';
  export { VEHICLE, vehicleDefinition, vehicleArmament } from './packages/shared/src/vehicles.ts';
  export { TICK_RATE, WORLD, PLAYER } from './packages/shared/src/constants.ts';
  export { MAP_SIZE, MAP_SPAN } from './packages/client/src/world-map.ts';`,
  resolveDir: root, loader: 'ts' }, outfile: helper, bundle: true, platform: 'node', format: 'cjs', target: ['node22'],
  tsconfig: path.join(root, 'tsconfig.json'), external: ['bufferutil', 'utf-8-validate'], logOverride: { 'empty-import-meta': 'silent' } });
const { startCluster, PLANETS, ByteReader, Msg, decodeWelcome, decodeSnapshot, decodeFire, decodeFrontierState, encodeHello, encodeInput,
  VEHICLE, vehicleDefinition, vehicleArmament, TICK_RATE, WORLD, PLAYER, MAP_SIZE, MAP_SPAN } = createRequire(import.meta.url)(helper);
const temporary = await mkdtemp(path.join(tmpdir(), 'mmofps-realtime-'));
const samples = [], exits = [], baseline = new Map(), populationDeficits = new Map();
let cluster, client, browser, browserServer, browserPage, browserProbe, copiedData, failure, closing = false, closed = false, began = 0, stoppedBySignal = '';
const browserCleanup = { pid: undefined, stopped: false, forced: false };
let browserState, browserEnvironment, browserPlaying = false, browserClosing = false, rawClientResult;
let browserInitialNavigationPending = false;
let clientDisconnect;
let driveActivity;
const browserErrors = [];
const browserVisibility = { startup: undefined, play: undefined, final: undefined, events: [], dropped: 0 };
const signal = name => { stoppedBySignal = name; };
const sigint = () => signal('SIGINT'), sigterm = () => signal('SIGTERM');
process.on('SIGINT', sigint); process.on('SIGTERM', sigterm);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
// Playwright's default action timeout does not bound page.evaluate. A stalled
// renderer must still let the fixture reach its owned-browser/server cleanup.
const boundedBrowserWork = async (work, description, timeoutMs = 5000) => {
  let timer;
  try {
    return await Promise.race([work, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${description} exceeded ${timeoutMs} ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
};
const copySavedWorlds = async () => {
  if (!options.has('--source-data')) return;
  const source = path.resolve(root, options.get('--source-data'));
  assert.notEqual(source, path.resolve(temporary));
  // Node 22.11 silently ignores DatabaseSync's newer readOnly option and may
  // checkpoint the source WAL on close; even a true readonly SQLite reader
  // can touch its shared-memory file. Copy DB+WAL before opening any SQLite
  // handle, reject a changed source, then backup from that isolated staging.
  // Never copy a live .sqlite file alone or restore an old WAL over its DB.
  const backupScript = `
import hashlib,json,pathlib,shutil,sqlite3,sys
source=pathlib.Path(sys.argv[1]).resolve()
def files():
    result={}
    for suffix in ['', '-wal', '-shm']:
        p=pathlib.Path(str(source)+suffix)
        if p.exists():
            s=p.stat(); result[suffix or 'database']={'bytes':s.st_size,'mtimeNs':str(s.st_mtime_ns),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
    return result
before=files()
staging=pathlib.Path(sys.argv[2]).parent/'source-snapshot'
staging.mkdir()
staged=staging/'universe.sqlite'
for suffix in ['', '-wal']:
    p=pathlib.Path(str(source)+suffix)
    if p.exists(): shutil.copyfile(p,pathlib.Path(str(staged)+suffix))
assert before==files(), 'Source database changed during copy; stop the source server first'
original=sqlite3.connect(staged.as_uri()+'?mode=ro',uri=True)
snapshot=sqlite3.connect(sys.argv[2])
try:
    original.backup(snapshot)
    assert snapshot.execute('PRAGMA integrity_check').fetchone()[0]=='ok', 'Copied database integrity check failed'
    authorities=[{'planet':r[0],'epoch':r[1]} for r in snapshot.execute('SELECT planet,epoch FROM world_authorities')]
    clocks=[{'planet':r[0],'tick':r[1]} for r in snapshot.execute('SELECT planet,tick FROM planet_clocks')]
finally:
    snapshot.close(); original.close()
after=files()
print(json.dumps({'sqliteSnapshot':True,'method':'Stable DB+WAL filesystem copy, then Python sqlite3 backup from staging','worlds':[],'authorities':authorities,'clocks':clocks,'sourceFilesBefore':before,'sourceFilesAfter':after,'sourceFilesUnchanged':before==after}))
`;
  const snapshot = await promisify(execFile)('python', ['-c', backupScript, path.join(source, 'universe.sqlite'), path.join(temporary, 'universe.sqlite')],
    { windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024 });
  copiedData = JSON.parse(snapshot.stdout);
  assert.equal(copiedData.sourceFilesUnchanged, true, 'Source save files changed during snapshot; stop the source server before this reproducible fixture');
  for (const planet of PLANETS) {
    const from = path.join(source, planet.id), to = path.join(temporary, planet.id);
    await mkdir(to, { recursive: true });
    try { await copyFile(path.join(from, 'world.json'), path.join(to, 'world.json')); copiedData.worlds.push(planet.id); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await cp(path.join(from, 'players'), path.join(to, 'players'), { recursive: true, errorOnExist: true, force: false }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
};
const receive = (probe, bytes) => {
  try {
    const reader = new ByteReader(bytes), type = reader.u8();
    if (type === Msg.SWelcome) { probe.welcome = decodeWelcome(reader); probe.joinedAt ??= performance.now(); }
    if (type === Msg.SSnapshot) {
      const snapshot = decodeSnapshot(reader), now = performance.now();
      if (probe.latest && snapshot.tick <= probe.latest.tick) probe.error = 'Snapshot tick failed to advance';
      if (probe.snapshots) probe.maxSnapshotGapMs = Math.max(probe.maxSnapshotGapMs, now - probe.lastSnapshotAt);
      probe.latest = snapshot; probe.snapshots++; probe.lastSnapshotAt = now;
      if (probe === browserProbe) driveActivity?.observe(snapshot);
    }
    if (type === Msg.SFire && probe === browserProbe && driveActivity) driveActivity.fire(decodeFire(reader));
    if (type === Msg.SFrontier && probe === browserProbe && browserActivity === 'drive') {
      // The public strategic packet includes depot/base locations, not stock.
      // Copy only this bounded network message; never query server internals.
      const message = ArrayBuffer.isView(bytes) ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) : bytes;
      probe.frontier = decodeFrontierState(message); probe.frontierAt = performance.now();
    }
  } catch (error) { probe.error = String(error); }
};
const probeState = probe => probe ? { snapshots: probe.snapshots, sent: probe.sent, acknowledged: probe.latest?.lastSeq ?? 0,
  tick: probe.latest?.tick, lastSnapshotAgeMs: performance.now() - probe.lastSnapshotAt, maxSnapshotGapMs: probe.maxSnapshotGapMs,
  // Record only already-decoded network data. This adds no server hooks or
  // actor serialization to its simulation loop, and makes heavy admissions
  // distinguishable from browser-generation pressure in failed runs.
  yourId: probe.welcome?.yourId,
  position: probe.latest ? { x: probe.latest.you.px, y: probe.latest.you.py, z: probe.latest.you.pz,
    alive: probe.latest.you.alive, grounded: probe.latest.you.grounded, vehicle: probe.latest.you.vehicle,
    ...(browserActivity === 'drive' ? { seat: probe.latest.you.seat ?? 0, vehicleId: probe.latest.you.vehicleId,
      heading: probe.latest.you.heading, speed: Math.hypot(probe.latest.you.vx, probe.latest.you.vz),
      boosting: probe.latest.you.boosting, boostFuel: probe.latest.you.boostFuel } : {}) } : undefined,
  nearbySnapshotActors: probe.latest?.ents.filter(entity => entity.kind === 0 && !entity.dead &&
    (entity.x-probe.latest.you.px)**2+(entity.z-probe.latest.you.pz)**2 < 300**2).map(entity => ({
      id: entity.id, x: entity.x, y: entity.y, z: entity.z, grounded: entity.grounded,
      vehicle: entity.vehicle, seat: entity.seat })),
  closed: probe.closed, error: probe.error } : undefined;
const cpu = () => cpus().reduce((total, core) => {
  total.idle += core.times.idle; total.all += Object.values(core.times).reduce((a, b) => a + b, 0); return total;
}, { idle: 0, all: 0 });
let previousCpu = cpu();
const fetchHealth = async (url, timeoutMs = 3000) => {
  const start = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { status: response.status, health: await response.json(), readAtMs: performance.now() - began, responseMs: performance.now() - start };
  } catch (error) { return { error: String(error), readAtMs: performance.now() - began, responseMs: performance.now() - start }; }
};
const persistSamples = () => writeFile(path.join(artifacts, `${label}-samples.json`), JSON.stringify(samples, null, 2));
const readBrowser = async () => {
  if (!browserPage) return undefined;
  // The first goto replaces about:blank and destroys its execution context.
  // Keep sampling server health while that one explicit navigation is pending;
  // after DOMContentLoaded, monitoring errors remain fatal in every phase.
  if (browserInitialNavigationPending) return { loading: true, initialNavigationPending: true };
  let timeout;
  try {
    return await Promise.race([
      browserPage.evaluate(() => {
        const trace = window.__realtimeFrames, state = window.__mmofps?.state;
        if (!trace) return { loading: true };
        const frames = { ...trace.period }, longTasks = { ...trace.longTasks };
        trace.period = { count: 0, totalMs: 0, maxMs: 0, over50: 0, over100: 0, over250: 0 };
        trace.longTasks = { count: 0, totalMs: 0, maxMs: 0 };
        const visibility = { atMs: performance.now(), state: document.visibilityState,
          hidden: document.hidden, hasFocus: document.hasFocus() };
        return { frames, longTasks, visibility, connected: state?.connected, initialized: state?.initialized,
          worldPresented: state?.rendering.worldPresented, alive: state?.alive, pos: state?.pos,
          simulationTick: state?.simulationTick, rttMs: state?.rttMs, seed: state?.seed,
          mapArtwork: state?.mapArtwork,
          camera: state?.camera,
          locked: !!document.pointerLockElement, streaming: state?.streaming,
          rendering: state?.rendering, chunks: state?.chunks };
      }),
      new Promise(resolve => { timeout = setTimeout(() => resolve({ error: 'Browser main thread did not answer within five seconds' }), 5000); }),
    ]);
  } catch (error) { return { error: String(error) }; }
  finally { clearTimeout(timeout); }
};
const sample = async phase => {
  assert.equal(stoppedBySignal, '', `Fixture interrupted by ${stoppedBySignal}`);
  const start = performance.now(), sampledAt = new Date().toISOString(), currentCpu = cpu(), deltaCpu = currentCpu.all - previousCpu.all;
  const hostBusy = deltaCpu > 0 ? 1 - (currentCpu.idle - previousCpu.idle) / deltaCpu : 0; previousCpu = currentCpu;
  const worldsRead = Promise.all(PLANETS.map(async planet => {
    const worker = cluster.workers.get(planet.id), authority = cluster.coordinator.route(planet.id);
    const healthTimeout = clientDisconnect ? Math.max(1, Math.ceil(clientDisconnect.deadline - performance.now())) : 3000;
    return { planet: planet.id, pid: worker?.process.pid, port: worker?.port, epoch: authority?.epoch, authorityId: authority?.id,
      ...(worker ? await fetchHealth(`http://127.0.0.1:${worker.port}/healthz`, healthTimeout) : { error: 'Worker absent' }) };
  }));
  const [worlds, browserRead] = await Promise.all([worldsRead, readBrowser()]);
  if (browserRead) { if (driveActivity) browserRead.activity = driveActivity.summary(); browserState = browserRead; }
  if (phase === 'browser-startup' && browserRead?.visibility) browserVisibility.startup ??= browserRead.visibility;
  const probe = probeState(client), browserNetwork = probeState(browserProbe);
  const initialStartup = start - began < startupSeconds * 1000;
  const startup = initialStartup || phase === 'browser-startup';
  // Keep UTC and monotonic sample origins paired before the asynchronous
  // health/browser reads, so host CPU intervals can align with short phases.
  const row = { at: sampledAt, completedAt: new Date().toISOString(), elapsedMs: start - began, phase: initialStartup ? 'startup' : phase,
    hostBusy, freeMemoryMB: freemem() / 1024 ** 2, worlds, client: probe,
    browser: browserRead ? { ...browserRead, network: browserNetwork } : undefined };
  samples.push(row);
  assert.equal(stoppedBySignal, '', `Fixture interrupted by ${stoppedBySignal}`);
  assert.equal(exits.length, 0, `Worker exited during the fixture: ${JSON.stringify(exits)}`);
  assert.equal(cluster.workers.size, PLANETS.length, 'Every expected planet has a worker');
  for (const world of worlds) {
    assert.equal(world.error, undefined, `${world.planet}: ${world.error}`);
    assert.equal(world.status, 200, `${world.planet}: health HTTP status`);
    assert.equal(world.health.ok, true, `${world.planet}: ready`);
    assert.equal(world.health.authority?.ready, true, `${world.planet}: authority ready`);
    assert.equal(world.health.failure, undefined, `${world.planet}: simulation failure`);
    const original = baseline.get(world.planet);
    if (!original) {
      const previousEpoch = copiedData?.authorities.find(authority => authority.planet === world.planet)?.epoch ?? 0;
      assert.equal(world.epoch, previousEpoch + 1, `${world.planet}: worker did not restart during cluster startup`);
      baseline.set(world.planet, { pid: world.pid, epoch: world.epoch, id: world.authorityId });
    } else {
      assert.equal(world.pid, original.pid, `${world.planet}: process replaced`);
      assert.equal(world.epoch, original.epoch, `${world.planet}: authority epoch changed`);
      assert.equal(world.authorityId, original.id, `${world.planet}: authority identity changed`);
    }
    assert.equal(world.health.authority.epoch, world.epoch, `${world.planet}: directory and worker epochs agree`);
    const human = client ?? browserProbe;
    const withClient = !!human?.welcome && world.planet === 'meridian';
    const admittingBrowser = !!browserProbe && !browserProbe.welcome && world.planet === 'meridian';
    const disconnectingClient = !!clientDisconnect && phase === 'client-disconnect' && world.planet === 'meridian';
    const frozen = world.health.authority.campaign?.frozen ?? 0;
    const humans = world.health.players - world.health.bots + frozen;
    assert.ok(Number.isInteger(frozen) && frozen >= 0 && frozen <= 6, `${world.planet}: at most one squad in transit`);
    if (disconnectingClient) assert.ok(humans === 0 || humans === 1, 'Only the departing client may remain during disconnect');
    else if (admittingBrowser) assert.ok(humans === 0 || humans === 1, 'Browser admission may be in flight');
    else assert.equal(humans, withClient ? 1 : 0, `${world.planet}: expected human population`);
    const adaptive = world.health.population;
    const minimumPopulation = Math.min(population, Math.max(48, Math.ceil(population / 2)));
    assert.equal(adaptive?.adaptive, true, world.planet + ': adaptive population enabled');
    assert.equal(adaptive.maximum, population, world.planet + ': configured maximum');
    assert.equal(adaptive.minimum, minimumPopulation, world.planet + ': configured minimum');
    assert.ok(Number.isInteger(adaptive.target) && adaptive.target >= minimumPopulation && adaptive.target <= population,
      world.planet + ': target remains within adaptive bounds');
    assert.equal(adaptive.actual, world.health.players, world.planet + ': actual health census agrees');
    assert.equal(adaptive.bots, world.health.bots, world.planet + ': bot health census agrees');
    assert.ok(Number.isInteger(adaptive.actual) && adaptive.actual >= 0 && Number.isInteger(adaptive.bots) && adaptive.bots >= frozen,
      world.planet + ': valid live and detached bot census');
    // Detached transfers remain in the roster while absent from live players.
    // Quiet/visible/combat-protected bots may remain above the soft target;
    // they never excuse exceeding the configured live-actor ceiling.
    assert.ok(adaptive.actual <= Math.max(adaptive.maximum, humans), world.planet + ': configured live population ceiling');
    const desiredBots = Math.max(0, adaptive.target - humans);
    if (world.health.bots >= desiredBots) populationDeficits.delete(world.planet);
    else if (row.elapsedMs >= 10_000) {
      const refillAllowance = 6 + Math.max(1, Math.ceil(population / 32));
      assert.ok(world.health.bots >= desiredBots - refillAllowance,
        world.planet + ': only one expedition and recovery refill are pending');
      const previousDeficit = populationDeficits.get(world.planet);
      if (!previousDeficit || previousDeficit.target !== adaptive.target)
        populationDeficits.set(world.planet, { since: row.elapsedMs, target: adaptive.target });
      assert.ok(row.elapsedMs - populationDeficits.get(world.planet).since < 5000,
        world.planet + ': adaptive replacement soldiers failed to arrive');
    }
    // All three workers keep simulating during cold generation/JIT startup.
    // Allow its initial debt to drain without changing production tick policy.
    const debtLimit = startup ? 240 : 120;
    assert.ok(world.health.clockDebt <= debtLimit, `${world.planet}: ${startup ? 'startup' : 'steady'} debt exceeded ${debtLimit} ticks (${world.health.clockDebt})`);
    assert.ok(world.health.simulation.maxDebt <= 240, `${world.planet}: an unsampled debt spike exceeded four seconds`);
    const previous = samples.at(-2)?.worlds.find(w => w.planet === world.planet);
    if (previous) {
      assert.ok(world.health.tick >= previous.health.tick, `${world.planet}: simulation clock went backwards`);
      // A fresh phase-boundary check may follow the previous response within
      // one tick. Normal half-second-or-longer observations must progress.
      if (world.readAtMs - previous.readAtMs >= 500)
        assert.ok(world.health.tick > previous.health.tick, `${world.planet}: simulation stopped advancing`);
    }
    // Shader submission, welcome geometry and initial terrain workers have a
    // bounded startup phase just like cold world generation. Once the world
    // is presented, establish a new cadence window entirely within actual
    // rendering play rather than charging that prior startup to its first
    // steady samples. All steady debt/final recovery limits stay unchanged.
    const earlier = [...samples].reverse().find(s => row.elapsedMs - s.elapsedMs >= 10_000 &&
      (!browserPlaying || s.phase === 'browser-play'))?.worlds.find(w => w.planet === world.planet);
    if (!startup && earlier) {
      const elapsedSeconds = (world.readAtMs - earlier.readAtMs) / 1000, progressed = world.health.tick - earlier.health.tick;
      assert.ok(progressed >= elapsedSeconds * 60 - 90, `${world.planet}: sustained cadence fell behind (${(progressed / elapsedSeconds).toFixed(1)} Hz)`);
    }
  }
  if (probe) {
    assert.equal(probe.closed, false, 'Synthetic client remains connected');
    assert.equal(probe.error, undefined, 'Synthetic client has no socket/protocol error');
    assert.ok(probe.lastSnapshotAgeMs < 2000, 'Snapshots continue arriving');
    assert.ok(probe.sent - probe.acknowledged < 60, 'Input acknowledgements stay within three seconds');
  }
  if (browserRead) {
    assert.equal(browserRead.error, undefined, `Browser monitoring: ${browserRead.error}`);
    assert.deepEqual(browserErrors, [], 'Rendering browser has no script or console errors');
    if (browserProbe?.welcome) {
      assert.equal(browserNetwork.closed, false, 'Rendering browser remains connected');
      assert.equal(browserNetwork.error, undefined, 'Rendering browser has no protocol error');
      if (browserPlaying) {
        assert.ok(browserNetwork.lastSnapshotAgeMs < 2000, 'Rendering browser keeps receiving snapshots');
        assert.equal(browserRead.connected, true, 'Game client remains connected during play');
      }
    }
  }
  if (samples.length % 15 === 0) {
    await persistSamples();
    console.log(JSON.stringify({ seconds: Math.round(row.elapsedMs / 1000), phase: row.phase,
      worlds: worlds.map(w => ({ planet: w.planet, pid: w.pid, epoch: w.epoch, bots: w.health.bots, debt: w.health.clockDebt, meanTickMs: w.health.simulation.meanTickWorkMs })) }));
  }
};
const phase = async (name, duration) => {
  const until = performance.now() + duration * 1000;
  do { const at = performance.now(); await sample(name); await delay(Math.max(1, Math.min(1000 - (performance.now() - at), until - performance.now()))); }
  while (performance.now() < until);
};
const connect = async () => {
  const response = await fetch(`http://127.0.0.1:${cluster.port}/api/session`, { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie);
  const ws = new WebSocket(`ws://127.0.0.1:${cluster.port}/ws`, { headers: { Cookie: cookie } }); ws.binaryType = 'arraybuffer';
  const probe = { ws, sent: 0, snapshots: 0, lastSnapshotAt: performance.now(), maxSnapshotGapMs: 0, closed: false, joinedAt: performance.now() };
  client = probe;
  ws.on('error', error => { probe.error = error.message; }); ws.on('close', () => { probe.closed = true; });
  ws.on('message', bytes => receive(probe, bytes));
  ws.on('open', () => ws.send(encodeHello('Realtime fixture')));
  const deadline = performance.now() + 10_000;
  while ((!probe.welcome || !probe.latest) && performance.now() < deadline && !probe.error && !probe.closed) await delay(50);
  assert.ok(probe.welcome && probe.latest, `Synthetic player admission: ${probe.error ?? 'no welcome/snapshot'}`);
  assert.equal(probe.welcome.seed, 1337, 'Synthetic player joins Meridian through the gateway');
  probe.joinedAt = performance.now();
  probe.timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(encodeInput({ seq: ++probe.sent, buttons: 0, weapon: 0, yaw: probe.sent * .005, pitch: 0,
      renderTick: probe.latest.tick, renderFrac: 0 }));
  }, 50);
};
const disconnectClient = async () => {
  const departing = client;
  assert.ok(departing, 'There is a synthetic client to disconnect');
  clearInterval(departing.timer);
  const transition = { deadline: performance.now() + 2000, closed: departing.ws.readyState === WebSocket.CLOSED };
  const onClose = () => { transition.closed = true; };
  departing.ws.once('close', onClose);
  clientDisconnect = transition; client = undefined;
  departing.ws.close();
  try {
    // The gateway close acknowledgement can precede its upstream close. Keep
    // all population/clock checks active until the worker confirms removal.
    for (;;) {
      await sample('client-disconnect');
      assert.ok(performance.now() <= transition.deadline, 'Authoritative client removal exceeded two seconds');
      const world = samples.at(-1).worlds.find(world => world.planet === 'meridian');
      const humans = world.health.players - world.health.bots + (world.health.authority.campaign?.frozen ?? 0);
      if (transition.closed && humans === 0) break;
      await delay(Math.max(1, Math.min(50, transition.deadline - performance.now())));
    }
  } finally {
    departing.ws.off('close', onClose);
    clientDisconnect = undefined;
    if (!transition.closed) departing.ws.terminate();
  }
};
// This driver uses only received snapshots, existing atlas paths and ordinary
// browser input. It cannot move actors/hulls, bypass collisions or grant a seat.
const createDriveActivity = page => {
  const began = performance.now(), keys = new Set(), mouse = new Set(), tiles = new Set();
  const bins = [], retiredTargets = new Map(), searchedDepots = new Set();
  const metrics = { stage: 'approach', driverSeconds: 0, movingSeconds: 0, boostedSeconds: 0, cruiseSeconds: 0,
    distance: 0, maxSpeed: 0, ownVehicleShots: 0, boardingAttempts: 0, deaths: 0,
    discontinuities: 0, waypointsReached: 0, routeSource: null, route: [], routeUpgrades: 0, boardedAtSeconds: null,
    targetChanges: 0, targetAbandons: 0, targetFailures: [], depotChanges: 0, depotWaypointsReached: 0,
    depotSearchSeconds: 0, depotSearchDistance: 0, depotFailures: [], depotVisits: [],
    recoveryAttempts: 0, recoverySuccesses: 0, recoveryEvents: [] };
  let previous, target, targetSeen = 0, targetAttempts = 0, nextUse = 0, nextJump = 0, routeIndex = 0, routeHull, routeArtworkChecked = false;
  let aimYaw, lastCamera, progressAt = began, progressDistance = Infinity, sideUntil = 0, driveSince, finishedAt, depot;
  let driveProgress, recovery;
  const recordRecovery = event => {
    metrics.recoveryEvents.push(event);
    if(metrics.recoveryEvents.length>40)metrics.recoveryEvents.shift();
  };
  const resetDriveProgress = (s,now,reason) => {
    if(recovery)recordRecovery({stage:'aborted',reason,vehicleId:recovery.hull,atSeconds:(now-began)/1000});
    recovery=undefined;
    driveProgress=s?{hull:s.vehicleId,x:s.px,z:s.pz,stalledSeconds:0,attempts:0,goodSeconds:0,goodX:s.px,goodZ:s.pz}:undefined;
  };
  const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle));
  const setKey = async (key, down) => { if (keys.has(key) === down) return; await boundedBrowserWork(page.keyboard[down ? 'down' : 'up'](key), `Drive key ${key}`); down ? keys.add(key) : keys.delete(key); };
  const setMouse = async (button, down) => { if (mouse.has(button) === down) return; await boundedBrowserWork(page.mouse[down ? 'down' : 'up']({ button }), `Drive mouse ${button}`); down ? mouse.add(button) : mouse.delete(button); };
  const release = async () => { for (const key of [...keys]) await setKey(key, false); for (const button of [...mouse]) await setMouse(button, false); };
  const abandonTarget = (reason, now) => {
    if (target) {
      retiredTargets.set(target.id, now + 30000);
      if (retiredTargets.size > 64) retiredTargets.delete(retiredTargets.keys().next().value);
      metrics.targetAbandons++;
      metrics.targetFailures.push({ vehicleId: target.id, reason, attempts: targetAttempts, atSeconds: (now - began) / 1000 });
      if (metrics.targetFailures.length > 16) metrics.targetFailures.shift();
    }
    target = undefined; targetAttempts = 0; progressAt = now; progressDistance = Infinity; sideUntil = 0;
  };
  const binAt = index => bins[index] ??= { driverSeconds: 0, movingSeconds: 0, distance: 0, newTerrainTiles64m: 0 };
  const finish = () => { finishedAt ??= performance.now(); };
  const approachBudget = now => {
    const remaining = ((metrics.boardedAtSeconds === null ? 90000 : browserSeconds*1000) - (now-began))/1000;
    // Straight-line running is only an optimistic lower bound; hills and
    // obstacles still have to be traversed through ordinary movement.
    return { remaining, distanceBudget: Math.max(0, (remaining-5)*PLAYER.RUN_SPEED) };
  };
  const vehicleEvidence = () => {
    const snapshot = browserProbe.latest, s = snapshot?.you;
    if (!s) return undefined;
    const describe = (v, occupied = false) => ({ id: v.id, ...(occupied ? { vehicleId: v.vehicleId } : {}),
      type: occupied ? v.vehicle : v.type, name: vehicleDefinition(occupied ? v.vehicle : v.type)?.name ?? 'Unknown',
      x: v.x, y: v.y, z: v.z, distance: Math.hypot(v.x - s.px, v.z - s.pz), altitude: v.y - s.py,
      ...(occupied ? { seat: v.seat ?? 0 } : { health: v.health, retryExcluded: (retiredTargets.get(v.id) ?? 0) > performance.now() }) });
    const parked = (snapshot.vehicles ?? []).map(v => describe(v)).sort((a,b) => a.distance-b.distance);
    const occupied = snapshot.ents.filter(e => e.kind === 0 && !e.dead && e.vehicle && (e.seat ?? 0) === 0)
      .map(v => describe(v, true)).sort((a,b) => a.distance-b.distance);
    const types = rows => { const counts = {}; for (const row of rows) counts[row.name] = (counts[row.name] ?? 0) + 1; return counts; };
    const jeeps = parked.filter(v => v.type === VEHICLE.JEEP && v.health > 0);
    const { remaining, distanceBudget } = approachBudget(performance.now());
    const finitePosition = v => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
    return { tick: snapshot.tick, parkedCount: parked.length, parkedByType: types(parked),
      snapshotLimitPossiblyReached: parked.length >= 24,
      liveParkedJeeps: jeeps.length, boardingHeightMismatchJeeps: jeeps.filter(v => Math.abs(v.altitude) >= 3).length,
      nonfinitePositionJeeps: jeeps.filter(v => !finitePosition(v)).length,
      beyondApproachBudgetJeeps: jeeps.filter(v => v.distance > Math.max(2.8,distanceBudget)).length,
      approachRemainingSeconds: Math.max(0,remaining), optimisticApproachDistanceBudget: distanceBudget,
      retryExcludedJeeps: jeeps.filter(v => v.retryExcluded).length,
      eligibleParkedJeeps: jeeps.filter(v => finitePosition(v) && v.distance <= Math.max(2.8,distanceBudget) && !v.retryExcluded).length,
      nearestParked: parked.slice(0, 6), nearestParkedJeeps: jeeps.slice(0, 6),
      visibleOccupiedDrivers: occupied.length, occupiedByType: types(occupied), nearestOccupied: occupied.slice(0, 6),
      limitation: 'Parked snapshots omit occupied and respawning hulls; occupied drivers use separate player interest. Neither list proves total depot stock.' };
  };
  const depotEvidence = () => {
    const s = browserProbe.latest?.you, frontier = browserProbe.frontier;
    return { frontierReceived: !!frontier, frontierAgeMs: browserProbe.frontierAt === undefined ? undefined : performance.now()-browserProbe.frontierAt,
      faction: frontier?.you?.faction, searched: [...searchedDepots],
      target: depot ? { id: depot.base.id, name: depot.base.name, owner: depot.base.owner, x: depot.base.x, y: depot.base.y, z: depot.base.z,
        waypointIndex: depot.index, waypoint: depot.points[depot.index] } : undefined,
      nearestBases: s ? (frontier?.bases ?? []).map(base => ({ id: base.id, name: base.name, owner: base.owner,
        x: base.x, y: base.y, z: base.z, distance: Math.hypot(base.x-s.px,base.z-s.pz) }))
        .sort((a,b)=>a.distance-b.distance).slice(0, 6) : [],
      limitation: 'Published bases are depot search hints, not assertions that a jeep is present or a route is clear.' };
  };
  const summary = () => {
    const duration = metrics.boardedAtSeconds === null ? 0 :
      Math.max(0, ((finishedAt ?? performance.now()) - began) / 1000 - metrics.boardedAtSeconds);
    return { ...metrics, targetFailures: metrics.targetFailures.slice(), depotFailures: metrics.depotFailures.slice(),
      recoveryEvents: metrics.recoveryEvents.slice(), recoveryStage: recovery ? performance.now()<recovery.reverseUntil?'reverse-turn':'forward-turn':null,
      stalledObservedSeconds: driveProgress?.stalledSeconds??0, consecutiveRecoveryAttempts: driveProgress?.attempts??0,
      depotVisits: metrics.depotVisits.slice(), postBoardingSeconds: duration,
      driverFraction: duration ? metrics.driverSeconds / duration : 0,
      movingFraction: duration ? metrics.movingSeconds / duration : 0,
      coverageClock: 'Observed wall-time between adjacent authoritative snapshots; gaps over one second earn no credit',
      minuteBins: Array.from({ length: Math.ceil(duration / 60) }, (_, index) => ({
        index, fromPostBoardingSeconds: index * 60, seconds: Math.min(60, duration - index * 60),
        complete: duration >= (index + 1) * 60,
        ...(bins[index] ?? { driverSeconds: 0, movingSeconds: 0, distance: 0, newTerrainTiles64m: 0 }),
      })),
      terrainTiles64m: tiles.size, targetVehicleId: target?.id,
      currentVehicleId: browserProbe?.latest?.you.vehicleId, waypointIndex: routeIndex,
      vehicleEvidence: vehicleEvidence(), depotSearch: depotEvidence() };
  };
  const observe = snapshot => {
    if (finishedAt !== undefined) return;
    const now = performance.now();
    const s = snapshot.you, driver = s.alive && s.vehicle === VEHICLE.JEEP && (s.seat ?? 0) === 0;
    if(!driver)resetDriveProgress(undefined,now,s.alive?'dismounted or lost driver seat':'death');
    else if(driveProgress?.hull!==s.vehicleId)resetDriveProgress(s,now,'changed hull');
    if (previous?.alive && !s.alive) metrics.deaths++;
    if (s.alive && !s.vehicle && previous?.alive && !previous.vehicle &&
      metrics.stage === 'depot-search' && previous.stage === 'depot-search') {
      const dt = (snapshot.tick-previous.tick)/TICK_RATE, seconds = (now-previous.at)/1000;
      const distance = Math.hypot(s.px-previous.x,s.pz-previous.z), speed = Math.hypot(s.vx,s.vz);
      if (dt>0&&dt<=1&&seconds>0&&seconds<=1&&distance<=(Math.max(speed,previous.speed)+20)*dt+3) {
        metrics.depotSearchSeconds += seconds; metrics.depotSearchDistance += distance;
      }
    }
    if (driver) {
      metrics.boardedAtSeconds ??= (now - began) / 1000;
      const boardedAt = began + metrics.boardedAtSeconds * 1000;
      const speed = Math.hypot(s.vx, s.vz); metrics.maxSpeed = Math.max(metrics.maxSpeed, speed);
      const dt = previous ? (snapshot.tick - previous.tick) / TICK_RATE : 0;
      const observedSeconds = previous ? (now - previous.at) / 1000 : 0;
      let validObservation = !previous?.driver;
      if (previous?.driver && previous.vehicleId === s.vehicleId && dt > 0 && dt <= 1 && observedSeconds > 0 && observedSeconds <= 1) {
        const distance = Math.hypot(s.px - previous.x, s.pz - previous.z);
        // Respawn/teleport discontinuities must not count as driving distance.
        if (distance <= (Math.max(speed, previous.speed) + 20) * dt + 3) {
          validObservation = true;
          // Recovery observes the same adjacent authoritative, plausible
          // intervals as coverage; requested throttle/speed grants no progress.
          if(!recovery){
            driveProgress.stalledSeconds+=observedSeconds;
            if(Math.hypot(s.px-driveProgress.x,s.pz-driveProgress.z)>=1.5){
              driveProgress.x=s.px;driveProgress.z=s.pz;driveProgress.stalledSeconds=0;
            }
            if(distance/dt>=4){
              if(!driveProgress.goodSeconds){driveProgress.goodX=previous.x;driveProgress.goodZ=previous.z;}
              driveProgress.goodSeconds+=observedSeconds;
              if(driveProgress.attempts&&driveProgress.goodSeconds>=5&&Math.hypot(s.px-driveProgress.goodX,s.pz-driveProgress.goodZ)>=12){
                metrics.recoverySuccesses++;
                recordRecovery({stage:'resumed-progress',vehicleId:s.vehicleId,attempts:driveProgress.attempts,atSeconds:(now-began)/1000});
                driveProgress.attempts=0;
              }
            }else driveProgress.goodSeconds=0;
          }
          const moving = speed >= 8 && distance / dt >= 8;
          metrics.distance += distance; metrics.driverSeconds += observedSeconds;
          if (moving) metrics.movingSeconds += observedSeconds;
          if (s.boosting) metrics.boostedSeconds += observedSeconds;
          if (speed >= vehicleDefinition(VEHICLE.JEEP).maxSpeed * .9) metrics.cruiseSeconds += observedSeconds;
          // Split boundary-crossing intervals across fixed wall-time minutes.
          // Death, losing the hull and reboarding never restart this clock.
          const start = Math.max(0, (previous.at - boardedAt) / 1000), end = (now - boardedAt) / 1000;
          for (let index = Math.floor(start / 60); index * 60 < end; index++) {
            const seconds = Math.min(end, (index + 1) * 60) - Math.max(start, index * 60);
            const bin = binAt(index); bin.driverSeconds += seconds;
            if (moving) bin.movingSeconds += seconds;
            bin.distance += distance * seconds / observedSeconds;
          }
        } else metrics.discontinuities++;
      }
      if (validObservation) {
        const key = `${Math.floor(s.px / 64)},${Math.floor(s.pz / 64)}`;
        if (!tiles.has(key)) { tiles.add(key); binAt(Math.floor((now - boardedAt) / 60000)).newTerrainTiles64m++; }
      }else if(driveProgress){
        // Gaps and discontinuities earn neither stall time nor success time.
        driveProgress.x=s.px;driveProgress.z=s.pz;driveProgress.stalledSeconds=0;driveProgress.goodSeconds=0;
      }
    }
    previous = { tick: snapshot.tick, at: now, x: s.px, z: s.pz, alive: s.alive, driver, vehicle: s.vehicle,
      vehicleId: s.vehicleId, speed: Math.hypot(s.vx,s.vz), stage: metrics.stage };
  };
  const fire = event => {
    if (finishedAt !== undefined) return;
    const s = browserProbe.latest?.you;
    if (event.shooter === browserProbe.welcome?.yourId && s?.vehicle === VEHICLE.JEEP && (s.seat ?? 0) === 0 &&
      event.weapon === vehicleArmament(VEHICLE.JEEP).primary.id) metrics.ownVehicleShots++;
  };
  const look = async yaw => {
    if (browserState.camera !== lastCamera) { lastCamera = browserState.camera; aimYaw = lastCamera?.yaw; }
    if (!Number.isFinite(aimYaw)) return;
    const delta = wrap(yaw - aimYaw);
    await boundedBrowserWork(page.evaluate(dx => {
      const camera = window.__mmofps?.state?.camera;
      if (!camera || !Number.isFinite(camera.pitch)) throw new Error('Drive look needs an observed camera pitch');
      // Pointer-lock entry can move the mouse vertically. Keep a road-facing
      // view using ordinary look input, including after respawning/reboarding.
      // Correct each rendered observation once: repeated controls during a
      // stalled frame must not accumulate the same stale pitch correction.
      const frame = window.__realtimeFrames?.serial;
      if (!Number.isFinite(frame)) throw new Error('Drive look needs an observed browser frame');
      const movementY = frame === window.__realtimeDriveLookFrame ? 0 : (camera.pitch + .08) / .0022;
      window.__realtimeDriveLookFrame = frame;
      document.dispatchEvent(new MouseEvent('mousemove', { movementX: dx, movementY, bubbles: true }));
    }, -delta / .0022), 'Drive look');
    aimYaw = yaw;
  };
  const boardingFailure = message => new Error(`${message}; ${JSON.stringify({
    position: browserProbe.latest ? { x: browserProbe.latest.you.px, y: browserProbe.latest.you.py, z: browserProbe.latest.you.pz } : undefined,
    vehicles: vehicleEvidence(), depots: depotEvidence(), boardingAttempts: metrics.boardingAttempts,
  })}`);
  const searchDepot = async (s, now) => {
    const frontier = browserProbe.frontier;
    if (!frontier) { metrics.stage = 'await-frontier'; await release(); return; }
    // This is an optimistic straight-line bound, not a path-clearance claim.
    // Initial search never borrows time from beyond the existing 90s deadline.
    const { remaining, distanceBudget } = approachBudget(now);
    if (!depot) {
      const candidates = (frontier.bases ?? []).filter(base => !searchedDepots.has(base.id) &&
        Number.isFinite(base.x+base.y+base.z)).map(base => ({ base, distance: Math.hypot(base.x-s.px,base.z-s.pz) }));
      const reachable = candidates.filter(row => row.distance <= distanceBudget)
        .sort((a,b)=>Number(b.base.owner===frontier.you.faction)-Number(a.base.owner===frontier.you.faction)||a.distance-b.distance);
      if (!reachable.length) {
        const nearest = candidates.sort((a,b)=>a.distance-b.distance)[0];
        throw boardingFailure(nearest
          ? `Driving coverage: no parked jeep and nearest unsearched depot ${nearest.base.name} is ${nearest.distance.toFixed(0)}m away; only ${Math.max(0,remaining).toFixed(1)}s remain (${distanceBudget.toFixed(0)}m optimistic walking budget)`
          : 'Driving coverage: no parked jeep and all published depot search areas have been exhausted');
      }
      const base = reachable[0].base, limit = WORLD.BORDER-100;
      // Bases are only search hints: valid roadside stock may be absent or
      // already crewed, and regional hulls need not be near a base. A short
      // sweep can expose another parked-hull set without assuming a car exists.
      const vicinity = [[160,0],[0,160],[-160,0],[0,-160]].map(([dx,dz])=>({
        x: Math.max(-limit,Math.min(limit,base.x+dx)), z: Math.max(-limit,Math.min(limit,base.z+dz)) }))
        .sort((a,b)=>Math.hypot(a.x-s.px,a.z-s.pz)-Math.hypot(b.x-s.px,b.z-s.pz));
      depot = { base, points: [{ x: base.x, z: base.z },...vicinity], index: 0, progressAt: now, progressDistance: Infinity };
      metrics.depotChanges++; metrics.depotVisits.push({ id: base.id, name: base.name, distance: reachable[0].distance, atSeconds: (now-began)/1000 });
      if (metrics.depotVisits.length>16) metrics.depotVisits.shift();
      sideUntil=0;
    }
    metrics.stage='depot-search';
    let goal=depot.points[depot.index], distance=Math.hypot(goal.x-s.px,goal.z-s.pz);
    if(distance<10){metrics.depotWaypointsReached++;depot.index++;depot.progressAt=now;depot.progressDistance=Infinity;}
    else if(distance<depot.progressDistance-1){depot.progressDistance=distance;depot.progressAt=now;}
    else if(now-depot.progressAt>12000){
      metrics.depotFailures.push({ id: depot.base.id, waypointIndex: depot.index, reason: 'twelve seconds without walking progress', atSeconds: (now-began)/1000 });
      if(metrics.depotFailures.length>16)metrics.depotFailures.shift();
      depot.index++;depot.progressAt=now;depot.progressDistance=Infinity;
    }
    if(depot.index>=depot.points.length){
      searchedDepots.add(depot.base.id);if(searchedDepots.size>64)searchedDepots.delete(searchedDepots.values().next().value);
      depot=undefined;await release();return;
    }
    goal=depot.points[depot.index];distance=Math.hypot(goal.x-s.px,goal.z-s.pz);
    if(distance>distanceBudget) throw boardingFailure(`Driving coverage: next depot search waypoint is ${distance.toFixed(0)}m away; only ${Math.max(0,remaining).toFixed(1)}s remain within the boarding/play deadline`);
    if(now-depot.progressAt>5000&&now>=nextJump){
      await boundedBrowserWork(page.keyboard.press('Space',{delay:80}), 'Depot search jump');sideUntil=now+1000;nextJump=now+5000;
    }
    await look(Math.atan2(-(goal.x-s.px),-(goal.z-s.pz)));
    await setKey('KeyA',now<sideUntil);await setKey('KeyD',false);await setKey('KeyW',true);
  };
  const chooseRoute = async s => {
    const paths = await boundedBrowserWork(page.locator('#frontier-atlas .map-roads path').evaluateAll(nodes => nodes.map(node => node.getAttribute('d') ?? '')), 'Drive atlas paths');
    routeArtworkChecked = browserState.mapArtwork?.ready === true;
    let nearest, nextRoute;
    for (const path of paths) for (const section of path.split(/(?=M)/)) {
      const points = [...section.matchAll(/[ML]\s*(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/g)]
        .map(match => ({ x: (Number(match[1]) / MAP_SIZE - .5) * MAP_SPAN, z: (Number(match[2]) / MAP_SIZE - .5) * MAP_SPAN }));
      for (let i = 1; i < points.length; i++) {
        const a = points[i-1], b = points[i], dx = b.x-a.x, dz = b.z-a.z, length2 = dx*dx+dz*dz;
        if (length2 < 2500) continue;
        const t = Math.max(0,Math.min(1,((s.px-a.x)*dx+(s.pz-a.z)*dz)/length2));
        const entry = { x: a.x+dx*t, z: a.z+dz*t }, distance = Math.hypot(entry.x-s.px,entry.z-s.pz);
        if (distance <= 350 && (!nearest || distance < nearest.distance)) nearest = { points, i, entry, distance };
      }
    }
    if (nearest) {
      const { points, i, entry } = nearest, forward = -Math.sin(s.heading)*(points[i].x-points[i-1].x)-Math.cos(s.heading)*(points[i].z-points[i-1].z) >= 0;
      const ahead = forward ? points.slice(i) : points.slice(0,i).reverse(), route = [entry]; let length = 0;
      for (const p of ahead) {
        const last=route.at(-1),distance=Math.hypot(p.x-last.x,p.z-last.z); if(distance<1)continue;
        const fraction=Math.min(1,(700-length)/distance);route.push({x:last.x+(p.x-last.x)*fraction,z:last.z+(p.z-last.z)*fraction});length+=distance*fraction;
        if(length>=700)break;
      }
      if(length>=200) nextRoute=[...route,...route.slice(1,-1).reverse()];
    }
    if (nextRoute) {
      if (metrics.routeSource?.startsWith('initial-heading')) metrics.routeUpgrades++;
      metrics.route = nextRoute; metrics.routeSource='atlas major-road out-and-back (simplified navigation data)'; routeIndex=0;
    }
    if (!metrics.route.length) {
      // No new world generation: use a bounded loop relative to the hull's
      // actual starting heading. This fallback makes no road-clearance claim.
      const dx=-Math.sin(s.heading),dz=-Math.cos(s.heading),limit=WORLD.BORDER-100;
      metrics.route=[[250,0],[250,180],[0,180],[0,0]].map(([ahead,side])=>({
        x:Math.max(-limit,Math.min(limit,s.px+dx*ahead+dz*side)),z:Math.max(-limit,Math.min(limit,s.pz+dz*ahead-dx*side))}));
      metrics.routeSource='initial-heading loop (atlas road unavailable nearby)';
      routeIndex=0;
    }
    routeHull=s.vehicleId;
  };
  const control = async () => {
    const now=performance.now(),s=browserProbe.latest?.you;if(!s)return;
    if(metrics.boardedAtSeconds===null&&now-began>=90000) throw boardingFailure('Driving coverage: no authoritative jeep driver seat within 90 seconds');
    if(!s.alive){metrics.stage='dead';depot=undefined;await release();return;}
    if(!browserState.locked){
      await release();await page.locator('#c').click({position:{x:viewport.width/2,y:viewport.height/2},timeout:1500}).catch(()=>{});
      browserState.locked=await boundedBrowserWork(page.evaluate(()=>!!document.pointerLockElement), 'Drive pointer lock');if(!browserState.locked)return;
    }
    if(s.vehicle===VEHICLE.JEEP&&(s.seat??0)===0){
      metrics.stage='drive';driveSince??=now;depot=undefined;
      if(now-browserProbe.lastSnapshotAt>1000){await release();return;}
      if(routeHull!==s.vehicleId){metrics.route=[];routeArtworkChecked=false;await chooseRoute(s);}
      else if(!routeArtworkChecked&&browserState.mapArtwork?.ready) await chooseRoute(s);
      let goal=metrics.route[routeIndex];
      if(Math.hypot(goal.x-s.px,goal.z-s.pz)<18){routeIndex=(routeIndex+1)%metrics.route.length;metrics.waypointsReached++;goal=metrics.route[routeIndex];}
      const yaw=Math.atan2(-(goal.x-s.px),-(goal.z-s.pz)),turn=wrap(yaw-s.heading),cycle=(now-driveSince)/1000;
      if(recovery&&now>=recovery.until){
        recordRecovery({stage:'maneuver-ended',vehicleId:s.vehicleId,attempt:recovery.attempt,atSeconds:(now-began)/1000,
          displacement:Math.hypot(s.px-recovery.x,s.pz-recovery.z)});
        recovery=undefined;
        driveProgress.x=s.px;driveProgress.z=s.pz;driveProgress.stalledSeconds=0;driveProgress.goodSeconds=0;
      }
      if(!recovery&&driveProgress?.stalledSeconds>=3.5){
        if(driveProgress.attempts>=3||metrics.recoveryAttempts>=12)
          throw boardingFailure(`Driving coverage: jeep ${s.vehicleId} remains stalled after ${driveProgress.attempts} consecutive / ${metrics.recoveryAttempts} total reverse-turn attempts; waypoint ${routeIndex}; recent recovery ${JSON.stringify(metrics.recoveryEvents.slice(-6))}`);
        const attempt=++driveProgress.attempts;
        metrics.recoveryAttempts++;
        // Keep one requested yaw direction throughout each maneuver. Ground
        // steering reverses while backing, so its key is opposite forward.
        const turnSign=Math.abs(turn)>.15?Math.sign(turn):attempt%2?1:-1;
        recovery={hull:s.vehicleId,attempt,turnSign,x:s.px,z:s.pz,reverseUntil:now+2200,until:now+3600};
        recordRecovery({stage:'started',vehicleId:s.vehicleId,attempt,totalAttempt:metrics.recoveryAttempts,
          atSeconds:(now-began)/1000,x:s.px,y:s.py,z:s.pz,waypointIndex:routeIndex,
          stalledObservedSeconds:driveProgress.stalledSeconds,turnSign,reverseSeconds:2.2,forwardSeconds:1.4});
        driveProgress.goodSeconds=0;
      }
      if(recovery){
        metrics.stage='drive-recovery';
        const reversing=now<recovery.reverseUntil;
        const steering=reversing?-recovery.turnSign:recovery.turnSign;
        await setMouse('left',false);await setMouse('right',false);
        // Release the old throttle before holding its opposite.
        await setKey(reversing?'KeyW':'KeyS',false);await setKey(reversing?'KeyS':'KeyW',true);
        await setKey('KeyA',steering>0);await setKey('KeyD',steering<0);
        await look(s.heading);return;
      }
      await setKey('KeyS',false);await setKey('KeyW',true);await setKey('KeyA',turn>.10);await setKey('KeyD',turn<-.10);
      await look(s.heading+Math.sin(cycle*.4)*.12);
      await setMouse('left',cycle%5<1.2);
      await setMouse('right',Math.abs(turn)<.18&&cycle%10<2.5&&s.boostFuel>.1);
      return;
    }
    await setMouse('left',false);await setMouse('right',false);await setKey('KeyS',false);driveSince=undefined;
    if(s.vehicle){metrics.stage='wrong-seat';abandonTarget('boarded another hull or passenger seat',now);await release();if(now>=nextUse){await boundedBrowserWork(page.keyboard.press('KeyE'), 'Drive leave wrong seat');nextUse=now+1500;}return;}
    metrics.stage='approach';
    // Parked snapshots do not encode faction. E remains the authoritative
    // permission check; receiving a real driver seat is required below.
    for(const [id,until] of retiredTargets) if(until<=now) retiredTargets.delete(id);
    if(target&&(now-progressAt>12000||targetAttempts>=4)) abandonTarget(targetAttempts>=4?'four boarding attempts without a driver seat':'twelve seconds without approach progress',now);
    // A distant hull can be up/down a reachable hillside. Height constrains
    // boarding below, not acquisition across the parked-snapshot interest.
    const parked=(browserProbe.latest.vehicles??[]).filter(v=>v.type===VEHICLE.JEEP&&v.health>0&&
      Number.isFinite(v.x)&&Number.isFinite(v.y)&&Number.isFinite(v.z)&&!retiredTargets.has(v.id));
    const current=parked.find(v=>v.id===target?.id);if(current){target=current;targetSeen=now;}
    if(target&&!current&&now-targetSeen>2500) abandonTarget('parked hull disappeared',now);
    if(!target){
      const { distanceBudget }=approachBudget(now);
      target=parked.filter(v=>!retiredTargets.has(v.id)&&Math.hypot(v.x-s.px,v.z-s.pz)<=Math.max(2.8,distanceBudget))
        .sort((a,b)=>Math.hypot(a.x-s.px,a.z-s.pz)-Math.hypot(b.x-s.px,b.z-s.pz))[0];
      targetSeen=now;targetAttempts=0;progressAt=now;progressDistance=Infinity;if(target)metrics.targetChanges++;
    }
    if(!target){await searchDepot(s,now);return;}
    // Keep an interrupted search resumable without charging its progress
    // deadline while approaching a real, newly observed parked jeep.
    if(depot){depot.progressAt=now;depot.progressDistance=Infinity;}
    const distance=Math.hypot(target.x-s.px,target.z-s.pz);
    if(distance<progressDistance-1){progressDistance=distance;progressAt=now;}
    if(now-progressAt>5000&&now>=nextJump){
      // Jump is held input, unlike E's queued pulse; span several input ticks.
      await boundedBrowserWork(page.keyboard.press('Space',{delay:80}), 'Drive approach jump');sideUntil=now+1000;nextJump=now+5000;
    }
    await look(Math.atan2(-(target.x-s.px),-(target.z-s.pz)));
    await setKey('KeyA',now<sideUntil);await setKey('KeyD',false);await setKey('KeyW',distance>2);
    if(distance<=2.8&&Math.abs(target.y-s.py)<3&&now>=nextUse){await setKey('KeyW',false);await boundedBrowserWork(page.keyboard.press('KeyE'), 'Drive board jeep');metrics.boardingAttempts++;targetAttempts++;nextUse=now+1500;}
  };
  const validate = () => {
    finish();
    const coverage = summary();
    assert.ok(metrics.driverSeconds>=20,'Driving coverage: at least 20 seconds in the authoritative driver seat');
    assert.ok(coverage.driverFraction>=.8,'Driving coverage: at least 80% of post-boarding play in the authoritative driver seat');
    assert.ok(coverage.movingFraction>=.5,'Driving coverage: at least 50% of post-boarding play moving at 8 m/s or faster');
    for (const bin of coverage.minuteBins) if (bin.complete)
      assert.ok(bin.movingSeconds>=20,`Driving coverage: post-boarding minute ${bin.index + 1} has fewer than 20 moving seconds`);
    assert.ok(metrics.distance>=200&&tiles.size>=4,'Driving coverage: at least 200 metres and four 64 m terrain cells');
    assert.ok(metrics.boostedSeconds>=.25&&metrics.maxSpeed>vehicleDefinition(VEHICLE.JEEP).maxSpeed*1.05,'Driving coverage: authoritative boost and speed above ordinary cruise');
    assert.ok(metrics.cruiseSeconds>=5,'Driving coverage: at least five seconds near cruise speed');
    assert.ok(metrics.ownVehicleShots>=3,'Driving coverage: at least three authoritative jeep fire events');
  };
  return{control,observe,fire,summary,release,finish,validate};
};
const browserPlay = async () => {
  const browsers = await import('@playwright/test');
  // Retain a public, fixture-owned process handle even if connect or later
  // renderer work fails; cleanup must never search for browsers by name.
  browserServer = await browsers[browserEngine].launchServer({ host: '127.0.0.1', headless: browserMode === 'headless', args: browserEngine === 'chromium' && process.platform === 'win32'
    ? ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] : [] });
  browserCleanup.pid = browserServer.process().pid;
  browser = await browsers[browserEngine].connect(browserServer.wsEndpoint(), { timeout: 10000 });
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    localStorage.setItem('mmofps-sens', '0.0022');
    // Foreground state is evidence, never an exemption from frame/health gates.
    // Only transitions and three phase snapshots allocate records, not RAF.
    const visibility = window.__realtimeVisibility = { events: [], dropped: 0 };
    visibility.record = reason => {
      const row = { atMs: performance.now(), reason, state: document.visibilityState,
        hidden: document.hidden, hasFocus: document.hasFocus() };
      if (visibility.events.length < 128) visibility.events.push(row); else visibility.dropped++;
      return row;
    };
    visibility.record('startup');
    document.addEventListener('visibilitychange', () => visibility.record('visibilitychange'));
    window.addEventListener('focus', () => visibility.record('focus'));
    window.addEventListener('blur', () => visibility.record('blur'));
    const trace = window.__realtimeFrames = {
      serial: 0,
      period: { count: 0, totalMs: 0, maxMs: 0, over50: 0, over100: 0, over250: 0 },
      longTasks: { count: 0, totalMs: 0, maxMs: 0 },
    };
    let previous;
    const frame = now => {
      trace.serial++;
      if (previous !== undefined) {
        const ms = now - previous, metric = trace.period;
        metric.count++; metric.totalMs += ms; metric.maxMs = Math.max(metric.maxMs, ms);
        if (ms > 50) metric.over50++; if (ms > 100) metric.over100++; if (ms > 250) metric.over250++;
      }
      previous = now; requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    if (PerformanceObserver.supportedEntryTypes.includes('longtask')) new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        trace.longTasks.count++; trace.longTasks.totalMs += entry.duration;
        trace.longTasks.maxMs = Math.max(trace.longTasks.maxMs, entry.duration);
      }
    }).observe({ type: 'longtask', buffered: true });
  });
  browserPage = await context.newPage(); browserPage.setDefaultTimeout(5000);
  browserPage.on('pageerror', error => browserErrors.push(error.message));
  browserPage.on('console', message => { if (message.type() === 'error') browserErrors.push(message.text()); });
  browserPage.on('crash', () => browserErrors.push('Rendering page crashed'));
  browserProbe = { snapshots: 0, sent: 0, lastSnapshotAt: performance.now(), maxSnapshotGapMs: 0, closed: false, sockets: 0 };
  browserPage.on('websocket', socket => {
    if (!socket.url().endsWith('/ws')) return;
    if (++browserProbe.sockets > 1) browserProbe.error = 'Game reconnected during rendering play';
    socket.on('framereceived', frame => { if (typeof frame.payload !== 'string') receive(browserProbe, frame.payload); });
    socket.on('framesent', frame => {
      if (typeof frame.payload === 'string') return;
      try { const reader = new ByteReader(frame.payload); if (reader.u8() === Msg.CInput) browserProbe.sent = Math.max(browserProbe.sent, reader.u32()); }
      catch (error) { browserProbe.error = String(error); }
    });
    socket.on('close', () => { if (!browserClosing) browserProbe.closed = true; });
    socket.on('socketerror', error => { if (!browserClosing) browserProbe.error = String(error); });
  });
  if (browserMode === 'windowed')
    await boundedBrowserWork(browserPage.bringToFront(), 'Browser startup foreground');
  let navigationError;
  browserInitialNavigationPending = true;
  const navigation = browserPage.goto(`http://127.0.0.1:${cluster.port}`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .then(() => { browserInitialNavigationPending = false; }, error => {
      navigationError = error; browserInitialNavigationPending = false;
    });
  const startupUntil = performance.now() + 60_000;
  do {
    await delay(250); await sample('browser-startup');
    if (navigationError) throw navigationError;
    if (browserState?.initialized && browserState.worldPresented) break;
    await delay(750);
  } while (performance.now() < startupUntil);
  await navigation;
  if (navigationError) throw navigationError;
  assert.ok(browserState?.initialized && browserState.worldPresented, 'Rendering browser presents the initialized world within one minute');
  assert.equal(browserState.seed, 1337, 'Fresh rendering identity joins Meridian');
  assert.ok(browserProbe.welcome && browserProbe.latest, 'Rendering browser receives real welcome and snapshots');
  if (browserMode === 'windowed')
    await boundedBrowserWork(browserPage.bringToFront(), 'Browser play foreground');
  browserEnvironment = { version: browser.version(), ...await boundedBrowserWork(browserPage.evaluate(() => {
    const gl = document.querySelector('#c')?.getContext('webgl2');
    const extension = gl?.getExtension('WEBGL_debug_renderer_info');
    return { userAgent: navigator.userAgent, hostname: location.hostname, width: innerWidth, height: innerHeight,
      visibility: window.__realtimeVisibility?.record('play'),
      devicePixelRatio, renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER),
      longTaskObserverSupported: PerformanceObserver.supportedEntryTypes.includes('longtask') };
  }), 'Browser environment read') };
  browserVisibility.play = browserEnvironment.visibility;
  browserProbe.startupMaxSnapshotGapMs = browserProbe.maxSnapshotGapMs;
  browserProbe.maxSnapshotGapMs = 0;
  browserPlaying = true;
  const until = performance.now() + browserSeconds * 1000;
  if (browserActivity === 'drive') {
    driveActivity = createDriveActivity(browserPage);
    driveActivity.observe(browserProbe.latest);
    let nextSample = performance.now();
    do {
      const at = performance.now();
      await driveActivity.control();
      // Steering updates use ordinary controls at 5 Hz. Health/frame reads
      // remain at 1 Hz, with no catch-up burst after a slow read.
      if (performance.now() >= nextSample) {
        nextSample = performance.now() + 1000;
        await sample('browser-play');
      }
      await delay(Math.max(1, Math.min(200 - (performance.now() - at), until - performance.now())));
    } while (performance.now() < until);
    driveActivity.finish();
    await driveActivity.release();
  } else {
    let index = 0;
    do {
      const at = performance.now();
      if (browserState.alive) {
        if (!browserState.locked) await browserPage.locator('#c').click({ position: { x: viewport.width / 2, y: viewport.height / 2 }, timeout: 1500 }).catch(() => {});
        // Ordinary keyboard/mouse handlers drive authoritative movement and
        // client prediction. No camera, actor, map or server state is assigned.
        const sidestep = index % 12 >= 9;
        await browserPage.keyboard[sidestep ? 'up' : 'down']('KeyW');
        await browserPage.keyboard[sidestep && index % 24 < 12 ? 'down' : 'up']('KeyA');
        await browserPage.keyboard[sidestep && index % 24 >= 12 ? 'down' : 'up']('KeyD');
        await browserPage.evaluate(index => document.dispatchEvent(new MouseEvent('mousemove', {
          movementX: index % 24 < 12 ? 10 : -10, movementY: 0, bubbles: true,
        })), index);
        if (index % 10 === 0) await browserPage.keyboard.press('Space');
      }
      await sample('browser-play'); index++;
      await delay(Math.max(1, Math.min(1000 - (performance.now() - at), until - performance.now())));
    } while (performance.now() < until);
  }
  await sample('browser-play');
  driveActivity?.validate();
  // The opaque map reduces scene work. Require recovery while ordinary play
  // is still active, before that quieter phase can conceal a growing backlog.
  const lastPlay = samples.at(-1);
  const priorPlay = [...samples].reverse().find(row => row.phase === 'browser-play' && lastPlay.elapsedMs - row.elapsedMs >= 30_000);
  for (const world of lastPlay.worlds) {
    assert.ok(world.health.clockDebt < 30, `${world.planet}: active play ends with at least half a second of debt`);
    const earlier = priorPlay?.worlds.find(w => w.planet === world.planet);
    if (earlier) assert.ok(world.health.clockDebt <= earlier.health.clockDebt + 15, `${world.planet}: debt grows over the final thirty seconds of active play`);
  }
  assert.equal(browserState.mapArtwork?.ready, true, 'Detailed cartography finishes in its real worker during play');
  assert.equal(browserState.mapArtwork?.failed, false, 'Cartography worker remains healthy');
  // Open the actual map after timing the play phase. Async artwork must retain
  // its dynamic ownership and spawn pins rather than replacing their overlay.
  if (!await browserPage.locator('#frontier-atlas').isVisible()) await browserPage.keyboard.press('KeyG');
  await browserPage.locator('#frontier-atlas').waitFor({ state: 'visible' });
  assert.ok(await browserPage.locator('#frontier-atlas .map-roads').count(), 'Atlas displays the strategic basemap');
  assert.equal(await browserPage.locator('#frontier-atlas .terrain-contours').count(), 0, 'Terrain relief does not obscure the strategic map');
  assert.ok(await browserPage.locator('#frontier-atlas .territory-regions [data-territory]').count(), 'Atlas retains current territory ownership');
  assert.ok(await browserPage.locator('#frontier-atlas .respawn-pin').count(), 'Atlas retains spawn markers');
  await phase('browser-map', 10);
  await browserPage.screenshot({ path: path.join(artifacts, `${label}-browser.png`), timeout: 5000 });
};
try {
  await copySavedWorlds();
  cluster = await startCluster({ dataDir: temporary, port: 0, host: '127.0.0.1', controlHost: '127.0.0.1', controlPort: 0,
    targetPopulation: population, maxPlayers: 64, log: false, entry, clientDir: path.join(root, 'packages/client/dist') });
  began = performance.now();
  for (const worker of cluster.workers.values()) worker.process.once('exit', (code, signal) => {
    if (!closing) exits.push({ planet: worker.planet, pid: worker.process.pid, code, signal, elapsedMs: performance.now() - began });
  });
  const gateway = await fetchHealth(`http://127.0.0.1:${cluster.port}/healthz`);
  assert.equal(gateway.status, 200); assert.equal(gateway.health.worlds.filter(world => world.available).length, PLANETS.length);
  await phase(`${population}-bots`, seconds);
  if (clientSeconds) {
    await connect(); await phase('client', clientSeconds); await sample('client');
    assert.ok(client.snapshots >= clientSeconds * 5, 'Connected player receives frequent full snapshots');
    assert.ok(client.latest.lastSeq >= clientSeconds * 15, 'Real input commands are acknowledged by authoritative snapshots');
    assert.ok(client.maxSnapshotGapMs < 2000, 'No hidden snapshot outage between health samples');
    rawClientResult = probeState(client);
    if (browserSeconds) {
      await disconnectClient();
      // Require ordinary zero-human checks before admitting a new browser identity.
      await phase('between-clients', 2);
    }
  }
  if (browserSeconds) await browserPlay();
  // Include the final sleep interval in the measured run. Old health data
  // must not conceal a last-moment worker exit or client disconnect.
  await sample(browserPlaying ? 'browser-map' : client ? 'client' : `${population}-bots`);
  assert.equal(stoppedBySignal, '', `Fixture interrupted by ${stoppedBySignal}`);
  assert.equal(exits.length, 0, `Worker exited during the fixture: ${JSON.stringify(exits)}`);
  if (client) {
    assert.equal(client.closed, false, 'Synthetic client remains connected through the final boundary');
    assert.equal(client.error, undefined, 'Synthetic client has no final socket/protocol error');
  }
  const last = samples.at(-1);
  for (const world of last.worlds) {
    assert.ok(world.health.clockDebt < 30, `${world.planet}: final debt has not drained below half a second`);
    const earlier = [...samples].reverse().find(row => last.elapsedMs - row.elapsedMs >= 30_000)?.worlds.find(w => w.planet === world.planet);
    if (earlier) assert.ok(world.health.clockDebt <= earlier.health.clockDebt + 15, `${world.planet}: debt is still growing over the final thirty seconds`);
  }
  if (browserProbe) {
    assert.ok(browserProbe.snapshots >= browserSeconds * 5, 'Rendering browser receives frequent full snapshots');
    assert.ok(browserProbe.latest.lastSeq >= browserSeconds * 15, 'Rendering browser movement inputs are acknowledged');
    assert.ok(browserProbe.maxSnapshotGapMs < 2000, 'Rendering browser has no snapshot outage');
    const periods = samples.filter(row => row.phase === 'browser-play').map(row => row.browser?.frames).filter(Boolean);
    const frameCount = periods.reduce((sum, period) => sum + period.count, 0), elapsed = periods.reduce((sum, period) => sum + period.totalMs, 0);
    assert.ok(frameCount / elapsed * 1000 >= 20, 'Rendering play averages at least 20 frames per second');
    assert.ok(periods.every(period => period.maxMs < 2000), 'Rendering play has no two-second frame stall');
  }
} catch (error) { failure = error; }
finally {
  closing = true;
  if (client) { clearInterval(client.timer); client.ws.terminate(); }
  browserClosing = true;
  driveActivity?.finish();
  try { await boundedBrowserWork(driveActivity?.release(), 'Drive cleanup release', 3000); } catch (error) { failure ??= error; }
  if (browserPage) {
    try {
      const visibility = await boundedBrowserWork(browserPage.evaluate(() => {
        const trace = window.__realtimeVisibility;
        return trace ? { final: trace.record('final'), events: trace.events, dropped: trace.dropped } :
          { final: { atMs: performance.now(), state: document.visibilityState,
            hidden: document.hidden, hasFocus: document.hasFocus() }, events: [], dropped: 0 };
      }), 'Browser final visibility read', 1500);
      Object.assign(browserVisibility, visibility);
    } catch (error) { browserVisibility.finalReadError = String(error); }
  }
  if (failure) await boundedBrowserWork(browserPage?.screenshot({ path: path.join(artifacts, `${label}-browser-failure.png`), timeout: 3000 }), 'Failure screenshot', 3500).catch(() => {});
  try { await boundedBrowserWork(browser?.close(), 'Browser client disconnect', 5000); } catch (error) { failure ??= error; }
  if (browserServer) {
    try { await boundedBrowserWork(browserServer.close(), 'Owned browser shutdown', 5000); browserCleanup.stopped = true; }
    catch (error) {
      failure ??= error; browserCleanup.forced = true;
      try { await boundedBrowserWork(browserServer.kill(), 'Owned browser force-stop', 5000); browserCleanup.stopped = true; }
      catch (killError) { failure ??= killError; }
    }
  }
  try { await cluster?.close(); closed = true; }
  catch (error) { failure ??= error; }
  process.off('SIGINT', sigint); process.off('SIGTERM', sigterm);
  await persistSamples();
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir())); assert.ok(path.basename(resolved).startsWith('mmofps-realtime-'));
  await rm(resolved, { recursive: true, force: true });
}
const worlds = PLANETS.map(planet => {
  const rows = samples.flatMap(sample => sample.worlds.filter(w => w.planet === planet.id && w.health));
  const startupRows = samples.filter(sample => ['startup', 'browser-startup'].includes(sample.phase)).flatMap(sample => sample.worlds.filter(w => w.planet === planet.id && w.health));
  const steadyRows = samples.filter(sample => !['startup', 'browser-startup'].includes(sample.phase)).flatMap(sample => sample.worlds.filter(w => w.planet === planet.id && w.health));
  const first = rows[0], last = rows.at(-1), elapsed = first && last ? (last.readAtMs - first.readAtMs) / 1000 : 0;
  return { planet: planet.id, samples: rows.length, pids: [...new Set(rows.map(w => w.pid))], epochs: [...new Set(rows.map(w => w.epoch))],
    observedHz: elapsed > 0 ? (last.health.tick - first.health.tick) / elapsed : undefined,
    startupPeak: Math.max(0, ...startupRows.map(w => w.health.simulation.maxDebt)),
    // The lifetime counter cannot separate a smaller steady spike from a
    // larger startup peak; retain both the sampled phase peak and exact total.
    steadyPeak: Math.max(0, ...steadyRows.map(w => w.health.clockDebt)),
    maxDebt: Math.max(0, ...rows.map(w => w.health.simulation.maxDebt)), finalDebt: last?.health.clockDebt,
    campaign: { phases: [...new Set(rows.map(w => w.health.authority.campaign?.phase).filter(Boolean))],
      destinations: [...new Set(rows.map(w => w.health.authority.campaign?.destination).filter(Boolean))],
      observedArrivals: Math.max(0,...rows.map(w => w.health.authority.campaign?.arrivals ?? 0)) },
    lastSimulation: last?.health.simulation };
});
const browserRows = samples.filter(row => row.browser), playRows = browserRows.filter(row => row.phase === 'browser-play');
const playWorlds = PLANETS.map(planet => {
  const rows = playRows.flatMap(row => row.worlds.filter(w => w.planet === planet.id && w.health));
  const first = rows[0], last = rows.at(-1), seconds = first && last ? (last.readAtMs - first.readAtMs) / 1000 : 0;
  return { planet: planet.id, seconds, observedHz: seconds > 0 ? (last.health.tick - first.health.tick) / seconds : undefined,
    startingDebt: first?.health.clockDebt, finalDebt: last?.health.clockDebt,
    peakDebt: Math.max(0, ...rows.map(row => row.health.clockDebt)) };
});
const frameSummary = rows => {
  const periods = rows.map(row => row.browser.frames).filter(Boolean);
  const frames = periods.reduce((sum, period) => sum + period.count, 0), elapsedMs = periods.reduce((sum, period) => sum + period.totalMs, 0);
  return { frames, elapsedMs, averageFps: elapsedMs ? frames * 1000 / elapsedMs : 0,
    maxFrameMs: Math.max(0, ...periods.map(period => period.maxMs)),
    over50Ms: periods.reduce((sum, period) => sum + period.over50, 0),
    over100Ms: periods.reduce((sum, period) => sum + period.over100, 0),
    over250Ms: periods.reduce((sum, period) => sum + period.over250, 0),
    maxLongTaskMs: Math.max(0, ...rows.map(row => row.browser.longTasks?.maxMs ?? 0)) };
};
function summarizeAdaptivePopulation(samples) {
  return PLANETS.map(({ id: planet }) => {
    const rows = samples.flatMap(sample => sample.worlds.filter(world => world.planet === planet && world.health?.population)
      .map(world => ({ elapsedMs: sample.elapsedMs, phase: sample.phase, ...world.health.population,
        frozen: world.health.authority?.campaign?.frozen ?? 0, clockDebt: world.health.clockDebt })));
    const play = rows.filter(row => row.phase === 'browser-play');
    const range = values => values.length ? { minimum: Math.min(...values), maximum: Math.max(...values) } : null;
    const targetHistory = [], actualChanges = [];
    let previous;
    for (const row of rows) {
      if (!previous || row.target !== previous.target) targetHistory.push({ elapsedMs: row.elapsedMs,
        phase: row.phase, target: row.target, previous: previous?.target ?? null, actual: row.actual,
        bots: row.bots, frozen: row.frozen, reason: row.reason, debt: row.clockDebt, meanTickWorkMs: row.meanTickWorkMs });
      if (previous && row.actual !== previous.actual) actualChanges.push({ elapsedMs: row.elapsedMs,
        phase: row.phase, from: previous.actual, to: row.actual, target: row.target,
        humans: row.actual - row.bots + row.frozen, frozen: row.frozen });
      previous = row;
    }
    return { planet, sampledRows: rows.length, playRows: play.length,
      configuredMinimum: Math.min(population, Math.max(48, Math.ceil(population / 2))), configuredMaximum: population,
      targetRange: range(rows.map(row => row.target)), actualRange: range(rows.map(row => row.actual)),
      playTargetRange: range(play.map(row => row.target)), playActualRange: range(play.map(row => row.actual)), targetHistory,
      observedTargetReductions: targetHistory.filter(row => row.previous !== null && row.target < row.previous).length,
      observedTargetRecoveries: targetHistory.filter(row => row.previous !== null && row.target > row.previous).length,
      actualCountDecreases: actualChanges.filter(row => row.to < row.from).length,
      actualCountIncreases: actualChanges.filter(row => row.to > row.from).length, actualChanges,
      maximumAboveSoftTarget: Math.max(0, ...rows.map(row => row.actual - row.target)),
      deferredSheddingSamples: rows.filter(row => row.actual > row.target).length,
      maximumFrozenTransfers: Math.max(0, ...rows.map(row => row.frozen)),
      final: previous ? { target: previous.target, actual: previous.actual, bots: previous.bots, frozen: previous.frozen } : null,
      limitation: 'Health is sampled at1Hz; count changes include admission, travel and retirement. They do not identify individual removals or prove recovery unless a target rise was observed.' };
  });
}
const result = { passed: !failure, populationMode: 'adaptive',
  populationBounds: { minimum: Math.min(population, Math.max(48, Math.ceil(population / 2))), maximum: population },
  populationEvidence: summarizeAdaptivePopulation(samples), population, requestedBotSeconds: seconds, startupSeconds, requestedClientSeconds: clientSeconds,
  requestedBrowserSeconds: browserSeconds, serverEntry: path.relative(root, entry), copiedData, samples: samples.length,
  steadyPeakSampling: '1 Hz current debt; maxDebt retains the exact lifetime peak',
  serverStopped: closed, browserCleanup: browserServer ? browserCleanup : undefined, exits, worlds, client: rawClientResult ?? probeState(client),
  browser: browserProbe ? { engine: browserEngine, mode: browserMode, activity: browserActivity, activityCoverage: driveActivity?.summary(),
    viewport, environment: browserEnvironment, visibility: browserVisibility, identity: 'fresh isolated session',
    network: probeState(browserProbe), startupMaxSnapshotGapMs: browserProbe.startupMaxSnapshotGapMs, errors: browserErrors,
    startup: frameSummary(browserRows.filter(row => row.phase === 'browser-startup')),
    play: { ...frameSummary(playRows), worlds: playWorlds }, map: frameSummary(browserRows.filter(row => row.phase === 'browser-map')),
    positionSamples: playRows.map(row => ({ seconds: row.elapsedMs / 1000, alive: row.browser.alive, pos: row.browser.pos })) } : undefined,
  error: failure ? { message: String(failure), stack: failure.stack } : undefined };
await writeFile(path.join(artifacts, `${label}.json`), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
if (failure) process.exitCode = 1;
