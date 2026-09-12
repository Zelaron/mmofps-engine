import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Versioned Google Fonts URLs and hashes preserve the original game assets.
// The font binaries are a local cache; attribution and licenses remain in Git.
const assets = [
  { name: 'barlow.ttf', url: 'https://fonts.gstatic.com/s/barlow/v13/7cHpv4kjgoGqM7EPCw.ttf',
    sha256: 'a35caa4687f434d66453c1fe423d7074cfa9fd7ab80c19b0780f3862887d2fc9' },
  { name: 'barlow-condensed.ttf', url: 'https://fonts.gstatic.com/s/barlowcondensed/v13/HTxwL3I-JCGChYJ8VI-L6OO_au7B4873_3E.ttf',
    sha256: '0d85af813fc3ed87db0c6265515689b2eef5cbaf7aab17922528dfc95a2cd73f' },
];
const directory = fileURLToPath(new URL('../packages/client/public/fonts/', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export async function ensureAssets() {
  await mkdir(directory, { recursive: true });
  for (const asset of assets) {
    const file = path.join(directory, asset.name);
    try { if (hash(await readFile(file)) === asset.sha256) continue; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Downloading ${asset.name}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== asset.sha256) throw new Error(`Checksum mismatch for ${asset.name}`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx' });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }); }
    console.log(`Downloaded ${asset.name} (${bytes.length} bytes, SHA-256 verified)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await ensureAssets();
