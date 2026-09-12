import { BTN, VEHICLE } from '@shared/index';

interface TouchInput {
  setTouchMode(enabled: boolean): void;
  setTouchButton(button: number, pressed: boolean): void;
  addTouchLook(dx: number, dy: number): void;
  releaseTouchControls(): void;
  cycleWeapon(direction?: number): void;
}

/** Shared movement bits preserve the same authoritative simulation on phones. */
export function touchMoveBits(x: number, y: number): number {
  if (!Number.isFinite(x + y)) return 0;
  let bits = 0;
  if (x < -0.22) bits |= BTN.LEFT;
  if (x > 0.22) bits |= BTN.RIGHT;
  if (y < -0.22) bits |= BTN.FORWARD;
  if (y > 0.22) bits |= BTN.BACK;
  return bits;
}

/** Pointer events support independent movement, aiming and held fire fingers. */
export class TouchControls {
  readonly element = document.createElement('div');
  active = false;
  private vehicle = -1;
  private seat = 0;
  private swimming = false;
  private underground = false;
  private worldGuide = false;
  private moveBits = 0;
  private readonly held = new Map<number, number>();
  private readonly cleanup: (() => void)[] = [];
  private readonly abort = new AbortController();
  private readonly stick: HTMLElement;
  private readonly knob: HTMLElement;

  constructor(private readonly input: TouchInput, private readonly onActiveChange: () => void) {
    input.setTouchMode(true);
    document.documentElement.classList.add('touch-device');
    this.element.id = 'touch-controls';
    this.element.innerHTML = `
      <button id="touch-start" type="button">TAP TO PLAY</button>
      <div class="touch-game">
        <div id="touch-look" aria-label="Drag to look"></div>
        <div id="touch-stick" aria-label="Movement joystick"><span></span><i>MOVE</i></div>
        <div id="touch-actions">
          <button data-action="use">ENTER</button><button data-action="reload">RELOAD</button>
          <button data-action="next" aria-label="Next carried weapon">WEAPON</button><button data-action="jump">JUMP</button>
          <button data-action="dodge">DODGE</button><button data-action="brake" hidden>BRAKE</button>
          <button data-action="alt">ALT</button><button data-action="fire" class="touch-fire">FIRE</button>
        </div>
        <button id="touch-pause" type="button">PAUSE</button>
        <div id="touch-orient">Rotate for a wider view</div>
      </div>`;
    document.body.append(this.element);
    this.stick = this.element.querySelector('#touch-stick')!;
    this.knob = this.stick.querySelector('span')!;
    const listen = <K extends keyof HTMLElementEventMap>(el: HTMLElement, type: K,
      fn: (event: HTMLElementEventMap[K]) => void) => el.addEventListener(type, fn, { signal: this.abort.signal });
    listen(this.element, 'contextmenu', e => e.preventDefault());
    listen(this.element.querySelector('#touch-start')!, 'click', () => this.setActive(true));
    listen(this.element.querySelector('#touch-pause')!, 'click', () => this.setActive(false));

    let moveId: number | null = null;
    const move = (e: PointerEvent) => {
      const rect = this.stick.getBoundingClientRect();
      let x = (e.clientX - rect.left - rect.width / 2) / (rect.width * 0.36);
      let y = (e.clientY - rect.top - rect.height / 2) / (rect.height * 0.36);
      const length = Math.max(1, Math.hypot(x, y)); x /= length; y /= length;
      this.knob.style.transform = `translate(${x * 34}px, ${y * 34}px)`;
      this.setMove(touchMoveBits(x, y));
    };
    listen(this.stick, 'pointerdown', e => {
      if (!this.active || moveId !== null) return;
      e.preventDefault(); moveId = e.pointerId; this.stick.setPointerCapture(e.pointerId); move(e);
    });
    listen(this.stick, 'pointermove', e => { if (e.pointerId === moveId) move(e); });
    const releaseMove = (e: PointerEvent) => {
      if (e.pointerId !== moveId) return;
      moveId = null; this.setMove(0); this.knob.style.transform = '';
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) listen(this.stick, type, releaseMove);
    this.cleanup.push(() => { moveId = null; this.setMove(0); this.knob.style.transform = ''; });

    const bindLook = (el: HTMLElement, fire = false) => {
      let id: number | null = null, x = 0, y = 0;
      listen(el, 'pointerdown', e => {
        if (!this.active || id !== null) return;
        e.preventDefault(); id = e.pointerId; x = e.clientX; y = e.clientY;
        el.setPointerCapture(e.pointerId);
        if (fire) { this.hold(id, BTN.FIRE); el.classList.add('pressed'); }
      });
      listen(el, 'pointermove', e => {
        if (id !== e.pointerId) return;
        this.input.addTouchLook(e.clientX - x, e.clientY - y); x = e.clientX; y = e.clientY;
      });
      const end = (e: PointerEvent) => {
        if (e.pointerId !== id) return;
        this.release(id); id = null; el.classList.remove('pressed');
      };
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) listen(el, type, end);
      this.cleanup.push(() => { id = null; el.classList.remove('pressed'); });
    };
    bindLook(this.element.querySelector('#touch-look')!);
    bindLook(this.element.querySelector('[data-action="fire"]')!, true);
    for (const el of this.element.querySelectorAll<HTMLButtonElement>('[data-action]')) {
      if (el.dataset.action === 'fire') continue;
      listen(el, 'pointerdown', e => {
        if (!this.active) return;
        e.preventDefault(); el.setPointerCapture(e.pointerId); el.classList.add('pressed');
        if (el.dataset.action === 'next') this.input.cycleWeapon();
        else this.hold(e.pointerId, this.actionBit(el.dataset.action!));
      });
      const end = (e: PointerEvent) => { this.release(e.pointerId); el.classList.remove('pressed'); };
      for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) listen(el, type, end);
    }
    window.addEventListener('blur', () => this.setActive(false), { signal: this.abort.signal });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.setActive(false);
    }, { signal: this.abort.signal });
    window.addEventListener('resize', () => this.releaseAll(), { signal: this.abort.signal });
    this.setVehicle(VEHICLE.NONE);
  }

  setActive(active: boolean): void {
    this.active = active; this.releaseAll();
    this.element.classList.toggle('active', active);
    this.onActiveChange();
  }

  setVehicle(vehicle: number, seat=0): void {
    if (vehicle === this.vehicle && seat===this.seat) return;
    this.vehicle = vehicle; this.seat=seat; this.releaseAll();
    const jet = vehicle === VEHICLE.JET;
    const button = (action: string) => this.element.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
    this.updateUseLabel();
    button('jump').textContent = jet ? 'THRUST' : 'JUMP';
    button('jump').hidden = seat!==0 || vehicle !== VEHICLE.NONE && !jet;
    button('brake').hidden = seat!==0 || !jet;
    button('brake').textContent = 'BRAKE';
    button('dodge').hidden = vehicle !== VEHICLE.NONE;
    button('reload').hidden = vehicle !== VEHICLE.NONE;
    button('next').hidden = vehicle !== VEHICLE.NONE;
    button('alt').textContent = jet ? 'BOMBS' : vehicle === VEHICLE.JEEP ? 'BOOST' : 'ALT';
    button('alt').hidden=seat!==0;
    this.stick.style.visibility=seat!==0?'hidden':'';
    this.stick.querySelector('i')!.textContent = jet ? 'PITCH / ROLL' : vehicle ? 'DRIVE' : 'MOVE';
    this.updateSwimmingButtons();
  }

  setSwimming(swimming: boolean): void {
    if (this.swimming === swimming) return;
    this.swimming = swimming; this.updateSwimmingButtons();
  }
  private updateSwimmingButtons(): void {
    if (this.vehicle !== VEHICLE.NONE) return;
    const button = (action: string) => this.element.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)!;
    button('jump').textContent = this.swimming ? 'UP' : 'JUMP';
    button('brake').textContent = 'DIVE'; button('brake').hidden = !this.swimming;
    button('dodge').hidden = this.swimming;
    if (!this.swimming) this.input.setTouchButton(BTN.BRAKE, false);
  }

  setUnderground(underground: boolean): void {
    if (underground === this.underground) return;
    this.underground = underground;
    this.updateOrientationHint();
    this.updateUseLabel();
  }

  setWorldGuide(visible: boolean): void {
    if (visible === this.worldGuide) return;
    this.worldGuide = visible; this.updateOrientationHint();
  }

  private updateOrientationHint(): void {
    this.element.querySelector<HTMLElement>('#touch-orient')!.style.visibility = this.underground || this.worldGuide ? 'hidden' : '';
  }

  private updateUseLabel(): void {
    const button = this.element.querySelector<HTMLButtonElement>('[data-action="use"]')!;
    const recall = this.vehicle === VEHICLE.NONE && this.underground;
    const label = this.vehicle !== VEHICLE.NONE ? 'EXIT' : recall ? 'RECALL' : 'ENTER';
    button.textContent = label;
    button.setAttribute('aria-label', recall ? 'Hold four seconds to recall to the surface' : label);
  }

  private actionBit(action: string): number {
    return ({ use: BTN.USE, reload: BTN.RELOAD, jump: this.vehicle === VEHICLE.JET ? BTN.THROTTLE : BTN.JUMP,
      dodge: BTN.DODGE, brake: BTN.BRAKE, alt: BTN.ALTFIRE } as Record<string, number>)[action] ?? 0;
  }

  private setMove(bits: number): void {
    this.input.setTouchButton(this.moveBits & ~bits, false);
    this.input.setTouchButton(bits, true); this.moveBits = bits;
  }
  private hold(id: number, bits: number): void { this.held.set(id, bits); this.input.setTouchButton(bits, true); }
  private release(id: number): void {
    const bits = this.held.get(id) ?? 0; this.held.delete(id);
    let remaining = this.moveBits;
    for (const value of this.held.values()) remaining |= value;
    this.input.setTouchButton(bits & ~remaining, false);
  }
  private releaseAll(): void {
    this.held.clear(); for (const fn of this.cleanup) fn();
    this.input.releaseTouchControls();
    for (const el of this.element.querySelectorAll('.pressed')) el.classList.remove('pressed');
  }
  dispose(): void {
    this.releaseAll(); this.abort.abort(); this.input.setTouchMode(false);
    this.element.remove(); document.documentElement.classList.remove('touch-device');
  }
}
