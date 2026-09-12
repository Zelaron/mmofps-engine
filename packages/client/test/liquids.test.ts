import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LiquidRenderer } from '../src/render/liquids.js';
import { liquidAtSurfaceColumn, liquidFootprint, surfaceLiquidVolumes } from '../../shared/src/liquids.js';
import { World, type ColumnData } from '../../shared/src/worldgen.js';
import { buildJungleTemplePlan, type JungleTempleSite } from '../../shared/src/jungle-temples.js';

function drain(renderer:LiquidRenderer,at:{x:number;y:number;z:number}):void {
  for(let i=0;i<600;i++){renderer.update(at,i/60);if(!renderer.stats.queuedTiles)return;}
  assert.fail('bounded tile queue did not finish');
}
function vertices(renderer:LiquidRenderer,name='water-surfaces'):THREE.BufferAttribute {
 return (renderer.group.getObjectByName(name) as THREE.Mesh).geometry.getAttribute('position') as THREE.BufferAttribute;
}

test('surface liquid geometry follows the graded wet bed, finite footprints and river levels',()=>{
 const world=new World(1337),renderer=new LiquidRenderer(world,{touch:true,now:()=>0});
 const lagoon=surfaceLiquidVolumes().find(v=>v.id===4)!;
 drain(renderer,{x:450,y:14,z:1250}); const positions=vertices(renderer);let lagoonVertices=0;
 for(let i=0;i<positions.count;i++) {
  const x=positions.getX(i),y=positions.getY(i)-.015,z=positions.getZ(i);
  if(Math.abs(y-lagoon.level)>.01)continue;
  lagoonVertices++;assert.ok(liquidFootprint(lagoon,1337,x,z).distance<.02,'no lake plane beyond its authored footprint');
  assert.ok(world.column(x,z).h<y+.15,'shoreline clipping stays at the actual bank');
 }
 assert.ok(lagoonVertices>150);assert.equal(renderer.group.children.length,2);
 drain(renderer,{x:7100,y:8,z:1400});const river=vertices(renderer);let high=0,low=0;
 for(let i=0;i<river.count;i++){const y=river.getY(i);if(y>4&&y<5.5)high++;if(y>1&&y<3)low++;}
 assert.ok(high>50&&low>50,'river surface follows its downhill authored levels');
 renderer.dispose();
});

test('curved lake banks and the river inlet stay covered wherever the actual water is swimmable',()=>{
 const world=new World(1337);
 const witnesses=[
  {camera:{x:4900,y:8,z:1200},points:[[5328,820],[5560,1348],[5592,1268]]},
  {camera:{x:450,y:14,z:1250},points:[[308,1318],[348,1350],[540,1142]]},
  {camera:{x:-2800,y:64,z:-1200},points:[[-2918,-1049],[-2662,-1049],[-3014,-1105]]},
 ];
 for(const {camera,points} of witnesses) {
  const renderer=new LiquidRenderer(world,{now:()=>0});drain(renderer,camera);
  const mesh=renderer.group.getObjectByName('water-surfaces') as THREE.Mesh;
  for(const [x,z] of points) {
   const bed=world.column(x,z).h,water=world.liquidAt(x,bed+.1,z)!;
   assert.equal(water.kind,'water');assert.ok(water.surfaceY-bed>.3,'use a visibly wet bank, not the waterline tolerance');
   const ray=new THREE.Raycaster(new THREE.Vector3(x,water.surfaceY+.1,z),new THREE.Vector3(0,-1,0),0,water.surfaceY-bed+.1);
   assert.ok(ray.intersectObject(mesh).some(hit=>hit.point.y>bed),`missing lake surface above the submerged bank at ${x}, ${z}`);
  }
  assert.ok(renderer.stats.waterTriangles<80000,'shore refinement remains bounded and uses the two existing meshes');
  assert.equal(renderer.group.children.length,2);renderer.dispose();
 }
});

test('ocean cache, build work, geometry and material counts remain bounded during fast travel',()=>{
 let calls=0;const world={seed:1337,column:(x:number,z:number)=>{calls++;return {h:-50,lavaY:-1000} as ColumnData;},
  liquidAt:(x:number,y:number,z:number)=>liquidAtSurfaceColumn(1337,x,y,z,-50),collectJungleTemples:()=>[]};
 const renderer=new LiquidRenderer(world,{touch:true,now:()=>0});
 for(let i=0;i<40;i++) {
  calls=0;renderer.update({x:9600+i*512,y:3,z:400},i);
  assert.ok(calls<=128,'fixed sample cap bounds work even with a stopped timer');
 }
 drain(renderer,{x:9800,y:-1,z:1100});assert.equal(renderer.currentLiquid?.kind,'water');
 assert.ok(renderer.stats.waterTriangles>10000);assert.ok(renderer.stats.waterTriangles<=49*1024);
 for(let region=0;region<5;region++) {
  drain(renderer,{x:9800+region*2048,y:4,z:1100});assert.ok(renderer.stats.cachedTiles<=renderer.cacheLimit);
 }
 assert.equal(renderer.currentLiquid,undefined,'above-water camera never triggers an underwater overlay');
 const mesh=renderer.group.getObjectByName('water-surfaces') as THREE.Mesh<THREE.BufferGeometry,THREE.ShaderMaterial>;
 assert.equal(mesh.material.depthWrite,false);assert.equal(mesh.material.side,THREE.DoubleSide);
 assert.equal(mesh.geometry.groups.length,0,'all water tiles share a single draw');
 let disposed=0;mesh.geometry.addEventListener('dispose',()=>disposed++);renderer.dispose();renderer.dispose();
 assert.equal(disposed,1);assert.equal(renderer.group.children.length,0);
});

test('underground cisterns appear immediately at their own finite level without flooding the cave',()=>{
 const site:JungleTempleSite={id:1,kind:'great-pyramid',forestId:0,x:0,y:80,z:0,radius:184};
 const pool=buildJungleTemplePlan(site).cisterns[0];
 const world={seed:1337,column:()=>({h:80,lavaY:-1000} as ColumnData),collectJungleTemples:()=>[site],
  liquidAt:(x:number,y:number,z:number)=>Math.hypot((x-pool.x)/pool.hx,(z-pool.z)/pool.hz)<=1&&y>=pool.bottom&&y<=pool.level?
   {id:pool.id,kind:'water' as const,surfaceY:pool.level,bottomY:pool.bottom,distance:-1,flowX:0,flowZ:0}:undefined};
 const renderer=new LiquidRenderer(world,{now:()=>0});renderer.update({x:pool.x,y:pool.level-1,z:pool.z},0);
 const p=vertices(renderer);assert.equal(p.count,144);assert.equal(renderer.currentLiquid?.id,pool.id);
 for(let i=0;i<p.count;i++) {assert.ok(Math.abs(p.getY(i)-pool.level-.015)<.0001);
  assert.ok(Math.hypot((p.getX(i)-pool.x)/pool.hx,(p.getZ(i)-pool.z)/pool.hz)<1.00001);}
 renderer.update({x:pool.x+pool.hx+2,y:pool.level-1,z:pool.z},1);assert.equal(renderer.currentLiquid,undefined);
 renderer.update({x:9000,y:-200,z:9000},2);assert.equal(vertices(renderer).count,0,'old cistern geometry is removed on teleport');
 renderer.dispose();
});
