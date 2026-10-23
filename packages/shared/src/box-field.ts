import type { Box } from './worldgen.js';

interface Node extends Box { left?: Node; right?: Node; start: number; count: number }
const cache = new WeakMap<readonly Box[], SolidBoxIndex>();

// The largest signed axis distance is a conservative box bound. It is exact
// inside a box and never exceeds its Euclidean distance outside. Internal
// traversal can therefore reject distant branches without square roots;
// leaves still evaluate the original exact signed-distance primitive.
function lowerBound(b: Box, x: number, y: number, z: number, limit: number): number {
  const dx = Math.abs(x - b.x) - b.hx;
  if (dx >= limit) return Infinity;
  const dy = Math.abs(y - b.y) - b.hy;
  if (dy >= limit) return Infinity;
  const dz = Math.abs(z - b.z) - b.hz;
  if (dz >= limit) return Infinity;
  return Math.max(dx, dy, dz);
}

const CELL_SIZE = 4, CELL_CAP = 2, CELL_CAPACITY = 64, CELL_MAX_CANDIDATES = 128;

function axisOutsideCell(center: number, half: number, lo: number, hi: number): number {
  return Math.max(lo - center, center - hi, 0) - half;
}

/** Exact minimum distance to a box union. Bounding volumes only reject
 * pieces whose signed distance cannot improve the current field value. */
export class SolidBoxIndex {
  private readonly root: Node;
  private static readonly originalVisit = SolidBoxIndex.prototype.visit;
  // Cache possible leaf offsets, never a field value. Ownership and lifetime
  // follow this immutable index; dense cells keep the original traversal.
  private readonly cells = new Map<string, Uint32Array | null>();
  private cellSafe = false;
  private cellMargin = 0;
  private cellX = NaN;
  private cellY = NaN;
  private cellZ = NaN;
  private lastCandidates: Uint32Array | null | undefined;
  // Immutable geometry comes from several generators with different object
  // layouts. Keep the hot leaf walk in one contiguous double-precision store.
  private readonly bounds: Float64Array;
  private cursor = 0;
  readonly count: number;
  boxTests = 0;
  constructor(boxes: readonly Box[]) {
    this.count = boxes.length;
    this.bounds = new Float64Array(boxes.length * 6);
    this.root = this.build([...boxes]);
    let scale = 1;
    this.cellSafe = boxes.every(b => [b.x, b.y, b.z, b.hx, b.hy, b.hz]
      .every(v => Number.isFinite(v) && Math.abs(v) <= 1e12) && b.hx >= 0 && b.hy >= 0 && b.hz >= 0);
    if (this.cellSafe) for (const value of this.bounds) scale = Math.max(scale, Math.abs(value));
    this.cellMargin = scale * Number.EPSILON * 32;
  }

  distance(x: number, y: number, z: number, best = Infinity): number {
    this.boxTests = 0;
    if (lowerBound(this.root, x, y, z, best) >= best) return best;
    if (!this.cellSafe || this.visit !== SolidBoxIndex.originalVisit || !Number.isFinite(best) || best > CELL_CAP ||
        !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) > 1e12) {
      return this.visit(this.root, x, y, z, best);
    }
    const cx = Math.floor(x / CELL_SIZE), cy = Math.floor(y / CELL_SIZE), cz = Math.floor(z / CELL_SIZE);
    let offsets: Uint32Array | null | undefined;
    if (cx === this.cellX && cy === this.cellY && cz === this.cellZ) {
      offsets = this.lastCandidates;
    } else {
      const key = cx + ',' + cy + ',' + cz;
      offsets = this.cells.get(key);
      if (offsets === undefined) {
        const margin = Math.max(this.cellMargin, Math.max(1, Math.abs(x), Math.abs(y), Math.abs(z)) * Number.EPSILON * 32);
        const x0 = cx * CELL_SIZE - margin, x1 = (cx + 1) * CELL_SIZE + margin;
        const y0 = cy * CELL_SIZE - margin, y1 = (cy + 1) * CELL_SIZE + margin;
        const z0 = cz * CELL_SIZE - margin, z1 = (cz + 1) * CELL_SIZE + margin;
        const found: number[] = [], bounds = this.bounds;
        const collect = (node: Node): void => {
          if (found.length > CELL_MAX_CANDIDATES) return;
          // A rejected signed axis bound exceeds the cap everywhere in the
          // closed, padded cell. Containing boxes remain candidates even
          // when the incoming best is negative. Only search bounds expand.
          if (axisOutsideCell(node.x, node.hx, x0, x1) > CELL_CAP ||
              axisOutsideCell(node.y, node.hy, y0, y1) > CELL_CAP ||
              axisOutsideCell(node.z, node.hz, z0, z1) > CELL_CAP) return;
          if (node.left) { collect(node.left); collect(node.right!); return; }
          for (let i = node.start, end = i + node.count * 6; i < end; i += 6) {
            if (axisOutsideCell(bounds[i], bounds[i + 3], x0, x1) > CELL_CAP ||
                axisOutsideCell(bounds[i + 1], bounds[i + 4], y0, y1) > CELL_CAP ||
                axisOutsideCell(bounds[i + 2], bounds[i + 5], z0, z1) > CELL_CAP) continue;
            found.push(i);
            if (found.length > CELL_MAX_CANDIDATES) return;
          }
        };
        collect(this.root);
        offsets = found.length > CELL_MAX_CANDIDATES ? null : new Uint32Array(found);
        if (this.cells.size === CELL_CAPACITY) {
          const oldest = this.cells.keys().next().value!;
          this.cells.delete(oldest);
        }
        this.cells.set(key, offsets);
      }
      this.cellX = cx; this.cellY = cy; this.cellZ = cz; this.lastCandidates = offsets;
    }
    if (offsets === null) return this.visit(this.root, x, y, z, best);
    const bounds = this.bounds;
    for (const i of offsets!) {
      // Every query still applies the original exact signed-axis pruning and
      // primitive arithmetic to its current best; the candidate set is only
      // a replacement for repeated hierarchy traversal.
      const dx = Math.abs(x - bounds[i]) - bounds[i + 3];
      if (dx >= best) continue;
      const dy = Math.abs(y - bounds[i + 1]) - bounds[i + 4];
      if (dy >= best) continue;
      const dz = Math.abs(z - bounds[i + 2]) - bounds[i + 5];
      if (dz >= best) continue;
      this.boxTests++;
      const ox = dx > 0 ? dx : 0, oy = dy > 0 ? dy : 0, oz = dz > 0 ? dz : 0;
      const outside = Math.sqrt(ox * ox + oy * oy + oz * oz), inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
      const d = outside + inside;
      if (d < best) best = d;
    }
    return best;
  }

  private visit(node: Node, x: number, y: number, z: number, best: number): number {
    if (!node.left) {
      const bounds = this.bounds, end = node.start + node.count * 6;
      for (let i = node.start; i < end; i += 6) {
        // A leaf groups nearby pieces, not necessarily pieces touching this
        // query. Apply the same conservative bound to each box before the
        // exact primitive; thin walls and decks otherwise pay for all eight.
        const dx = Math.abs(x - bounds[i]) - bounds[i + 3];
        if (dx >= best) continue;
        const dy = Math.abs(y - bounds[i + 1]) - bounds[i + 4];
        if (dy >= best) continue;
        const dz = Math.abs(z - bounds[i + 2]) - bounds[i + 5];
        if (dz >= best) continue;
        this.boxTests++;
        // Reuse the exact signed axis distances already required for the
        // broad phase; this is sdBox's original arithmetic and evaluation order.
        const ox = dx > 0 ? dx : 0, oy = dy > 0 ? dy : 0, oz = dz > 0 ? dz : 0;
        const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
        const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
        const d = outside + inside;
        if (d < best) best = d;
      }
      return best;
    }
    const a = node.left!, b = node.right!;
    const da = lowerBound(a, x, y, z, best);
    const db = lowerBound(b, x, y, z, best);
    if (da < db) {
      if (da < best) best = this.visit(a,x,y,z,best);
      if (db < best) best = this.visit(b,x,y,z,best);
    } else {
      if (db < best) best = this.visit(b,x,y,z,best);
      if (da < best) best = this.visit(a,x,y,z,best);
    }
    return best;
  }

  private build(boxes: Box[]): Node {
    let x0=Infinity,y0=Infinity,z0=Infinity,x1=-Infinity,y1=-Infinity,z1=-Infinity;
    let cx0=Infinity,cy0=Infinity,cz0=Infinity,cx1=-Infinity,cy1=-Infinity,cz1=-Infinity;
    for (const b of boxes) {
      x0=Math.min(x0,b.x-b.hx);x1=Math.max(x1,b.x+b.hx);
      y0=Math.min(y0,b.y-b.hy);y1=Math.max(y1,b.y+b.hy);
      z0=Math.min(z0,b.z-b.hz);z1=Math.max(z1,b.z+b.hz);
      cx0=Math.min(cx0,b.x);cx1=Math.max(cx1,b.x);
      cy0=Math.min(cy0,b.y);cy1=Math.max(cy1,b.y);
      cz0=Math.min(cz0,b.z);cz1=Math.max(cz1,b.z);
    }
    // Centre/extent reconstruction can round a hierarchy box inward. Allow
    // for those floating-point operations at this world's coordinate scale;
    // the actual solid bounds below retain every original double unchanged.
    const ex = Math.max(1, Math.abs(x0), Math.abs(x1)) * Number.EPSILON * 8;
    const ey = Math.max(1, Math.abs(y0), Math.abs(y1)) * Number.EPSILON * 8;
    const ez = Math.max(1, Math.abs(z0), Math.abs(z1)) * Number.EPSILON * 8;
    const node: Node = { x:(x0+x1)/2,y:(y0+y1)/2,z:(z0+z1)/2,
      hx:(x1-x0)/2+ex,hy:(y1-y0)/2+ey,hz:(z1-z0)/2+ez, start: this.cursor, count: 0 };
    if (boxes.length <= 8) {
      node.count = boxes.length;
      for (const b of boxes) {
        this.bounds[this.cursor++] = b.x; this.bounds[this.cursor++] = b.y; this.bounds[this.cursor++] = b.z;
        this.bounds[this.cursor++] = b.hx; this.bounds[this.cursor++] = b.hy; this.bounds[this.cursor++] = b.hz;
      }
      return node;
    }
    const axis = cx1-cx0 >= cy1-cy0 && cx1-cx0 >= cz1-cz0 ? 'x' : cy1-cy0 >= cz1-cz0 ? 'y' : 'z';
    boxes.sort((a,b)=>a[axis]-b[axis]);
    const mid=boxes.length>>1;
    node.left=this.build(boxes.slice(0,mid));node.right=this.build(boxes.slice(mid));
    return node;
  }
}

/** Generated region boxes are finite and immutable after collection; weak ownership follows the
 * existing bounded region caches and does not retain abandoned districts. */
export function solidBoxDistance(boxes: readonly Box[], x: number, y: number, z: number, best: number): number {
  // Even small building compounds benefit from indexed bounds across the
  // many contact-shell probes. Preserve the prior small-union NaN behavior.
  if (boxes.length < 8 || boxes.length < 32 && (x !== x || y !== y || z !== z)) {
    if (x !== x || y !== y || z !== z) return boxes.length ? NaN : best;
    for (const b of boxes) {
      // Small compounds skip hierarchy construction, but still benefit from
      // the same exact signed-axis rejection used by hierarchy leaves.
      const dx = Math.abs(x - b.x) - b.hx;
      if (dx >= best) continue;
      const dy = Math.abs(y - b.y) - b.hy;
      if (dy >= best) continue;
      const dz = Math.abs(z - b.z) - b.hz;
      if (dz >= best) continue;
      const ox = dx > 0 ? dx : 0, oy = dy > 0 ? dy : 0, oz = dz > 0 ? dz : 0;
      const outside = Math.sqrt(ox * ox + oy * oy + oz * oz);
      const inside = Math.min(Math.max(dx, Math.max(dy, dz)), 0);
      best = Math.min(best, outside + inside);
    }
    return best;
  }
  let index=cache.get(boxes);
  if (!index || index.count !== boxes.length) { index=new SolidBoxIndex(boxes);cache.set(boxes,index); }
  return index.distance(x,y,z,best);
}
