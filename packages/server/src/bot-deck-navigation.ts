// Quiet travel on native elevated Vesper decks; physical collision remains authoritative.
import {PLAYER,TICK_RATE} from '@shared/constants';
import {World,type Box,type Region,type CityDistrict} from '@shared/worldgen';
import type {KinState} from '@shared/physics';
import {transitDistance} from '@shared/transit-motion';
import {surfaceLiquidVolumes} from '@shared/liquids';
import {walkingHullClearance} from './bot-walk-clearance.js';

type Goal={kind:'course'|'pickup'|'vehicle',id:string|number,x:number,z:number};
export type DeckRect={x0:number;x1:number;z0:number;z1:number};
type Lease=DeckRect&{x:number;y:number;z:number;yaw:number;tick:number;mode:'course'|'hold'|'wall'};
type Space=DeckRect&{world:World;floor:number;region:Region;boxes:readonly Box[];city:CityDistrict};
const WIDTH=PLAYER.RADIUS+.12,EPS=1e-6,RETRY=12,ABANDON=120,MAX_BOXES=24;
const TURNS=[0,.7,-.7,1.4,-1.4,2.1,-2.1,Math.PI] as const;
const LENGTHS=[8,4] as const;
const nativePrototype=World.prototype,nativeCity=World.prototype.collectCities,nativeGuard=World.prototype.hasNativeTerrainProviders;
// A city core disables lava; the existing surface-water table has this finite ceiling.
const WATER_CEILING=Math.max(...surfaceLiquidVolumes().flatMap(v=>[v.level,...(v.points??[]).map(p=>p.level)]));
const overlaps=(b:Box,r:DeckRect,y0:number,y1:number)=>b.x+b.hx>=r.x0&&b.x-b.hx<=r.x1&&
 b.z+b.hz>=r.z0&&b.z-b.hz<=r.z1&&b.y+b.hy>=y0&&b.y-b.hy<=y1;
const inside=(outer:DeckRect,inner:DeckRect)=>inner.x0>=outer.x0&&inner.x1<=outer.x1&&inner.z0>=outer.z0&&inner.z1<=outer.z1;
const native=(world:World)=>Object.getPrototypeOf(world)===nativePrototype&&
 world.hasNativeTerrainProviders===nativeGuard&&nativeGuard.call(world);

/** Exact finite rectangle-union coverage, with no endpoint interpolation.
 * Split at every clipped X boundary; on each positive-width slab union the
 * complete Z intervals. Closed box boundaries can join, but no gap can hide
 * between the slabs. Callers expand the requested footprint by EPS. */
export function deckUnionCovers(boxes:readonly Box[],cuts:readonly Box[],floor:number,r:DeckRect):boolean {
 if(!Number.isFinite(floor+r.x0+r.x1+r.z0+r.z1)||r.x0>=r.x1||r.z0>=r.z1||boxes.length>MAX_BOXES)return false;
 for(let i=0;i<cuts.length;i++)if(overlaps(cuts[i],r,floor-.25,floor+.25)){return false;}
 const selected:Box[]=[],xs=[r.x0,r.x1];
 for(let i=0;i<boxes.length;i++){
  const b=boxes[i];
  if(b.y+b.hy!==floor||b.hy<.25||!overlaps(b,r,floor-.2,floor))continue;
  selected.push(b);xs.push(Math.max(r.x0,b.x-b.hx),Math.min(r.x1,b.x+b.hx));
 }
 if(!selected.length||selected.length>MAX_BOXES)return false;
 xs.sort((a,b)=>a-b);
 const zs:Array<{lo:number;hi:number}>=[];
 for(let i=1;i<xs.length;i++){
  const lo=xs[i-1],hi=xs[i];if(!(hi>lo))continue;
  zs.length=0;
  for(let j=0;j<selected.length;j++){
   const b=selected[j];if(b.x-b.hx<=lo&&b.x+b.hx>=hi)zs.push({lo:b.z-b.hz,hi:b.z+b.hz});
  }
  zs.sort((a,b)=>a.lo-b.lo);let reach=r.z0;
  for(let j=0;j<zs.length&&reach<r.z1;j++){if(zs[j].lo>reach)return false;reach=Math.max(reach,zs[j].hi);}
  if(reach<r.z1)return false;
 }
 return true;
}

export class DeckNavigation {
 goal:Goal|undefined;lease:Lease|undefined;hold=false;abandon=false;active=false;
 private space:Space|undefined;private unsupportedAt:number|undefined;
 private progress:{best:number;at:number}|undefined;
 reset(){this.goal=this.lease=this.space=undefined;this.hold=this.abandon=this.active=false;this.unsupportedAt=undefined;this.progress=undefined;}
 target(kind:Goal['kind'],id:Goal['id'],x:number,z:number){
  if(!this.goal||this.goal.kind!==kind||this.goal.id!==id||Math.hypot(this.goal.x-x,this.goal.z-z)>.5){
   this.lease=undefined;this.unsupportedAt=undefined;this.progress=undefined;this.hold=this.abandon=false;
  }
  this.goal={kind,id,x,z};
 }
 // Flat authored support only. Include all four potentially pending physics ticks.
 private stopRect(s:KinState,yaw?:number):DeckRect {
  const speed=Math.hypot(s.vx,s.vz),time=1/PLAYER.FRICTION+4/TICK_RATE;
  const vx=s.px+s.vx*time,vz=s.pz+s.vz*time;
  const reserve=Math.max(PLAYER.RUN_SPEED,speed)*time;
  const fx=yaw===undefined?s.px:s.px-Math.sin(yaw)*reserve,fz=yaw===undefined?s.pz:s.pz-Math.cos(yaw)*reserve;
  return{x0:Math.min(s.px,vx,fx)-WIDTH-EPS,x1:Math.max(s.px,vx,fx)+WIDTH+EPS,
   z0:Math.min(s.pz,vz,fz)-WIDTH-EPS,z1:Math.max(s.pz,vz,fz)+WIDTH+EPS};
 }
 wake(s:KinState,tick:number,movingTarget?:{x:number;z:number}|null,world?:World):boolean {
  const l=this.lease;if(!l)return false; // No city/column work or early wake without a deck lease.
  const changed=!!this.goal&&this.goal.kind!=='course'&&(!movingTarget||Math.hypot(movingTarget.x-this.goal.x,movingTarget.z-this.goal.z)>.5);
  const invalid=changed||!s.grounded||Math.abs(s.py-l.y)>.6||!Number.isFinite(s.px+s.py+s.pz+s.vx+s.vy+s.vz)||
   !!world&&!native(world)||l.mode!=='hold'&&!this.stoppingInside(l,s,l.yaw)||
   l.mode!=='course'&&Math.hypot(s.px-l.x,s.pz-l.z)>=1;
  if(invalid){this.lease=undefined;return true;}return false;
 }
 private stoppingInside(r:DeckRect,s:KinState,yaw:number):boolean {
  // Scalar per-tick check: allocate a rectangle only during a fresh scan.
  const time=1/PLAYER.FRICTION+4/TICK_RATE,reserve=Math.max(PLAYER.RUN_SPEED,Math.hypot(s.vx,s.vz))*time;
  const vx=s.px+s.vx*time,vz=s.pz+s.vz*time,fx=s.px-Math.sin(yaw)*reserve,fz=s.pz-Math.cos(yaw)*reserve;
  return Math.min(s.px,vx,fx)-WIDTH-EPS>=r.x0&&Math.max(s.px,vx,fx)+WIDTH+EPS<=r.x1&&
   Math.min(s.pz,vz,fz)-WIDTH-EPS>=r.z0&&Math.max(s.pz,vz,fz)+WIDTH+EPS<=r.z1;
 }
 /** Returns undefined outside the narrow scope; caller retains its original branch. */
 steer(world:World,s:KinState,yaw:number,tick:number,side:number):number|undefined {
  this.abandon=false;
  return this.choose(world,s,yaw,tick,side);
 }
 private acquire(world:World,s:KinState):Space|undefined {
  // Called only at the existing quiet thought. Cheap city rejection precedes
  // both the full native guard and the single elevation column query.
  if(!s.grounded||!Number.isFinite(s.px+s.py+s.pz+s.vx+s.vy+s.vz)||Object.getPrototypeOf(world)!==nativePrototype||world.collectCities!==nativeCity)return;
  let city:CityDistrict|undefined;
  const cities=nativeCity.call(world);
  for(let i=0;i<cities.length;i++)if(cities[i].theme==='vesper'&&Math.abs(s.px-cities[i].x)<1500&&Math.abs(s.pz-cities[i].z)<1500){city=cities[i];break;}
  if(!city||!native(world))return;
  const old=this.space;
  if(old&&old.world===world&&old.city===city&&Math.abs(s.py-(old.floor+.1))<=.3&&
   s.px-10>=old.x0&&s.px+10<=old.x1&&s.pz-10>=old.z0&&s.pz+10<=old.z1)return old;
  const r={x0:s.px-20,x1:s.px+20,z0:s.pz-20,z1:s.pz+20};
  const ax=Math.max(Math.abs(r.x0-city.x),Math.abs(r.x1-city.x)),az=Math.max(Math.abs(r.z0-city.z),Math.abs(r.z1-city.z));
  // Same conservative abyss/rim/approach-axis bound as the native air proof.
  // The complete region is deep terrain, not a noise-sampled floor stencil.
  if(Math.hypot(ax,az)>=city.radius*.85-260-EPS||Math.max(ax,az)>=1550-EPS)return;
  const col=world.sampleColumn(s.px,s.pz);
  if(col.city!==city||col.cave||col.transport||col.templeSite||s.py-col.h<=3)return;
  if(world.collectCaveSites(r.x0,r.x1,r.z0,r.z1).length)return;
  const plan=world.collectTransportPlan();
  for(const station of plan.stations)if(station.x+194>=r.x0&&station.x-34<=r.x1&&station.z+194>=r.z0&&station.z-34<=r.z1)return;
  for(const access of plan.accesses)if(access.x+270>=r.x0&&access.x-270<=r.x1&&access.endZ+256>=r.z0&&access.startZ-256<=r.z1)return;
  for(const lift of world.collectCityLifts())if(lift.x+lift.hx>=r.x0&&lift.x-lift.hx<=r.x1&&lift.z+lift.hz>=r.z0&&lift.z-lift.hz<=r.z1)return;
  const region=world.collectRegion(r.x0,r.x1,r.z0,r.z1);
  let floor:number|undefined,best=Infinity;
  for(const box of region.solids){
   const top=box.y+box.hy,delta=Math.abs(s.py-(top+.1));
   if(box.capital&&box.hy>=.25&&delta<=.3&&delta<best&&Math.abs(s.px-box.x)<=box.hx&&Math.abs(s.pz-box.z)<=box.hz){floor=top;best=delta;}
  }
  if(floor===undefined||floor<=WATER_CEILING+1)return;
  const boxes=region.solids.filter(b=>b.capital&&b.y+b.hy===floor&&b.hy>=.25&&overlaps(b,r,floor-.2,floor));
  if(!boxes.length||boxes.length>MAX_BOXES)return;
  return this.space={...r,world,city,floor,region,boxes};
 }
 private dynamicClear(world:World,space:Space,r:DeckRect,tick:number):boolean {
  const x=(r.x0+r.x1)/2,z=(r.z0+r.z1)/2,y=space.floor+PLAYER.HEIGHT/2;
  const reach=Math.hypot((r.x1-r.x0)/2,(r.z1-r.z0)/2,PLAYER.HEIGHT/2)+.2;
  return world.outposts.distance(x,y,z,reach)>=reach&&transitDistance(world,tick/TICK_RATE,x,y,z,reach)>=reach&&
   (space.region.transportBridges?.distance(x,y,z,reach)??reach)>=reach;
 }
 private choose(world:World,s:KinState,yaw:number,tick:number,side:number):number|undefined {
  const space=this.acquire(world,s);
  if(!space){this.lease=this.space=undefined;this.active=this.hold=false;this.unsupportedAt=undefined;this.progress=undefined;return;}
  this.active=true;
  if(this.goal&&this.goal.kind!=='course'){
   const distance=Math.hypot(s.px-this.goal.x,s.pz-this.goal.z);
   if(!this.progress||distance<this.progress.best-1)this.progress={best:distance,at:tick};
   else if(tick-this.progress.at>=180){this.abandon=this.hold=true;return yaw;}
  }
  const hullClear=walkingHullClearance(world,s,tick);
  if(this.lease&&tick-this.lease.tick<(this.lease.mode==='course'?28:RETRY)&&
   !this.wake(s,tick,this.goal)&&hullClear(this.lease.yaw)&&this.dynamicClear(world,space,this.lease,tick)){
   this.hold=this.lease.mode==='hold';return this.lease.yaw;
  }
  this.lease=undefined;this.hold=false;
  const stopping=this.stopRect(s);let blocked:Lease|undefined;
  for(let i=0;i<TURNS.length;i++){
   const heading=yaw+TURNS[i]*side,dx=-Math.sin(heading),dz=-Math.cos(heading);
   let rectangle:DeckRect|undefined;
   // Long clear leases preserve normal thought cadence away from deck edges.
   // Near an edge the shorter original four-metre course can still be used.
   for(const length of LENGTHS){
    const r={x0:Math.min(stopping.x0,s.px+dx*length-WIDTH-EPS),x1:Math.max(stopping.x1,s.px+dx*length+WIDTH+EPS),
     z0:Math.min(stopping.z0,s.pz+dz*length-WIDTH-EPS),z1:Math.max(stopping.z1,s.pz+dz*length+WIDTH+EPS)};
    if(inside(space,r)&&deckUnionCovers(space.boxes,space.region.cuts,space.floor,r)){rectangle=r;break;}
   }
   if(!rectangle)continue;
   const lease:Lease={...rectangle,x:s.px,y:s.py,z:s.pz,yaw:heading,tick,mode:'course'};
   if(!this.dynamicClear(world,space,rectangle,tick)||!hullClear(heading)){blocked??=lease;continue;}
   const hit=world.trace(s.px,s.py+1.05,s.pz,dx,0,dz,4,false);
   if(hit.hit&&hit.dist<4){blocked??=lease;continue;}
   const speed=Math.hypot(s.vx,s.vz),along=s.vx*dx+s.vz*dz,lateral=Math.abs(s.vx*dz-s.vz*dx);
   if(!inside(rectangle,this.stopRect(s,heading))||speed>2&&(lateral>2||along<0)){
    this.hold=true;lease.mode='hold';
   }
   this.lease=lease;this.unsupportedAt=undefined;return heading;
  }
  if(blocked){this.lease={...blocked,mode:'wall'};this.unsupportedAt=undefined;return blocked.yaw;}
  this.hold=true;this.unsupportedAt??=tick;
  if(this.goal?.kind!=='course'&&tick-this.unsupportedAt>=ABANDON){this.abandon=true;this.unsupportedAt=undefined;}
  this.lease={...stopping,x:s.px,y:s.py,z:s.pz,yaw,tick,mode:'hold'};return yaw;
 }
}
