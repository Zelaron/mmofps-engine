import type { Box, RBox, World } from '@shared/index';
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

  /** A structure cell is the smallest existing canonical work unit. Its
   * nested generator stays synchronous; only complete cells enter the LRU. */
  *collectSteps(bounds: SceneryBounds): Generator<void, Box[], void> {
    const minX = Math.floor((bounds.minX - STRUCTURE_HALF_EXTENT) / STRUCTURE_GENERATION_CELL);
    const maxX = Math.floor((bounds.maxX + STRUCTURE_HALF_EXTENT) / STRUCTURE_GENERATION_CELL);
    const minZ = Math.floor((bounds.minZ - STRUCTURE_HALF_EXTENT) / STRUCTURE_GENERATION_CELL);
    const maxZ = Math.floor((bounds.maxZ + STRUCTURE_HALF_EXTENT) / STRUCTURE_GENERATION_CELL);
    const boxes = new Map<string, Box>();
    for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
      for (const box of this.collectCell(x, z).source) boxes.set(structureBoxKey(box), box);
      yield;
    }
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

  /** Atomic result with cooperative boundaries between canonical cells.
   * Existing synchronous consumers keep collect(); only the worker drains
   * this iterator. No partial scenery escapes when a job is cancelled. */
  *collectSteps(kind: SceneryKind, b: SceneryBounds): Generator<void, SceneryData[SceneryKind], void> {
    if (kind === 'structures') return yield* this.structures.collectSteps(b);
    if (kind === 'vegetation') {
      if (!this.world.collectVegetationCells) return this.collect(kind, b);
      const out: SceneryData['vegetation'] = [];
      for (const cell of this.world.collectVegetationCells(b.minX, b.maxX, b.minZ, b.maxZ)) {
        if (cell) out.push(...cell);
        yield;
      }
      return out;
    }
    if (!this.world.collectBoulderCells) return this.collect(kind, b);
    const rocks: RBox[] = [];
    for (const cell of this.world.collectBoulderCells(b.minX, b.maxX, b.minZ, b.maxZ)) {
      if (cell) rocks.push(...cell);
      yield;
    }
    // The old collector generates every boulder before sampling any colors.
    // Retain that order, including all world-cache writes, across pauses.
    const out: SceneryData['rocks'] = [];
    for (const rock of rocks) {
      out.push({ rock, desert: this.world.column(rock.x, rock.z).desert > .5 });
      yield;
    }
    return out;
  }
}
