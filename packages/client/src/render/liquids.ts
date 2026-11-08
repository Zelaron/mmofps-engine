import * as THREE from 'three';
import { COAST_REACH, liquidFootprint, surfaceLiquidVolumes, type LiquidSample } from '@shared/liquids';
import { buildJungleTemplePlan, type TempleCistern } from '@shared/jungle-temples';
import type { World } from '@shared/worldgen';
import { createSurfaceNoise } from './surface-material.js';
import { renderProfile } from './device-profile.js';

export const LIQUID_TILE_SIZE = 512;
const GRID = 16, STEP = LIQUID_TILE_SIZE / GRID;
const SHORE_STEP = 4;
const SAMPLE_STRIDE = LIQUID_TILE_SIZE / (SHORE_STEP / 2) + 1;
export const LIQUID_BUILD_BUDGET_MS = 1.5;
type LiquidWorld = Pick<World, 'seed' | 'column' | 'liquidAt' | 'collectJungleTemples'>;
type Point = { x: number; z: number; y: number; margin: number; depth: number; fx: number; fz: number };
type Tile = { key: string; x: number; z: number; water: number[]; lava: number[] };

/** Clip against the wet bed as well as the authored footprint. A lake plane
 * therefore cannot spread beneath an unrelated cave or over an island. */
function clipTriangle(points: readonly Point[], output: number[]): void {
  const polygon: Point[] = [];
  for (let i = 0; i < 3; i++) {
    const a = points[i], b = points[(i + 1) % 3], inside = a.margin > 0;
    if (inside) polygon.push(a);
    if (inside !== (b.margin > 0)) {
      const t = a.margin / (a.margin - b.margin), mix = (a: number, b: number) => a + (b - a) * t;
      polygon.push({ x: mix(a.x, b.x), z: mix(a.z, b.z), y: mix(a.y, b.y), margin: 0,
        depth: Math.max(0, mix(a.depth, b.depth)), fx: mix(a.fx, b.fx), fz: mix(a.fz, b.fz) });
    }
  }
  for (let i = 1; i + 1 < polygon.length; i++) for (const p of [polygon[0], polygon[i], polygon[i + 1]])
    output.push(p.x, p.y + .015, p.z, Math.max(0, p.depth), p.fx, p.fz);
}

/** One inexpensive shader per liquid: two shared mipmapped noise samples,
 * analytic ripple normals, sky tint/specular and moving shallow-bank foam.
 * There are no reflection targets, screen copies or per-frame geometry edits. */
function material(noise: THREE.Texture, lava: boolean): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, noiseMap: { value: noise }, molten: { value: lava ? 1 : 0 },
      viewOrigin: { value: new THREE.Vector3() }, fadeRadius: { value: 1900 },
      ...THREE.UniformsLib.fog },
    vertexShader: `attribute vec3 liquidData; varying vec3 vWorld; varying vec3 vLiquid;
      #include <fog_pars_vertex>
      void main() { vWorld = position; vLiquid = liquidData;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform float time, molten, fadeRadius; uniform sampler2D noiseMap;
      uniform vec3 viewOrigin; varying vec3 vWorld; varying vec3 vLiquid;
      #include <fog_pars_fragment>
      void main() {
        vec2 p = vWorld.xz - vLiquid.yz * time * 1.5;
        vec2 uv = p * .025 + vec2(time * .004, -time * .002);
        vec2 grain = texture2D(noiseMap, uv).rg;
        float broad = texture2D(noiseMap, p * .009 + vec2(-time * .001, time * .0018)).g;
        vec2 slope = vec2(cos(p.x * .73 + p.y * .41 + time * 1.8),
          sin(p.y * .84 - p.x * .28 + time * 1.5)) * .055 + (grain - .5) * .13;
        vec3 normal = normalize(vec3(slope.x, 1.0, slope.y));
        vec3 eye = normalize(cameraPosition - vWorld);
        float fresnel = pow(1.0 - abs(dot(normal, eye)), 3.0);
        float depth = max(0.0, vLiquid.x);
        vec3 water = mix(vec3(.065,.34,.29), vec3(.016,.115,.17), 1.0-exp(-depth*.13));
        water *= .88 + broad * .25;
        water = mix(water, vec3(.48,.67,.74), fresnel * .8);
        vec3 sun = normalize(vec3(.55,.75,.3));
        float glint = pow(max(0.0, dot(reflect(-sun, normal), eye)), 160.0);
        water += vec3(1.0,.91,.65) * glint * .85;
        float bank = exp(-depth * 1.3);
        float foam = bank * smoothstep(.25,.70, sin(depth * 8.0 - time * 2.0 + broad * 4.0)*.5+.5);
        water = mix(water, vec3(.78,.9,.84), foam * .72);
        float cracks = smoothstep(.40,.57, broad + grain.r * .10);
        vec3 lava = mix(vec3(.085,.021,.012), vec3(1.0,.20,.014), cracks);
        lava += vec3(1.0,.58,.055) * pow(cracks, 4.0) * (.45 + .12*sin(time+p.x*.12));
        float alpha = mix(.48, .94, 1.0-exp(-depth*.35));
        alpha = max(alpha, fresnel*.94);
        float edge = 1.0-smoothstep(fadeRadius*.80,fadeRadius,length(vWorld.xz-viewOrigin.xz));
        gl_FragColor = vec4(mix(water,lava,molten), mix(alpha,1.0,molten)*edge);
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
    transparent: true, side: THREE.DoubleSide, depthWrite: false, fog: true,
  });
}

/** Finite liquid surfaces, incrementally sampled into a bounded tile cache.
 * Cached tiles merge by material: water (including cisterns) and lava cost at
 * most two draws, irrespective of the number of visible lakes or channels. */
export class LiquidRenderer {
  readonly group = new THREE.Group();
  currentLiquid: LiquidSample | undefined;
  readonly radius: number;
  readonly cacheLimit: number;
  private readonly noise = createSurfaceNoise();
  private readonly water = new THREE.Mesh(new THREE.BufferGeometry(), material(this.noise, false));
  private readonly lava = new THREE.Mesh(new THREE.BufferGeometry(), material(this.noise, true));
  private readonly tiles = new Map<string, Tile>();
  private readonly pools: readonly TempleCistern[];
  private wanted = new Set<string>();
  private queue: { key: string; x: number; z: number; distance: number }[] = [];
  private job: { tile: Tile; work: Generator<void> } | undefined;
  private cell = '';
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly world: LiquidWorld, options: { touch?: boolean; now?: () => number } = {}) {
    this.radius = (options.touch ?? renderProfile().touch) ? 3 : 4;
    this.cacheLimit = (this.radius * 2 + 1) ** 2 + 16;
    this.now = options.now ?? (() => performance.now());
    this.pools = world.collectJungleTemples().flatMap(site => buildJungleTemplePlan(site).cisterns);
    this.group.name = 'finite-liquids'; this.water.name = 'water-surfaces'; this.lava.name = 'lava-surfaces';
    this.water.frustumCulled = this.lava.frustumCulled = false;
    this.water.renderOrder = this.lava.renderOrder = 2;
    this.group.add(this.water, this.lava);
    for (const mesh of [this.water, this.lava]) mesh.material.uniforms.fadeRadius.value = this.radius * LIQUID_TILE_SIZE;
  }

  get stats(): { cachedTiles: number; queuedTiles: number; waterTriangles: number; lavaTriangles: number } {
    return { cachedTiles: this.tiles.size, queuedTiles: this.queue.length + (this.job ? 1 : 0),
      waterTriangles: (this.water.geometry.getAttribute('position')?.count ?? 0) / 3,
      lavaTriangles: (this.lava.geometry.getAttribute('position')?.count ?? 0) / 3 };
  }

  update(camera: { x: number; y: number; z: number }, seconds: number): void {
    if (this.disposed || !Number.isFinite(camera.x + camera.y + camera.z + seconds)) return;
    this.currentLiquid = this.world.liquidAt(camera.x, camera.y, camera.z);
    for (const mesh of [this.water, this.lava]) {
      mesh.material.uniforms.time.value = seconds;
      mesh.material.uniforms.viewOrigin.value.set(camera.x, camera.y, camera.z);
    }
    const cx = Math.floor(camera.x / LIQUID_TILE_SIZE), cz = Math.floor(camera.z / LIQUID_TILE_SIZE), key = `${cx},${cz}`;
    if (this.cell !== key) { this.cell = key; this.plan(cx, cz); }
    const start = this.now();
    // Adaptive shoreline work yields after every new column. Keep both the
    // time budget and an absolute sample cap, including under coarse timers.
    for (let samples = 0; samples < 128 && this.now() - start < LIQUID_BUILD_BUDGET_MS; samples++) {
      if (!this.job) {
        const next = this.queue.shift(); if (!next) break;
        const tile: Tile = { ...next, water: [], lava: [] };
        this.job = { tile, work: this.build(tile) };
      }
      if (this.job.work.next().done) {
        const tile = this.job.tile; this.tiles.set(tile.key, tile); this.job = undefined;
        this.trim(); this.merge(); break;
      }
    }
  }

  private plan(cx: number, cz: number): void {
    this.wanted = new Set(); this.queue = [];
    for (let z = cz - this.radius; z <= cz + this.radius; z++) for (let x = cx - this.radius; x <= cx + this.radius; x++) {
      const key = `${x},${z}`; this.wanted.add(key);
      if (!this.tiles.has(key)) this.queue.push({ key, x: x * LIQUID_TILE_SIZE, z: z * LIQUID_TILE_SIZE, distance: (x-cx)**2+(z-cz)**2 });
    }
    this.queue.sort((a,b)=>a.distance-b.distance);
    if (this.job && !this.wanted.has(this.job.tile.key)) this.job = undefined;
    if (this.job) this.queue = this.queue.filter(t=>t.key!==this.job!.tile.key);
    // Cisterns are tiny authored surfaces and appear immediately on a teleport,
    // independently of the surface-world sampling queue.
    this.merge();
  }

  private *build(tile: Tile): Generator<void> {
    // The ocean can only reach tiles that touch the coast's outer band.
    const coastal = Math.max(Math.abs(tile.x), Math.abs(tile.x + LIQUID_TILE_SIZE),
      Math.abs(tile.z), Math.abs(tile.z + LIQUID_TILE_SIZE)) >= COAST_REACH;
    const candidates = surfaceLiquidVolumes().filter(v=>v.shape==='ocean' ? coastal :
      (tile.x <= v.x+v.rx+160 && tile.x+LIQUID_TILE_SIZE >= v.x-v.rx-160 &&
       tile.z <= v.z+v.rz+160 && tile.z+LIQUID_TILE_SIZE >= v.z-v.rz-160));
    type Sample = { water: Point; lava: Point; waterId: number };
    const cache = new Map<number, Sample>(), world = this.world;
    function *sample(x: number, z: number): Generator<void, Sample> {
        const key = (x-tile.x)/(SHORE_STEP/2) + (z-tile.z)/(SHORE_STEP/2) * SAMPLE_STRIDE;
        const cached = cache.get(key); if (cached) return cached;
        const column=world.column(x,z);
        let water: Point | undefined;
        let waterId = 0;
        for (const volume of candidates) {
          const footprint=liquidFootprint(volume,world.seed,x,z), depth=footprint.surfaceY-column.h;
          const point={x,z,y:footprint.surfaceY,depth:Math.max(0,Math.min(depth,volume.depth)),
            margin:Math.min(depth-.035,-footprint.distance),fx:footprint.flowX,fz:footprint.flowZ};
          if (!water || (point.margin>0 && (water.margin<=0 || point.y>water.y)) ||
            (water.margin<=0 && point.margin>water.margin)) { water=point; waterId=volume.id; }
        }
        water ??= { x, z, y: column.h - 1, depth: 0, margin: -1, fx: 0, fz: 0 };
        const basin=column.lavaBasin, level=column.lavaY>-999?column.lavaY:basin?.level??column.h-1;
        const lava: Point={x,z,y:level,depth:Math.max(0,level-column.h),
          margin:Math.min(level-column.h-.035,column.lavaY>-999?basin?(basin.channel-.28)*80:1:-1),fx:0,fz:0};
        if(lava.margin>0)water!.margin=Math.min(water!.margin,-lava.margin);
        const result={water:water!,lava,waterId}; cache.set(key,result);
        yield; return result;
    }
    function *quad(x: number, z: number, size: number): Generator<void> {
      const a=yield*sample(x,z), b=yield*sample(x+size,z), c=yield*sample(x,z+size), d=yield*sample(x+size,z+size);
      const corners=[a,b,c,d];
      let boundary = corners.some(p=>p.waterId!==a.waterId && p.water.margin>0 && a.water.margin>0);
      for (const kind of ['water','lava'] as const) {
        const wet=corners.map(p=>p[kind].margin>0);
        boundary ||= wet.some(Boolean) && !wet.every(Boolean);
        // A curved bank or narrow inlet may enter the cell without reaching
        // a corner. Probe its center before deciding that the cell is dry.
        if (!boundary && !wet.some(Boolean) && Math.max(...corners.map(p=>p[kind].margin))>-size) {
          const center=yield*sample(x+size/2,z+size/2);
          boundary ||= center[kind].margin>0;
        }
      }
      if (boundary && size>SHORE_STEP) {
        const half=size/2;
        yield*quad(x,z,half);yield*quad(x+half,z,half);
        yield*quad(x,z+half,half);yield*quad(x+half,z+half,half);
      } else for (const kind of ['water','lava'] as const) {
        clipTriangle([a[kind],c[kind],b[kind]],tile[kind]); clipTriangle([b[kind],c[kind],d[kind]],tile[kind]);
      }
    }
    for (let row=0;row<GRID;row++) for(let col=0;col<GRID;col++) yield*quad(tile.x+col*STEP,tile.z+row*STEP,STEP);
  }

  private trim(): void {
    for (const key of this.tiles.keys()) { if(this.tiles.size<=this.cacheLimit) break; if(!this.wanted.has(key))this.tiles.delete(key); }
  }

  private cisternData(output: number[]): void {
    for(const pool of this.pools) {
      if(!this.wanted.has(`${Math.floor(pool.x/LIQUID_TILE_SIZE)},${Math.floor(pool.z/LIQUID_TILE_SIZE)}`))continue;
      const center:Point={x:pool.x,z:pool.z,y:pool.level,depth:pool.level-pool.bottom,margin:1,fx:0,fz:0};
      for(let i=0;i<48;i++) {
        const point=(a:number):Point=>({...center,x:pool.x+Math.cos(a)*pool.hx,z:pool.z+Math.sin(a)*pool.hz,depth:.08});
        clipTriangle([center,point((i+1)*Math.PI/24),point(i*Math.PI/24)],output);
      }
    }
  }

  private merge(): void {
    const cisterns:number[]=[];this.cisternData(cisterns);
    for(const kind of ['water','lava'] as const) {
      const chunks=[...this.tiles.values()].filter(t=>this.wanted.has(t.key)).map(t=>t[kind]);
      if(kind==='water')chunks.push(cisterns);
      const count=chunks.reduce((n,c)=>n+c.length/6,0), positions=new Float32Array(count*3),data=new Float32Array(count*3);
      let offset=0;
      for(const chunk of chunks)for(let i=0;i<chunk.length;i+=6) {
        positions[offset]=chunk[i];positions[offset+1]=chunk[i+1];positions[offset+2]=chunk[i+2];
        data[offset]=chunk[i+3];data[offset+1]=chunk[i+4];data[offset+2]=chunk[i+5];offset+=3;
      }
      const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.BufferAttribute(positions,3));
      geometry.setAttribute('liquidData',new THREE.BufferAttribute(data,3));
      this[kind].geometry.dispose();this[kind].geometry=geometry;this[kind].visible=count>0;
    }
  }

  dispose(): void {
    if(this.disposed)return;this.disposed=true;
    for(const mesh of [this.water,this.lava]) {mesh.geometry.dispose();mesh.material.dispose();}
    this.noise.dispose();this.group.clear();this.tiles.clear();this.queue=[];this.job=undefined;this.currentLiquid=undefined;
  }
}
