import type { TransportPlan } from '@shared/transport';
import type { World } from '@shared/worldgen';
import { airliftDuration } from '@shared/airlift';
import { mapPoint, separateMapPins, MAP_SIZE, worldMapSvg } from './world-map.js';

export class AirliftMap {
  readonly element=document.createElement('section');
  open=false;
  private abort=new AbortController();
  constructor(private travel:(destination:number)=>void,private changed:(open:boolean,resume:boolean)=>void,private orbital?:()=>void) {
    this.element.id='airlift-map';this.element.hidden=true;this.element.setAttribute('role','dialog');
    this.element.setAttribute('aria-label','Airlift destinations');this.element.setAttribute('aria-modal','true');
    document.body.append(this.element);
    document.addEventListener('keydown',e=>{
      if(!this.open)return;
      if(e.code==='Escape'){e.preventDefault();e.stopImmediatePropagation();this.close(true);}
      if(e.code==='Tab') {
        const buttons=[...this.element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index=buttons.indexOf(document.activeElement as HTMLButtonElement);
        e.preventDefault();buttons[(index+(e.shiftKey?buttons.length-1:1))%buttons.length]?.focus();
      }
    },{capture:true,signal:this.abort.signal});
  }
  show(plan:TransportPlan,source:number,world:World):void {
    const origin=plan.pods.find(p=>p.id===source);if(!origin)return;
    this.open=true;this.element.hidden=false;
    this.element.innerHTML=`<div class="airlift-card"><header><div><small>ISLAND TRANSIT AUTHORITY / POD SERVICE</small><h2>Where to next?</h2></div><button class="close" aria-label="Close destination map">×</button></header>
      <div class="airlift-departure"><span class="airlift-status-dot"></span><span>DEPARTING <strong></strong></span><span class="airlift-network-status">8 STATIONS ONLINE</span></div>
      <div class="airlift-body"><div class="airlift-chart">${worldMapSvg(world,plan)}<div class="airlift-map-markers"></div><div class="airlift-map-legend"><span>— RAIL</span><span>⋯ FERRY</span><span>● AIRLIFT</span></div></div>
      <div class="airlift-destinations"><small>SELECT ON THE MAP OR BELOW</small><nav aria-label="Destinations"></nav></div></div>
      <footer><span>Stay in the pod for the 3-second charge, then enjoy the flight.</span><span>M · MINIMAP & COMPASS</span></footer></div>`;
    this.element.querySelector('.airlift-departure strong')!.textContent=origin.name;
    const markers=this.element.querySelector('.airlift-map-markers')!, nav=this.element.querySelector('nav')!;
    if (this.orbital) {
      const button=document.createElement('button'); button.type='button'; button.className='airlift-destination';
      button.textContent='↗  LEAVE THIS PLANET · STAR SYSTEM';
      this.bindChoice(button,()=>{this.close(false);this.orbital?.();});nav.before(button);
    }
    const locations=plan.pods.map(mapPoint), width=this.element.querySelector('.airlift-chart')!.clientWidth||600;
    const positions=separateMapPins(locations,48*MAP_SIZE/width);
    for(const [index,pod] of plan.pods.entries()) {
      const current=pod.id===source, distance=Math.hypot(pod.x-origin.x,pod.z-origin.z)/1000;
      const seconds=Math.round(airliftDuration(origin,pod)),pos=positions[index],actual=locations[index];
      if(Math.hypot(actual.x-pos.x,actual.y-pos.y)>1) {
        const line=document.createElementNS('http://www.w3.org/2000/svg','path');
        line.setAttribute('d',`M${actual.x},${actual.y}L${pos.x},${pos.y}`);line.setAttribute('stroke','#c1e2d4');line.setAttribute('stroke-width','1');
        this.element.querySelector('svg')!.append(line);
      }
      const choose=()=>{this.travel(pod.id);this.close(true);};
      const marker=document.createElement('button');marker.type='button';marker.className='airlift-pin';marker.disabled=current;
      marker.style.left=`${pos.x/MAP_SIZE*100}%`;marker.style.top=`${pos.y/MAP_SIZE*100}%`;
      marker.setAttribute('aria-label',current?`${pod.name}, current station`:`Fly to ${pod.name}, ${distance.toFixed(1)} kilometers, ${seconds} seconds`);
      marker.title=marker.getAttribute('aria-label')!;
      const dot=document.createElement('span');dot.className='pin-dot';dot.textContent=String(pod.id);
      const label=document.createElement('span');label.className='pin-label';label.textContent=pod.name;
      marker.append(dot,label);this.bindChoice(marker,choose);markers.append(marker);
      const button=document.createElement('button');button.type='button';button.disabled=current;button.className='airlift-destination';
      const badge=document.createElement('span');badge.className='destination-number';badge.textContent=String(pod.id);
      const text=document.createElement('span'),name=document.createElement('strong'),detail=document.createElement('small');
      name.textContent=pod.name;detail.textContent=current?'CURRENT STATION':`${distance.toFixed(1)} km · ${seconds}s flight`;
      text.append(name,detail);const arrow=document.createElement('span');arrow.className='destination-arrow';arrow.textContent=current?'●':'↗';
      button.append(badge,text,arrow);this.bindChoice(button,choose);nav.append(button);
      const highlight=(on:boolean)=>{marker.classList.toggle('highlight',on);button.classList.toggle('highlight',on);};
      for(const el of [marker,button]){el.onpointerenter=()=>highlight(true);el.onpointerleave=()=>highlight(false);el.onfocus=()=>highlight(true);el.onblur=()=>highlight(false);}
    }
    this.bindChoice(this.element.querySelector<HTMLButtonElement>('.close')!,()=>this.close(true));
    this.changed(true,false);this.element.querySelector<HTMLButtonElement>('nav button:not(:disabled)')?.focus();
  }
  private bindChoice(button:HTMLButtonElement,action:()=>void):void {
    // A held touch that opened the map must not select a destination on release.
    let pressedHere=false;button.onpointerdown=()=>{pressedHere=true;};button.onpointercancel=()=>{pressedHere=false;};
    button.onclick=event=>{const activate=event.detail===0||pressedHere;pressedHere=false;if(activate)action();};
  }
  close(resume=false):void {if(!this.open)return;this.open=false;this.element.hidden=true;this.changed(false,resume);}
  dispose():void {this.close();this.abort.abort();this.element.remove();}
}
