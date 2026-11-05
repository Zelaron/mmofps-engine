import {
  WEAPONS, PLAYER,
  PICKUP_AMMO, PICKUP_HEALTH, PICKUP_WEAPON,
  PICKUP_RESULT_COLLECTED, PICKUP_RESULT_FULL,
  type PickupResultEvent, type ScoreRow,
} from '@shared/index';

// DOM overlay HUD. All elements live in index.html; this class just drives
// them. No framework - direct DOM is plenty at this scale.

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export function formatAmmoReserve(
  reserve: number,
  infiniteReserve: boolean,
  alive: boolean,
): string {
  if (!alive) return '--';
  return infiniteReserve ? '\u221e' : String(Math.max(0, reserve));
}

function formatPickupAmount(amount: number): string {
  if (!Number.isFinite(amount)) return '0';
  const positive = Math.max(0, amount);
  // Passive regeneration can leave a player a few hundredths below full.
  // Never turn a real, authoritative gain into the misleading text "+0".
  const rounded = positive > 0
    ? Math.max(0.1, Math.round(positive * 10) / 10)
    : 0;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Safe, plain-text copy for one authoritative pickup result. */
export function formatPickupResult(ev: PickupResultEvent): string {
  const full = ev.result === PICKUP_RESULT_FULL;
  if (!full && ev.result !== PICKUP_RESULT_COLLECTED) return 'Pickup unavailable';

  if (ev.kind === PICKUP_HEALTH) {
    return full
      ? 'Health already full'
      : `+${formatPickupAmount(ev.amount)} health`;
  }

  if (ev.kind === PICKUP_AMMO) {
    const weaponName = WEAPONS[ev.weapon]?.name;
    if (full) return weaponName ? `${weaponName} ammo full` : 'Ammo full';
    const amount = formatPickupAmount(ev.amount);
    return weaponName ? `+${amount} ${weaponName} ammo` : `+${amount} ammo`;
  }

  if (ev.kind === PICKUP_WEAPON) {
    const weaponName = WEAPONS[ev.weapon]?.name ?? 'Weapon';
    return full ? `${weaponName} already loaded` : `${weaponName} acquired!`;
  }

  return full
    ? 'Resource already full'
    : `+${formatPickupAmount(ev.amount)} resource`;
}

const MAX_PICKUP_NOTICES = 4;
const PICKUP_NOTICE_HOLD_MS = 2400;
const PICKUP_NOTICE_FADE_MS = 600;

interface PickupNoticeTimer {
  fade: number;
  remove: number;
  fullKey?: string;
}

export class Hud {
  private crosshair = el('crosshair');
  private jetAim = el('jet-aim');
  private healthBar = el('health-bar');
  private healthNum = el('health-num');
  private weaponName = el('weapon-name');
  private ammoWrap = el('ammo');
  private ammoMag = el('ammo-mag');
  private ammoSep = el('ammo-sep');
  private ammoReserve = el('ammo-reserve');
  private cdTrack = el('cd-track');
  private cdBar = el('cd-bar');
  private reloadLabel = el('reload-label');
  private reloadTrack = el('reload-track');
  private reloadBar = el('reload-bar');
  private slots: HTMLElement[] = [];
  private slotsWrap = el('weapon-slots');
  private mountedWeapon = false;
  private stats = el('stats');
  private feed = el('feed');
  private pickupFeed = el('pickup-feed');
  private center = el('center-msg');
  private centerSub = el('center-sub');
  private board = el('scoreboard');
  private boardBody = el('scoreboard-body');
  private flash = el('dmg-flash');
  private nukeFlashEl = el('nuke-flash');
  private marker = el('hitmarker');
  private debugEl = el('debug');
  private announce = el('announce');

  private feedTimers: number[] = [];
  private pickupTimers = new Map<HTMLElement, PickupNoticeTimer>();
  private fullPickupLines = new Map<string, HTMLElement>();
  debugVisible = false;

  constructor() {
    for (let i = 0; i < WEAPONS.length; i++) {
      const s = document.createElement('div');
      s.className = 'slot';
      s.textContent = String((i + 1) % 10);
      s.title = WEAPONS[i].name;
      this.slotsWrap.appendChild(s);
      this.slots.push(s);
    }
  }

  setHealth(h: number, alive: boolean): void {
    const pct = Math.max(0, Math.min(100, (h / PLAYER.MAX_HEALTH) * 100));
    this.healthBar.style.width = `${pct}%`;
    this.healthBar.style.background = pct > 55 ? '#5fd068' : pct > 25 ? '#e0b640' : '#e0503c';
    this.healthNum.textContent = alive ? String(Math.ceil(h)) : '--';
  }

  setWeapon(i: number): void {
    if (this.mountedWeapon) {
      this.mountedWeapon = false;
      for (const item of [this.slotsWrap, this.ammoSep, this.ammoReserve, this.cdTrack]) item.style.display = '';
    }
    this.weaponName.textContent = WEAPONS[i]?.name ?? '';
    this.slots.forEach((s, k) => s.classList.toggle('active', k === i));
  }

  /** Override carried ammunition after the ordinary HUD update while seated. */
  setMountedWeapon(name: string, alive = true): void {
    this.mountedWeapon = true;
    this.weaponName.textContent = name;
    this.ammoMag.textContent = alive ? '\u221e' : '--';
    this.ammoWrap.classList.remove('empty');
    for (const item of [this.slotsWrap, this.ammoSep, this.ammoReserve, this.cdTrack]) item.style.display = 'none';
    this.setReload(false, 0);
  }

  /** Hide slots for found weapons the player does not currently carry. */
  setWeaponAvailability(mask: boolean[]): void {
    this.slots.forEach((s, k) => {
      s.style.display = (mask[k] ?? true) ? '' : 'none';
    });
  }

  setAmmo(
    magazine: number,
    reserve: number,
    alive: boolean,
    infiniteReserve = false,
  ): void {
    this.ammoMag.textContent = alive ? String(Math.max(0, magazine)) : '--';
    this.ammoReserve.textContent =
      formatAmmoReserve(reserve, infiniteReserve, alive);
    this.ammoWrap.classList.toggle('empty', alive && magazine <= 0);
  }

  setCooldown(frac: number): void {
    this.cdBar.style.width = `${Math.max(0, Math.min(1, 1 - frac)) * 100}%`;
  }

  setReload(active: boolean, progress: number): void {
    const p = Math.max(0, Math.min(1, progress));
    this.reloadLabel.textContent = active ? 'RELOADING' : '';
    this.reloadTrack.classList.toggle('active', active);
    this.reloadBar.style.width = `${active ? p * 100 : 0}%`;
  }

  setStats(ping: number, fps: number): void {
    this.stats.textContent = `${Math.round(ping)} ms | ${Math.round(fps)} fps`;
  }

  /** Vehicle status line; label null hides it. Boost null hides its meter. */
  /** Aircraft weapons stay on the nose while the pilot looks around. */
  setJetAim(x: number | null, y = 0, behind = false): void {
    this.crosshair.style.display = x === null ? '' : 'none';
    this.jetAim.style.display = x === null ? 'none' : 'block';
    if (x === null) return;
    const edge = behind || Math.abs(x) > 0.88 || Math.abs(y) > 0.76;
    if (behind && Math.abs(x) + Math.abs(y) < 0.05) y = -1;
    const fit = Math.min(1, 0.88 / Math.max(0.001, Math.abs(x)), 0.76 / Math.max(0.001, Math.abs(y)));
    x *= fit; y *= fit;
    if (behind) {
      const toEdge = Math.max(Math.abs(x) / 0.88, Math.abs(y) / 0.76, 0.001);
      x /= toEdge; y /= toEdge;
    }
    this.jetAim.classList.toggle('offscreen', edge);
    this.jetAim.style.transform = `translate(-50%, -50%) translate(${x * 50}vw, ${-y * 50}vh)`;
    this.jetAim.style.setProperty('--aim-angle', `${Math.atan2(-y, x)}rad`);
  }

  setVehicle(label: string | null, healthFrac: number, boostFrac: number | null): void {
    const box = this.vehicleBox();
    if (!label) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    const pct = Math.round(Math.max(0, Math.min(1, healthFrac)) * 100);
    const boost = boostFrac === null
      ? ''
      : ` · boost ${Math.round(Math.max(0, Math.min(1, boostFrac)) * 100)}%`;
    box.textContent = `${label} ${pct}%${boost}`;
    box.style.color = pct > 55 ? '#cfe3d2' : pct > 25 ? '#e0b640' : '#e0503c';
  }

  setPrompt(text: string | null): void {
    const box = this.promptBox();
    box.style.display = text ? 'block' : 'none';
    if (text) box.textContent = text;
  }

  setArtillery(remaining:number|null,inFlight:number,marker:{x:number;y:number;behind:boolean;label:string;impact:boolean}|null):void {
    const status=this.lazyBox('hud-artillery-status',
      'position:absolute;left:50%;bottom:calc(env(safe-area-inset-bottom,0px) + 150px);transform:translateX(-50%);'+
      'font:700 12px system-ui;color:#ffe6a4;text-shadow:0 1px 3px #000;pointer-events:none;');
    status.style.display=remaining===null?'none':'block';
    if(remaining!==null)status.textContent=`${remaining>0?`RELOADING ${remaining.toFixed(1)}s`:'CANNON READY'}${inFlight?` · ${inFlight} IN FLIGHT`:''}`;
    const target=this.lazyBox('hud-artillery-marker',
      'position:absolute;left:50%;top:50%;font:700 11px system-ui;color:#fff0b5;text-align:center;'+
      'padding:5px 8px;background:#151a22bb;border:1px solid #dbc28588;border-radius:4px;pointer-events:none;');
    target.style.display=marker?'block':'none';if(!marker)return;
    let x=Number.isFinite(marker.x)?marker.x:0,y=Number.isFinite(marker.y)?marker.y:0;if(marker.behind){x=-x;y=-y;}
    const scale=Math.max(1,Math.abs(x)/.82,Math.abs(y)/.70);x/=scale;y/=scale;
    target.style.transform=`translate(-50%,16px) translate(${x*50}vw,${-y*50}vh)`;
    target.textContent=`${marker.impact?'✦':'◇'} ${marker.label}${marker.behind?' · BEHIND':''}`;
  }

  setLock(text: string | null): void {
    const box = this.lockBox();
    box.style.display = text ? 'block' : 'none';
    if (text) {
      box.textContent = text;
      box.style.color = text === 'LOCKED' ? '#ff5d4d' : '#e0b640';
    }
  }

  setCaveGuide(text: string | null): void {
    const box = this.lazyBox('hud-cave-guide',
      'position:absolute;left:50%;top:calc(env(safe-area-inset-top,0px) + 58px);transform:translateX(-50%);' +
      'width:max-content;max-width:82vw;text-align:center;white-space:pre-line;font:600 12px/1.4 system-ui;color:#ffcf89;' +
      'background:rgba(14,18,22,.7);padding:7px 12px;border:1px solid #ad864955;border-radius:6px;pointer-events:none;');
    box.style.display = text ? 'block' : 'none';
    if (text && box.textContent !== text) box.textContent = text;
  }

  /** HUD extras are created lazily so index.html stays untouched. */
  private vehicleBox(): HTMLElement {
    return this.lazyBox('hud-vehicle',
      'position:absolute;left:18px;bottom:140px;font:600 15px system-ui;' +
      'color:#cfe3d2;text-shadow:0 1px 2px rgba(0,0,0,.7);pointer-events:none;');
  }

  private promptBox(): HTMLElement {
    return this.lazyBox('hud-prompt',
      'position:absolute;left:50%;bottom:26%;transform:translateX(-50%);' +
      'font:600 15px system-ui;color:#e8edf5;background:rgba(8,10,14,.55);' +
      'padding:4px 12px;border-radius:6px;pointer-events:none;');
  }

  private lockBox(): HTMLElement {
    return this.lazyBox('hud-lock',
      'position:absolute;left:50%;top:58%;transform:translateX(-50%);' +
      'font:700 16px system-ui;letter-spacing:.12em;pointer-events:none;' +
      'text-shadow:0 1px 3px rgba(0,0,0,.8);');
  }

  private lazyBox(id: string, css: string): HTMLElement {
    let box = document.getElementById(id);
    if (!box) {
      box = document.createElement('div');
      box.id = id;
      box.style.cssText = css + 'display:none;';
      document.body.appendChild(box);
    }
    return box;
  }

  addFeed(html: string, cls = ''): void {
    const line = document.createElement('div');
    line.className = `feed-line ${cls}`;
    line.innerHTML = html;
    this.feed.prepend(line);
    while (this.feed.children.length > 6) this.feed.lastChild?.remove();
    window.setTimeout(() => {
      line.classList.add('fade');
      window.setTimeout(() => line.remove(), 900);
    }, 5200);
  }

  showPickupResult(ev: PickupResultEvent): void {
    const text = formatPickupResult(ev);
    const fullKey = ev.result === PICKUP_RESULT_FULL
      ? `${ev.kind}:${ev.weapon}:${text}`
      : undefined;
    const existing = fullKey ? this.fullPickupLines.get(fullKey) : undefined;
    if (existing) {
      // A malformed/replayed packet or overlapping equivalent crates should
      // refresh one quiet "full" line, never grow an on-screen spam column.
      this.pickupFeed.prepend(existing);
      this.armPickupLine(existing, fullKey);
      return;
    }

    const line = document.createElement('div');
    line.className = `pickup-line ${
      ev.result === PICKUP_RESULT_FULL
        ? 'full'
        : ev.kind === PICKUP_HEALTH
          ? 'health'
          : ev.kind === PICKUP_AMMO
            ? 'ammo'
            : 'resource'
    }`;
    line.textContent = text;
    this.pickupFeed.prepend(line);
    this.armPickupLine(line, fullKey);

    while (this.pickupFeed.children.length > MAX_PICKUP_NOTICES) {
      const oldest = this.pickupFeed.lastElementChild;
      if (!(oldest instanceof HTMLElement)) break;
      this.removePickupLine(oldest);
    }
  }

  private armPickupLine(line: HTMLElement, fullKey?: string): void {
    const old = this.pickupTimers.get(line);
    if (old) {
      window.clearTimeout(old.fade);
      window.clearTimeout(old.remove);
      if (old.fullKey && old.fullKey !== fullKey &&
          this.fullPickupLines.get(old.fullKey) === line) {
        this.fullPickupLines.delete(old.fullKey);
      }
    }

    line.classList.remove('fade');
    const fade = window.setTimeout(() => {
      line.classList.add('fade');
    }, PICKUP_NOTICE_HOLD_MS);
    const remove = window.setTimeout(() => {
      this.removePickupLine(line);
    }, PICKUP_NOTICE_HOLD_MS + PICKUP_NOTICE_FADE_MS);
    this.pickupTimers.set(line, { fade, remove, fullKey });
    if (fullKey) this.fullPickupLines.set(fullKey, line);
  }

  private removePickupLine(line: HTMLElement): void {
    const timers = this.pickupTimers.get(line);
    if (timers) {
      window.clearTimeout(timers.fade);
      window.clearTimeout(timers.remove);
      if (timers.fullKey && this.fullPickupLines.get(timers.fullKey) === line) {
        this.fullPickupLines.delete(timers.fullKey);
      }
      this.pickupTimers.delete(line);
    }
    line.remove();
  }

  /**
   * Announcements stack as independent lines so rapid events (a double
   * kill, a multi-frag nuke) each stay visible instead of overwriting
   * one another mid-animation.
   */
  showAnnounce(text: string): void {
    const line = document.createElement('div');
    line.className = 'announce-line';
    const bounty = text.startsWith('PLANET BOUNTY:');
    if (bounty) line.classList.add('announce-bounty');
    line.textContent = text;
    this.announce.appendChild(line);
    while (this.announce.children.length > 4) {
      this.announce.firstElementChild?.remove();
    }
    window.setTimeout(() => line.remove(), bounty ? 8100 : 3300);
  }

  /** Whiteout for a nearby nuclear detonation; strength 0..1 by proximity. */
  nukeFlash(strength: number): void {
    const s = Math.max(0, Math.min(0.95, strength));
    if (s <= 0.02) return;
    this.nukeFlashEl.style.transition = 'none';
    this.nukeFlashEl.style.opacity = String(s);
    void this.nukeFlashEl.offsetWidth;
    this.nukeFlashEl.style.transition = 'opacity 1.8s ease-out';
    this.nukeFlashEl.style.opacity = '0';
  }

  showCenter(main: string, sub = ''): void {
    this.center.textContent = main;
    this.centerSub.textContent = sub;
    el('center-wrap').classList.remove('hide');
  }

  hideCenter(): void {
    el('center-wrap').classList.add('hide');
  }

  damageFlash(): void {
    this.flash.classList.remove('on');
    void this.flash.offsetWidth;
    this.flash.classList.add('on');
  }

  hitmarker(kill: boolean): void {
    this.marker.classList.remove('on', 'kill');
    void this.marker.offsetWidth;
    this.marker.classList.add('on');
    if (kill) this.marker.classList.add('kill');
  }

  setScores(rows: ScoreRow[], names: Map<number, string>, myId: number): void {
    const html = rows
      .map((r) => {
        const me = r.id === myId ? ' class="me"' : '';
        const name = escapeHtml(names.get(r.id) ?? `#${r.id}`);
        return `<tr${me}><td>${name}</td><td>${r.frags}</td><td>${r.deaths}</td><td>${r.ping}</td></tr>`;
      })
      .join('');
    this.boardBody.innerHTML = html;
  }

  showScores(show: boolean): void {
    this.board.style.display = show ? 'block' : 'none';
  }

  toggleDebug(): void {
    this.debugVisible = !this.debugVisible;
    this.debugEl.style.display = this.debugVisible ? 'block' : 'none';
  }

  setDebug(text: string): void {
    if (this.debugVisible) this.debugEl.textContent = text;
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
