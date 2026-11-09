import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AudioFX } from '../src/audio.js';
import { VEHICLE, VEHICLE_VARIANT, WEAPONS } from '@shared/index';
import { advanceEngineDrive, combustionSamples, initialEngineDrive, engineVoice, PROPELLER_ENGINE } from '../src/vehicle-audio.js';
import { nearestMovingLift } from '../src/city-lift-audio.js';
import type { CityLiftSite } from '@shared/cities';

test('pickup cues are safe before browser audio is unlocked', () => {
  const audio = new AudioFX();
  assert.doesNotThrow(() => audio.pickupHealth());
  assert.doesNotThrow(() => audio.pickupAmmo());
  assert.doesNotThrow(() => audio.lift({gain:.05,pan:0,speed:4}));
  assert.doesNotThrow(() => audio.stopLift());
});

test('lift sound follows the nearest real moving carriage, including height, dwell and camera orientation', () => {
  const site=(x:number,overrides:Partial<CityLiftSite>={}):CityLiftSite=>({
    id:x,cityId:0,x,z:0,bottom:0,top:24,hx:3,hz:3,phase:0,dwell:8,...overrides,
  });
  const sites=[site(20),site(8)],camera={x:0,y:5,z:0};
  const sound=nearestMovingLift(sites,9,camera,0)!;
  assert.ok(Math.abs(sound.gain-.09*(1-8/36)**2)<1e-12);
  assert.equal(sound.pan,1);assert.equal(sound.speed,4);
  assert.deepEqual(nearestMovingLift([...sites].reverse(),9,camera,0),sound);
  assert.equal(nearestMovingLift(sites,9,camera,Math.PI)!.pan,-1);
  assert.equal(nearestMovingLift(sites,7.99,camera,0),null,'station-specific eight-second dwell stays silent');
  assert.equal(nearestMovingLift(sites,14,camera,0),null,'upper landing dwell stays silent');
  assert.equal(nearestMovingLift([site(1,{bottom:100,top:124})],9,camera,0),null,
    'a shaft beside the listener does not sound close when its carriage is overhead');
  assert.equal(nearestMovingLift(sites,9,{...camera,x:-40},0),null);
  assert.equal(nearestMovingLift(sites,9,camera,0,false),null);
  assert.equal(nearestMovingLift(sites,NaN,camera,0),null);
  const descending=nearestMovingLift([site(8)],23,{x:0,y:21,z:0},0)!;
  assert.equal(descending.speed,4,'descent has the same motor speed as ascent');
});

test('vehicle cues are safe before browser audio is unlocked', () => {
  const audio = new AudioFX();
  assert.doesNotThrow(() => audio.vehicleEnter());
  assert.doesNotThrow(() => audio.vehicleExit());
  assert.doesNotThrow(() => audio.engine(3, 0.5));
  assert.doesNotThrow(() => audio.engine(0, 0));
  assert.doesNotThrow(() => audio.fire(205));
  assert.doesNotThrow(() => audio.explosion(0, 1, 22.5));
  for (const species of [0, 1, 2, 3, 4, 5]) assert.doesNotThrow(() => audio.creatureAlert(species));
});

test('reload cues are safe before browser audio is unlocked', () => {
  const audio = new AudioFX();
  for (let w = 0; w < WEAPONS.length; w++) {
    assert.doesNotThrow(() => audio.fire(w));
    assert.doesNotThrow(() => audio.reloadStart(w));
    assert.doesNotThrow(() => audio.reloadMid(w));
    assert.doesNotThrow(() => audio.reloadComplete(w));
  }
});

test('wildlife species keep distinct brief alert signatures with bounded voice counts', () => {
  const signatures = new Set<string>();
  for (const species of [0, 1, 2, 3, 4, 5]) {
    const audio = new AudioFX() as unknown as { creatureAlert(species: number): void; tone(...args: unknown[]): void; noise(...args: unknown[]): void };
    const calls: unknown[][] = [];
    audio.tone = (...args) => calls.push(['tone', ...args]);
    audio.noise = (...args) => calls.push(['noise', ...args]);
    audio.creatureAlert(species);
    assert.ok(calls.length >= 2 && calls.length <= 6);
    signatures.add(JSON.stringify(calls));
  }
  assert.equal(signatures.size, 6);
});

test('found weapons have distinct reports and bounded fire/reload voice counts', () => {
  const signatures = new Set<string>();
  for (const id of [7, 8, 9]) {
    const audio = new AudioFX();
    const calls: unknown[][] = [];
    const record = audio as unknown as { tone: (...args: unknown[]) => void; noise: (...args: unknown[]) => void };
    record.tone = (...args) => { calls.push(['tone', ...args]); };
    record.noise = (...args) => { calls.push(['noise', ...args]); };
    audio.fire(id);
    assert.ok(calls.length >= 2 && calls.length <= 4, 'rapid fire cannot create unbounded oscillator layers');
    signatures.add(JSON.stringify(calls));
    for (const method of ['reloadStart', 'reloadMid', 'reloadComplete'] as const) {
      calls.length = 0; audio[method](id);
      assert.ok(calls.length >= 2 && calls.length <= 4, `${id} needs a bounded audible ${method} cue`);
    }
  }
  assert.equal(signatures.size, 3, 'burst reports, gas salvos and plasma excitation must sound different');
});

test('combustion loops are deterministic, centered, bounded and distinct for each engine', () => {
  const jeep = combustionSamples(VEHICLE.JEEP, 48000);
  const tank = combustionSamples(VEHICLE.TANK, 48000);
  const radials = combustionSamples(PROPELLER_ENGINE, 48000);
  assert.deepEqual(jeep, combustionSamples(VEHICLE.JEEP, 48000));
  assert.notEqual(jeep.length, tank.length);
  const crossings = (samples: Float32Array) => { let n = 0; for (let i = 1; i < samples.length; i++) if ((samples[i - 1] < 0) !== (samples[i] < 0)) n++; return n / samples.length; };
  assert.ok(crossings(radials) < crossings(tank) * .75, "the Condor's radials rumble deeper than any other engine");
  for (const samples of [jeep, tank, radials]) {
    let mean = 0;
    let energy = 0;
    let largestStep = 0;
    for (let i = 0; i < samples.length; i++) {
      assert.ok(Number.isFinite(samples[i]) && Math.abs(samples[i]) <= 0.881);
      mean += samples[i]; energy += samples[i] ** 2;
      if (i > 0) largestStep = Math.max(largestStep, Math.abs(samples[i] - samples[i - 1]));
    }
    assert.ok(Math.abs(mean / samples.length) < 1e-7, 'exhaust loop must not add a DC offset');
    assert.ok(Math.sqrt(energy / samples.length) > 0.1, 'loop contains audible combustion energy');
    assert.ok(Math.abs(samples[0] - samples[samples.length - 1]) <= largestStep,
      'wrapped seam stays inside the signal\'s natural transient range');
  }
});

test('jeep upshifts lower revs and hold their gear instead of hunting', () => {
  let state = initialEngineDrive(VEHICLE.JEEP);
  let shiftAt = -1;
  let rpmBeforeShift = 0;
  let lowestAfterShift = Infinity;
  let previousGear = 1;
  for (let frame = 1; frame <= 240; frame++) {
    const now = frame / 60;
    const next = advanceEngineDrive(state, VEHICLE.JEEP, 0.4, false, { throttle: 1 }, now, 1 / 60);
    if (next.gear > previousGear) { assert.equal(shiftAt, -1); shiftAt = now; rpmBeforeShift = state.rpm; }
    if (shiftAt > 0 && now < shiftAt + 0.28) lowestAfterShift = Math.min(lowestAfterShift, next.rpm);
    state = next; previousGear = state.gear;
  }
  assert.equal(state.gear, 2);
  assert.ok(shiftAt > 0);
  assert.ok(lowestAfterShift < rpmBeforeShift * 0.92, 'audible clutch/rev drop on upshift');
});

test('throttle, turbine spool, ground contact and pivoting affect independent sound layers', () => {
  const settle = (vehicle: number, speed: number, throttle: number, grounded = true, turning = 0) => {
    let state = initialEngineDrive(vehicle);
    for (let i = 1; i <= 240; i++) state = advanceEngineDrive(state, vehicle, speed, false,
      { throttle, grounded, turning }, i / 60, 1 / 60);
    return state;
  };
  const idle = settle(VEHICLE.JEEP, 0.2, 0);
  const loaded = settle(VEHICLE.JEEP, 0.2, 1);
  assert.ok(loaded.rpm > idle.rpm + 400);
  assert.ok(loaded.load > 0.99 && idle.load === 0);
  assert.equal(settle(VEHICLE.TANK, 0, 0).surface, 0);
  assert.ok(settle(VEHICLE.TANK, 0, 0, true, 1).surface > 0.29, 'tank pivot makes track noise');
  assert.equal(settle(VEHICLE.JEEP, 0.8, 1, false).surface, 0, 'no tire hiss while airborne');
  const initial = initialEngineDrive(VEHICLE.JET);
  const first = advanceEngineDrive(initial, VEHICLE.JET, 0, false, { throttle: 1 }, 0.016, 0.016);
  assert.ok(first.rpm < 0.25, 'turbine does not jump straight to full spool');
  assert.ok(settle(VEHICLE.JET, 0.8, 1).rpm > settle(VEHICLE.JET, 0.8, 0).rpm + 0.28);
  assert.ok(settle(VEHICLE.JET, 0.8, -1).rpm < settle(VEHICLE.JET, 0.8, 0).rpm);
});

test('engine controls stay finite during boost, invalid input and long frame gaps', () => {
  for (const vehicle of [VEHICLE.JEEP, VEHICLE.TANK, VEHICLE.JET]) {
    let state = initialEngineDrive(vehicle);
    for (let i = 1; i <= 500; i++) state = advanceEngineDrive(state, vehicle, 4.8, true,
      { throttle: 1 }, i / 60, 1 / 60);
    assert.ok(state.rpm <= (vehicle === VEHICLE.JET ? 1.1 : 5800));
    assert.ok(state.boost > 0.99);
    state = advanceEngineDrive(state, vehicle, NaN, false, { throttle: Infinity, turning: NaN }, 20, 12);
    for (const value of Object.values(state)) assert.ok(Number.isFinite(value));
  }
});

class FakeParam {
  value = 0;
  setValueAtTime(value: number, time: number): this { this.validate(value, time); this.value = value; return this; }
  exponentialRampToValueAtTime(value: number, time: number): this {
    assert.ok(value > 0); return this.setValueAtTime(value, time);
  }
  setTargetAtTime(value: number, time: number, constant: number): this {
    assert.ok(constant > 0); return this.setValueAtTime(value, time);
  }
  cancelScheduledValues(time: number): this { this.validate(time); return this; }
  private validate(...values: number[]): void { for (const value of values) assert.ok(Number.isFinite(value)); }
}

class FakeNode {
  connections = new Set<unknown>();
  gain = new FakeParam();
  frequency = new FakeParam();
  playbackRate = new FakeParam();
  Q = new FakeParam();
  pan = new FakeParam();
  type = '';
  loop = false;
  buffer: unknown = null;
  onended: (() => void) | null = null;
  startAt: number | null = null;
  stopAt: number | null = null;
  connect(to: unknown): unknown { this.connections.add(to); return to; }
  disconnect(): void { this.connections.clear(); }
  start(time = 0): void { assert.equal(this.startAt, null); this.startAt = time; }
  stop(time = 0): void { assert.equal(this.stopAt, null, 'sources stop exactly once'); this.stopAt = time; }
}

class FakeAudioContext {
  static latest: FakeAudioContext;
  currentTime = 0;
  sampleRate = 48000;
  state = 'running';
  destination = new FakeNode();
  nodes: FakeNode[] = [];
  constructor() { FakeAudioContext.latest = this; }
  private node(): FakeNode { const node = new FakeNode(); this.nodes.push(node); return node; }
  createGain(): FakeNode { return this.node(); }
  createStereoPanner(): FakeNode { return this.node(); }
  createBiquadFilter(): FakeNode { return this.node(); }
  createBufferSource(): FakeNode { return this.node(); }
  createOscillator(): FakeNode { return this.node(); }
  createBuffer(_channels: number, length: number): { getChannelData: () => Float32Array } {
    const data = new Float32Array(length); return { getChannelData: () => data };
  }
  advance(time: number): void {
    this.currentTime = time;
    for (const node of this.nodes) if (node.stopAt !== null && node.stopAt <= time) {
      const ended = node.onended; node.onended = null; ended?.();
    }
  }
}

function withAudio(run: (audio: AudioFX, context: FakeAudioContext) => void): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { AudioContext: FakeAudioContext } });
  try {
    const audio = new AudioFX(); audio.unlock(); run(audio, FakeAudioContext.latest);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

test('driving reuses its voice and exiting releases every engine node without another frame', () => {
  withAudio((audio, context) => {
    audio.engine(VEHICLE.JEEP, 0);
    const nodeCount = context.nodes.length;
    const sources = context.nodes.filter(node => node.startAt !== null);
    for (let i = 1; i <= 300; i++) {
      context.advance(i / 60);
      audio.engine(VEHICLE.JEEP, i / 300, i > 200, { throttle: 1 });
    }
    assert.equal(context.nodes.length, nodeCount, 'no new audio nodes while driving');
    audio.engine(VEHICLE.NONE, 0);
    audio.engine(VEHICLE.NONE, 0);
    assert.ok(sources.every(node => node.stopAt !== null && node.stopAt <= context.currentTime + 0.41));
    context.advance(6);
    assert.ok(context.nodes.slice(1).every(node => node.connections.size === 0), 'only global master remains connected');
  });
});

test('changing vehicles crossfades and safely releases the old voice', () => {
  withAudio((audio, context) => {
    for (const vehicle of [VEHICLE.JEEP, VEHICLE.TANK, VEHICLE.JET, VEHICLE.JEEP]) {
      const old = context.nodes.filter(node => node.startAt !== null && node.stopAt === null);
      audio.engine(vehicle, 0.5, false, { throttle: 0.75, grounded: true, turning: 0.5 });
      assert.ok(old.every(node => node.stopAt !== null));
      context.advance(context.currentTime + 0.5);
      assert.ok(old.every(node => node.connections.size === 0));
    }
    audio.engine(VEHICLE.NONE, 0);
    context.advance(context.currentTime + 1);
    assert.ok(context.nodes.slice(1).every(node => node.connections.size === 0));
  });
});

test('vehicle reports and entry cues release their complete one-shot graphs', () => {
  withAudio((audio, context) => {
    for (const vehicle of [VEHICLE.JEEP, VEHICLE.TANK, VEHICLE.JET]) {
      audio.vehicleEnter(vehicle); audio.vehicleExit(vehicle);
    }
    for (const weapon of [200, 201, 202, 204, 205]) audio.fire(weapon, -0.35, 0.7);
    context.advance(3);
    const sources = context.nodes.filter(node => node.startAt !== null);
    assert.ok(sources.length > 30, 'layered cues exercised');
    assert.ok(sources.every(node => node.stopAt !== null && node.stopAt < 3));
    assert.ok(context.nodes.slice(1).every(node => node.connections.size === 0));
  });
});


test('turbo layer decays after real boost ends even while coasting at boost speed', () => {
  let state = initialEngineDrive(VEHICLE.JEEP);
  for (let i = 0; i < 120; i++) state = advanceEngineDrive(state, VEHICLE.JEEP, 4, true,
    { throttle: 1, grounded: true }, i / 60, 1 / 60);
  assert.ok(state.boost > 0.99);
  for (let i = 0; i < 60; i++) state = advanceEngineDrive(state, VEHICLE.JEEP, 4, false,
    { throttle: 1, grounded: true }, 2 + i / 60, 1 / 60);
  assert.ok(state.boost < 0.003, 'coasting speed cannot sustain the turbo sound');
});

test('jet bomb release includes a cockpit confirmation and staggered rack clacks', () => {
  withAudio((audio, context) => {
    audio.fire(205);
    const sources = context.nodes.filter(node => node.startAt !== null);
    assert.ok(sources.length >= 12, 'release has an audible confirmation plus the carpet-rack sequence');
    assert.ok(sources.filter(node => node.startAt! > 0.1).length >= 5, 'rack clacks are spread across the release');
    context.advance(2);
    assert.ok(sources.every(node => node.connections.size === 0));
  });
});

test('capital superweapons have distinct audible reports with at most four synthesized layers', () => {
  const signatures=new Set<string>();
  for(const id of [207,208,209,210]) {
    const audio=new AudioFX(), calls:unknown[][]=[];
    const record=audio as unknown as {tone(...args:unknown[]):void;noise(...args:unknown[]):void};
    record.tone=(...args)=>{calls.push(['tone',...args]);};record.noise=(...args)=>{calls.push(['noise',...args]);};
    audio.fire(id);assert.ok(calls.length>=2&&calls.length<=4);signatures.add(JSON.stringify(calls));
  }
  assert.equal(signatures.size,4);
});

test('nearby lifts reuse one quiet voice, mute during dwell, and release every node when paused or disconnected', () => {
  withAudio((audio,context)=>{
    const base=context.nodes.length;audio.lift(null);assert.equal(context.nodes.length,base);
    audio.lift({gain:.07,pan:.4,speed:4});
    const count=context.nodes.length,liftNodes=context.nodes.slice(base);
    const sources=liftNodes.filter(node=>node.startAt!==null);
    assert.equal(sources.length,3);assert.ok(liftNodes.length<=9);
    assert.equal(liftNodes[0].gain.value,.07);
    for(let frame=1;frame<=600;frame++){
      context.advance(frame/60);
      audio.lift({gain:.04+Math.sin(frame)*.02,pan:Math.sin(frame*.01),speed:frame<300?4:12});
    }
    assert.equal(context.nodes.length,count,'movement and changing shafts allocate no additional audio nodes');
    audio.lift(null);assert.equal(liftNodes[0].gain.value,0,'a waiting/distant carriage fades to silence');
    audio.lift({gain:.05,pan:-.3,speed:4});assert.equal(context.nodes.length,count);
    audio.stopLift();audio.stopLift();
    assert.ok(sources.every(node=>node.stopAt===10.25));
    context.advance(10.3);
    assert.ok(liftNodes.every(node=>node.connections.size===0),'cleanup finishes without a render frame');
    assert.equal(context.nodes[0].connections.size,1,'the shared AudioFX master remains connected');
    audio.lift({gain:.05,pan:0,speed:4});
    assert.equal(context.nodes.filter(node=>node.startAt!==null&&node.stopAt===null).length,3);
    audio.stopLift();context.advance(11);
    assert.ok(context.nodes.slice(base).every(node=>node.connections.size===0));
  });
});

test('gunboats use a finite diesel voice and new mounted weapons release their audio nodes',()=>{
  let state=initialEngineDrive(VEHICLE.GUNBOAT);
  for(let i=0;i<120;i++)state=advanceEngineDrive(state,VEHICLE.GUNBOAT,.8,false,{throttle:1,grounded:true},i/60,1/60);
  assert.ok(state.rpm>1000&&state.rpm<2300,'boat controls drive diesel RPM, never turbine spool');
  withAudio((audio,context)=>{
    audio.engine(VEHICLE.GUNBOAT,.6,false,{throttle:1,grounded:true});
    context.advance(.2);audio.engine(VEHICLE.GUNBOAT,.8,false,{throttle:1,grounded:true});
    for(const id of [211,212,213,214,215])audio.fire(id);
    audio.engine(VEHICLE.NONE,0);context.advance(3);
    assert.ok(context.nodes.slice(1).every(node=>node.connections.size===0));
  });
});

test('the Condor rumbles on its own propeller voice through a slow, heavy rev band', () => {
  assert.equal(engineVoice(VEHICLE.JET, VEHICLE_VARIANT.CONDOR), PROPELLER_ENGINE);
  assert.equal(engineVoice(VEHICLE.JET, 0), VEHICLE.JET, 'fighters keep their turbine');
  assert.equal(engineVoice(VEHICLE.TANK, 0), VEHICLE.TANK);
  let idle = initialEngineDrive(PROPELLER_ENGINE), full = idle;
  for (let i = 0; i < 300; i++) {
    idle = advanceEngineDrive(idle, PROPELLER_ENGINE, 0, false, { throttle: 0 }, i / 60, 1 / 60);
    full = advanceEngineDrive(full, PROPELLER_ENGINE, 1, false, { throttle: 1 }, i / 60, 1 / 60);
  }
  assert.ok(Math.abs(idle.rpm - 560) < 20, `idles near 560 rpm (${idle.rpm})`);
  assert.ok(full.rpm > 1350 && full.rpm <= 1600, `full power swings up to a deep 1.35-1.6k rpm (${full.rpm})`);
  let slow = initialEngineDrive(PROPELLER_ENGINE);
  slow = advanceEngineDrive(slow, PROPELLER_ENGINE, 1, false, { throttle: 1 }, 0, .1);
  assert.ok(slow.rpm < 900, 'heavy propellers take time to spool up');
});
