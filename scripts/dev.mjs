import { context } from 'esbuild';
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { clientOptions, workerOptions, encounterWorkerOptions, sceneryWorkerOptions, serverOptions, copyStatic } from './build.mjs';
import { ensureAssets } from './fetch-assets.mjs';

// Dev mode: esbuild watch-rebuilds the client, workers and server; the server runs from
// its bundle under `node --watch`, restarting automatically on change.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

await ensureAssets();
const ctxs = await Promise.all([
  context({ ...clientOptions, minify: false }),
  context({ ...workerOptions, minify: false }),
  context({ ...encounterWorkerOptions, minify: false }),
  context({ ...sceneryWorkerOptions, minify: false }),
  context({ ...serverOptions }),
]);

// Initial build, then watch.
await Promise.all(ctxs.map((c) => c.rebuild()));
copyStatic();
await Promise.all(ctxs.map((c) => c.watch()));

watch(path.join(root, 'packages/client/index.html'), () => {
  try { copyStatic(); console.log('index.html copied'); } catch { /* mid-save */ }
});
watch(path.join(root, 'packages/client/public'), { recursive: true }, () => {
  try { copyStatic(); } catch { /* editor is still saving */ }
});

const child = spawn(
  process.execPath,
  ['--experimental-sqlite', '--watch', path.join(root, 'packages/server/dist/server.cjs')],
  { stdio: 'inherit', env: process.env },
);

const shutdown = async () => {
  child.kill();
  await Promise.all(ctxs.map((c) => c.dispose()));
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('dev mode: watching. Open http://localhost:8080 (PORT env to change)');
