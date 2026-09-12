/** Dynamic broad phase. Exact distance/height checks belong to each caller. */
export class SpatialIndex<T> {
  private readonly cells = new Map<string, T[]>();
  constructor(readonly cellSize: number) {
    if (!Number.isFinite(cellSize) || cellSize <= 0) throw new Error('Invalid cell size');
  }
  clear(): void { for (const cell of this.cells.values()) cell.length = 0; }
  insert(value: T, x: number, z: number): void {
    const key = `${Math.floor(x / this.cellSize)},${Math.floor(z / this.cellSize)}`;
    let cell = this.cells.get(key);
    if (!cell) this.cells.set(key, cell = []);
    cell.push(value);
  }
  *query(x: number, z: number, radius: number): IterableIterator<T> {
    const minX = Math.floor((x - radius) / this.cellSize), maxX = Math.floor((x + radius) / this.cellSize);
    const minZ = Math.floor((z - radius) / this.cellSize), maxZ = Math.floor((z + radius) / this.cellSize);
    for (let cz = minZ; cz <= maxZ; cz++) for (let cx = minX; cx <= maxX; cx++) {
      const cell = this.cells.get(`${cx},${cz}`);
      if (cell) yield* cell;
    }
  }
  /** Drop empty buckets after movement, so travel cannot grow memory forever. */
  compact(): void { for (const [key, cell] of this.cells) if (!cell.length) this.cells.delete(key); }
}
