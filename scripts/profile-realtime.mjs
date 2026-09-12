import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), at = args.indexOf('--label');
const label = at < 0 ? 'realtime-profile' : args[at + 1];
if (!label || label.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(label)) throw new Error('Invalid realtime profile label');
const output = path.join(root, 'artifacts', `${label}.runner.mjs`);
await mkdir(path.dirname(output), { recursive: true });
await build({ entryPoints: [path.join(root, 'scripts/realtime-profile.ts')], outfile: output,
  bundle: true, platform: 'node', format: 'esm', target: ['node22'], sourcemap: true,
  tsconfig: path.join(root, 'tsconfig.json'), external: ['ws', 'bufferutil', 'utf-8-validate'] });
const child = spawn(process.execPath, ['--experimental-sqlite', output, ...args],
  { cwd: root, stdio: 'inherit', windowsHide: true });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
