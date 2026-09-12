import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PICKUP_AMMO, PICKUP_HEALTH,
  PICKUP_RESULT_COLLECTED, PICKUP_RESULT_FULL,
  type PickupResultEvent,
} from '@shared/index';
import { Hud, formatAmmoReserve, formatPickupResult } from '../src/hud.js';

test('mounted HUD replaces carried ammo and reload state, then restores the on-foot display', () => {
  class Element {
    textContent = '';
    className = '';
    title = '';
    style: Record<string, string> = {};
    children: Element[] = [];
    classes = new Set<string>();
    classList = {
      toggle: (name: string, active: boolean) => active ? this.classes.add(name) : this.classes.delete(name),
      remove: (name: string) => this.classes.delete(name),
    };
    appendChild(child: Element) { this.children.push(child); }
  }
  const nodes = new Map<string, Element>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, new Element());
    return nodes.get(id)!;
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    getElementById: node, createElement: () => new Element(),
  } });
  try {
    const hud = new Hud();
    hud.setWeapon(0);
    hud.setAmmo(0, 12, true);
    hud.setWeaponAvailability([true, false]);
    hud.setReload(true, .4);
    hud.setMountedWeapon('Ventral Rocket');
    assert.equal(node('weapon-name').textContent, 'Ventral Rocket');
    assert.equal(node('ammo-mag').textContent, '\u221e');
    assert.equal(node('ammo').classes.has('empty'), false);
    assert.equal(node('weapon-slots').style.display, 'none');
    assert.equal(node('ammo-sep').style.display, 'none');
    assert.equal(node('ammo-reserve').style.display, 'none');
    assert.equal(node('cd-track').style.display, 'none');
    assert.equal(node('reload-label').textContent, '');
    assert.equal(node('reload-track').classes.has('active'), false);
    hud.setMountedWeapon('Leviathan Nuclear Artillery', false);
    assert.equal(node('ammo-mag').textContent, '--');
    hud.setWeapon(0);
    hud.setAmmo(12, 30, true);
    hud.setReload(false, 0);
    assert.equal(node('weapon-name').textContent, 'Sidearm');
    assert.equal(node('ammo-mag').textContent, '12');
    assert.equal(node('ammo-reserve').textContent, '30');
    for (const id of ['weapon-slots', 'ammo-sep', 'ammo-reserve', 'cd-track']) assert.equal(node(id).style.display, '');
    assert.equal(node('weapon-slots').children[1].style.display, 'none', 'hidden carried slots remain unavailable');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  }
});

test('infinite reserve has a clear HUD representation without a numeric sentinel', () => {
  assert.equal(formatAmmoReserve(0, true, true), '\u221e');
  assert.equal(formatAmmoReserve(65535, true, true), '\u221e');
});

test('finite and dead reserve displays remain unchanged', () => {
  assert.equal(formatAmmoReserve(17, false, true), '17');
  assert.equal(formatAmmoReserve(-2, false, true), '0');
  assert.equal(formatAmmoReserve(17, false, false), '--');
  assert.equal(formatAmmoReserve(0, true, false), '--');
});

function pickupResult(
  overrides: Partial<PickupResultEvent> = {},
): PickupResultEvent {
  return {
    pickupId: 41,
    kind: PICKUP_HEALTH,
    weapon: -1,
    result: PICKUP_RESULT_COLLECTED,
    amount: 20,
    ...overrides,
  };
}

test('pickup result formatter reports exact health gains and full health', () => {
  assert.equal(formatPickupResult(pickupResult()), '+20 health');
  assert.equal(
    formatPickupResult(pickupResult({ amount: 12.5 })),
    '+12.5 health',
  );
  assert.equal(
    formatPickupResult(pickupResult({
      result: PICKUP_RESULT_FULL,
      amount: 0,
    })),
    'Health already full',
  );
});

test('pickup result formatter names weapon ammo gains and full reserves', () => {
  assert.equal(
    formatPickupResult(pickupResult({
      kind: PICKUP_AMMO,
      weapon: 3,
      amount: 5,
    })),
    '+5 Rocket Launcher ammo',
  );
  assert.equal(
    formatPickupResult(pickupResult({
      kind: PICKUP_AMMO,
      weapon: 4,
      result: PICKUP_RESULT_FULL,
      amount: 0,
    })),
    'Grenade Launcher ammo full',
  );
});

test('pickup result formatter safely handles unknown protocol values', () => {
  assert.equal(
    formatPickupResult(pickupResult({
      kind: PICKUP_AMMO,
      weapon: 99,
      amount: 3,
    })),
    '+3 ammo',
  );
  assert.equal(
    formatPickupResult(pickupResult({
      kind: 99 as PickupResultEvent['kind'],
      amount: 7,
    })),
    '+7 resource',
  );
  assert.equal(
    formatPickupResult(pickupResult({
      result: 99 as PickupResultEvent['result'],
    })),
    'Pickup unavailable',
  );
});
