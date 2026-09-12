// World scout: scans a seed for notable terrain, biomes, cave entrances, and
// generated sites. It prints copyable fixed-camera spectate URLs, or a
// machine-readable witness manifest with --json.
//
// Usage: node scripts/scout.mjs [seed] [--json]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let seedArg = '1337';
let haveSeed = false;
let json = false;
for (const arg of process.argv.slice(2)) {
  if (arg === '--json') {
    json = true;
  } else if (arg.startsWith('--') || haveSeed) {
    console.error('Usage: node scripts/scout.mjs [seed] [--json]');
    process.exit(1);
  } else {
    seedArg = arg;
    haveSeed = true;
  }
}
const seed = Number(seedArg);
if (!Number.isInteger(seed) || !Number.isFinite(seed)) {
  console.error(`Invalid world seed: ${seedArg}`);
  process.exit(1);
}

const code = `
import { World, cavePathPoint } from '@shared/worldgen';
import { WORLD } from '@shared/constants';

// With tsx -e, arguments after the source begin at process.argv[1].
const seed = Number(process.argv[1]);
const outputJson = process.argv[2] === 'json';
const w = new World(seed);
const SCAN_MAX = Math.min(6500, WORLD.BORDER - 128);
const SCAN_MIN = -SCAN_MAX;
const SCAN_STEP = 80;

let peak = { h: -Infinity, x: 0, z: 0 };
let hills = null;
let flat = null;
let desert = null;
let snow = null;
let lush = null;

for (let ix = 0, x = SCAN_MIN; x <= SCAN_MAX; ix++, x += SCAN_STEP) {
  for (let iz = 0, z = SCAN_MIN; z <= SCAN_MAX; iz++, z += SCAN_STEP) {
    const c = w.column(x, z);
    if (c.h > peak.h) peak = { h: c.h, x, z };
    if (!desert || c.desert > desert.score) {
      desert = { x, z, h: c.h, score: c.desert };
    }
    const snowScore = (0.34 - c.temp) + Math.max(0, c.h - 25) * 0.004;
    if (c.temp < 0.34 && c.h > 25 && (!snow || snowScore > snow.score)) {
      snow = { x, z, h: c.h, score: snowScore };
    }
    const lushScore = c.moist - Math.abs(c.temp - 0.53) * 0.65 - c.desert;
    if (c.moist > 0.6 && c.desert < 0.1 && (!lush || lushScore > lush.score)) {
      lush = { x, z, h: c.h, score: lushScore };
    }

    // A coarser sub-grid keeps the scan quick while finding useful broad
    // landscape witnesses rather than one noisy height sample.
    if ((ix & 3) === 0 && (iz & 3) === 0) {
      const hs = [];
      for (const dx of [-60, 0, 60]) {
        for (const dz of [-60, 0, 60]) hs.push(w.column(x + dx, z + dz).h);
      }
      const relief = Math.max(...hs) - Math.min(...hs);
      if (!hills || relief > hills.relief) hills = { x, z, h: c.h, relief };
      if (c.entr < 0.5 && c.h > -20 && c.h < 90 &&
          (!flat || relief < flat.relief)) {
        flat = { x, z, h: c.h, relief };
      }
    }
  }
}

// Region margins can return a neighboring site from more than one query.
// Stable coordinate keys turn those overlapping results into unique sites.
const structureNames = ['bunker', 'courtyard', 'hangar', 'relay'];
const sitesByPosition = new Map();
const SITE_SCAN_TILE = 256;
for (let minX = SCAN_MIN; minX <= SCAN_MAX && sitesByPosition.size < 4;
     minX += SITE_SCAN_TILE) {
  for (let minZ = SCAN_MIN; minZ <= SCAN_MAX && sitesByPosition.size < 4;
       minZ += SITE_SCAN_TILE) {
    const r = w.collectRegion(
      minX, Math.min(SCAN_MAX, minX + SITE_SCAN_TILE),
      minZ, Math.min(SCAN_MAX, minZ + SITE_SCAN_TILE),
    );
    const generated = Array.isArray(r.sites) && r.sites.length > 0
      ? r.sites.map((site) => ({
          x: site.x,
          z: site.z,
          h: site.top,
          kind: structureNames[site.kind] ?? \`kind-\${site.kind}\`,
        }))
      : r.pads.map((pad) => ({
          x: pad.x,
          z: pad.z,
          h: pad.y + pad.hy,
          kind: 'structure',
        }));
    for (const site of generated) {
      const key = \`\${site.x.toFixed(4)},\${site.z.toFixed(4)}\`;
      if (!sitesByPosition.has(key)) {
        sitesByPosition.set(key, site);
      }
      if (sitesByPosition.size >= 4) break;
    }
  }
}

const cleanSite = (site, cameraLift = 26) => {
  if (!site) return null;
  const x = Math.round(site.x);
  const z = Math.round(site.z);
  const h = Math.round(site.h);
  const y = Math.round(site.h + cameraLift);
  const out = {
    x, y, z, h,
    url: \`http://localhost:8080/?spectate=\${x},\${y},\${z}&spin=0&clean=1\`,
  };
  if (site.kind) out.kind = site.kind;
  if (Number.isFinite(site.relief)) out.relief = Math.round(site.relief * 10) / 10;
  return out;
};

// Explicit galleries replace the old broad shaft mask. Put cameras at
// walking height on the actual graded route and aim through its arch.
const cave = w.collectCaveSites(SCAN_MIN, SCAN_MAX, SCAN_MIN, SCAN_MAX)
  .sort((a, b) => a.x * a.x + a.z * a.z - b.x * b.x - b.z * b.z)[0];
const caveView = (forward, targetForward) => {
  if (!cave) return null;
  const point = cavePathPoint(cave, forward);
  const target = cavePathPoint(cave, targetForward);
  const round = (value) => Math.round(value * 1000) / 1000;
  const x = round(point.x), z = round(point.z), y = round(point.y + 1.8);
  const dx = target.x - point.x, dz = target.z - point.z;
  const yaw = round(Math.atan2(-dx, -dz));
  const pitch = round(Math.atan2(target.y + 1.8 - y, Math.hypot(dx, dz)));
  return {
    x, y, z, h: round(point.y), yaw, pitch,
    url: \`http://localhost:8080/?spectate=\${x},\${y},\${z}&yaw=\${yaw}&pitch=\${pitch}&spin=0&clean=1\`,
  };
};

const landscapeView = (point, target) => {
  const round = (value) => Math.round(value * 1000) / 1000;
  const x = round(point.x), y = round(point.y), z = round(point.z);
  const dx = target.x - x, dz = target.z - z;
  const yaw = round(Math.atan2(-dx, -dz));
  const pitch = round(Math.atan2(target.y - y, Math.hypot(dx, dz)));
  return { x, y, z, h: round(w.terrainHeight(x, z)), yaw, pitch,
    url: \`http://localhost:8080/?spectate=\${x},\${y},\${z}&yaw=\${yaw}&pitch=\${pitch}&spin=0&clean=1\` };
};
const mountain = w.collectMountains(-1024, 1024, -1024, 1024)
  .sort((a, b) => a.x * a.x + a.z * a.z - b.x * b.x - b.z * b.z)[0];
const mountainTarget = { x: mountain.x, z: mountain.z, y: w.terrainHeight(mountain.x, mountain.z) - 25 };
const mountainX = mountain.x + mountain.dx * (mountain.length + 100) - mountain.dz * 90;
const mountainZ = mountain.z + mountain.dz * (mountain.length + 100) + mountain.dx * 90;
const mountainCamera = { x: mountainX, z: mountainZ, y: w.groundY(mountainX, mountainZ) + 25 };
const roadSegments = w.collectRoadSegments(-1024, 1024, -1024, 1024);
const switchbacks = roadSegments.filter((segment) => segment.id === \`trail:\${mountain.ix},\${mountain.iz}\`);
const trailPoint = switchbacks[2].b;
const trailCamera = { x: trailPoint.x - mountain.dz * 65, z: trailPoint.z + mountain.dx * 65,
  y: trailPoint.y + 36 };
trailCamera.y = Math.max(trailCamera.y, w.groundY(trailCamera.x, trailCamera.z) + 15);

const manifest = {
  seed,
  scan: { min: SCAN_MIN, max: SCAN_MAX, step: SCAN_STEP },
  sites: {
    peak: cleanSite(peak),
    massif: landscapeView(mountainCamera, mountainTarget),
    switchbacks: landscapeView(trailCamera, switchbacks[4].b),
    hills: cleanSite(hills),
    flat: cleanSite(flat),
    desert: desert && desert.score > 0.5 ? cleanSite(desert) : null,
    snow: cleanSite(snow),
    lush: cleanSite(lush),
    entrance: cave ? caveView(Math.max(4, cave.mouthLength - 12), cave.mouthLength + 14) : null,
    caveChamber: cave ? caveView(cave.length - 12, cave.length + 8) : null,
    caveExit: cave ? caveView(cave.mouthLength + 6, cave.mouthLength - 20) : null,
    structures: [...sitesByPosition.values()].map((site) => cleanSite(site, 22)),
  },
};

if (outputJson) {
  console.log(JSON.stringify(manifest, null, 2));
} else {
  const printSite = (label, site, suffix = '') => {
    if (!site) {
      console.log(label.padEnd(12), 'none');
      return;
    }
    console.log(label.padEnd(12), \`\${site.x},\${site.z}  h=\${site.h}m\${suffix}\`);
    console.log(' '.repeat(12), site.url);
  };
  console.log(\`seed \${seed}\`);
  printSite('peak', manifest.sites.peak);
  printSite('massif', manifest.sites.massif);
  printSite('switchbacks', manifest.sites.switchbacks);
  printSite('hills', manifest.sites.hills,
    manifest.sites.hills ? \`  relief=\${manifest.sites.hills.relief}m/120m\` : '');
  printSite('flat-ish', manifest.sites.flat,
    manifest.sites.flat ? \`  relief=\${manifest.sites.flat.relief}m/120m\` : '');
  printSite('desert', manifest.sites.desert);
  printSite('snow', manifest.sites.snow);
  printSite('lush', manifest.sites.lush);
  printSite('entrance', manifest.sites.entrance);
  printSite('chamber', manifest.sites.caveChamber);
  printSite('cave exit', manifest.sites.caveExit);
  if (manifest.sites.structures.length === 0) {
    printSite('structures', null);
  } else {
    manifest.sites.structures.forEach((site, i) =>
      printSite(site.kind ?? \`structure \${i + 1}\`, site));
  }
}
`;

const res = spawnSync(
  process.execPath,
  [tsx, '-e', code, String(seed), json ? 'json' : 'text'],
  { cwd: root, encoding: 'utf8' },
);
if (res.error) throw res.error;
process.stdout.write(res.stdout);
process.stderr.write(res.stderr);
if (res.status !== 0) process.exitCode = res.status ?? 1;
