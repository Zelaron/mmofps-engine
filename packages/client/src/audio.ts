// Layered synthesized sound effects via WebAudio - zero downloaded audio assets.
// Positional cues: stereo pan + distance attenuation.

import { VEHICLE, VEHICLE_VARIANT } from '@shared/index';
import { combustionSamples, VehicleEngineVoice, type VehicleAudioInput } from './vehicle-audio.js';
import { CityLiftVoice, type LiftSound } from './city-lift-audio.js';

export class AudioFX {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private nextLanceImpact = 0;
  private eng: VehicleEngineVoice | null = null;
  private liftVoice:CityLiftVoice|null=null;
  private readonly combustionBuffers = new Map<number, AudioBuffer>();

  /** Cockpit radar warning; never creates or resumes an audio context. */
  aircraftWarning(stage: 1 | 2 | 3, pan = 0): void {
    if (this.ctx?.state !== 'running') return;
    if (stage === 3) {
      this.tone(1450, 900, .115, 'square', pan, .16);
      this.tone(900, 1450, .10, 'square', pan, .14, .13);
    } else if (stage === 2) {
      this.tone(1050, 1050, .12, 'triangle', pan, .23);
      this.tone(1300, 1300, .09, 'triangle', pan, .2, .15);
    } else this.tone(750, 920, .10, 'sine', pan, .22);
  }

  /** Brief alert calls; callers trigger once on an alert transition. */
  creatureAlert(species: number, pan = 0, gain = 1): void {
    if (species === 3) {
      for (let i = 0; i < 2; i++) this.tone(950 + i * 220, 1750 - i * 250, .12,
        'sine', pan, .12 * gain, i * .15);
    } else if (species === 4) {
      this.noise(.24, 330, 'bandpass', pan, .24 * gain, 130);
      this.tone(135, 68, .22, 'triangle', pan, .16 * gain);
    } else if (species === 5) {
      this.tone(680, 1120, .09, 'sine', pan, .08 * gain);
      this.tone(1140, 790, .12, 'sine', pan, .06 * gain, .12);
    } else if (species === 2) {
      for (let i = 0; i < 3; i++) {
        this.tone(1550 - i * 145, 700 - i * 60, .065, 'triangle', pan, .13 * gain, i * .085);
        this.noise(.045, 3100, 'bandpass', pan, .17 * gain, 1200, i * .085);
      }
    } else if (species === 1) {
      this.tone(110, 62, .38, 'sawtooth', pan, .18 * gain);
      this.tone(165, 95, .24, 'triangle', pan, .1 * gain, .055);
      this.noise(.33, 470, 'bandpass', pan, .29 * gain, 210);
    } else {
      this.noise(.17, 720, 'lowpass', pan, .23 * gain, 170);
      this.tone(280, 155, .14, 'triangle', pan, .11 * gain);
    }
  }

  /** Must be called from a user gesture (click) to satisfy autoplay policy. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.42;
    this.master.connect(this.ctx.destination);

    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  }

  private out(pan: number, gain: number): { node: AudioNode; t0: number; release: () => void } | null {
    if (!this.ctx || !this.master) return null;
    const p = this.ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(p);
    p.connect(this.master);
    return { node: g, t0: this.ctx.currentTime, release: () => { g.disconnect(); p.disconnect(); } };
  }

  private noise(dur: number, filterHz: number, type: BiquadFilterType, pan: number, gain: number, slideTo?: number, delay = 0): void {
    if (!this.ctx || !this.noiseBuf) return;
    const o = this.out(pan, gain);
    if (!o) return;
    const start = o.t0 + Math.max(0, delay);
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(filterHz, start);
    if (slideTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), start + dur);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(1, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + dur);
    src.connect(f); f.connect(env); env.connect(o.node);
    src.onended = () => { src.disconnect(); f.disconnect(); env.disconnect(); o.release(); };
    src.start(start);
    src.stop(start + dur + 0.02);
  }

  private tone(
    freq: number,
    freqEnd: number,
    dur: number,
    type: OscillatorType,
    pan: number,
    gain: number,
    delay = 0,
  ): void {
    if (!this.ctx) return;
    const o = this.out(pan, gain);
    if (!o) return;
    const start = o.t0 + Math.max(0, delay);
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), start + dur);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(1, start);
    env.gain.exponentialRampToValueAtTime(0.001, start + dur);
    osc.connect(env); env.connect(o.node);
    osc.onended = () => { osc.disconnect(); env.disconnect(); o.release(); };
    osc.start(start);
    osc.stop(start + dur + 0.02);
  }

  fire(weapon: number, pan = 0, gain = 1): void {
    switch (weapon) {
      case 0:
        // Compact metallic crack, intentionally unlike the old pulse burst.
        this.noise(0.095, 2100, 'highpass', pan, 0.6 * gain);
        this.tone(760, 230, 0.065, 'triangle', pan, 0.28 * gain);
        this.tone(190, 95, 0.045, 'square', pan, 0.12 * gain);
        break;
      case 1:
        // Original Pulse Rifle report: short enough to stay crisp at 9.5 Hz.
        this.noise(0.07, 1600, 'highpass', pan, 0.5 * gain);
        this.tone(420, 160, 0.05, 'square', pan, 0.25 * gain);
        break;
      case 2:
        this.noise(0.16, 900, 'lowpass', pan, 0.9 * gain);
        this.tone(180, 60, 0.12, 'square', pan, 0.3 * gain);
        break;
      case 3:
        this.noise(0.3, 500, 'bandpass', pan, 0.7 * gain, 120);
        this.tone(140, 60, 0.25, 'sawtooth', pan, 0.3 * gain);
        break;
      case 4:
        // Heavy breech thunk, propellant pop, then a short mechanical clack.
        this.noise(0.18, 650, 'lowpass', pan, 0.7 * gain, 150);
        this.tone(190, 68, 0.14, 'square', pan, 0.34 * gain);
        this.tone(760, 420, 0.045, 'triangle', pan, 0.16 * gain);
        break;
      case 5:
        // Railgun: capacitor snap, supersonic crack, long falling whine.
        this.noise(0.08, 3200, 'highpass', pan, 0.7 * gain);
        this.tone(1800, 220, 0.28, 'sawtooth', pan, 0.22 * gain);
        this.tone(2600, 900, 0.12, 'sine', pan, 0.18 * gain);
        this.tone(140, 55, 0.18, 'square', pan, 0.3 * gain);
        break;
      case 6:
        // Nuke designator: dull thunk plus an ominous confirm beep pair.
        this.noise(0.09, 700, 'lowpass', pan, 0.4 * gain);
        this.tone(160, 90, 0.1, 'square', pan, 0.25 * gain);
        this.tone(880, 880, 0.09, 'sine', pan, 0.2 * gain, 0.16);
        this.tone(1175, 1175, 0.14, 'sine', pan, 0.22 * gain, 0.3);
        break;
      case 7:
        // One crisp report per authoritative burst round, never fake echoes.
        this.noise(.055, 2850, 'highpass', pan, .5 * gain);
        this.tone(320, 125, .055, 'triangle', pan, .28 * gain);
        this.tone(1100, 720, .025, 'square', pan, .07 * gain, .02);
        break;
      case 8:
        // Compressed-gas dart salvo with a fast cassette clack.
        this.noise(.095, 1850, 'bandpass', pan, .58 * gain, 900);
        this.tone(205, 74, .09, 'square', pan, .24 * gain);
        this.noise(.025, 3600, 'highpass', pan, .18 * gain, undefined, .035);
        break;
      case 9:
        // Glassy excitation, a descending plasma pulse, and crystal ringing.
        this.tone(1470, 490, .22, 'triangle', pan, .24 * gain);
        this.tone(480, 120, .19, 'sine', pan, .3 * gain);
        this.tone(2210, 1640, .15, 'sine', pan, .11 * gain, .035);
        this.noise(.055, 2800, 'bandpass', pan, .19 * gain, 1250);
        break;
      case 200:
        // Belt-fed .50: pressure crack, chesty report and reciprocating bolt.
        this.noise(0.028, 2400, 'highpass', pan, 0.5 * gain);
        this.noise(0.13, 880, 'lowpass', pan, 0.54 * gain, 240);
        this.tone(122, 52, 0.095, 'sine', pan, 0.38 * gain);
        this.noise(0.026, 1450, 'bandpass', pan, 0.14 * gain, 900, 0.048);
        this.tone(720, 460, 0.032, 'triangle', pan, 0.055 * gain, 0.052);
        break;
      case 201:
        // Cannon pressure wave, long exterior report, recoil slide and breech.
        this.noise(0.055, 1800, 'highpass', pan, 0.64 * gain);
        this.noise(0.7, 720, 'lowpass', pan, 1.0 * gain, 95);
        this.tone(88, 29, 0.62, 'sine', pan, 0.75 * gain);
        this.noise(0.42, 430, 'bandpass', pan, 0.32 * gain, 160, 0.09);
        this.noise(0.12, 1150, 'bandpass', pan, 0.22 * gain, 380, 0.16);
        this.tone(195, 82, 0.14, 'triangle', pan, 0.16 * gain, 0.3);
        break;
      case 202:
        // Low-velocity shell leaves a hollow launch tube and hydraulic return.
        this.noise(0.04, 1600, 'highpass', pan, 0.33 * gain);
        this.noise(0.42, 620, 'lowpass', pan, 0.8 * gain, 140);
        this.tone(135, 43, 0.34, 'sine', pan, 0.58 * gain);
        this.tone(380, 245, 0.18, 'triangle', pan, 0.09 * gain, 0.025);
        this.noise(0.2, 980, 'bandpass', pan, 0.12 * gain, 420, 0.2);
        break;
      case 204:
        // Rotary cannon: two interleaved barrel cracks with a short bass punch.
        this.noise(0.026, 2200, 'highpass', pan, 0.43 * gain);
        this.noise(0.075, 950, 'lowpass', pan, 0.45 * gain, 320);
        this.tone(155, 72, 0.07, 'sine', pan, 0.29 * gain);
        this.noise(0.025, 2900, 'highpass', pan, 0.2 * gain, undefined, 0.026);
        this.noise(0.04, 1450, 'bandpass', pan, 0.13 * gain, 850, 0.033);
        break;
      case 207:
        this.tone(1380, 280, .13, 'sawtooth', pan, .22 * gain);
        this.tone(690, 125, .16, 'triangle', pan, .25 * gain);
        this.noise(.075, 3300, 'bandpass', pan, .28 * gain, 650);
        this.tone(98, 45, .11, 'sine', pan, .22 * gain);
        break;
      case 208:
        this.tone(180, 48, 1.0, 'sine', pan, .40 * gain);
        this.tone(1900, 210, .7, 'triangle', pan, .25 * gain);
        this.noise(.55, 1050, 'bandpass', pan, .25 * gain, 180);
        break;
      case 209:
        this.tone(520, 240, .12, 'sawtooth', pan, .27 * gain);
        this.tone(1040, 520, .10, 'triangle', pan, .14 * gain);
        this.noise(.06, 2200, 'highpass', pan, .20 * gain);
        this.tone(110, 58, .14, 'sine', pan, .26 * gain);
        break;
      case 210:
        this.tone(140, 35, .8, 'sine', pan, .45 * gain);
        this.noise(.38, 680, 'lowpass', pan, .65 * gain, 90);
        this.tone(820, 340, .34, 'triangle', pan, .25 * gain, .05);
        this.noise(.35, 1200, 'bandpass', pan, .25 * gain, 320, .15);
        break;
      case 213:
        // A sharp breech crack, heavy pressure wave and rolling report. The
        // gunner hears this from the moving barrel tip after its pose update.
        this.noise(.12,2800,'highpass',pan,.70*gain);
        this.tone(94,23,1.15,'sine',pan,.72*gain);
        this.noise(.85,440,'lowpass',pan,.78*gain,65,.025);
        this.tone(220,43,.65,'triangle',pan,.32*gain,.03);
        this.noise(1.05,720,'bandpass',pan,.28*gain,120,.32);
        break;
      case 211:
        this.tone(120,45,.14,'triangle',pan,.32*gain);
        this.noise(.09,1300,'bandpass',pan,.36*gain,320);
        break;
      case 212:
      case 215:
        this.tone(160,58,.28,'sawtooth',pan,.26*gain);
        this.noise(.32,800,'lowpass',pan,.42*gain);
        break;
      case 214:
        this.noise(.045,1700,'highpass',pan,.30*gain);
        this.tone(140,55,.07,'triangle',pan,.22*gain);
        break;
      case 205:
        // Cockpit release confirmation cuts through turbine noise; a short
        // sequence of rack clacks makes the complete carpet release audible.
        this.tone(1320, 980, 0.12, 'triangle', pan, 0.42 * gain);
        this.tone(880, 660, 0.16, 'sine', pan, 0.30 * gain, 0.13);
        for (let rack = 0; rack < 4; rack++) {
          this.noise(0.065, 1700, 'bandpass', pan, 0.50 * gain, 520, rack * 0.085);
          this.tone(190, 80, 0.075, 'triangle', pan, 0.28 * gain, rack * 0.085);
        }
        this.noise(0.55, 1500, 'bandpass', pan, 0.23 * gain, 550, 0.06);
        this.tone(1150, 340, 1.0, 'sine', pan, 0.14 * gain, 0.12);
        break;
    }
  }

  /** Blast report; `radius` (m) scales it from grenade crack to bomb roar. */
  /** Coalesce a simultaneous pellet cluster into one brief crackle. */
  lanceImpact(pan=0,gain=1):void {
    if(!this.ctx||this.ctx.currentTime<this.nextLanceImpact)return;
    this.nextLanceImpact=this.ctx.currentTime+.075;
    this.noise(.11,1900,'bandpass',pan,.25*gain,700);
    this.tone(720,210,.13,'triangle',pan,.16*gain);
  }

  explosion(pan = 0, gain = 1, radius = 6, voided = false): void {
    if(voided){this.tone(165,28,1.9,'sine',pan,.60*gain);this.tone(1640,180,1.1,'triangle',pan,.27*gain,.12);}
    const big = Math.max(0, Math.min(1, (radius - 6) / 16));
    this.noise(0.7 + 1.0 * big, 700 - 320 * big, 'lowpass', pan, (1.0 + 0.8 * big) * gain, 90 - 45 * big);
    this.tone(90 - 28 * big, 32 - 12 * big, 0.55 + 0.55 * big, 'sine', pan, (0.8 + 0.5 * big) * gain);
    if (big > 0.15) {
      // Shockwave crack plus a long low rumble tail for large blasts.
      this.noise(0.12, 2400, 'highpass', pan, 0.5 * big * gain);
      this.tone(55, 26, 1.2 * big, 'triangle', pan, 0.5 * big * gain, 0.08);
    }
    if (radius > 25) {
      // Nuke tier: a second delayed concussion and a very long ground roll.
      this.noise(0.5, 300, 'lowpass', pan, 0.9 * gain, 60);
      this.tone(48, 24, 2.6, 'sine', pan, 0.7 * gain, 0.15);
      this.noise(2.2, 220, 'lowpass', pan, 0.5 * gain, 45);
      this.tone(36, 20, 3.2, 'triangle', pan, 0.4 * gain, 0.5);
    }
  }

  /** Shimmering sweep for teleport departure/arrival. */
  teleport(pan = 0, gain = 1): void {
    this.noise(0.35, 900, 'bandpass', pan, 0.25 * gain, 3400);
    this.tone(320, 1400, 0.3, 'sine', pan, 0.2 * gain);
    this.tone(480, 2100, 0.34, 'triangle', pan, 0.14 * gain, 0.05);
    this.tone(1600, 2400, 0.12, 'sine', pan, 0.1 * gain, 0.22);
  }

  /** Found one of the cave weapons: a short ominous power chord. */
  pickupWeapon(): void {
    this.tone(110, 110, 0.5, 'sawtooth', 0, 0.16);
    this.tone(220, 220, 0.45, 'square', 0, 0.1, 0.04);
    this.tone(440, 660, 0.3, 'sine', 0, 0.14, 0.12);
    this.noise(0.15, 1200, 'bandpass', 0, 0.12, 2600);
  }

  hit(kill: boolean): void {
    this.tone(kill ? 320 : 900, kill ? 120 : 700, kill ? 0.18 : 0.05, 'square', 0, 0.35);
  }

  hurt(): void {
    this.tone(220, 90, 0.12, 'sawtooth', 0, 0.4);
  }

  jump(): void { this.tone(260, 380, 0.08, 'sine', 0, 0.14); }
  land(): void { this.noise(0.06, 500, 'lowpass', 0, 0.2); }
  dodge(): void { this.noise(0.12, 1400, 'bandpass', 0, 0.25, 500); }
  death(): void {
    this.tone(300, 55, 0.5, 'sawtooth', 0, 0.5);
    this.noise(0.4, 800, 'lowpass', 0, 0.4, 100);
  }
  spawn(): void { this.tone(200, 600, 0.16, 'sine', 0, 0.25); }
  weaponSwitch(): void { this.noise(0.04, 1800, 'highpass', 0, 0.15); }
  pickupHealth(): void {
    // A soft rising two-note chime: positive and distinct from combat cues.
    this.tone(480, 660, 0.11, 'sine', 0, 0.16);
    this.tone(660, 990, 0.13, 'triangle', 0, 0.12, 0.065);
  }
  pickupAmmo(): void {
    // Compact crate latch + magazine thunk, kept dry and unobtrusive.
    this.noise(0.055, 1700, 'bandpass', 0, 0.13, 850);
    this.tone(190, 120, 0.075, 'square', 0, 0.10);
    this.tone(760, 480, 0.04, 'triangle', 0, 0.07, 0.035);
  }
  /** Reload kickoff: mag release, break-action opening, or tube latch. */
  reloadStart(weapon: number): void {
    switch (weapon) {
      case 0: // mag release click, mag slipping free
        this.noise(0.03, 2000, 'highpass', 0, 0.16);
        this.tone(420, 300, 0.04, 'square', 0, 0.12);
        this.tone(230, 150, 0.06, 'square', 0, 0.1, 0.09);
        break;
      case 1:
      case 7: // latch + mag rattling out
        this.noise(0.05, 1500, 'bandpass', 0, 0.18, 700);
        this.tone(300, 190, 0.05, 'square', 0, 0.14);
        this.tone(180, 120, 0.07, 'square', 0, 0.1, 0.1);
        break;
      case 2: // break-action opens, spent shells ring away
        this.tone(520, 380, 0.035, 'square', 0, 0.14);
        this.noise(0.09, 800, 'bandpass', 0, 0.16, 350);
        this.tone(150, 95, 0.09, 'square', 0, 0.12, 0.08);
        this.tone(900, 1300, 0.05, 'triangle', 0, 0.05, 0.16);
        this.tone(1100, 1500, 0.05, 'triangle', 0, 0.04, 0.24);
        break;
      case 3: // heavy tube latch + venting
        this.tone(140, 90, 0.1, 'square', 0, 0.2);
        this.noise(0.16, 600, 'lowpass', 0, 0.15, 250);
        break;
      case 5: // railgun: capacitor bank discharging with a falling whine
        this.tone(1400, 300, 0.3, 'sawtooth', 0, 0.1);
        this.noise(0.08, 2200, 'highpass', 0, 0.14);
        this.tone(260, 170, 0.06, 'square', 0, 0.14, 0.1);
        break;
      case 6: // nuke launcher: heavy shielded drum unlatching
        this.tone(120, 75, 0.12, 'square', 0, 0.22);
        this.noise(0.14, 500, 'lowpass', 0, 0.16, 200);
        this.tone(700, 700, 0.06, 'sine', 0, 0.08, 0.18);
        break;
      case 8:
        this.noise(.055, 1150, 'bandpass', 0, .18, 650);
        this.tone(230, 135, .095, 'square', 0, .17);
        this.tone(440, 260, .065, 'triangle', 0, .09, .13);
        break;
      case 9:
        this.tone(1320, 330, .32, 'sine', 0, .16);
        this.noise(.13, 1800, 'bandpass', 0, .11, 600);
        this.tone(245, 165, .055, 'triangle', 0, .14, .11);
        break;
      default: // grenade launcher chamber swings open
        this.tone(170, 100, 0.09, 'square', 0, 0.18);
        this.noise(0.1, 700, 'bandpass', 0, 0.16, 300);
        this.tone(120, 80, 0.08, 'square', 0, 0.12, 0.12);
        break;
    }
  }
  /** Mid-reload: the fresh round/mag seating home. */
  reloadMid(weapon: number): void {
    switch (weapon) {
      case 0:
      case 1:
      case 7: // mag slapped in
        this.noise(0.035, 900, 'bandpass', 0, 0.18);
        this.tone(210, 140, 0.05, 'square', 0, 0.16);
        break;
      case 2: // two shells dropped into the chambers
        this.tone(320, 210, 0.05, 'square', 0, 0.14);
        this.tone(300, 200, 0.05, 'square', 0, 0.12, 0.12);
        break;
      case 3: // rocket scraping down the tube, thunking home
        this.noise(0.18, 500, 'bandpass', 0, 0.14, 950);
        this.tone(160, 110, 0.06, 'square', 0, 0.14, 0.15);
        break;
      case 5: // fresh capacitor cell seats; charge whine spools back up
        this.noise(0.04, 1000, 'bandpass', 0, 0.16);
        this.tone(230, 160, 0.05, 'square', 0, 0.16);
        this.tone(300, 1100, 0.35, 'sine', 0, 0.07, 0.1);
        break;
      case 6: // warhead cassette clunks into the drum
        this.tone(190, 110, 0.09, 'square', 0, 0.2);
        this.noise(0.05, 700, 'bandpass', 0, 0.14);
        break;
      case 8:
        this.tone(175, 95, .095, 'square', 0, .2);
        this.noise(.04, 1100, 'bandpass', 0, .16, 470);
        break;
      case 9:
        this.tone(392, 523, .15, 'sine', 0, .13);
        this.tone(784, 1046, .18, 'sine', 0, .08, .07);
        this.noise(.03, 2200, 'highpass', 0, .1);
        break;
      default: // grenade plunks into the chamber
        this.tone(260, 150, 0.07, 'square', 0, 0.16);
        this.noise(0.03, 1200, 'bandpass', 0, 0.1);
        break;
    }
  }
  /** Reload finish: slide snap, bolt rack, or action snapping shut. */
  reloadComplete(weapon: number): void {
    switch (weapon) {
      case 0: // slide released home
        this.noise(0.03, 1800, 'highpass', 0, 0.2);
        this.tone(520, 320, 0.035, 'square', 0, 0.18);
        break;
      case 1:
      case 7: // charging handle racked: two quick metallic ticks
        this.noise(0.04, 1600, 'highpass', 0, 0.16);
        this.tone(600, 380, 0.03, 'square', 0, 0.16);
        this.tone(480, 300, 0.035, 'square', 0, 0.16, 0.07);
        break;
      case 2: // action snapped shut
        this.tone(200, 120, 0.06, 'square', 0, 0.2);
        this.noise(0.04, 1200, 'highpass', 0, 0.14);
        break;
      case 3: // breech latch clunks closed
        this.tone(160, 95, 0.09, 'square', 0, 0.2);
        this.tone(700, 450, 0.04, 'triangle', 0, 0.1, 0.06);
        break;
      case 5: // rails re-energize: rising charge ping
        this.noise(0.03, 1800, 'highpass', 0, 0.14);
        this.tone(900, 1500, 0.12, 'sine', 0, 0.12);
        break;
      case 6: // drum locks; arming confirmation beep
        this.tone(170, 100, 0.08, 'square', 0, 0.2);
        this.tone(1046, 1046, 0.1, 'sine', 0, 0.12, 0.1);
        break;
      case 8:
        this.noise(.035, 1950, 'highpass', 0, .18);
        this.tone(570, 315, .04, 'square', 0, .14);
        this.noise(.055, 1350, 'bandpass', 0, .1, 850, .075);
        break;
      case 9:
        this.tone(660, 1320, .22, 'sine', 0, .15);
        this.tone(1980, 1980, .1, 'sine', 0, .07, .12);
        break;
      default: // heavy break-action snap
        this.tone(190, 110, 0.07, 'square', 0, 0.2);
        this.noise(0.05, 900, 'bandpass', 0, 0.14);
        break;
    }
  }
  dryFire(): void {
    this.noise(0.025, 2200, 'highpass', 0, 0.13);
    this.tone(145, 105, 0.035, 'square', 0, 0.12);
  }

  vehicleEnter(vehicle: number = VEHICLE.JEEP, variant = 0): void {
    if (variant === VEHICLE_VARIANT.NOCTURNE) { this.tone(240, 850, .6, 'sine', 0, .22); this.tone(360, 1260, .5, 'triangle', 0, .12, .1); }
    if (variant === VEHICLE_VARIANT.BASTION) { this.tone(90, 44, .7, 'sine', 0, .24); this.noise(.25, 520, 'lowpass', 0, .22); }
    if (vehicle === VEHICLE.TANK) {
      // Heavy hatch seats, hydraulics pressurize, diesel catches underneath.
      this.noise(0.11, 750, 'bandpass', 0, 0.28, 180);
      this.tone(112, 45, 0.24, 'sine', 0, 0.32);
      this.noise(0.32, 1100, 'bandpass', 0, 0.10, 360, 0.12);
      this.tone(41, 67, 0.44, 'triangle', 0, 0.1, 0.18);
      this.noise(0.26, 350, 'lowpass', 0, 0.2, 160, 0.32);
    } else if (vehicle === VEHICLE.JET) {
      // Canopy seals, avionics acknowledge, compressor begins to spool.
      this.noise(0.28, 2100, 'bandpass', 0, 0.12, 500);
      this.tone(210, 90, 0.09, 'triangle', 0, 0.13, 0.17);
      this.tone(1046, 1046, 0.055, 'sine', 0, 0.05, 0.22);
      this.tone(1568, 1568, 0.075, 'sine', 0, 0.04, 0.3);
      this.tone(320, 820, 0.8, 'sine', 0, 0.04, 0.18);
      this.noise(0.75, 700, 'bandpass', 0, 0.1, 1700, 0.15);
    } else {
      // Door latch, brief starter motor, then a low exhaust cough.
      this.noise(0.065, 950, 'bandpass', 0, 0.23, 300);
      this.tone(165, 65, 0.13, 'triangle', 0, 0.21);
      this.noise(0.22, 600, 'bandpass', 0, 0.13, 900, 0.08);
      this.tone(62, 110, 0.25, 'triangle', 0, 0.09, 0.1);
      this.noise(0.16, 390, 'lowpass', 0, 0.19, 170, 0.3);
      this.tone(88, 48, 0.18, 'sine', 0, 0.14, 0.3);
    }
  }

  vehicleExit(vehicle: number = VEHICLE.JEEP): void {
    this.noise(vehicle === VEHICLE.JET ? 0.22 : 0.07,
      vehicle === VEHICLE.JET ? 2200 : 1050, 'bandpass', 0, 0.14, 400);
    this.tone(vehicle === VEHICLE.TANK ? 140 : 220, vehicle === VEHICLE.TANK ? 62 : 110,
      vehicle === VEHICLE.TANK ? 0.16 : 0.09, 'triangle', 0, 0.14);
  }

  /** Continuous occupied-vehicle mix. Speed is relative to the hull's nominal max speed. */
  engine(vehicle: number, speed01: number, boost = false, input: VehicleAudioInput = {}): void {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    if (this.eng && this.eng.vehicle !== vehicle) this.stopEngine();
    if (vehicle !== VEHICLE.JEEP && vehicle !== VEHICLE.TANK && vehicle !== VEHICLE.JET && vehicle !== VEHICLE.GUNBOAT) return;
    if (!this.eng) {
      let buffer = this.combustionBuffers.get(vehicle);
      if (!buffer && vehicle !== VEHICLE.JET) {
        const data = combustionSamples(vehicle, this.ctx.sampleRate);
        buffer = this.ctx.createBuffer(1, data.length, this.ctx.sampleRate);
        buffer.getChannelData(0).set(data);
        this.combustionBuffers.set(vehicle, buffer);
      }
      this.eng = new VehicleEngineVoice(this.ctx, this.master, this.noiseBuf, vehicle, buffer);
    }
    this.eng.update(speed01, boost, input);
  }

  private stopEngine(): void {
    this.eng?.stop();
    this.eng = null;
  }

  lift(sound:LiftSound|null):void {
    if(!this.ctx||!this.master||!this.noiseBuf)return;
    if(sound&&!this.liftVoice)this.liftVoice=new CityLiftVoice(this.ctx,this.master,this.noiseBuf);
    this.liftVoice?.update(sound);
  }
  stopLift():void {this.liftVoice?.stop();this.liftVoice=null;}

  /**
   * pan/gain for a world position relative to the listener. `reach` widens
   * the audible falloff for loud events (big explosions carry farther).
   */
  positional(
    x: number, y: number, z: number,
    camX: number, camY: number, camZ: number, camYaw: number,
    reach = 14,
  ): { pan: number; gain: number } {
    const dx = x - camX, dy = y - camY, dz = z - camZ;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const gain = Math.min(1, reach / (6 + dist));
    // Camera right vector: (cos yaw, 0, -sin yaw)
    const pan = dist < 0.5 ? 0 : (dx * Math.cos(camYaw) - dz * Math.sin(camYaw)) / dist;
    return { pan: pan * 0.75, gain };
  }
}
