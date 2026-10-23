import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlActivity, ownershipShares, normalizeOwnership, territoryRegions, territoryBorders } from '../src/territory-map.js';
import type { Territory } from '@shared/frontier';

test('tactical status separates stalled contests, attacks and capture progress from ownership',()=>{
  const site:Territory={id:'vesper',name:'Vesper Reach',kind:'city',x:100,y:20,z:100,radius:40,owner:1,influence:1,contested:false,
    captureFaction:1,captureProgress:.65,pressureFaction:2,progressRate:-1/35};
  const attack=controlActivity(site);
  assert.equal(attack.kind,'attacked');assert.equal(attack.label,'UNDER ATTACK 35%');assert.equal(attack.faction,2);
  assert.equal(site.owner,1,'attacker color does not repaint ownership');
  const contest=controlActivity({...site,contested:true,progressRate:0,pressureFaction:0});
  assert.equal(contest.label,'CONTESTED');assert.equal(contest.active,true);
  const capture=controlActivity({...site,owner:0,captureFaction:2,progressRate:1/35});
  assert.equal(capture.label,'CAPTURING 65%');assert.equal(capture.faction,2);
  const empty=controlActivity({...site,progressRate:0,pressureFaction:0});assert.equal(empty.active,false);assert.equal(empty.label,'HELD');
  assert.equal(controlActivity({...site,progressRate:undefined,captureRate:-1/35}).kind,'attacked','older snapshots retain active markers');
  assert.equal(controlActivity({...site,owner:0,influence:-.4,captureFaction:1,captureProgress:.4,pressureFaction:1,progressRate:undefined,captureRate:-1/35}).label,'CAPTURING 40%',
    'legacy signed influence may decrease while the first faction gains control');
  assert.equal(controlActivity({...site,owner:0,captureFaction:0,captureProgress:0}).label,'CAPTURING 0%',
    'a just-neutralized point begins a new claim even if its last tick was negative');
});

test('friendly restoration changes wording without changing capture rings or rounded percentages',()=>{
  const site:Territory={id:'friendly',name:'Friendly relay',kind:'city',x:0,y:0,z:0,radius:40,owner:1,influence:-.996,contested:false,
    captureFaction:1,captureProgress:.996,pressureFaction:1,progressRate:1/60};
  const restoring=controlActivity(site);
  assert.equal(restoring.restoring,true);assert.equal(restoring.label,'RESTORING CONTROL 100%');
  assert.equal(restoring.kind,'capturing');assert.equal(restoring.active,true);
  assert.equal(restoring.progress,.996);assert.equal(restoring.faction,1);
  const neutral=controlActivity({...site,owner:0});
  assert.equal(neutral.restoring,false);assert.equal(neutral.label,'CAPTURING 100%');
  assert.equal(neutral.progress,restoring.progress);assert.equal(neutral.color,restoring.color);
  const attacked=controlActivity({...site,captureProgress:.65,pressureFaction:2,progressRate:-1/60});
  assert.equal(attacked.restoring,false);assert.equal(attacked.label,'UNDER ATTACK 35%');
  const contested=controlActivity({...site,contested:true});
  assert.equal(contested.restoring,false);assert.equal(contested.label,'CONTESTED');
  const held=controlActivity({...site,progressRate:0});
  assert.equal(held.restoring,false);assert.equal(held.label,'HELD');
  assert.equal(controlActivity({...site,progressRate:undefined,captureRate:-1/60}).label,'RESTORING CONTROL 100%',
    'legacy signed influence still identifies friendly restoration');
});

const area = (polygon: { x: number; y: number }[]) => Math.abs(polygon.reduce((sum, point, i) => {
  const next = polygon[(i + 1) % polygon.length]; return sum + point.x * next.y - next.x * point.y;
}, 0)) / 2;

test('ownership regions fill the map without overlap and follow captured point locations', () => {
  const points = [{ id: 'west', x: 100, y: 300 }, { id: 'east', x: 500, y: 300 }, { id: 'north', x: 300, y: 80 }];
  const regions = territoryRegions(points);
  assert.ok(Math.abs(regions.reduce((sum, region) => sum + area(region.polygon), 0) - 600 * 600) < .001);
  for (const [index, region] of regions.entries()) for (const vertex of region.polygon) {
    assert.ok(vertex.x >= 0 && vertex.x <= 600 && vertex.y >= 0 && vertex.y <= 600);
    const distance = Math.hypot(vertex.x - points[index].x, vertex.y - points[index].y);
    for (const point of points) assert.ok(distance <= Math.hypot(vertex.x - point.x, vertex.y - point.y) + 1e-7);
  }
});

test('overlapping controls and empty worlds produce finite deterministic map geometry', () => {
  const regions = territoryRegions([{ id: 'a', x: 300, y: 300 }, { id: 'b', x: 300, y: 300 }]);
  assert.equal(area(regions[0].polygon), 600 * 600); assert.deepEqual(regions[1].polygon, []);
  assert.deepEqual(territoryRegions([]), []);
});

test('planet strips measure captured control points, including unclaimed shares', () => {
  assert.deepEqual(ownershipShares([{ owner: 1 }, { owner: 1 }, { owner: 2 }, { owner: 0 }]), [.25, .5, .25, 0]);
  assert.deepEqual(ownershipShares([]), [1, 0, 0, 0]);
  assert.deepEqual(normalizeOwnership([NaN, -5, Infinity]), [1, 0, 0, 0]);
  assert.deepEqual(normalizeOwnership([0, 3, 1, 4]), [0, .375, .125, .5]);
});

test('front lines follow shared hostile boundaries, never friendly subdivisions or map edges',()=>{
  const regions=territoryRegions([{id:'west',x:100,y:300},{id:'center',x:300,y:300},{id:'east',x:500,y:300}]);
  const owners=new Map([['west',1],['center',1],['east',2]]);
  const borders=territoryBorders(regions,owners);assert.equal(borders.length,1);
  assert.equal(borders[0].a.x,400);assert.equal(borders[0].b.x,400);assert.deepEqual(borders[0].owners,[1,2]);
  owners.set('east',0);assert.deepEqual(territoryBorders(regions,owners),[]);
  owners.set('east',1);assert.deepEqual(territoryBorders(regions,owners),[]);
});
