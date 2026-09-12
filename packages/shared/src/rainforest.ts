import { smoothstep } from './math.js';
import { hash2i, unit } from './rng.js';

export interface RainforestSite { x: number; z: number; radius: number }
const sites = new Map<number, readonly RainforestSite[]>();
/** Broad contiguous forests with irregular ecotones; no per-tree state. */
export function rainforestSites(seed: number): readonly RainforestSite[] {
  let result = sites.get(seed);
  if (!result) {
    result = [[1050, 1050, 950], [-4200, 3100, 1120], [3100, 3300, 1000]].map(([x, z, radius], i) => ({
      x: x + (unit(hash2i(seed ^ 0x728a, i, 1)) - .5) * 240,
      z: z + (unit(hash2i(seed ^ 0x728a, i, 2)) - .5) * 240, radius,
    }));
    if (sites.size >= 32) sites.delete(sites.keys().next().value!);
    sites.set(seed, result);
  }
  return result;
}
export function rainforestAt(seed: number, x: number, z: number): number {
  let weight = 0;
  for (const site of rainforestSites(seed)) {
    const dx = x - site.x, dz = z - site.z;
    if (Math.abs(dx) > site.radius + 150 || Math.abs(dz) > site.radius + 150) continue;
    const a = Math.atan2(dz, dx);
    const boundary = site.radius * (.92 + .065 * Math.sin(a * 3) + .035 * Math.cos(a * 7));
    weight = Math.max(weight, smoothstep(boundary + 100, boundary - 160, Math.hypot(dx, dz)));
  }
  return weight;
}
