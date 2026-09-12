import { build } from 'esbuild';
import { clientOptions } from './build.mjs';
import { readFile, writeFile, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { brotliCompressSync, gzipSync, constants } from 'node:zlib';
import path from 'node:path';
import assert from 'node:assert/strict';

// A controlled startup comparison across a wire-version change: retain the
// archived foreground-generation entry point, but use the current protocol,
// connection lifecycle and all other current modules on both sides.
const [reference, destination] = process.argv.slice(2);
assert.ok(reference && destination, 'Usage: node scripts/build-startup-baseline.mjs <archived-client-dir> <artifact-output-dir>');
const root = path.resolve('artifacts'), out = path.resolve(destination), relative = path.relative(root, out);
assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Output must be a named artifacts subdirectory');
const archivedMap = await readFile(path.join(reference, 'app.js.map'));
const map = JSON.parse(archivedMap), index = map.sources.findIndex(source =>
  source === '../src/main.ts' || source.replaceAll('\\', '/').endsWith('/packages/client/src/main.ts'));
assert.ok(index >= 0, 'Archived client entry source is required');
const entry = map.sourcesContent[index];
assert.ok(entry.includes('new EncounterStream(world.seed, generateTeleporters(world))'), 'Reference must retain the old foreground search');
await cp('packages/client/dist', out, { recursive: true });
await build({ ...clientOptions, outfile: path.join(out, 'app.js'), minify: true, plugins: [{
  name: 'archived-startup-entry', setup(builder) {
    builder.onLoad({ filter: /[\\/]packages[\\/]client[\\/]src[\\/]main\.ts$/ }, args => ({
      contents: entry, loader: 'ts', resolveDir: path.dirname(args.path),
    }));
  },
}] });
const app = await readFile(path.join(out, 'app.js'));
await writeFile(path.join(out, 'app.js.br'), brotliCompressSync(app, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }));
await writeFile(path.join(out, 'app.js.gz'), gzipSync(app));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
await writeFile(path.join(out, 'baseline.json'), JSON.stringify({ at: new Date().toISOString(), reference,
  archivedMapHash: hash(archivedMap), archivedMainHash: hash(entry), appHash: hash(app),
  scope: 'Archived main.ts with foreground base-pad generation; all dependencies, including protocol and connection fencing, are from the current worktree. Other client assets are copied from the current build.' }, null, 2));
console.log(`Startup baseline written to ${destination}`);
