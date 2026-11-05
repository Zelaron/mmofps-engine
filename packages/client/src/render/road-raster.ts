import type { World, RoadSegment, RoadNetworkSnapshot } from '@shared/worldgen';
import type { TransportSnapshot } from '@shared/transport';

/** Pure road-map rasterization, shared by the main thread and its worker. */
export interface RoadGrid { x: number; z: number; size: number; step: number }
const RANGE = 32;

/** Distance and height, independent of terrain vertices and terrain worker LOD. */
export function rasterRoadSegment(data: Uint8Array, grid: RoadGrid, road: RoadSegment): void {
  const {a,b,width} = road, {x:x0,z:z0,size,step}=grid;
  const reach=width+RANGE, dx=b.x-a.x,dz=b.z-a.z,length2=dx*dx+dz*dz;
  if(length2<1e-8 || road.id.startsWith('city:'))return;
  const minX=Math.max(0,Math.floor((Math.min(a.x,b.x)-reach-x0)/step));
  const maxX=Math.min(size-1,Math.ceil((Math.max(a.x,b.x)+reach-x0)/step));
  const minZ=Math.max(0,Math.floor((Math.min(a.z,b.z)-reach-z0)/step));
  const maxZ=Math.min(size-1,Math.ceil((Math.max(a.z,b.z)+reach-z0)/step));
  for(let z=minZ;z<=maxZ;z++)for(let x=minX;x<=maxX;x++) {
    const px=x0+(x+.5)*step-a.x,pz=z0+(z+.5)*step-a.z;
    const t=Math.max(0,Math.min(1,(px*dx+pz*dz)/length2));
    const distance=Math.hypot(px-dx*t,pz-dz*t)-width;
    const encoded=Math.max(0,Math.min(255,Math.round((distance/RANGE*.5+.5)*255))), i=(z*size+x)*4;
    if(encoded>=data[i])continue;
    const height=Math.max(0,Math.min(65535,Math.round((a.y+(b.y-a.y)*t+512)*32)));
    data[i]=encoded;data[i+1]=height>>8;data[i+2]=height&255;data[i+3]=road.trail?255:0;
  }
}

export type RoadWorld = Pick<World, 'collectRoadSegments'> & Partial<Pick<World, 'collectRoadSegmentSteps'>>;

export function* collectRoads(world: RoadWorld, grid: RoadGrid): Generator<void, RoadSegment[], void> {
  const span = grid.size * grid.step;
  if (typeof world.collectRoadSegmentSteps === 'function')
    return yield* world.collectRoadSegmentSteps(grid.x, grid.x + span, grid.z, grid.z + span);
  return world.collectRoadSegments(grid.x, grid.x + span, grid.z, grid.z + span);
}

/** One complete map: road collection, then rasterization in small batches. */
export function* rasterRoadSteps(world: RoadWorld, grid: RoadGrid): Generator<void, Uint8Array<ArrayBuffer>, void> {
  const roads = yield* collectRoads(world, grid);
  const data = new Uint8Array(grid.size * grid.size * 4); data.fill(255);
  for (let i = 0; i < roads.length; i++) { rasterRoadSegment(data, grid, roads[i]); if ((i & 31) === 31) yield; }
  return data;
}

/** Main thread to road worker. Layer 0 is the near map, 1 the far map. */
export type RoadFieldRequest =
  | { type: 'init'; seed: number; transportSnapshot?: TransportSnapshot; cooperative?: boolean; network?: boolean }
  | { type: 'raster'; id: number; layer: number; grid: RoadGrid };
/** A finished map, or (once, after the first maps, when requested) the
 * whole island's routed network for the main thread's Worlds to adopt. */
export type RoadFieldResponse =
  | { type: 'raster'; id: number; layer: number; grid: RoadGrid; data: Uint8Array<ArrayBuffer>; workMs: number }
  | { type: 'network'; snapshot: RoadNetworkSnapshot; workMs: number };
