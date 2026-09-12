import { PLAYER } from './constants.js';
import { smoothstep } from './math.js';
import { rainforestSites } from './rainforest.js';
import { hash2i, unit } from './rng.js';
import type { Box, ColumnData } from './worldgen.js';

export type JungleTempleKind = 'great-pyramid' | 'sun-shrine' | 'root-vault' | 'serpent-gate';
export interface JungleTempleSite {
  id: number; kind: JungleTempleKind; x: number; y: number; z: number; radius: number; forestId: number;
}
export interface TemplePoint { x: number; y: number; z: number }
export interface TempleGallery { a: TemplePoint; b: TemplePoint; width: number; height: number; open?: boolean }
export interface TempleTrap {
  id: number; templeId: number; kind: 'spikes' | 'crusher' | 'darts';
  x: number; y: number; z: number; hx: number; hz: number; height: number;
  period: number; phase: number; damage: number;
}
export interface TempleLoot extends TemplePoint { id: number; weapon: number; cave: boolean }
export interface TempleCistern { id: number; x: number; z: number; hx: number; hz: number; bottom: number; level: number }
export interface JungleTemplePlan {
  site: JungleTempleSite; solids: Box[]; galleries: TempleGallery[];
  routes: TemplePoint[][]; entrances: TemplePoint[]; traps: TempleTrap[]; loot: TempleLoot[]; cisterns: TempleCistern[];
}
export interface TempleTrapPose { active: boolean; warning: boolean; extension: number; progress: number }

/** The visible wind-up and danger interval share the authoritative tick clock. */
export function templeTrapPose(trap: TempleTrap, seconds: number): TempleTrapPose {
  const t = ((seconds + trap.phase) % trap.period + trap.period) % trap.period;
  const active = t >= 2.2 && t < 3.6;
  const extension = t < 2.2 ? 0 : t < 2.45 ? (t - 2.2) / .25 : t < 3.2 ? 1 : Math.max(0, (3.6 - t) / .4);
  return { active, warning: t >= 1.2 && t < 2.2, extension, progress: active ? (t - 2.2) / 1.4 : 0 };
}

/** Cosmetic mechanisms are hazards, not invisible moving collision walls. */
export function templeTrapTouches(trap: TempleTrap, seconds: number, x: number, feet: number, z: number, radius = PLAYER.RADIUS): boolean {
  const pose = templeTrapPose(trap, seconds);
  if (!pose.active || Math.abs(x - trap.x) > trap.hx + radius || Math.abs(z - trap.z) > trap.hz + radius) return false;
  if(trap.kind==='darts' && Math.abs(x-(trap.x+(((pose.progress*3)%1)*2-1)*trap.hx))>radius+.35) return false;
  const low = trap.kind === 'crusher' ? trap.y + trap.height * (1 - pose.extension) : trap.y;
  const high = trap.kind === 'spikes' ? trap.y + pose.extension * 1.5 : trap.y + trap.height;
  return feet < high && feet + PLAYER.HEIGHT > low;
}

/** Seven authored complexes distributed inside the three rainforest cores. */
export function createJungleTempleSites(seed: number, sample: (x: number, z: number) => ColumnData): readonly JungleTempleSite[] {
  const sites: JungleTempleSite[] = [];
  for (const [forestId, forest] of rainforestSites(seed).entries()) {
    const add = (x: number, z: number, kind: JungleTempleKind): void => {
      const col = sample(x, z);
      sites.push({ id: sites.length + 1, forestId, kind, x, z, y: Math.max(14, col.h), radius: kind === 'great-pyramid' ? 184 : 92 });
    };
    if (forestId === 0) add(forest.x + 80, forest.z - 40, 'great-pyramid');
    for (let i = 0; i < 2; i++) {
      const angle = i * Math.PI + .62 + unit(hash2i(seed ^ 0x71e4, forestId, i)) * .28;
      add(forest.x + Math.cos(angle) * forest.radius * .57, forest.z + Math.sin(angle) * forest.radius * .57,
        (['sun-shrine', 'root-vault', 'serpent-gate'] as const)[(forestId + i) % 3]);
    }
  }
  return sites;
}

const plans = new WeakMap<JungleTempleSite, JungleTemplePlan>();
export function buildJungleTemplePlan(site: JungleTempleSite): JungleTemplePlan {
  const cached = plans.get(site); if (cached) return cached;
  const plan: JungleTemplePlan = { site, solids: [], galleries: [], routes: [], entrances: [], traps: [], loot: [], cisterns: [] };
  const big = site.kind === 'great-pyramid';
  const p = (x: number, y: number, z: number): TemplePoint => ({ x: site.x + x, y: site.y + y, z: site.z + z });
  const box = (x: number, y: number, z: number, hx: number, hy: number, hz: number, shade = 0): void => {
    plan.solids.push({ ...p(x, y, z), hx, hy, hz, capital: true, facade: 112 + shade, floorY: site.y });
  };
  const gallery = (points: TemplePoint[], width = 5.5, height = 7, openFirst = false): void => {
    plan.routes.push(points);
    for (let i = 1; i < points.length; i++) plan.galleries.push({ a: points[i - 1], b: points[i], width, height, open: openFirst && i === 1 });
  };
  const hall = (x: number, y: number, z: number, radius: number, height: number): void => {
    const point = p(x, y, z); plan.galleries.push({ a: point, b: point, width: radius, height });
    for (let i = 0; i < 8; i++) {
      const a = (i + .5) * Math.PI / 4, px = x + Math.sin(a) * (radius - 1), pz = z + Math.cos(a) * (radius - 1);
      box(px, y + height * .5, pz, .6, height * .5, .6, 1);
      box(px, y + .32, pz, 1.2, .32, 1.2, 2);
      box(px, y + height - .35, pz, 1.15, .35, 1.15, 2);
    }
  };
  const gate = (x: number, z: number, alongX: boolean, height = 9): void => {
    for (const side of [-1, 1]) {
      box(x + (alongX ? 0 : side * 7), height * .5, z + (alongX ? side * 7 : 0), alongX ? 3.3 : 1.5, height * .5, alongX ? 1.5 : 3.3, 1);
      box(x + (alongX ? 0 : side * 7), height + .4, z + (alongX ? side * 7 : 0), alongX ? 3.8 : 2, .8, alongX ? 2 : 3.8, 2);
    }
    box(x, height + .1, z, alongX ? 3.8 : 9, .7, alongX ? 9 : 3.8, 2);
    box(x, height + 1.6, z, alongX ? 2.8 : 6.5, .8, alongX ? 6.5 : 2.8, 1);
  };
  const loot = (x: number, y: number, z: number, weapon: number, cave = true): void => {
    // Low stone offering plates provide physical support without blocking a route.
    box(x, y + .16, z, 1.2, .16, 1.2, 2);
    plan.loot.push({ ...p(x, y + .42, z), id: 500000 + site.id * 100 + plan.loot.length, weapon, cave });
  };
  const trap = (kind: TempleTrap['kind'], x: number, y: number, z: number, width: number, depth: number, alongX=false): void => {
    plan.traps.push({ ...p(x, y, z), id: site.id * 100 + plan.traps.length, templeId: site.id, kind,
      hx: width, hz: depth, height: kind === 'crusher' ? 6 : 2, period: 7 + plan.traps.length * .7, phase: site.id * 1.73 + plan.traps.length,
      damage: kind === 'crusher' ? 48 : kind === 'spikes' ? 24 : 18 });
    for (const side of [-1, 1]) box(x + (alongX?0:side * (width + .7)), y + .12, z+(alongX?side*(depth+.7):0), alongX?width+.3:.22, .12, alongX?.22:depth + .3, 3);
    if(kind==='crusher') {
      for(const side of [-1,1]) box(x+(alongX?0:side*(width+.7)),y+3.2,z+(alongX?side*(depth+.7):0),.4,3.2,.4,1);
      box(x,y+6.6,z,width+1,.35,depth+.4,2);
    }
  };
  if (big) {
    // A 208m-wide stepped silhouette with a real open processional gate.
    for (let tier = 0; tier < 11; tier++) {
      const r = 104 - tier * 7.5, inner = Math.max(0, r - 12), y = tier * 3.8 + 1.9;
      box(-r + 6, y, 0, 6, 1.9, r, tier % 3); box(r - 6, y, 0, 6, 1.9, r, tier % 3);
      box(0, y, -r + 6, inner, 1.9, 6, tier % 3);
      const gap = tier < 3 ? 9 : 0;
      if (gap) for (const side of [-1, 1]) box(side * (inner + gap) * .5, y, r - 6, (inner - gap) * .5, 1.9, 6, tier % 3);
      else box(0, y, r - 6, inner, 1.9, 6, tier % 3);
      // Broad stone ledges read as courses and shaded relief from a distance.
      for (const side of [-1, 1]) box(side * (r - .8), y + 1.5, 0, 1.2, .4, r + .6, 2);
    }
    box(0, 42.4, 0, 26, .6, 26, 2);
    for (const side of [-1, 1]) box(side * 16, 51, 0, 4, 8, 15, 1);
    box(0, 60, 0, 22, 2, 20, 2); box(0, 64, 0, 15, 2, 14, 1); box(0, 68, 0, 8, 2, 8, 2);
    for (const [x,z,axis] of [[0,145,0],[0,-145,0],[-145,0,1],[145,0,1]]) gate(x,z,!!axis);
    hall(0,-24,0,24,14);
    for (const [dx,dz] of [[0,1],[0,-1],[1,0],[-1,0]]) {
      const route = [p(dx*172,0,dz*172),p(dx*135,0,dz*135),p(dx*84,-24,dz*84),p(0,-24,0)];
      gallery(route,6,8,true); plan.entrances.push(route[0]);
    }
    const loop = [p(-52,-24,-52),p(52,-24,-52),p(52,-24,52),p(-52,-24,52),p(-52,-24,-52)];
    gallery(loop,5.5,7);
    for (const side of [-1,1]) {
      gallery([p(0,-24,side*52),p(0,-24,0)],6,8);
      hall(side*52,-24,0,13,10);
      gallery([p(side*52,-24,0),p(0,-24,0)],5,8);
      loot(side*57,-24,5,side<0?5:9);
    }
    hall(28,-24,-72,12,10); gallery([p(28,-24,-52),p(28,-24,-72)],5,7);
    loot(28,-24,-78,6); loot(9,-24,8,9);
    trap('spikes',0,-24,40,2.5,4); trap('crusher',40,-24,0,2.6,3,true); trap('darts',-52,-24,25,2.8,2.3);
    // A side cistern has a dry perimeter and its own stair, never flooding
    // the primary routes or trap lanes. Root owns the explicit liquid body.
    hall(86,-24,-18,15,11); gallery([p(52,-24,0),p(73,-24,-18)],4.5,8);
    const pool=p(86,-29,-18); plan.galleries.push({a:pool,b:pool,width:8,height:16});
    plan.cisterns.push({id:site.id*10,x:pool.x,z:pool.z,hx:8,hz:8,bottom:pool.y,level:site.y-24.8});
    for(let i=0;i<20;i++) {
      const top=-24-(i+1)*.25; box(86,(-29+top)*.5,-26+i*.45,1.8,(top+29)*.5+.04,.235,2);
    }
  } else {
    const height = site.kind === 'sun-shrine' ? 26 : site.kind === 'root-vault' ? 15 : 21;
    for (let tier=0;tier<4;tier++) {
      const r=24-tier*4.5, y=tier*2.6+1.3;
      box(-r+3,y,0,3,1.3,r,tier%3); box(r-3,y,0,3,1.3,r,tier%3);
      for(const side of [-1,1]) for(const xside of [-1,1]) box(xside*(r+8)*.5,y,side*(r-3),(r-8)*.5,1.3,3,tier%3);
    }
    for (const side of [-1,1]) box(side*10,height*.5,0,2.5,height*.5,6,1);
    box(0,height,0,14,1.5,9,2);
    if(site.kind==='serpent-gate') for(const side of [-1,1]) {
      box(side*17,3,28,3,3,7,1); box(side*17,8,25,2,3,3,2); box(side*17,11,28,3.3,1.2,4.5,3);
    }
    hall(0,-12,0,15,10);
    for (const side of [-1,1]) {
      const route=[p(0,0,side*82),p(0,0,side*66),p(0,-12,side*20),p(0,-12,0)];
      gallery(route,5.3,7,true); plan.entrances.push(route[0]); gate(0,side*64,false,7.5);
    }
    gallery([p(0,-12,0),p(26,-12,0)],4.8,7); hall(26,-12,0,10,9);
    loot(30,-12,0,site.id%2?5:9); loot(-7,-12,-3,site.id%3?9:6);
    trap(site.kind==='sun-shrine'?'spikes':site.kind==='root-vault'?'crusher':'darts',0,-12,13,2.2,2.8);
  }
  plans.set(site,plan); return plan;
}

export interface TempleColumn { samples: { floor: number; margin: number; distance: number; height: number; scale: number; open: boolean }[] }
export function jungleTempleColumn(site: JungleTempleSite, x: number, z: number): TempleColumn | undefined {
  if(Math.abs(x-site.x)>site.radius || Math.abs(z-site.z)>site.radius) return undefined;
  const samples: TempleColumn['samples'] = [];
  for(const g of buildJungleTemplePlan(site).galleries) {
    const dx=g.b.x-g.a.x,dz=g.b.z-g.a.z,l2=dx*dx+dz*dz;
    const t=Math.max(0,Math.min(1,((x-g.a.x)*dx+(z-g.a.z)*dz)/Math.max(.001,l2)));
    const distance=Math.hypot(x-g.a.x-dx*t,z-g.a.z-dz*t),margin=g.width-distance;
    if(margin < -3) continue;
    samples.push({floor:g.a.y+(g.b.y-g.a.y)*t,margin,distance,height:g.height,scale:1+Math.abs(g.b.y-g.a.y)/Math.sqrt(Math.max(1,l2)),open:!!g.open});
  }
  return samples.length?{samples}:undefined;
}

/** Stone sleeves preserve every floor even where old noise caverns intersect.
 * Their shared open volume connects overlapping ramps and chambers both ways. */
export function jungleTempleField(column: TempleColumn, y: number, terrain: number): number {
  let solid=Infinity,air=-Infinity,nearest=Infinity,floor=Infinity,scale=1;
  for(const s of column.samples) if(s.margin>=0) {
    if(s.distance<nearest-1e-6){nearest=s.distance;floor=s.floor;scale=s.scale;}
    else if(Math.abs(s.distance-nearest)<1e-6){floor=Math.min(floor,s.floor);scale=Math.max(scale,s.scale);}
  }
  for(const s of column.samples) {
    solid=Math.min(solid,Math.max(-s.margin-2,s.floor-2-y,y-s.floor-(s.open?0:s.height+2))/s.scale);
    air=Math.max(air,Math.min(s.margin,y-s.floor,s.open?Infinity:s.floor+s.height-y)/s.scale);
  }
  // Rounded joins must not let the flat corridor's cap carve the bottom
  // six meters of an adjoining ramp into an un-climbable vertical step.
  if(floor<Infinity)air=Math.min(air,(y-floor)/scale);
  return Math.max(Math.min(terrain,solid),air);
}

export function jungleTempleGrade(site: JungleTempleSite, x: number, z: number): number {
  return smoothstep(site.radius+120,site.radius-6,Math.max(Math.abs(x-site.x),Math.abs(z-site.z)));
}
