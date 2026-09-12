import { WORLD } from './constants.js';
import { hash2i, mulberry32 } from './rng.js';
import type { World } from './worldgen.js';

export const RESOURCE_CELL = 128;
export const RESOURCE_REACH = 4.5;
export const RESOURCE_SECONDS = 3;
export const RESOURCE_RENEW_SECONDS = 180;
export const RESOURCE_YIELD = 12;
export const RESOURCE_VISIBLE_LIMIT = 9;
export interface ResourceNode { id: string; x: number; y: number; z: number }
export interface ResourceSnapshot {
  enabled: boolean; target: string; progress: number; saving: boolean; reason: string;
  nodes: (ResourceNode & { remaining: number })[];
}

/** One stable candidate per cell. Only the world worker resolves its surface. */
export function resourceCandidate(seed: number, id: string): { id: string; x: number; z: number } {
  const match = /^(-?\d{1,3}),(-?\d{1,3})$/.exec(id);
  if (!match) throw new Error('Invalid resource site');
  const cx = Number(match[1]), cz = Number(match[2]);
  if (`${cx},${cz}` !== id || cx < -WORLD.BORDER / RESOURCE_CELL || cx >= WORLD.BORDER / RESOURCE_CELL ||
      cz < -WORLD.BORDER / RESOURCE_CELL || cz >= WORLD.BORDER / RESOURCE_CELL) throw new Error('Invalid resource cell');
  const random = mulberry32(hash2i(seed ^ 0x71e0a, cx, cz));
  return { id, x: cx * RESOURCE_CELL + 24 + Math.floor(random() * 80), z: cz * RESOURCE_CELL + 24 + Math.floor(random() * 80) };
}

/** A bounded cache; harvesting does not generate the rest of the planet. */
export class ResourceField {
  private readonly cache = new Map<string, ResourceNode | null>();
  constructor(private readonly world: World) {}
  get cacheSize(): number { return this.cache.size; }
  get(id: string): ResourceNode | null {
    if (this.cache.has(id)) {
      const node = this.cache.get(id)!; this.cache.delete(id); this.cache.set(id, node); return node;
    }
    const p = resourceCandidate(this.world.seed, id), ground = this.world.groundY(p.x, p.z);
    const floor = this.world.trace(p.x, ground + 2, p.z, 0, -1, 0, 4), y = floor.y;
    const slope = Math.max(...[[3, 0], [-3, 0], [0, 3], [0, -3]].map(([dx, dz]) =>
      Math.abs(this.world.groundY(p.x + dx, p.z + dz) - ground) / 3));
    const node = floor.hit && floor.ny >= .94 && Math.abs(y - ground) < .4 && Number.isFinite(y) && y > WORLD.KILL_Y + 8 && slope < .2 &&
      !this.world.liquidAt(p.x, y + .2, p.z) && this.world.sdf(p.x, y + 1.1, p.z) > .75
      ? { ...p, y } : null;
    this.cache.set(id, node);
    if (this.cache.size > 1024) this.cache.delete(this.cache.keys().next().value!);
    return node;
  }
  near(x: number, z: number): ResourceNode[] {
    if (!Number.isFinite(x + z) || Math.abs(x) >= WORLD.BORDER || Math.abs(z) >= WORLD.BORDER) return [];
    const cx = Math.floor(x / RESOURCE_CELL), cz = Math.floor(z / RESOURCE_CELL), nodes: ResourceNode[] = [];
    const bound = WORLD.BORDER / RESOURCE_CELL;
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
      if (cx + dx < -bound || cx + dx >= bound || cz + dz < -bound || cz + dz >= bound) continue;
      const node = this.get(`${cx + dx},${cz + dz}`);
      if (node && Math.hypot(node.x - x, node.z - z) < 190) nodes.push(node);
    }
    return nodes.sort((a, b) => Math.hypot(a.x - x, a.z - z) - Math.hypot(b.x - x, b.z - z)).slice(0, RESOURCE_VISIBLE_LIMIT);
  }
}
