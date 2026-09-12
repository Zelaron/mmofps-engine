import { build } from 'esbuild';
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ensureAssets } from './fetch-assets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsconfig = path.join(root, 'tsconfig.json');

export const clientOptions = {
  entryPoints: [path.join(root, 'packages/client/src/main.ts')],
  outfile: path.join(root, 'packages/client/dist/app.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  sourcemap: true,
  tsconfig,
  logLevel: 'info',
};

export const workerOptions = {
  entryPoints: [path.join(root, 'packages/client/src/render/mesher.worker.ts')],
  outfile: path.join(root, 'packages/client/dist/mesher.worker.js'),
  bundle: true,
  format: 'iife',
  target: ['es2020'],
  sourcemap: true,
  tsconfig,
  logLevel: 'info',
};

export const encounterWorkerOptions = {
  ...workerOptions,
  entryPoints: [path.join(root, 'packages/client/src/render/encounters.worker.ts')],
  outfile: path.join(root, 'packages/client/dist/encounters.worker.js'),
};

export const sceneryWorkerOptions = {
  ...workerOptions,
  entryPoints: [path.join(root, 'packages/client/src/render/scenery.worker.ts')],
  outfile: path.join(root, 'packages/client/dist/scenery.worker.js'),
};

export const serverOptions = {
  entryPoints: [path.join(root, 'packages/server/src/main.ts')],
  outfile: path.join(root, 'packages/server/dist/server.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: ['node22'],
  sourcemap: true,
  tsconfig,
  logLevel: 'info',
  external: ['bufferutil', 'utf-8-validate'], // optional ws accelerators
  // server.ts references import.meta.url only on the tsx/ESM dev path; the
  // cjs bundle always takes the __dirname branch, so the warning is noise.
  logOverride: { 'empty-import-meta': 'silent' },
};

export function copyStatic() {
  mkdirSync(path.join(root, 'packages/client/dist'), { recursive: true });
  cpSync(path.join(root, 'packages/client/index.html'), path.join(root, 'packages/client/dist/index.html'));
  cpSync(path.join(root, 'packages/client/public'), path.join(root, 'packages/client/dist'), { recursive: true });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await ensureAssets();
  const minify = !process.argv.includes('--no-minify');
  await Promise.all([
    build({ ...clientOptions, minify }),
    build({ ...workerOptions, minify }),
    build({ ...encounterWorkerOptions, minify }),
    build({ ...sceneryWorkerOptions, minify }),
    build({ ...serverOptions }),
  ]);
  copyStatic();
  let compressed = 0;
  function compress(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { compress(file); continue; }
      if (!/\.(js|css|html|ttf|svg|json)$/.test(entry.name)) continue;
      const bytes = readFileSync(file);
      const br = brotliCompressSync(bytes, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } });
      writeFileSync(file + '.br', br); writeFileSync(file + '.gz', gzipSync(bytes));
      compressed += br.length;
    }
  }
  compress(path.join(root, 'packages/client/dist'));
  console.log(`All client scripts, fonts, HTML and CSS: ${Math.round(compressed / 1024)} KiB Brotli`);
  console.log('build complete');
}
