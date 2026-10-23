import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TICK_RATE } from '@shared/constants';
import type { CampaignBase, Faction, Territory } from '@shared/frontier';
import { CampaignDirector } from '../src/campaign-director.js';
import { Game, ServerPlayer } from '../src/game.js';

function fixture(count = 48) {
  const bases: CampaignBase[] = [], controls: Territory[] = [];
  for (let i = 0; i < 12; i++) {
    const owner: Faction = i < 3 ? (i + 1) as Faction : 0;
    const base: CampaignBase = { id: `base-${i}`, name: `Sector ${i}`, kind: i < 3 ? 'outpost' : 'city',
      x: i < 3 ? i * 800 : (i - 2) * 2400, y: 0, z: i < 3 ? 0 : 1800,
      owner, homeFaction: owner, controlIds: [], requiredPoints: 2 };
    for (let point = 0; point < 3; point++) {
      const id = `${base.id}-${point}`; base.controlIds.push(id);
      controls.push({ id, name: id, baseId: base.id, kind: 'city', x: base.x + point * 180, y: 0, z: base.z,
        owner, radius: 40, influence: owner === 1 ? -1 : owner ? 1 : 0, captureFaction: owner, captureProgress: owner ? 1 : 0, contested: false });
    }
    bases.push(base);
  }
  const players = Array.from({ length: count }, (_, i) => {
    const player = new ServerPlayer(0x100000000 + i, `Soldier ${i}`, null, true, { x: 0, y: 0, z: 0 });
    player.botRosterIndex = i; player.faction = (i % 3 + 1) as Faction;
    return player;
  });
  const director = new CampaignDirector(bases, controls);
  const order = (player: ServerPlayer, tick = 0) => director.order(player, () => players, tick)!;
  return { bases, controls, players, director, order };
}

test('whole squads share stable operations while three squads spread beyond the starting battle', () => {
  const { director, players, order, bases } = fixture();
  director.update(players, 0);
  for (const faction of [1, 2, 3]) {
    const allies = players.filter(p => p.faction === faction), orders = allies.map(p => order(p));
    assert.equal(new Set(orders.map(o => o.baseId)).size, 3, 'each of the three squads gets its own operation');
    assert.ok(orders.some(o => bases.find(b => b.id === o.baseId)!.x > 2400), 'an expedition leaves the starting cluster');
    for (const squad of new Set(orders.map(o => o.squad)))
      assert.equal(new Set(orders.filter(o => o.squad === squad).map(o => o.targetId)).size, 1);
  }
  const initial = players.map(p => order(p).baseId);
  director.update(players, 10 * TICK_RATE);
  assert.deepEqual(players.map(p => order(p, 10 * TICK_RATE).baseId), initial, 'quiet reassessment does not interrupt journeys');
});

test('two assault squads retain distinct controls across reassessments and respond to ownership and threats', () => {
  const { director, players, order, controls, bases } = fixture(72);
  // Four faction squads allow two assault slots; the others remain garrisons.
  for (const base of bases) base.owner = 1;
  for (const site of controls) Object.assign(site, { owner: 1, captureFaction: 1, captureProgress: 1 });
  const base = bases[6]; base.owner = 0;
  const sites = controls.filter(site => site.baseId === base.id);
  controls.splice(controls.indexOf(sites.pop()!), 1);
  base.controlIds = sites.map(site => site.id);
  for (const site of sites) Object.assign(site, { owner: 0, captureFaction: 0, captureProgress: 0 });
  for (const enemy of players.filter(player => player.faction === 2).slice(0, 7))
    Object.assign(enemy.state, { px: base.x, pz: base.z + 600 });
  director.update(players, 0);
  const attackers = players.filter(player => player.faction === 1 && order(player).baseId === base.id);
  assert.equal(new Set(attackers.map(player => order(player).squad)).size, 2);
  const initial = attackers.map(player => order(player).targetId);
  assert.equal(new Set(initial).size, 2, 'both eligible controls receive a squad');
  for (let tick = 2 * TICK_RATE; tick <= 20 * TICK_RATE; tick += 2 * TICK_RATE) {
    director.update(players, tick);
    assert.deepEqual(attackers.map(player => order(player, tick).targetId), initial,
      'quiet target retention must not be negated by the second squad assignment');
  }
  Object.assign(sites[0], { owner: 1, captureFaction: 1, captureProgress: 1 });
  director.update(players, 20 * TICK_RATE + 1);
  assert.ok(attackers.every(player => order(player, 20 * TICK_RATE + 1).targetId === sites[1].id),
    'securing a control redirects the assault to the remaining enemy control');
  sites[0].pressureFaction = 2;
  director.update(players, 20 * TICK_RATE + 2);
  assert.ok(attackers.every(player => {
    const operation = order(player, 20 * TICK_RATE + 2);
    return operation.targetId === sites[0].id && operation.phase === 'defend';
  }), 'a threatened holding immediately interrupts the retained assault');
});

test('a single distant foothold attracts support and enemy pressure gets both attackers and defenders', () => {
  const { director, players, order, controls, bases } = fixture();
  director.update(players, 0);
  const base = bases[10], site = controls.find(t => t.baseId === base.id)!;
  site.owner = 1; site.captureFaction = 1; site.captureProgress = 1; site.influence = -1;
  director.update(players, TICK_RATE);
  assert.ok(players.some(p => p.faction === 1 && order(p, TICK_RATE).baseId === base.id), 'a one-point foothold merits an expedition before spawn unlock');
  site.pressureFaction = 2; site.progressRate = -.01;
  director.update(players, 2 * TICK_RATE);
  const defenders = players.filter(p => p.faction === 1 && order(p, 2 * TICK_RATE).baseId === base.id);
  const attackers = players.filter(p => p.faction === 2 && order(p, 2 * TICK_RATE).baseId === base.id);
  assert.ok(defenders.length && attackers.length, 'both factions respond to the faraway assault');
  assert.ok(defenders.every(p => order(p, 2 * TICK_RATE).phase === 'defend' && order(p, 2 * TICK_RATE).targetId === site.id));
  assert.ok(defenders.length <= 6 && attackers.length <= 6, 'one incident cannot pull the entire faction away');
  site.owner = 0; site.captureProgress = 0; site.captureFaction = 0; site.influence = 0;
  director.update(players, 3 * TICK_RATE);
  assert.ok(defenders.some(p => order(p, 3 * TICK_RATE).baseId === base.id), 'neutralizing the flag does not erase the defense response');
});

test('192 bots retain distinct roster squads and bounded deployment around one hot city', () => {
  const { director, players, order, controls, bases } = fixture(192);
  const base = bases[4], sites = controls.filter(t => t.baseId === base.id);
  for (const site of sites) { site.owner = 1; site.captureFaction = 1; site.captureProgress = 1; site.influence = -1; }
  base.owner = 1; sites[0].pressureFaction = 2;
  for (const enemy of players.filter(p => p.faction === 2).slice(0, 14)) Object.assign(enemy.state, { px: sites[0].x, pz: sites[0].z });
  director.update(players, 0);
  const allies = players.filter(p => p.faction === 1), orders = allies.map(p => order(p));
  assert.equal(new Set(orders.map(o => o.squad)).size, 11, 'squad IDs do not wrap after three groups');
  assert.ok(orders.filter(o => o.baseId === base.id).length <= 12, 'even heavy pressure draws no more than two squads');
  assert.ok(new Set(orders.map(o => o.baseId)).size >= 7, 'the rest of the army continues the planetary campaign');
});

test('a secured distant city keeps a garrison before the squad moves onward', () => {
  const { director, players, order, controls, bases } = fixture();
  director.update(players, 0);
  const base = bases[9];
  for (const site of controls.filter(t => t.baseId === base.id)) {
    site.owner = 1; site.captureFaction = 1; site.captureProgress = 1; site.influence = -1;
  }
  base.owner = 1; director.update(players, TICK_RATE);
  assert.ok(players.some(p => p.faction === 1 && order(p, TICK_RATE).baseId === base.id && order(p, TICK_RATE).phase === 'defend'));
  director.update(players, 90 * TICK_RATE);
  assert.ok(players.filter(p => p.faction === 1).every(p => order(p, 90 * TICK_RATE).baseId !== base.id), 'quiet garrisons eventually resume expansion');
});

test('unassigned fragmented squads reassess once per interval and react to territory changes', t => {
  const { director, players, order, controls, bases } = fixture();
  for (const [index, player] of players.entries()) { player.faction = 1; player.botRosterIndex = index * 18; }
  for (const base of bases) base.owner = 0;
  for (const site of controls) { site.owner = 0; site.captureFaction = 0; site.captureProgress = 0; }
  const auctions = t.mock.method(director as unknown as {
    assign(faction: Faction, actors: readonly ServerPlayer[], tick: number): void;
  }, 'assign');
  director.update(players, 0);
  const missing = players.filter(player => !order(player));
  assert.ok(missing.length > 12, 'fragmented roster exceeds every available attack slot');
  for (let tick = 1; tick < 2 * TICK_RATE; tick++) for (const player of players) order(player, tick);
  assert.equal(auctions.mock.callCount(), 3, 'thousands of order lookups reuse the assessed misses');

  for (const player of missing) order(player, 2 * TICK_RATE);
  assert.equal(auctions.mock.callCount(), 6, 'the first expired miss refreshes all squads only once');
  const arrival = new ServerPlayer(0x200000000, 'New expedition', null, true, { x: 0, y: 0, z: 0 });
  arrival.faction = 1; arrival.botRosterIndex = 9000; players.push(arrival);
  for (let call = 0; call < 100; call++) order(arrival, 2 * TICK_RATE);
  assert.equal(auctions.mock.callCount(), 9, 'a newly arriving squad is considered immediately, then its miss is cached');

  const site = controls.find(point => point.baseId === bases[8].id)!;
  site.owner = 1; site.captureFaction = 1; site.captureProgress = 1; site.pressureFaction = 2;
  director.update(players, 2 * TICK_RATE + 1);
  assert.ok(players.some(player => order(player, 2 * TICK_RATE + 1)?.targetId === site.id &&
    order(player, 2 * TICK_RATE + 1)?.phase === 'defend'), 'a new threatened foothold interrupts the interval');
  assert.equal(auctions.mock.callCount(), 12);
  bases[8].owner = 1;
  for (const point of controls.filter(point => point.baseId === bases[8].id)) {
    point.owner = 1; point.captureFaction = 1; point.captureProgress = 1; point.pressureFaction = 0;
  }
  director.update(players, 2 * TICK_RATE + 2);
  assert.ok(players.every(player => order(player, 2 * TICK_RATE + 2)), 'new holdings provide garrison orders to previously unassigned squads');
  assert.equal(auctions.mock.callCount(), 15);
  director.reset();
  assert.ok(order(arrival, 2 * TICK_RATE + 2));
  assert.equal(auctions.mock.callCount(), 18, 'reset discards the assessment cache');
});

test('auction invariant precomputation preserves deterministic assignments and staging', () => {
  const fingerprints: string[] = [];
  for (const count of [48, 192, 216]) {
    const { director, players, order, controls, bases } = fixture(count);
    let seed = 7231 + count;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (const base of bases) {
      base.x = Math.floor(random() * 7000); base.z = Math.floor(random() * 7000);
      for (const site of controls.filter(site => site.baseId === base.id)) {
        site.x = base.x + Math.floor(random() * 180); site.z = base.z + Math.floor(random() * 180);
      }
    }
    // Include partial cohorts, regrouped arrivals, nearby sectors, and dead
    // members. These exercise both the auction and its garrison fallback.
    for (const [index, player] of players.entries()) {
      const base = bases[Math.floor(random() * bases.length)];
      Object.assign(player.state, { px: base.x + random() * 500, pz: base.z + random() * 500, alive: index % 13 !== 0 });
      if (index >= count - 6) player.botRosterIndex! += 180;
    }
    const trace: unknown[] = [];
    const record = (tick: number) => {
      director.update(players, tick);
      trace.push(players.map(player => order(player, tick)));
    };
    record(0); record(10 * TICK_RATE);
    const foothold = controls.find(site => site.baseId === bases[8].id)!;
    foothold.owner = 1; foothold.captureFaction = 1; foothold.captureProgress = 1; foothold.pressureFaction = 2;
    record(11 * TICK_RATE);
    foothold.owner = 0; foothold.captureFaction = 2; foothold.captureProgress = .4;
    record(12 * TICK_RATE);
    for (const base of bases) base.owner = 1;
    for (const site of controls) { site.owner = 1; site.captureFaction = 1; site.captureProgress = 1; site.pressureFaction = 0; }
    record(20 * TICK_RATE); record(130 * TICK_RATE);
    fingerprints.push(createHash('sha256').update(JSON.stringify(trace)).digest('hex'));
  }
  // Recorded from the original auction before invariant precomputation. Hash
  // every full order, including target, phase, squad, and staging coordinates.
  assert.deepEqual(fingerprints, [
    'b2271ff203edf4010709ae8034355f62ec797c9f4af7b5348776a286c8a42569',
    '733d2e9a536ccfa03f5ea5363cc6da394f98b66d5c5a3334ba7e32ad75fc29ec',
    '0ab14da7fb507840cf04720f3d6a9de3831550647382d142ef288bd1ca2ec78f',
  ]);
});

test('threatened Vesper defenders respawn at its safe held approach and attack-start alerts are bounded', () => {
  const game = new Game(1337, { frontier: true }), frontier = game.frontier!;
  const bots = Array.from({ length: 48 }, (_, i) => game.addPlayer(`Bot ${i}`, null, true));
  const vesper = frontier.bases.find(b => b.id === 'base-city-2')!;
  const sites = frontier.territories.filter(t => t.baseId === vesper.id);
  const attacker = game.addPlayer('Vesper raider', null); attacker.faction = 1;
  Object.assign(attacker.state, { px: sites[0].x, py: sites[0].y, pz: sites[0].z });
  const alerts: string[] = []; frontier.campaignAlert = alert => alerts.push(alert.message);
  frontier.step(game.players.values(), 1, .2);
  const defender = bots.find(p => p.faction === 2 && frontier.order(p)?.baseId === vesper.id)!;
  assert.ok(defender, 'the distant assault recruits a defending squad');
  assert.equal(frontier.order(defender)?.targetId, sites[0].id);
  (game as unknown as { kill(p: ServerPlayer, a: ServerPlayer, weapon: number): void }).kill(defender, defender, 255);
  game.tick = defender.respawnAtTick;
  (game as unknown as { updateRespawnsAndRegen(): void }).updateRespawnsAndRegen();
  assert.ok(defender.state.alive);
  assert.ok(Math.hypot(defender.state.px - vesper.x, defender.state.pz - vesper.z) < 1500, 'safe Vesper ownership beats the old Meridian spawn bias');
  for (let tick = game.tick; tick < game.tick + 25 * TICK_RATE; tick += 12) frontier.step(game.players.values(), tick, .2);
  assert.equal(alerts.filter(text => text.includes('Vesper Reach')).length, 1, 'one sustained assault announces once');
  assert.ok(alerts[0].includes('on Meridian') && alerts[0].includes('Terran Accord'));
});
