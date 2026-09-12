import type { Box, World } from '@shared/index';
import type { SceneryBounds, SceneryData, SceneryKind } from './scenery-stream.js';

export const STRUCTURE_GENERATION_CELL = 256;
export const STRUCTURE_HALF_EXTENT = 128;
export const STRUCTURE_CACHE_CELLS = 256;
export const structureBoxKey = (box: Box): string =>
  `${box.x},${box.y},${box.z},${box.hx},${box.hy},${box.hz},${box.facade ?? 0},${box.floorY ?? 0}`;

/** Shared by the worker and synchronous fallback: identical bounds, floor
 * ownership and bounded caches, without constructing any Three.js objects. */
export class StructureSamples {
  readonly cells = new Map<string, { source: Box[] }>();
  readonly prefetch: { x: number; z: number }[] = [];
  constructor(private readonly world: Pick<World, 'collectStructures'>) {}

  collectCell(x: number, z: number): { source: Box[] } {
    const key = `${x},${z}`, cached = this.cells.get(key);
    if (cached) { this.cells.delete(key); this.cells.set(key, cached); return cached; }
    const cx = (x + .5) * STRUCTURE_GENERATION_CELL, cz = (z + .5) * STRUCTURE_GENERATION_CELL;
    const region = this.world.collectStructures(cx, cx, cz, cz);
    const floors = new Set((region.foundations ?? []).map(structureBoxKey));
    const value = { source: region.solids.filter(b => !b.capital && !floors.has(structureBoxKey(b))) };
    this.cells.set(key, value);
    if (this.cells.size > STRUCTURE_CACHE_CELLS) this.cells.delete(this.cells.keys().next().value!);
    return value;
  }

  collect(bounds: SceneryBounds): Box[] {
    const minX = Math.floor((bounds.minX - STRUCTURE_HALF_EXTENT) / STRUCTURE_GENERATION_CELL);
    const maxX = Math.floor((bounds.maxX + STRUCTURE_HALF_EXTENT) / STRUCTURE_GENERATION_CELL);
    const minZ = Math.floor((bounds.minZ - STRUCTURE_HALF_EXTENT) / STRUCTURE_GENERATION_CELL);
    const maxZ = Math.floor((bounds.maxZ + STRUCTURE_HALF_EXTENT) / STRUCTURE_GENERATION_CELL);
    const boxes = new Map<string, Box>();
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++)
      for (const box of this.collectCell(x, z).source) boxes.set(structureBoxKey(box), box);
    this.prefetch.length = 0;
    if ((maxX - minX + 3) * (maxZ - minZ + 3) <= STRUCTURE_CACHE_CELLS) {
      for (let x = minX - 1; x <= maxX + 1; x++) for (let z = minZ - 1; z <= maxZ + 1; z++) {
        if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) continue;
        if (!this.cells.has(`${x},${z}`)) this.prefetch.push({ x, z });
      }
    }
    return [...boxes.values()];
  }
}

export class ScenerySamples {
  private readonly structures: StructureSamples;
  constructor(private readonly world: World) { this.structures = new StructureSamples(world); }

  collect(kind: SceneryKind, b: SceneryBounds): SceneryData[SceneryKind] {
    if (kind === 'vegetation') return this.world.collectVegetation(b.minX, b.maxX, b.minZ, b.maxZ);
    if (kind === 'structures') return this.structures.collect(b);
    return this.world.collectBoulders(b.minX, b.maxX, b.minZ, b.maxZ)
      .map(rock => ({ rock, desert: this.world.column(rock.x, rock.z).desert > .5 }));
  }
}
