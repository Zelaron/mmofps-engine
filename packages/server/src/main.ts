import { DEFAULT_TARGET_POPULATION, startServer } from './server.js';
import { startCluster } from './cluster.js';
import { planetById, type PlanetId } from '@shared/universe';

// Process entry point. Configuration via environment:
//   PORT        listen port                     (default 8080)
//   HOST        bind address                    (default 0.0.0.0)
//   SEED        world seed                      (default 1337)
//   BOTS        target arena population         (default 15)
//   MAX_PLAYERS max concurrent connections      (default 64)
//   CLIENT_DIR  override path to built client

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function main(): Promise<void> {
  const common = {
    port: envInt('PORT', 8080),
    host: process.env.HOST || '0.0.0.0',
    targetPopulation: envInt('BOTS', DEFAULT_TARGET_POPULATION),
    maxPlayers: envInt('MAX_PLAYERS', 64),
    clientDir: process.env.CLIENT_DIR || undefined,
    log: process.env.NODE_LOG !== '0',
  };
  const role = process.env.MMOFPS_ROLE ?? 'cluster';
  if (!['cluster', 'world', 'single'].includes(role)) throw new Error('MMOFPS_ROLE must be cluster, world or single');
  const localPlanets = process.env.LOCAL_PLANETS === undefined ? undefined : process.env.LOCAL_PLANETS.split(',').filter(Boolean);
  if (localPlanets?.some(p => !planetById(p))) throw new Error('LOCAL_PLANETS contains an unknown planet');
  if (role === 'cluster' && process.env.COORDINATOR_HOST && !['127.0.0.1', '::1', 'localhost'].includes(process.env.COORDINATOR_HOST) && !process.env.COORDINATOR_SECRET) throw new Error('A configured COORDINATOR_SECRET is required on a private network interface');
  const planet = planetById(process.env.PLANET_ID ?? 'meridian');
  if (!planet) throw new Error('Unknown PLANET_ID');
  if (role === 'world' && (!process.env.COORDINATOR_URL || !process.env.COORDINATOR_SECRET || !process.env.WORLD_NODE_ID)) throw new Error('World workers require a coordinator URL, secret and unique node ID');
  const running = role === 'cluster' ? await startCluster({ ...common, dataDir: process.env.DATA_DIR || 'data', localPlanets: localPlanets as PlanetId[] | undefined,
      controlHost: process.env.COORDINATOR_HOST, controlPort: envInt('COORDINATOR_PORT', 0), controlSecret: process.env.COORDINATOR_SECRET })
    : await startServer({ ...common, onFailure: error => { console.error('World failed:', error.message); process.exit(1); }, seed: role === 'world' ? planet.seed : envInt('SEED', 1337),
      dataDir: process.env.DATA_DIR || `data/${planet.id}`,
      node: role === 'world' ? { planet: planet.id, url: process.env.COORDINATOR_URL!, secret: process.env.COORDINATOR_SECRET!,
        id: process.env.WORLD_NODE_ID!, advertise: process.env.NODE_ADVERTISE || undefined } : undefined });
  process.send?.({ type: 'ready', port: running.port });
  let closing = false;
  const shutdown = (): void => {
    if (closing) return; closing = true;
    void running.close().then(() => process.exit(0), error => { console.error('Shutdown:', error); process.exit(1); });
    setTimeout(() => process.exit(1), 12_000).unref();
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, shutdown);
  process.on('message', message => { if ((message as { type?: string }).type === 'shutdown') shutdown(); });
  // A crashed parent must not leave orphaned authorities running indefinitely.
  if (process.connected) process.on('disconnect', shutdown);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
