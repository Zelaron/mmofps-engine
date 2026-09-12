import * as THREE from 'three';
import { NuclearBurstBudget, NUCLEAR_PARTICLE_CAP } from './nuclear-burst.js';
import { weaponDefById, TICK_DT, WEAPONS, NUKE_MARKER, NUKE_BOMB, vehicleWeaponColor } from '@shared/index';
import { VehicleGeometry } from './vehicle-geometry.js';
import { StrategicBurst } from './strategic-burst.js';

// Pooled, allocation-light combat effects: tracers (one LineSegments draw),
// particles (one Points draw), projectile meshes, explosion lights, camera shake.

const MAX_TRACERS = 128;
const MAX_BEAMS = 64;
const BEAM_AXIS = new THREE.Vector3(0,1,0);
// Dense nuclear clouds share one Points draw and a fixed buffer with combat FX.
const MAX_PARTICLES = NUCLEAR_PARTICLE_CAP;
const PREDICTION_COVER_SECONDS = 0.22;
const SHOCKWAVE_POOL_SIZE = 6;
const configuredRocketBlastRadius = WEAPONS.find(
  (weapon) => weapon.projectile === 'rocket',
)?.splashRadius;
if (!(configuredRocketBlastRadius && configuredRocketBlastRadius > 0)) {
  throw new Error('Rocket projectile requires a positive splash radius');
}
const BASE_BLAST_RADIUS = configuredRocketBlastRadius;

interface Tracer {
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
  life: number; maxLife: number;
  r: number; g: number; b: number;
}

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; maxLife: number;
  r: number; g: number; b: number;
  gravity: number;
}

export interface ProjectileVisual {
  id: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  weapon: number;
}

interface ProjectileMesh {
  object: THREE.Object3D;
  weapon: number;
  moving: boolean;
}

interface PredictedProjectile extends ProjectileMesh {
  authoritativeId?: number;
  vx: number;
  vy: number;
  vz: number;
  gravity: number;
  age: number;
  trailAcc: number;
}

interface TrailPoint {
  x: number;
  y: number;
  z: number;
}

interface Shockwave {
  mesh: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  life: number;
  maxLife: number;
  radius: number;
}

export class Effects {
  readonly group = new THREE.Group();
  shake = 0;

  private tracers: Tracer[] = [];
  private readonly nuclear = new NuclearBurstBudget();
  private readonly strategic = new StrategicBurst();
  private readonly beams: {a:THREE.Vector3;b:THREE.Vector3;color:THREE.Color;width:number;life:number;maxLife:number}[]=[];
  private readonly beamMesh=new THREE.InstancedMesh(new THREE.CylinderGeometry(1,1,1,8),
    new THREE.MeshBasicMaterial({color:0xffffff,transparent:true,opacity:.60,depthWrite:false,blending:THREE.AdditiveBlending,toneMapped:false}),MAX_BEAMS);
  private readonly beamMatrix=new THREE.Matrix4();
  private readonly beamPosition=new THREE.Vector3();
  private readonly beamDirection=new THREE.Vector3();
  private readonly beamScale=new THREE.Vector3();
  private readonly beamRotation=new THREE.Quaternion();
  private particles: Particle[] = [];
  private readonly freeParticles: Particle[] = Array.from({length:MAX_PARTICLES},()=>({
    // Initialize floating-point storage up front, avoiding a mass integer-to-
    // double object transition on the first large explosion.
    x:.1,y:.1,z:.1,vx:.1,vy:.1,vz:.1,life:.1,maxLife:.1,r:.1,g:.1,b:.1,gravity:.1,
  }));

  private readonly linePos = new Float32Array(MAX_TRACERS * 6);
  private readonly lineCol = new Float32Array(MAX_TRACERS * 6);
  private readonly lineGeo = new THREE.BufferGeometry();
  private readonly lines: THREE.LineSegments;

  private readonly pointPos = new Float32Array(MAX_PARTICLES * 3);
  private readonly pointCol = new Float32Array(MAX_PARTICLES * 3);
  private readonly pointGeo = new THREE.BufferGeometry();
  private readonly points: THREE.Points;

  private readonly projectileMeshes = new Map<number, ProjectileMesh>();
  private readonly projectileTrailPrev = new Map<number, TrailPoint>();
  private readonly predictedProjectiles: PredictedProjectile[] = [];
  private readonly rocketGeo: THREE.ConeGeometry;
  private readonly rocketMat = new THREE.MeshLambertMaterial({ color: 0x8a4632 });
  private readonly prismGeo = new THREE.IcosahedronGeometry(.22, 1);
  private readonly prismMat = new THREE.MeshBasicMaterial({ color: 0xbeacff, toneMapped: false });
  private readonly energyCoreGeo = new THREE.CylinderGeometry(.40, .40, 4.8, 16);
  private readonly energyGlowGeo = new THREE.CylinderGeometry(.65, .65, 5.2, 16);
  private readonly energyCoreMat = new THREE.MeshBasicMaterial({ color: 0xfff6cf, toneMapped: false });
  private readonly energyGlowMat = new THREE.MeshBasicMaterial({ color: 0xffb638, transparent: true,
    opacity: .46, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  private readonly nuclearShell = strategicShell(0xc6b583, false);
  private readonly artilleryBeaconGeo = new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([0,0,0],3));
  private readonly artilleryBeaconMat = new THREE.PointsMaterial({color:0xfff0ae,size:10,sizeAttenuation:false,
    transparent:true,opacity:.95,depthWrite:false,depthTest:true,fog:false,blending:THREE.AdditiveBlending,toneMapped:false});
  private readonly voidShell = strategicShell(0x80639c, true);
  private readonly grenadeGeo = new THREE.DodecahedronGeometry(0.24, 0);
  private readonly grenadeMat = new THREE.MeshLambertMaterial({ color: 0x52613a, flatShading: true });
  private readonly grenadeBandGeo = new THREE.TorusGeometry(0.24, 0.028, 5, 10);
  private readonly grenadeBandMat = new THREE.MeshLambertMaterial({ color: 0x252b20, flatShading: true });
  private readonly grenadeBeaconGeo = new THREE.CylinderGeometry(0.04, 0.065, 0.1, 6);
  private readonly grenadeBeaconMat = new THREE.MeshBasicMaterial({ color: 0xffbc3e });
  private readonly grenadeGlowGeo = new THREE.BufferGeometry();
  private readonly grenadeGlowMat = new THREE.PointsMaterial({
    color: 0xffc247,
    size: 4.5,
    sizeAttenuation: false,
    blending: THREE.AdditiveBlending,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    fog: false,
  });
  private rocketSmokeAcc = 0;
  private grenadeTrailAcc = 0;

  private readonly lights: {
    light: THREE.PointLight;
    life: number;
    maxLife: number;
    peak: number;
  }[] = [];
  private readonly shockwaves: Shockwave[] = [];

  constructor() {
    this.group.add(this.beamMesh);this.beamMesh.count=0;this.beamMesh.frustumCulled=false;
    this.beamMesh.name="coherent-laser-beams";
    this.lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3));
    this.lines = new THREE.LineSegments(
      this.lineGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }),
    );
    this.lines.frustumCulled = false;
    this.group.add(this.lines);

    this.pointGeo.setAttribute('position', new THREE.BufferAttribute(this.pointPos, 3));
    this.pointGeo.setAttribute('color', new THREE.BufferAttribute(this.pointCol, 3));
    this.points = new THREE.Points(
      this.pointGeo,
      new THREE.PointsMaterial({ size: 0.32, vertexColors: true, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, sizeAttenuation: true }),
    );
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.group.add(this.strategic.group);

    this.rocketGeo = new THREE.ConeGeometry(0.11, 0.5, 8);
    this.rocketGeo.rotateX(-Math.PI / 2); // point along -Z... rotated to +dir below
    this.energyCoreGeo.rotateX(Math.PI / 2); this.energyCoreGeo.translate(0,0,-2.4);
    this.energyGlowGeo.rotateX(Math.PI / 2); this.energyGlowGeo.translate(0,0,-2.6);
    this.grenadeGlowGeo.setAttribute(
      'position',
      new THREE.Float32BufferAttribute([0, 0.24, 0], 3),
    );

    for (let i = 0; i < 3; i++) {
      const light = new THREE.PointLight(0xffa245, 0, 26, 1.8);
      this.group.add(light);
      this.lights.push({ light, life: 0, maxLife: 0.28, peak: 60 });
    }

    // Each pooled shell owns its material because simultaneous blasts fade
    // independently. Geometry is shared and the pool bounds both draw calls
    // and GPU resources during grenade-heavy fights.
    const shockwaveGeo = new THREE.SphereGeometry(1, 16, 10);
    for (let i = 0; i < SHOCKWAVE_POOL_SIZE; i++) {
      const material = new THREE.MeshBasicMaterial({
        color: 0xffa04a,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(shockwaveGeo, material);
      mesh.visible = false;
      mesh.renderOrder = 3;
      mesh.userData.effect = 'blast-shockwave';
      this.group.add(mesh);
      this.shockwaves.push({ mesh, life: 0, maxLife: 0.48, radius: BASE_BLAST_RADIUS });
    }
  }

  // ---- Emitters ----------------------------------------------------------

  addTracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, color: number, life = 0.09): void {
    if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
    const c = new THREE.Color(color);
    this.tracers.push({ ax, ay, az, bx, by, bz, life, maxLife: life, r: c.r, g: c.g, b: c.b });
  }

  addBeam(ax:number,ay:number,az:number,bx:number,by:number,bz:number,color:number,width=.05,life=.115):void {
    if(this.beams.length>=MAX_BEAMS)this.beams.shift();
    this.beams.push({a:new THREE.Vector3(ax,ay,az),b:new THREE.Vector3(bx,by,bz),color:new THREE.Color(color),width,life,maxLife:life});
    this.addTracer(ax,ay,az,bx,by,bz,0xf4e9ff,life);
  }

  /** Scatterstorm impacts stay crisp without nine full fireballs per burst. */
  addLanceExplosion(x:number,y:number,z:number,radius:number):void {
    this.burst(x,y,z,8,6,0xc580ff,.25,1);
    this.burst(x,y,z,4,3,0xf5d9ff,.16,0);
    if(this.shockwaves.some(w=>w.life<=0))this.startShockwave(x,y,z,radius,0xc580ff);
  }

  addVoidExplosion(x:number,y:number,z:number,camPos:THREE.Vector3,radius:number):void {
    this.emitNuclearCloud(x,y,z,radius,true);
    this.startShockwave(x,y,z,radius,0xc479ff);
    for(const slot of this.lights)if(slot.life<=0){slot.light.color.setHex(0xc881ff);slot.light.position.set(x,y+12,z);
      slot.light.distance=radius*2;slot.peak=360;slot.maxLife=.85;slot.life=.85;slot.light.intensity=360;break;}
    this.shake=Math.min(.85,this.shake+48/Math.max(10,camPos.distanceTo(new THREE.Vector3(x,y,z))));
  }

  addImpact(x: number, y: number, z: number, color = 0xffd9a0): void {
    this.burst(x, y, z, 6, 3.5, color, 0.35, 8);
  }

  addBlood(x: number, y: number, z: number): void {
    this.burst(x, y, z, 10, 3, 0xc22b2b, 0.4, 5);
  }

  addExplosion(
    x: number, y: number, z: number,
    camPos: THREE.Vector3,
    blastRadius = BASE_BLAST_RADIUS,
    tint?: number,
  ): void {
    const radius = Number.isFinite(blastRadius) && blastRadius > 0
      ? blastRadius
      : BASE_BLAST_RADIUS;
    // Keep particle/light cost bounded independently of the pressure-front
    // radius, which must continue to represent the authoritative splash.
    // Truly huge blasts (the nuke) get a raised cap so they read as events.
    const s = Math.max(0.55, Math.min(radius > 20 ? 5 : 2.5, radius / BASE_BLAST_RADIUS));
    const spread = Math.sqrt(s);
    this.burst(x, y, z, Math.round(40 * spread), 9 * spread, tint ?? 0xffb054, 0.65 * spread, 4);
    this.burst(x, y, z, Math.round(22 * spread), 5 * spread, tint ?? 0xff5f2a, 0.5 * spread, 2);
    this.burst(x, y, z, Math.round(16 * spread), 3.2 * spread, 0x8a8f96, 1.1 * spread, 1.5);
    for (const slot of this.lights) {
      if (slot.life <= 0) {
        slot.light.color.setHex(tint ?? 0xffb36b);
        slot.light.position.set(x, y + 0.4, z);
        slot.light.distance = 26 * spread;
        slot.peak = 60 * s;
        slot.maxLife = 0.28 * Math.min(1.5, spread);
        slot.light.intensity = slot.peak;
        slot.life = slot.maxLife;
        break;
      }
    }
    const d = camPos.distanceTo(new THREE.Vector3(x, y, z));
    this.shake = Math.min(0.85, this.shake + (1.6 * s) / Math.max(3, d));
    this.startShockwave(x, y, z, radius, tint);
  }

  addMuzzle(x: number, y: number, z: number): void {
    this.burst(x, y, z, 3, 1.2, 0xffe6a8, 0.06, 0);
  }

  addDodgePuff(x: number, y: number, z: number): void {
    this.burst(x, y, z, 8, 2, 0xcfd6de, 0.3, 2);
  }

  /** Sparkling column at each end of a teleport. */
  addTeleportBurst(x: number, y: number, z: number): void {
    this.burst(x, y + 0.2, z, 22, 3.2, 0x7fe6ff, 0.5, -3);
    this.burst(x, y + 1.1, z, 12, 1.6, 0xd8f6ff, 0.4, -4);
  }

  /**
   * The nuke gets its own bespoke event: white-hot core flash, layered
   * fireball, a buoyant smoke column with a cap high above it (poor man's
   * mushroom cloud), a fast ground-hugging dust ring, and a shockwave shell
   * swept out to the true blast radius.
   */
  addNukeExplosion(
    x: number, y: number, z: number,
    camPos: THREE.Vector3,
    radius: number,
  ): void {
    this.emitNuclearCloud(x,y,z,radius,false);
    for (const slot of this.lights) {
      if (slot.life > 0) continue;
      slot.light.color.setHex(0xffba69);
      slot.light.position.set(x, y + 8, z);
      slot.light.distance = 340;
      slot.peak = 520;
      slot.maxLife = 1.5;
      slot.life = slot.maxLife;
      slot.light.intensity = slot.peak;
    }
    const d = camPos.distanceTo(new THREE.Vector3(x, y, z));
    this.shake = Math.min(0.85, this.shake + 60 / Math.max(10, d));
    this.startShockwave(x, y, z, radius * 0.45);
    this.startShockwave(x, y, z, radius);
  }

  /** Layered billowing sparks/smoke restore the particle-led explosion. Each
   * accepted blast creates 6600 points, never an opaque sphere or cloud cap. */
  private emitNuclearCloud(x:number,y:number,z:number,radius:number,voided:boolean):void {
    if (!this.nuclear.take()) return;
    const scale = Math.max(.65, Math.min(1.3, radius / 115));
    const layers = [
      [3,900,42,0xffffff,0xf3dfff,.55,1], [3,850,26,0xfff2c8,0xe7b9ff,1.3,1.5],
      [2,700,18,0xffb054,0xb95dea,1.8,1], [1,450,12,0xff5f2a,0x67358c,2.3,.7],
      [4,600,4.5,0x8a8f96,0x7d6a96,3.6,-7], [14,450,4,0xb8874f,0x9d79b2,3.2,-8],
      [28,400,4,0x9a9fa6,0x777281,3,-7], [44,850,12,0xa8adb4,0xad91c2,3.8,-2],
      [6,350,30,0xffa245,0xd586ff,1.9,7],
    ];
    for (const [height,count,speed,fireColor,voidColor,life,gravity] of layers) {
      this.burst(x,y+height*scale,z,count,speed*scale,voided?voidColor:fireColor,life,gravity*scale);
    }
    const dust = new THREE.Color(voided ? 0xb899ce : 0xcfc4ae);
    for (const [count, lo, hi, life] of [[600, 48, 78, 1.5], [450, 22, 40, 2.4]] as const) {
      this.reserveParticles(count);
      for (let i=0;i<count;i++) {
        const a=i/count*Math.PI*2+Math.random()*.08;
        const speed=(lo+Math.random()*(hi-lo))*scale;
        const particle=this.freeParticles.pop()!;
        particle.x=x;particle.y=y+.8;particle.z=z;
        particle.vx=Math.cos(a)*speed;particle.vy=2+Math.random()*3;particle.vz=Math.sin(a)*speed;
        particle.life=life*(.7+Math.random()*.3);particle.maxLife=life;
        particle.r=dust.r;particle.g=dust.g;particle.b=dust.b;particle.gravity=1.2;
        this.particles.push(particle);
      }
    }
  }

  private burst(x: number, y: number, z: number, count: number, speed: number, color: number, life: number, gravity: number): void {
    const c = new THREE.Color(color);
    count=Math.min(MAX_PARTICLES,count);
    this.reserveParticles(count);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const vertical = Math.random() * 2 - 1, horizontal=Math.sqrt(1-vertical*vertical);
      const s = speed * (0.35 + Math.random() * 0.65);
      const p=this.freeParticles.pop()!;
      p.x=x;p.y=y;p.z=z;p.vx=horizontal*Math.cos(a)*s;p.vy=vertical*s*.9+speed*.15;p.vz=horizontal*Math.sin(a)*s;
      p.life=life*(.6+Math.random()*.4);p.maxLife=life;p.r=c.r;p.g=c.g;p.b=c.b;p.gravity=gravity;
      this.particles.push(p);
    }
  }

  addArtilleryMuzzle(x:number,y:number,z:number,camPos:THREE.Vector3):void {
    this.burst(x,y,z,90,15,0xffe1a1,.32,-2);
    this.burst(x,y,z,45,7,0xaeb8b2,1.1,-3);
    const distance=Math.hypot(x-camPos.x,y-camPos.y,z-camPos.z);
    this.shake=Math.min(.85,this.shake+7/Math.max(16,distance));
  }

  addArtilleryExplosion(x:number,y:number,z:number,camPos:THREE.Vector3,radius:number):void {
    // Ordinary combat particles only help nearby viewers. The larger shared
    // cloud remains readable at artillery range without a solid mesh cap.
    if(Math.hypot(x-camPos.x,y-camPos.y,z-camPos.z)<700)this.addNukeExplosion(x,y,z,camPos,radius);
    this.strategic.emit(x,y,z);
  }

  private reserveParticles(count:number):void {
    const excess=this.particles.length+count-MAX_PARTICLES;
    if(excess<=0)return;
    for(let i=0;i<excess;i++)this.freeParticles.push(this.particles[i]);
    this.particles.splice(0,excess);
  }

  /** Locally-predicted projectile shown until the replicated one arrives. */
  spawnPredictedProjectile(
    weapon: number,
    x: number, y: number, z: number,
    vx: number, vy: number, vz: number,
  ): void {
    const object = this.createProjectileObject(weapon);
    object.position.set(x, y, z);
    if (!this.isGrenade(weapon)) orientAlong(object, vx, vy, vz);
    this.group.add(object);
    this.predictedProjectiles.push({
      object,
      weapon,
      moving: true,
      vx, vy, vz,
      gravity: weaponDefById(weapon)?.gravity ?? 0,
      age: 0,
      trailAcc: 0,
    });
  }

  /** Sync server-authoritative projectile positions. */
  updateProjectiles(views: ProjectileVisual[]): void {
    const present = new Set<number>();
    for (const v of views) {
      present.add(v.id);
      let slot = this.projectileMeshes.get(v.id);
      if (!slot || slot.weapon !== v.weapon) {
        if (slot) this.group.remove(slot.object);
        slot = {
          object: this.createProjectileObject(v.weapon),
          weapon: v.weapon,
          moving: true,
        };
        this.projectileMeshes.set(v.id, slot);
        this.group.add(slot.object);
      }
      slot.object.position.set(v.x, v.y, v.z);
      slot.moving = Math.hypot(v.vx, v.vy, v.vz) > 0.01;
      if (!this.isGrenade(v.weapon) || v.weapon === 208) orientAlong(slot.object, v.vx, v.vy, v.vz);
      slot.object.visible = true;

      if (v.weapon === 213) {
        const previous=this.projectileTrailPrev.get(v.id);
        if(previous)this.addTracer(v.x,v.y,v.z,previous.x,previous.y,previous.z,0xffeda1,.6);
        this.projectileTrailPrev.set(v.id,{x:v.x,y:v.y,z:v.z});
      } else if (v.weapon === 209) {
        this.burst(v.x,v.y,v.z,2,1.2,0xffd67e,.18,0);
      } else if (this.isGrenade(v.weapon)) {
        const previous = this.projectileTrailPrev.get(v.id);
        if (previous && Math.hypot(v.x - previous.x, v.y - previous.y, v.z - previous.z) > 0.04) {
          this.addTracer(v.x, v.y, v.z, previous.x, previous.y, previous.z, v.weapon===208?0xc881ff:0xffb83e, 0.42);
        }
        this.projectileTrailPrev.set(v.id, { x: v.x, y: v.y, z: v.z });
        this.grenadeTrailAcc += 1;
        if (this.grenadeTrailAcc >= 2) {
          this.grenadeTrailAcc = 0;
          if(v.weapon===208)this.burst(v.x,v.y,v.z,1,1.4,0xc881ff,.55,-1);
          else this.addGrenadeTrail(v.x, v.y, v.z);
        }
      } else {
        this.projectileTrailPrev.delete(v.id);
        // Preserve the rocket's hot exhaust trail.
        this.rocketSmokeAcc += 1;
        if (this.rocketSmokeAcc >= 2) {
          this.rocketSmokeAcc = 0;
          this.burst(v.x, v.y, v.z, 1, 0.4, v.weapon === 9 ? 0xb5a4ff : 0xffa268, 0.3, -0.5);
        }
      }
    }
    for (const [id, slot] of this.projectileMeshes) {
      if (!present.has(id)) {
        this.group.remove(slot.object);
        this.projectileMeshes.delete(id);
        this.projectileTrailPrev.delete(id);
      }
    }
    for (const id of this.projectileTrailPrev.keys()) {
      if (!present.has(id)) this.projectileTrailPrev.delete(id);
    }
  }

  /**
   * Pair a fresh authoritative entity with the local prediction for the same
   * weapon. The returned true tells the caller to hide that network copy until
   * prediction handoff; recording the id also makes early explosions exact.
   * A reflected server velocity ends that handoff immediately so a close miss
   * cannot leave the local visual travelling through the obstacle it struck.
   */
  reconcilePredictedProjectile(authoritative: ProjectileVisual): boolean {
    const matchedIndex = this.predictedProjectiles.findIndex(
      (p) => p.authoritativeId === authoritative.id,
    );
    if (matchedIndex >= 0) {
      const matched = this.predictedProjectiles[matchedIndex];
      if (this.authoritativeBounceDiverged(matched, authoritative)) {
        this.group.remove(matched.object);
        this.predictedProjectiles.splice(matchedIndex, 1);
        return false;
      }
      return matched.age < PREDICTION_COVER_SECONDS;
    }
    const candidateIndex = this.predictedProjectiles.findIndex(
      (p) => p.weapon === authoritative.weapon &&
        p.authoritativeId === undefined &&
        p.age < PREDICTION_COVER_SECONDS,
    );
    if (candidateIndex < 0) return false;
    const candidate = this.predictedProjectiles[candidateIndex];
    candidate.authoritativeId = authoritative.id;
    if (this.authoritativeBounceDiverged(candidate, authoritative)) {
      this.group.remove(candidate.object);
      this.predictedProjectiles.splice(candidateIndex, 1);
      return false;
    }
    return true;
  }

  private authoritativeBounceDiverged(
    predicted: PredictedProjectile,
    authoritative: ProjectileVisual,
  ): boolean {
    if ((weaponDefById(predicted.weapon)?.terrainBounceTime ?? 0) <= 0) return false;
    const delta = Math.hypot(
      predicted.vx - authoritative.vx,
      predicted.vy - authoritative.vy,
      predicted.vz - authoritative.vz,
    );
    const predictedSpeed = Math.hypot(predicted.vx, predicted.vy, predicted.vz);
    const authoritativeSpeed = Math.hypot(
      authoritative.vx,
      authoritative.vy,
      authoritative.vz,
    );
    const alignment = predictedSpeed > 1e-6 && authoritativeSpeed > 1e-6
      ? (
          predicted.vx * authoritative.vx +
          predicted.vy * authoritative.vy +
          predicted.vz * authoritative.vz
        ) / (predictedSpeed * authoritativeSpeed)
      : 1;
    // Normal interpolation delay changes grenade vertical velocity by only a
    // few m/s. A ricochet changes direction and/or sheds far more speed.
    return delta > Math.max(10, predictedSpeed * 0.22) || alignment < 0.88;
  }

  clearPredictedProjectiles(weapon?: number): void {
    for (let i = this.predictedProjectiles.length - 1; i >= 0; i--) {
      const p = this.predictedProjectiles[i];
      if (weapon !== undefined && p.weapon !== weapon) continue;
      this.group.remove(p.object);
      this.predictedProjectiles.splice(i, 1);
    }
  }

  /** Clear replicated and locally-predicted projectiles during a hard resync. */
  clearProjectiles(): void {
    for (const slot of this.projectileMeshes.values()) {
      this.group.remove(slot.object);
    }
    this.projectileMeshes.clear();
    this.projectileTrailPrev.clear();
    this.clearPredictedProjectiles();
  }

  /** Immediately retire the visual named by an explosion event. */
  removeProjectile(
    id: number,
    weapon?: number,
    explosionX?: number,
    explosionY?: number,
    explosionZ?: number,
  ): void {
    const slot = this.projectileMeshes.get(id);
    if (slot) {
      this.group.remove(slot.object);
      this.projectileMeshes.delete(id);
    }
    this.projectileTrailPrev.delete(id);
    let removedPrediction = false;
    for (let i = this.predictedProjectiles.length - 1; i >= 0; i--) {
      const p = this.predictedProjectiles[i];
      if (p.authoritativeId !== id) continue;
      this.group.remove(p.object);
      this.predictedProjectiles.splice(i, 1);
      removedPrediction = true;
    }
    if (removedPrediction ||
        weapon === undefined ||
        !Number.isFinite(explosionX) ||
        !Number.isFinite(explosionY) ||
        !Number.isFinite(explosionZ)) return;

    // A close impact can explode before its first replicated snapshot assigns
    // the server id. Also require spatial agreement: a remote same-weapon
    // explosion must not consume our fresh local prediction. The allowance
    // covers one authoritative integration tick plus travel since impact.
    let unbound = -1;
    let closest = Infinity;
    for (let i = 0; i < this.predictedProjectiles.length; i++) {
      const p = this.predictedProjectiles[i];
      if (p.authoritativeId !== undefined ||
          p.weapon !== weapon ||
          p.age >= PREDICTION_COVER_SECONDS) continue;
      const dx = p.object.position.x - explosionX!;
      const dy = p.object.position.y - explosionY!;
      const dz = p.object.position.z - explosionZ!;
      const distance = Math.hypot(dx, dy, dz);
      const speed = weaponDefById(weapon)?.speed ?? 48;
      const skin = Math.max(1, (weaponDefById(weapon)?.projRadius ?? 0.16) * 2);
      const maxError = speed * (p.age + TICK_DT) + skin;
      if (distance <= maxError && distance < closest) {
        closest = distance;
        unbound = i;
      }
    }
    if (unbound >= 0) {
      this.group.remove(this.predictedProjectiles[unbound].object);
      this.predictedProjectiles.splice(unbound, 1);
    }
  }

  private createProjectileObject(weapon: number): THREE.Object3D {
    if (weapon === 209) {
      const bolt = new THREE.Group(); bolt.name = 'solar-energy-shell';
      bolt.add(new THREE.Mesh(this.energyCoreGeo,this.energyCoreMat),new THREE.Mesh(this.energyGlowGeo,this.energyGlowMat));
      return bolt;
    }
    if (weapon === 210) return this.nuclearShell.clone();
    if (weapon === 213) {
      const shell=new THREE.Group();shell.name='leviathan-shell';
      const body=this.nuclearShell.clone();body.scale.setScalar(2.2);shell.add(body);
      const beacon=new THREE.Points(this.artilleryBeaconGeo,this.artilleryBeaconMat);beacon.name='artillery-shell-beacon';shell.add(beacon);
      return shell;
    }
    if (weapon === 208) return this.voidShell.clone();
    if (weapon === 9) {
      const bolt = new THREE.Mesh(this.prismGeo, this.prismMat);
      bolt.scale.set(.8, .8, 1.8); return bolt;
    }
    if (weapon === NUKE_BOMB.id) {
      // The falling nuke is just a big rocket - readable from far away.
      const bomb = new THREE.Mesh(this.rocketGeo, this.rocketMat);
      bomb.scale.setScalar(3.2);
      return bomb;
    }
    if (weapon === NUKE_MARKER.id) {
      // Ground zero: an unmissable warning pillar over the designated spot.
      const marker = new THREE.Group();
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xff4433,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.45, 0.9, 120, 10, 1, true), beamMat,
      );
      beam.position.y = 60;
      marker.add(beam);
      const core = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0xff5540 }),
      );
      core.position.y = 0.5;
      marker.add(core);
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(1.6, 0.14, 8, 22),
        new THREE.MeshBasicMaterial({
          color: 0xff7755, transparent: true, opacity: 0.7,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }),
      );
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 0.25;
      marker.add(ring);
      return marker;
    }
    if (!this.isGrenade(weapon)) return new THREE.Mesh(this.rocketGeo, this.rocketMat);

    const grenade = new THREE.Group();
    grenade.add(new THREE.Mesh(this.grenadeGeo, this.grenadeMat));
    const band = new THREE.Mesh(this.grenadeBandGeo, this.grenadeBandMat);
    band.rotation.x = Math.PI / 2;
    grenade.add(band);
    const beacon = new THREE.Mesh(this.grenadeBeaconGeo, this.grenadeBeaconMat);
    beacon.position.y = 0.2;
    beacon.rotation.z = 0.25;
    grenade.add(beacon);
    grenade.add(new THREE.Points(this.grenadeGlowGeo, this.grenadeGlowMat));
    return grenade;
  }

  private isGrenade(weapon: number): boolean {
    return weaponDefById(weapon)?.projectile === 'grenade';
  }

  private addGrenadeTrail(x: number, y: number, z: number): void {
    // A bright tracer-beacon spark plus a cool smoke fleck keeps the tumbling
    // impact grenade readable without implying a timed airburst fuse.
    this.burst(x, y, z, 1, 0.7, 0xffcf57, 0.18, 2);
    this.burst(x, y, z, 1, 0.22, 0x777b70, 0.35, -0.2);
  }

  private startShockwave(x: number, y: number, z: number, radius: number, tint?: number): void {
    // Prefer an idle shell. If every slot is live, replace the one nearest
    // expiry so the pool stays strictly bounded.
    let slot = this.shockwaves.find((wave) => wave.life <= 0);
    if (!slot) {
      slot = this.shockwaves.reduce(
        (oldest, wave) => wave.life < oldest.life ? wave : oldest,
      );
    }
    slot.life = slot.maxLife;
    slot.radius = radius;
    slot.mesh.position.set(x, y, z);
    slot.mesh.scale.setScalar(radius * 0.1);
    slot.mesh.material.opacity = 0.3;
    slot.mesh.material.color.setHex(tint ?? 0xffd28a);
    slot.mesh.visible = true;
  }

  // ---- Frame update ------------------------------------------------------

  update(dt: number): void {
    this.nuclear.nextFrame();
    this.strategic.update(dt);
    for(let i=this.beams.length-1;i>=0;i--)if((this.beams[i].life-=dt)<=0)this.beams.splice(i,1);
    for(let i=0;i<this.beams.length;i++){
      const beam=this.beams[i],length=this.beamDirection.subVectors(beam.b,beam.a).length();
      this.beamPosition.copy(beam.a).add(beam.b).multiplyScalar(.5);
      this.beamRotation.setFromUnitVectors(BEAM_AXIS,this.beamDirection.multiplyScalar(1/Math.max(.001,length)));
      const width=beam.width*(.6+.4*beam.life/beam.maxLife);
      this.beamScale.set(width,length,width);this.beamMatrix.compose(this.beamPosition,this.beamRotation,this.beamScale);
      this.beamMesh.setMatrixAt(i,this.beamMatrix);this.beamMesh.setColorAt(i,beam.color);
    }
    this.beamMesh.count=this.beams.length;this.beamMesh.instanceMatrix.needsUpdate=true;
    if(this.beamMesh.instanceColor)this.beamMesh.instanceColor.needsUpdate=true;
    // Tracers.
    let li = 0;
    this.tracers = this.tracers.filter((t) => {
      t.life -= dt;
      return t.life > 0;
    });
    for (const t of this.tracers) {
      const f = t.life / t.maxLife;
      this.linePos.set([t.ax, t.ay, t.az, t.bx, t.by, t.bz], li * 6);
      this.lineCol.set([t.r * f, t.g * f, t.b * f, t.r * f * 0.4, t.g * f * 0.4, t.b * f * 0.4], li * 6);
      li++;
    }
    this.lineGeo.setDrawRange(0, li * 2);
    this.lineGeo.getAttribute('position').needsUpdate = true;
    this.lineGeo.getAttribute('color').needsUpdate = true;

    // Particles.
    let liveParticles=0;
    for(let i=0;i<this.particles.length;i++) {
      const p=this.particles[i];p.life-=dt;
      if(p.life>0)this.particles[liveParticles++]=p;
      else this.freeParticles.push(p);
    }
    this.particles.length=liveParticles;
    let pi = 0;
    for (const p of this.particles) {
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const f = Math.min(1, (p.life / p.maxLife) * 1.6);
      this.pointPos[pi * 3] = p.x; this.pointPos[pi * 3 + 1] = p.y; this.pointPos[pi * 3 + 2] = p.z;
      this.pointCol[pi * 3] = p.r * f; this.pointCol[pi * 3 + 1] = p.g * f; this.pointCol[pi * 3 + 2] = p.b * f;
      pi++;
    }
    this.pointGeo.setDrawRange(0, pi);
    this.pointGeo.getAttribute('position').needsUpdate = true;
    this.pointGeo.getAttribute('color').needsUpdate = true;

    // Predictions use the same per-weapon gravity as authoritative flight.
    for (let i = this.predictedProjectiles.length - 1; i >= 0; i--) {
      const p = this.predictedProjectiles[i];
      p.age += dt;
      const oldX = p.object.position.x;
      const oldY = p.object.position.y;
      const oldZ = p.object.position.z;
      p.object.position.x += p.vx * dt;
      p.object.position.y += p.vy * dt - 0.5 * p.gravity * dt * dt;
      p.object.position.z += p.vz * dt;
      p.vy -= p.gravity * dt;
      if (this.isGrenade(p.weapon) && p.weapon !== 208) {
        this.addTracer(
          p.object.position.x, p.object.position.y, p.object.position.z,
          oldX, oldY, oldZ,
          // A reflected authoritative handoff should not leave a long-lived
          // predicted streak continuing through the obstacle.
          0xffb83e, 0.10,
        );
        p.object.rotation.x += dt * 7;
        p.object.rotation.z += dt * 4.5;
        p.trailAcc += dt;
        if (p.trailAcc >= 0.045) {
          p.trailAcc %= 0.045;
          this.addGrenadeTrail(p.object.position.x, p.object.position.y, p.object.position.z);
        }
      } else {
        orientAlong(p.object, p.vx, p.vy, p.vz);
      }
      if (p.age > PREDICTION_COVER_SECONDS) {
        this.group.remove(p.object);
        this.predictedProjectiles.splice(i, 1);
      }
    }

    for (const slot of this.projectileMeshes.values()) {
      if (!this.isGrenade(slot.weapon) || slot.weapon === 208 || !slot.moving) continue;
      slot.object.rotation.x += dt * 7;
      slot.object.rotation.z += dt * 4.5;
    }

    for (const slot of this.lights) {
      if (slot.life > 0) {
        slot.life -= dt;
        slot.light.intensity = Math.max(0, slot.life / slot.maxLife) * slot.peak;
        if (slot.life <= 0) slot.light.intensity = 0;
      }
    }

    for (const wave of this.shockwaves) {
      if (wave.life <= 0) continue;
      wave.life = Math.max(0, wave.life - dt);
      const t = 1 - wave.life / wave.maxLife;
      // Fast initial pressure front, then a short readable fade at full size.
      const expansion = 1 - Math.pow(1 - t, 3);
      wave.mesh.scale.setScalar(wave.radius * (0.1 + expansion * 0.9));
      wave.mesh.material.opacity = 0.3 * Math.pow(1 - t, 1.45);
      if (wave.life <= 0) {
        wave.mesh.visible = false;
        wave.mesh.material.opacity = 0;
      }
    }

    this.shake = Math.max(0, this.shake - dt * 2.2);
  }
}

/** One shared draw: tapered cannon body, pointed nose and four real tail fins. */
function strategicShell(color:number, voided:boolean):THREE.Mesh {
  const shell = new VehicleGeometry();
  shell.tube(.28,[0,0,-.88],[0,0,.55],color,16,.32);
  shell.tube(.32,[0,0,.55],[0,0,1.12],0xd6d1b4,16,.015);
  shell.tube(.30,[0,0,-.76],[0,0,-.60],voided?0xc777ff:0xe5a93e,16);
  for(let side=0;side<4;side++) {
    const a=side*Math.PI/2,c=Math.cos(a),s=Math.sin(a);
    shell.prism([[c*.24,s*.24,-.94],[c*.60,s*.60,-.94],[c*.27,s*.27,-.36]],[-s*.065,c*.065,0],0x47545b);
  }
  const mesh = shell.mesh(new THREE.MeshLambertMaterial({vertexColors:true}),voided?'void-bomb':'nuclear-cannon-shell');
  if (voided) mesh.scale.setScalar(1.8);
  return mesh;
}

function orientAlong(object: THREE.Object3D, vx: number, vy: number, vz: number): void {
  const len = Math.hypot(vx, vy, vz);
  if (len < 1e-6) return;
  const target = new THREE.Vector3(
    object.position.x + vx / len,
    object.position.y + vy / len,
    object.position.z + vz / len,
  );
  object.lookAt(target);
}
