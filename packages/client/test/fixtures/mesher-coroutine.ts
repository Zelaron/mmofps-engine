import { createHash } from 'node:crypto';
import { MAT, type ColumnData, type Region, type World } from '@shared/index';
import type { ColumnMeshBundle } from '../../src/render/surfacenets.js';

export function bundleHash(bundle: ColumnMeshBundle): string {
  const hash = createHash('sha256');
  for (const mesh of [...bundle.chunks, bundle.portals]) {
    hash.update(JSON.stringify({ cy: 'cy' in mesh ? mesh.cy : null, partGrid: mesh.partGrid }));
    for (const key of ['positions', 'normals', 'colors', 'caveDepth', 'partOffsets'] as const) {
      const value = (mesh as unknown as Record<string, ArrayBufferView | undefined>)[key];
      hash.update(`${key}:${value?.byteLength ?? -1}:`);
      if (value) hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    }
  }
  return hash.digest('hex');
}

/** Cheap deterministic terrain with a cave, a surface plinth and an
 * underground plinth. Query hashing also detects reordered field evaluation. */
export function mesherFixture(cave: boolean, foundations: boolean, cityFloor = false) {
  const calls = { column: 0, sdf: 0, region: 0, material: 0, color: 0 };
  const queryHash = createHash('sha256');
  const record = (kind: string, ...numbers: number[]) => queryHash.update(`${kind}:${numbers.join(',')};`);
  const height = (x: number, z: number) => 10 + Math.sin(x * .055) * 3 + Math.cos(z * .043) * 2;
  const region: Region = { sites: [], solids: [], pads: [], cuts: [], vegetation: [], boulders: [],
    foundations: foundations ? [
      cityFloor ? { x: 128, y: 11, z: 128, hx: 160, hy: 3, hz: 160, facade: 5 } :
        { x: 14, y: 11, z: 13, hx: 7, hy: 3, hz: 8 },
      { x: 20, y: 1, z: 20, hx: 5, hy: 1, hz: 6, underground: true },
    ] : [] };
  const world = {
    column(x: number, z: number) {
      calls.column++; record('column', x, z);
      return { h: height(x, z), temp: .6, moist: .7, desert: .1, volc: 0, lavaY: -1000,
        entr: cave ? .7 : 0, entrRaw: cave ? .7 : 0,
        cave: cave ? { mouth: x / 20 - 1 } : undefined } as ColumnData;
    },
    collectRegion() { calls.region++; record('region'); return region; },
    collectCities() {
      record('cities');
      return cityFloor ? [{ id: 1, name: 'fixture', x: 128, y: 11, z: 128, radius: 256, seed: 55 }] : [];
    },
    groundY(x: number, z: number) { record('ground', x, z); return height(x, z); },
    sdfCol(x: number, y: number, z: number, col: ColumnData) {
      calls.sdf++; record('sdf', x, y, z);
      const terrain = y - col.h;
      return cave ? Math.max(terrain, 12 - Math.hypot(x - 17, (y - 2) * 1.4, z - 17)) : terrain;
    },
    material(x: number, y: number, z: number) { calls.material++; record('material', x, y, z); return MAT.GRASS; },
    vertexColor(_material: number, x: number, y: number, z: number, col: ColumnData, color: number[]) {
      calls.color++; record('color', x, y, z);
      color[0] = .3 + Math.sin(x / 10) * .1;
      color[1] = .5 + Math.cos(z / 10) * .1;
      color[2] = .2 + Math.min(.3, Math.max(0, col.h - y) / 40);
    },
  } as unknown as World;
  return { world, calls, queryHash: () => queryHash.digest('hex') };
}
