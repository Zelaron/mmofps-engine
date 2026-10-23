import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeMapLabels, shortControlName, type MapLabelBox } from '../src/map-labels.js';

const overlap=(a:MapLabelBox,b:MapLabelBox)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
test('dense tactical labels prioritize active reports and never overlap icons, each other or map edges',()=>{
  const candidates=Array.from({length:36},(_,i)=>({id:`site:${i}`,x:180+i%3*5,y:160+Math.floor(i/3)*3,width:100,height:13,priority:i===20?0:4}));
  const bounds={x:0,y:0,width:380,height:330},block={x:150,y:140,width:35,height:35};
  const placed=placeMapLabels(candidates,bounds,[block],9);
  assert.ok(placed.length>0&&placed.length<=9);assert.equal(placed[0].id,'site:20');assert.ok(placed.length<candidates.length);
  for(const [i,label] of placed.entries()){
    assert.ok(label.x>=5&&label.y>=5&&label.x+label.width<=375&&label.y+label.height<=325);assert.ok(!overlap(label,block));
    for(const prior of placed.slice(0,i))assert.ok(!overlap(label,prior));
  }
  assert.deepEqual(placeMapLabels([...candidates].reverse(),bounds,[block],9),placed,'packet ordering cannot shuffle labels');
});
test('offscreen labels are omitted and control names remove city or staging prefixes',()=>{
  assert.deepEqual(placeMapLabels([{id:'a',x:-5,y:20,width:40,height:12,priority:0}],{x:0,y:0,width:200,height:200}),[]);
  assert.equal(shortControlName('Meridian - North avenue exchange'),'North avenue exchange');
  assert.equal(shortControlName('Terran Accord staging · North relay'),'North relay');
  assert.equal(shortControlName('Harbor command'),'Harbor command');
});

test('critical capture status stays visible beyond a dense vehicle and respawn cluster',()=>{
  const cluster={x:35,y:54,width:130,height:88};
  const placed=placeMapLabels([{id:'contested',x:100,y:100,width:80,height:12,priority:0}],
    {x:0,y:0,width:300,height:200},[cluster],9);
  assert.equal(placed.length,1);
  assert.ok(!overlap(placed[0],cluster));
  assert.deepEqual([placed[0].anchorX,placed[0].anchorY],[100,100],'the control marker keeps its true position');
});
