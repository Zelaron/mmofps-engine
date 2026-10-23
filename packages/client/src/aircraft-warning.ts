import { wrapAngle, type AircraftThreat } from '@shared/index';

export interface AircraftWarningView {
  title: string;
  detail: string;
  instruction: string;
  rotation: number;
  pan: number;
}

/** Clock positions are relative to the airframe, independent of free look. */
export function aircraftWarningView(threat: AircraftThreat, heading: number): AircraftWarningView {
  const relative = wrapAngle(threat.bearing - heading);
  const clock = ((Math.round(-relative * 6 / Math.PI) + 12) % 12) || 12;
  const side = clock === 12 ? 'AHEAD' : clock === 6 ? 'BEHIND' : clock < 6 ? 'RIGHT' : 'LEFT';
  return {
    title: threat.stage === 3 ? 'MISSILE INCOMING' : threat.stage === 2 ? 'ENEMY MISSILE LOCK' : 'RADAR TRACKING YOU',
    detail: `${clock} O'CLOCK · ${side}${threat.stage === 3 ? ` · ${threat.eta < 1 ? 'IMPACT IMMINENT' : `~${Math.ceil(threat.eta)}s TO IMPACT`}` : ''}`,
    instruction: threat.stage === 3 ? 'BANK + PULL UP TO BREAK THE SEEKER'
      : threat.stage === 2 ? 'BREAK TURN OR GET BEHIND TERRAIN' : 'TURN AWAY FROM THE LAUNCHER',
    rotation: -relative * 180 / Math.PI,
    pan: -Math.sin(relative) * .7,
  };
}

/** Warning tones repeat at a bounded rate; an escalating threat sounds now. */
export class AircraftWarningCadence {
  private stage = 0;
  private nextAt = 0;
  pulse(threat: AircraftThreat | undefined, now: number): boolean {
    if (!threat) { this.stage = 0; this.nextAt = 0; return false; }
    const rising = threat.stage > this.stage;
    this.stage = threat.stage;
    if (!rising && now < this.nextAt) return false;
    this.nextAt = now + (threat.stage === 3 ? (threat.eta < 1.5 ? .30 : .43) : threat.stage === 2 ? .7 : 1.4);
    return true;
  }
}

export class AircraftWarning {
  private readonly panel: HTMLDivElement;
  private readonly title: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly instruction: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly cadence = new AircraftWarningCadence();
  constructor(private readonly sound: (stage: 1 | 2 | 3, pan: number) => void) {
    const style = document.createElement('style');
    style.textContent = `
      #aircraft-warning { position:fixed; top:clamp(94px,18vh,170px); left:50%; transform:translateX(-50%); z-index:31;
        display:flex; align-items:center; gap:13px; padding:12px 19px; width:max-content; max-width:calc(100vw - 32px);
        box-sizing:border-box; color:#ffe399; background:linear-gradient(100deg,#291905f0,#151a20f5);
        border:1px solid #d79a47; border-left:4px solid #ffc867; box-shadow:0 8px 35px #0008,0 0 24px #e58f1124;
        font:700 12px/1.45 system-ui; pointer-events:none; text-shadow:0 1px 3px #000; }
      #aircraft-warning[hidden] { display:none; }
      #aircraft-warning strong { display:block; font-size:clamp(15px,2.2vw,22px); letter-spacing:.09em; }
      #aircraft-warning small { display:block; font-size:10px; letter-spacing:.045em; color:#e6dbce; margin-top:4px; }
      #aircraft-warning .threat-bearing { width:35px; height:35px; border:1px solid currentColor; border-radius:50%;
        display:grid; place-items:center; flex-shrink:0; font-size:25px; }
      #aircraft-warning[data-stage="2"] { color:#ffba65; border-color:#f49137; }
      #aircraft-warning[data-stage="3"] { color:#fff2ec; border-color:#ff5f49; border-left-color:#ff6c56;
        background:linear-gradient(100deg,#601609f5,#28181cf5); animation:air-threat-pulse .65s ease-in-out infinite; }
      @keyframes air-threat-pulse { 50% { box-shadow:0 8px 35px #0008,0 0 26px #ff533e90; border-color:#ffd5bd; } }
      @media (max-height:500px) and (orientation:landscape) { #aircraft-warning { top:6px; padding:7px 12px; gap:9px; } #aircraft-warning strong { font-size:15px; } }
      @media (max-width:650px) and (orientation:portrait) { #aircraft-warning { top:180px; } }
      @media (prefers-reduced-motion:reduce) { #aircraft-warning { animation:none!important; } }
    `;
    document.head.appendChild(style);
    this.panel = document.createElement('div');
    this.panel.id = 'aircraft-warning'; this.panel.hidden = true;
    this.panel.setAttribute('role', 'alert');
    this.panel.innerHTML = `<span class="threat-bearing" aria-hidden="true">▲</span><div><strong></strong><div class="threat-detail" aria-live="off"></div><small></small></div>`;
    this.arrow = this.panel.querySelector('.threat-bearing')!;
    this.title = this.panel.querySelector('strong')!;
    this.detail = this.panel.querySelector('.threat-detail')!;
    this.instruction = this.panel.querySelector('small')!;
    document.body.appendChild(this.panel);
  }
  update(threat: AircraftThreat | undefined, heading: number, visible: boolean, now: number): void {
    const active = visible ? threat : undefined;
    this.panel.hidden = !active;
    if (!active) { this.cadence.pulse(undefined, now); return; }
    const view = aircraftWarningView(active, heading);
    this.panel.dataset.stage = String(active.stage);
    if (this.title.textContent !== view.title) this.title.textContent = view.title;
    if (this.detail.textContent !== view.detail) this.detail.textContent = view.detail;
    if (this.instruction.textContent !== view.instruction) this.instruction.textContent = view.instruction;
    this.arrow.style.transform = `rotate(${view.rotation}deg)`;
    if (this.cadence.pulse(active, now)) this.sound(active.stage, view.pan);
  }
}
