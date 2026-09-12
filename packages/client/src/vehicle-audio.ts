import { VEHICLE } from '@shared/index';

export interface VehicleAudioInput {
  /** Signed drive input; jets treat negative input as an air brake. */
  throttle?: number;
  grounded?: boolean;
  turning?: number;
}

export interface EngineDrive {
  speed: number;
  load: number;
  /** Crankshaft RPM for piston hulls; normalized spool for the turbine. */
  rpm: number;
  boost: number;
  surface: number;
  gear: number;
  shiftUntil: number;
}

const limit = (x: number, low = 0, high = 1): number =>
  Math.max(low, Math.min(high, Number.isFinite(x) ? x : 0));
const approach = (a: number, b: number, dt: number, seconds: number): number =>
  a + (b - a) * (1 - Math.exp(-dt / seconds));

export function initialEngineDrive(vehicle: number): EngineDrive {
  return { speed: 0, load: 0, rpm: vehicle === VEHICLE.JET ? 0.23 : (vehicle === VEHICLE.TANK || vehicle === VEHICLE.GUNBOAT) ? 620 : 850, boost: 0,
    surface: 0, gear: 1, shiftUntil: 0 };
}

/** Frame-rate independent control smoothing, including hysteresis at gear changes. */
export function advanceEngineDrive(
  state: EngineDrive, vehicle: number, speed01: number, boost: boolean,
  input: VehicleAudioInput, now: number, elapsed: number,
): EngineDrive {
  const dt = limit(elapsed, 0, 0.1);
  // Boost can take the jeep to almost five times its normal road speed.
  const speed = approach(state.speed, limit(speed01, 0, 5), dt, 0.12);
  const drive = input.throttle === undefined ? Math.min(1, speed * 1.4) : limit(input.throttle, -1, 1);
  const requestedLoad = vehicle === VEHICLE.JET ? Math.max(0, drive) : Math.abs(drive);
  const load = approach(state.load, boost ? 1 : requestedLoad, dt, requestedLoad > state.load ? 0.18 : 0.32);
  const boosted = approach(state.boost, boost ? 1 : 0, dt, 0.16);
  const contact = input.grounded === false ? 0 : 1;
  const rolling = Math.min(1.5, speed) + ((vehicle === VEHICLE.TANK || vehicle === VEHICLE.GUNBOAT) ? Math.abs(limit(input.turning ?? 0, -1, 1)) * 0.3 : 0);
  const surface = approach(state.surface, rolling * contact, dt, 0.18);
  let gear = state.gear;
  let shiftUntil = state.shiftUntil;
  let targetRpm: number;
  if (vehicle === VEHICLE.JEEP) {
    const ratios = [10500, 6800, 4600, 3300, 2700];
    const roadRpm = 850 + speed * ratios[gear - 1];
    if (now >= shiftUntil) {
      if (roadRpm > 4150 && state.rpm > 3700 && gear < ratios.length) { gear++; shiftUntil = now + 0.28; }
      else if (roadRpm < 1850 && state.rpm < 2250 && gear > 1) { gear--; shiftUntil = now + 0.32; }
    }
    const clutch = now < shiftUntil ? 0.72 : 1;
    targetRpm = limit((850 + speed * ratios[gear - 1] + load * 450 + boosted * 400) * clutch, 780, 5800);
  } else if ((vehicle === VEHICLE.TANK || vehicle === VEHICLE.GUNBOAT)) {
    targetRpm = 620 + Math.min(1, speed) * 800 + load * 520;
  } else {
    // Turbine spool is separate from airspeed: coasting still creates wind.
    targetRpm = limit(0.23 + Math.min(1.2, speed) * 0.46 + load * 0.31 + Math.min(0, drive) * 0.12, 0.2, 1.1);
  }
  const rpm = approach(state.rpm, targetRpm, dt,
    vehicle === VEHICLE.JET ? (targetRpm > state.rpm ? 0.8 : 1.1) : (targetRpm > state.rpm ? 0.16 : 0.09));
  return { speed, load, rpm, boost: boosted, surface, gear, shiftUntil };
}

/**
 * Eight complete 720-degree cycles of individually excited exhaust resonances.
 * Cylinder-to-cylinder variation breaks up the buzzy, identical oscillator sound;
 * wrapping each decay into the buffer makes the loop continuous at its seam.
 */
export function combustionSamples(vehicle: number, sampleRate: number): Float32Array {
  const tank = (vehicle === VEHICLE.TANK || vehicle === VEHICLE.GUNBOAT);
  const idle = tank ? 620 : 850;
  const cylinders = tank ? 12 : 8;
  const cycleSeconds = 120 / idle;
  const length = Math.round(sampleRate * cycleSeconds * 8);
  const samples = new Float32Array(length);
  let seed = vehicle === VEHICLE.GUNBOAT ? 49139 : tank ? 71237 : 19391;
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let firing = 0; firing < cylinders * 8; firing++) {
    const bank = firing % 2;
    const offset = Math.round((firing + (bank ? 0.06 : -0.06)) * length / (cylinders * 8));
    const strength = 0.72 + random() * 0.28;
    const decay = tank ? 0.042 : 0.024;
    let grit = 0;
    for (let j = 0; j < sampleRate * decay * 5; j++) {
      const t = j / sampleRate;
      grit = grit * 0.62 + (random() * 2 - 1) * 0.38;
      const attack = 1 - Math.exp(-t * 3000);
      const body = Math.sin(t * Math.PI * 2 * (tank ? 67 : 92)) * Math.exp(-t / decay);
      const exhaust = Math.sin(t * Math.PI * 2 * (tank ? 141 : 213)) * Math.exp(-t / (decay * 0.42));
      const combustion = grit * Math.exp(-t / (decay * 0.22));
      const index = (offset + j + length) % length;
      samples[index] += strength * attack * (body * 0.66 + exhaust * 0.21 + combustion * 0.35);
    }
  }
  let mean = 0;
  for (const value of samples) mean += value / length;
  let peak = 0;
  for (let i = 0; i < length; i++) { samples[i] -= mean; peak = Math.max(peak, Math.abs(samples[i])); }
  for (let i = 0; i < length; i++) samples[i] = samples[i] / Math.max(0.001, peak) * 0.88;
  return samples;
}

/** One bounded, continuously modulated voice; no per-frame node allocations. */
export class VehicleEngineVoice {
  readonly vehicle: number;
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly master: GainNode;
  private readonly body: GainNode;
  private readonly bodyFilter: BiquadFilterNode;
  private readonly combustion: AudioBufferSourceNode | null;
  private readonly turbine: OscillatorNode | null;
  private readonly mechanical: OscillatorNode;
  private readonly mechanicalGain: GainNode;
  private readonly roar: GainNode;
  private readonly roarFilter: BiquadFilterNode;
  private readonly road: GainNode;
  private readonly roadFilter: BiquadFilterNode;
  private readonly clatter: OscillatorNode;
  private readonly clatterDepth: GainNode;
  private state: EngineDrive;
  private lastTime: number;
  private stopped = false;
  private readonly targets = new Map<AudioParam, number>();

  constructor(private readonly ctx: AudioContext, output: AudioNode, noise: AudioBuffer,
    vehicle: number, combustionBuffer?: AudioBuffer) {
    this.vehicle = vehicle;
    this.state = initialEngineDrive(vehicle);
    this.lastTime = ctx.currentTime;
    const gain = (value = 0): GainNode => {
      const node = ctx.createGain(); node.gain.value = value; this.nodes.push(node); return node;
    };
    const filter = (type: BiquadFilterType, hz: number, q = 0.7): BiquadFilterNode => {
      const node = ctx.createBiquadFilter(); node.type = type; node.frequency.value = hz; node.Q.value = q;
      this.nodes.push(node); return node;
    };
    const oscillator = (type: OscillatorType, hz: number): OscillatorNode => {
      const node = ctx.createOscillator(); node.type = type; node.frequency.value = hz;
      this.nodes.push(node); this.sources.push(node); return node;
    };
    this.master = gain(0);
    this.master.connect(output);
    this.body = gain();
    this.bodyFilter = filter('lowpass', (vehicle === VEHICLE.TANK || vehicle === VEHICLE.GUNBOAT) ? 400 : 950);
    this.bodyFilter.connect(this.body); this.body.connect(this.master);
    if (vehicle !== VEHICLE.JET && combustionBuffer) {
      this.combustion = ctx.createBufferSource();
      this.combustion.buffer = combustionBuffer; this.combustion.loop = true;
      this.combustion.connect(this.bodyFilter);
      this.nodes.push(this.combustion); this.sources.push(this.combustion);
      this.turbine = null;
    } else {
      this.combustion = null;
      this.turbine = oscillator('sine', 640);
      this.turbine.connect(this.bodyFilter);
    }
    this.mechanical = oscillator(vehicle === VEHICLE.JEEP ? 'triangle' : 'sine', 100);
    this.mechanicalGain = gain();
    this.mechanical.connect(this.mechanicalGain); this.mechanicalGain.connect(this.master);
    this.roar = gain();
    this.roarFilter = filter(vehicle === VEHICLE.JET ? 'lowpass' : 'bandpass', 450, 0.6);
    this.roarFilter.connect(this.roar); this.roar.connect(this.master);
    this.road = gain();
    this.roadFilter = filter(vehicle === VEHICLE.JET ? 'highpass' : 'bandpass', 750, 0.5);
    this.roadFilter.connect(this.road); this.road.connect(this.master);
    for (const [i, destination] of [this.roarFilter, this.roadFilter].entries()) {
      const source = ctx.createBufferSource(); source.buffer = noise; source.loop = true;
      source.playbackRate.value = i === 0 ? 0.83 : 1.13;
      source.connect(destination); this.nodes.push(source); this.sources.push(source);
    }
    this.clatter = oscillator('triangle', 8);
    this.clatterDepth = gain();
    this.clatter.connect(this.clatterDepth); this.clatterDepth.connect(this.road.gain);
    // A stopped source's ended event releases every node, including modulation
    // connections; the callback runs on audio time even after render updates stop.
    this.sources[0].onended = () => { for (const node of this.nodes) node.disconnect(); this.targets.clear(); };
    for (const source of this.sources) source.start(ctx.currentTime);
  }

  private target(param: AudioParam, value: number, seconds = 0.075): void {
    if (this.targets.get(param) === value) return;
    this.targets.set(param, value);
    // Replace pending automation; the new target begins at the native current
    // value, preserving the ramp instead of snapping to its destination.
    const now = this.ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(value, now, seconds);
  }

  update(speed01: number, boost: boolean, input: VehicleAudioInput): void {
    if (this.stopped) return;
    const now = this.ctx.currentTime;
    this.state = advanceEngineDrive(this.state, this.vehicle, speed01, boost, input, now,
      Math.max(0, now - this.lastTime));
    this.lastTime = now;
    const { rpm, speed, load, surface, boost: boosted, shiftUntil } = this.state;
    const s = Math.min(1.5, speed);
    if (this.vehicle === VEHICLE.JEEP) {
      this.target(this.combustion!.playbackRate, rpm / 850);
      this.target(this.body.gain, (0.22 + load * 0.13 + boosted * 0.035) * (now < shiftUntil ? 0.74 : 1));
      this.target(this.bodyFilter.frequency, 320 + rpm * 0.27 + load * 620);
      this.target(this.mechanical.frequency, 80 + rpm * 0.055);
      this.target(this.mechanicalGain.gain, 0.008 + load * 0.008);
      this.target(this.roarFilter.frequency, 300 + load * 750 + boosted * 1100);
      this.target(this.roar.gain, 0.015 + load * 0.07 + boosted * 0.14);
      this.target(this.roadFilter.frequency, 650 + s * 780);
      this.target(this.road.gain, surface * 0.055);
      this.target(this.clatterDepth.gain, 0);
    } else if ((this.vehicle === VEHICLE.TANK || this.vehicle === VEHICLE.GUNBOAT)) {
      this.target(this.combustion!.playbackRate, rpm / 620);
      this.target(this.body.gain, 0.29 + load * 0.13);
      this.target(this.bodyFilter.frequency, 270 + load * 340 + s * 180);
      this.target(this.mechanical.frequency, 95 + s * 220);
      this.target(this.mechanicalGain.gain, surface * 0.015);
      this.target(this.roarFilter.frequency, 200 + load * 420);
      this.target(this.roar.gain, 0.035 + load * 0.09);
      this.target(this.roadFilter.frequency, 550 + surface * 700);
      this.target(this.road.gain, surface * (this.vehicle === VEHICLE.GUNBOAT ? .06 : .14));
      this.target(this.clatter.frequency, 4 + surface * 39);
      this.target(this.clatterDepth.gain, this.vehicle === VEHICLE.GUNBOAT ? 0 : surface * .09);
    } else {
      this.target(this.turbine!.frequency, 450 + rpm * 1650, 0.18);
      this.target(this.bodyFilter.frequency, 3300);
      this.target(this.body.gain, 0.011 + rpm * 0.017);
      this.target(this.mechanical.frequency, 152 + rpm * 510, 0.18);
      this.target(this.mechanicalGain.gain, 0.018 + rpm * 0.022);
      this.target(this.roarFilter.frequency, 320 + rpm * 1650, 0.18);
      this.target(this.roar.gain, 0.18 + rpm * 0.42);
      this.target(this.roadFilter.frequency, 900 + s * 1050);
      this.target(this.road.gain, Math.pow(Math.min(1.2, speed), 1.6) * 0.1);
      this.target(this.clatterDepth.gain, 0);
    }
    this.target(this.master.gain, 1, this.vehicle === VEHICLE.JET ? 0.45 : 0.22);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    const now = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(0, now, 0.065);
    for (const source of this.sources) source.stop(now + 0.4);
  }
}
