import type { RoadPoint, RoadSegment } from '@shared/landscape';
import type { CityDistrict } from '@shared/cities';
import type { World } from '@shared/worldgen';
import { vesperRoutes } from '@shared/vesper-city';
import { caveColumn, cavePathPoint } from '@shared/caves';

export interface NavigationWorld {
  collectRoadSegments(minX: number, maxX: number, minZ: number, maxZ: number): RoadSegment[];
  collectCities?(): readonly CityDistrict[];
  sdf?: World['sdf'];
  liquidAt?: World['liquidAt'];
  sampleColumn?: World['sampleColumn'];
}
type Point = { x: number; y?: number; z: number };
export interface CampaignWaypoint extends RoadPoint { street?: true }

/** A surface order cannot be reached through a hillside chamber wall. Once
 * local movement stops making progress, take the authored walking gallery
 * back to its mouth before retrying the surface route. */
export function campaignCaveExitRoute(world: NavigationWorld, start: Point, goal: Point): readonly CampaignWaypoint[] {
  if (start.y === undefined || !world.sampleColumn) return [];
  const column = world.sampleColumn(start.x, start.z), cave = column.cave;
  if (!cave || start.y + 3 >= column.h || Math.abs(start.y - cave.floor) > 5 || cave.footprint < -1) return [];
  const destination = caveColumn(cave.site, goal.x, goal.z);
  if (goal.y !== undefined && destination && destination.footprint > 1 && Math.abs(goal.y - destination.floor) < 5) return [];
  const forward = Math.max(0, Math.min(cave.site.length, cave.forward));
  const route: CampaignWaypoint[] = [cavePathPoint(cave.site, forward)];
  for (let distance = forward - 12; distance > 0; distance -= 12) route.push(cavePathPoint(cave.site, distance));
  route.push(cavePathPoint(cave.site, 0), cavePathPoint(cave.site, -28));
  return route;
}
interface Node { point: RoadPoint; links: Map<number, number> }
const cache = new WeakMap<NavigationWorld, Map<string, readonly CampaignWaypoint[]>>();
const STREET_CLEARANCE_PROBES = [[0,0,1.6],[-.45,0,.7],[.45,0,.7],[0,-.45,.7],[0,.45,.7]] as const;

/** A short connection to an avenue must not cut across an occupied building
 * or the void between Vesper's supported decks. All probes are local/bounded. */
function streetConnectionClear(world: NavigationWorld, start: Point, end: RoadPoint): boolean {
  if (!world.sdf) return true;
  const distance = Math.hypot(end.x-start.x,end.z-start.z), count = Math.max(1,Math.ceil(distance/6));
  for(let i=0;i<=count;i++) {
    const t=i/count,x=start.x+(end.x-start.x)*t,z=start.z+(end.z-start.z)*t,y=(start.y??end.y)+(end.y-(start.y??end.y))*t;
    if(world.sdf(x,y-.55,z)>0 || world.liquidAt?.(x,y+.2,z))return false;
    for(const [dx,dz,height] of STREET_CLEARANCE_PROBES)
      if(world.sdf(x+dx,y+height,z+dz)<0)return false;
  }
  return true;
}

/** Cities have an explicit pedestrian network that is different from the
 * terrain roads below or outside them. Preserve its supported right-angle
 * corners and junctions instead of inventing diagonal cuts through blocks. */
function cityRoadRoute(world: NavigationWorld, start: Point, goal: Point,
  routes: Map<string, readonly CampaignWaypoint[]>): readonly CampaignWaypoint[] | undefined {
  const city=world.collectCities?.().find(c=>Math.abs(goal.x-c.x)<=c.radius+1 && Math.abs(goal.z-c.z)<=c.radius+1 &&
    Math.abs(start.x-c.x)<=c.radius+280 && Math.abs(start.z-c.z)<=c.radius+280);
  if(!city)return;
  if(Math.hypot(start.x-goal.x,start.z-goal.z)<24)return [];
  const key=`city-${city.id}:${Math.floor(start.x/32)},${Math.floor(start.z/32)}:${Math.round(goal.x/16)},${Math.round(goal.z/16)}`;
  const retained=routes.get(key);
  // Nearby squad members share a bucket, not necessarily a clear approach.
  // Validate both real endpoints before reusing another member's connectors.
  if(retained?.length && streetConnectionClear(world,start,retained[0]) &&
    streetConnectionClear(world,goal,retained[retained.length-1]))return retained;
  const floor=city.y+.06;
  const point=(x:number,z:number):RoadPoint=>({x:city.x+x,y:floor,z:city.z+z});
  const lane=(a:RoadPoint,b:RoadPoint):RoadSegment=>({a,b,width:22,trail:false,id:`city-navigation:${city.id}`});
  const segments:RoadSegment[]=city.theme==='vesper'
    ? vesperRoutes(city).filter(r=>Math.abs(r.y-floor)<.1).map(r=>lane({x:r.ax,y:r.y,z:r.az},{x:r.bx,y:r.y,z:r.bz}))
    : city.theme==='aurelia'
      // The northern palace blocks its central axis. The public east/west
      // processional avenue and southern court connect all ground controls.
      ? [lane(point(-city.radius,0),point(city.radius,0)),lane(point(0,0),point(0,city.radius))]
      : world.collectRoadSegments(city.x-city.radius,city.x+city.radius,city.z-city.radius,city.z+city.radius)
        .filter(s=>s.id===`city:${city.id}`).map(s=>({...s,a:{...s.a,y:floor},b:{...s.b,y:floor}}));
  const project=(p:Point,s:RoadSegment)=>{
    const dx=s.b.x-s.a.x,dz=s.b.z-s.a.z,length2=dx*dx+dz*dz;
    const t=length2?Math.max(0,Math.min(1,((p.x-s.a.x)*dx+(p.z-s.a.z)*dz)/length2)):0;
    const point={x:s.a.x+dx*t,y:s.a.y+(s.b.y-s.a.y)*t,z:s.a.z+dz*t};
    return {t,point,distance:Math.hypot(point.x-p.x,point.z-p.z)};
  };
  const attach=(p:Point)=>segments.map((s,index)=>({...project(p,s),index})).filter(p=>p.distance<280)
    .sort((a,b)=>a.distance-b.distance).slice(0,4).find(candidate=>streetConnectionClear(world,p,candidate.point));
  const source=attach(start),target=attach(goal);
  let result:CampaignWaypoint[]=[];
  if(source && target) {
    const cuts=segments.map(()=>[0,1]);cuts[source.index].push(source.t);cuts[target.index].push(target.t);
    // City street segments cross in their interiors. Join those crossings,
    // including T junctions/overlapping bridge legs, at the actual deck height.
    for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++) {
      const a=segments[i],b=segments[j];if(Math.abs(a.a.y-b.a.y)>.1)continue;
      const ax=a.b.x-a.a.x,az=a.b.z-a.a.z,bx=b.b.x-b.a.x,bz=b.b.z-b.a.z,den=ax*bz-az*bx;
      if(Math.abs(den)>.00001) {
        const dx=b.a.x-a.a.x,dz=b.a.z-a.a.z,t=(dx*bz-dz*bx)/den,u=(dx*az-dz*ax)/den;
        if(t>=0&&t<=1&&u>=0&&u<=1){cuts[i].push(t);cuts[j].push(u);}
      } else {
        for(const p of [b.a,b.b]){const projected=project(p,a);if(projected.distance<.01)cuts[i].push(projected.t);}
        for(const p of [a.a,a.b]){const projected=project(p,b);if(projected.distance<.01)cuts[j].push(projected.t);}
      }
    }
    const nodes:Node[]=[],ids=new Map<string,number>();
    const node=(point:RoadPoint)=>{
      const id=`${Math.round(point.x*100)},${Math.round(point.z*100)}`;
      let index=ids.get(id);if(index===undefined){index=nodes.length;ids.set(id,index);nodes.push({point,links:new Map()});}return index;
    };
    for(let i=0;i<segments.length;i++) {
      const s=segments[i],ordered=[...new Set(cuts[i])].sort((a,b)=>a-b);
      const points=ordered.map(t=>({x:s.a.x+(s.b.x-s.a.x)*t,y:s.a.y,z:s.a.z+(s.b.z-s.a.z)*t}));
      for(let j=1;j<points.length;j++) {
        const a=node(points[j-1]),b=node(points[j]),length=Math.hypot(points[j].x-points[j-1].x,points[j].z-points[j-1].z);
        nodes[a].links.set(b,length);nodes[b].links.set(a,length);
      }
    }
    const origin=node(source.point),destination=node(target.point),costs=new Float64Array(nodes.length).fill(Infinity),
      previous=new Int32Array(nodes.length).fill(-1),open=new Set<number>([origin]),clearEdges=new Map<string,boolean>();costs[origin]=0;
    for(let budget=0;open.size&&budget<1024;budget++) {
      let current=-1,best=Infinity;
      for(const id of open){const p=nodes[id].point,score=costs[id]+Math.hypot(p.x-target.point.x,p.z-target.point.z);if(score<best){best=score;current=id;}}
      if(current===destination) {
        for(let id=destination;id>=0;id=previous[id])result.push({...nodes[id].point,street:true});
        result.reverse();break;
      }
      open.delete(current);
      for(const [next,length] of nodes[current].links)if(costs[current]+length<costs[next]) {
        // Authored avenues can still intersect added city structures. Check
        // only explored edges and choose another supported street when blocked.
        const edge=current<next?`${current}:${next}`:`${next}:${current}`;
        let clear=clearEdges.get(edge);
        if(clear===undefined){clear=streetConnectionClear(world,nodes[current].point,nodes[next].point);clearEdges.set(edge,clear);}
        if(!clear)continue;
        costs[next]=costs[current]+length;previous[next]=current;open.add(next);
      }
    }
    // Remove only collinear intermediate junctions; every physical bend stays.
    result=result.filter((p,i,all)=>{
      if(!i||i===all.length-1)return true;
      const a=all[i-1],b=all[i+1],ax=p.x-a.x,az=p.z-a.z,bx=b.x-p.x,bz=b.z-p.z;
      return Math.abs(ax*bz-az*bx)>.01 || ax*bx+az*bz<0;
    });
  }
  // A passing train can temporarily obstruct a connector; retry failed city
  // attachments on the next planning interval instead of caching them forever.
  if(result.length) {
    if(routes.size>=128)routes.delete(routes.keys().next().value!);
    routes.set(key,result);
  }
  return result;
}

/** Reuse the world's dry, graded road network. Routes are shared by nearby
 * squad members and bounded so a distant continent never triggers a world scan. */
export function campaignRoadRoute(world: NavigationWorld, start: Point, goal: Point): readonly CampaignWaypoint[] {
  const distance = Math.hypot(start.x-goal.x,start.z-goal.z);
  if (distance > 4200) return [];
  const key = `${Math.floor(start.x/128)},${Math.floor(start.z/128)}:${Math.round(goal.x/32)},${Math.round(goal.z/32)}`;
  let routes = cache.get(world);
  if (!routes) { routes = new Map(); cache.set(world,routes); }
  const cityRoute=cityRoadRoute(world,start,goal,routes);
  if(cityRoute!==undefined)return cityRoute;
  if(distance<180)return [];
  const retained = routes.get(key);
  if (retained) return retained;
  const segments = world.collectRoadSegments(Math.min(start.x,goal.x)-320,Math.max(start.x,goal.x)+320,
    Math.min(start.z,goal.z)-320,Math.max(start.z,goal.z)+320).filter(s=>!s.trail);
  const nodes: Node[] = [], ids = new Map<string,number>();
  const node = (p: RoadPoint): number => {
    const k = `${Math.round(p.x*100)},${Math.round(p.z*100)}`;
    const old = ids.get(k); if (old!==undefined) return old;
    const id=nodes.length; ids.set(k,id); nodes.push({point:p,links:new Map()}); return id;
  };
  for (const segment of segments) {
    if (nodes.length>8000) break;
    const a=node(segment.a), b=node(segment.b), cost=Math.hypot(segment.a.x-segment.b.x,segment.a.z-segment.b.z);
    nodes[a].links.set(b,cost); nodes[b].links.set(a,cost);
  }
  let source=-1,target=-1,sourceDistance=Infinity,targetDistance=Infinity;
  for (let i=0;i<nodes.length;i++) {
    const p=nodes[i].point, a=Math.hypot(p.x-start.x,p.z-start.z), b=Math.hypot(p.x-goal.x,p.z-goal.z);
    if(a<sourceDistance){source=i;sourceDistance=a;} if(b<targetDistance){target=i;targetDistance=b;}
  }
  let result: RoadPoint[]=[];
  if(source>=0 && target>=0 && sourceDistance<280 && targetDistance<280) {
    const costs=new Float64Array(nodes.length).fill(Infinity),previous=new Int32Array(nodes.length).fill(-1);
    const open=new Set<number>([source]); costs[source]=0;
    for(let budget=0;open.size && budget<8000;budget++) {
      let current=-1,best=Infinity;
      for(const id of open) {
        const p=nodes[id].point,score=costs[id]+Math.hypot(p.x-goal.x,p.z-goal.z);
        if(score<best){best=score;current=id;}
      }
      if(current===target) {
        for(let id=target;id>=0;id=previous[id])result.push(nodes[id].point);
        result.reverse(); break;
      }
      open.delete(current);
      for(const [next,length] of nodes[current].links)if(costs[current]+length<costs[next]) {
        costs[next]=costs[current]+length;previous[next]=current;open.add(next);
      }
    }
  }
  // If the available network takes a huge loop, let local movement/transport
  // handle this leg instead of spending several minutes circling the planet.
  const length=result.reduce((sum,p,i)=>sum+(i?Math.hypot(p.x-result[i-1].x,p.z-result[i-1].z):0),0);
  if(length>distance*3+400)result=[];
  if(routes.size>=128)routes.delete(routes.keys().next().value!);
  routes.set(key,result); return result;
}
