import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BTN, WEAPONS, VEHICLE, multiplyRotations, rotationFromEuler, rotateVector } from '@shared/index';
import { InputTracker } from '../src/input.js';
import { Game } from '../../server/src/game.js';

type Listener = EventListenerOrEventListenerObject;

class FakeTarget {
  private readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      if (typeof listener === 'function') listener(event as unknown as Event);
      else listener.handleEvent(event as unknown as Event);
    }
  }
}

class FakeDocument extends FakeTarget {
  pointerLockElement: unknown = null;
  hidden = false;
}

class FakeCanvas extends FakeTarget {
  constructor(private readonly doc: FakeDocument) {
    super();
  }

  requestPointerLock(): void {
    this.doc.pointerLockElement = this;
    this.doc.emit('pointerlockchange');
  }
}

function key(code: string): Record<string, unknown> {
  return { code, repeat: false, preventDefault(): void {} };
}

function withInput(check: (input: InputTracker, doc: FakeDocument, win: FakeTarget, canvas: FakeCanvas) => void): void {
  const doc = new FakeDocument(), win = new FakeTarget(), canvas = new FakeCanvas(doc);
  const prior = new Map(['document', 'window', 'localStorage'].map(name =>
    [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: doc },
    window: { configurable: true, value: win },
    localStorage: { configurable: true, value: { getItem: () => null, setItem: () => {} } },
  });
  try { check(new InputTracker(canvas as unknown as HTMLCanvasElement), doc, win, canvas); }
  finally {
    for (const [name, descriptor] of prior) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

test('hyperspeed is disabled: H does nothing and the server strips the playtest bit', () => {
  withInput((input, doc, _win, canvas) => {
    canvas.emit('click'); doc.emit('keydown', key('KeyH'));
    assert.equal(input.hyper, false); assert.equal(input.sample(1, 0, 0).buttons & BTN.HYPER, 0);
    const game = new Game(1337, { frontier: true }), player = game.addPlayer('Player', null);
    game.queueInput(player, { ...input.sample(2, 0, 0), buttons: BTN.HYPER | BTN.FORWARD }); game.step();
    assert.equal(player.lastCmd!.buttons & BTN.HYPER, 0, 'a modified client cannot turn it on');
  });
});

test('when enabled, H toggles playtest hyperspeed in normal play and ignores repeats, chat and paused input', () => {
  withInput((input, doc, _win, canvas) => {
    input.hyperspeedEnabled = true;
    const toggles: boolean[] = []; input.onHyperToggle = value => toggles.push(value);
    canvas.emit('click');
    doc.emit('keydown', key('KeyH'));
    assert.equal(input.hyper, true); assert.ok(input.sample(1, 0, 0).buttons & BTN.HYPER);
    const game = new Game(1337, { frontier: true, hyperspeed: true }), player = game.addPlayer('Playtester', null);
    game.queueInput(player, input.sample(1, 0, 0)); game.step();
    assert.ok(player.lastCmd!.buttons & BTN.HYPER, 'the live frontier accepts human playtest input');
    doc.emit('keydown', { ...key('KeyH'), repeat: true });
    doc.emit('keydown', { ...key('KeyH'), target: { matches: () => true } });
    assert.deepEqual(toggles, [true]);
    input.setSuspended(true); doc.emit('keydown', key('KeyH'));
    assert.equal(input.sample(2, 0, 0).buttons, 0); assert.equal(input.hyper, true);
    input.setSuspended(false); canvas.emit('click'); doc.emit('keydown', key('KeyH'));
    assert.equal(input.hyper, false); assert.equal(input.sample(3, 0, 0).buttons & BTN.HYPER, 0);
    assert.deepEqual(toggles, [true, false]);
  });
});

test('sub-tick touch and mouse fire taps survive exactly one input sample', () => {
  withInput((input, doc, _win, canvas) => {
    input.setTouchMode(true);
    for (const bit of [BTN.FIRE, BTN.ALTFIRE]) for (let tap = 0; tap < 4; tap++) {
      input.setTouchButton(bit, true);
      input.setTouchButton(bit, false);
      assert.equal(input.firing, false, 'the released finger is not reported as a physical hold');
      assert.equal(input.sample(tap * 2, 0, 0).buttons & bit, bit);
      assert.equal(input.sample(tap * 2 + 1, 0, 0).buttons & bit, 0, 'a tap never becomes continuing automatic fire');
    }
    input.setTouchMode(false); canvas.emit('click');
    for (const [button, bit] of [[0, BTN.FIRE], [2, BTN.ALTFIRE]]) {
      doc.emit('mousedown', { button }); doc.emit('mouseup', { button });
      assert.equal(input.sample(20, 0, 0).buttons & bit, bit);
      assert.equal(input.sample(21, 0, 0).buttons & bit, 0);
    }
  });
});

test('sampled held fire stops immediately on release and cancellation clears unsampled presses', () => {
  withInput((input, doc, win, canvas) => {
    const bits = BTN.FIRE | BTN.ALTFIRE;
    input.setTouchMode(true); input.setTouchButton(bits, true);
    for (let seq = 0; seq < 30; seq++) {
      assert.equal(input.sample(seq, 0, 0).buttons & bits, bits);
      input.setTouchButton(bits, true); // duplicate pointer state is not a new press
    }
    input.setTouchButton(bits, false);
    assert.equal(input.sample(30, 0, 0).buttons & bits, 0);
    for (const cancel of [() => input.releaseTouchControls(), () => input.setTouchMode(false),
      () => win.emit('blur'), () => { doc.hidden = true; doc.emit('visibilitychange'); },
      () => { doc.pointerLockElement = null; doc.emit('pointerlockchange'); }]) {
      input.setTouchMode(true); doc.hidden = false;
      input.setTouchButton(bits, true); input.setTouchButton(bits, false);
      cancel();
      assert.equal(input.sample(31, 0, 0).buttons & bits, 0, 'pause, hiding and capture loss discard pending taps');
    }
    input.setTouchMode(false); canvas.emit('click');
    doc.emit('mousedown', { button: 0 }); doc.emit('mouseup', { button: 0 }); win.emit('blur');
    assert.equal(input.sample(32, 0, 0).buttons & bits, 0, 'blur also discards a pending desktop tap');
    canvas.emit('click'); doc.emit('mousedown', { button: 0 });
    assert.ok(input.sample(33, 0, 0).buttons & BTN.FIRE);
    doc.emit('mouseup', { button: 0 });
    assert.equal(input.sample(34, 0, 0).buttons & BTN.FIRE, 0);
  });
});

test('four rapid touch taps each spend one sidearm round through three-command server catch-up', () => {
  withInput(input => {
    const game = new Game(1337), player = game.addPlayer('Touch taps', null);
    player.fireCd = 0;
    input.setTouchMode(true);
    const before = player.ammo[0].magazine;
    let seq = 1;
    for (let tap = 0; tap < 4; tap++) {
      input.setTouchButton(BTN.FIRE, true); input.setTouchButton(BTN.FIRE, false);
      for (let command = 0; command < 3; command++) game.queueInput(player, input.sample(seq++, 0, 0));
      game.step();
      assert.equal(player.ammo[0].magazine, before - tap - 1, 'the authoritative server receives the tap once');
      for (let tick = 0; tick < 4; tick++) game.step();
      assert.equal(player.ammo[0].magazine, before - tap - 1, 'repeating the released last command cannot repeat the shot');
      // The sidearm cycles on the commands the client keeps sending, as predicted.
      for (let tick = 0; tick < 20; tick++) { game.queueInput(player, input.sample(seq++, 0, 0)); game.step(); }
      assert.equal(player.ammo[0].magazine, before - tap - 1, 'later samples after the release cannot repeat the shot');
    }
  });
});

test('reload taps span catch-up bursts and unlock clears transient actions', () => {
  const doc = new FakeDocument();
  const win = new FakeTarget();
  const canvas = new FakeCanvas(doc);
  const storage = new Map<string, string>();
  const prior = {
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
    window: Object.getOwnPropertyDescriptor(globalThis, 'window'),
    localStorage: Object.getOwnPropertyDescriptor(globalThis, 'localStorage'),
  };

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: doc },
    window: { configurable: true, value: win },
    localStorage: {
      configurable: true,
      value: {
        getItem: (name: string) => storage.get(name) ?? null,
        setItem: (name: string, value: string) => storage.set(name, value),
      },
    },
  });

  try {
    const input = new InputTracker(canvas as unknown as HTMLCanvasElement);
    canvas.emit('click');
    assert.equal(input.isLocked, true);

    doc.emit('keydown', key('Digit5'));
    assert.equal(input.sample(0, 0, 0).weapon, 4);
    doc.emit('keydown', key('Digit7'));
    assert.equal(input.sample(0, 0, 0).weapon, 6, 'cave weapon slots are selectable');
    doc.emit('keydown', key('Digit8'));
    assert.equal(input.sample(0, 0, 0).weapon, 7, 'key8 reaches the burst carbine');
    doc.emit('keydown', key('Digit9'));
    assert.equal(input.sample(0, 0, 0).weapon, 8, 'key9 reaches the flechette repeater');
    doc.emit('keydown', key('Digit0'));
    assert.equal(input.sample(0, 0, 0).weapon, 9, 'key0 reaches the tenth weapon');
    doc.emit('keydown', key('Digit99'));
    assert.equal(input.sample(0, 0, 0).weapon, 9, 'out-of-range number keys leave the weapon unchanged');
    input.setWeaponAvailability(WEAPONS.map((_, id) => [0, 7, 8, 9].includes(id)));
    // Touch's WEAPON button and desktop wheel use this same cycle operation.
    for (const expected of [0, 7, 8, 9]) {
      input.cycleWeapon();
      assert.equal(input.sample(0, 0, 0).weapon, expected, 'cycle reaches every carried new weapon');
    }
    input.cycleWeapon(-1);
    assert.equal(input.sample(0, 0, 0).weapon, 8);
    doc.emit('keydown', key('Digit7'));
    assert.equal(input.sample(0, 0, 0).weapon, 8, 'unfound cave weapons remain skipped');
    input.setWeaponAvailability(WEAPONS.map(() => true));
    doc.emit('keydown', key('KeyE'));
    for (let tick = 0; tick < 245; tick++) {
      assert.equal(input.using, true, 'keyboard E stays physically held through a four-second recall');
      assert.ok(input.sample(tick, 0, 0).buttons & BTN.USE);
    }
    doc.emit('keyup', key('KeyE'));
    assert.equal(input.using, false);
    assert.equal(input.sample(246, 0, 0).buttons & BTN.USE, 0);
    doc.emit('keydown', key('Digit1'));
    assert.equal(input.sample(0, 0, 0).weapon, 0);

    // Even if keyup occurs before the first fixed-tick sample, every command
    // in the maximum catch-up burst carries the reload level.
    doc.emit('keydown', key('KeyR'));
    doc.emit('keyup', key('KeyR'));
    for (let seq = 1; seq <= 8; seq++) {
      assert.ok((input.sample(seq, 0, 0).buttons & BTN.RELOAD) !== 0);
    }
    assert.equal(input.sample(9, 0, 0).buttons & BTN.RELOAD, 0);

    // A physically held key continues past the minimum pulse.
    doc.emit('keydown', key('KeyR'));
    for (let seq = 10; seq < 20; seq++) {
      assert.ok((input.sample(seq, 0, 0).buttons & BTN.RELOAD) !== 0);
    }
    doc.emit('keyup', key('KeyR'));
    assert.equal(input.sample(20, 0, 0).buttons & BTN.RELOAD, 0);

    // Queue every transient action, then release pointer lock without the
    // corresponding mouse/key-up events.
    doc.emit('mousedown', { button: 0 });
    doc.emit('keydown', key('KeyW'));
    doc.emit('keyup', key('KeyW'));
    doc.emit('keydown', key('KeyW')); // double tap queues dodge
    doc.emit('keydown', key('KeyR'));
    doc.pointerLockElement = null;
    doc.emit('pointerlockchange');

    const afterUnlock = input.sample(21, 0, 0).buttons;
    assert.equal(
      afterUnlock & (BTN.FIRE | BTN.DODGE | BTN.RELOAD | BTN.FORWARD),
      0,
    );

    // Clearing the tap history prevents a stale pre-unlock tap from turning
    // the first movement key after reacquiring focus into a dodge.
    canvas.emit('click');
    doc.emit('keydown', key('KeyW'));
    const afterRelock = input.sample(22, 0, 0).buttons;
    assert.ok((afterRelock & BTN.FORWARD) !== 0);
    assert.equal(afterRelock & BTN.DODGE, 0);
    // Simulate losing browser capture before its change event is delivered.
    doc.pointerLockElement = null;
    assert.equal(input.isLocked, true);
    canvas.emit('click');
    assert.equal(doc.pointerLockElement, canvas, 'resume click checks actual capture, not a stale cached flag');
    win.emit('blur');
    assert.equal(input.isLocked, false);
    assert.equal(input.sample(22, 0, 0).buttons & BTN.FORWARD, 0);
    win.emit('focus');
    assert.equal(input.isLocked, true);
    // Space/C are ordinary keys, so holding flight controls never invokes
    // operating-system Shift accessibility shortcuts.
    input.setVehicleMode(3, 1, 0.2);
    doc.emit('keydown', key('Space'));
    assert.equal(input.throttle, 1);
    assert.ok(input.sample(23, 0, 0).buttons & BTN.THROTTLE);
    doc.emit('keydown', key('KeyC'));
    assert.equal(input.throttle, -1);
    assert.ok(input.sample(24, 0, 0).buttons & BTN.BRAKE);
    doc.pointerLockElement = null; doc.emit('pointerlockchange');
    input.setTouchMode(true); canvas.emit('click');
    assert.equal(input.isLocked, false, 'touch activation must not request pointer lock');
    input.setTouchButton(BTN.THROTTLE | BTN.LEFT, true);
    input.setTouchButton(BTN.FIRE, true);
    input.setTouchButton(BTN.USE, true);
    for (let tick = 0; tick < 245; tick++) {
      assert.equal(input.using, true);
      assert.ok(input.sample(tick, 0, 0).buttons & BTN.USE, 'touch ENTER supports a held recall');
    }
    input.setTouchButton(BTN.USE, false);
    assert.equal(input.using, false);
    assert.equal(input.sample(246, 0, 0).buttons & BTN.USE, 0);
    assert.equal(input.throttle, 1);
    assert.equal(input.steering, 1);
    const touch = input.sample(25, 0, 0);
    assert.equal(touch.buttons & (BTN.THROTTLE | BTN.LEFT | BTN.FIRE), BTN.THROTTLE | BTN.LEFT | BTN.FIRE);
    input.addTouchLook(100, -40);
    input.followJet(1.3, 0.4);
    const localLook = rotationFromEuler(-100 * input.sensitivity, 40 * input.sensitivity);
    const expectedLook = multiplyRotations(rotationFromEuler(1.3, .4), localLook);
    assert.deepEqual(input.viewRotation, expectedLook,
      'mouse and touch look offsets stay in the aircraft frame, rather than adding world Euler angles');
    const flightInput = input.sample(247, 0, 0).buttons;
    for (let step = 0; step <= 180; step++) {
      const aircraft = rotationFromEuler(.6, step * Math.PI / 45, .7);
      input.followJet(0, 0, 0, aircraft);
      const expected = multiplyRotations(aircraft, localLook);
      assert.deepEqual(input.viewRotation, expected, 'look remains relative during two complete loops');
      assert.equal(input.sample(248 + step, 0, 0).buttons, flightInput, 'looking never changes flight controls');
      const aim = rotateVector(expected, 0, 0, -1);
      assert.ok(Math.abs(input.pitch - Math.atan2(aim.y, Math.hypot(aim.x, aim.z))) < 1e-12);
    }
    input.setVehicleMode(VEHICLE.NONE, 0);
    const inverted = rotationFromEuler(.4, Math.PI, .3);
    input.setVehicleMode(VEHICLE.JET, 0, 0, 0, inverted);
    assert.deepEqual(input.viewRotation, inverted, 'entering an inverted jet defaults to its forward view');
    input.setWeaponAvailability(WEAPONS.map((_, id) => id === 0 || id === 2));
    input.weapon = 0; input.cycleWeapon(); assert.equal(input.weapon, 2);
    input.cycleWeapon(-1); assert.equal(input.weapon, 0);
    win.emit('blur');
    assert.equal(input.sample(26, 0, 0).buttons & (BTN.THROTTLE | BTN.LEFT | BTN.FIRE), 0,
      'touch controls must release even when touchend is lost');
  } finally {
    for (const [name, descriptor] of Object.entries(prior)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
});

test('aircraft gunner camera stays inside its downward cone through inverted flight and never steers',()=>{
 withInput((input,doc,_win,canvas)=>{
  canvas.emit('click');const q=rotationFromEuler(.7,2.1,1.6);
  input.setVehicleMode(VEHICLE.JET,.7,2.1,1.6,q,1);
  let dir=rotateVector(input.viewRotation,0,0,-1),down=rotateVector(q,0,-1,0);
  assert.ok(Math.hypot(dir.x-down.x,dir.y-down.y,dir.z-down.z)<1e-9,'entry looks straight out the underbelly');
  for(let i=0;i<300;i++) {
   input.addTouchLook(Math.sin(i)*240,Math.cos(i)*190);
   const attitude=rotationFromEuler(i*.03,i*.07,i*.11);input.followJet(0,0,0,attitude);
   dir=rotateVector(input.viewRotation,0,0,-1);down=rotateVector(attitude,0,-1,0);
   assert.ok(dir.x*down.x+dir.y*down.y+dir.z*down.z>=Math.cos(Math.PI/9)-1e-9);
  }
  for(const code of ['KeyW','KeyA','Space','KeyC'])doc.emit('keydown',key(code));
  input.setTouchButton(BTN.RIGHT|BTN.FORWARD|BTN.THROTTLE|BTN.FIRE,true);
  const cmd=input.sample(1,0,0);assert.equal(cmd.buttons&(BTN.RIGHT|BTN.LEFT|BTN.FORWARD|BTN.THROTTLE|BTN.BRAKE|BTN.JUMP),0);
  assert.ok(cmd.buttons&BTN.FIRE);assert.equal(input.throttle,0);assert.equal(input.steering,0);
  input.setVehicleMode(VEHICLE.JET,0,0,0,rotationFromEuler(0,0),0);
  dir=rotateVector(input.viewRotation,0,0,-1);assert.ok(dir.z<-.9999,'returning to pilot resets to nose view');
  assert.ok(input.sample(2,0,0).buttons&BTN.FORWARD,'driver controls are restored');
 });
});

test('context USE interception covers keyboard and touch without leaking an enter command',()=>{
 withInput((input,doc,_win,canvas)=>{
  canvas.emit('click');let interactions=0;input.onUse=()=>{interactions++;return true;};
  doc.emit('keydown',key('KeyE'));input.setTouchButton(BTN.USE,true);input.setTouchButton(BTN.USE,false);
  assert.equal(interactions,2);assert.equal(input.sample(0,0,0).buttons&BTN.USE,0);assert.equal(input.using,false);
  input.onUse=()=>false;input.setTouchButton(BTN.USE,true);assert.ok(input.sample(1,0,0).buttons&BTN.USE);
  input.setVehicleMode(VEHICLE.TANK,0,0,0,undefined,2);input.setTouchButton(BTN.FORWARD|BTN.FIRE,true);
  assert.equal(input.sample(2,0,0).buttons&BTN.FORWARD,0,'fixed artillery cannot drive away');
 });
});

test('M toggles navigation once per press and stays inactive while typing or suspended',()=>{
 withInput((input,doc)=>{
  let toggles=0;input.onToggleMap=()=>toggles++;
  doc.emit('keydown',key('KeyM'));doc.emit('keydown',{...key('KeyM'),repeat:true});
  assert.equal(toggles,1);
  doc.emit('keydown',{...key('KeyM'),target:{matches:()=>true}});assert.equal(toggles,1);
  input.setSuspended(true);doc.emit('keydown',key('KeyM'));assert.equal(toggles,1);
 });
});
