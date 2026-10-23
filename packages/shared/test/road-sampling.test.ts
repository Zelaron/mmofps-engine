import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Landscape, type RoadSample, type RoadSegment } from '@shared/landscape';
import { World } from '@shared/worldgen';
import { clamp, lerp, smoothstep } from '@shared/math';

// Frozen pre-acceleration evaluator: exact comparison protects terrain height,
// lane choice and normals, including roads with no remaining grading weight.
function originalRoadAt(segments: readonly RoadSegment[], x: number, z: number,
  naturalHeight?: number): RoadSample | undefined {
  let result: RoadSample | undefined;
  let best = Infinity;
  let sumWeight = 0, sumHeight = 0, gradeWeight = 0;
  let dramatic = false, corridorLow = -Infinity, corridorHigh = Infinity;
  for (const segment of segments) {
    const dx = segment.b.x - segment.a.x, dz = segment.b.z - segment.a.z;
    const length2 = dx * dx + dz * dz;
    const t = clamp(((x - segment.a.x) * dx + (z - segment.a.z) * dz) / length2, 0, 1);
    const distance = Math.hypot(x - lerp(segment.a.x, segment.b.x, t), z - lerp(segment.a.z, segment.b.z, t));
    if (distance > (segment.dramatic ? 180 : 90)) continue;
    const height = lerp(segment.a.y, segment.b.y, t);
    dramatic ||= !!segment.dramatic;
    if (segment.dramatic) {
      const bank = Math.max(0, distance - segment.width) * 1.45;
      corridorLow = Math.max(corridorLow, height - bank);
      corridorHigh = Math.min(corridorHigh, height + bank);
    }
    const shoulder = segment.dramatic ? 56 : Math.min(82, (segment.trail ? 16 : 26) + Math.abs(height - (naturalHeight ?? height)) * 1.2);
    const influence = smoothstep(segment.width + shoulder, segment.width, distance);
    const edgeDistance = Math.max(0, distance - segment.width);
    const falloff = 1 + edgeDistance * edgeDistance;
    const weight = segment.dramatic ? influence / (1 + edgeDistance * edgeDistance * .05)
      : influence / falloff * Math.min(1, Math.sqrt(length2) / 24);
    if (!segment.dramatic) {
      sumWeight += weight;
      sumHeight += height * weight;
      gradeWeight = Math.max(gradeWeight, influence);
    }
    if (distance - segment.width >= best) continue;
    best = distance - segment.width;
    const length = Math.sqrt(length2);
    result = { distance, height, width: segment.width,
      trail: segment.trail, dx: dx / length, dz: dz / length, gradeWeight: 0 };
  }
  if (result) {
    result.height = sumWeight > 0 ? sumHeight / sumWeight : result.height;
    result.gradeWeight = gradeWeight;
    if (dramatic && naturalHeight !== undefined) {
      const baseline = lerp(naturalHeight, result.height, result.gradeWeight);
      result.height = corridorLow <= corridorHigh ? clamp(baseline, corridorLow, corridorHigh) : (corridorLow + corridorHigh) * .5;
      result.gradeWeight = 1;
    }
  }
  return result;
}

class FixtureLandscape extends Landscape {
  constructor(private readonly roads: RoadSegment[]) { super(1, () => 0, () => ({ h: 0, volc: 0 })); }
  override collectRoads(): RoadSegment[] { return this.roads; }
}

function compare(landscape: Landscape, segments: readonly RoadSegment[], x: number, z: number,
  naturalHeight?: number): void {
  assert.deepEqual(landscape.roadAt(x, z, naturalHeight), originalRoadAt(segments, x, z, naturalHeight),
    `road sample changed at ${x},${z}, natural height ${naturalHeight}`);
}

test('road acceleration preserves cutoff endpoints, zero-weight roads, ties and overlapping grades exactly', () => {
  const road = (z: number, y: number, dramatic = false): RoadSegment => ({
    a: { x: -256, z, y }, b: { x: 256, z, y: y + 8 }, width: dramatic ? 2.7 : 5.8,
    trail: dramatic, dramatic, id: `${z}:${y}`,
  });
  const first = road(-20, 10), second = road(20, 40);
  for (const roads of [[first], [first, second], [second, first],
    [road(0, 50, true)], [first, road(35, 110, true), second, road(-5, 80, true)]]) {
    const landscape = new FixtureLandscape(roads);
    for (const segment of roads) {
      const reach = segment.dramatic ? 180 : 90;
      for (const endpoint of [-256, 0, 256]) for (const distance of [0, 30, 80, reach - 1e-10, reach, reach + 1e-10]) {
        for (const sign of [-1, 1]) for (const naturalHeight of [undefined, -300, 0, 200]) {
          compare(landscape, roads, endpoint, segment.a.z + distance * sign, naturalHeight);
          compare(landscape, roads, endpoint + distance * sign, segment.a.z, naturalHeight);
        }
      }
    }
    for (const boundary of [-128, -96, -32, 0, 32, 96, 128]) for (const x of [boundary - 1e-10, boundary, boundary + 1e-10]) {
      for (const naturalHeight of [undefined, -100, 100]) compare(landscape, roads, x, 0, naturalHeight);
    }
  }
  const sparse = new FixtureLandscape([road(0, 10)]);
  assert.equal(sparse.roadAt(0, 80)?.gradeWeight, 0, 'zero-weight nearby roads still supply their lane distance and height');
  assert.equal(sparse.roadAt(0, 90)?.distance, 90, 'the exact cutoff remains inclusive');
  assert.equal(sparse.roadAt(0, 90 + 1e-10), undefined);
  const low = road(-80, 10), high = road(80, 40);
  const forward = new FixtureLandscape([low, high]), reverse = new FixtureLandscape([high, low]);
  compare(forward, [low, high], 0, 0); compare(reverse, [high, low], 0, 0);
  assert.notEqual(forward.roadAt(0, 0)?.height, reverse.roadAt(0, 0)?.height,
    'fixture needs an observable tie break when grading is absent');
});

test('native curved roads, city grids and dramatic switchbacks retain bit-exact samples across tile boundaries', () => {
  for (const seed of [1337, 7331, 20077]) {
    const world = new World(seed);
    // Use the actual world's natural-height callbacks and generated topology.
    const landscape = (world as unknown as { landscape: Landscape }).landscape;
    const city = world.collectCities().find(c => !c.theme)!;
    const mountain = world.collectMountains(-2048, 1024, -2048, 1024).find(m => m.dramatic)!;
    assert.ok(city && mountain);
    const generated = [
      ...world.collectRoadSegments(-128, 128, -128, 128),
      ...world.collectRoadSegments(city.x - 128, city.x + 128, city.z - 128, city.z + 128),
      ...world.collectRoadSegments(mountain.x - 160, mountain.x + 160, mountain.z - 160, mountain.z + 160),
    ];
    const families = [generated.filter(s => !s.trail && !s.id.startsWith('city')),
      generated.filter(s => s.id.startsWith('city')), generated.filter(s => s.dramatic)];
    const originalTiles = new Map<string, RoadSegment[]>();
    const check = (x: number, z: number, naturalHeight?: number) => {
      const ix = Math.floor(x / 128), iz = Math.floor(z / 128), key = `${ix},${iz}`;
      let segments = originalTiles.get(key);
      if (!segments) {
        segments = landscape.collectRoads(ix * 128, (ix + 1) * 128, iz * 128, (iz + 1) * 128);
        originalTiles.set(key, segments);
      }
      compare(landscape, segments, x, z, naturalHeight);
    };
    for (const family of families) {
      assert.ok(family.length > 0, `seed ${seed} must exercise every road family`);
      const stride = Math.max(1, Math.floor(family.length / 12));
      for (let i = 0; i < family.length; i += stride) {
        const s = family[i], dx = s.b.x - s.a.x, dz = s.b.z - s.a.z, length = Math.hypot(dx, dz);
        const reach = s.dramatic ? 180 : 90;
        for (const t of [0, .37, 1]) for (const offset of [0, s.width + 30, -reach, reach - 1e-8, reach + 1e-8]) {
          const x = lerp(s.a.x, s.b.x, t) - dz / length * offset;
          const z = lerp(s.a.z, s.b.z, t) + dx / length * offset;
          for (const naturalHeight of [undefined, s.a.y - 120, s.a.y, s.a.y + 120]) check(x, z, naturalHeight);
          for (const side of [-1e-8, 0, 1e-8]) check(Math.floor(x / 128) * 128 + side, z, s.a.y);
        }
      }
    }
  }
});
