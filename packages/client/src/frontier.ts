import { FACTIONS, type Faction, type FrontierState } from '@shared/frontier';
import type { World } from '@shared/worldgen';
import { mapPoint, worldMapSvg } from './world-map.js';
import { planetBySeed, PLANETS } from '@shared/universe';

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
  private pins: SVGElement;
  private self: SVGElement;
  private x = 0; private z = 0;

  constructor(private readonly enlist: (faction: Faction) => void, private readonly onOpen: (open: boolean, resume: boolean) => void, system: () => void = () => {}) {
    this.bar.id = 'frontier-bar';
    this.bar.innerHTML = `<div class="world-brand"><b>THE MMOFPS<span>01</span></b><span>MERIDIAN SYSTEM</span></div>
      <div class="world-location">Arriving on the frontier</div><button id="atlas-open" aria-label="Open world atlas">G <span>WORLD ATLAS</span> ↗</button>
      <div id="frontier-status">INDEPENDENT · FREE EXPLORATION</div><div id="frontier-near"></div>`;
    const systemButton = document.createElement('button'); systemButton.id = 'system-open'; systemButton.textContent = 'O  STAR SYSTEM ↗';
    systemButton.setAttribute('aria-label', 'Open star system'); systemButton.onclick = system; this.bar.append(systemButton);
    this.element.id = 'frontier-atlas'; this.element.hidden = true;
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-label', 'World atlas and factions');
    this.element.innerHTML = `<header><div><small>THE MMOFPS / WORLD ATLAS</small><h1>A world worth getting lost in.</h1></div><button id="atlas-close" aria-label="Close atlas">BACK TO WORLD <span>×</span></button></header>
      <div class="atlas-body"><div class="atlas-cartography"><div class="atlas-map"></div><svg class="atlas-pins" viewBox="0 0 600 600"></svg>
      <div class="atlas-map-label"><small>01 / MERIDIAN</small><b>The inhabited frontier</b><span>Cities · wilderness · subterranean routes · open ocean</span></div></div>
      <aside class="atlas-sidebar"><small>YOUR ALLEGIANCE</small><h2>Choose your own war.</h2><p>Arrive as an independent explorer. Enlist when you want to fight for territory. Stand down after leaving combat.</p>
      <div class="faction-choices">${FACTIONS.map(f => `<button data-faction="${f.id}" style="--faction:${f.color}"><i></i><span><b>${f.name}</b><small>${f.description}</small></span><em>→</em></button>`).join('')}</div>
      <div class="atlas-inventory"></div><div class="atlas-fronts"></div><div class="atlas-transit"><small>GO FURTHER</small><p>Follow the rail lines into another city. Take a ferry around the coast. Find a cave entrance or board an airlift pod.</p><span>M · compass & minimap &nbsp; E · board / interact</span></div></aside></div>
      <footer><span>ONE CONNECTED FRONTIER</span><span>Gold lines: rail · Cyan lines: ferry · Dots: territory</span></footer>`;
    document.body.append(this.bar, this.element);
    this.map = this.element.querySelector('.atlas-map')!;
    this.pins = this.element.querySelector('.atlas-pins')!;
    this.self = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    this.self.setAttribute('d', 'M0 -7L5 6L0 3L-5 6Z'); this.self.setAttribute('fill', '#fff7d5');
    this.self.setAttribute('stroke', '#071b24'); this.self.setAttribute('stroke-width', '1.5');
    this.bar.querySelector('button')!.onclick = () => this.toggle();
    this.element.querySelector<HTMLButtonElement>('#atlas-close')!.onclick = () => this.toggle(false);
    this.element.querySelectorAll<HTMLButtonElement>('[data-faction]').forEach(button => button.onclick = () => this.enlist(Number(button.dataset.faction) as Faction));
    window.addEventListener('keydown', e => {
      if ((e.target as HTMLElement)?.matches('input,textarea,[contenteditable]')) return;
      if ((e.code === 'KeyG' || (e.code === 'Escape' && this.open)) && !e.repeat) { e.preventDefault(); this.toggle(); }
    });
  }
  toggle(value = !this.open, resume = true): void {
    if (this.open === value) return;
    this.open = value; this.element.hidden = !value;
    this.onOpen(value, resume);
  }
  setWorld(world: World): void {
    this.world = world; this.map.innerHTML = worldMapSvg(world, world.collectTransportPlan());
    const planet = planetBySeed(world.seed), index = PLANETS.findIndex(p => p.id === planet.id) + 1;
    this.bar.querySelector('.world-brand b span')!.textContent = `0${index}`;
    this.bar.querySelector('.world-brand>span')!.textContent = `${planet.name.toUpperCase()} / HELIOS`;
    this.element.querySelector('.atlas-map-label small')!.textContent = `0${index} / ${planet.name.toUpperCase()}`;
    this.element.querySelector('.atlas-map-label b')!.textContent = planet.description.split('.')[0];
    this.location = '';
  }
  receive(state: FrontierState): void {
    this.state = state;
    document.body.dataset.allegiance = String(state.you.faction);
    this.bar.querySelector('#frontier-status')!.textContent = `${FACTIONS[state.you.faction].name.toUpperCase()} · ${state.you.faction ? 'FACTION OPERATIONS' : 'FREE EXPLORATION'}`;
    this.bar.style.setProperty('--faction', FACTIONS[state.you.faction].color);
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-faction]')) {
      const active = Number(button.dataset.faction) === state.you.faction;
      button.setAttribute('aria-pressed', String(active));
      button.querySelector('em')!.textContent = active ? '✓' : '→';
      button.disabled = !active && state.you.factionCooldown > 0;
    }
    this.element.querySelector('.atlas-inventory')!.textContent = `${state.you.salvage} SALVAGE · ${state.you.discoveries.length} DISCOVERIES${state.you.factionCooldown ? ` · ALLEGIANCE LOCK ${state.you.factionCooldown}s` : ''}`;
    this.pins.replaceChildren();
    for (const site of state.territories) {
      const point = mapPoint(site), circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', String(point.x)); circle.setAttribute('cy', String(point.y)); circle.setAttribute('r', site.contested ? '5' : '3');
      circle.setAttribute('fill', FACTIONS[site.owner].color); circle.setAttribute('stroke', '#0b2027');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = `${site.name} · ${FACTIONS[site.owner].name}`;
      circle.append(title); this.pins.append(circle);
    }
    this.pins.append(this.self);
    for (const pod of this.world?.collectTransportPlan().pods ?? []) {
      const point = mapPoint(pod), marker = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      marker.setAttribute('d', `M${point.x} ${point.y - 4}l4 4-4 4-4-4Z`); marker.setAttribute('fill', '#c5c4ff'); marker.setAttribute('stroke', '#0b2027');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = `${pod.name} · Airlift / orbital pod`; marker.append(title); this.pins.append(marker);
    }
    const fronts = this.element.querySelector('.atlas-fronts')!; fronts.replaceChildren();
    const label = document.createElement('small'); label.textContent = 'TERRITORY NETWORK'; fronts.append(label);
    for (const faction of FACTIONS.slice(1)) {
      const line = document.createElement('div'); line.style.color = faction.color;
      line.textContent = `${faction.name}   ${state.territories.filter(t => t.owner === faction.id).length} districts`; fronts.append(line);
    }
  }
  update(x: number, y: number, z: number, yaw: number, seconds: number): void {
    this.x = x; this.z = z;
    if (seconds - this.lastUpdate < .2) return;
    this.lastUpdate = seconds;
    const point = mapPoint({ x, z }); this.self.setAttribute('transform', `translate(${point.x} ${point.y}) rotate(${-yaw * 180 / Math.PI})`);
    const cities = this.world?.collectCities() ?? [];
    const city = cities.find(c => Math.hypot(c.x - x, c.z - z) < c.radius + 100);
    const under = this.world && this.world.terrainHeight(x, z) > y + 5;
    const location = under ? 'Below the frontier' : city?.name ?? (Math.hypot(x, z) > 8800 ? 'The outer coast' : 'Unclaimed wilderness');
    if (location !== this.location) { this.location = location; this.bar.querySelector('.world-location')!.textContent = location; }
    const nearest = this.state?.territories.reduce((best, t) => !best || Math.hypot(t.x - x, t.z - z) < Math.hypot(best.x - x, best.z - z) ? t : best, null as FrontierState['territories'][number] | null);
    const notice = this.bar.querySelector('#frontier-near')!;
    if (nearest && Math.hypot(nearest.x - x, nearest.z - z) < 450) {
      const d = Math.round(Math.hypot(nearest.x - x, nearest.z - z));
      notice.textContent = `${nearest.contested ? 'CONTESTED' : FACTIONS[nearest.owner].name.toUpperCase()} · ${nearest.name.split(' · ').pop()} · ${d} m`;
    } else notice.textContent = 'Follow your curiosity. The war can wait.';
  }
}
