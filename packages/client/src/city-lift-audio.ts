import { cityLiftPose } from '@shared/lifts';
import type { CityLiftSite } from '@shared/cities';

export interface LiftSound { gain:number;pan:number;speed:number }
/** A single nearby moving carriage owns the soft motor sound. Waiting lifts
 * and distant shafts are silent; vertical distance follows the real deck. */
export function nearestMovingLift(sites:readonly CityLiftSite[],seconds:number,
  camera:{x:number;y:number;z:number},yaw:number,enabled=true):LiftSound|null {
  if(!enabled||!Number.isFinite(camera.x+camera.y+camera.z+seconds+yaw))return null;
  let best=36*36,result:LiftSound|null=null;
  for(const site of sites) {
    const dx=site.x-camera.x,dz=site.z-camera.z;if(dx*dx+dz*dz>=best)continue;
    const pose=cityLiftPose(site,seconds);if(pose.waiting)continue;
    const dy=pose.y+1-camera.y,d2=dx*dx+dy*dy+dz*dz;if(d2>=best)continue;
    best=d2;const distance=Math.sqrt(d2),horizontal=Math.hypot(dx,dz);
    result={gain:.09*(1-distance/36)**2,pan:horizontal>.01?Math.max(-1,Math.min(1,(dx*Math.cos(yaw)-dz*Math.sin(yaw))/horizontal)):0,
      speed:Math.abs(pose.velocity)};
  }
  return result;
}

/** One reusable, quiet motor/hydraulic voice on AudioFX's unlocked context. */
export class CityLiftVoice {
  private readonly nodes:AudioNode[]=[];
  private readonly sources:(OscillatorNode|AudioBufferSourceNode)[]=[];
  private readonly level:GainNode;
  private readonly pan:StereoPannerNode;
  private readonly motor:OscillatorNode;
  private readonly harmonic:OscillatorNode;
  private readonly targets=new Map<AudioParam,number>();
  private stopped=false;
  constructor(private readonly ctx:AudioContext,destination:AudioNode,noise:AudioBuffer) {
    const gain=(value:number)=>{const n=ctx.createGain();n.gain.value=value;this.nodes.push(n);return n;};
    this.level=gain(0);this.pan=ctx.createStereoPanner();this.nodes.push(this.pan);this.level.connect(this.pan);this.pan.connect(destination);
    this.motor=ctx.createOscillator();this.motor.type='triangle';this.motor.frequency.value=90;this.motor.connect(this.level);
    this.harmonic=ctx.createOscillator();this.harmonic.type='sine';this.harmonic.frequency.value=180;
    const harmonicLevel=gain(.16);this.harmonic.connect(harmonicLevel);harmonicLevel.connect(this.level);
    const source=ctx.createBufferSource();source.buffer=noise;source.loop=true;
    const filter=ctx.createBiquadFilter();filter.type='bandpass';filter.frequency.value=780;filter.Q.value=.7;
    const hiss=gain(.12);source.connect(filter);filter.connect(hiss);hiss.connect(this.level);
    this.nodes.push(this.motor,this.harmonic,source,filter);this.sources.push(this.motor,this.harmonic,source);
    this.motor.onended=()=>{for(const node of this.nodes)node.disconnect();this.targets.clear();};
    for(const voice of this.sources)voice.start(ctx.currentTime);
  }
  private target(param:AudioParam,value:number,fade=.10):void {
    if(this.targets.get(param)===value)return;this.targets.set(param,value);
    param.cancelScheduledValues(this.ctx.currentTime);param.setTargetAtTime(value,this.ctx.currentTime,fade);
  }
  update(sound:LiftSound|null):void {
    if(this.stopped)return;this.target(this.level.gain,sound?.gain??0,.13);
    if(sound){this.target(this.pan.pan,sound.pan);this.target(this.motor.frequency,80+sound.speed*9);this.target(this.harmonic.frequency,160+sound.speed*18);}
  }
  stop():void {
    if(this.stopped)return;this.stopped=true;this.target(this.level.gain,0,.05);
    for(const voice of this.sources)voice.stop(this.ctx.currentTime+.25);
  }
}
