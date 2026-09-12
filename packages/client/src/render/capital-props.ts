import * as THREE from 'three';
import { VehicleGeometry } from './vehicle-geometry.js';

/** Normalized roof ornaments: X/Z fit [-.5,.5], Y fits [0,1].
 * Place on existing solid crowns, never as apparent walkable cover. Geometry
 * and materials are immutable and shared by every InstancedMesh using them. */
export type CapitalPropKind = 'vesper-spire' | 'vesper-portal' | 'vesper-beacon'
  | 'aurelia-dome' | 'aurelia-buttress' | 'aurelia-standard';
export interface CapitalPropPart { readonly geometry: THREE.BufferGeometry; readonly material: THREE.Material }

const STONE = new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 28, specular: 0x585361 });
const EMISSION = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false });
const CACHE = new Map<CapitalPropKind, readonly CapitalPropPart[]>();
const INK = 0x292638, EDGE = 0x665b77, VIOLET = 0xb863ed, LIGHT = 0xe9b1ff;
const IVORY = 0xc7bea8, PALE = 0xe1d6bc, GOLD = 0xc6a15e, DEEP_GOLD = 0x857049, BURGUNDY = 0x6e3548;

function spire(body: VehicleGeometry, glow: VehicleGeometry): boolean {
  body.loft([{z:-.14,y:.14,w:.18,h:.14},{z:.14,y:.14,w:.18,h:.14}],INK);
  body.add(new THREE.ConeGeometry(.14,.69,8),EDGE,[0,.615,0]);
  for(const side of [-1,1]) {
    // Convex blade panels frame open slits, instead of hiding a stack of boxes.
    body.prism([[side*.09,.16,-.10],[side*.45,.49,-.065],[side*.25,.94,-.035],[side*.17,.52,-.05]], [0,0,.08],INK);
    body.prism([[side*.08,.27,.03],[side*.25,.60,.07],[side*.14,.81,.10],[side*.09,.43,.08]], [0,0,.05],EDGE);
    glow.tube(.009,[side*.13,.28,-.115],[side*.34,.51,-.08],VIOLET,5);
    glow.tube(.008,[side*.34,.51,-.08],[side*.245,.88,-.05],LIGHT,5);
  }
  body.add(new THREE.ConeGeometry(.06,.23,6),INK,[0,.885,0]);
  glow.add(new THREE.OctahedronGeometry(.067),LIGHT,[0,.30,-.135]);
  return true;
}

function portal(body: VehicleGeometry, glow: VehicleGeometry): boolean {
  body.loft([{z:-.15,y:.065,w:.32,h:.065},{z:.15,y:.065,w:.32,h:.065}],INK);
  // A broken elliptical crown has a real aperture; it is a rooftop finial,
  // not an uncollidable ground doorway or a gameplay teleporter.
  const arc = new THREE.TorusGeometry(.355,.041,6,32,Math.PI*1.55);
  arc.rotateZ(-Math.PI*.275);arc.scale(1,1.16,1);body.add(arc,EDGE,[0,.535,0]);
  const inset = new THREE.TorusGeometry(.351,.009,4,32,Math.PI*1.42);
  inset.rotateZ(-Math.PI*.21);inset.scale(1,1.16,1);glow.add(inset,VIOLET,[0,.535,-.042]);
  for(const side of [-1,1]) {
    body.prism([[side*.23,.06,-.08],[side*.40,.28,-.05],[side*.44,.78,-.04],[side*.26,.30,-.05]], [0,0,.10],INK);
    body.prism([[side*.24,.67,-.02],[side*.25,.87,-.015],[side*.13,1,-.01]], [0,0,.035],INK);
  }
  glow.add(new THREE.OctahedronGeometry(.065),LIGHT,[0,.89,0]);return true;
}

function beacon(body: VehicleGeometry, glow: VehicleGeometry): boolean {
  body.add(new THREE.CylinderGeometry(.25,.34,.09,8),EDGE,[0,.045,0]);
  body.add(new THREE.CylinderGeometry(.10,.20,.54,6),INK,[0,.36,0]);
  glow.add(new THREE.OctahedronGeometry(.17),VIOLET,[0,.73,0]);
  for(let i=0;i<3;i++) {
    const a=i*Math.PI*2/3, x=Math.cos(a),z=Math.sin(a);
    body.tube(.016,[x*.16,.43,z*.16],[x*.25,.85,z*.25],EDGE,6,.008);
    body.tube(.009,[x*.25,.85,z*.25],[x*.05,.995,z*.05],INK,5,.002);
    glow.tube(.006,[x*.12,.18,z*.12],[x*.12,.49,z*.12],LIGHT,5);
  }
  return true;
}

function dome(body: VehicleGeometry): boolean {
  body.add(new THREE.CylinderGeometry(.48,.50,.08,24),DEEP_GOLD,[0,.04,0]);
  body.add(new THREE.CylinderGeometry(.445,.445,.12,24),IVORY,[0,.14,0]);
  const cap = new THREE.SphereGeometry(.45,24,12,0,Math.PI*2,0,Math.PI/2);
  cap.scale(1,1.22,1);body.add(cap,PALE,[0,.2,0]);
  for(let i=0;i<10;i++) {
    const az=i*Math.PI*2/10, points:THREE.Vector3[]=[];
    for(let j=0;j<=12;j++) {const a=j/12*Math.PI*.5;points.push(new THREE.Vector3(Math.sin(a)*.455*Math.cos(az),.2+Math.cos(a)*.555,Math.sin(a)*.455*Math.sin(az)));}
    body.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),12,.0065,5,false),GOLD);
  }
  body.add(new THREE.CylinderGeometry(.064,.082,.14,10),DEEP_GOLD,[0,.785,0]);
  body.add(new THREE.SphereGeometry(.072,12,8),GOLD,[0,.86,0]);
  body.add(new THREE.ConeGeometry(.032,.11,8),GOLD,[0,.945,0]);
  return false;
}

function buttress(body: VehicleGeometry): boolean {
  // Open flying arch and a pointed outer pier. The void is actual geometry.
  body.prism([[-.48,0,-.10],[-.32,0,-.10],[-.32,.50,-.10],[-.38,.72,-.10],[-.48,.56,-.10]], [0,0,.20],IVORY);
  const points:THREE.Vector3[]=[];
  for(let i=0;i<=16;i++) {const t=i/16;points.push(new THREE.Vector3(-.36+t*.79,.48+Math.sin(t*Math.PI*.5)*.44,0));}
  body.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points),16,.048,6,false),PALE);
  body.add(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points.map(p=>new THREE.Vector3(p.x,p.y+.04,p.z))),16,.009,5,false),GOLD);
  body.add(new THREE.ConeGeometry(.09,.25,6),GOLD,[-.40,.875,0]);
  body.box(.16,.05,.24,-.40,.67,0,DEEP_GOLD);
  body.tube(.035,[-.40,.67,0],[-.40,.80,0],GOLD,6);
  return false;
}

function standard(body: VehicleGeometry): boolean {
  body.add(new THREE.CylinderGeometry(.12,.18,.08,8),DEEP_GOLD,[0,.04,0]);
  body.tube(.019,[0,.05,0],[0,.92,0],GOLD,8,.011);
  body.tube(.015,[-.35,.73,0],[.35,.73,0],GOLD,8);
  // Rigid heraldic pendants hang below the gilded wing crest.
  body.prism([[-.235,.71,-.016],[.235,.71,-.016],[.205,.34,-.016],[0,.23,-.016],[-.205,.34,-.016]], [0,0,.032],BURGUNDY);
  body.prism([[-.065,.62,-.035],[.065,.62,-.035],[.052,.44,-.035],[0,.39,-.035],[-.052,.44,-.035]], [0,0,.018],GOLD);
  for(const side of [-1,1]) for(let i=0;i<4;i++) {
    const x=side*(.07+i*.073);
    body.prism([[x,.79,-.02],[x+side*.10,.89+i*.02,-.02],[x+side*.045,.74,-.02]], [0,0,.04],GOLD);
  }
  body.add(new THREE.OctahedronGeometry(.055),PALE,[0,.945,0]);
  return false;
}

/** At most two shared material batches; no textures, alpha cards or lights. */
export function capitalPropParts(kind: CapitalPropKind): readonly CapitalPropPart[] {
  const cached=CACHE.get(kind);if(cached)return cached;
  const body=new VehicleGeometry(),glow=new VehicleGeometry();
  const lit=kind==='vesper-spire'?spire(body,glow):kind==='vesper-portal'?portal(body,glow)
    :kind==='vesper-beacon'?beacon(body,glow):kind==='aurelia-dome'?dome(body)
    :kind==='aurelia-buttress'?buttress(body):standard(body);
  const parts:CapitalPropPart[]=[{geometry:body.mesh(STONE,kind).geometry,material:STONE}];
  if(lit)parts.push({geometry:glow.mesh(EMISSION,kind+'-glow').geometry,material:EMISSION});
  const result=Object.freeze(parts.map(part=>Object.freeze(part)));CACHE.set(kind,result);return result;
}
