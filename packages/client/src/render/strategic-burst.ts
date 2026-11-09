import * as THREE from 'three';

/** Room for a destroyer's five-shell nuclear salvo and one more blast. */
export const STRATEGIC_BURST_SLOTS = 6;
export const STRATEGIC_PARTICLES_PER_BURST = 768;
/** Large soft particles stay legible beyond ordinary scenery fog. Their
 * depth test still respects terrain; one fixed draw serves every live cloud.
 * Motion/fading is analytic in the shader, with no per-frame buffer uploads. */
export class StrategicBurst {
  readonly group = new THREE.Group();
  readonly capacity = STRATEGIC_BURST_SLOTS * STRATEGIC_PARTICLES_PER_BURST;
  private readonly positions = new Float32Array(this.capacity * 3);
  private readonly velocities = new Float32Array(this.capacity * 3);
  private readonly timing = new Float32Array(this.capacity * 3);
  /** Per particle: 0 for an ordinary shell, 1 for a nuclear salvo's heavier,
   * darker cloud that still reads against bright sky and snow. */
  private readonly looks = new Float32Array(this.capacity);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 } },
    vertexShader: `attribute vec3 velocity; attribute vec3 timing; attribute float look;
      uniform float time; varying float vAge; varying float vFade; varying float vLook;
      void main(){
        vLook=look;
        float age=max(0.0,time-timing.x), life=max(.01,timing.y);
        vAge=age/life; vFade=timing.y>0.0 ? (1.0-smoothstep(.45,1.0,vAge)) : 0.0;
        vec3 p=position+velocity*age;
        p.y+=min(age*age,16.0)*1.1;
        vec4 mv=modelViewMatrix*vec4(p,1.0);
        gl_Position=projectionMatrix*mv;
        gl_PointSize=clamp(timing.z*(.35+min(age,2.0)*.6)*900.0/max(1.0,-mv.z),1.0,96.0);
      }`,
    fragmentShader: `varying float vAge;varying float vFade;varying float vLook;
      void main(){
        float r=length(gl_PointCoord-.5)*2.0;
        float soft=pow(max(0.0,1.0-r*r),2.0);
        if(soft*vFade<.005)discard;
        vec3 fire=mix(vec3(1.0,.83,.42),vec3(1.0,.55,.22),vLook), smoke=mix(vec3(.52,.57,.60),vec3(.27,.25,.24),vLook);
        vec3 color=mix(fire,smoke,smoothstep(.08+vLook*.1,.5+vLook*.1,vAge));
        color=mix(vec3(1.0,1.0,.92),color,smoothstep(0.0,.12,vAge));
        gl_FragColor=vec4(color,soft*vFade*mix(.36,.62,vLook));
        #include <colorspace_fragment>
      }`,
    transparent: true, depthWrite: false, depthTest: true, fog: false,
    // Smoke must occlude softly rather than add hundreds of overlapping
    // highlights into an opaque white disk at long range.
    blending: THREE.NormalBlending, toneMapped: false,
  });
  private readonly expires = new Float64Array(STRATEGIC_BURST_SLOTS);
  private cursor = 0;
  private emitted = 0;
  private time = 0;
  constructor() {
    this.geometry.setAttribute('position',new THREE.BufferAttribute(this.positions,3));
    this.geometry.setAttribute('velocity',new THREE.BufferAttribute(this.velocities,3));
    this.geometry.setAttribute('timing',new THREE.BufferAttribute(this.timing,3));
    this.geometry.setAttribute('look',new THREE.BufferAttribute(this.looks,1));
    const points=new THREE.Points(this.geometry,this.material);points.frustumCulled=false;
    points.name='strategic-cloud-particles';this.group.add(points);this.group.visible=false;
  }
  get activeBursts():number {let n=0;for(const expiry of this.expires)if(expiry>this.time)n++;return n;}
  /** `scale` enlarges the whole cloud: its spread, height, speed and puffs.
   * A scaled cloud is a nuclear salvo's, with its heavier look. */
  emit(x:number,y:number,z:number,scale=1):void {
    if(this.emitted>=STRATEGIC_BURST_SLOTS)return;this.emitted++;
    const slot=this.cursor;this.cursor=(slot+1)%STRATEGIC_BURST_SLOTS;this.expires[slot]=this.time+8;
    for(let i=0;i<STRATEGIC_PARTICLES_PER_BURST;i++) {
      const at=(slot*STRATEGIC_PARTICLES_PER_BURST+i)*3,angle=Math.random()*Math.PI*2;
      const flash=i<192, cap=i>=448, spread=flash?8:cap?28:10;
      const radial=Math.sqrt(Math.random())*spread*scale;
      this.positions[at]=x+Math.cos(angle)*radial;this.positions[at+2]=z+Math.sin(angle)*radial;
      this.positions[at+1]=y+(flash?3:cap?60+Math.random()*25:Math.random()*65)*scale;
      const speed=flash?35+Math.random()*35:cap?10+Math.random()*10:2+Math.random()*5;
      this.velocities[at]=Math.cos(angle)*speed*scale;this.velocities[at+2]=Math.sin(angle)*speed*scale;
      this.velocities[at+1]=(flash?Math.random()*25:cap?8+Math.random()*8:12+Math.random()*8)*scale;
      this.timing[at]=this.time;this.timing[at+1]=flash?1.4:6+Math.random()*2;this.timing[at+2]=(flash?24:36)*scale;
      this.looks[at/3]=scale>1?1:0;
    }
    for(const name of ['position','velocity','timing','look'])this.geometry.getAttribute(name).needsUpdate=true;
    this.group.visible=true;
  }
  update(dt:number):void {this.emitted=0;this.time+=Math.max(0,dt);this.material.uniforms.time.value=this.time;this.group.visible=this.activeBursts>0;}
  dispose():void {this.geometry.dispose();this.material.dispose();this.group.clear();}
}
