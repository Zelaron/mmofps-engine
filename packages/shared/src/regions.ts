import { WORLD } from './constants.js';

/** Rectilinear partitions of the existing continuous surface. Layout changes
 * are maintenance operations; they are never inferred from worker arrivals. */
export interface RegionLayout {
  version: number;
  xCuts: readonly number[];
  zCuts: readonly number[];
  entry: Readonly<{ x: number; z: number }>;
}
export interface RegionBounds { id: string; minX: number; maxX: number; minZ: number; maxZ: number }
export const WORLD_REGION_LAYOUT: RegionLayout = Object.freeze({ version: 1,
  xCuts: Object.freeze([]), zCuts: Object.freeze([]), entry: Object.freeze({ x: 0, z: 0 }) });

function cell(cuts: readonly number[], value: number): number {
  let low = 0, high = cuts.length;
  while (low < high) { const mid = (low + high) >>> 1; if (value < cuts[mid]) high = mid; else low = mid + 1; }
  return low;
}
export class RegionGrid {
  readonly layout: RegionLayout;
  constructor(input: RegionLayout = WORLD_REGION_LAYOUT) {
    if (!input || !Number.isSafeInteger(input.version) || input.version < 1 || input.version > 0xffffffff ||
        !input.entry || !Number.isFinite(input.entry.x) || !Number.isFinite(input.entry.z) ||
        Math.abs(input.entry.x) >= WORLD.BORDER || Math.abs(input.entry.z) >= WORLD.BORDER) throw new Error('Invalid region layout');
    for (const cuts of [input.xCuts, input.zCuts]) {
      if (!Array.isArray(cuts) || cuts.length > 63) throw new Error('Invalid region cuts');
      let previous = -WORLD.BORDER;
      for (const cut of [...cuts, WORLD.BORDER]) {
        if (!Number.isFinite(cut) || cut - previous < 128 || cut > WORLD.BORDER) throw new Error('Region cuts must be ordered, with cells at least 128 metres wide');
        previous = cut;
      }
    }
    this.layout = Object.freeze({ version: input.version, xCuts: Object.freeze([...input.xCuts]),
      zCuts: Object.freeze([...input.zCuts]), entry: Object.freeze({ x: input.entry.x, z: input.entry.z }) });
  }
  get partitioned(): boolean { return this.layout.xCuts.length + this.layout.zCuts.length > 0; }
  at(x: number, z: number): RegionBounds {
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('Invalid region position');
    // The physics boundary owns the outer edge. Overshoot still has an owner.
    return this.bounds(cell(this.layout.xCuts, x), cell(this.layout.zCuts, z));
  }
  get(id: string): RegionBounds | null {
    if (!this.partitioned) return id === 'world' ? this.bounds(0, 0) : null;
    const match = /^r(0|[1-9]\d*):(0|[1-9]\d*)$/.exec(id);
    if (!match) return null;
    const x = Number(match[1]), z = Number(match[2]);
    return x <= this.layout.xCuts.length && z <= this.layout.zCuts.length ? this.bounds(x, z) : null;
  }
  neighbors(id: string, reach: number): RegionBounds[] {
    const bounds = this.get(id);
    if (!bounds || !Number.isFinite(reach) || reach < 0 || reach > WORLD.BORDER) throw new Error('Invalid neighbor request');
    const result: RegionBounds[] = [];
    const x0 = cell(this.layout.xCuts, bounds.minX - reach), x1 = cell(this.layout.xCuts, bounds.maxX + reach);
    const z0 = cell(this.layout.zCuts, bounds.minZ - reach), z1 = cell(this.layout.zCuts, bounds.maxZ + reach);
    // Include touching cells even at zero reach; bounds are half open for
    // ownership, while adjacent simulations must still discover each other.
    for (let x = Math.max(0, x0 - 1); x <= x1; x++) for (let z = Math.max(0, z0 - 1); z <= z1; z++) {
      const candidate = this.bounds(x, z);
      if (candidate.id !== id && candidate.maxX >= bounds.minX - reach && candidate.minX <= bounds.maxX + reach &&
          candidate.maxZ >= bounds.minZ - reach && candidate.minZ <= bounds.maxZ + reach) result.push(candidate);
    }
    return result;
  }
  private bounds(x: number, z: number): RegionBounds {
    return { id: this.partitioned ? `r${x}:${z}` : 'world',
      minX: x === 0 ? -WORLD.BORDER : this.layout.xCuts[x - 1], maxX: this.layout.xCuts[x] ?? WORLD.BORDER,
      minZ: z === 0 ? -WORLD.BORDER : this.layout.zCuts[z - 1], maxZ: this.layout.zCuts[z] ?? WORLD.BORDER };
  }
}
