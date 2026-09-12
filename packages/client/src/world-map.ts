import { islandCoastDistance, surfaceLiquidVolumes } from '@shared/liquids';
import type { World } from '@shared/worldgen';
import type { TransportPlan } from '@shared/transport';

export const MAP_SIZE=600, MAP_SPAN=24576;
export const mapPoint=(p:{x:number;z:number})=>({x:MAP_SIZE/2+p.x/MAP_SPAN*MAP_SIZE,y:MAP_SIZE/2+p.z/MAP_SPAN*MAP_SIZE});
/** Displace only overlapping hit targets; leader lines retain true locations. */
export function separateMapPins(points:readonly {x:number;y:number}[],gap:number):{x:number;y:number}[] {
  const placed:{x:number;y:number}[]=[];
  for(const point of points) {
    let candidate={...point};
    for(let i=0;i<160&&placed.some(p=>Math.hypot(p.x-candidate.x,p.y-candidate.y)<gap);i++) {
      const r=gap*.45*Math.sqrt(i+1),angle=i*2.39996;
      candidate={x:Math.max(28,Math.min(MAP_SIZE-28,point.x+Math.cos(angle)*r)),y:Math.max(28,Math.min(MAP_SIZE-28,point.y+Math.sin(angle)*r))};
    }
    placed.push(candidate);
  }
  return placed;
}
const path=(points:readonly {x:number;z:number}[])=>points.map((p,i)=>{const v=mapPoint(p);return `${i?'L':'M'}${v.x.toFixed(2)},${v.y.toFixed(2)}`;}).join(' ');
const maps=new WeakMap<World,string>();

/** Cartography uses the actual seed, coastline, basins and transit routes. */
export function worldMapSvg(world:World,plan:TransportPlan):string {
  const cached=maps.get(world);if(cached)return cached;
  const coast=[];
  for(let i=0;i<160;i++) {
    const angle=i*Math.PI*2/160;let low=7500,high=11000;
    for(let j=0;j<16;j++){const r=(low+high)/2;if(islandCoastDistance(world.seed,Math.cos(angle)*r,Math.sin(angle)*r)>8500)high=r;else low=r;}
    coast.push({x:Math.cos(angle)*(low+high)/2,z:Math.sin(angle)*(low+high)/2});
  }
  const outline=path(coast)+' Z';
  const relief=world.collectMountains(-8200,8200,-8200,8200).map(m=>{
    const p=mapPoint(m),rx=m.length/MAP_SPAN*MAP_SIZE,ry=m.width/MAP_SPAN*MAP_SIZE;
    return [1,.65,.32].map((s,i)=>`<ellipse cx="${p.x}" cy="${p.y}" rx="${rx*s}" ry="${ry*s}" transform="rotate(${m.dx?0:90} ${p.x} ${p.y})" fill="${i===2?'#849081':'none'}" fill-opacity=".3" stroke="#a9bda0" stroke-opacity=".18" stroke-width=".7"/>`).join('');
  }).join('');
  const lakes=surfaceLiquidVolumes().filter(v=>v.shape!=='ocean').map(v=>{
    if(v.points)return `<path d="${path(v.points)}" fill="none" stroke="#487b85" stroke-width="7.3" stroke-linecap="round" stroke-linejoin="round"/>`;
    const p=mapPoint(v);return `<ellipse cx="${p.x}" cy="${p.y}" rx="${v.rx/MAP_SPAN*MAP_SIZE}" ry="${v.rz/MAP_SPAN*MAP_SIZE}" fill="#376573" stroke="#79a8ac" stroke-width=".7"/>`;
  }).join('');
  const cities=world.collectCities().map(c=>{const p=mapPoint(c),r=c.radius/MAP_SPAN*MAP_SIZE;
    return `<rect x="${p.x-r}" y="${p.y-r}" width="${r*2}" height="${r*2}" rx="${r*.35}" fill="${c.theme==='aurelia'?'#ad9d66':c.theme==='vesper'?'#665b84':'#8b9c91'}" fill-opacity=".55" stroke="#becbb5" stroke-opacity=".5" stroke-width=".7"/>`;
  }).join('');
  const routes=plan.routes.map(r=>`<path d="${path(r.legs[0].points)}" fill="none" stroke="${r.kind==='train'?'#d0b97b':'#74cdd5'}" stroke-opacity=".68" stroke-width="${r.kind==='train'?1.2:1}" ${r.kind==='ferry'?'stroke-dasharray="3 4"':''}/>`).join('');
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600" viewBox="0 0 600 600" role="img" aria-label="Island terrain, rivers, cities and transit routes">
    <defs><radialGradient id="sea"><stop stop-color="#1b3f50"/><stop offset="1" stop-color="#071a29"/></radialGradient><linearGradient id="land" x2=".8" y2="1"><stop stop-color="#53695b"/><stop offset="1" stop-color="#243f42"/></linearGradient><pattern id="grid" width="50" height="50" patternUnits="userSpaceOnUse"><path d="M50 0H0V50" fill="none" stroke="#b3d6d9" stroke-opacity=".07"/></pattern><clipPath id="island"><path d="${outline}"/></clipPath></defs>
    <rect width="600" height="600" fill="url(#sea)"/><path d="${outline}" fill="none" stroke="#417885" stroke-opacity=".22" stroke-width="19"/>
    <path d="${outline}" fill="url(#land)" stroke="#a2bca8" stroke-opacity=".65" stroke-width="1.1"/>
    <g clip-path="url(#island)">${relief}${cities}</g>${lakes}${routes}<rect width="600" height="600" fill="url(#grid)"/>
    <g fill="#95bdc8" font-family="sans-serif" font-size="9" letter-spacing="3"><text x="235" y="38">NORTHERN OCEAN</text><text x="235" y="568">SOUTHERN OCEAN</text></g>
    <path d="M35 67V29M30 37L35 28L40 37M32 67H38" fill="none" stroke="#d9e8da" stroke-width="1.3"/><text x="35" y="21" text-anchor="middle" fill="#d9e8da" font-family="sans-serif" font-size="11">N</text>
    <path d="M29 559v6h122v-6M90 565v-4" fill="none" stroke="#b4cbd0"/><text x="29" y="580" fill="#b4cbd0" font-family="sans-serif" font-size="10">0</text><text x="134" y="580" fill="#b4cbd0" font-family="sans-serif" font-size="10">5 km</text>
  </svg>`;
  maps.set(world,svg);return svg;
}

export class NavigationMap {
  readonly element=document.createElement('aside');
  private canvas=document.createElement('canvas');
  private heading=document.createElement('div');
  private context:CanvasRenderingContext2D;
  private image:HTMLImageElement|null=null;
  private imageUrl:string|null=null;
  private plan:TransportPlan|null=null;
  private shown=localStorage.getItem('mmofps-minimap')==='1';
  private lastDraw=-Infinity;
  constructor() {
    this.element.id='navigation-map';this.element.setAttribute('aria-label','Minimap and compass');
    this.canvas.width=this.canvas.height=256;this.context=this.canvas.getContext('2d')!;
    this.heading.className='navigation-heading';this.element.append(this.canvas,this.heading);
    document.body.append(this.element);this.element.hidden=!this.shown;
  }
  setWorld(world:World):void {
    this.plan=world.collectTransportPlan();this.image=null;this.lastDraw=-Infinity;
    if(this.imageUrl)URL.revokeObjectURL(this.imageUrl);
    this.imageUrl=URL.createObjectURL(new Blob([worldMapSvg(world,this.plan)],{type:'image/svg+xml'}));
    const image=new Image();image.onload=()=>{if(image.src===this.imageUrl)this.image=image;};image.src=this.imageUrl;
  }
  toggle():void {this.shown=!this.shown;localStorage.setItem('mmofps-minimap',this.shown?'1':'0');this.element.hidden=!this.shown;}
  update(x:number,z:number,yaw:number,seconds:number,hidden=false):void {
    this.element.hidden=!this.shown||hidden;
    if(this.element.hidden||seconds-this.lastDraw<.08)return;this.lastDraw=seconds;
    const c=this.context,p=mapPoint({x,z}),crop=MAP_SIZE*3200/MAP_SPAN;
    c.clearRect(0,0,256,256);c.fillStyle='#0b2533';c.fillRect(0,0,256,256);
    if(this.image)c.drawImage(this.image,p.x-crop/2,p.y-crop/2,crop,crop,0,0,256,256);
    c.strokeStyle='#79989a66';c.lineWidth=1;c.beginPath();c.arc(128,128,82,0,Math.PI*2);c.stroke();
    for(const pod of this.plan?.pods??[]) {
      const dx=128+(pod.x-x)/3200*256,dz=128+(pod.z-z)/3200*256;
      if(dx<8||dx>248||dz<8||dz>248)continue;
      c.fillStyle='#89f1e0';c.beginPath();c.arc(dx,dz,4,0,Math.PI*2);c.fill();
    }
    c.save();c.translate(128,128);c.rotate(-yaw);c.fillStyle='#ffe1a1';c.strokeStyle='#112831';c.lineWidth=2;
    c.beginPath();c.moveTo(0,-12);c.lineTo(8,9);c.lineTo(0,5);c.lineTo(-8,9);c.closePath();c.fill();c.stroke();c.restore();
    const bearing=((Math.round(-yaw*180/Math.PI)%360)+360)%360,dirs=['N','NE','E','SE','S','SW','W','NW'];
    this.heading.textContent=`${dirs[Math.round(bearing/45)%8]}  ${String(bearing).padStart(3,'0')}°   ·   M`;
  }
  dispose():void {if(this.imageUrl)URL.revokeObjectURL(this.imageUrl);this.element.remove();}
}
