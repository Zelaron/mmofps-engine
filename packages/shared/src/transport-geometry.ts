import { sdBox } from './sdf.js';

export interface BridgePoint { x: number; z: number }
/** The same four corners define the visible ribbon and its exact collision. */
export interface TransportPrism {
  corners: readonly BridgePoint[];
  bottom: number; top: number; rail: boolean;
}
interface Bounds { x: number; y: number; z: number; hx: number; hy: number; hz: number }
interface Node extends Bounds { a?: Node; b?: Node; pieces?: readonly TransportPrism[] }
const boundsCache = new WeakMap<TransportPrism, Bounds>();
export function transportPrismBounds(piece: TransportPrism): Bounds {
  const cached = boundsCache.get(piece); if (cached) return cached;
  const xs = piece.corners.map(p => p.x), zs = piece.corners.map(p => p.z);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
  const bounds = { x: (x0 + x1) / 2, y: (piece.top + piece.bottom) / 2, z: (z0 + z1) / 2,
    hx: (x1 - x0) / 2, hy: (piece.top - piece.bottom) / 2, hz: (z1 - z0) / 2 };
  boundsCache.set(piece, bounds); return bounds;
}
export function transportPrismDistance(piece: TransportPrism, x: number, y: number, z: number): number {
  let distance2 = Infinity, positive = false, negative = false;
  for (let i = 0; i < piece.corners.length; i++) {
    const a = piece.corners[i], b = piece.corners[(i + 1) % piece.corners.length];
    const dx = b.x - a.x, dz = b.z - a.z, px = x - a.x, pz = z - a.z;
    const cross = dx * pz - dz * px; positive ||= cross > 1e-9; negative ||= cross < -1e-9;
    const t = Math.max(0, Math.min(1, (px * dx + pz * dz) / Math.max(1e-12, dx * dx + dz * dz)));
    distance2 = Math.min(distance2, (px - t * dx) ** 2 + (pz - t * dz) ** 2);
  }
  const horizontal = Math.sqrt(distance2) * (positive && negative ? 1 : -1);
  const vertical = Math.max(piece.bottom - y, y - piece.top);
  return Math.hypot(Math.max(0, horizontal), Math.max(0, vertical)) + Math.min(0, Math.max(horizontal, vertical));
}

/** Global immutable BVH: long rays and capsule probes see identical geometry. */
export class TransportBridgeIndex {
  private readonly root?: Node;
  constructor(pieces: readonly TransportPrism[]) { if (pieces.length) this.root = this.build([...pieces]); }
  distance(x: number, y: number, z: number, best: number): number {
    return this.root ? this.visit(this.root, x, y, z, best) : best;
  }
  private visit(node: Node, x: number, y: number, z: number, limit: number): number {
      if (sdBox(x, y, z, node.x, node.y, node.z, node.hx, node.hy, node.hz) >= limit) return limit;
      if (node.pieces) { for (const p of node.pieces) limit = Math.min(limit, transportPrismDistance(p, x, y, z)); return limit; }
      const a = node.a!, b = node.b!, da = sdBox(x, y, z, a.x, a.y, a.z, a.hx, a.hy, a.hz), db = sdBox(x, y, z, b.x, b.y, b.z, b.hx, b.hy, b.hz);
      return da < db ? this.visit(b, x, y, z, this.visit(a, x, y, z, limit)) : this.visit(a, x, y, z, this.visit(b, x, y, z, limit));
  }
  private build(pieces: TransportPrism[]): Node {
    const bounds = pieces.map(transportPrismBounds);
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const b of bounds) { x0 = Math.min(x0, b.x - b.hx); x1 = Math.max(x1, b.x + b.hx); y0 = Math.min(y0, b.y - b.hy); y1 = Math.max(y1, b.y + b.hy); z0 = Math.min(z0, b.z - b.hz); z1 = Math.max(z1, b.z + b.hz); }
    const node: Node = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: (z0 + z1) / 2, hx: (x1 - x0) / 2, hy: (y1 - y0) / 2, hz: (z1 - z0) / 2 };
    if (pieces.length <= 6) { node.pieces = pieces; return node; }
    const axis = x1 - x0 > z1 - z0 ? 'x' : 'z';
    pieces.sort((a, b) => transportPrismBounds(a)[axis] - transportPrismBounds(b)[axis]);
    const middle = pieces.length >> 1; node.a = this.build(pieces.slice(0, middle)); node.b = this.build(pieces.slice(middle)); return node;
  }
}
