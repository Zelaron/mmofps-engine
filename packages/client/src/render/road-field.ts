import * as THREE from 'three';
import type { RoadSegment, RoadNetworkSnapshot } from '@shared/worldgen';
import type { TransportSnapshot } from '@shared/transport';
import { collectRoads, rasterRoadSegment, type RoadFieldRequest, type RoadFieldResponse, type RoadGrid, type RoadWorld } from './road-raster.js';

export { rasterRoadSegment, type RoadGrid } from './road-raster.js';

/** The subset of a Worker that the road field uses (tests inject fakes). */
export interface RoadFieldWorker {
  postMessage(message: RoadFieldRequest): void;
  onmessage: ((event: MessageEvent<RoadFieldResponse>) => void) | null;
  onerror: ((event: Event) => void) | null;
  terminate(): void;
}
export interface RoadFieldRemote {
  create(): RoadFieldWorker; seed: number; transportSnapshot?: TransportSnapshot; cooperative?: boolean;
  /** Receives the island's routed network once the worker has built it. */
  onNetwork?(snapshot: RoadNetworkSnapshot): void;
}
/** A worker that has not answered for this long is replaced by local work. */
const WORKER_TIMEOUT_MS = 60_000;

function texture(data: Uint8Array<ArrayBuffer>, size: number): THREE.DataTexture {
  const map=new THREE.DataTexture(data,size,size);
  map.minFilter=map.magFilter=THREE.LinearFilter;map.generateMipmaps=false;map.needsUpdate=true;
  return map;
}
type Layer = { grid?: RoadGrid; texture: THREE.DataTexture; job?: {
  grid: RoadGrid; data: Uint8Array<ArrayBuffer>; roads?: RoadSegment[]; index: number;
  collection?: Generator<void, RoadSegment[], void>;
}; request?: { id: number; grid: RoadGrid; sentAt: number } };

/** Two bounded maps survive terrain replacement. New maps are rasterized in
 * small batches, then swapped atomically; travelling fast retains far coverage.
 * With a worker, collection and rasterization leave the main thread entirely;
 * without one (or if it fails) the same work runs here in 1.5 ms slices. */
export class RoadField {
  readonly uniforms = {
    roadNearMap: {value:texture(new Uint8Array([255,0,0,0]),1)},
    roadFarMap: {value:texture(new Uint8Array([255,0,0,0]),1)},
    roadNearBounds: {value:new THREE.Vector3(0,0,1)},
    roadFarBounds: {value:new THREE.Vector3(0,0,1)},
  };
  private layers: Layer[] = [{texture:this.uniforms.roadNearMap.value},{texture:this.uniforms.roadFarMap.value}];
  private disposed = false;
  private worker: RoadFieldWorker | null = null;
  private onNetwork: ((snapshot: RoadNetworkSnapshot) => void) | undefined;
  private sequence = 0;
  constructor(private world: RoadWorld, remote?: RoadFieldRemote) {
    if (!remote) return;
    try {
      const worker = remote.create();
      worker.onmessage = ({ data }) => this.receive(data);
      worker.onerror = event => { event.preventDefault?.(); this.disconnect(); };
      worker.postMessage({ type: 'init', seed: remote.seed, transportSnapshot: remote.transportSnapshot,
        cooperative: remote.cooperative === true, network: !!remote.onNetwork });
      this.worker = worker; this.onNetwork = remote.onNetwork;
    } catch { this.worker = null; }
  }
  /** True while maps are built by a worker. */
  get remote(): boolean { return this.worker !== null; }
  update(x: number,z: number): void {
    if(this.disposed || !Number.isFinite(x+z))return;
    for(let i=0;i<2;i++) {
      const deadline=performance.now()+1.5;
      const layer=this.layers[i], size=i?2048:1024, step=i?6:2, span=size*step, quantum=i?1536:512;
      const grid={x:Math.floor(x/quantum)*quantum-span/2,z:Math.floor(z/quantum)*quantum-span/2,size,step};
      const current=layer.grid;
      if(this.worker) {
        // One request per layer at a time: work in progress is finished even
        // after crossing a recenter cell, so fast travel cannot starve a map.
        if(layer.request) {
          if(performance.now()-layer.request.sentAt>WORKER_TIMEOUT_MS)this.disconnect();
          else continue;
        } else {
          if(current&&current.x===grid.x&&current.z===grid.z)continue;
          const id=++this.sequence;
          layer.request={id,grid,sentAt:performance.now()};
          try{this.worker.postMessage({type:'raster',id,layer:i,grid});continue;}catch{this.disconnect();}
        }
      }
      // Finish work already in progress even after crossing a recenter cell.
      // Otherwise a fast aircraft can continually restart the far map and
      // never publish any roads. Its wide footprint remains useful on arrival.
      if(!layer.job&&(!current||current.x!==grid.x||current.z!==grid.z)) {
        const data=new Uint8Array(size*size*4); data.fill(255);
        layer.job={grid,data,collection:collectRoads(this.world,grid),index:0};
      }
      const job=layer.job;if(!job)continue;
      // Collection and rasterization share one budget. In particular, the
      // cold far-map route search must not precede the deadline unbounded.
      while(job.collection && performance.now()<deadline) {
        const next=job.collection.next();
        if(next.done) {job.roads=next.value;job.collection=undefined;}
      }
      if(job.collection || performance.now()>=deadline)continue;
      const roads=job.roads!;
      do {
        const end=Math.min(job.index+16,roads.length);
        while(job.index<end)rasterRoadSegment(job.data,job.grid,roads[job.index++]);
      }while(job.index<roads.length&&performance.now()<deadline);
      if(job.index<roads.length)continue;
      layer.job=undefined;
      this.publish(i,job.grid,job.data);
    }
  }
  private publish(i: number, grid: RoadGrid, data: Uint8Array<ArrayBuffer>): void {
    const layer=this.layers[i], map=texture(data,grid.size);
    layer.texture.dispose();layer.texture=map;layer.grid=grid;
    const prefix=i?'roadFar':'roadNear';this.uniforms[`${prefix}Map`].value=map;
    this.uniforms[`${prefix}Bounds`].value.set(grid.x,grid.z,grid.size*grid.step);
  }
  private receive(response: RoadFieldResponse): void {
    if(this.disposed || !this.worker)return;
    if(response?.type==='network'){this.onNetwork?.(response.snapshot);return;}
    if(response?.type!=='raster')return;
    const layer=this.layers[response.layer];
    if(!layer || layer.request?.id!==response.id)return;
    layer.request=undefined;
    this.publish(response.layer,response.grid,response.data);
  }
  /** Falls back to local slices; requests in flight restart there. */
  private disconnect(): void {
    const worker=this.worker; this.worker=null;
    for(const layer of this.layers)layer.request=undefined;
    try{worker?.terminate();}catch{/* already gone */}
  }
  dispose(): void {
    this.disposed=true;
    this.disconnect();
    for(const layer of this.layers){layer.job?.collection?.return([]);layer.texture.dispose();layer.job=undefined;}
  }
}

export const ROAD_GLSL = `
uniform sampler2D roadNearMap, roadFarMap;
uniform vec3 roadNearBounds, roadFarBounds;
vec4 roadSample(vec2 p) {
  vec2 nearUV=(p-roadNearBounds.xy)/roadNearBounds.z;
  vec2 farUV=(p-roadFarBounds.xy)/roadFarBounds.z;
  vec4 farRoad=texture2D(roadFarMap,farUV);
  if(min(farUV.x,farUV.y)<0.0||max(farUV.x,farUV.y)>1.0)farRoad.r=1.0;
  float edge=min(min(nearUV.x,nearUV.y),min(1.0-nearUV.x,1.0-nearUV.y));
  return mix(farRoad,texture2D(roadNearMap,nearUV),smoothstep(.025,.075,edge));
}
`;
export const ROAD_COLOR_GLSL = `
vec4 road=roadSample(vSurfacePosition.xz);
float roadDistance=(road.r*2.0-1.0)*32.0;
float roadAA=max(1.35,fwidth(roadDistance));
float roadCover=1.0-smoothstep(-roadAA,roadAA,roadDistance);
float roadHeight=(road.g*255.0*256.0+road.b*255.0)/32.0-512.0;
float roadTolerance=mix(4.0,28.0,smoothstep(200.0,1600.0,length(vViewPosition)));
roadCover*=1.0-smoothstep(roadTolerance,roadTolerance*2.0,abs(vSurfacePosition.y-roadHeight));
roadCover*=smoothstep(.25,.6,surfaceN.y)*(1.0-smoothstep(1.5,6.0,vCaveDepth));
roadCover*=1.0-clamp(cityWeights.x+cityWeights.y,0.0,1.0);
vec3 gravel=mix(vec3(.39,.37,.33),vec3(.49,.37,.24),road.a);
gravel=mix(diffuseColor.rgb*.75,gravel,.7);
gravel*=.94+grain.x*.12;
diffuseColor.rgb=mix(diffuseColor.rgb,gravel,roadCover);
`;
