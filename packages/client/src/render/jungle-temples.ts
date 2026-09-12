import * as THREE from 'three';
import { buildJungleTemplePlan, templeTrapPose, type JungleTemplePlan, type TempleTrap } from '@shared/jungle-temples';
import type { World } from '@shared/worldgen';

const STONE=[0x777d60,0x424f44,0xa79c72,0xb2944d];
function templeMaterial(): THREE.MeshLambertMaterial {
  const material=new THREE.MeshLambertMaterial({color:0xffffff});
  material.onBeforeCompile=shader=>{
    shader.vertexShader=shader.vertexShader.replace('#include <common>','#include <common>\nvarying vec3 vTempleWorld;\nvarying vec3 vTempleNormal;')
      .replace('#include <worldpos_vertex>','#include <worldpos_vertex>\nvTempleWorld=(modelMatrix * instanceMatrix * vec4(transformed,1.0)).xyz;\nvTempleNormal=normalize(mat3(modelMatrix * instanceMatrix)*normal);');
    shader.fragmentShader=shader.fragmentShader.replace('#include <common>','#include <common>\nvarying vec3 vTempleWorld;\nvarying vec3 vTempleNormal;')
      .replace('#include <color_fragment>',`#include <color_fragment>
        vec3 q=vTempleWorld;
        float row=floor(q.y/.85);
        vec2 masonry=vec2((abs(vTempleNormal.z)>.6?q.x:q.z)/2.3+mod(row,2.)*.5,q.y/.85);
        vec2 edge=min(fract(masonry),1.-fract(masonry));
        vec2 aa=max(fwidth(masonry)*1.4,vec2(.002));
        float mortar=1.-min(smoothstep(.014,.014+aa.x,edge.x),smoothstep(.025,.025+aa.y,edge.y));
        float course=fract(sin(dot(floor(masonry),vec2(127.1,311.7)))*43758.5453);
        float moss=smoothstep(.45,.85,sin(q.x*.15+q.z*.21)*sin(q.y*.19-q.z*.13));
        diffuseColor.rgb*=mix(1.,.72,mortar)*(.86+course*.18);
        diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(.64,.89,.52),moss*.42);`);
  };
  material.customProgramCacheKey=()=> 'jungle-temple-stone-1';
  return material;
}

/** One static masonry pool and three tiny mechanism pools for all nearby
 * shrines. Shared poses drive the visible danger; there are no extra lights. */
export class JungleTempleRenderer {
  readonly group=new THREE.Group();
  private readonly plans: JungleTemplePlan[];
  private readonly masonry: THREE.InstancedMesh;
  private readonly spikes: THREE.InstancedMesh;
  private readonly crushers: THREE.InstancedMesh;
  private readonly darts: THREE.InstancedMesh;
  private readonly transform=new THREE.Object3D();
  private readonly color=new THREE.Color();
  private activeTraps: TempleTrap[]=[];
  private key='';
  private disposed=false;

  constructor(world:World) {
    this.plans=world.collectJungleTemples().map(buildJungleTemplePlan);
    const count=this.plans.reduce((n,p)=>n+p.solids.length,0),traps=this.plans.reduce((n,p)=>n+p.traps.length,0);
    this.masonry=new THREE.InstancedMesh(new THREE.BoxGeometry(2,2,2),templeMaterial(),count);
    const metal=new THREE.MeshLambertMaterial({color:0xd8c089,emissive:0x2a1509,emissiveIntensity:.12});
    this.spikes=new THREE.InstancedMesh(new THREE.ConeGeometry(.23,1,6).translate(0,.5,0),metal,traps*25);
    this.crushers=new THREE.InstancedMesh(new THREE.BoxGeometry(2,.55,2),metal,traps);
    this.darts=new THREE.InstancedMesh(new THREE.ConeGeometry(.08,1,5).rotateZ(-Math.PI/2),metal,traps*5);
    this.group.name='jungle-temples';
    for(const mesh of [this.masonry,this.spikes,this.crushers,this.darts]) {mesh.count=0;mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);this.group.add(mesh);}
  }

  get stats() {return {draws:4,boxes:this.masonry.count,mechanisms:this.activeTraps.length,triangles:this.masonry.count*12+this.spikes.count*12+this.crushers.count*12+this.darts.count*10};}

  update(seconds:number,x:number,y:number,z:number):void {
    if(this.disposed || !Number.isFinite(seconds+x+y+z)) return;
    const key=`${Math.floor(x/96)},${Math.floor(z/96)}`;
    if(key!==this.key) {
      this.key=key;let count=0;this.activeTraps=[];
      for(const plan of this.plans) {
        if(Math.hypot(x-plan.site.x,z-plan.site.z)>(plan.site.kind==='great-pyramid'?1800:1000))continue;
        for(const box of plan.solids) {
          this.transform.position.set(box.x,box.y,box.z);this.transform.scale.set(box.hx,box.hy,box.hz);this.transform.rotation.set(0,0,0);this.transform.updateMatrix();
          this.masonry.setMatrixAt(count,this.transform.matrix);this.color.setHex(STONE[(box.facade??112)-112]??STONE[0]);this.masonry.setColorAt(count++,this.color);
        }
        this.activeTraps.push(...plan.traps);
      }
      this.masonry.count=count;this.masonry.instanceMatrix.needsUpdate=true;
      if(this.masonry.instanceColor)this.masonry.instanceColor.needsUpdate=true;
      if(count)this.masonry.computeBoundingSphere();
    }
    let spikes=0,crushers=0,darts=0;
    const set=(mesh:THREE.InstancedMesh,index:number,px:number,py:number,pz:number,sx:number,sy:number,sz:number,warning:boolean)=>{
      this.transform.position.set(px,py,pz);this.transform.scale.set(sx,sy,sz);this.transform.updateMatrix();mesh.setMatrixAt(index,this.transform.matrix);
      this.color.setHex(warning?0xffb340:0xd8c089);mesh.setColorAt(index,this.color);
    };
    for(const trap of this.activeTraps) {
      if(Math.hypot(x-trap.x,y-trap.y,z-trap.z)>230)continue;
      const pose=templeTrapPose(trap,seconds);
      if(trap.kind==='spikes') for(let ix=-2;ix<=2;ix++)for(let iz=-2;iz<=2;iz++)
        set(this.spikes,spikes++,trap.x+ix*trap.hx*.4,trap.y+.015,trap.z+iz*trap.hz*.4,1,.12+pose.extension*1.38,1,pose.warning);
      else if(trap.kind==='crusher') set(this.crushers,crushers++,trap.x,trap.y+trap.height*(1-pose.extension)+.275,trap.z,trap.hx,1,trap.hz,pose.warning);
      else {
        const px=trap.x+(((pose.progress*3)%1)*2-1)*trap.hx;
        for(let i=-2;i<=2;i++)set(this.darts,darts++,pose.active?px:trap.x-trap.hx-.35,trap.y+1.2,trap.z+i*trap.hz*.4,pose.active?1.1:.32,1,1,pose.warning);
      }
    }
    for(const [mesh,count]of [[this.spikes,spikes],[this.crushers,crushers],[this.darts,darts]] as const) {
      mesh.count=count;mesh.instanceMatrix.needsUpdate=true;if(mesh.instanceColor)mesh.instanceColor.needsUpdate=true;if(count)mesh.computeBoundingSphere();
    }
  }

  dispose():void {
    if(this.disposed)return;this.disposed=true;
    const materials=new Set<THREE.Material>();
    for(const mesh of [this.masonry,this.spikes,this.crushers,this.darts]) {mesh.geometry.dispose();materials.add(mesh.material as THREE.Material);mesh.dispose();}
    for(const material of materials)material.dispose();this.group.clear();
  }
}
