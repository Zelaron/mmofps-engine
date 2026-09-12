import * as THREE from 'three';
import { airliftPose, type AirliftFlight } from '@shared/airlift';
import type { TransportPlan } from '@shared/transport';

/** Cockpit framing leaves the launch, landscape and landing in clear view. */
export class AirliftPodView {
  readonly group=new THREE.Group();
  private metal=new THREE.MeshBasicMaterial({color:0x152b35,depthTest:false,depthWrite:false});
  private light=new THREE.MeshBasicMaterial({color:0x73e0d5,depthTest:false,depthWrite:false});
  private panel=document.createElement('aside');
  private phase=document.createElement('small');
  private destination=document.createElement('strong');
  private telemetry=document.createElement('span');
  private progress=document.createElement('div');
  private savedFov:number|null=null;
  constructor(camera:THREE.Camera) {
    this.group.name='airlift-pod-cockpit';this.group.visible=false;
    const rim=new THREE.Mesh(new THREE.TorusGeometry(1,.032,6,8),this.metal);
    rim.position.z=-1.1;rim.scale.set(1.85,1,1);this.group.add(rim);
    for(const side of [-1,1]) {
      const strut=new THREE.Mesh(new THREE.BoxGeometry(.045,.75,.05),this.metal);
      strut.position.set(side*.84,-.7,-.9);strut.rotation.z=side*.45;this.group.add(strut);
      const lamp=new THREE.Mesh(new THREE.BoxGeometry(.12,.015,.02),this.light);
      lamp.position.set(side*.63,-.79,-.88);this.group.add(lamp);
    }
    const console=new THREE.Mesh(new THREE.BoxGeometry(1.25,.12,.2),this.metal);
    console.position.set(0,-.88,-.9);this.group.add(console);
    this.group.traverse(o=>{o.renderOrder=150;o.frustumCulled=false;});camera.add(this.group);
    this.panel.id='airlift-flight';this.panel.hidden=true;this.panel.setAttribute('aria-label','Pod flight progress');
    this.progress.className='airlift-flight-progress';
    this.panel.append(this.phase,this.destination,this.telemetry,this.progress);document.body.append(this.panel);
  }
  update(plan:TransportPlan|null,flight:AirliftFlight|undefined,seconds:number,camera:THREE.PerspectiveCamera,hidden=false):void {
    const pose=plan&&flight?airliftPose(plan,flight,seconds*60):undefined;
    this.panel.hidden=!pose||hidden;this.group.visible=!!pose&&!hidden;
    if(!pose||!plan||!flight) {
      if(this.savedFov!==null){camera.fov=this.savedFov;camera.updateProjectionMatrix();this.savedFov=null;}
      return;
    }
    if(this.savedFov===null)this.savedFov=camera.fov;
    const speed=Math.hypot(pose.vx,pose.vy,pose.vz);
    camera.fov=this.savedFov+Math.min(9,speed/100);camera.updateProjectionMatrix();
    this.phase.textContent=pose.progress<.23?'POD LAUNCH':pose.progress>.77?'APPROACH & LANDING':'HIGH ALTITUDE CRUISE';
    this.destination.textContent=plan.pods.find(p=>p.id===flight.destination)?.name??'Destination';
    this.telemetry.textContent=`${Math.round(speed)} m/s  ·  ${Math.ceil(pose.remaining)}s to arrival`;
    this.progress.style.setProperty('--progress',`${pose.progress*100}%`);
  }
  dispose():void {
    this.group.traverse(o=>{if(o instanceof THREE.Mesh)o.geometry.dispose();});
    this.metal.dispose();this.light.dispose();this.group.removeFromParent();this.panel.remove();
  }
}
