import { mainCoastDistance, OFFSHORE_ISLANDS, surfaceLiquidVolumes } from '@shared/liquids';
import type { World, RoadSegment } from '@shared/worldgen';
import type { TransportPlan } from '@shared/transport';
import type { WorldMapStream } from './world-map-stream.js';
import { FACTIONS, type FrontierState } from '@shared/frontier';
import { contactColor, declutterMapLoot, EMPTY_MAP_INTEL, localMapPoint, type MapIntel } from './tactical-intel.js';
import { shortControlName } from './map-labels.js';
import { controlActivity } from './territory-map.js';

export const MAP_SIZE=600, MAP_SPAN=24576;
export const mapPoint=(p:{x:number;z:number})=>({x:MAP_SIZE/2+p.x/MAP_SPAN*MAP_SIZE,y:MAP_SIZE/2+p.z/MAP_SPAN*MAP_SIZE});
/** Displace only overlapping hit targets; leader lines retain true locations. */
export function separateMapPins(points:readonly {x:number;y:number}[],gap:number):{x:number;y:number}[] {
  const placed:{x:number;y:number}[]=[],inset=Math.max(28,gap/2);
  for(const point of points) {
    let candidate={...point};
    for(let i=0;i<160&&placed.some(p=>Math.hypot(p.x-candidate.x,p.y-candidate.y)<gap);i++) {
      const r=gap*.45*Math.sqrt(i+1),angle=i*2.39996;
      candidate={x:Math.max(inset,Math.min(MAP_SIZE-inset,point.x+Math.cos(angle)*r)),y:Math.max(inset,Math.min(MAP_SIZE-inset,point.y+Math.sin(angle)*r))};
    }
    placed.push(candidate);
  }
  return placed;
}
const path=(points:readonly {x:number;z:number}[])=>points.map((p,i)=>{const v=mapPoint(p);return `${i?'L':'M'}${v.x.toFixed(2)},${v.y.toFixed(2)}`;}).join(' ');
const maps=new WeakMap<World,string>();
function complete<T>(steps:Generator<void,T,void>):T {
  for(;;){const next=steps.next();if(next.done)return next.value;}
}

/** Preserve separate road sections: city cutouts and lava detours are real gaps. */
export function roadMapPaths(roads: readonly RoadSegment[], toleranceMeters = 6): { roads: string; trails: string } {
  return complete(roadMapPathSteps(roads,toleranceMeters));
}
/** Simplify complete chains in the same order, with worker checkpoints. */
export function* roadMapPathSteps(roads: readonly RoadSegment[], toleranceMeters = 6): Generator<void, { roads: string; trails: string }, void> {
  const result = { roads: '', trails: '' };
  let chain: { x: number; z: number }[] = [], previous: RoadSegment | undefined;
  const flush = () => {
    if (chain.length < 2 || !previous) return;
    // The map does not need every 2 m curve chord. A 6 m tolerance remains
    // below a pixel even after zooming, while retaining switchbacks.
    const simplify = (points: typeof chain): typeof chain => {
      if (points.length < 3) return points;
      const a = points[0], b = points[points.length - 1], dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz;
      let farthest = toleranceMeters ** 2, split = -1;
      for (let i = 1; i + 1 < points.length; i++) {
        const p = points[i], t = length2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / length2)) : 0;
        const distance2 = (p.x - a.x - dx * t) ** 2 + (p.z - a.z - dz * t) ** 2;
        if (distance2 > farthest) { farthest = distance2; split = i; }
      }
      return split < 0 ? [a, b] : [...simplify(points.slice(0, split + 1)).slice(0, -1), ...simplify(points.slice(split))];
    };
    result[previous.trail ? 'trails' : 'roads'] += `${path(simplify(chain))} `;
  };
  for (const road of roads) {
    if (!previous || previous.id !== road.id || previous.trail !== road.trail || previous.b.x !== road.a.x || previous.b.z !== road.a.z) {
      flush(); yield; chain = [road.a];
    }
    chain.push(road.b); previous = road;
  }
  flush(); yield; return result;
}

export function mapViewport(center: { x: number; y: number }, zoom: number): { x: number; y: number; size: number } {
  const size = MAP_SIZE / Math.max(1, Math.min(4, zoom));
  return { x: Math.max(0, Math.min(MAP_SIZE - size, center.x - size / 2)),
    y: Math.max(0, Math.min(MAP_SIZE - size, center.y - size / 2)), size };
}

/** A quiet tactical basemap: geography orients the player; live control owns the contrast. */
export function worldMapSvg(world:World,plan:TransportPlan):string {
  const cached=maps.get(world);if(cached)return cached;
  const svg=buildWorldMapSvg(world,plan,true);maps.set(world,svg);return svg;
}
/** Publish/cache only complete artwork; cancellation leaves no partial map. */
export function* worldMapSvgSteps(world:World,plan:TransportPlan):Generator<void,string,void> {
  const cached=maps.get(world);if(cached)return cached;
  const svg=yield*buildWorldMapSvgSteps(world,plan,true,true);maps.set(world,svg);return svg;
}
/** Accurate coast, cities and transit are cheap enough for immediate use. */
export function worldMapOverviewSvg(world:World,plan:TransportPlan):string {
  return buildWorldMapSvg(world,plan,false);
}
function buildWorldMapSvg(world:World,plan:TransportPlan,detail:boolean):string {
  return complete(buildWorldMapSvgSteps(world,plan,detail,false));
}
function* buildWorldMapSvgSteps(world:World,plan:TransportPlan,detail:boolean,cooperative:boolean):Generator<void,string,void> {
  const coast=[];
  for(let i=0;i<160;i++) {
    const angle=i*Math.PI*2/160;let low=7500,high=11000;
    for(let j=0;j<16;j++){const r=(low+high)/2;if(mainCoastDistance(world.seed,Math.cos(angle)*r,Math.sin(angle)*r)>8500)high=r;else low=r;}
    coast.push({x:Math.cos(angle)*(low+high)/2,z:Math.sin(angle)*(low+high)/2});
    if(cooperative&&i%16===15)yield;
  }
  const outline=path(coast)+' Z';
  const islands=OFFSHORE_ISLANDS.map(island=>{const p=mapPoint(island);
    return `<circle cx="${p.x}" cy="${p.y}" r="${island.radius/MAP_SPAN*MAP_SIZE}" fill="#243a40" stroke="#607b80" stroke-opacity=".6" stroke-width=".8"/>`;}).join('');
  const lakes=surfaceLiquidVolumes().filter(v=>v.shape!=='ocean').map(v=>{
    if(v.points)return `<path d="${path(v.points)}" fill="none" stroke="#243f4b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`;
    const p=mapPoint(v);return `<ellipse cx="${p.x}" cy="${p.y}" rx="${v.rx/MAP_SPAN*MAP_SIZE}" ry="${v.rz/MAP_SPAN*MAP_SIZE}" fill="#152d39" stroke="#39505a" stroke-width=".5"/>`;
  }).join('');
  const cities=world.collectCities().map(c=>{const p=mapPoint(c),r=c.radius/MAP_SPAN*MAP_SIZE;
    return `<rect x="${p.x-r}" y="${p.y-r}" width="${r*2}" height="${r*2}" rx="${r*.35}" fill="#53666a" fill-opacity=".32" stroke="#809395" stroke-opacity=".35" stroke-width=".7"/>`;
  }).join('');
  const routes=plan.routes.map(r=>`<path d="${path(r.legs[0].points)}" fill="none" stroke="${r.kind==='train'?'#a89b73':'#57838e'}" stroke-opacity=".48" stroke-width="${r.kind==='train'?.75:.65}" ${r.kind==='ferry'?'stroke-dasharray="3 4"':''}/>`).join('');
  if(cooperative)yield;
  let roads={roads:'',trails:''};
  if(detail) {
    const segments=cooperative&&typeof world.collectMajorRoadSegmentSteps==='function'
      ?yield*world.collectMajorRoadSegmentSteps(-9000,9000,-9000,9000)
      :typeof world.collectMajorRoadSegments==='function'?world.collectMajorRoadSegments(-9000,9000,-9000,9000)
      :world.collectRoadSegments(-9000,9000,-9000,9000).filter(road=>!road.trail);
    roads=cooperative?yield*roadMapPathSteps(segments,65):roadMapPaths(segments,65);
  }
  const coordinates=Array.from({length:10},(_,i)=>`<text x="${50+i*50}" y="13" text-anchor="middle">${String.fromCharCode(65+i)}</text><text x="589" y="${55+i*50}" text-anchor="middle">${i+1}</text>`).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600" role="img" data-map-style="tactical" aria-label="Tactical map: coast, cities and transport routes">
    <defs><pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="#b3d6d9" stroke-opacity=".045"/></pattern><clipPath id="island"><path d="${outline}"/></clipPath></defs>
    <rect width="600" height="600" fill="#102531"/><path d="${outline}" fill="#243a40" stroke="#607b80" stroke-opacity=".6" stroke-width=".8"/>${islands}
    <g clip-path="url(#island)"><g class="map-roads" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="${roads.roads}" stroke="#97a59c" stroke-opacity=".24" stroke-width=".55"/></g>${cities}</g>${lakes}${routes}<rect width="600" height="600" fill="url(#grid)"/>
    <g fill="#80a6af" font-family="sans-serif" font-size="7" opacity=".65">${coordinates}</g>
    <g fill="#95bdc8" font-family="sans-serif" font-size="9" letter-spacing="3"><text x="235" y="38">NORTHERN OCEAN</text><text x="235" y="568">SOUTHERN OCEAN</text></g>
    <path d="M35 67V29M30 37L35 28L40 37M32 67H38" fill="none" stroke="#d9e8da" stroke-width="1.3"/><text x="35" y="21" text-anchor="middle" fill="#d9e8da" font-family="sans-serif" font-size="11">N</text>
    <path d="M29 559v6h122v-6M90 565v-4" fill="none" stroke="#b4cbd0"/><text x="29" y="580" fill="#b4cbd0" font-family="sans-serif" font-size="10">0</text><text x="134" y="580" fill="#b4cbd0" font-family="sans-serif" font-size="10">5 km</text>
  </svg>`;
  return svg;
}

export class NavigationMap {
  readonly element=document.createElement('aside');
  private canvas=document.createElement('canvas');
  private heading=document.createElement('div');
  private status=document.createElement('div');
  private objective=document.createElement('div');
  private context:CanvasRenderingContext2D;
  private image:HTMLCanvasElement|null=null;
  private imageUrl:string|null=null;
  private plan:TransportPlan|null=null;
  private shown=localStorage.getItem('mmofps-minimap')==='1';
  private lastDraw=-Infinity;
  private stopArtwork: (()=>void)|undefined;
  private state:FrontierState|null=null;
  private intel:MapIntel=EMPTY_MAP_INTEL;
  private canvasPixels=220;
  private resizeObserver:ResizeObserver;
  constructor() {
    this.element.id='navigation-map';this.element.setAttribute('aria-label','Minimap and compass');
    this.canvas.width=this.canvas.height=256;this.context=this.canvas.getContext('2d')!;
    this.heading.className='navigation-heading';this.status.className='navigation-status';this.objective.className='navigation-objective';
    this.element.append(this.status,this.canvas,this.heading,this.objective);
    document.body.append(this.element);this.element.hidden=!this.shown;
    this.resizeObserver=new ResizeObserver(entries=>{const width=entries[0]?.contentRect.width;if(width)this.canvasPixels=width;});
    this.resizeObserver.observe(this.canvas);
  }
  setWorld(world:World,artwork:WorldMapStream):void {
    this.plan=world.collectTransportPlan();this.image=null;this.lastDraw=-Infinity;this.state=null;this.intel=EMPTY_MAP_INTEL;
    this.stopArtwork?.();this.stopArtwork=artwork.subscribe(svg=>{
      // Destination maps also use this World cache. They must reuse the
      // current artwork rather than rebuilding terrain on their first open.
      maps.set(world,svg);this.setArtwork(svg);
    });
  }
  private setArtwork(svg:string):void {
    if(this.imageUrl)URL.revokeObjectURL(this.imageUrl);
    this.imageUrl=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
    const image=new Image();image.onload=()=>{
      if(image.src!==this.imageUrl)return;
      // Rasterize once. Panning the minimap then copies a small bitmap crop,
      // instead of repainting the complete SVG on every navigation frame.
      const raster=document.createElement('canvas');raster.width=raster.height=1200;
      raster.getContext('2d')!.drawImage(image,0,0,1200,1200);this.image=raster;
    };image.src=this.imageUrl;
  }
  toggle():void {this.shown=!this.shown;localStorage.setItem('mmofps-minimap',this.shown?'1':'0');this.element.hidden=!this.shown;}
  receive(state:FrontierState):void {this.state=state;}
  setIntel(intel:MapIntel):void {this.intel=intel;}
  clearIntel():void {this.intel=EMPTY_MAP_INTEL;this.state=null;this.lastDraw=-Infinity;}
  update(x:number,z:number,yaw:number,seconds:number,hidden=false):void {
    this.element.hidden=!this.shown||hidden;
    if(this.element.hidden||seconds-this.lastDraw<.08)return;this.lastDraw=seconds;
    const span=this.intel.vehicle===3?4000:2000,c=this.context,p=mapPoint({x,z}),crop=MAP_SIZE*span/MAP_SPAN;
    const point=(position:{x:number;z:number})=>({x:128+(position.x-x)/span*256,y:128+(position.z-z)/span*256});
    const visible=(p:{x:number;y:number})=>p.x>6&&p.x<250&&p.y>6&&p.y<250;
    const labelSize=9*256/Math.max(120,this.canvasPixels),labels:{text:string;x:number;y:number;color:string;priority:number}[]=[];
    c.clearRect(0,0,256,256);c.fillStyle='#0b2533';c.fillRect(0,0,256,256);
    if(this.image)c.drawImage(this.image,(p.x-crop/2)*2,(p.y-crop/2)*2,crop*2,crop*2,0,0,256,256);
    c.strokeStyle='#afced333';c.lineWidth=1;
    for(const radius of [64,120]){c.beginPath();c.arc(128,128,radius,0,Math.PI*2);c.stroke();}
    c.beginPath();c.moveTo(128,0);c.lineTo(128,256);c.moveTo(0,128);c.lineTo(256,128);c.stroke();
    c.save();c.translate(128,128);c.rotate(-yaw);c.fillStyle='#f4e7b316';c.beginPath();c.moveTo(0,0);c.arc(0,0,120,-Math.PI*.71,-Math.PI*.29);c.closePath();c.fill();c.restore();
    for(const battle of this.state?.battles??[]) {
      const b=point(battle);if(!visible(b))continue;
      c.fillStyle='#fba44d26';c.strokeStyle='#ffc87599';c.lineWidth=1.5;c.setLineDash([3,4]);c.beginPath();c.arc(b.x,b.y,12+battle.intensity*12,0,Math.PI*2);c.fill();c.stroke();c.setLineDash([]);
    }
    for(const base of this.state?.bases??[]) {
      const b=point(base);if(!visible(b))continue;
      c.fillStyle=FACTIONS[base.owner].color;c.strokeStyle='#081c24';c.lineWidth=2;c.fillRect(b.x-6,b.y-6,12,12);c.strokeRect(b.x-6,b.y-6,12,12);
      labels.push({text:base.name.toUpperCase(),x:b.x,y:b.y-12,color:'#edf1de',priority:2});
    }
    for(const site of this.state?.territories??[]) {
      const s=point(site);if(!visible(s))continue;
      const activity=controlActivity(site),active=activity.active,radius=Math.max(active?9:6,site.radius/span*256);
      c.strokeStyle=active?'#e7e4c74d':FACTIONS[site.owner].color;c.fillStyle=`${FACTIONS[site.owner].color}18`;c.lineWidth=1;
      c.beginPath();c.arc(s.x,s.y,radius,0,Math.PI*2);c.fill();c.stroke();
      if(active){c.strokeStyle=activity.color;c.lineWidth=2.5;if(activity.kind==='contested')c.setLineDash([3,3]);
        c.beginPath();c.arc(s.x,s.y,radius,-Math.PI/2,-Math.PI/2+Math.PI*2*(activity.kind==='contested'?1:Math.max(.03,activity.progress)));c.stroke();c.setLineDash([]);}
      c.fillStyle=FACTIONS[site.owner].color;c.beginPath();c.arc(s.x,s.y,3.5,0,Math.PI*2);c.fill();
      if(active||Math.hypot(site.x-x,site.z-z)<600)labels.push({text:active?activity.label:shortControlName(site.name).toUpperCase(),x:s.x,y:s.y+radius+labelSize,color:active?'#ffe0a3':'#e5e9d4',priority:active?0:1});
    }
    for(const pod of this.plan?.pods??[]) {
      const dx=128+(pod.x-x)/span*256,dz=128+(pod.z-z)/span*256;
      if(dx<8||dx>248||dz<8||dz>248)continue;
      c.fillStyle='#c4b7ff';c.beginPath();c.moveTo(dx,dz-5);c.lineTo(dx+4,dz);c.lineTo(dx,dz+5);c.lineTo(dx-4,dz);c.closePath();c.fill();
    }
    let friendly=0,hostile=0,bossOnRim=false;
    for(const contact of declutterMapLoot(this.intel.contacts,x,z,span/Math.max(120,this.canvasPixels)*16,4)) {
      const raw=point(contact),boss=contact.kind==='boss';if(!visible(raw)&&!boss)continue;
      if(!visible(raw)&&boss){if(bossOnRim)continue;bossOnRim=true;}
      const at=boss?localMapPoint(contact.x,contact.z,x,z,span):raw;
      if(visible(raw)){if(contact.relation==='friendly')friendly++;if(contact.relation==='hostile')hostile++;}
      c.save();c.translate(at.x,at.y);c.fillStyle=contactColor(contact);c.strokeStyle='#071922';c.lineWidth=1.5;
      if(boss){c.beginPath();c.moveTo(0,-8);c.lineTo(7,-4);c.lineTo(7,4);c.lineTo(0,8);c.lineTo(-7,4);c.lineTo(-7,-4);c.closePath();c.fill();c.stroke();c.font='bold 11px sans-serif';c.textAlign='center';c.fillStyle='#281c16';c.fillText('!',0,4);}
      else if(contact.kind==='vehicle'||contact.kind==='aircraft'){c.rotate(-contact.yaw);c.beginPath();c.moveTo(0,-6);c.lineTo(5,4);c.lineTo(-5,4);c.closePath();c.fill();c.stroke();}
      else if(contact.kind==='loot'){c.fillRect(-4,-4,8,8);c.strokeRect(-4,-4,8,8);}
      else{c.beginPath();c.arc(0,0,contact.kind==='creature'?2.5:3,0,Math.PI*2);c.fill();c.stroke();}
      c.restore();
    }
    const order=this.state?.order;
    if(order) {
      const goal=order.phase==='assemble'?order.staging:order,at=localMapPoint(goal.x,goal.z,x,z,span);
      c.strokeStyle='#ffe3a6';c.lineWidth=2;c.beginPath();c.moveTo(at.x,at.y-9);c.lineTo(at.x+9,at.y);c.lineTo(at.x,at.y+9);c.lineTo(at.x-9,at.y);c.closePath();c.stroke();
      const distance=Math.hypot(goal.x-x,goal.z-z);this.objective.textContent=`${order.phase.toUpperCase()} · ${order.name} · ${distance>1000?(distance/1000).toFixed(1)+' km':Math.round(distance)+' m'}`;
    }else this.objective.textContent='G · Open tactical map';
    if(this.state?.death){const d=point(this.state.death);if(visible(d)){c.strokeStyle='#ff9993';c.lineWidth=2;c.beginPath();c.moveTo(d.x-4,d.y-4);c.lineTo(d.x+4,d.y+4);c.moveTo(d.x+4,d.y-4);c.lineTo(d.x-4,d.y+4);c.stroke();}}
    c.font=`bold ${labelSize}px sans-serif`;c.textAlign='center';
    const placed:{x:number;y:number;width:number}[]=[];
    for(const label of labels.sort((a,b)=>a.priority-b.priority||Math.hypot(a.x-128,a.y-128)-Math.hypot(b.x-128,b.y-128))) {
      if(placed.length>=(this.canvasPixels<180?3:5))break;
      let text=label.text;while(text.length>4&&c.measureText(text).width>214)text=text.slice(0,-2).trimEnd()+'…';
      const width=c.measureText(text).width,px=Math.max(width/2+7,Math.min(249-width/2,label.x)),py=Math.max(labelSize+5,Math.min(249,label.y));
      if(placed.some(prior=>Math.abs(prior.x-px)<(prior.width+width)/2+5&&Math.abs(prior.y-py)<labelSize+4))continue;
      placed.push({x:px,y:py,width});c.lineWidth=3;c.strokeStyle='#061a24';c.strokeText(text,px,py);c.fillStyle=label.color;c.fillText(text,px,py);
    }
    c.save();c.translate(128,128);c.rotate(-yaw);c.fillStyle='#ffe1a1';c.strokeStyle='#112831';c.lineWidth=2;
    c.beginPath();c.moveTo(0,-12);c.lineTo(8,9);c.lineTo(0,5);c.lineTo(-8,9);c.closePath();c.fill();c.stroke();c.restore();
    const bearing=((Math.round(-yaw*180/Math.PI)%360)+360)%360,dirs=['N','NE','E','SE','S','SW','W','NW'];
    this.heading.textContent=`${dirs[Math.round(bearing/45)%8]} ${String(bearing).padStart(3,'0')}° · ${span/1000} KM · M`;
    this.status.textContent=`LOCAL CONTACTS   ${friendly} FRIENDLY / ${hostile} HOSTILE`;
    this.status.dataset.hostile=String(hostile>0);
  }
  dispose():void {this.resizeObserver.disconnect();this.stopArtwork?.();if(this.imageUrl)URL.revokeObjectURL(this.imageUrl);this.element.remove();}
}
