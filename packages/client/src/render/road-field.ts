import * as THREE from 'three';
import type { World, RoadSegment } from '@shared/worldgen';

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

function texture(data: Uint8Array<ArrayBuffer>, size: number): THREE.DataTexture {
  const map=new THREE.DataTexture(data,size,size);
  map.minFilter=map.magFilter=THREE.LinearFilter;map.generateMipmaps=false;map.needsUpdate=true;
  return map;
}
type Layer = { grid?: RoadGrid; texture: THREE.DataTexture; job?: { grid: RoadGrid; data: Uint8Array<ArrayBuffer>; roads: RoadSegment[]; index: number } };

/** Two bounded maps survive terrain replacement. New maps are rasterized in
 * small batches, then swapped atomically; travelling fast retains far coverage. */
export class RoadField {
  readonly uniforms = {
    roadNearMap: {value:texture(new Uint8Array([255,0,0,0]),1)},
    roadFarMap: {value:texture(new Uint8Array([255,0,0,0]),1)},
    roadNearBounds: {value:new THREE.Vector3(0,0,1)},
    roadFarBounds: {value:new THREE.Vector3(0,0,1)},
  };
  private layers: Layer[] = [{texture:this.uniforms.roadNearMap.value},{texture:this.uniforms.roadFarMap.value}];
  constructor(private world: Pick<World,'collectRoadSegments'>) {}
  update(x: number,z: number): void {
    if(!Number.isFinite(x+z))return;
    for(let i=0;i<2;i++) {
      const layer=this.layers[i], size=i?2048:1024, step=i?6:2, span=size*step, quantum=i?1536:512;
      const grid={x:Math.floor(x/quantum)*quantum-span/2,z:Math.floor(z/quantum)*quantum-span/2,size,step};
      const current=layer.grid;
      // Finish work already in progress even after crossing a recenter cell.
      // Otherwise a fast aircraft can continually restart the far map and
      // never publish any roads. Its wide footprint remains useful on arrival.
      if(!layer.job&&(!current||current.x!==grid.x||current.z!==grid.z)) {
        const data=new Uint8Array(size*size*4); data.fill(255);
        layer.job={grid,data,roads:this.world.collectRoadSegments(grid.x,grid.x+span,grid.z,grid.z+span),index:0};
      }
      const job=layer.job;if(!job)continue;
      const deadline=performance.now()+1.5;
      do {
        const end=Math.min(job.index+16,job.roads.length);
        while(job.index<end)rasterRoadSegment(job.data,job.grid,job.roads[job.index++]);
      }while(job.index<job.roads.length&&performance.now()<deadline);
      if(job.index<job.roads.length)continue;
      const map=texture(job.data,job.grid.size);
      layer.texture.dispose();layer.texture=map;layer.grid=job.grid;layer.job=undefined;
      const prefix=i?'roadFar':'roadNear';this.uniforms[`${prefix}Map`].value=map;
      this.uniforms[`${prefix}Bounds`].value.set(job.grid.x,job.grid.z,job.grid.size*job.grid.step);
    }
  }
  dispose(): void {for(const layer of this.layers){layer.texture.dispose();layer.job=undefined;}}
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
