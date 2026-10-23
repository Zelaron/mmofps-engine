import { PLAYER } from '@shared/constants';
import type { World, TraceHit } from '@shared/worldgen';
import type { KinState } from '@shared/physics';
import { walkingHullClearance } from './bot-walk-clearance.js';

type Point = { x:number; y:number; z:number };
type Goal = { x:number; z:number };
const NORMAL=.82, LEG=16, RISE=.45, REACH=1.2;

/** A bounded connector for navigation only. Movement still uses the complete
 * shared capsule controller. Rays must start in air and find real support;
 * field magnitude is never treated as metres of clearance. */
export function connectedGround(world:World,start:Point,end:Goal,tick:number,requireRecovery=true):Point[]|null {
  const length=Math.hypot(end.x-start.x,end.z-start.z);
  if(!Number.isFinite(length)||length<=0||length>LEG+1)return null;
  const dx=(end.x-start.x)/length,dz=(end.z-start.z)/length,count=Math.ceil(length),stride=length/count;
  const support=(x:number,y:number,z:number,computeNormal=true):TraceHit|null=>{
    if(world.sdf(x,y+1,z)<=0)return null;
    const floor=world.trace(x,y+1,z,0,-1,0,2.2,computeNormal);
    return floor.hit&&floor.dist>.001&&!world.liquidAt(x,floor.y+.2,z)?floor:null;
  };
  let floor=support(start.x,start.y,start.z);
  if(!floor)return null;
  let previous={x:start.x,y:floor.y+.1,z:start.z},normal=floor.ny;
  const initialNormal=normal,points:Point[]=[];
  for(let i=1;i<=count;i++){
    const x=start.x+dx*stride*i,z=start.z+dz*stride*i;
    floor=support(x,previous.y,z);
    if(!floor)return null;
    const y=floor.y+.1,rise=y-previous.y;
    // A walker already on an unsustainable slope may leave downhill while
    // support improves, but the whole <=16 m leg must reach normal >=.82.
    if(normal<NORMAL?rise>.08||floor.ny<Math.max(initialNormal,normal-.002):floor.ny<NORMAL)return null;
    if(Math.abs(rise)>stride*RISE+.06)return null;
    for(const lateral of [-PLAYER.RADIUS,PLAYER.RADIUS]){
      // Flanks only compare support height; their normals are not consumed.
      const flank=support(x+dz*lateral,y,z-dx*lateral,false);
      if(!flank||Math.abs(flank.y-floor.y)>.55)return null;
    }
    const next={x,y,z},yaw=Math.atan2(-dx,-dz);
    if(!walkingHullClearance(world,{px:x,py:y,pz:z,vx:0,vy:0,vz:0,grounded:true},tick)(yaw))return null;
    const dy=next.y-previous.y,distance=Math.hypot(stride,dy);
    for(const lateral of [-PLAYER.RADIUS-.01,0,PLAYER.RADIUS+.01])for(const height of [.65,PLAYER.HEIGHT+.02]){
      const ox=previous.x+dz*lateral,oz=previous.z-dx*lateral,oy=previous.y+height;
      if(world.sdf(ox,oy,oz)<=0)return null;
      const hit=world.trace(ox,oy,oz,dx*stride/distance,dy/distance,dz*stride/distance,distance,false);
      if(hit.hit&&hit.dist<=distance)return null;
    }
    points.push(next);previous=next;normal=floor.ny;
  }
  return !requireRecovery||normal>=NORMAL?points:null;
}

/** Called only after the ordinary scheduled chest feeler hits rising terrain.
 * Structures and cave walls keep their existing obstacle response. */
export function supportedTerrainRise(world:World,state:KinState,yaw:number,hit:TraceHit,tick:number):boolean {
  if(!hit.hit)return false;
  const column=world.sampleColumn(state.px,state.pz);
  if(column.cave||hit.y>world.sampleColumn(hit.x,hit.z).h+.05||state.py<column.h-.3)return false;
  return !!connectedGround(world,{x:state.px,y:state.py,z:state.pz},
    {x:state.px-Math.sin(yaw)*4,z:state.pz-Math.cos(yaw)*4},tick);
}

interface Leg { points:Point[]; side:number; dx:number; dz:number }
function detourLeg(world:World,start:Point,goal:Goal,tick:number,previous?:Leg):Leg|undefined {
  const yaw=Math.atan2(-(goal.x-start.x),-(goal.z-start.z));
  const turns=previous?[0,.7,1.4,2.1,Math.PI].map(t=>t*previous.side):[0,.7,-.7,1.4,-1.4,2.1,-2.1,Math.PI];
  let best:Leg|undefined,score=Infinity;
  for(const turn of turns){
    const heading=yaw+turn,dx=-Math.sin(heading),dz=-Math.cos(heading);
    if(previous&&dx*previous.dx+dz*previous.dz<0)continue;
    const end={x:start.x+dx*LEG,z:start.z+dz*LEG};
    // Score the exact final sample, including the connector's normalization
    // and multiply order. Nominal end coordinates can differ by a last bit.
    const length=Math.hypot(end.x-start.x,end.z-start.z),count=Math.ceil(length),stride=length/count;
    const remaining=Math.hypot(goal.x-(start.x+(end.x-start.x)/length*stride*count),
      goal.z-(start.z+(end.z-start.z)/length*stride*count));
    // Retain candidate order and strict ties. A worse endpoint cannot replace
    // a validated leg, so its full support/body/hull proof would be unused.
    if(!(remaining<score))continue;
    const points=connectedGround(world,start,end,tick);
    if(!points)continue;
    score=remaining;best={points:points.filter((_,i)=>i%4===3||i===points.length-1),side:previous?.side??(Math.sign(turn)||1),dx,dz};
  }
  return best;
}

interface Contour extends Leg {
  key:string; index:number; until:number; goal:Goal; entryBest:number;
  travelled:number; last:Point; retryAt:number; planned:number;
  checkedAt:number; exitAt:number; checkedFrom:Point; checkedTo:Point; campStamp:string;
  sdf:World['sdf']; trace:World['trace']; liquid:World['liquidAt'];
  camps:World['outposts'];
  surfaceAt:number; surfaceFrom:Point; sampleColumn:World['sampleColumn'];
}

/** Keep one obstacle side while following short supported legs. Changing side
 * at every locally attractive endpoint recreates the hillside oscillation. */
export class GroundDetour {
  private current:Contour|undefined;
  private retryAfter=0;
  get active():boolean { return !!this.current; }

  clear(tick:number):void { this.current=undefined;this.retryAfter=tick+180; }

  begin(world:World,state:KinState,goal:Goal,key:string,best:number,tick:number):boolean {
    if(tick<this.retryAfter)return false;
    this.retryAfter=tick+180;
    const column=world.sampleColumn(state.px,state.pz);
    if(column.cave||state.py<column.h-.3)return false;
    const start={x:state.px,y:state.py,z:state.pz},next=detourLeg(world,start,goal,tick);
    if(!next)return false;
    this.current={...next,key,index:0,until:tick+3600,goal:{...goal},entryBest:best,
      travelled:0,last:start,retryAt:0,planned:LEG,checkedAt:0,exitAt:tick,checkedFrom:start,checkedTo:start,
      campStamp:'',sdf:world.sdf,trace:world.trace,liquid:world.liquidAt,camps:world.outposts,
      surfaceAt:tick+12,surfaceFrom:start,sampleColumn:world.sampleColumn};
    return true;
  }

  follow(world:World,state:KinState,key:string,tick:number):Goal|undefined {
    const c=this.current;if(!c)return;
    const start={x:state.px,y:state.py,z:state.pz};
    c.travelled+=Math.hypot(start.x-c.last.x,start.z-c.last.z);c.last=start;
    const remaining=Math.hypot(c.goal.x-start.x,c.goal.z-start.z);
    if(key!==c.key||tick>=c.until||c.travelled>=400||remaining<3){this.clear(tick);return;}
    // A fall or displacement can move a surface walker into a cave while a
    // leg is cached or waiting behind a blocker. Release this mode before it
    // can suppress cave recovery for the rest of the contour's lifetime.
    if(tick>=c.surfaceAt||Math.hypot(start.x-c.surfaceFrom.x,start.z-c.surfaceFrom.z)>.5||
      Math.abs(start.y-c.surfaceFrom.y)>.4||c.sampleColumn!==world.sampleColumn){
      const column=world.sampleColumn(start.x,start.z);
      if(column.cave||start.y<column.h-.3){this.clear(tick);return;}
      c.surfaceAt=tick+12;c.surfaceFrom=start;c.sampleColumn=world.sampleColumn;
    }
    // Check the longer exit connector only on the same bounded scan cadence.
    if(tick>=c.exitAt){
      c.exitAt=tick+12;
      if(remaining<c.entryBest-4&&connectedGround(world,start,
        {x:start.x+(c.goal.x-start.x)*LEG/remaining,z:start.z+(c.goal.z-start.z)*LEG/remaining},tick)){
        this.clear(tick);return;
      }
    }
    while(c.index<c.points.length&&Math.hypot(start.x-c.points[c.index].x,start.z-c.points[c.index].z)<REACH){c.index++;c.checkedAt=0;}
    if(c.index>=c.points.length&&tick>=c.retryAt){
      if(c.planned>=400){this.clear(tick);return;}
      const next=detourLeg(world,start,c.goal,tick,c);c.retryAt=tick+60;
      if(next){Object.assign(c,next);c.index=0;c.planned+=LEG;c.checkedAt=0;}
    }
    const next=c.points[c.index];
    if(!next)return {x:start.x,z:start.z};
    const yaw=Math.atan2(-(next.x-start.x),-(next.z-start.z));
    // Hull poses are mutable every tick. Do not cache this inexpensive guard.
    if(!walkingHullClearance(world,state,tick)(yaw))return this.blocked(start,tick);
    const stamp=world.outposts.sites.size?world.outposts.stamp(start.x,start.z):'empty';
    const ax=c.checkedTo.x-c.checkedFrom.x,az=c.checkedTo.z-c.checkedFrom.z,length2=ax*ax+az*az;
    const t=length2?Math.max(0,Math.min(1,((start.x-c.checkedFrom.x)*ax+(start.z-c.checkedFrom.z)*az)/length2)):0;
    const deviation=Math.hypot(start.x-c.checkedFrom.x-ax*t,start.z-c.checkedFrom.z-az*t);
    const heightDeviation=Math.abs(start.y-c.checkedFrom.y-(c.checkedTo.y-c.checkedFrom.y)*t);
    if(tick>=c.checkedAt||deviation>.5||heightDeviation>.4||stamp!==c.campStamp||c.camps!==world.outposts||
      c.sdf!==world.sdf||c.trace!==world.trace||c.liquid!==world.liquidAt){
      if(!connectedGround(world,start,next,tick,false))return this.blocked(start,tick);
      c.checkedAt=tick+12;c.checkedFrom=start;c.checkedTo=next;c.campStamp=stamp;
      c.sdf=world.sdf;c.trace=world.trace;c.liquid=world.liquidAt;
      c.camps=world.outposts;
    }
    return next;
  }

  private blocked(start:Point,tick:number):Goal {
    const c=this.current!;c.index=c.points.length;c.retryAt=Math.max(c.retryAt,tick+60);c.checkedAt=0;
    return {x:start.x,z:start.z};
  }
}
