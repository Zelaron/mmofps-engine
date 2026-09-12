import { DatabaseSync } from 'node:sqlite';
import { cpus, freemem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

// Finite, read-only development monitor for the local universe. It follows
// worker replacements through the directory and records raw samples so a
// final healthy response cannot conceal an outage or an authority restart.
const seconds = Number(process.argv[2] ?? 300), label = process.argv[3] ?? 'universe-soak';
assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 1800);
assert.match(label, /^[a-z0-9][a-z0-9-]{0,63}$/);
await mkdir('artifacts', { recursive: true });
const db = new DatabaseSync('data/universe.sqlite', { readOnly: true });
const statement = db.prepare('SELECT planet,region,epoch,url FROM world_authorities ORDER BY planet,region');
const cpu = () => cpus().reduce((total, core) => {
  total.idle += core.times.idle;
  total.all += Object.values(core.times).reduce((a, b) => a + b, 0); return total;
}, { idle: 0, all: 0 });
let previous = cpu();
const samples = [], began = performance.now();
try {
  while (performance.now() - began < seconds * 1000) {
    const at = performance.now(), current = cpu(), delta = current.all - previous.all;
    const hostBusy = delta > 0 ? 1 - (current.idle - previous.idle) / delta : 0; previous = current;
    const worlds = await Promise.all(statement.all().map(async row => {
      const start = performance.now(), url = new URL('/healthz', row.url.replace('ws:', 'http:'));
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return { ...row, error: 'nonlocal worker omitted' };
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        const health = await response.json();
        return { ...row, responseMs: performance.now() - start, status: response.status, health };
      } catch (error) { return { ...row, responseMs: performance.now() - start, error: String(error) }; }
    }));
    samples.push({ at: new Date().toISOString(), elapsedMs: at - began, hostBusy, freeMemoryMB: freemem() / 1024 ** 2, worlds });
    if (samples.length % 30 === 0) {
      await writeFile(`artifacts/${label}-samples.json`, JSON.stringify(samples, null, 2));
      console.log(JSON.stringify({ samples: samples.length, hostBusy, worlds: worlds.map(w => ({ planet: w.planet, epoch: w.epoch,
        ready: w.health?.ok, debt: w.health?.clockDebt, error: w.error })) }));
    }
    await new Promise(resolve => setTimeout(resolve, Math.max(1, 1000 - (performance.now() - at))));
  }
} finally { db.close(); }
const worlds = [];
for (const planet of new Set(samples.flatMap(s => s.worlds.map(w => w.planet)))) {
  const rows = samples.flatMap(s => s.worlds.filter(w => w.planet === planet));
  const debt = rows.map(w => w.health?.clockDebt).filter(Number.isFinite).sort((a, b) => a - b);
  const valid = rows.filter(w => w.health?.simulation), last = valid.at(-1);
  worlds.push({ planet, samples: rows.length, ready: rows.filter(w => w.health?.ok).length,
    epochs: [...new Set(rows.map(w => w.epoch))], maxDebt: debt.at(-1), p95Debt: debt[Math.floor(debt.length * .95)],
    maxTimerOvershootMs: Math.max(0, ...valid.map(w => w.health.simulation.maxTimerOvershootMs)),
    maxBatchMs: Math.max(0, ...valid.map(w => w.health.simulation.maxBatchMs)), lastSimulation: last?.health.simulation });
}
const summary = { beganAt: samples[0]?.at, seconds, samples: samples.length,
  maxHostBusy: Math.max(...samples.map(s => s.hostBusy)), worlds };
await writeFile(`artifacts/${label}-samples.json`, JSON.stringify(samples, null, 2));
await writeFile(`artifacts/${label}.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
