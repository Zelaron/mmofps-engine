import { clamp, lerp } from './math.js';
import type { RoadPoint } from './landscape.js';

/** Bounded deterministic search for the few links that need more than a
 * single bend around a basin. Both exact junctions and their grades survive. */
export function detourRoad(a: RoadPoint, b: RoadPoint,
  clear: (a: RoadPoint, b: RoadPoint) => boolean): RoadPoint[] | undefined {
  const step = 32, margin = 448;
  const x0 = Math.floor((Math.min(a.x, b.x) - margin) / step) * step;
  const z0 = Math.floor((Math.min(a.z, b.z) - margin) / step) * step;
  const nx = Math.ceil((Math.max(a.x, b.x) + margin - x0) / step) + 1;
  const nz = Math.ceil((Math.max(a.z, b.z) + margin - z0) / step) + 1;
  const start = nx * nz, end = start + 1;
  const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
  const point = (id: number): RoadPoint => {
    if (id === start) return a;
    if (id === end) return b;
    const x = x0 + id % nx * step, z = z0 + Math.floor(id / nx) * step;
    return { x, z, y: lerp(a.y, b.y, clamp(((x - a.x) * dx + (z - a.z) * dz) / length2, 0, 1)) };
  };
  const costs = new Float64Array(end + 1).fill(Infinity);
  const previous = new Int32Array(end + 1).fill(-1), closed = new Uint8Array(end + 1);
  const heap: { id: number; rank: number }[] = [];
  const push = (id: number, rank: number): void => {
    let i = heap.length; heap.push({ id, rank });
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p].rank <= rank) break;
      heap[i] = heap[p]; i = p;
    }
    heap[i] = { id, rank };
  };
  const pop = (): number => {
    const first = heap[0], last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].rank < heap[child].rank) child++;
        if (last.rank <= heap[child].rank) break;
        heap[i] = heap[child]; i = child;
      }
      heap[i] = last;
    }
    return first.id;
  };
  costs[start] = 0; push(start, Math.sqrt(length2));
  while (heap.length) {
    const id = pop();
    if (closed[id]) continue;
    if (id === end) {
      const path: RoadPoint[] = [];
      for (let i = end; i !== -1; i = previous[i]) path.push(point(i));
      path.reverse();
      // Remove grid stair-steps only when the entire shortcut is safe.
      const result = [a];
      for (let i = 0; i < path.length - 1;) {
        let next = path.length - 1;
        while (next > i + 1 && !clear(path[i], path[next])) next--;
        result.push(path[next]); i = next;
      }
      return result;
    }
    closed[id] = 1;
    const p = point(id), gx = Math.round((p.x - x0) / step), gz = Math.round((p.z - z0) / step);
    const neighbors: number[] = [];
    if (Math.hypot(p.x - b.x, p.z - b.z) <= step * 1.5) neighbors.push(end);
    for (let oz = -1; oz <= 1; oz++) for (let ox = -1; ox <= 1; ox++) {
      const x = gx + ox, z = gz + oz;
      if ((!ox && !oz && id !== start) || x < 0 || z < 0 || x >= nx || z >= nz) continue;
      neighbors.push(z * nx + x);
    }
    for (const next of neighbors) {
      if (closed[next]) continue;
      const q = point(next), cost = costs[id] + Math.hypot(q.x - p.x, q.z - p.z);
      if (cost >= costs[next] || !clear(p, q)) continue;
      costs[next] = cost; previous[next] = id;
      push(next, cost + Math.hypot(q.x - b.x, q.z - b.z));
    }
  }
  return undefined;
}
