import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// A deterministic UI fixture exercises production map code independently of
// WebGL/server load, so DOM reuse and map repaint regressions are measurable.
const bundle=await build({bundle:true,write:false,format:'iife',platform:'browser',target:'es2022',
  stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {World} from './packages/shared/src/worldgen.ts';
import {CAPTURE_SECONDS} from './packages/shared/src/frontier.ts';
import {FrontierUI} from './packages/client/src/frontier.ts';
import {NavigationMap,worldMapSvg} from './packages/client/src/world-map.ts';
import {WorldMapStream} from './packages/client/src/world-map-stream.ts';
const world=new World(1337),plan=world.collectTransportPlan(),art=worldMapSvg(world,plan),stream=new WorldMapStream(1337,art);
const bases=world.collectCities().map((city,i)=>({id:'city-'+i,name:city.name,kind:'city',x:city.x,y:20,z:city.z,owner:(i%3)+1,homeFaction:0,requiredPoints:2,controlIds:[0,1,2].map(n=>'control-'+i+'-'+n)}));
const territories=bases.flatMap((base,i)=>base.controlIds.map((id,n)=>({id,name:base.name+' - '+['Command','North approach','West relay'][n],kind:'city',baseId:base.id,x:base.x+(n===2?-400:n===1?300:0),y:20,z:base.z+(n===1?-320:n===2?200:0),radius:45,owner:base.owner,influence:1,contested:false,captureProgress:1,captureFaction:base.owner,progressRate:0})));
const vesper=bases.find(base=>base.name.includes('Vesper'))??bases[1],target=territories.find(site=>site.id===vesper.controlIds[1]),contest=territories.find(site=>site.id===vesper.controlIds[2]);
Object.assign(target,{owner:1,captureFaction:1,captureProgress:.62,pressureFaction:2,progressRate:-1/CAPTURE_SECONDS});
Object.assign(contest,{owner:1,captureFaction:1,captureProgress:.8,contested:true});
const distant=territories.find(site=>site.baseId!==vesper.id);Object.assign(distant,{owner:0,captureFaction:3,captureProgress:.35,pressureFaction:3,progressRate:1/CAPTURE_SECONDS});
const state={revision:1,you:{faction:1,salvage:20,discoveries:[],factionCooldown:0},nearby:[],bases,territories,
  order:{baseId:vesper.id,targetId:target.id,name:vesper.name,x:target.x,z:target.z,phase:'defend',squad:1,staging:{x:vesper.x,y:20,z:vesper.z}},
  reinforcements:{selected:null,options:bases.filter(base=>base.owner===1).map(base=>({...base,kind:'base',baseId:base.id}))},
  battles:[{id:'vesper-fight',name:vesper.name,x:vesper.x,z:vesper.z,intensity:.75,factions:[1,2]}]};
const ui=new FrontierUI(()=>{},()=>{});ui.setWorld(world,stream);ui.receive(state);ui.update(vesper.x+100,20,vesper.z+100,0,1);
localStorage.setItem('mmofps-minimap','1');const mini=new NavigationMap();mini.setWorld(world,stream);mini.receive(state);
const intel={vehicle:0,contacts:Array.from({length:160},(_,i)=>({id:'infantry-'+i,x:vesper.x+Math.sin(i*2.4)*500,z:vesper.z+Math.cos(i*2.4)*500,yaw:0,kind:'infantry',relation:i%2?'hostile':'friendly',faction:i%2?2:1,label:i%2?'Enemy':'Friendly'}))};
ui.setIntel(intel);mini.setIntel(intel);
window.fixture={ui,mini,state,world,vesper,target,contest,intel,art,stream};
let seconds=2;setInterval(()=>{seconds+=.15;ui.update(vesper.x+100,20,vesper.z+100,0,seconds);mini.update(vesper.x+100,vesper.z+100,0,seconds,ui.open);},150);
`}});
const css=await readFile('packages/client/public/frontier.css'),html='<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/frontier.css"><style>body{margin:0;background:#101b25}#navigation-map canvas{display:block;width:220px;height:220px}</style><body><script src="/map-fixture.js"></script>';
const server=createServer(async(req,res)=>{
  try{
    if(req.url==='/map-fixture.js'){res.setHeader('content-type','text/javascript');res.end(bundle.outputFiles[0].contents);}
    else if(req.url==='/frontier.css'){res.setHeader('content-type','text/css');res.end(css);}
    else if(req.url==='/fonts/barlow.ttf'||req.url==='/fonts/barlow-condensed.ttf'){res.end(await readFile('packages/client/public'+req.url));}
    else {res.setHeader('content-type','text/html');res.end(html);}
  }catch{res.statusCode=404;res.end();}
});
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
const address=server.address();assert.ok(address&&typeof address!=='string');
const browser=await chromium.launch({headless:true});
const reports:unknown[]=[];
await mkdir('artifacts',{recursive:true});
try{
  for(const viewport of [{width:1440,height:900},{width:844,height:390},{width:390,height:844}]){
    const context=await browser.newContext({viewport}),page=await context.newPage(),errors:string[]=[];
    page.on('pageerror',error=>{errors.push(error.message);console.error(error);});
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.waitForFunction(()=>!!(window as any).fixture);
    await page.evaluate(()=>document.fonts.ready);
    const initial=await page.evaluate(()=>({pins:document.querySelector('.atlas-pins')!.children.length,territories:document.querySelector('.atlas-territory')!.children.length}));
    assert.deepEqual(initial,{pins:0,territories:0},'closed atlas defers all strategic geometry and DOM work');
    await page.keyboard.press('KeyG');
    await page.locator('.atlas-control-report').first().waitFor({state:'visible'});
    assert.equal(await page.locator('.atlas-control-report').count(),3);
    assert.match(await page.locator('.atlas-situation-detail').innerText(),/1 under attack.*1 contested.*1 capturing/);
    const restoration=await page.evaluate(()=>{
      const f=(window as any).fixture,saved={...f.target};
      Object.assign(f.target,{pressureFaction:f.target.owner,progressRate:1/60,captureProgress:.996});f.ui.receive(f.state);
      const report=Array.from(document.querySelectorAll<HTMLElement>('.atlas-control-report')).find(node=>node.dataset.control===f.target.id)!;
      const result={label:report.querySelector('strong')!.textContent,detail:report.querySelector('span')!.textContent,state:report.dataset.state,
        progress:report.querySelector('i')!.style.getPropertyValue('--capture-progress')};
      Object.assign(f.target,saved);f.ui.receive(f.state);return result;
    });
    assert.equal(restoration.label,'RESTORING CONTROL 100%');
    assert.match(restoration.detail!,/ · Restoring control$/);assert.ok(!restoration.detail!.includes('→'),'friendly restoration has no self-arrow');
    assert.equal(restoration.state,'capturing');assert.equal(restoration.progress,'99.6%');
    const overviewLabels=await page.locator('.map-placed-label text').allTextContents();
    assert.ok(overviewLabels.some(text=>text.includes('CONTESTED')||text.includes('UNDER ATTACK')),'active objectives are labeled at planet zoom');
    assert.equal(await page.locator('.atlas-live-pins [data-kind=infantry]').count(),0,'planet view stays focused on objectives');
    assert.equal(await page.locator('.atlas-map filter,.terrain-contours').count(),0);
    const metrics=await page.evaluate(()=>{
      const f=(window as any).fixture,art=document.querySelector('.atlas-map svg'),polygon=document.querySelector('.territory-regions polygon'),pin=document.querySelector('.map-base'),times:number[]=[];
      for(let i=0;i<60;i++){const start=performance.now();f.state.revision++;f.ui.receive(f.state);times.push(performance.now()-start);}
      const noOpPinsReused=pin===document.querySelector('.map-base');
      f.target.captureProgress=.4;f.ui.receive(f.state);
      const control=document.querySelector<HTMLElement>('.atlas-control-report')!,controlId=control.dataset.control;control.focus();
      f.ui.receive(f.state);
      const controlFocusPreserved=(document.activeElement as HTMLElement)?.dataset.control===controlId;
      document.querySelector<HTMLElement>('.atlas-order-card')!.focus();f.ui.receive(f.state);
      const objectiveFocusPreserved=document.activeElement?.matches('.atlas-order-card');
      return {artReused:art===document.querySelector('.atlas-map svg'),regionsReused:polygon===document.querySelector('.territory-regions polygon'),noOpPinsReused,
        controlFocusPreserved,objectiveFocusPreserved,
        packetMs:times.reduce((a,b)=>a+b,0)/times.length,worstPacketMs:Math.max(...times),artBytes:f.art.length,
        basemapNodes:art!.querySelectorAll('*').length,allMapNodes:document.querySelector('.atlas-cartography')!.querySelectorAll('*').length};
    });
    assert.equal(metrics.artReused,true);assert.equal(metrics.regionsReused,true);assert.equal(metrics.noOpPinsReused,true);
    assert.equal(metrics.controlFocusPreserved,true,'live control-point reports preserve keyboard focus');
    assert.equal(metrics.objectiveFocusPreserved,true,'live squad objectives preserve keyboard focus');
    assert.ok(metrics.artBytes<80000);assert.ok(metrics.packetMs<30,'strategic updates must remain below a frame at 30 Hz in this isolated fixture');
    await page.locator('.atlas-cartography').scrollIntoViewIfNeeded();
    await page.screenshot({path:`artifacts/map-overview-${viewport.width}.png`});
    await page.locator('.atlas-control-report[data-state=attacked]').click();
    await page.waitForFunction(()=>document.querySelector('.atlas-zoom')?.textContent?.startsWith('4'));
    await page.locator('.map-control-status').first().waitFor({state:'visible'});
    assert.ok(await page.locator('.atlas-live-pins [data-kind=infantry]').count()>0,'local zoom reveals unit contacts');
    const layers=await page.locator('.atlas-map svg,.atlas-territory,.atlas-live-pins,.atlas-pins').evaluateAll(nodes=>nodes.map(node=>node.getAttribute('viewBox')));
    assert.equal(new Set(layers).size,1,'all four map layers share the same viewport');
    const overlap=await page.locator('.map-placed-label text').evaluateAll(nodes=>{
      const boxes=nodes.map(node=>node.getBoundingClientRect());return boxes.some((box,i)=>boxes.slice(0,i).some(other=>box.left<other.right&&box.right>other.left&&box.top<other.bottom&&box.bottom>other.top));
    });
    assert.equal(overlap,false,'control labels remain separate at local zoom');
    await page.locator('.atlas-cartography').scrollIntoViewIfNeeded();
    await page.screenshot({path:`artifacts/map-local-${viewport.width}.png`});
    const quiet=await page.evaluate(async()=>{
      const f=(window as any).fixture;f.ui.toggle(false);let mutations=0;
      const observer=new MutationObserver(records=>mutations+=records.length);observer.observe(document.querySelector('.atlas-cartography')!,{subtree:true,attributes:true,childList:true,characterData:true});
      for(let i=0;i<60;i++){f.state.revision++;f.target.captureProgress=i/100;f.ui.receive(f.state);f.ui.setIntel(f.intel);}
      await Promise.resolve();observer.disconnect();return mutations;
    });
    assert.equal(quiet,0,'closed atlas does not mutate map DOM for packets or contacts');
    await page.locator('#navigation-map').waitFor({state:'visible'});
    await page.screenshot({path:`artifacts/map-minimap-${viewport.width}.png`});
    assert.deepEqual(errors,[]);reports.push({viewport,...metrics,hiddenMapMutations:quiet,labels:overviewLabels});await context.close();
  }
  await writeFile('artifacts/map-readability-report.json',JSON.stringify(reports,null,2));
  console.log(JSON.stringify(reports,null,2));
}finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
