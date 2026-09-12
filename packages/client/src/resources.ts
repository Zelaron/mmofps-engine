import { RESOURCE_YIELD, type ResourceSnapshot } from '@shared/resources';

export class ResourcesUI {
  readonly element = document.createElement('section');
  private readonly button: HTMLButtonElement;
  private readonly progress: HTMLElement;
  private readonly style = document.createElement('style');
  private readonly abort = new AbortController();
  private state: ResourceSnapshot | null = null;
  private held = false;
  private lastPulse = 0;
  private receivedAt = 0;
  constructor(private readonly send: (held: boolean) => void, private readonly playing: () => boolean, private readonly touch: boolean) {
    this.element.id = 'resource-panel'; this.element.hidden = true;
    this.element.setAttribute('aria-label', 'Extract xenolite');
    this.element.innerHTML = `<small>XENOLITE SEAM <span>+${RESOURCE_YIELD} SALVAGE</span></small><button id="resource-harvest" type="button"></button><div class="resource-track"><i></i></div>`;
    this.button = this.element.querySelector('button')!; this.progress = this.element.querySelector('i')!;
    this.style.textContent = `#resource-panel{position:fixed;z-index:25;left:50%;bottom:140px;transform:translateX(-50%);width:250px;padding:12px;background:#071b19eb;border:1px solid #68d5b66e;border-radius:8px;color:#d4fff0;font-family:Barlow,sans-serif;box-shadow:0 8px 30px #0005}#resource-panel[hidden]{display:none}#resource-panel small{display:flex;justify-content:space-between;gap:12px;font-size:11px;letter-spacing:1px}#resource-panel small span{color:#7de4c7}#resource-harvest{width:100%;min-height:44px;margin:8px 0 0;border:1px solid #8aedd15c;border-radius:4px;background:#163e35;color:#e9fff6;font:600 14px Barlow,sans-serif;touch-action:none;cursor:pointer}#resource-harvest:disabled{cursor:default;color:#a1bdb2;background:#142923}#resource-panel .resource-track{height:3px;margin-top:8px;background:#426052}#resource-panel .resource-track i{display:block;height:100%;width:0;background:#8affd5;transition:width .1s linear}.touch-device #resource-panel{bottom:220px;width:215px;padding:9px}@media(max-width:600px){.touch-device #resource-panel{bottom:246px;width:200px}}`;
    this.style.textContent += '@media(min-width:601px){.touch-device #resource-panel{bottom:max(20px,env(safe-area-inset-bottom))}}';
    document.head.append(this.style); document.body.append(this.element);
    const options = { signal: this.abort.signal };
    window.addEventListener('keydown', e => {
      if (e.code !== 'KeyF' || e.repeat || (e.target as HTMLElement)?.matches('input,textarea,select,[contenteditable]')) return;
      if (this.playing() && !this.element.hidden) { e.preventDefault(); this.hold(true); }
    }, options);
    window.addEventListener('keyup', e => { if (e.code === 'KeyF') this.hold(false); }, options);
    window.addEventListener('blur', () => this.hold(false), options);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.hold(false); }, options);
    this.button.addEventListener('pointerdown', e => {
      if (this.button.disabled) return;
      e.preventDefault(); this.button.setPointerCapture(e.pointerId); this.hold(true);
    }, options);
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) this.button.addEventListener(type, () => this.hold(false), options);
  }
  private hold(held: boolean): void {
    held = held && this.playing() && !this.button.disabled && !this.element.hidden;
    if (held === this.held) return;
    this.held = held; this.lastPulse = performance.now(); this.send(held);
  }
  receive(state: ResourceSnapshot): void { this.state = state; this.receivedAt = performance.now(); }
  clear(): void { this.hold(false); this.state = null; this.element.hidden = true; }
  update(): void {
    const state = this.state, node = state?.nodes.find(n => n.id === state.target);
    this.element.hidden = !node || !this.playing() || performance.now() - this.receivedAt > 3000;
    if (this.element.hidden || !state || !node) { this.hold(false); return; }
    this.button.disabled = !state.enabled || state.saving || node.remaining > 0;
    this.button.textContent = state.saving ? 'Saving salvage…' : node.remaining > 0 ? `REGROWING · ${Math.ceil(node.remaining)}s` :
      !state.enabled ? state.reason || 'Extraction unavailable' : state.progress > 0 ? `EXTRACTING · ${Math.round(state.progress * 100)}%` : this.touch ? 'HOLD TO EXTRACT' : 'HOLD F TO EXTRACT';
    this.progress.style.width = `${state.progress * 100}%`;
    if (this.button.disabled) this.hold(false);
    if (this.held && performance.now() - this.lastPulse >= 250) { this.lastPulse = performance.now(); this.send(true); }
  }
  dispose(): void { this.hold(false); this.abort.abort(); this.element.remove(); this.style.remove(); }
}
