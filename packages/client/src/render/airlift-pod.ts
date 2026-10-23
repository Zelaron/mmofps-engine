import * as THREE from 'three';
import { airliftPose, type AirliftFlight } from '@shared/airlift';
import { PLAYER, TICK_DT } from '@shared/constants';
import type { TransportPlan } from '@shared/transport';

/** Cockpit framing leaves the launch, landscape and landing in clear view. */
export class AirliftPodView {
  readonly group=new THREE.Group();
  private metal=new THREE.MeshBasicMaterial({color:0x152b35});
  private light=new THREE.MeshBasicMaterial({color:0x73e0d5});
  private lining=new THREE.MeshBasicMaterial({color:0x29424c});
  private panel=document.createElement('aside');
  private phase=document.createElement('small');
  private destination=document.createElement('strong');
  private telemetry=document.createElement('span');
  private progress=document.createElement('div');
  private savedFov:number|null=null;
  constructor(parent:THREE.Object3D) {
    this.group.name='airlift-pod-cockpit';this.group.visible=false;
    const rim=new THREE.Mesh(new THREE.TorusGeometry(1,.032,6,8),this.metal);
    rim.name='windscreen';rim.position.z=-1.1;rim.scale.set(1.85,1,1);this.group.add(rim);
    for(const side of [-1,1]) {
      const strut=new THREE.Mesh(new THREE.BoxGeometry(.045,.75,.05),this.metal);
      strut.position.set(side*.84,-.7,-.9);strut.rotation.z=side*.45;this.group.add(strut);
      const lamp=new THREE.Mesh(new THREE.BoxGeometry(.12,.015,.02),this.light);
      lamp.position.set(side*.63,-.79,-.88);this.group.add(lamp);
    }
    const console=new THREE.Mesh(new THREE.BoxGeometry(1.25,.12,.2),this.metal);
    console.name='console';console.position.set(0,-.88,-.9);this.group.add(console);
    const box=(name:string,size:[number,number,number],position:[number,number,number],material=this.metal) => {
      const mesh=new THREE.Mesh(new THREE.BoxGeometry(...size),material);
      mesh.name=name;mesh.position.set(...position);this.group.add(mesh);
    };
    // The eye stays inside an open-window cabin. Side framing, a rear hatch
    // and a floor give free-look a stable vehicle around it in every direction.
    box('cabin-floor',[3.6,.12,3.2],[0,-1.5,.4],this.lining);
    box('cabin-roof',[3.6,.1,3.2],[0,1.3,.4],this.lining);
    box('rear-bulkhead',[3.6,2.7,.12],[0,-.1,1.94]);
    box('rear-hatch',[1.15,2.15,.04],[0,-.2,1.86],this.lining);
    box('rear-hatch-light',[.8,.035,.04],[0,.76,1.82],this.light);
    box('rear-hatch-handle',[.3,.035,.06],[.3,-.3,1.8],this.light);
    for(const side of [-1,1]) {
      box(`side-sill-${side}`,[.12,.62,3.2],[side*1.74,-1.05,.4],this.lining);
      box(`side-post-${side}`,[.09,2.15,.09],[side*1.74,.15,.5]);
      box(`side-light-${side}`,[.025,.025,1.1],[side*1.665,-.72,.65],this.light);
    }
    parent.add(this.group);
    this.panel.id='airlift-flight';this.panel.hidden=true;this.panel.setAttribute('aria-label','Pod flight progress');
    this.progress.className='airlift-flight-progress';
    this.panel.append(this.phase,this.destination,this.telemetry,this.progress);document.body.append(this.panel);
  }
  update(plan:TransportPlan|null,flight:AirliftFlight|undefined,seconds:number,camera:THREE.PerspectiveCamera,hidden=false):void {
    const pose=plan&&flight?airliftPose(plan,flight,seconds/TICK_DT):undefined;
    this.panel.hidden=!pose||hidden;this.group.visible=!!pose&&!hidden;
    if(!pose||!plan||!flight) {
      if(this.savedFov!==null){camera.fov=this.savedFov;camera.updateProjectionMatrix();this.savedFov=null;}
      return;
    }
    // Use the same fractional render clock as Prediction.renderPos(). The
    // cabin follows the route, while the camera may look or shake independently.
    this.group.position.set(pose.x,pose.y+PLAYER.EYE_HEIGHT,pose.z);
    this.group.rotation.set(0,pose.heading,0);
    if(this.savedFov===null)this.savedFov=camera.fov;
    const speed=Math.hypot(pose.vx,pose.vy,pose.vz);
    camera.fov=this.savedFov+Math.min(9,speed/100);camera.updateProjectionMatrix();
    this.phase.textContent=pose.progress<.23?'POD LAUNCH':pose.progress>.77?'APPROACH & LANDING':'HIGH ALTITUDE CRUISE';
    this.destination.textContent=plan.pods.find(p=>p.id===flight.destination)?.name??'Destination';
    this.telemetry.textContent=`${Math.round(speed)} m/s  ·  ${Math.ceil(pose.remaining)}s to arrival`;
    this.progress.style.setProperty('--progress',`${pose.progress*100}%`);
  }
  /** Read-only diagnostics for the real input/flight browser checks. */
  diagnostics(camera:THREE.Camera) {
    this.group.updateWorldMatrix(true,false);camera.updateWorldMatrix(true,false);
    const position=this.group.getWorldPosition(new THREE.Vector3());
    const cameraLocal=this.group.worldToLocal(camera.getWorldPosition(new THREE.Vector3()));
    const viewForward=new THREE.Vector3(0,0,-1).transformDirection(this.group.matrixWorld).transformDirection(camera.matrixWorldInverse);
    return {visible:this.group.visible,x:position.x,y:position.y,z:position.z,heading:this.group.rotation.y,
      cameraLocal:{x:cameraLocal.x,y:cameraLocal.y,z:cameraLocal.z},viewForward:{x:viewForward.x,y:viewForward.y,z:viewForward.z}};
  }
  dispose():void {
    this.group.traverse(o=>{if(o instanceof THREE.Mesh)o.geometry.dispose();});
    this.metal.dispose();this.light.dispose();this.lining.dispose();this.group.removeFromParent();this.panel.remove();
  }
}
