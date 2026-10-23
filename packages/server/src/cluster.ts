import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLANETS, type PlanetId } from '@shared/universe';
import { Coordinator, NODE_TIMEOUT_MS } from './coordinator.js';
import { startControlPlane } from './control-plane.js';
import { startGateway } from './gateway.js';
import { WorldStore } from './persistence.js';
import { DEFAULT_TARGET_POPULATION, defaultClientDir } from './server.js';

interface ClusterOptions {
  port?: number; host?: string; dataDir?: string; clientDir?: string;
  maxPlayers?: number; targetPopulation?: number; log?: boolean;
  localPlanets?: PlanetId[];
  controlHost?: string; controlPort?: number; controlSecret?: string;
  /** Explicit entry point is useful to process supervisors and test fixtures. */
  entry?: string;
}
interface Worker { planet: PlanetId; process: ChildProcess; port: number }

/** V8 options for every world process. A 64 MiB young generation absorbs the
 * full-population allocation rate. TurboFan's default inlining budget runs out
 * inside the deep world-field queries (sdf -> column -> noise), leaving hot
 * helpers as real calls that box their double arguments and results; a larger
 * budget keeps them inline. These change speed only, never simulation results
 * (docs/PERFORMANCE.md). Start external `MMOFPS_ROLE=world` workers with them too. */
const WORLD_V8_OPTIONS = [
  '--max-semi-space-size=64',
  '--max-inlined-bytecode-size-cumulative=11040',
  '--max-inlined-bytecode-size-absolute=22080',
] as const;

/** A local deployment has exactly the same HTTP/WS boundaries as remote world
 * workers. Each planet has its own process, simulation, bots and world store. */
export async function startCluster(options: ClusterOptions = {}) {
  const dataDir = path.resolve(options.dataDir ?? 'data');
  const coordinator = new Coordinator(path.join(dataDir, 'universe.sqlite'));
  const secret = options.controlSecret ?? randomBytes(32).toString('hex');
  const control = await startControlPlane(coordinator, secret, { legacy: new WorldStore(path.join(dataDir, 'meridian')), host: options.controlHost, port: options.controlPort });
  const controlHost = options.controlHost && !['0.0.0.0', '::'].includes(options.controlHost) ? options.controlHost : '127.0.0.1';
  const localControlHost = controlHost.includes(':') ? `[${controlHost}]` : controlHost;
  const entry = options.entry ?? (typeof __filename !== 'undefined' ? __filename : fileURLToPath(new URL('./main.ts', import.meta.url)));
  const workers = new Map<PlanetId, Worker>(), children = new Set<ChildProcess>();
  const restarts = new Set<ReturnType<typeof setTimeout>>();
  let stopping = false;
  let gateway: Awaited<ReturnType<typeof startGateway>> | undefined;
  let closing: Promise<void> | null = null;
  const stopWorker = async (child: ChildProcess): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timeout = setTimeout(() => child.kill(), 8000);
      child.once('exit', () => { clearTimeout(timeout); resolve(); });
      if (child.connected) child.send({ type: 'shutdown' }, () => {}); else child.kill();
    });
  };
  const close = (): Promise<void> => closing ??= (async () => {
    stopping = true;
    for (const timer of restarts) clearTimeout(timer);
    await gateway?.close();
    await Promise.all([...children].map(stopWorker));
    await control.close(); coordinator.close();
  })();
  const launch = async (planet: typeof PLANETS[number]): Promise<Worker> => {
    if (stopping) throw new Error('Cluster is stopping');
    const child = fork(entry, [], {
      execArgv: ['--experimental-sqlite', ...WORLD_V8_OPTIONS, ...(entry.endsWith('.ts') ? ['--import', 'tsx'] : [])],
      stdio: ['ignore', options.log === false ? 'ignore' : 'inherit', 'pipe', 'ipc'],
      env: { ...process.env, MMOFPS_ROLE: 'world', PLANET_ID: planet.id,
        WORLD_NODE_ID: `${planet.id}:${randomUUID()}`, COORDINATOR_URL: `http://${localControlHost}:${control.port}`,
        COORDINATOR_SECRET: secret, NODE_ADVERTISE: '', PORT: '0', HOST: '127.0.0.1',
        DATA_DIR: path.join(dataDir, planet.id), CLIENT_DIR: options.clientDir ?? defaultClientDir(),
        MAX_PLAYERS: String(options.maxPlayers ?? 64), BOTS: String(options.targetPopulation ?? DEFAULT_TARGET_POPULATION), NODE_LOG: options.log === false ? '0' : '1' },
    });
    children.add(child);
    child.once('exit', () => children.delete(child));
    let errors = '';
    child.stderr?.on('data', chunk => { errors = (errors + String(chunk)).slice(-2000); if (options.log !== false) process.stderr.write(chunk); });
    const worker = await new Promise<Worker>((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error(`${planet.name} startup timed out: ${errors}`)); }, 30_000);
      const failed = (error: Error) => { clearTimeout(timeout); reject(error); };
      child.once('error', failed);
      child.once('exit', code => failed(new Error(`${planet.name} exited (${code}): ${errors}`)));
      child.on('message', message => {
        const ready = message as { type?: string; port?: number };
        if (ready.type === 'ready' && Number.isInteger(ready.port)) {
          clearTimeout(timeout); resolve({ planet: planet.id, process: child, port: ready.port! });
        }
      });
    });
    workers.set(planet.id, worker);
    child.once('exit', () => {
      children.delete(child);
      if (workers.get(planet.id) === worker) workers.delete(planet.id);
      if (stopping) return;
      if (options.log !== false) console.error(`${new Date().toISOString()} ${planet.name} worker stopped; restarting after its authority expires.`);
      schedule(planet);
    });
    return worker;
  };
  const schedule = (planet: typeof PLANETS[number]): void => {
    if (stopping) return;
    const timer = setTimeout(() => {
      restarts.delete(timer);
      void launch(planet).catch(error => { if (!stopping) { console.error(error.message); schedule(planet); } });
    }, NODE_TIMEOUT_MS + 1000);
    restarts.add(timer);
  };
  try {
    // Starting sequentially keeps first boot's procedural generation from
    // monopolizing a small home server, while normal play runs in parallel.
    for (const planet of PLANETS) if (!options.localPlanets || options.localPlanets.includes(planet.id)) await launch(planet);
    gateway = await startGateway(coordinator, { port: options.port ?? 8080, host: options.host ?? '0.0.0.0',
      clientDir: options.clientDir ?? defaultClientDir(), secret });
    if (options.log !== false) console.log(`THE MMOFPS on http://localhost:${gateway.port} — ${workers.size} persistent worlds`);
    return { port: gateway.port, controlPort: control.port, coordinator, workers, close };
  } catch (error) { await close(); throw error; }
}
