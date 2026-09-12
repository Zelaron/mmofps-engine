import { startServer, type ServerOptions, type RunningServer } from '../src/server.js';

/** Tests need direct access to actors, so these worlds share one JS thread.
 * Finish all synchronous terrain generation before issuing any clock leases.
 * Production worlds have separate processes and do not need this barrier. */
export async function startWorldFixtures(options: ServerOptions[]): Promise<RunningServer[]> {
  let prepared = 0, release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const jobs = options.map(option => startServer({ ...option, beforeSimulationStart: async () => {
    if (++prepared === options.length) release();
    await barrier;
  } }).catch(error => { release(); throw error; }));
  const results = await Promise.allSettled(jobs);
  const worlds = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') { await Promise.all(worlds.map(world => world.close())); throw failed.reason; }
  return worlds;
}
