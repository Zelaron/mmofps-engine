/** Touch capability is also opt-in for desktop/mobile browser testing. */
export function isTouchDevice(): boolean {
  if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('touch') === '1') return true;
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export function isLocalWorldHost(): boolean {
  const hostname = typeof location !== 'undefined' ? location.hostname?.toLowerCase() ?? '' : '';
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
}

/** Leave CPU time for the three planetary simulations when playing on their
 * host. Background generation targets one quarter of a worker's time; urgent
 * terrain coverage retains its shorter deadline. This is the compatibility
 * rest for workers that have not already paced their canonical work slices. */
export function workerJobRestMs(workMs: unknown, urgentCoverage = false): number {
  if (!isLocalWorldHost() || typeof workMs !== 'number' || !Number.isFinite(workMs)) return 0;
  return Math.min(urgentCoverage ? 250 : 750, Math.max(0, workMs) * (urgentCoverage ? 1 : 3));
}

function terrainWorkers(touch: boolean): number {
  const local = isLocalWorldHost();
  const concurrency = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  // Larger local desktops can keep two paced terrain jobs in flight so fast
  // ground travel does not wait for one column to finish before starting the next.
  const localMaximum = !touch && typeof concurrency === 'number' &&
    Number.isFinite(concurrency) && concurrency >= 12 ? 2 : 1;
  const maximum = local ? localMaximum : touch ? 2 : 4;
  if (concurrency === undefined || !Number.isFinite(concurrency) || concurrency < 1) return maximum;
  // Reserve browser/scenery work on remote hosts, or the browser and three
  // planetary loops when playing locally. Reported concurrency is a logical
  // count; do not assume any particular physical-core/SMT relationship.
  const reserved = local ? 4 : 2;
  return Math.min(maximum, Math.max(1, Math.floor(concurrency) - reserved));
}

export function renderProfile(touch = isTouchDevice()) {
  const workers = terrainWorkers(touch);
  return touch
    ? { touch: true, nearChunks: 5, farRadius: 2800, fogFar: 2500, workers, pixelBudget: 1_000_000, maxPixelRatio: 1.25 }
    : { touch: false, nearChunks: 7, farRadius: 4800, fogFar: 4600, workers, pixelBudget: 2_500_000, maxPixelRatio: 1.5 };
}
