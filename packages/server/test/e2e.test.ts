import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
import {
  ByteReader, Msg, decodeSnapshot, decodeWelcome, encodeHello, encodeInput,
  BTN, ENT_PROJECTILE, WEAPONS, type Snapshot, type WelcomeMsg,
} from '@shared/index';

// Full end-to-end: boot the real server, connect a real WebSocket client,
// play for a couple of seconds, verify the netcode round-trips.

test('a live client can join, move, shoot, and receive snapshots', async () => {
  const server = await startServer({
    port: 0,
    targetPopulation: 3,
    log: false,
    clientDir: '.',
  });

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    ws.binaryType = 'arraybuffer';

    const state: { welcome: WelcomeMsg | null; scoreRows: number } = { welcome: null, scoreRows: 0 };
    const snapshots: Snapshot[] = [];
    let sawOwnGrenade = false;
    let sawGrenadeAmmoSpend = false;

    ws.on('message', (data) => {
      const r = new ByteReader(data as ArrayBuffer);
      const type = r.u8();
      if (type === Msg.SWelcome) state.welcome = decodeWelcome(r);
      else if (type === Msg.SSnapshot) {
        const snap = decodeSnapshot(r);
        snapshots.push(snap);
        if (state.welcome && snap.ents.some(
          (e) => e.kind === ENT_PROJECTILE &&
            e.owner === state.welcome!.yourId &&
            e.weapon === 4,
        )) {
          sawOwnGrenade = true;
        }
        if ((snap.you.ammo[4]?.magazine ?? WEAPONS[4].magazineSize) <
            WEAPONS[4].magazineSize) {
          sawGrenadeAmmoSpend = true;
        }
      }
      else if (type === Msg.SScores) state.scoreRows = Math.max(state.scoreRows, r.u8());
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    ws.send(encodeHello('E2E-Probe'));

    // Send ~2.5s of inputs at 60Hz: run forward and fire the grenade launcher.
    let seq = 0;
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        seq++;
        const lastTick = snapshots.length ? snapshots[snapshots.length - 1].tick : 0;
        ws.send(encodeInput({
          seq,
          buttons: BTN.FORWARD | BTN.FIRE | (seq % 40 === 0 ? BTN.JUMP : 0),
          weapon: 4,
          yaw: (seq * 0.01) % (Math.PI * 2),
          pitch: 0.2,
          renderTick: Math.max(0, lastTick - 6),
          renderFrac: 0,
        }));
        if (seq >= 150) {
          clearInterval(timer);
          resolve();
        }
      }, 16);
    });

    // Allow trailing snapshots to arrive.
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(state.welcome, 'welcome received');
    assert.ok(state.welcome.yourId > 0);
    assert.ok(snapshots.length >= 40, `expected a steady snapshot stream, got ${snapshots.length}`);

    const last = snapshots[snapshots.length - 1];
    assert.ok(last.lastSeq >= 120, `server consumed our inputs (lastSeq=${last.lastSeq})`);
    assert.ok(Number.isFinite(last.you.px) && Number.isFinite(last.you.py));
    assert.ok(last.you.py > -80, 'player is inside the world');
    assert.ok(last.you.alive || last.you.health === 0, 'consistent alive/health');
    assert.ok(state.scoreRows >= 3, `scoreboard lists the target population, including the human replacing a bot (got ${state.scoreRows} rows)`);
    assert.equal(last.you.ammo.length, WEAPONS.length);
    for (let i = 0; i < WEAPONS.length; i++) {
      assert.ok(last.you.ammo[i].magazine >= 0);
      assert.ok(last.you.ammo[i].magazine <= WEAPONS[i].magazineSize);
      assert.ok(last.you.ammo[i].reserve >= 0);
      assert.ok(last.you.ammo[i].reserve <= WEAPONS[i].reserveSize);
    }
    assert.ok(Number.isFinite(last.you.reloadCooldown));

    // We held FIRE the whole time - the weapon must have cycled.
    assert.ok(server.game.stats.shotsFired > 0, 'shots were fired server-side');
    assert.ok(sawOwnGrenade, 'weapon 5 produced a replicated grenade projectile');
    assert.ok(sawGrenadeAmmoSpend, 'weapon 5 consumed authoritative magazine ammo');

    // Movement: with FORWARD held for 2.5s we must have moved.
    const first = snapshots[0];
    const moved = Math.hypot(last.you.px - first.you.px, last.you.pz - first.you.pz);
    assert.ok(moved > 3, `player should have moved (moved ${moved.toFixed(1)}m)`);

    ws.close();
  } finally {
    await server.close();
  }
});
