import type { World, Region, StructureFoundation, CityDistrict, Box } from './worldgen.js';
import { PLAYER, WORLD } from './constants.js';
import { transitDistance } from './transit-motion.js';
import { VehicleCollisionSelection } from './vehicle-collision.js';
import { TransportBridgeIndex } from './transport-geometry.js';
import { SolidBoxIndex } from './box-field.js';

// Every accepted result proves findCapsuleContact
// would return false; no contact, gradient, bisection or snap is approximated.
const EPS = 1e-6;
const CONTACT_SKIN = .006, CONTACT_MIN = .0005;
// Any gradient-ray crossing outside this radius has depth < CONTACT_MIN.
// The outward EPS absorbs floating-point subtraction/normal normalization.
// Shell fallback rays use only PLAYER.RADIUS and are strictly contained.
const REACH = PLAYER.RADIUS + CONTACT_SKIN - CONTACT_MIN + EPS;
const CELL = 4, CACHE_LIMIT = 256;
type Prototype = object;
interface NativeShape { prototype: Prototype; names:string[]; methods:unknown[] }
let nativeWorld:NativeShape|undefined, nativeLandscape:NativeShape, nativeNoise:NativeShape, nativeOutpost:NativeShape;
let nativeHullDistance:unknown, nativeBridge:NativeShape, nativeSolidBox:NativeShape;
const capture = (prototype:Prototype):NativeShape => {
  const names=Object.getOwnPropertyNames(prototype).filter(name=>name!=='constructor'&&typeof Object.getOwnPropertyDescriptor(prototype,name)?.value==='function');
  return {prototype,names,methods:names.map(name=>(prototype as Record<string, unknown>)[name])};
};
// Called once at the end of the World module, after its class and
// dependencies are initialized. Saved references also detect prototype edits.
export function registerCanonicalWorldPrototype(world:Prototype,landscape:Prototype,noise:Prototype,outpost:Prototype):void {
  nativeWorld=capture(world);nativeLandscape=capture(landscape);nativeNoise=capture(noise);nativeOutpost=capture(outpost);
  nativeHullDistance=VehicleCollisionSelection.prototype.distance;
  nativeBridge=capture(TransportBridgeIndex.prototype);
  nativeSolidBox=capture(SolidBoxIndex.prototype);
}
const methodsMatch=(object:object,shape:NativeShape):boolean=>{
  const record=object as Record<string, unknown>;
  for(let i=0;i<shape.names.length;i++)if(record[shape.names[i]]!==shape.methods[i])return false;
  return true;
};
const matches=(object:object,shape:NativeShape):boolean=>Object.getPrototypeOf(object)===shape.prototype&&methodsMatch(object,shape);
interface Interval { lo:number;hi:number }
interface CellProof {
  floor:number;x0:number;x1:number;z0:number;z1:number;
  early:Interval[];solid:Interval[];clamps:StructureFoundation[];
  bridges?:Region['transportBridges'];
}
interface Provider extends Record<string, unknown> { seed:number; naturalHeight?:unknown; base?:unknown }
interface WorldProof {
  seed:number;landscape:Provider;noise:Provider;landscapeSeed:number;noiseSeed:number;
  naturalHeight:unknown;base:unknown;cities?:readonly CityDistrict[];cells:Map<string,CellProof|null>;
}
const cache = new WeakMap<World,WorldProof>();

/** Capture per-instance generator callbacks before an injected provider can
 * replace them. The geometry itself remains lazy and bounded per world. */
export function initializeAirProofWorld(world:World,landscape:object,noise:object):void {
  const l=landscape as Provider,n=noise as Provider;
  cache.set(world,{seed:world.seed,landscape:l,noise:n,landscapeSeed:l.seed,noiseSeed:n.seed,
    naturalHeight:l.naturalHeight,base:l.base,cells:new Map()});
}

function buildCell(world:World,city:CityDistrict,ix:number,iz:number):CellProof|null {
  const x0=ix*CELL-REACH-EPS,x1=(ix+1)*CELL+REACH+EPS,z0=iz*CELL-REACH-EPS,z1=(iz+1)*CELL+REACH+EPS;
  const ax=Math.max(Math.abs(x0-city.x),Math.abs(x1-city.x)),az=Math.max(Math.abs(z0-city.z),Math.abs(z1-city.z));
  if(city.theme?Math.hypot(ax,az)>=city.radius*.85-EPS:Math.max(ax,az)>=city.radius-EPS)return null;
  // Deep Vesper terrain is bounded above by -60. Keep its rim and raised
  // approach axes excluded, using the entire expanded cell footprint.
  const abyss=city.theme==='vesper';
  if(abyss&&(Math.hypot(ax,az)>=city.radius*.85-260-EPS||Math.max(ax,az)>=1550-EPS))return null;
  if(Math.max(Math.abs(x0),Math.abs(x1),Math.abs(z0),Math.abs(z1))>=WORLD.BORDER-EPS)return null;
  if(world.collectCaveSites(x0,x1,z0,z1).length)return null;
  const overlaps=(loX:number,hiX:number,loZ:number,hiZ:number)=>hiX>=x0&&loX<=x1&&hiZ>=z0&&loZ<=z1;
  const plan=world.collectTransportPlan();
  if(plan.stations.some(s=>overlaps(s.x-34,s.x+194,s.z-34,s.z+194))||
    plan.accesses.some(a=>overlaps(a.x-270,a.x+270,a.startZ-256,a.endZ+256))||
    world.collectJungleTemples().some(t=>overlaps(t.x-t.radius-120,t.x+t.radius+120,t.z-t.radius-120,t.z+t.radius+120)))return null;
  const region=world.collectRegion(x0,x1,z0,z1);
  const early:Interval[]=[],solid:Interval[]=[];
  const append=(boxes:readonly Box[],target:Interval[],apron=EPS)=>{
    for(const b of boxes)if(overlaps(b.x-b.hx-apron,b.x+b.hx+apron,b.z-b.hz-apron,b.z+b.hz+apron))
      target.push({lo:b.y-b.hy-apron,hi:b.y+b.hy+apron});
  };
  append(region.boulders,early);append(region.pads,early,.6+EPS);append(region.solids,solid);
  for(const v of region.vegetation)if(overlaps(v.x-v.radius-EPS,v.x+v.radius+EPS,v.z-v.radius-EPS,v.z+v.radius+EPS))
    solid.push({lo:v.y-(v.sink??0)-EPS,hi:v.y+v.height+EPS});
  for(const {a,b} of region.capitalSegments??[]){
    const r=Math.max(a.radius,b.radius)+EPS;
    if(overlaps(Math.min(a.x,b.x)-r,Math.max(a.x,b.x)+r,Math.min(a.z,b.z)-r,Math.max(a.z,b.z)+r))
      solid.push({lo:Math.min(a.y,b.y)-r,hi:Math.max(a.y,b.y)+r});
  }
  // Clamp/cut max operations cannot introduce solid into air. A covering
  // foundation can additionally restore positivity after the early unions.
  const clamps=(region.foundations??[]).filter(f=>f.x-f.hx<=x0&&f.x+f.hx>=x1&&f.z-f.hz<=z0&&f.z+f.hz>=z1);
  return{floor:abyss?-60+EPS:city.y,x0,x1,z0,z1,early,solid,clamps,bridges:region.transportBridges};
}

export function proveCapsuleAirPrism(world:World,x:number,y:number,z:number):boolean {
  if(!nativeWorld||!Number.isFinite(x+y+z)||Math.max(Math.abs(x),Math.abs(y),Math.abs(z))>100_000)return false;
  const proof=cache.get(world);
  if(!proof||Object.getPrototypeOf(world)!==nativeWorld.prototype)return false;
  const w=world as unknown as {landscape:Provider;noise:Provider};
  const canonical=()=>proof.seed===world.seed&&proof.landscape===w.landscape&&proof.noise===w.noise&&
    proof.landscapeSeed===w.landscape.seed&&proof.noiseSeed===w.noise.seed&&
    proof.naturalHeight===w.landscape.naturalHeight&&proof.base===w.landscape.base&&
    matches(world,nativeWorld!)&&matches(w.landscape,nativeLandscape)&&matches(w.noise,nativeNoise)&&matches(world.outposts,nativeOutpost)&&
    methodsMatch(SolidBoxIndex.prototype,nativeSolidBox);
  // Never call an injected collector during cheap rejection. Only descriptors
  // obtained through the complete saved-provider guard enter this cache.
  if(!proof.cities){if(!canonical())return false;proof.cities=world.collectCities();}
  const city=proof.cities.find(c=>(c.theme?
    (x-c.x)**2+(z-c.z)**2<(c.radius*.85)**2:Math.max(Math.abs(x-c.x),Math.abs(z-c.z))<c.radius));
  if(!city||!canonical())return false;
  const ix=Math.floor(x/CELL),iz=Math.floor(z/CELL),key=`${ix},${iz}`;
  let cell=proof.cells.get(key);
  if(cell===undefined){cell=buildCell(world,city,ix,iz);if(proof.cells.size>=CACHE_LIMIT)proof.cells.delete(proof.cells.keys().next().value!);proof.cells.set(key,cell);}
  if(!cell){return false;}
  const y0=y+PLAYER.RADIUS-REACH,y1=y+PLAYER.HEIGHT-PLAYER.RADIUS+REACH;
  if(!(y0>cell.floor+EPS))return false;
  const overlap=(interval:Interval)=>interval.hi>=y0&&interval.lo<=y1;
  const clamped=cell.clamps.some(f=>y0>f.y+f.hy+EPS&&(!f.underground||y1<=f.y+f.hy+.6-EPS));
  if(cell.solid.some(overlap)||!clamped&&cell.early.some(overlap)){return false;}
  const cy=(y0+y1)/2,reach=Math.hypot(REACH,REACH,(y1-y0)/2)+EPS;
  if(cell.bridges&&(!matches(cell.bridges,nativeBridge)||cell.bridges.distance(x,cy,z,reach)<reach))return false;
  if(world.outposts.distance(x,cy,z,reach)<reach||world.motionTime!==undefined&&
    (!Number.isFinite(world.motionTime)||transitDistance(world,world.motionTime,x,cy,z,reach)<reach)){
    return false;
  }
  const hulls=world.pedestrianCollisions;
  if(hulls&&(hulls.distance!==nativeHullDistance||hulls.distance(x,cy,z,reach)<reach)){return false;}
  return true;
}
