import { PLANETS, planetBySeed, nearestSpaceport, type JourneyState, type UniverseStatus } from '@shared/universe';
import { Noise } from '@shared/noise';
import type { World } from '@shared/worldgen';
import { PLANET_CAMPAIGN_REWARD, type FrontierState } from '@shared/frontier';
import { ownershipShares, renderOwnership } from './territory-map.js';

/** The star chart is a navigation instrument, available after instant arrival.
 * Its small procedural globe portraits require no image or model downloads. */
export class OrbitalUI {
  readonly element = document.createElement('section');
  readonly beacon = document.createElement('aside');
  private readonly journey = document.createElement('aside');
  open = false;
  private world: World | null = null;
  private current = 0;
  private selected = 1;
  private status: UniverseStatus | null = null;
  private localOwnership: number[] | null = null;
  private campaignRewards: readonly number[] = [];
  private readonly chart: HTMLCanvasElement;
  private readonly globes = new Map<number, HTMLCanvasElement>();
  private planetTargets: { x: number; y: number; radius: number; index: number }[] = [];
  private position = { x: 0, y: 0, z: 0 };
  private onFoot = true;
  private guiding = false;
  private lastUpdate = 0;
  private phase: JourneyState | null = null;
  private abort = new AbortController();
  private observer: ResizeObserver;
  private poll: ReturnType<typeof setInterval>;
  /** A universe with one enabled world has nowhere to launch to: the star
   * chart and its HUD button stay hidden until more worlds are enabled. */
  singleWorld = false;

  constructor(private travel: (destination: number) => void, private changed: (open: boolean, resume: boolean) => void, private atlas: () => void) {
    this.element.id = 'orbital-map'; this.element.hidden = true;
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-modal', 'true'); this.element.setAttribute('aria-label', 'Helios star system');
    this.element.innerHTML = `<header><div><small>THE MMOFPS / ORBITAL NAVIGATION</small><h1>Beyond the next horizon.</h1></div><button class="orbit-close" aria-label="Close star system">BACK TO WORLD <span>×</span></button></header>
      <div class="orbit-layout"><div class="orbit-chart"><canvas aria-hidden="true"></canvas><div class="orbit-chart-title"><small>BINARY STAR SYSTEM</small><b>Helios</b><span>Three frontiers. One shared war.</span></div>
      <nav class="orbit-planets" aria-label="Planets">${PLANETS.map((p, i) => `<button data-planet="${i}" style="--planet:${p.color}"><span>0${i + 1}</span><b>${p.name}</b><small></small><div class="planet-ownership"></div></button>`).join('')}</nav><div class="orbit-scale">ORBITAL PROJECTION <span>HELIOS A + B</span></div></div>
      <aside class="orbit-detail"><div class="orbit-survey"><small class="orbit-number"></small><span class="orbit-availability"></span></div><h2></h2><p class="orbit-description"></p>
      <section class="orbit-control"><small>CONTROL POINTS</small><div class="orbit-ownership"></div></section>
      <section class="orbit-contract"><small>PLANETARY CAMPAIGN CONTRACT</small><b></b><p></p></section>
      <section class="orbit-campaign"><small>CAMPAIGN DISPATCH</small><p></p></section>
      <div class="orbit-facts"><div><b>04</b><span>CITIES TO DISCOVER</span></div><div><b>22.5 km</b><span>SURVEYED REGION WIDTH</span></div></div>
      <div class="orbit-places"></div><div class="orbit-departure"><small>YOUR DEPARTURE</small><b></b><span></span></div>
      <button class="orbit-launch"></button><button class="orbit-guide">MARK NEAREST TRANSIT POD ↗</button><button class="orbit-atlas">EXPLORE THIS WORLD'S ATLAS →</button>
      <p class="orbit-help">Launch from any transit pod. Hold position during the 5-second charge. Your allegiance, supplies and discoveries travel with you.</p></aside></div>
      <footer><span>THE FRONTIER DOESN'T END AT THE COAST</span><span>O · star system &nbsp; G · world atlas</span></footer>`;
    this.beacon.id = 'orbital-beacon'; this.beacon.hidden = true;
    this.beacon.innerHTML = '<span></span><button aria-label="Clear transit waypoint">×</button>';
    this.journey.id = 'orbital-journey'; this.journey.hidden = true; this.journey.setAttribute('role', 'status');
    document.body.append(this.element, this.beacon, this.journey);
    this.chart = this.element.querySelector('canvas')!;
    this.chart.onclick = event => {
      const rect = this.chart.getBoundingClientRect(), x = event.clientX - rect.left, y = event.clientY - rect.top;
      const target = this.planetTargets.find(p => Math.hypot(p.x - x, p.y - y) < p.radius + 14);
      if (target) { this.selected = target.index; this.refresh(); this.draw(); }
    };
    this.beacon.querySelector('button')!.onclick = () => { this.guiding = false; this.beacon.hidden = true; };
    this.element.querySelector<HTMLButtonElement>('.orbit-close')!.onclick = () => this.toggle(false);
    this.element.querySelectorAll<HTMLButtonElement>('[data-planet]').forEach(button => button.onclick = () => {
      this.selected = Number(button.dataset.planet); this.refresh(); this.draw();
    });
    this.element.querySelector<HTMLButtonElement>('.orbit-launch')!.onclick = () => this.travel(this.selected);
    this.element.querySelector<HTMLButtonElement>('.orbit-guide')!.onclick = () => { this.guiding = true; this.toggle(false); };
    this.element.querySelector<HTMLButtonElement>('.orbit-atlas')!.onclick = () => { this.toggle(false, false); this.atlas(); };
    window.addEventListener('keydown', event => {
      if ((event.target as HTMLElement)?.matches('input,textarea,[contenteditable]')) return;
      if ((event.code === 'KeyO' || event.code === 'Escape' && this.open) && !event.repeat) { event.preventDefault(); this.toggle(); }
      if (this.open && event.code === 'Tab') {
        const buttons = [...this.element.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        event.preventDefault(); buttons[(index + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length]?.focus();
      }
    }, { signal: this.abort.signal });
    this.observer = new ResizeObserver(() => { if (this.open) this.draw(); }); this.observer.observe(this.chart);
    this.poll = setInterval(() => { if (this.open) void this.loadStatus(); }, 5000);
  }
  setWorld(world: World): void {
    this.world = world; this.current = PLANETS.findIndex(p => p.id === planetBySeed(world.seed).id);
    this.localOwnership = null;
    this.selected = (this.current + 1) % PLANETS.length; this.phase = null; this.journey.hidden = true;
    void this.loadStatus();
  }
  toggle(value = !this.open, resume = true): void {
    if (value && this.singleWorld) return;
    if (this.open === value) return;
    this.open = value; this.element.hidden = !value; this.changed(value, resume);
    if (value) { this.element.scrollTop = 0; this.refresh(); this.draw(); void this.loadStatus(); this.element.querySelector<HTMLButtonElement>('.orbit-close')!.focus({ preventScroll: true }); }
  }
  receive(state: JourneyState): void {
    this.phase = state; this.refresh();
    this.journey.hidden = state.phase !== 'charging' || this.open;
    this.journey.textContent = `ORBITAL LAUNCH · ${state.remaining.toFixed(1)}s · HOLD POSITION`;
  }
  receiveFrontier(state: FrontierState): void {
    this.localOwnership = ownershipShares(state.territories);
    this.campaignRewards = state.you.campaignRewards ?? [];
    if (this.open) this.refresh();
  }
  private async loadStatus(): Promise<void> {
    try {
      const response = await fetch('/api/universe', { signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error('No transit signal');
      this.status = await response.json() as UniverseStatus;
      this.setSingleWorld(Array.isArray(this.status.planets) && this.status.planets.length <= 1);
    } catch { this.status = null; }
    this.refresh();
  }
  private setSingleWorld(single: boolean): void {
    this.singleWorld = single;
    const button = document.getElementById('system-open');
    if (button) button.hidden = single;
    document.body.classList.toggle('single-world', single);
    if (single && this.open) this.toggle(false);
  }
  update(x: number, y: number, z: number, yaw: number, onFoot: boolean, seconds: number): void {
    this.position = { x, y, z }; this.onFoot = onFoot;
    if (seconds - this.lastUpdate < .2) return; this.lastUpdate = seconds;
    if (this.open) this.refresh();
    const near = this.world && nearestSpaceport(this.world, this.position);
    this.beacon.hidden = !this.guiding || !near || this.open;
    if (near && this.guiding) {
      const angle = Math.atan2(-(near.port.x - x), -(near.port.z - z)) - yaw;
      const relative = Math.atan2(Math.sin(angle), Math.cos(angle));
      const arrow = Math.abs(relative) < .45 ? '↑' : Math.abs(relative) > 2.7 ? '↓' : relative > 0 ? '←' : '→';
      this.beacon.querySelector('span')!.textContent = near.distance < 5.5 ? 'TRANSIT POD · O / STAR SYSTEM TO LAUNCH' : `${arrow} ${near.port.name.toUpperCase()} · ${Math.round(near.distance)} m`;
    }
  }
  private refresh(): void {
    const planet = PLANETS[this.selected], current = this.selected === this.current;
    const route = this.status?.planets.find(p => p.id === planet.id);
    this.element.style.setProperty('--planet', planet.color);
    this.element.querySelector('.orbit-number')!.textContent = `0${this.selected + 1} / ${current ? 'YOU ARE HERE' : 'OUTBOUND DESTINATION'}`;
    this.element.querySelector('.orbit-availability')!.textContent = route?.available ? `${route.players} EXPLORERS · OPEN` : 'TRANSIT OFFLINE';
    this.element.querySelector('h2')!.textContent = planet.name;
    this.element.querySelector('.orbit-description')!.textContent = planet.description;
    const earned = this.campaignRewards.includes(planet.seed);
    this.element.querySelector('.orbit-contract b')!.textContent = earned ? 'CONTRACT COMPLETE' : `+${PLANET_CAMPAIGN_REWARD} SALVAGE`;
    this.element.querySelector('.orbit-contract p')!.textContent = earned
      ? `Your first conquest on ${planet.name} is recorded. Each other planet has its own contract.`
      : `Help capture a control point on ${planet.name}. Stay on foot inside its ring when your faction claims it. Reward once per planet.`;
    const selectedOwnership = current && this.localOwnership ? this.localOwnership : route?.ownership;
    const campaign = route?.campaign;
    this.element.querySelector('.orbit-campaign p')!.textContent = campaign
      ? `${campaign.threatenedBases ? `${campaign.threatenedBases} ${campaign.threatenedBases === 1 ? 'base is' : 'bases are'} under attack. Reinforcements needed. ` : 'No active distress calls. Capture outlying controls to open another front. '}` +
        `${campaign.botPopulation.reduce((sum, count) => sum + count, 0)} soldiers deployed` +
        `${campaign.inboundSquads ? ` · ${campaign.inboundSquads} incoming ${campaign.inboundSquads === 1 ? 'squad' : 'squads'}` : ''}.`
      : 'Waiting for the latest planetary dispatch.';
    const ownership = this.element.querySelector<HTMLElement>('.orbit-ownership')!;
    if (selectedOwnership) renderOwnership(ownership, selectedOwnership);
    else ownership.textContent = 'Control data unavailable';
    this.element.querySelector('.orbit-places')!.textContent = planet.cities.join(' · ');
    const near = this.world && nearestSpaceport(this.world, this.position);
    this.element.querySelector('.orbit-departure b')!.textContent = near?.port.name ?? 'Locating transit';
    this.element.querySelector('.orbit-departure span')!.textContent = near ? `${Math.round(near.distance)} m from your position${near.distance < 5.5 && this.onFoot ? ' · READY TO LAUNCH' : ' · REACH THE POD ON FOOT'}` : 'Arriving in the world';
    const launching = this.phase && ['charging', 'departing', 'committed'].includes(this.phase.phase);
    const launch = this.element.querySelector<HTMLButtonElement>('.orbit-launch')!;
    launch.disabled = current || !route?.available || !near || near.distance > 5.5 || !this.onFoot || !!launching;
    launch.textContent = launching ? (this.phase!.phase === 'charging' ? `HOLD POSITION · ${this.phase!.remaining.toFixed(1)}s` : 'IN TRANSIT…') : current ? 'YOU ARE ON THIS WORLD' : `LAUNCH TO ${planet.name.toUpperCase()} ↗`;
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('[data-planet]')) {
      const index = Number(button.dataset.planet);
      button.setAttribute('aria-pressed', String(index === this.selected));
      const destination = this.status?.planets.find(p => p.id === PLANETS[index].id);
      button.querySelector('small')!.textContent = destination?.campaign?.threatenedBases
        ? `${destination.campaign.threatenedBases} UNDER ATTACK` : index === this.current ? 'YOU ARE HERE' : destination?.available ? 'TRANSIT OPEN' : 'OFFLINE';
      const shares = index === this.current && this.localOwnership ? this.localOwnership : this.status?.planets.find(p => p.id === PLANETS[index].id)?.ownership;
      const meter = button.querySelector<HTMLElement>('.planet-ownership')!;
      if (shares) renderOwnership(meter, shares, false); else meter.textContent = 'NO CONTROL DATA';
    }
  }
  private globe(index: number): HTMLCanvasElement {
    const cached = this.globes.get(index); if (cached) return cached;
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 192;
    const context = canvas.getContext('2d')!, pixels = context.createImageData(192, 192), noise = new Noise(PLANETS[index].seed);
    const land = [[103, 132, 94], [152, 92, 57], [159, 181, 191]][index];
    const sea = [[20, 70, 85], [46, 43, 55], [24, 59, 99]][index];
    for (let y = 0; y < 192; y++) for (let x = 0; x < 192; x++) {
      const nx = (x - 95.5) / 95, ny = (y - 95.5) / 95, radius = nx * nx + ny * ny;
      if (radius > 1) continue;
      const nz = Math.sqrt(1 - radius), terrain = noise.fbm3(nx * 3 + index, ny * 3, nz * 3, 5);
      const cloud = Math.max(0, noise.fbm3(nx * 7, ny * 7, nz * 7 + 11, 3) - .12) * 1.5;
      const polar = Math.max(0, Math.abs(ny) - .73) * 2.2;
      const surface = terrain > -.02 ? land : sea, light = Math.max(.025, -nx * .7 - ny * .42 + nz * .56);
      const rim = Math.pow(1 - nz, 4) * light * 65, bright = Math.max(0, terrain) * 65;
      const offset = (y * 192 + x) * 4;
      for (let c = 0; c < 3; c++) pixels.data[offset + c] = (surface[c] + bright + (220 - surface[c]) * Math.min(.85, cloud + polar)) * light + rim * (c === 2 ? 1.7 : 1);
      pixels.data[offset + 3] = Math.min(1, (1 - Math.sqrt(radius)) * 95) * 255;
    }
    context.putImageData(pixels, 0, 0); this.globes.set(index, canvas); return canvas;
  }
  private draw(): void {
    if (!this.open) return;
    const width = this.chart.clientWidth, height = this.chart.clientHeight;
    if (!width || !height) return;
    const dpr = Math.min(devicePixelRatio, 2); this.chart.width = width * dpr; this.chart.height = height * dpr;
    const c = this.chart.getContext('2d')!; c.scale(dpr, dpr); c.fillStyle = '#061018'; c.fillRect(0, 0, width, height);
    const mist = c.createRadialGradient(width * .45, height * .6, 0, width * .5, height * .5, width * .7);
    mist.addColorStop(0, '#193746'); mist.addColorStop(.5, '#0b1a25'); mist.addColorStop(1, '#061018'); c.fillStyle = mist; c.fillRect(0, 0, width, height);
    for (let i = 0; i < 220; i++) {
      c.fillStyle = `rgba(204,225,235,${.15 + (i % 7) * .065})`;
      c.fillRect(((i * 754.37) % 1000) / 1000 * width, ((i * 569.21) % 1000) / 1000 * height, i % 19 ? 1 : 2, i % 19 ? 1 : 2);
    }
    const sx = width * (width < 500 ? .1 : .2), sy = height * (width < 500 ? .61 : .57);
    for (let i = 0; i < 3; i++) {
      c.beginPath(); c.ellipse(sx, sy, width * (.23 + i * .235), height * (.18 + i * .16), -.2, 0, Math.PI * 2);
      c.strokeStyle = '#b4d5db25'; c.lineWidth = 1; c.stroke();
    }
    const star = (x: number, y: number, r: number, cool: boolean) => {
      const glow = c.createRadialGradient(x, y, 0, x, y, r * 8);
      glow.addColorStop(0, cool ? '#e4f6ffe6' : '#fff4dce6'); glow.addColorStop(.13, cool ? '#9bd5ffcc' : '#ffcf7ccc'); glow.addColorStop(.3, cool ? '#80bbff22' : '#ffbc661a'); glow.addColorStop(1, '#ffc36c00');
      c.fillStyle = glow; c.fillRect(x - r * 8, y - r * 8, r * 16, r * 16);
      c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = '#fff9e9'; c.fill();
    };
    star(sx, sy, width < 500 ? 7 : 11, false); star(sx + 26, sy - 18, 4, true);
    const positions = [{ x: .31, y: .34, r: .052 }, { x: .59, y: .69, r: .072 }, { x: .81, y: .29, r: .06 }];
    if (height < 350) positions.forEach((p, i) => { p.y = [.38, .54, .29][i]; });
    else if (width < 500) positions[0].y = .43;
    const source = positions[this.current], target = positions[this.selected];
    if (this.current !== this.selected) {
      c.beginPath(); c.moveTo(source.x * width, source.y * height); c.quadraticCurveTo(width * .5, height * .36, target.x * width, target.y * height);
      c.setLineDash([3, 6]); c.strokeStyle = '#bfded180'; c.stroke(); c.setLineDash([]);
    }
    this.planetTargets.length = 0;
    for (let i = 0; i < PLANETS.length; i++) {
      const p = positions[i], x = p.x * width, y = p.y * height, radius = Math.max(22, Math.min(65, p.r * width, height * .13));
      this.planetTargets.push({ x, y, radius, index: i });
      const halo = c.createRadialGradient(x, y, radius * .8, x, y, radius * 1.5);
      halo.addColorStop(0, PLANETS[i].color + '30'); halo.addColorStop(1, PLANETS[i].color + '00'); c.fillStyle = halo; c.fillRect(x - radius * 1.5, y - radius * 1.5, radius * 3, radius * 3);
      c.drawImage(this.globe(i), x - radius, y - radius, radius * 2, radius * 2);
      if (i === this.selected) { c.beginPath(); c.arc(x, y, radius + 7, 0, Math.PI * 2); c.strokeStyle = PLANETS[i].color + '88'; c.stroke(); }
      const button = this.element.querySelector<HTMLButtonElement>(`[data-planet="${i}"]`)!;
      button.style.left = `${p.x * 100}%`; button.style.top = `${y + radius + 13}px`;
    }
  }
  dispose(): void { clearInterval(this.poll); this.abort.abort(); this.observer.disconnect(); this.element.remove(); this.beacon.remove(); this.journey.remove(); }
}
