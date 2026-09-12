import {
  BTN, VEHICLE, clamp, wrapAngle,
  quantYaw, unquantYaw, quantPitch, unquantPitch,
  WEAPONS, type InputCmd,
  multiplyRotations, rotateVector, rotationFromEuler, vehicleQuaternion, type Rotation,
} from '@shared/index';
import { CREW_CONE_HALF_ANGLE } from '@shared/crew';

// Keyboard/mouse -> InputCmds. View angles are quantized through the wire
// format BEFORE the local simulation uses them, so predicted movement is
// computed with exactly the values the server will see.

const DOUBLE_TAP_MS = 280;
const MOVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD'] as const;
// One animation frame may emit up to eight fixed-tick commands while catching
// up. Pulse a quick reload tap across that entire burst so bounded downstream
// queues cannot discard its only true sample.
const RELOAD_PULSE_COMMANDS = 8;

export class InputTracker {
  yaw = 0;
  pitch = 0;
  sensitivity = 0.0022;
  weapon = 0;

  private keys = new Set<string>();
  /** Per-slot selectability (unfound cave weapons are skipped/ignored). */
  private weaponAvailable: boolean[] = [];
  private fireHeld = false;
  private altHeld = false;
  /** Preserve a press/release between fixed ticks without extending a hold. */
  private mouseFireQueued = 0;
  private touchFireQueued = 0;
  private dodgeQueued = false;
  private reloadPulse = 0;
  private usePulse = 0;
  private lastTapAt = new Map<string, number>();
  private locked = false;
  private touchButtons = 0;
  private touchMode = false;
  private suspended = false;
  private vehicleMode: number = VEHICLE.NONE;
  private vehicleSeat = 0;
  private jetLookYaw = 0;
  private jetLookPitch = 0;
  private readonly jetRotation: Rotation = { x: 0, y: 0, z: 0, w: 1 };
  /** World camera orientation while flying, including the local free look. */
  readonly viewRotation: Rotation = { x: 0, y: 0, z: 0, w: 1 };

  /** Accumulated mouse motion since last frame (viewmodel sway). */
  swayX = 0;
  swayY = 0;

  /** Refresh which weapon slots respond to keys/scroll. */
  setWeaponAvailability(mask: boolean[]): void {
    this.weaponAvailable = mask;
  }

  onPointerLockChange: ((locked: boolean) => void) | null = null;
  onToggleScores: ((show: boolean) => void) | null = null;
  onToggleDebug: (() => void) | null = null;
  onToggleMap: (() => void) | null = null;
  onHyperToggle: ((on: boolean) => void) | null = null;
  /** Return true when a nearby interaction consumes USE (for example airlift UI). */
  onUse: (() => boolean) | null = null;
  /** Playtest hyperspeed; persists across pointer-lock releases. */
  hyper = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const savedSens = localStorage.getItem('mmofps-sens');
    if (savedSens) this.sensitivity = clamp(Number(savedSens) || 0.0022, 0.0004, 0.01);

    canvas.addEventListener('click', () => {
      if (this.suspended) return;
      // Focus changes can overtake a queued pointerlockchange during a slow
      // frame. Read the browser's actual lock before deciding to reacquire.
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked && !this.touchMode && canvas.requestPointerLock) {
        try { void Promise.resolve(canvas.requestPointerLock()).catch(() => {
          this.locked = document.pointerLockElement === canvas;
          this.onPointerLockChange?.(this.locked);
        }); } catch { this.onPointerLockChange?.(false); }
      }
      this.onPointerLockChange?.(this.locked);
    });
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === canvas;
      if (!this.locked) this.releaseAll();
      this.onPointerLockChange?.(this.locked);
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || this.suspended) return;
      this.addTouchLook(e.movementX, e.movementY);

    });

    document.addEventListener('mousedown', (e) => {
      if (this.suspended) return;
      if (this.locked && e.button === 0) {
        if (!this.fireHeld) this.mouseFireQueued |= BTN.FIRE;
        this.fireHeld = true;
      }
      if (this.locked && e.button === 2) {
        if (!this.altHeld) this.mouseFireQueued |= BTN.ALTFIRE;
        this.altHeld = true;
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.fireHeld = false;
      if (e.button === 2) this.altHeld = false;
    });
    document.addEventListener('contextmenu', (e) => {
      if (this.locked) e.preventDefault();
    });
    document.addEventListener('wheel', (e) => {
      if (!this.locked || this.suspended) return;
      const dir = e.deltaY > 0 ? 1 : -1;
      this.cycleWeapon(dir);
    });

    document.addEventListener('keydown', (e) => {
      const target = e.target as HTMLElement | null;
      if (this.suspended || target?.matches?.('input,textarea,[contenteditable="true"]')) return;
      if (e.code === 'KeyM') { if (!e.repeat) this.onToggleMap?.(); e.preventDefault(); return; }
      if (e.code === 'Tab') {
        e.preventDefault();
        this.onToggleScores?.(true);
        return;
      }
      if (e.code === 'F3') {
        e.preventDefault();
        this.onToggleDebug?.();
        return;
      }
      if (!this.locked) return;
      if (e.repeat) return;

      if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
        const f = e.code === 'BracketLeft' ? 1 / 1.15 : 1.15;
        this.sensitivity = clamp(this.sensitivity * f, 0.0004, 0.01);
        localStorage.setItem('mmofps-sens', String(this.sensitivity));
        return;
      }
      if (e.code === 'KeyR') {
        // Keep the held state in every command so a bounded server input queue
        // cannot discard the only reload edge during a catch-up burst. The
        // latch additionally preserves taps shorter than one simulation tick.
        this.keys.add(e.code);
        this.reloadPulse = RELOAD_PULSE_COMMANDS;
        return;
      }
      if (e.code === 'KeyE') {
        if(this.onUse?.())return;
        // Enter/exit vehicle: same burst-latch treatment as reload so the
        // single press edge always reaches the server.
        this.keys.add(e.code);
        this.usePulse = RELOAD_PULSE_COMMANDS;
        return;
      }
      if (e.code === 'KeyH' && new URLSearchParams(location.search).get('spectate')) {
        // Playtest hyperspeed toggle (~10x run speed on foot).
        this.hyper = !this.hyper;
        this.onHyperToggle?.(this.hyper);
        return;
      }
      if (e.code.startsWith('Digit')) {
        const digit = Number(e.code.slice(5));
        const n = digit === 0 ? 9 : digit - 1;
        if (n >= 0 && n < WEAPONS.length && (this.weaponAvailable[n] ?? true)) {
          this.weapon = n;
        }
        return;
      }

      this.keys.add(e.code);
      if ((MOVE_KEYS as readonly string[]).includes(e.code)) {
        const now = performance.now();
        const last = this.lastTapAt.get(e.code) ?? -1e9;
        if (now - last < DOUBLE_TAP_MS) this.dodgeQueued = true;
        this.lastTapAt.set(e.code, now);
      }
    });
    document.addEventListener('keyup', (e) => this.keys.delete(e.code));

    // Leaving the tab: release everything.
    window.addEventListener('blur', () => {
      this.releaseAll(); this.locked = false; this.onPointerLockChange?.(false);
    });
    window.addEventListener('focus', () => {
      this.locked = document.pointerLockElement === canvas;
      this.onPointerLockChange?.(this.locked);
    });
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.releaseAll(); });
  }

  cycleWeapon(direction = 1): void {
    if (this.suspended) return;
    const step = direction < 0 ? -1 : 1;
    let weapon = this.weapon;
    for (let i = 0; i < WEAPONS.length; i++) {
      weapon = (weapon + step + WEAPONS.length) % WEAPONS.length;
      if (this.weaponAvailable[weapon] ?? true) { this.weapon = weapon; return; }
    }
  }

  /** Touch and keyboard share the same command bits; touch needs no pointer lock. */
  setTouchMode(enabled: boolean): void {
    this.touchMode = enabled;
    if (!enabled) this.releaseTouchControls();
  }

  get hasTouchInput(): boolean { return this.touchMode || this.touchButtons !== 0; }
  /** Physical hold for cave recall UI; a released tap's network latch is not a hold. */
  get using(): boolean { return this.keys.has('KeyE') || (this.touchButtons & BTN.USE) !== 0; }
  get firing(): boolean { return this.fireHeld || this.altHeld || (this.touchButtons & (BTN.FIRE | BTN.ALTFIRE)) !== 0; }

  setTouchButton(button: number, pressed: boolean): void {
    if (this.suspended) return;
    if(pressed&&(button&BTN.USE)&&!(this.touchButtons&BTN.USE)&&this.onUse?.())button&=~BTN.USE;
    if (pressed) {
      this.touchFireQueued |= button & ~this.touchButtons & (BTN.FIRE | BTN.ALTFIRE);
      this.touchButtons |= button;
      if (button & BTN.RELOAD) this.reloadPulse = RELOAD_PULSE_COMMANDS;
      if (button & BTN.USE) this.usePulse = RELOAD_PULSE_COMMANDS;
    } else this.touchButtons &= ~button;
  }

  releaseTouchControls(): void {
    this.touchButtons = 0;
    this.touchFireQueued = 0;
    this.reloadPulse = 0;
    this.usePulse = 0;
  }

  addTouchLook(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    if (this.vehicleMode === VEHICLE.JET) {
      this.jetLookYaw = wrapAngle(this.jetLookYaw - dx * this.sensitivity);
      this.jetLookPitch = clamp(this.jetLookPitch - dy * this.sensitivity, -1.55, 1.55);
      if(this.vehicleSeat===1) {
        const length=Math.hypot(this.jetLookYaw,this.jetLookPitch);
        if(length>CREW_CONE_HALF_ANGLE) {this.jetLookYaw*=CREW_CONE_HALF_ANGLE/length;this.jetLookPitch*=CREW_CONE_HALF_ANGLE/length;}
      }
      this.updateJetLook();
    } else {
      this.yaw = wrapAngle(this.yaw - dx * this.sensitivity);
      this.pitch = clamp(this.pitch - dy * this.sensitivity, -1.55, 1.55);
    }
    this.swayX += dx; this.swayY += dy;
  }

  setVehicleMode(type: number, heading: number, pitch = 0, roll = 0, rotation?: Rotation, seat = 0): void {
    if (type === this.vehicleMode && seat === this.vehicleSeat) return;
    this.vehicleMode = type;
    this.vehicleSeat = seat;
    if (type !== VEHICLE.NONE) {
      this.yaw = heading; this.pitch = type === VEHICLE.JET ? pitch : 0;
      this.jetLookYaw = this.jetLookPitch = 0;
      if (type === VEHICLE.JET) this.followJet(heading, pitch, roll, rotation);
    }
  }

  /** Keep a pilot's freely chosen look offset relative to the aircraft nose. */
  followJet(heading: number, pitch: number, roll = 0, rotation?: Rotation): void {
    if (this.vehicleMode !== VEHICLE.JET) return;
    Object.assign(this.jetRotation, vehicleQuaternion({ heading, vehiclePitch: pitch, vehicleRoll: roll, vehicleRotation: rotation }));
    this.updateJetLook();
  }

  private updateJetLook(): void {
    const look = rotationFromEuler(this.jetLookYaw, this.jetLookPitch);
    if(this.vehicleSeat===1) multiplyRotations(rotationFromEuler(0,-Math.PI/2),look,look);
    multiplyRotations(this.jetRotation, look, this.viewRotation);
    const forward = rotateVector(this.viewRotation, 0, 0, -1);
    // Network aim is a direction only. Keeping its pitch canonical does not
    // constrain the quaternion used by either the camera or the airframe.
    this.yaw = Math.atan2(-forward.x, -forward.z);
    this.pitch = Math.atan2(forward.y, Math.hypot(forward.x, forward.z));
  }

  get isLocked(): boolean {
    return this.locked;
  }

  /** Held controls for cosmetic engine load and steering, without consuming
   * sample()'s one-shot reload/use inputs a second time. */
  get throttle(): number {
    if(this.vehicleSeat!==0)return 0;
    if (this.vehicleMode === VEHICLE.JET) {
      const brake = this.keys.has('KeyC') || (this.touchButtons & BTN.BRAKE) !== 0;
      return brake ? -1 : Number(this.keys.has('Space') || (this.touchButtons & BTN.THROTTLE) !== 0);
    }
    return Number(this.keys.has('KeyW') || (this.touchButtons & BTN.FORWARD) !== 0) -
      Number(this.keys.has('KeyS') || (this.touchButtons & BTN.BACK) !== 0);
  }

  get steering(): number {
    if(this.vehicleSeat!==0)return 0;
    return Number(this.keys.has('KeyA') || (this.touchButtons & BTN.LEFT) !== 0) -
      Number(this.keys.has('KeyD') || (this.touchButtons & BTN.RIGHT) !== 0);
  }

  /** Consume accumulated sway (call once per frame). */
  takeSway(): { x: number; y: number } {
    const s = { x: this.swayX, y: this.swayY };
    this.swayX = 0;
    this.swayY = 0;
    return s;
  }

  sample(seq: number, renderTick: number, renderFrac: number): InputCmd {
    let buttons = this.touchButtons | this.touchFireQueued | this.mouseFireQueued;
    // A held press consumes its edge too, so releasing it after a sampled shot
    // stops immediately. A sub-tick tap produces exactly one fire command.
    this.touchFireQueued = 0;
    this.mouseFireQueued = 0;
    if (this.keys.has('KeyW')) buttons |= BTN.FORWARD;
    if (this.keys.has('KeyS')) buttons |= BTN.BACK;
    if (this.keys.has('KeyA')) buttons |= BTN.LEFT;
    if (this.keys.has('KeyD')) buttons |= BTN.RIGHT;
    if (this.keys.has('Space')) buttons |= BTN.JUMP | BTN.THROTTLE;
    if (this.keys.has('KeyC')) buttons |= BTN.BRAKE;
    if (this.fireHeld) buttons |= BTN.FIRE;
    if (this.altHeld) buttons |= BTN.ALTFIRE;
    if (this.hyper) buttons |= BTN.HYPER;
    if (this.reloadPulse > 0 || this.keys.has('KeyR')) {
      buttons |= BTN.RELOAD;
      if (this.reloadPulse > 0) this.reloadPulse--;
    }
    if (this.usePulse > 0 || this.keys.has('KeyE')) {
      buttons |= BTN.USE;
      if (this.usePulse > 0) this.usePulse--;
    }
    if (this.dodgeQueued) {
      buttons |= BTN.DODGE;
      this.dodgeQueued = false;
    }
    if(this.vehicleSeat!==0)buttons&=~(BTN.FORWARD|BTN.BACK|BTN.LEFT|BTN.RIGHT|BTN.JUMP|BTN.THROTTLE|BTN.BRAKE|BTN.DODGE|BTN.HYPER);
    return {
      seq,
      buttons: this.suspended ? 0 : buttons,
      weapon: this.weapon,
      yaw: unquantYaw(quantYaw(this.yaw)),
      pitch: unquantPitch(quantPitch(this.pitch)),
      renderTick: Math.max(0, Math.floor(renderTick)),
      renderFrac: clamp(renderFrac, 0, 1),
    };
  }

  private releaseAll(): void {
    this.keys.clear();
    this.releaseTouchControls();
    this.fireHeld = false;
    this.altHeld = false;
    this.mouseFireQueued = 0;
    this.dodgeQueued = false;
    this.reloadPulse = 0;
    this.usePulse = 0;
    this.lastTapAt.clear();
  }

  setSuspended(suspended: boolean): void {
    this.suspended = suspended; this.releaseAll(); this.onToggleScores?.(false);
  }
  resumePlay(): void {
    if (this.suspended || this.touchMode || !this.canvas.requestPointerLock) return;
    try { void Promise.resolve(this.canvas.requestPointerLock()).catch(() => this.onPointerLockChange?.(false)); }
    catch { this.onPointerLockChange?.(false); }
  }
}
