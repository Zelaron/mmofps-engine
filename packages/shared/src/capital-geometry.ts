import type { Box } from './worldgen.js';
import type { CityDistrict, CityLiftSite, CityVehicleSite, CityRewardSite } from './cities.js';

export interface CapitalPoint { x: number; y: number; z: number; radius: number }
export interface CapitalSweep {
  id: number; kind: 'spire' | 'rib' | 'arch' | 'dome';
  points: CapitalPoint[]; color: number; accent: number;
}
export interface CapitalPlan {
  solids: Box[]; sweeps: CapitalSweep[]; lifts: CityLiftSite[];
  vehicles: CityVehicleSite[]; rewards: CityRewardSite[];
}
export interface CapitalSegment { a: CapitalPoint; b: CapitalPoint }
export const CAPITAL_SKY_HEIGHT = 1900;

/** An organic perimeter, shared by grading, vegetation exclusion and mood. */
export function capitalBoundary(city: CityDistrict, x: number, z: number): number {
  if (!city.theme) return Math.max(Math.abs(x - city.x), Math.abs(z - city.z)) - city.radius;
  const dx = x - city.x, dz = z - city.z, angle = Math.atan2(dz, dx);
  const radius = city.radius * (.94 + .055 * Math.sin(angle * 3 + .6) + .035 * Math.cos(angle * 5));
  return Math.hypot(dx, dz) - radius;
}

/** Conservative tapered capsule field; curved monumental shells use these
 * segments, while every accessible landing and bridge has exact box cover. */
export function capitalSegmentDistance(s: CapitalSegment, x: number, y: number, z: number): number {
  const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y, dz = s.b.z - s.a.z;
  const length2 = dx * dx + dy * dy + dz * dz;
  const t = Math.max(0, Math.min(1, ((x - s.a.x) * dx + (y - s.a.y) * dy + (z - s.a.z) * dz) / Math.max(.001, length2)));
  const radius = s.a.radius + (s.b.radius - s.a.radius) * t;
  return (Math.hypot(x - s.a.x - dx * t, y - s.a.y - dy * t, z - s.a.z - dz * t) - radius) /
    (1 + Math.abs(s.b.radius - s.a.radius) / Math.sqrt(Math.max(.001, length2)));
}

interface PreparedSegment {
  segment: CapitalSegment; dx: number; dy: number; dz: number; inverseLength2: number; dr: number; inverseSlope: number; slope: number;
  minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number;
}
interface CapitalQueryIndex {
  bounds: PreparedSegment[]; cells: Map<string, PreparedSegment[]>;
  ix: number; iy: number; iz: number; last: PreparedSegment[];
}
const spatialSlices = new WeakMap<CapitalSegment[], CapitalQueryIndex>();
/** Physics probes cluster in the same tiny street or lift volume. A cached
 * XYZ bin excludes distant facades as well as high crowns, and a last-cell
 * memo avoids allocating keys for each capsule boundary sample. */
export function capitalDistance(segments: CapitalSegment[], x: number, y: number, z: number, distance: number): number {
  let index = spatialSlices.get(segments);
  if (!index) {
    const bounds = segments.map(segment => {
      const { a, b } = segment, dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
      const length2 = Math.max(.001, dx * dx + dy * dy + dz * dz), dr = b.radius - a.radius, r = Math.max(a.radius, b.radius);
      const slope = 1 + Math.abs(dr) / Math.sqrt(length2);
      return { segment, dx, dy, dz, inverseLength2: 1 / length2, dr, slope, inverseSlope: 1 / slope,
        minX: Math.min(a.x, b.x) - r, maxX: Math.max(a.x, b.x) + r,
        minY: Math.min(a.y, b.y) - r, maxY: Math.max(a.y, b.y) + r,
        minZ: Math.min(a.z, b.z) - r, maxZ: Math.max(a.z, b.z) + r };
    });
    index = { bounds, cells: new Map(), ix: NaN, iy: NaN, iz: NaN, last: [] };
    spatialSlices.set(segments, index);
  }
  const ix = Math.floor(x / 64), iy = Math.floor(y / 64), iz = Math.floor(z / 64);
  let candidates = index.last;
  if (index.ix !== ix || index.iy !== iy || index.iz !== iz) {
    const key = `${ix},${iy},${iz}`;
    candidates = index.cells.get(key)!;
    if (!candidates) {
      candidates = index.bounds.filter(s => {
        const apron = 64 * s.slope;
        return s.maxX + apron >= ix * 64 && s.minX - apron <= (ix + 1) * 64 &&
          s.maxY + apron >= iy * 64 && s.minY - apron <= (iy + 1) * 64 && s.maxZ + apron >= iz * 64 && s.minZ - apron <= (iz + 1) * 64;
      });
      if (index.cells.size >= 128) index.cells.delete(index.cells.keys().next().value!);
      index.cells.set(key, candidates);
    }
    index.ix = ix; index.iy = iy; index.iz = iz; index.last = candidates;
  }
  let d = Math.min(distance, 64);
  for (const s of candidates) {
    // The field normalizes by the taper's slope. Convert the current field
    // bound back to geometric distance before rejecting its bounding box.
    const r = Math.max(0, d) * s.slope;
    if (x < s.minX - r || x > s.maxX + r || y < s.minY - r || y > s.maxY + r || z < s.minZ - r || z > s.maxZ + r) continue;
    const a = s.segment.a, ax = x - a.x, ay = y - a.y, az = z - a.z;
    const t = Math.max(0, Math.min(1, (ax * s.dx + ay * s.dy + az * s.dz) * s.inverseLength2));
    const px = ax - s.dx * t, py = ay - s.dy * t, pz = az - s.dz * t;
    d = Math.min(d, (Math.sqrt(px * px + py * py + pz * pz) - a.radius - s.dr * t) * s.inverseSlope);
  }
  return d;
}

const indexes = new WeakMap<CapitalPlan, Map<string, CapitalSegment[]>>();
/** A fixed 256m index avoids traversing the entire skyline during physics. */
export function capitalSegments(plan: CapitalPlan, minX: number, maxX: number, minZ: number, maxZ: number): CapitalSegment[] {
  let index = indexes.get(plan);
  if (!index) {
    index = new Map();
    for (const sweep of plan.sweeps) for (let i = 1; i < sweep.points.length; i++) {
      const a = sweep.points[i - 1], b = sweep.points[i];
      const length = Math.sqrt(Math.max(.001, (b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2));
      const r = Math.max(a.radius, b.radius) + Math.max(96, 64 * (1 + Math.abs(b.radius - a.radius) / length));
      const segment = { a, b };
      for (let iz = Math.floor((Math.min(a.z, b.z) - r) / 256); iz <= Math.floor((Math.max(a.z, b.z) + r) / 256); iz++)
        for (let ix = Math.floor((Math.min(a.x, b.x) - r) / 256); ix <= Math.floor((Math.max(a.x, b.x) + r) / 256); ix++) {
          const key = `${ix},${iz}`;
          if (!index.has(key)) index.set(key, []);
          index.get(key)!.push(segment);
        }
    }
    indexes.set(plan, index);
  }
  const out = new Set<CapitalSegment>();
  for (let iz = Math.floor(minZ / 256); iz <= Math.floor(maxZ / 256); iz++)
    for (let ix = Math.floor(minX / 256); ix <= Math.floor(maxX / 256); ix++)
      for (const segment of index.get(`${ix},${iz}`) ?? []) out.add(segment);
  return [...out];
}
