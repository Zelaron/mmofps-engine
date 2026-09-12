import { OUTPOST_TYPES, planOutpost, type OutpostAction, type OutpostSite, type OutpostSnapshot } from '@shared/outposts';
import type { World } from '@shared/worldgen';
import type { FrontierState } from '@shared/frontier';

export class CampsUI {
  readonly element = document.createElement('section');
  readonly button = document.createElement('button');
  open = false;
  state: OutpostSnapshot = { enabled: false, sites: [] };
  private world: World | null = null;
  private inventory: FrontierState | null = null;
  private type = 0; private facing = 0; private distance = 7;
  private site: OutpostSite | null = null;
  private updatedAt = -Infinity;
  private pending = false;
  private nearbyKey = '';
  private place: HTMLButtonElement;
  private notice: HTMLElement;
  constructor(private readonly send: (action: OutpostAction) => void,
    private readonly onOpen: (open: boolean, resume: boolean) => void,
    private readonly preview: (site: OutpostSite | null, valid: boolean) => void) {
    this.button.id = 'camp-open'; this.button.textContent = 'B  FIELD CAMP'; this.button.setAttribute('aria-label', 'Build a field camp'); this.button.onclick = () => this.toggle();
    this.element.id = 'camp-builder'; this.element.hidden = true;
    this.element.setAttribute('role', 'dialog'); this.element.setAttribute('aria-label', 'Field camp construction');
    this.element.innerHTML = `<header><div><small>MAKE THE FRONTIER YOUR HOME</small><h2>Field camp</h2></div><button id="camp-close" aria-label="Close construction">×</button></header>
      <div class="camp-wallet"></div><div class="camp-blueprints">${OUTPOST_TYPES.map((t, i) => `<button data-blueprint="${i}" aria-pressed="${i === 0}"><b>${t.name}<span>${t.cost}</span></b><small>${t.description}</small></button>`).join('')}</div>
      <div class="camp-adjust"><button id="camp-rotate">Rotate 90°</button><label>Distance <select id="camp-distance"><option value="5">5 m</option><option value="7" selected>7 m</option><option value="9">9 m</option></select></label></div>
      <p class="camp-reason" aria-live="polite"></p><button id="camp-place">BUILD MODULE</button>
      <p class="camp-guidance">Close this panel to move and aim. Reopen with B or FIELD CAMP. Services help the owner and matching allegiance within 5 m.</p>
      <div class="camp-owned"></div><p class="camp-result" role="status"></p>`;
    this.place = this.element.querySelector('#camp-place')!; this.notice = this.element.querySelector('.camp-result')!;
    this.element.querySelector<HTMLButtonElement>('#camp-close')!.onclick = () => this.toggle(false);
    this.element.querySelectorAll<HTMLButtonElement>('[data-blueprint]').forEach(b => b.onclick = () => {
      this.type = Number(b.dataset.blueprint); this.updatedAt = -Infinity;
      this.element.querySelectorAll('[data-blueprint]').forEach(v => v.setAttribute('aria-pressed', String(v === b)));
    });
    this.element.querySelector<HTMLButtonElement>('#camp-rotate')!.onclick = () => { this.facing = (this.facing + 1) % 4; this.updatedAt = -Infinity; };
    this.element.querySelector<HTMLSelectElement>('#camp-distance')!.onchange = e => { this.distance = Number((e.target as HTMLSelectElement).value); this.updatedAt = -Infinity; };
    this.place.onclick = () => {
      if (!this.site || this.place.disabled || this.pending) return;
      this.pending = true; this.place.disabled = true; this.notice.textContent = 'Building…';
      this.send({ action: 'build', type: this.site.type, x: this.site.x, z: this.site.z, facing: this.site.facing });
    };
    document.body.append(this.element);
    window.addEventListener('keydown', e => {
      if ((e.target as HTMLElement)?.matches('input,textarea,select,[contenteditable]') || e.repeat) return;
      if (e.code === 'KeyB' || e.code === 'Escape' && this.open) { e.preventDefault(); this.toggle(); }
    });
  }
  toggle(open = !this.open, resume = true): void {
    if (open === this.open) return;
    this.open = open; this.element.hidden = !open; this.updatedAt = -Infinity;
    if (!open) this.preview(null, false);
    this.onOpen(open, resume);
  }
  setWorld(world: World): void { this.world = world; this.inventory = null; this.state = { enabled: false, sites: [] }; this.pending = false; this.nearbyKey = ''; this.updatedAt = -Infinity; }
  receive(state: OutpostSnapshot): void { this.state = state; this.updatedAt = -Infinity; }
  receiveInventory(state: FrontierState): void { this.inventory = state; this.updatedAt = -Infinity; }
  message(text: string): void { if (this.pending) { this.pending = false; this.notice.textContent = text; this.updatedAt = -Infinity; } }
  update(x: number, y: number, z: number, yaw: number, id: number, alive: boolean, onFoot: boolean, seconds: number): void {
    if (!this.open || !this.world || seconds - this.updatedAt < .2) return;
    this.updatedAt = seconds;
    const px = Math.round((x - Math.sin(yaw) * this.distance) * 2) / 2, pz = Math.round((z - Math.cos(yaw) * this.distance) * 2) / 2;
    const planned = planOutpost(this.world, this.type, px, pz, this.facing);
    this.site = planned.site;
    let reason = !this.state.enabled ? 'Construction needs a connected universe world.' : !alive || !onFoot ? 'Reach solid ground on foot to build.' : planned.reason;
    const salvage = this.inventory?.you.salvage ?? 0, cost = OUTPOST_TYPES[this.type].cost;
    if (!reason && this.inventory?.you.factionCooldown) reason = 'Leave combat and let your allegiance settle.';
    if (!reason && this.type === 0 && this.distance < 6.3) reason = 'Choose 7 or 9 metres for a shelter.';
    if (!reason && salvage < cost) reason = 'Extract xenolite or chart another city to earn more salvage.';
    if (!reason && Math.abs(y - planned.site.y) > 3) reason = 'Reach the site on foot first.';
    this.preview(planned.site.y ? planned.site : null, !reason);
    this.element.querySelector('.camp-wallet')!.textContent = `${salvage} SALVAGE · ${this.state.sites.filter(s => s.owner === id).length} MODULES NEARBY`;
    this.element.querySelector('.camp-reason')!.textContent = reason ?? 'Site clear. A permanent module will be placed here.';
    this.place.textContent = this.pending ? 'BUILDING…' : `BUILD · ${cost} SALVAGE`; this.place.disabled = !!reason || this.pending;
    const nearby = this.state.sites.filter(s => s.owner === id && Math.hypot(s.x - x, s.y - y, s.z - z) < 10), key = nearby.map(s => s.id).join(',');
    if (key !== this.nearbyKey) {
      this.nearbyKey = key; const list = this.element.querySelector('.camp-owned')!; list.replaceChildren();
      for (const s of nearby) {
        const b = document.createElement('button'); b.textContent = `Pack ${OUTPOST_TYPES[s.type].name} · no refund`; b.dataset.pack = String(s.id);
        b.onclick = () => { if (this.pending) return; this.pending = true; this.notice.textContent = 'Packing…'; this.send({ action: 'remove', id: s.id }); };
        list.append(b);
      }
    }
  }
}
