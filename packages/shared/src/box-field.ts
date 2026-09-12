import { sdBox } from './sdf.js';
import type { Box } from './worldgen.js';

interface Node extends Box { left?: Node; right?: Node; start: number; count: number }
const cache = new WeakMap<readonly Box[], SolidBoxIndex>();

// The largest signed axis distance is a conservative box bound. It is exact
// inside a box and never exceeds its Euclidean distance outside. Internal
// traversal can therefore reject distant branches without square roots;
// leaves still evaluate the original exact signed-distance primitive.
function lowerBound(b: Box, x: number, y: number, z: number): number {
  return Math.max(Math.abs(x - b.x) - b.hx, Math.abs(y - b.y) - b.hy, Math.abs(z - b.z) - b.hz);
}

/** Exact minimum distance to a box union. Bounding volumes only reject
 * pieces whose signed distance cannot improve the current field value. */
export class SolidBoxIndex {
  private readonly root: Node;
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
  }

  distance(x: number, y: number, z: number, best = Infinity): number {
    this.boxTests = 0;
    if (lowerBound(this.root, x, y, z) >= best) return best;
    return this.visit(this.root, x, y, z, best);
  }

  private visit(node: Node, x: number, y: number, z: number, best: number): number {
    if (!node.left) {
      const bounds = this.bounds, end = node.start + node.count * 6;
      for (let i = node.start; i < end; i += 6) {
        // A leaf groups nearby pieces, not necessarily pieces touching this
        // query. Apply the same conservative bound to each box before the
        // exact primitive; thin walls and decks otherwise pay for all eight.
        if (Math.abs(x - bounds[i]) - bounds[i + 3] >= best || Math.abs(y - bounds[i + 1]) - bounds[i + 4] >= best ||
            Math.abs(z - bounds[i + 2]) - bounds[i + 5] >= best) continue;
        this.boxTests++;
        const d = sdBox(x,y,z,bounds[i],bounds[i + 1],bounds[i + 2],bounds[i + 3],bounds[i + 4],bounds[i + 5]);
        if (d < best) best = d;
      }
      return best;
    }
    const a = node.left!, b = node.right!;
    const da = lowerBound(a, x, y, z);
    const db = lowerBound(b, x, y, z);
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

/** Region arrays are immutable after collection; weak ownership follows the
 * existing bounded region caches and does not retain abandoned districts. */
export function solidBoxDistance(boxes: readonly Box[], x: number, y: number, z: number, best: number): number {
  if (boxes.length < 32) {
    for (const b of boxes) best=Math.min(best,sdBox(x,y,z,b.x,b.y,b.z,b.hx,b.hy,b.hz));
    return best;
  }
  let index=cache.get(boxes);
  if (!index || index.count !== boxes.length) { index=new SolidBoxIndex(boxes);cache.set(boxes,index); }
  return index.distance(x,y,z,best);
}
