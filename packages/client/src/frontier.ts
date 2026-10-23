import { CAPTURE_SECONDS, FACTIONS, type Faction, type FrontierState, type SpawnOption } from '@shared/frontier';
import { PLAYER } from '@shared/constants';
import type { World } from '@shared/worldgen';
import { MAP_SPAN, MAP_SIZE, mapPoint, mapViewport, separateMapPins } from './world-map.js';
import type { WorldMapStream } from './world-map-stream.js';
import { planetBySeed, PLANETS } from '@shared/universe';
import { captureStatus, type CaptureObserver } from './capture-status.js';
import { baseControlStatus, localCampaignBase, orderedReinforcements, reinforcementStatus, respawnStatus } from './respawn-status.js';
import { controlActivity, ownershipShares, renderOwnership, territoryRegions, territoryBorders, type TerritoryRegion } from './territory-map.js';
import { contactColor, declutterMapLoot, EMPTY_MAP_INTEL, type MapIntel } from './tactical-intel.js';
import { CREATURE_DEFS } from '@shared/wildlife';
import { placeMapLabels, shortControlName, type MapLabelCandidate, type MapLabelBox } from './map-labels.js';

/** The atlas is available during play. It never blocks first arrival. */
export class FrontierUI {
  readonly element = document.createElement('section');
  readonly bar = document.createElement('aside');
  open = false;
  state: FrontierState | null = null;
  private world: World | null = null;
  private location = '';
  private lastUpdate = 0;
  private map: HTMLElement;
  private stopArtwork: (()=>void)|undefined;
  private pins: SVGSVGElement;
  private livePins: SVGSVGElement;
  private territoryLayer: SVGSVGElement;
  private territoryOwnerKey = '';
  private pinKey = '';
  private mapBounds = { width: 600, height: 600 };
  private viewportFrame = 0;
  private intelDirty = false;
  private lastIntelDraw = -Infinity;
  private intel: MapIntel = EMPTY_MAP_INTEL;
  private contactNodes = new Map<string, SVGGElement>();
  private mapUnitsPerPixel = 1;
  private labelMeasure = document.createElement('canvas').getContext('2d');
  private self: SVGElement;
  private x = 0; private z = 0; private yaw = 0;
  private readonly capturePanel = document.createElement('section');
  private readonly orderPanel = document.createElement('p');
  private readonly transitHint = document.createElement('p');
  private dead = false;
  private respawnReceivedAt = 0;
  private deathAt = 0;
  private mapOpenAt = 0;
  private zoom = 1;
  private mapCenter = { x: 300, y: 300 };
  private regionKey = '';
  private regions: TerritoryRegion[] = [];
  private displayedSpawns: SpawnOption[] = [];
  private get reinforcements() { return this.state?.reinforcements ?? this.state?.respawn; }
  private baseReinforcement(id: string) { return this.reinforcements?.options.find(option => (option.baseId ?? option.id) === id); }
  get respawning(): boolean { return this.dead; }

  constructor(private readonly enlist: (faction: Faction) => void, private readonly onOpen: (open: boolean, resume: boolean) => void,
    system: () => void = () => {}, private readonly selectSpawn: (id: string) => void = () => {}) {
    this.bar.id = 'frontier-bar';
    this.bar.innerHTML = `<div class="world-brand"><b>THE MMOFPS<span>01</span></b><span>MERIDIAN SYSTEM</span></div>
      <div class="world-location">Arriving on the frontier</div><button id="atlas-open" aria-label="Open tactical map (G)"><kbd>G</kbd><span>TACTICAL MAP</span> ↗</button>
      <div id="frontier-status">JOINING THE FRONTIER</div>`;
    this.capturePanel.id = 'capture-status'; this.capturePanel.hidden = true;
    this.capturePanel.setAttribute('aria-label', 'Territory capture');
    this.capturePanel.innerHTML = `<div class="capture-owner"></div><strong class="capture-name"></strong>
      <div class="capture-readout"><b id="capture-phase"></b><span id="capture-percent"></span></div>
      <div class="capture-track" role="progressbar" aria-label="Capture progress" aria-valuemin="0" aria-valuemax="100"><div></div></div>
      <p id="capture-detail"></p><p class="capture-base"></p>`;
    this.bar.append(this.capturePanel);
    this.orderPanel.id = 'frontier-order'; this.orderPanel.hidden = true; this.bar.append(this.orderPanel);
    const systemButton = document.createElement('button'); systemButton.id = 'system-open'; systemButton.textContent = 'O  STAR SYSTEM ↗';
    systemButton.setAttribute('aria-label', 'Open star system'); systemButton.onclick = system; this.bar.append(systemButton);
    this.element.id = 'frontier-atlas'; this.element.hidden = true;
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-label', 'Tactical map and factions');
    this.element.setAttribute('aria-modal', 'true');
    this.element.innerHTML = `<header><div><small>THE MMOFPS / TACTICAL NETWORK <i class="atlas-live">LIVE</i></small><h1>The battle for the frontier.</h1><p class="atlas-briefing">Control the approaches. Bring your squad home.</p></div><button id="atlas-close" aria-label="Close atlas">BACK TO WORLD <kbd>G</kbd><span>×</span></button></header>
      <div class="atlas-body"><div class="atlas-cartography"><div class="atlas-map"></div><svg class="atlas-territory" viewBox="0 0 600 600" aria-hidden="true"></svg><svg class="atlas-live-pins" viewBox="0 0 600 600" aria-label="Nearby units and major threats"></svg><svg class="atlas-pins" viewBox="0 0 600 600"></svg><div class="atlas-situation"><b>LIVE OPERATIONS</b><span class="atlas-situation-detail">Awaiting tactical reports</span><span class="atlas-contact-readout"></span></div>
      <div class="atlas-map-tools" aria-label="Map controls"><button data-map="out" aria-label="Zoom out">−</button><output class="atlas-zoom" aria-label="Map zoom">1×</output><button data-map="in" aria-label="Zoom in">+</button><button data-map="you">YOU</button><button data-map="death" hidden>LAST FALL</button><button data-map="world">PLANET</button></div>
      <div class="atlas-map-key" aria-label="Tactical map legend"><span><i class="key-you"></i>You</span><span><i class="key-friendly"></i>Friendly</span><span><i class="key-hostile"></i>Enemy</span><span><i class="key-vehicle"></i>Vehicle</span><span><i class="key-threat"></i>Major threat</span><span><i class="key-loot"></i>Weapon drop</span><span><i class="key-death"></i>Last fall</span><span><i class="key-capture"></i>Capturing</span><span><i class="key-contested"></i>Contested / attacked</span><span><i class="key-battle"></i>Recent combat</span><span><i class="key-base"></i>Base</span><span><i class="key-order"></i>Squad order</span><span><i class="key-pod"></i>Airlift</span></div>
      <div class="atlas-map-label"><small>01 / MERIDIAN</small><b>The inhabited frontier</b><span>Cities · wilderness · subterranean routes · open ocean</span><small>CONTROL POINTS</small><div class="atlas-ownership"></div></div></div>
      <aside class="atlas-sidebar"><section class="respawn-panel" hidden><small>FACTION REINFORCEMENTS</small><h2 class="reinforcement-heading">Choose next respawn.</h2><h2 class="redeploy-countdown" hidden>Back in <span id="respawn-countdown">10</span>s</h2><p id="respawn-detail"></p><div class="reinforcement-local" hidden></div><div class="respawn-choices" aria-label="Next respawn point"></div><p class="respawn-help"></p></section>
      <section class="atlas-intelligence"><small>FRONTLINE REPORT</small><h2>Active objectives.</h2><div class="atlas-controls"></div><p class="atlas-death-readout" hidden></p><div class="atlas-objective"></div><div class="atlas-battles"></div><p class="atlas-battle-help">Select a report to locate it. Combat rings show the last 30 seconds. Unit markers show nearby contacts; major threats are broadcast planet-wide.</p><div class="atlas-threats"></div></section>
      <section class="atlas-allegiance"><small>YOUR ALLEGIANCE</small><h2>Choose your own war.</h2><p>You join a faction automatically, ready to fight. You can switch sides here after leaving combat.</p>
      <div class="faction-choices">${FACTIONS.filter(f => f.id > 0).map(f => `<button data-faction="${f.id}" style="--faction:${f.color}"><i></i><span><b>${f.name}</b><small>${f.description}</small></span><em>→</em></button>`).join('')}</div>
      <div class="atlas-inventory"></div></section><div class="atlas-fronts"></div><div class="atlas-campaign"></div><div class="atlas-transit"><small>CAPTURE BASES</small><p>Capture 2 of a base's 3 control points to secure the base. One captured point is not enough. Reinforcements arrive at a safe rally outside the rings; nearby enemies can temporarily block it. Choose your next respawn here with G, while alive or after death. Hold a flag's ring on foot at ground level. One player needs ${CAPTURE_SECONDS} seconds for a neutral point, or ${CAPTURE_SECONDS * 2} seconds to neutralize and capture an enemy point. Enemy troops inside pause progress.</p><small>GO FURTHER</small><p>Follow the rail lines into another city. Take a ferry around the coast. Board a friendly vehicle or an airlift pod to join the next attack.</p><span>M · compass & minimap &nbsp; E · board / interact</span></div></aside></div>
      <footer><span>G · TACTICAL MAP &nbsp; / &nbsp; M · MINIMAP</span><span>Color = owner · Arc = capture progress · Broken ring = contested</span></footer>`;
    document.body.append(this.bar, this.element);
    this.map = this.element.querySelector('.atlas-map')!;
    this.pins = this.element.querySelector<SVGSVGElement>('.atlas-pins')!;
    this.livePins = this.element.querySelector<SVGSVGElement>('.atlas-live-pins')!;
    this.territoryLayer = this.element.querySelector<SVGSVGElement>('.atlas-territory')!;
    this.element.querySelector('.respawn-panel')!.before(this.element.querySelector('.atlas-intelligence')!);
    this.self = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.self.classList.add('map-you');
    this.self.setAttribute('d', 'M0 -7L5 6L0 3L-5 6Z'); this.self.setAttribute('fill', '#fff7d5');
    this.self.setAttribute('stroke', '#071b24'); this.self.setAttribute('stroke-width', '1.5');
    this.bar.querySelector('button')!.onclick = () => this.toggle();
    this.element.querySelector<HTMLButtonElement>('#atlas-close')!.onclick = () => this.toggle(false);
    this.element.querySelectorAll<HTMLButtonElement>('.faction-choices [data-faction]').forEach(button => button.onclick = () => this.enlist(Number(button.dataset.faction) as Faction));
    this.element.querySelectorAll<HTMLButtonElement>('[data-map]').forEach(button => button.onclick = () => {
      if (button.dataset.map === 'in') this.zoom = Math.min(4, this.zoom * 2);
      if (button.dataset.map === 'out') this.zoom = Math.max(1, this.zoom / 2);
      if (button.dataset.map === 'world') { this.zoom = 1; this.mapCenter = { x: 300, y: 300 }; }
      if (button.dataset.map === 'you') { this.zoom = 4; this.mapCenter = mapPoint({ x: this.x, z: this.z }); }
      if (button.dataset.map === 'death' && this.state?.death) { this.zoom = 4; this.mapCenter = mapPoint(this.state.death); }
      this.renderViewport();
    });
    const cartography = this.element.querySelector<HTMLElement>('.atlas-cartography')!;
    // Controls and key have their own rows so every coastal spawn stays clear.
    cartography.before(this.element.querySelector('.atlas-map-tools')!);
    cartography.after(this.element.querySelector('.atlas-map-key')!);
    // Font/viewport changes can resize the fitted SVG after it opens. Keep
    // screen-space spawn targets consistent with the final layout.
    new ResizeObserver(entries => { const rect=entries[0]?.contentRect;if(rect?.width&&rect.height)this.mapBounds={width:rect.width,height:rect.height};this.scheduleViewport(); }).observe(cartography);
    cartography.addEventListener('wheel', event => {
      event.preventDefault(); this.zoom = Math.max(1, Math.min(4, this.zoom * (event.deltaY < 0 ? 1.25 : .8))); this.scheduleViewport();
    }, { passive: false });
    let drag: { x: number; y: number; center: { x: number; y: number } } | null = null;
    cartography.addEventListener('pointerdown', event => {
      if ((event.target as Element).closest('button,.respawn-pin') || this.zoom <= 1) return;
      drag = { x: event.clientX, y: event.clientY, center: { ...this.mapCenter } };
      cartography.setPointerCapture(event.pointerId);
    });
    cartography.addEventListener('pointermove', event => {
      if (!drag) return;
      const scale = 600 / this.zoom / Math.min(this.mapBounds.width, this.mapBounds.height);
      this.mapCenter = { x: drag.center.x - (event.clientX - drag.x) * scale, y: drag.center.y - (event.clientY - drag.y) * scale }; this.scheduleViewport();
    });
    const stopDrag = () => { drag = null; };
    cartography.addEventListener('pointerup', stopDrag); cartography.addEventListener('pointercancel', stopDrag);
    this.transitHint.className = 'atlas-nearest-transit'; this.element.querySelector('.atlas-transit')!.prepend(this.transitHint);
    window.addEventListener('keydown', e => {
      if ((e.target as HTMLElement)?.matches('input,textarea,[contenteditable]')) return;
      if ((e.code === 'KeyG' || (e.code === 'Escape' && this.open)) && !e.repeat) { e.preventDefault(); this.toggle(); }
      if (this.open && e.code === 'Tab') {
        const targets = [...this.element.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"]')].filter(target => target.getClientRects().length > 0);
        const index = targets.indexOf(document.activeElement as HTMLElement);
        e.preventDefault(); targets[(index + (e.shiftKey ? targets.length - 1 : 1)) % targets.length]?.focus();
      }
    });
  }
  toggle(value = !this.open, resume = true): void {
    if (this.dead && value && performance.now() < this.mapOpenAt) return;
    if (this.dead && !value) return;
    if (this.open === value) return;
    this.open = value; this.element.hidden = !value;
    this.onOpen(value, resume);
    if (value) {
      this.refreshStrategicState(); this.renderIntel();
      this.element.scrollTop = 0;
      this.element.querySelector<HTMLElement>('.atlas-sidebar')!.scrollTop = 0;
      this.element.querySelector<HTMLElement>(this.dead ? '.respawn-choices button:not(:disabled)' : '#atlas-close')?.focus({ preventScroll: true });
    }
  }
  /** Death is driven by fast authoritative snapshots, independent of the 1 Hz atlas data. */
  setAlive(alive: boolean, mapDelayMs = 0): void {
    if (this.dead === !alive) return;
    this.dead = !alive;
    const sidebar=this.element.querySelector('.atlas-sidebar')!;
    sidebar.prepend(this.element.querySelector(this.dead?'.respawn-panel':'.atlas-intelligence')!);
    if (this.dead) { this.deathAt = performance.now(); this.mapOpenAt = this.deathAt + Math.max(0, mapDelayMs); }
    else this.mapOpenAt = 0;
    if (this.dead && mapDelayMs > 0 && this.open) { this.open = false; this.element.hidden = true; this.onOpen(false, false); }
    this.element.classList.toggle('redeploy-active', this.dead);
    document.body.dataset.redeploying = String(this.dead);
    this.element.querySelector<HTMLButtonElement>('#atlas-close')!.hidden = this.dead;
    this.element.querySelector('h1')!.textContent = this.dead ? 'Return to the fight.' : `The battle for ${this.world ? planetBySeed(this.world.seed).name : 'the frontier'}.`;
    this.element.querySelector('.atlas-briefing')!.textContent = this.dead ? 'Your squad still needs you. Choose where you return.' : 'Control the approaches. Bring your squad home.';
    this.element.setAttribute('aria-label', this.dead ? 'Choose a respawn point' : 'Tactical map and factions');
    if (this.dead) { this.zoom = 1; this.mapCenter = { x: 300, y: 300 }; this.renderViewport(); }
    this.renderSpawns(); this.renderPins();
    this.toggle(this.dead, true);
  }
  setWorld(world: World, artwork: WorldMapStream): void {
    this.world = world;this.state=null;this.regionKey='';this.territoryOwnerKey='';this.pinKey='';this.regions=[];this.pins.replaceChildren();this.territoryLayer.replaceChildren();
    this.intel=EMPTY_MAP_INTEL;this.contactNodes.clear();this.livePins.replaceChildren();
    this.stopArtwork?.();this.stopArtwork=artwork.subscribe(svg=>{
      this.map.innerHTML=svg;this.regionKey='';this.pinKey='';this.renderViewport();
    });
    const planet = planetBySeed(world.seed), index = PLANETS.findIndex(p => p.id === planet.id) + 1;
    this.bar.querySelector('.world-brand b span')!.textContent = `0${index}`;
    this.bar.querySelector('.world-brand>span')!.textContent = `${planet.name.toUpperCase()} / HELIOS`;
    this.element.querySelector('.atlas-map-label small')!.textContent = `0${index} / ${planet.name.toUpperCase()}`;
    this.element.querySelector('.atlas-map-label b')!.textContent = planet.description.split('.')[0];
    if (!this.dead) this.element.querySelector('h1')!.textContent = `The battle for ${planet.name}.`;
    this.zoom = 1; this.mapCenter = { x: 300, y: 300 }; this.renderViewport();
    this.location = '';
  }
  setIntel(intel: MapIntel): void { this.intel=intel;this.intelDirty=true; }
  clearIntel(): void {this.intel=EMPTY_MAP_INTEL;this.contactNodes.clear();this.livePins.replaceChildren();this.element.querySelector('.atlas-contact-readout')!.textContent='CONTACT LINK OFFLINE';}
  receive(state: FrontierState): void {
    this.state = state;
    this.respawnReceivedAt = performance.now();
    document.body.dataset.allegiance = String(state.you.faction);
    this.bar.querySelector('#frontier-status')!.textContent = `${FACTIONS[state.you.faction].name.toUpperCase()} · ${state.you.faction ? 'FACTION OPERATIONS' : 'FREE EXPLORATION'}`;
    this.bar.style.setProperty('--faction', FACTIONS[state.you.faction].color);
    if(this.open)this.refreshStrategicState();
  }
  private refreshStrategicState(): void {
    const state=this.state;if(!state)return;
    const focusedSpawn = (document.activeElement as HTMLElement | null)?.dataset.spawn;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('.faction-choices [data-faction]')) {
      const active = Number(button.dataset.faction) === state.you.faction;
      button.setAttribute('aria-pressed', String(active));
      button.querySelector('em')!.textContent = active ? '✓' : '→';
      button.disabled = !active && state.you.factionCooldown > 0;
    }
    this.element.querySelector('.atlas-inventory')!.textContent = `${state.you.salvage} SALVAGE · ${state.you.discoveries.length} DISCOVERIES${state.you.factionCooldown ? ` · ALLEGIANCE LOCK ${state.you.factionCooldown}s` : ''}`;
    this.renderSpawns(); this.renderPins(); this.renderIntelligence();
    const activities=state.territories.map(controlActivity),contested=activities.filter(site=>site.kind==='contested').length,attacked=activities.filter(site=>site.kind==='attacked').length,changing=activities.filter(site=>site.kind==='capturing').length;
    this.element.querySelector('.atlas-situation-detail')!.textContent=`${attacked} under attack · ${contested} contested · ${changing} capturing`;
    renderOwnership(this.element.querySelector<HTMLElement>('.atlas-ownership')!, ownershipShares(state.territories));
    if (focusedSpawn !== undefined) [...this.element.querySelectorAll<HTMLButtonElement>('.respawn-choices button')]
      .find(button => button.dataset.spawn === focusedSpawn)?.focus({ preventScroll: true });
    const fronts = this.element.querySelector('.atlas-fronts')!; fronts.replaceChildren();
    const label = document.createElement('small'); label.textContent = 'TERRITORY NETWORK'; fronts.append(label);
    for (const faction of FACTIONS.slice(1)) {
      const line = document.createElement('div'); line.style.color = faction.color;
      line.textContent = `${faction.name}   ${state.bases?.filter(base => base.owner === faction.id).length ?? 0} bases · ${state.territories.filter(t => t.owner === faction.id).length} points`; fronts.append(line);
    }
    const campaign = this.element.querySelector('.atlas-campaign')!; campaign.replaceChildren();
    if (state.bases?.length) {
      const title = document.createElement('small'); title.textContent = 'BASE CONTROL'; campaign.append(title);
      const bases = [...state.bases].sort((a, b) => Number(b.id === state.order?.baseId) - Number(a.id === state.order?.baseId)
        || Number(b.owner === state.you.faction) - Number(a.owner === state.you.faction));
      for (const base of bases) {
        const row = document.createElement('div'); row.className = 'atlas-base'; row.dataset.base = base.id;
        row.style.setProperty('--base-color', FACTIONS[base.owner].color);
        const name = document.createElement('b'); name.textContent = base.name;
        const owner = document.createElement('span'); owner.textContent = `${FACTIONS[base.owner].name}${base.homeFaction ? ' · Home base' : ''}`;
        const progress = document.createElement('p'); progress.textContent = baseControlStatus(base, state.territories, state.you.faction, this.baseReinforcement(base.id)).detail;
        row.append(name, owner, progress); campaign.append(row);
      }
    }
  }
  private scheduleViewport(): void {
    if(!this.open||this.viewportFrame)return;
    this.viewportFrame=requestAnimationFrame(()=>{this.viewportFrame=0;if(this.open)this.renderViewport();});
  }
  private renderViewport(): void {
    const view = mapViewport(this.mapCenter, this.zoom), box = `${view.x} ${view.y} ${view.size} ${view.size}`;
    this.mapCenter = { x: view.x + view.size / 2, y: view.y + view.size / 2 };
    this.map.querySelector('svg')?.setAttribute('viewBox', box); this.pins.setAttribute('viewBox', box);
    this.livePins.setAttribute('viewBox',box);this.territoryLayer.setAttribute('viewBox',box);
    this.element.querySelector('.atlas-zoom')!.textContent = `${Number(this.zoom.toFixed(1))}×`;
    this.element.querySelector<HTMLButtonElement>('[data-map="out"]')!.disabled = this.zoom <= 1;
    this.element.querySelector<HTMLButtonElement>('[data-map="in"]')!.disabled = this.zoom >= 4;
    this.element.querySelector<HTMLElement>('.atlas-cartography')!.dataset.zoomed = String(this.zoom > 1);
    if (this.open) {this.renderPins();this.renderIntel();}
  }
  /** Update keyed live markers independently of the strategic map. No terrain,
   * territory clipping or full SVG rebuild happens on the snapshot path. */
  private renderIntel(): void {
    this.intelDirty=false;
    const visible=new Set<string>(),view=mapViewport(this.mapCenter,this.zoom);
    let friendlies=0,enemies=0;
    for(const contact of declutterMapLoot(this.intel.contacts,this.x,this.z,this.mapUnitsPerPixel*MAP_SPAN/MAP_SIZE*14)) {
      if(contact.relation==='friendly')friendlies++;
      if(contact.relation==='hostile'&&contact.kind!=='boss'&&contact.kind!=='creature')enemies++;
      // Planet view is for the campaign. Infantry and dropped equipment are
      // readable only at local zoom; their totals remain in the live report.
      if(this.zoom<2&&contact.kind!=='boss'&&contact.kind!=='vehicle'&&contact.kind!=='aircraft')continue;
      const p=mapPoint(contact);if(p.x<view.x||p.y<view.y||p.x>view.x+view.size||p.y>view.y+view.size)continue;
      visible.add(contact.id);let group=this.contactNodes.get(contact.id);
      if(!group) {
        group=document.createElementNS('http://www.w3.org/2000/svg','g');group.classList.add('map-contact');group.dataset.contact=contact.id;
        const title=document.createElementNS('http://www.w3.org/2000/svg','title'),shape=document.createElementNS('http://www.w3.org/2000/svg','path');
        group.append(title,shape);this.contactNodes.set(contact.id,group);this.livePins.append(group);
      }
      group.dataset.kind=contact.kind;group.dataset.relation=contact.relation;
      group.setAttribute('transform',`translate(${p.x} ${p.y}) scale(${this.mapUnitsPerPixel})`);
      group.querySelector('title')!.textContent=`${contact.label}${contact.health===undefined?'':` · ${Math.round(contact.health*100)}% health`}`;
      const shape=group.querySelector('path')!;
      shape.setAttribute('fill',contactColor(contact));shape.setAttribute('stroke','#081b25');shape.setAttribute('stroke-width','1.3');
      const kind=contact.kind;
      shape.setAttribute('d',kind==='boss'?'M0 -8L7 -4V4L0 8L-7 4V-4Z':kind==='loot'?'M-4 -4H4V4H-4ZM-1 -2V2M-2 0H2'
        :kind==='aircraft'?'M0 -6L3 -1L7 2V4L1 2L2 6H-2L-1 2L-7 4V2L-3 -1Z':kind==='vehicle'?'M-4 -5H4V5H-4ZM0 -7V0'
        :kind==='creature'?'M0 -3L3 0L0 3L-3 0Z':'M0 -2.8A2.8 2.8 0 1 0 .01 -2.8');
      shape.setAttribute('transform',`rotate(${kind==='vehicle'||kind==='aircraft'?-contact.yaw*180/Math.PI:0})`);
    }
    for(const [id,node] of this.contactNodes)if(!visible.has(id)){node.remove();this.contactNodes.delete(id);}
    this.element.querySelector('.atlas-contact-readout')!.textContent=`NEAR YOU · ${friendlies} friendly / ${enemies} enemy${this.zoom<2?' · Zoom for units':''}`;
  }
  private renderIntelligence(): void {
    const state = this.state; if (!state) return;
    const controls=this.element.querySelector('.atlas-controls')!,focusControl=(document.activeElement as HTMLElement)?.dataset.control;
    controls.replaceChildren();
    const active=state.territories.filter(site=>controlActivity(site).active).sort((a,b)=>
      Number(b.contested)-Number(a.contested)||Number(b.owner===state.you.faction)-Number(a.owner===state.you.faction)||a.id.localeCompare(b.id));
    if(!active.length){const quiet=document.createElement('p');quiet.className='atlas-quiet';quiet.textContent='No control points under pressure. Scout an unclaimed base or follow your squad.';controls.append(quiet);}
    for(const site of active){
      const activity=controlActivity(site),button=document.createElement('button');button.className='atlas-control-report';button.dataset.control=site.id;button.dataset.state=activity.kind;
      const name=document.createElement('b'),status=document.createElement('strong'),detail=document.createElement('span'),meter=document.createElement('i');
      name.textContent=site.name;status.textContent=activity.label;
      detail.textContent=activity.kind==='contested'?`${FACTIONS[site.owner].name} · Multiple factions in the ring`
        :activity.restoring?`${FACTIONS[site.owner].name} · Restoring control`
        :`${FACTIONS[site.owner].name} → ${FACTIONS[activity.faction].name}`;
      meter.style.setProperty('--capture-progress',`${activity.progress*100}%`);meter.style.setProperty('--capture-color',activity.color);
      button.append(status,name,detail,meter);button.onclick=()=>{this.mapCenter=mapPoint(site);this.zoom=4;this.renderViewport();};controls.append(button);
      if(focusControl===site.id)button.focus({preventScroll:true});
    }
    const death = this.element.querySelector<HTMLElement>('.atlas-death-readout')!;
    death.hidden = !state.death;
    this.element.querySelector<HTMLButtonElement>('[data-map="death"]')!.hidden = !state.death;
    if (state.death) death.textContent = `Last fall · ${(Math.hypot(state.death.x - this.x, state.death.z - this.z) / 1000).toFixed(1)} km from your position. The red cross marks the location.`;
    const objective=this.element.querySelector('.atlas-objective')!,focusedObjective=objective.contains(document.activeElement);objective.replaceChildren();
    if(state.order){const order=state.order,goal=order.phase==='assemble'?order.staging:order,button=document.createElement('button');button.className='atlas-order-card';
      const small=document.createElement('small'),name=document.createElement('b'),detail=document.createElement('span');
      small.textContent=`SQUAD ${order.squad+1} · ${order.phase.toUpperCase()}`;name.textContent=order.name;
      detail.textContent=`${(Math.hypot(goal.x-this.x,goal.z-this.z)/1000).toFixed(1)} km · LOCATE OBJECTIVE`;
      button.append(small,name,detail);button.onclick=()=>{this.mapCenter=mapPoint(goal);this.zoom=4;this.renderViewport();};objective.append(button);if(focusedObjective)button.focus({preventScroll:true});}
    const threats=this.element.querySelector('.atlas-threats')!,focusedThreat=(document.activeElement as HTMLElement)?.dataset.threat;threats.replaceChildren();
    if(state.threats?.length){const title=document.createElement('small');title.textContent='MAJOR THREATS · TEAM ENCOUNTERS';threats.append(title);}
    for(const threat of state.threats??[]) {
      const species=CREATURE_DEFS[threat.species];if(!species?.boss||threat.health<=0)continue;
      const button=document.createElement('button');button.className='atlas-threat';button.dataset.threat=String(threat.id);
      const name=document.createElement('b'),detail=document.createElement('span'),health=document.createElement('i');
      name.textContent=species.name;detail.textContent=`${threat.engaged?'ENGAGED':'ROAMING'} · ${(Math.hypot(threat.x-this.x,threat.z-this.z)/1000).toFixed(1)} km · ${Math.round(threat.health*100)}% HP`;
      health.style.setProperty('--threat-health',`${Math.max(0,Math.min(1,threat.health))*100}%`);button.append(name,detail,health);
      button.onclick=()=>{this.mapCenter=mapPoint(threat);this.zoom=4;this.renderViewport();};threats.append(button);if(focusedThreat===String(threat.id))button.focus({preventScroll:true});
    }
    const list = this.element.querySelector('.atlas-battles')!, focus = (document.activeElement as HTMLElement)?.dataset.battle;
    list.replaceChildren();
    const battles = [...(state.battles ?? [])].sort((a, b) =>
      Math.hypot(a.x - this.x, a.z - this.z) - Math.hypot(b.x - this.x, b.z - this.z));
    if (!battles.length) {
      const quiet = document.createElement('p'); quiet.className = 'atlas-quiet';
      quiet.textContent = 'No fighting reported in the last 30 seconds. Follow your squad order to the next objective.'; list.append(quiet);
    }
    for (const battle of battles.slice(0, 5)) {
      const button = document.createElement('button'); button.className = 'atlas-battle'; button.dataset.battle = battle.id;
      const strength = battle.intensity >= .65 ? 'HEAVY FIGHTING' : battle.intensity >= .3 ? 'FIREFIGHT' : 'CONTACT';
      const heading = document.createElement('small'); heading.textContent = `${strength} · ${(Math.hypot(battle.x - this.x, battle.z - this.z) / 1000).toFixed(1)} km`;
      const title = document.createElement('b'); title.textContent = battle.name;
      const factions = document.createElement('span'); factions.className = 'battle-factions';
      for (const id of battle.factions) {
        const faction = FACTIONS[id]; if (!faction) continue;
        const chip = document.createElement('i'); chip.style.background = faction.color; chip.title = faction.name; chip.setAttribute('aria-label', faction.name); factions.append(chip);
      }
      const locator = document.createElement('span'); locator.className = 'battle-locate'; locator.textContent = 'LOCATE ↗';
      button.append(heading, title, factions, locator);
      button.onclick = () => { this.mapCenter = mapPoint(battle); this.zoom = 4; this.renderViewport(); };
      list.append(button); if (focus === battle.id) button.focus({ preventScroll: true });
    }
  }
  /** Geometry only changes with control locations, and color/fronts only with
   * ownership. Capture ticks, contacts, panning and zoom reuse these nodes. */
  private renderTerritories(): void {
    const state=this.state;if(!state)return;
    const geometryKey=state.territories.map(site=>`${site.id}:${site.x}:${site.z}`).join('|');
    if(geometryKey!==this.regionKey){
      this.regionKey=geometryKey;this.territoryOwnerKey='';
      this.regions=territoryRegions(state.territories.map(site=>({id:site.id,...mapPoint(site)})));
      this.territoryLayer.replaceChildren();
      const group=document.createElementNS('http://www.w3.org/2000/svg','g');group.classList.add('territory-regions');
      const coastline=this.map.querySelector('#island path')?.getAttribute('d');
      if(coastline){const defs=document.createElementNS('http://www.w3.org/2000/svg','defs'),clip=document.createElementNS('http://www.w3.org/2000/svg','clipPath'),outline=document.createElementNS('http://www.w3.org/2000/svg','path');
        clip.id='atlas-owned-land';outline.setAttribute('d',coastline);clip.append(outline);defs.append(clip);this.territoryLayer.append(defs);group.setAttribute('clip-path','url(#atlas-owned-land)');}
      for(const region of this.regions){const polygon=document.createElementNS('http://www.w3.org/2000/svg','polygon');polygon.dataset.territory=region.id;
        polygon.setAttribute('points',region.polygon.map(point=>`${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(' '));group.append(polygon);}
      this.territoryLayer.append(group);
    }
    const ownerKey=state.territories.map(site=>`${site.id}:${site.owner}`).join('|');if(ownerKey===this.territoryOwnerKey)return;
    this.territoryOwnerKey=ownerKey;
    const owners=new Map(state.territories.map(site=>[site.id,site.owner])),group=this.territoryLayer.querySelector('.territory-regions')!;
    for(const polygon of group.querySelectorAll<SVGPolygonElement>('polygon')){const owner=owners.get(polygon.dataset.territory!)??0;
      polygon.dataset.owner=String(owner);polygon.setAttribute('fill',FACTIONS[owner].color);polygon.setAttribute('fill-opacity',owner?'.12':'0');}
    group.querySelectorAll('.map-frontline').forEach(node=>node.remove());
    for(const edge of territoryBorders(this.regions,owners)){const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.classList.add('map-frontline');line.setAttribute('d',`M${edge.a.x} ${edge.a.y}L${edge.b.x} ${edge.b.y}`);group.append(line);}
  }
  private renderPins(): void {
    const state = this.state;
    if (!state || !this.open) return;
    const bounds = this.mapBounds, pixels = Math.min(bounds.width, bounds.height);
    const unitsPerPixel = 600 / this.zoom / pixels;
    this.mapUnitsPerPixel = unitsPerPixel;
    const view=mapViewport(this.mapCenter,this.zoom),origin={x:(bounds.width-pixels)/2-view.x/unitsPerPixel,y:(bounds.height-pixels)/2-view.y/unitsPerPixel};
    const screen=(point:{x:number;y:number})=>({x:point.x/unitsPerPixel+origin.x,y:point.y/unitsPerPixel+origin.y});
    const key=JSON.stringify([this.zoom,this.mapCenter,bounds,this.dead,state.you.faction,Math.round(this.x/25),Math.round(this.z/25),
      state.territories.map(site=>[site.id,site.x,site.z,site.owner,site.radius,controlActivity(site)]),state.bases,state.order,state.death,
      state.battles?.map(battle=>[battle.id,battle.x,battle.z,Math.round(battle.intensity*10),battle.factions]),
      this.reinforcements?.selected,this.displayedSpawns,state.threats?.map(threat=>[threat.id,threat.x,threat.z,Math.round(threat.health*100)])]);
    if(key===this.pinKey)return;
    this.pinKey=key;
    this.renderTerritories();
    this.pins.replaceChildren();
    const labels:MapLabelCandidate[]=[],obstacles:MapLabelBox[]=[],labelData=new Map<string,{text:string;className:string;color:string}>();
    const addLabel=(id:string,point:{x:number;y:number},text:string,priority:number,className='map-control-label',color='#e9eedb')=>{
      const anchor=screen(point),fontSize=priority<3?11:10;if(this.labelMeasure)this.labelMeasure.font=`600 ${fontSize}px Barlow,sans-serif`;
      const measure=(value:string)=>this.labelMeasure?.measureText(value).width??value.length*fontSize*.55;
      while(text.length>4&&measure(text)>200)text=text.slice(0,-2).trimEnd()+'…';
      labels.push({id,...anchor,width:measure(text),height:fontSize+2,priority});labelData.set(id,{text,className,color});
    };
    const block=(point:{x:number;y:number},radius:number)=>{const p=screen(point);obstacles.push({x:p.x-radius,y:p.y-radius,width:radius*2,height:radius*2});};
    block(mapPoint({x:this.x,z:this.z}),10);
    // Fixed screen-space panels and base glyphs reserve their own space.
    obstacles.push({x:10,y:10,width:Math.min(bounds.width-20,bounds.height<250?290:330),height:bounds.height<250?30:74});
    if(this.zoom<2&&bounds.width>=650)obstacles.push({x:12,y:bounds.height-92,width:280,height:80});
    if(this.zoom>=2)for (const base of state.bases ?? []) {
      const center = mapPoint(base);
      for (const site of state.territories.filter(site => base.controlIds.includes(site.id))) {
        const point = mapPoint(site), line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        line.setAttribute('d', `M${center.x} ${center.y}L${point.x} ${point.y}`);
        line.setAttribute('stroke', FACTIONS[base.owner].color); line.setAttribute('stroke-opacity', '.22');
        line.setAttribute('stroke-width', '.5'); this.pins.append(line);
      }
    }
    for (const battle of state.battles ?? []) {
      const point = mapPoint(battle), group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      group.classList.add('battle-marker'); group.dataset.battle = battle.id;
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${battle.name} · Recent combat · ${battle.factions.map(id => FACTIONS[id]?.name).filter(Boolean).join(' / ')}`;
      const radius = (10 + Math.max(0, Math.min(1, battle.intensity)) * 10)*unitsPerPixel;
      const aura = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); aura.classList.add('battle-aura');
      aura.setAttribute('cx', String(point.x)); aura.setAttribute('cy', String(point.y)); aura.setAttribute('r', String(radius));
      const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); ring.classList.add('battle-ring');
      ring.setAttribute('cx', String(point.x)); ring.setAttribute('cy', String(point.y)); ring.setAttribute('r', String(radius + 3*unitsPerPixel));
      group.append(title, aura, ring); this.pins.append(group);
    }
    for (const site of state.territories) {
      const activity=controlActivity(site),point = mapPoint(site), circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      if(this.zoom<2&&!activity.active&&site.baseId)continue;
      circle.classList.add('map-site');circle.dataset.control=site.id;circle.dataset.state=activity.kind;
      circle.setAttribute('cx', String(point.x)); circle.setAttribute('cy', String(point.y)); circle.setAttribute('r', String(3.5*unitsPerPixel));block(point,activity.active?10:5);
      circle.setAttribute('fill', FACTIONS[site.owner].color); circle.setAttribute('stroke', '#0b2027');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = `${site.name} · ${FACTIONS[site.owner].name} · ${activity.label}`;
      circle.append(title); this.pins.append(circle);
      if(activity.active){
        const ring=document.createElementNS('http://www.w3.org/2000/svg','circle');ring.classList.add('map-control-active');ring.dataset.state=activity.kind;
        ring.setAttribute('cx',String(point.x));ring.setAttribute('cy',String(point.y));ring.setAttribute('r',String(8*unitsPerPixel));ring.setAttribute('stroke-width','2');ring.style.stroke=activity.color;
        if(activity.kind==='contested')ring.setAttribute('stroke-dasharray',`${3*unitsPerPixel} ${2*unitsPerPixel}`);
        else {ring.setAttribute('pathLength','100');ring.style.strokeDasharray=`${Math.max(3,activity.progress*100)} 100`;ring.setAttribute('transform',`rotate(-90 ${point.x} ${point.y})`);}
        this.pins.append(ring);
        if(activity.kind==='attacked'||activity.kind==='contested'){
          const danger=document.createElementNS('http://www.w3.org/2000/svg','path');danger.classList.add('map-control-danger');danger.setAttribute('d','M-2 -11L0 -14L2 -11');danger.setAttribute('transform',`translate(${point.x} ${point.y}) scale(${unitsPerPixel})`);this.pins.append(danger);
        }
      }
      if(this.zoom>=2||(activity.active&&!site.baseId)){
        const text=activity.active&&pixels<450?activity.label:`${activity.active?activity.label+' · ':''}${shortControlName(site.name)}`;
        addLabel(`control:${site.id}`,point,text,activity.active?0:4,activity.active?'map-control-status map-control-label':'map-control-label',activity.active?'#ffe0a3':'#e9eedb');}
    }
    for (const base of state.bases ?? []) {
      const location=mapPoint(base),point={x:location.x,y:location.y-(this.zoom>=2?18*unitsPerPixel:0)}, marker = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      if(this.zoom>=2){const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('d',`M${location.x} ${location.y}L${point.x} ${point.y}`);line.classList.add('map-label-leader');this.pins.append(line);}
      marker.classList.add('map-base');
      marker.setAttribute('x', String(point.x - 5*unitsPerPixel)); marker.setAttribute('y', String(point.y - 5*unitsPerPixel));
      marker.setAttribute('width', String(10*unitsPerPixel)); marker.setAttribute('height', String(10*unitsPerPixel)); marker.setAttribute('rx', String(2*unitsPerPixel));block(point,7);
      marker.setAttribute('fill', FACTIONS[base.owner].color); marker.setAttribute('stroke', '#f1ebc0'); marker.setAttribute('stroke-width', '.8');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${base.name} · ${FACTIONS[base.owner].name} · ${baseControlStatus(base, state.territories, state.you.faction, this.baseReinforcement(base.id)).detail}`;
      marker.append(title); this.pins.append(marker);
      const controls=state.territories.filter(site=>base.controlIds.includes(site.id)),active=controls.map(controlActivity).filter(site=>site.active).sort((a,b)=>Number(b.kind==='contested')-Number(a.kind==='contested')||Number(b.kind==='attacked')-Number(a.kind==='attacked'));
      const label=this.zoom<2&&active.length?`${active[0].label} · ${base.name}`:base.name.toUpperCase();
      addLabel(`base:${base.id}`,point,label,active.length&&this.zoom<2?0:base.kind==='city'?1:2,'map-base-label',active.length&&this.zoom<2?'#ffe0a3':'#e9eedb');
      if(this.zoom<2)for(const [i,control]of controls.entries()){
        const pip=document.createElementNS('http://www.w3.org/2000/svg','rect');pip.setAttribute('x',String(point.x+(i-(controls.length-1)/2)*5*unitsPerPixel-1.5*unitsPerPixel));pip.setAttribute('y',String(point.y+8*unitsPerPixel));pip.setAttribute('width',String(3*unitsPerPixel));pip.setAttribute('height',String(3*unitsPerPixel));pip.setAttribute('fill',FACTIONS[control.owner].color);this.pins.append(pip);
      }
    }
    this.pins.append(this.self);
    const selfPoint=mapPoint({x:this.x,z:this.z});this.self.setAttribute('transform',`translate(${selfPoint.x} ${selfPoint.y}) rotate(${-this.yaw*180/Math.PI}) scale(${unitsPerPixel})`);
    const pods = this.world?.collectTransportPlan().pods ?? [];
    const nearestPod = pods.reduce((best, pod) => !best || Math.hypot(pod.x - this.x, pod.z - this.z) < Math.hypot(best.x - this.x, best.z - this.z) ? pod : best, null as typeof pods[number] | null);
    for (const pod of pods) {
      if(this.zoom<2&&pod!==nearestPod)continue;
      const point = mapPoint(pod), marker = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      marker.classList.add('map-airlift');marker.setAttribute('d','M0 -4l4 4-4 4-4-4Z');marker.setAttribute('transform',`translate(${point.x} ${point.y}) scale(${unitsPerPixel})`); marker.setAttribute('fill', '#c5c4ff'); marker.setAttribute('stroke', '#0b2027');block(point,5);
      if (pod === nearestPod) { marker.setAttribute('stroke', '#f4f0d4'); marker.setAttribute('stroke-width', '1.5'); }
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = `${pod.name} · Airlift / orbital pod`; marker.append(title); this.pins.append(marker);
    }
    if (state.order) {
      const point = mapPoint(state.order.phase === 'assemble' ? state.order.staging : state.order), marker = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const from=mapPoint({x:this.x,z:this.z}),line=document.createElementNS('http://www.w3.org/2000/svg','path');line.classList.add('map-order-line');line.setAttribute('d',`M${from.x} ${from.y}L${point.x} ${point.y}`);line.setAttribute('stroke-width',String(1/this.zoom));this.pins.append(line);
      marker.classList.add('map-order');marker.setAttribute('d','M0 -9l9 9-9 9-9-9Z');marker.setAttribute('transform',`translate(${point.x} ${point.y}) scale(${unitsPerPixel})`); marker.setAttribute('fill', 'none');block(point,11);
      marker.setAttribute('stroke', '#ffe0a3'); marker.setAttribute('stroke-width', '1.5');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = `Squad ${state.order.squad + 1} · ${state.order.phase} · ${state.order.name}`;
      marker.append(title); this.pins.append(marker);
    }
    if (state.death) {
      const point = mapPoint(state.death), marker = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      marker.classList.add('death-marker'); marker.setAttribute('transform', `translate(${point.x} ${point.y}) scale(${unitsPerPixel})`);block(point,9);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = 'You fell here';
      const ring = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); ring.setAttribute('r', '8');
      const cross = document.createElementNS('http://www.w3.org/2000/svg', 'path'); cross.setAttribute('d', 'M-3 -3L3 3M3 -3L-3 3');
      addLabel('death',point,'LAST FALL',0,'map-control-label','#ffc7b5');marker.append(title, ring, cross); this.pins.append(marker);
    }
    if (this.reinforcements) {
      const hitRadius = 22 * unitsPerPixel;
      const radius = 14 * unitsPerPixel, options = this.displayedSpawns;
      const points = options.map(mapPoint), keepClear = [...(state.death ? [mapPoint(state.death)] : []), ...(!this.dead ? [mapPoint({ x: this.x, z: this.z })] : [])];
      const spread = separateMapPins([...keepClear, ...points], hitRadius * 2 + 3 * unitsPerPixel).slice(keepClear.length);
      for (const [index, option] of options.entries()) {
        const point = spread[index], actual = points[index], group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        const available = option.available !== false;
        group.classList.add('respawn-pin'); group.dataset.spawn = option.id; group.setAttribute('tabindex', available ? '0' : '-1');
        group.setAttribute('role', 'button'); group.setAttribute('aria-label', available ? `Choose ${option.name} for your next respawn` : `${option.name} unavailable: ${option.reason ?? 'Rally blocked'}`);
        group.setAttribute('aria-disabled', String(!available));
        group.setAttribute('aria-pressed', String(this.reinforcements?.selected === option.id));
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = `${option.name} · ${available ? 'Choose next respawn' : option.reason ?? 'Rally unavailable'}`;
        const line = document.createElementNS('http://www.w3.org/2000/svg', 'path'); line.setAttribute('d', `M${actual.x} ${actual.y}L${point.x} ${point.y}`);
        line.setAttribute('stroke', '#fff0ba'); line.setAttribute('stroke-width', '1');
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', String(point.x)); circle.setAttribute('cy', String(point.y)); circle.setAttribute('r', String(radius));
        const hit = circle.cloneNode() as SVGElement; hit.setAttribute('r', String(hitRadius)); hit.classList.add('respawn-hit');
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('x', String(point.x)); text.setAttribute('y', String(point.y)); text.style.fontSize = `${12 * unitsPerPixel}px`; text.textContent = String(index + 1);
        group.append(title, line, hit, circle, text); group.onclick = () => this.chooseSpawn(option.id);
        group.onkeydown = event => { if (event.code === 'Enter' || event.code === 'Space') { event.preventDefault(); this.chooseSpawn(option.id); } };
        this.pins.append(group);
        block(point,16);
      }
    }
    for(const threat of state.threats??[]){const species=CREATURE_DEFS[threat.species];if(!species?.boss||threat.health<=0)continue;const point=mapPoint(threat);block(point,9);addLabel(`boss:${threat.id}`,point,`${species.name} · ${Math.round(threat.health*100)}%`,0,'map-threat-label','#ffd397');}
    const placements=placeMapLabels(labels,{x:0,y:0,width:bounds.width||pixels,height:bounds.height||pixels},obstacles,pixels<450?9:14);
    for(const placed of placements){const data=labelData.get(placed.id)!;const group=document.createElementNS('http://www.w3.org/2000/svg','g');group.classList.add('map-placed-label');group.dataset.label=placed.id;
      const labelX=(placed.x-origin.x)*unitsPerPixel,labelY=(placed.y-origin.y)*unitsPerPixel,anchorX=(placed.anchorX-origin.x)*unitsPerPixel,anchorY=(placed.anchorY-origin.y)*unitsPerPixel;
      const line=document.createElementNS('http://www.w3.org/2000/svg','path');line.setAttribute('d',`M${anchorX} ${anchorY}L${labelX+(placed.x>placed.anchorX?0:placed.width*unitsPerPixel)} ${labelY+placed.height*unitsPerPixel*.5}`);line.classList.add('map-label-leader');
      const label=document.createElementNS('http://www.w3.org/2000/svg','text');label.setAttribute('x',String(labelX));label.setAttribute('y',String(labelY+(placed.height-2)*unitsPerPixel));label.setAttribute('class',data.className);label.style.fontSize=`${(placed.height-2)*unitsPerPixel}px`;label.style.strokeWidth=String(2*unitsPerPixel);label.style.fill=data.color;label.textContent=data.text;group.append(line,label);this.pins.append(group);}
  }
  private chooseSpawn(id: string): void {
    const model = this.reinforcements;
    if (!model || id && !model.options.some(option => option.id === id && option.available !== false)) return;
    model.selected = id || null;
    if (this.state?.respawn) this.state.respawn.selected = id || null;
    this.selectSpawn(id); this.renderSpawns(); this.renderPins();
  }
  private renderSpawns(): void {
    const list = this.element.querySelector('.respawn-choices')!;
    const active = document.activeElement as HTMLElement | null, focused = active?.dataset.spawn;
    list.replaceChildren();
    const state = this.reinforcements;
    this.element.classList.toggle('reinforcement-ready', !!state);
    this.element.querySelector<HTMLElement>('.respawn-panel')!.hidden = !state && !this.dead;
    this.element.querySelector<HTMLElement>('.reinforcement-heading')!.hidden = this.dead;
    this.element.querySelector<HTMLElement>('.redeploy-countdown')!.hidden = !this.dead;
    this.element.querySelector('.respawn-help')!.textContent = this.dead
      ? 'Your choice is used when the timer ends. If the rally becomes unsafe, you return at another safe position; your preference is remembered.'
      : 'This sets your next respawn only. It does not teleport or move you. Your preference is remembered between deaths.';
    this.displayedSpawns = orderedReinforcements(state?.options ?? [], this.state?.bases ?? [], this.x, this.z, this.state?.territories);
    const local = localCampaignBase(this.state?.bases ?? [], this.x, this.z, this.state?.territories);
    const localPanel = this.element.querySelector<HTMLElement>('.reinforcement-local')!; localPanel.replaceChildren(); localPanel.hidden = !local || !this.state;
    if (local && this.state) {
      const status = baseControlStatus(local, this.state.territories, this.state.you.faction, this.baseReinforcement(local.id));
      localPanel.dataset.state = status.kind; localPanel.dataset.base = local.id;
      const focus = document.createElement('button'); focus.className = 'reinforcement-local-focus';
      const label = document.createElement('small'); label.textContent = 'LOCAL BASE';
      const name = document.createElement('b'); name.textContent = local.name;
      const badge = document.createElement('span'); badge.textContent = status.kind === 'secured' ? 'SECURED · RALLY AVAILABLE' : status.kind === 'threatened' ? 'SECURED · RALLY THREATENED' : status.kind === 'partial' ? 'PARTIALLY CAPTURED' : 'CAPTURE REQUIRED';
      focus.append(label, name, badge); focus.setAttribute('aria-label', `Locate ${local.name} control network`);
      focus.onclick = () => {
        this.mapCenter = mapPoint(local); this.zoom = 4; this.renderViewport();
        if (innerWidth <= 650) this.element.querySelector('.atlas-cartography')?.scrollIntoView({ block: 'center' });
      };
      const detail = document.createElement('p'); detail.textContent = status.detail;
      const meter = document.createElement('div'); meter.className = 'local-control-meter';
      for (const control of this.state.territories.filter(control => local.controlIds.includes(control.id))) {
        const segment = document.createElement('i'); segment.style.background = FACTIONS[control.owner].color;
        segment.title = `${control.name} · ${FACTIONS[control.owner].name}${control.contested ? ' · Contested' : ''}`;
        segment.setAttribute('aria-label', segment.title); meter.append(segment);
      }
      localPanel.append(focus, meter, detail);
    }
    const add = (id: string, name: string, detail: string, index?: number, available = true, near = false) => {
      const button = document.createElement('button'); button.dataset.spawn = id;
      button.disabled = !available; button.dataset.available = String(available); button.classList.toggle('local-spawn', near);
      button.setAttribute('aria-pressed', String((state?.selected ?? '') === id));
      const title = document.createElement('b'); title.textContent = `${index === undefined ? '' : `${index + 1}. `}${name}`;
      const description = document.createElement('span'); description.textContent = detail;
      button.append(title, description); button.onclick = () => this.chooseSpawn(id); list.append(button);
      if (focused === id) button.focus({ preventScroll: true });
    };
    for (const [index, option] of this.displayedSpawns.entries()) {
      const near = (option.baseId ?? option.id) === local?.id, available = option.available !== false;
      const detail = `${near ? 'LOCAL · ' : ''}${available ? option.kind === 'mobile' ? 'Mobile rally' : 'Safe reinforcement rally' : 'UNAVAILABLE'} · ${(Math.hypot(option.x - this.x, option.z - this.z) / 1000).toFixed(1)} km${option.reason ? ` · ${option.reason}` : ''}`;
      add(option.id, option.name, detail, index, available, near);
    }
    add('', 'Automatic deployment', 'Use an available safe faction rally', undefined, !!state);
    if (this.dead) this.updateRespawnCountdown();
    else this.element.querySelector('#respawn-detail')!.textContent = reinforcementStatus(state ?? { selected: null, options: [] }, true).detail;
  }
  private updateRespawnCountdown(): void {
    if (!this.dead) return;
    const now = performance.now(), state = this.state?.respawn;
    const status = respawnStatus({ remaining: state?.remaining ?? PLAYER.RESPAWN_SECONDS, selected: this.reinforcements?.selected ?? null, options: this.reinforcements?.options ?? [] },
      (now - (state ? this.respawnReceivedAt : this.deathAt)) / 1000);
    this.element.querySelector('#respawn-countdown')!.textContent = String(Math.ceil(status.remaining));
    this.element.querySelector('#respawn-detail')!.textContent = status.remaining > 0 ? status.detail : 'Deploying…';
  }
  update(x: number, y: number, z: number, yaw: number, seconds: number, observer?: CaptureObserver): void {
    this.x = x; this.z = z;this.yaw=yaw;
    if(this.open&&this.intelDirty&&seconds-this.lastIntelDraw>=.12){this.lastIntelDraw=seconds;this.renderIntel();}
    if (this.dead && !this.open && performance.now() >= this.mapOpenAt) this.toggle(true);
    if (seconds - this.lastUpdate < .2) return;
    this.lastUpdate = seconds;
    this.updateRespawnCountdown();
    const order = this.state?.order;
    this.orderPanel.hidden = !order || this.dead;
    if (order) {
      const goal = order.phase === 'assemble' ? order.staging : order;
      const distance = Math.hypot(goal.x - x, goal.z - z), angle = Math.atan2(-(goal.x - x), -(goal.z - z)) - yaw;
      const relative = Math.atan2(Math.sin(angle), Math.cos(angle));
      const arrow = Math.abs(relative) < .5 ? '↑' : Math.abs(relative) > 2.6 ? '↓' : relative > 0 ? '←' : '→';
      this.orderPanel.textContent = `${arrow} SQUAD ${order.squad + 1} · ${order.phase.toUpperCase()} · ${order.name} · ${distance >= 1000 ? `${(distance / 1000).toFixed(1)} km` : `${Math.round(distance)} m`}`;
    }
    if (this.open) {
      const pods = this.world?.collectTransportPlan().pods ?? [];
      const nearest = pods.reduce((best, pod) => !best || Math.hypot(pod.x - x, pod.z - z) < Math.hypot(best.x - x, best.z - z) ? pod : best, null as typeof pods[number] | null);
      this.transitHint.hidden = !nearest;
      if (nearest) this.transitHint.textContent = `Nearest airlift: ${nearest.name} · ${(Math.hypot(nearest.x - x, nearest.z - z) / 1000).toFixed(1)} km. The outlined violet diamond marks its position. Press E at the pod to travel.`;
    }
    if(this.open){const point = mapPoint({ x, z }); this.self.setAttribute('transform', `translate(${point.x} ${point.y}) rotate(${-yaw * 180 / Math.PI}) scale(${this.mapUnitsPerPixel})`);}
    const cities = this.world?.collectCities() ?? [];
    const city = cities.find(c => Math.hypot(c.x - x, c.z - z) < c.radius + 100);
    const under = this.world && this.world.terrainHeight(x, z) > y + 5;
    const location = under ? 'Below the frontier' : city?.name ?? (Math.hypot(x, z) > 8800 ? 'The outer coast' : 'Unclaimed wilderness');
    if (location !== this.location) { this.location = location; this.bar.querySelector('.world-location')!.textContent = location; }
    const nearest = this.state?.territories.reduce((best, t) => !best || Math.hypot(t.x - x, t.z - z) < Math.hypot(best.x - x, best.z - z) ? t : best, null as FrontierState['territories'][number] | null);
    this.capturePanel.hidden = !nearest || !observer || !this.state || Math.hypot(nearest.x - x, nearest.z - z) >= 450;
    document.body.dataset.capturing = 'false';
    if (!this.capturePanel.hidden && nearest && observer && this.state) {
      const status = captureStatus(nearest, this.state.you.faction, observer);
      this.capturePanel.dataset.state = status.kind;
      this.capturePanel.dataset.territory = nearest.id;
      this.capturePanel.style.setProperty('--capture-color', FACTIONS[this.state.you.faction || nearest.owner].color);
      this.capturePanel.querySelector('.capture-owner')!.textContent = `${nearest.owner ? FACTIONS[nearest.owner].name : 'Unclaimed'} · ${nearest.radius} m radius`;
      this.capturePanel.querySelector('.capture-name')!.textContent = nearest.name;
      this.capturePanel.querySelector('#capture-phase')!.textContent = status.phase;
      this.capturePanel.querySelector('#capture-percent')!.textContent = `${Math.floor(status.progress + 1e-6)}%`;
      this.capturePanel.querySelector('#capture-detail')!.textContent = status.detail;
      const base = this.state.bases?.find(base => base.id === nearest.baseId || base.controlIds.includes(nearest.id));
      const baseLine = this.capturePanel.querySelector<HTMLElement>('.capture-base')!; baseLine.hidden = !base;
      if (base) baseLine.textContent = `${base.name} · ${baseControlStatus(base, this.state.territories, this.state.you.faction, this.baseReinforcement(base.id)).detail}`;
      this.capturePanel.querySelector('.capture-track')!.setAttribute('aria-valuenow', String(Math.floor(status.progress + 1e-6)));
      this.capturePanel.style.setProperty('--capture-progress', `${status.progress}%`);
      document.body.dataset.capturing = String(status.active && ['capturing', 'contested', 'secured'].includes(status.kind));
    }
  }
}
