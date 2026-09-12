import { readdirSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Cross-platform test runner: finds packages/*/test/*.test.ts and runs them
// through tsx + the built-in node:test runner.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
for (const pkg of readdirSync(path.join(root, 'packages'))) {
  const dir = path.join(root, 'packages', pkg, 'test');
  if (!existsSync(dir)) continue;
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.test.ts')) files.push(path.join(dir, f));
  }
}

if (files.length === 0) {
  console.error('no test files found');
  process.exit(1);
}

const child = spawn(process.execPath, ['--experimental-sqlite', '--import', 'tsx', '--test', '--test-concurrency=' + (process.env.TEST_CONCURRENCY || '3'), ...files], {
  stdio: 'inherit',
  cwd: root,
  env: process.env,
});
child.on('exit', (code) => process.exit(code ?? 1));
