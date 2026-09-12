import { CHUNK_SIZE, LOD2_STEP, type ColumnData, type Region, type World } from '@shared/index';
import { partitionChunkMeshes, type ColumnMeshBundle } from './surfacenets.js';

const TILE_SIZE = CHUNK_SIZE * LOD2_STEP;
const SAMPLE_STEP = 64;
const CELLS = TILE_SIZE / SAMPLE_STEP;
const EMPTY_REGION: Region = { sites: [], solids: [], pads: [], cuts: [], vegetation: [], boulders: [] };

/** Cheap temporary coverage, before any SDF slab or structure generation.
 * The same 32m ownership parts let exact terrain replace it without overlap. */
export function meshTerrainPreview(world: World, cx: number, cz: number): ColumnMeshBundle {
  return new TerrainPreviewBuilder(world, cx, cz).advance(Infinity)!;
}

/** The emergency camera tile can progress even while a browser delays its
 * workers. Sampling yields between columns; only one tiny packed tile is
 * finalized, never an SDF region or an entire horizon on the main thread. */
export class TerrainPreviewBuilder {
  private readonly columns: ColumnData[] = [];
  private result: ColumnMeshBundle | null = null;

  constructor(private readonly world: World, private readonly cx: number, private readonly cz: number) {}

  get sampledColumns(): number { return this.columns.length; }

  advance(deadline: number, maxSamples = Infinity): ColumnMeshBundle | null {
    if (this.result) return this.result;
    const side = CELLS + 3, x0 = this.cx * TILE_SIZE, z0 = this.cz * TILE_SIZE;
    let samples = 0;
    do {
      const i = this.columns.length;
      this.columns.push(this.world.column(x0 + (i % side - 1) * SAMPLE_STEP,
        z0 + (Math.floor(i / side) - 1) * SAMPLE_STEP));
      samples++;
    } while (this.columns.length < side * side && samples < maxSamples && performance.now() < deadline);
    if (this.columns.length < side * side) return null;
    this.result = packPreview(this.world, this.cx, this.cz, this.columns);
    return this.result;
  }
}

function packPreview(world: World, cx: number, cz: number, columns: readonly ColumnData[]): ColumnMeshBundle {
  const x0 = cx * TILE_SIZE, z0 = cz * TILE_SIZE;
  const side = CELLS + 3;
  const positions: number[] = [], normals: number[] = [], colors: number[] = [];
  const color = [0, 0, 0];
  const point = (x: number, z: number) => {
    const col = columns[(z + 1) * side + x + 1];
    const nx = columns[(z + 1) * side + x].h - columns[(z + 1) * side + x + 2].h;
    const nz = columns[z * side + x + 1].h - columns[(z + 2) * side + x + 1].h;
    const inverse = 1 / Math.hypot(nx, SAMPLE_STEP * 2, nz);
    const px = x0 + x * SAMPLE_STEP, pz = z0 + z * SAMPLE_STEP;
    const ny = SAMPLE_STEP * 2 * inverse;
    const mat = world.material(px, col.h, pz, col, ny, EMPTY_REGION, false);
    world.vertexColor(mat, px, col.h, pz, col, color, 0, ny, false);
    return { x: px, y: col.h, z: pz, nx: nx * inverse, ny, nz: nz * inverse,
      r: Math.round(color[0] * 255), g: Math.round(color[1] * 255), b: Math.round(color[2] * 255) };
  };
  const vertices = Array.from({ length: (CELLS + 1) ** 2 }, (_, i) => point(i % (CELLS + 1), Math.floor(i / (CELLS + 1))));
  for (let z = 0; z < CELLS; z++) {
    for (let x = 0; x < CELLS; x++) {
      const a = z * (CELLS + 1) + x, b = a + 1, c = a + CELLS + 1, d = c + 1;
      for (const i of [a, c, b, b, c, d]) {
        const v = vertices[i];
        positions.push(v.x, v.y, v.z); normals.push(v.nx, v.ny, v.nz); colors.push(v.r, v.g, v.b);
      }
    }
  }
  return {
    chunks: partitionChunkMeshes([{ cy: 0, positions: new Float32Array(positions),
      normals: new Float32Array(normals), colors: new Uint8Array(colors) }], x0, z0, TILE_SIZE, LOD2_STEP),
    portals: { positions: new Float32Array() },
  };
}
