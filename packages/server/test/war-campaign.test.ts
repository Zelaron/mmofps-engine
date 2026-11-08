import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Game, type ServerPlayer } from '../src/game.js';
import { campaignHomes, campaignLattice } from '../src/campaign-layout.js';
import { capturePlayer, restorePlayer } from '../src/persistence.js';
import { BOT_CAPTURE_WEIGHT, CAPTURE_SECONDS, FINAL_PUSH_SECONDS, STALEMATE_SECONDS, WAR_REDEPLOY_WEAPON, WILDLIFE_WEAPON, warFaction, type Faction, type Territory } from '@shared/frontier';
import { STALEMATE_GRACE_SECONDS, SUPPLY_CUT_SECONDS } from '../src/frontier.js';
import { TICK_RATE } from '@shared/constants';
import { VEHICLE } from '@shared/vehicles';
import { BTN } from '@shared/movement';
import { Msg } from '@shared/protocol';
import { rankForXp, xpForRank, XP_VALUES } from '@shared/progression';

const game = new Game(1337, { frontier: true });
const frontier = game.frontier!;

function stand(player: ServerPlayer, site: Territory): void {
  Object.assign(player.state, { px: site.x, py: site.y, pz: site.z, alive: true, vehicle: 0 });
}
function kill(g: Game, victim: ServerPlayer, attacker: ServerPlayer): void {
  (g as unknown as { kill(p: ServerPlayer, a: ServerPlayer, w: number): void }).kill(victim, attacker, 1);
}
function respawn(g: Game, player: ServerPlayer): void {
  g.tick = Math.max(g.tick, player.respawnAtTick);
  (g as unknown as { updateRespawnsAndRegen(): void }).updateRespawnsAndRegen();
}

test('each faction starts in its own home region and the forward bases face each other kilometres apart', () => {
  for (const faction of [1, 2, 3] as const) {
    const owned = frontier.bases.filter(b => b.owner === faction).map(b => b.kind).sort();
    assert.deepEqual(owned, ['city', 'harbor', 'outpost'], `faction ${faction} home region`);
  }
  const forwards = frontier.bases.filter(b => b.kind === 'outpost');
  for (let i = 0; i < forwards.length; i++) for (let j = i + 1; j < forwards.length; j++)
    assert.ok(Math.hypot(forwards[i].x - forwards[j].x, forwards[i].z - forwards[j].z) > 2500, 'opposing forward bases are separated');
  for (const forward of forwards) for (const city of game.world.collectCities())
    assert.ok(Math.hypot(forward.x - city.x, forward.z - city.z) > city.radius + 250, 'forward bases sit outside the cities');
  assert.equal(frontier.bases.filter(b => !b.owner).length, 3, 'three neutral bases remain to fight over');
});

test('home selection is geometric and the front-line lattice connects every base', () => {
  const homes = campaignHomes([{ id: 0, x: 0, z: 0 }, { id: 1, x: 100, z: 0 }, { id: 2, x: 0, z: 5000, theme: 'vesper' }, { id: 3, x: 5000, z: 0, theme: 'aurelia' }],
    [{ x: -500, z: -500 }, { x: 0, z: 6000 }, { x: 6000, z: 0 }, { x: 2500, z: 2500 }]);
  assert.deepEqual([...homes.cities], [0, 2, 3], 'the most widely spread trio of cities');
  assert.deepEqual([...homes.harbors], [0, 1, 2], 'each home takes the harbor behind it, not the shared middle');
  const lattice = campaignLattice(frontier.bases);
  const seen = new Set<string>(), stack = [frontier.bases[0].id];
  while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); stack.push(...lattice.get(id)!); }
  assert.equal(seen.size, frontier.bases.length);
  for (const [id, neighbors] of lattice) for (const other of neighbors) assert.ok(lattice.get(other)!.includes(id), 'links are symmetric');
});

test('the side that clearly outnumbers the others captures through a contested ring; a narrow lead stalls', () => {
  const g = new Game(1337, { frontier: true }), f = g.frontier!;
  const site = f.territories.find(t => t.owner === 0)!;
  const attackers = [0, 1, 2].map(i => { const p = g.addPlayer(`A${i}`, null, true); p.faction = 1; stand(p, site); return p; });
  const defender = g.addPlayer('D', null, true); defender.faction = 2; stand(defender, site);
  f.step([...attackers, defender], 1, 10);
  assert.equal(site.contested, true);
  assert.equal(site.captureFaction, 1, 'three bots against one make progress');
  const expected = Math.min(3, BOT_CAPTURE_WEIGHT * 2) * 10 / CAPTURE_SECONDS;
  assert.ok(Math.abs(site.captureProgress! - expected) < 1e-9, `progress ${site.captureProgress} vs ${expected}`);
  const before = site.captureProgress!;
  stand(attackers[1], { ...site, x: site.x + 500 }); stand(attackers[2], { ...site, x: site.x + 500 });
  f.step([...attackers, defender], 2, 10);
  assert.equal(site.captureProgress, before, 'one against one is a stalemate');
});

test('a war is won at two thirds of the bases, then every soldier redeploys into rotated home regions', () => {
  const packets: Uint8Array[] = [];
  const g = new Game(1337, { frontier: true }), f = g.frontier!;
  const human = g.addPlayer('Commander', { send: bytes => packets.push(bytes) }); human.faction = 2;
  const bot = g.addPlayer('Rifleman', null, true);
  const winner = 3 as Faction;
  let decided = 0, started = 0;
  const previousDecided = f.warDecided, previousStarted = f.warStarted;
  f.warDecided = war => { decided = war.victor; previousDecided(war); };
  f.warStarted = war => { started = war.number; previousStarted(war); };
  for (const base of f.bases.slice(0, f.victoryBases)) for (const site of f.territories.filter(t => t.baseId === base.id)) {
    site.owner = winner; site.captureFaction = winner; site.captureProgress = 1; site.influence = 1;
  }
  f.step(g.players.values(), 100, .2);
  assert.equal(decided, winner); assert.equal(f.war.victor, winner); assert.equal(f.war.wins[winner], 1);
  assert.ok(human.xp >= XP_VALUES.warService, 'every human earns war pay');
  assert.ok(packets.some(p => p[0] === Msg.SXp), 'rewards are sent immediately');
  f.step(g.players.values(), f.war.resetAt, .2);
  assert.equal(started, 2); assert.equal(f.war.number, 2); assert.equal(f.war.victor, 0);
  for (const base of f.bases) {
    const slotOwner = new Game(1337, { frontier: true }).frontier!.bases.find(b => b.id === base.id)!.owner;
    assert.equal(base.owner, warFaction(slotOwner, 2), `${base.id} rotates to its war-two owner`);
  }
  assert.equal(human.state.alive, false); assert.equal(bot.state.alive, false);
  const queued = (g as unknown as { events: { bytes: Uint8Array }[] }).events;
  assert.ok(queued.some(e => e.bytes[0] === Msg.SDeath && e.bytes.includes(WAR_REDEPLOY_WEAPON)), 'redeploy uses the deployment cause');
  respawn(g, human); respawn(g, bot);
  assert.equal(human.state.alive, true);
  const homes = f.bases.filter(b => b.owner === human.faction);
  assert.ok(homes.length >= 3);
});

test('wars persist across saves; worlds saved before wars start a fresh one', () => {
  const g = new Game(1337, { frontier: true }), f = g.frontier!;
  f.war.number = 4; f.war.wins = [0, 2, 1, 0]; f.war.startedAt = 0;
  f.step([], 600 * TICK_RATE, .2);
  const site = f.territories.find(t => t.owner === 0)!;
  site.owner = 1; site.captureFaction = 1; site.captureProgress = 1; site.influence = -1;
  const restored = new Game(1337, { frontier: true }).frontier!;
  restored.restore(f.save());
  assert.equal(restored.war.number, 4); assert.deepEqual(restored.war.wins, [0, 2, 1, 0]);
  assert.ok(Math.abs(restored.war.elapsed - 600) < 1);
  assert.equal(restored.territories.find(t => t.id === site.id)!.owner, 1);
  const legacy = new Game(1337, { frontier: true }).frontier!;
  legacy.restore({ version: 3, seed: 1337, territories: f.territories.map(t => ({ ...t, owner: 2, captureFaction: 2, influence: 1, captureProgress: 1 })) });
  assert.equal(legacy.war.number, 1);
  assert.ok(legacy.territories.some(t => t.owner !== 2), 'pre-war saves start from the war-one layout');
});

test('kills, assists and captures award persistent experience to humans only', () => {
  const g = new Game(1337, { frontier: true });
  const hunter = g.addPlayer('Hunter', null); hunter.faction = 1;
  const helper = g.addPlayer('Helper', null); helper.faction = 1;
  const target = g.addPlayer('Target', null, true); target.faction = 2;
  target.recentAttackers.set(helper.id, g.tick);
  kill(g, target, hunter);
  assert.ok(hunter.xp >= XP_VALUES.kill); assert.equal(hunter.careerKills, 1);
  assert.equal(helper.xp, XP_VALUES.assist);
  const site = g.frontier!.territories.find(t => t.owner === 0)!;
  stand(hunter, site);
  g.frontier!.step([hunter], 10, CAPTURE_SECONDS + 1);
  assert.equal(site.owner, 1); assert.equal(hunter.captures, 1);
  const saved = capturePlayer(g, hunter);
  const fresh = g.addPlayer('Returning', null); restorePlayer(g, fresh, saved);
  assert.equal(fresh.xp, hunter.xp); assert.equal(fresh.careerKills, 1); assert.equal(fresh.captures, 1);
  assert.equal(rankForXp(xpForRank(5)), 5); assert.equal(rankForXp(xpForRank(5) - 1), 4);
});

test('a human can deploy into a fighter jet at rest on a runway and take off, with a cooldown, and deployed jets never respawn', () => {
  const g = new Game(1337, { frontier: true, vehicles: true }), f = g.frontier!;
  const pilot = g.addPlayer('Ace', null); pilot.faction = 1;
  f.step(g.players.values(), g.tick, .2);
  const option = f.reinforcementOptions(pilot).find(o => o.kind === 'air')!;
  assert.ok(option && option.available !== false, 'runway deployment is offered to humans');
  assert.equal(f.reinforcementOptions(g.addPlayer('Bot', null, true)).some(o => o.kind === 'air'), false, 'never to bots');
  assert.equal(g.requestRespawn(pilot, option.id), true);
  kill(g, pilot, pilot); respawn(g, pilot);
  assert.equal(pilot.state.alive, true); assert.equal(pilot.state.vehicle, VEHICLE.JET);
  const jet = g.vehicles.get(pilot.vehicleId)!;
  assert.ok(jet.deployed); assert.equal(jet.occupant, pilot.id);
  assert.equal(Math.hypot(pilot.state.vx, pilot.state.vy, pilot.state.vz), 0, 'starts at rest');
  const sites = (g as unknown as { vehicleSites: { type: number; x: number; z: number; heading: number }[] }).vehicleSites;
  const strip = sites.find(s => s.type === VEHICLE.JET && Math.hypot(s.x - pilot.state.px, s.z - pilot.state.pz) < 12);
  assert.ok(strip, 'starts on a runway, just ahead of its parked jet');
  assert.equal(pilot.state.heading, strip.heading, 'facing down the strip');
  const ground = g.world.groundY(pilot.state.px, pilot.state.pz);
  assert.ok(Math.abs(pilot.state.py - ground) < .5, 'on the ground');
  for (let i = 0; i < 240; i++) {
    // Roll to takeoff speed, pull up briefly, then hold the climb.
    g.queueInput(pilot, { seq: pilot.lastQueuedSeq + 1, buttons: BTN.THROTTLE | (i > 30 && i < 60 ? BTN.BACK : 0), weapon: 0,
      yaw: pilot.state.heading, pitch: 0, renderTick: g.tick, renderFrac: 0 });
    g.step();
  }
  assert.ok(pilot.state.alive && pilot.state.vehicle === VEHICLE.JET && pilot.state.py > ground + 20,
    `held throttle and a pull-up take off from the strip (height ${(pilot.state.py - ground).toFixed(1)} m)`);
  assert.equal(f.reinforcementOptions(pilot).find(o => o.kind === 'air')!.available, false, 'cooldown before the next fighter');
  jet.health = 0; jet.respawnAtTick = g.tick; jet.occupant = -1;
  (g as unknown as { updateVehicles(): void }).updateVehicles();
  assert.equal(g.vehicles.has(jet.id), false, 'a wrecked deployed jet is removed, not respawned');
});

test('out of combat, deploy-now moves a soldier to a rally immediately; in combat it is refused', () => {
  const g = new Game(1337, { frontier: true }), f = g.frontier!;
  const soldier = g.addPlayer('Runner', null); soldier.faction = 2;
  f.step(g.players.values(), g.tick, .2);
  const option = f.spawnOptions(soldier).find(o => o.kind === 'base')!;
  Object.assign(soldier.state, { px: option.x + 2500, pz: option.z, py: g.world.groundY(option.x + 2500, option.z) + .1 });
  soldier.regenBlockUntil = g.tick + 15 * TICK_RATE;
  assert.match(g.deployNow(soldier, option.id) ?? '', /combat/);
  soldier.regenBlockUntil = 0;
  assert.equal(g.deployNow(soldier, option.id), null);
  assert.ok(Math.hypot(soldier.state.px - option.x, soldier.state.pz - option.z) < 40, 'moved to the rally');
  assert.equal(soldier.preferredSpawnId, '', 'a deployment does not pin later ones (or respawns) to this point');
  assert.match(g.deployNow(soldier, option.id) ?? '', /ready in/, 'a short cooldown follows');
});

test('a living soldier keeps the fight beside them; only a respawning one is sent to a hotter distant one', () => {
  const g = new Game(1337, { frontier: true }), f = g.frontier!;
  const human = g.addPlayer('Near the fight', null, false); human.faction = 1;
  const own = f.territories.find(t => t.owner === 1)!;
  const far = [...f.territories].filter(t => t.owner !== 1)
    .sort((a, b) => Math.hypot(b.x - own.x, b.z - own.z) - Math.hypot(a.x - own.x, a.z - own.z))[0];
  assert.ok(Math.hypot(far.x - own.x, far.z - own.z) > 3000);
  const baseOf = (t: Territory) => f.bases.find(b => b.id === t.baseId)!;
  const operations = [
    { base: baseOf(own), target: own, defending: true, squads: 2, staging: { x: own.x, y: own.y, z: own.z } },
    { base: baseOf(far), target: far, defending: false, squads: 5, staging: { x: far.x, y: far.y, z: far.z } },
  ];
  (f as unknown as { director: { operations(): typeof operations } }).director.operations = () => operations;
  // A skirmish beside our holding (no capture pressure yet) and a far bigger battle kilometres away.
  for (let i = 0; i < 4; i++) f.recordCombat(own.x + 20, own.z, [1, 2], 0);
  for (const dx of [-256, 0, 256]) for (let i = 0; i < 12; i++) f.recordCombat(far.x + dx, far.z, [1, 3], 0);
  Object.assign(human.state, { px: own.x + 150, py: own.y, pz: own.z, alive: true });
  assert.equal(f.order(human)?.targetId, own.id, 'recent fighting at a holding is an active defense within reach');
  assert.match(f.order(human)!.name, /^Defend /);
  for (let i = 0; i < 12; i++) f.recordCombat(far.x, far.z + 256, [1, 3], 0);
  assert.equal(f.order(human)?.targetId, own.id, 'the order does not flip to a fight kilometres away');
  human.state.alive = false;
  (f as unknown as { humanPicks: Map<number, unknown> }).humanPicks.clear();
  assert.equal(f.order(human)?.targetId, far.id, 'deployment goes to the hottest fight, wherever it is');
});

test('before any battle is reported, a deploying soldier is sent where enemy soldiers actually are', () => {
  const g = new Game(1337, { frontier: true }), f = g.frontier!;
  const human = g.addPlayer('Fresh war', null, false); human.faction = 1;
  const home = f.bases.find(b => b.owner === 1 && b.kind === 'city')!;
  const targets = f.territories.filter(t => t.owner !== 1)
    .sort((a, b) => Math.hypot(a.x - home.x, a.z - home.z) - Math.hypot(b.x - home.x, b.z - home.z));
  const [empty, held] = [targets[0], targets.find(t => Math.hypot(t.x - targets[0].x, t.z - targets[0].z) > 1500)!];
  const baseOf = (t: Territory) => f.bases.find(b => b.id === t.baseId)!;
  const operations = [empty, held].map(target => ({ base: baseOf(target), target, defending: false, squads: 3,
    staging: { x: target.x, y: target.y, z: target.z } }));
  (f as unknown as { director: { operations(): typeof operations } }).director.operations = () => operations;
  const defenders = [0, 1, 2, 3, 4].map(i => {
    const bot = g.addPlayer(`Defender ${i}`, null, true); bot.faction = held.owner === 1 || !held.owner ? 3 : held.owner;
    Object.assign(bot.state, { px: held.x + i * 20, py: held.y, pz: held.z + 40, alive: true }); return bot;
  });
  Object.assign(human.state, { px: home.x, py: home.y, pz: home.z, alive: false });
  f.step([human, ...defenders], 1, 0);
  assert.equal(f.order(human)?.targetId, held.id, 'the defended objective, not the empty nearer one');
  for (const bot of defenders) bot.state.alive = false;
  (f as unknown as { humanPicks: Map<number, unknown> }).humanPicks.clear();
  f.step([human, ...defenders], 2, 0);
  assert.equal(f.order(human)?.targetId, empty.id, 'without anyone there, the nearer objective');
  f.startWar(f.war.number + 1, 3);
  assert.equal((f as unknown as { humanPicks: Map<number, unknown> }).humanPicks.size, 0,
    'a new war (rotated homes) clears held orders, which could now name an empty objective');
});

test('a decided war gives every human a debrief of their war; the next war starts the counts afresh', () => {
  const g = new Game(1337, { frontier: true }), f = g.frontier!;
  const human = g.addPlayer('Debriefed', null, false); human.faction = 1;
  const enemy = g.addPlayer('Opponent', null, true); enemy.faction = 2;
  const ace = g.addPlayer('Ace', null, true); ace.faction = 3;
  const site = f.territories[0];
  for (const p of [human, enemy, ace]) stand(p, site);
  kill(g, enemy, human); respawn(g, enemy); stand(enemy, site);
  kill(g, enemy, human); kill(g, human, enemy);
  for (let i = 0; i < 3; i++) { respawn(g, human); stand(human, site); kill(g, human, ace); }
  f.step([human, enemy, ace], g.tick, 0);
  assert.equal(f.snapshot(human, [], g.tick).debrief, undefined, 'no debrief while the war is undecided');
  (f as unknown as { decideWar(victor: Faction, tick: number, reason: string): void }).decideWar(2, g.tick, 'test');
  const debrief = f.snapshot(human, [], g.tick).debrief!;
  assert.deepEqual({ kills: debrief.kills, deaths: debrief.deaths, victor: debrief.victor, faction: debrief.faction },
    { kills: 2, deaths: 4, victor: 2, faction: 1 });
  assert.ok(debrief.xp >= 2 * XP_VALUES.kill, 'experience earned in this war');
  assert.deepEqual(debrief.best, { name: 'Ace', faction: 3, kills: 3, you: false });
  assert.equal(f.snapshot(enemy, [], g.tick).debrief, undefined, 'bots get none');
  f.startWar(f.war.number + 1, g.tick);
  assert.deepEqual([human.warKills, human.warDeaths, human.warXp, ace.warKills], [0, 0, 0, 0]);
  assert.equal(f.snapshot(human, [], g.tick).debrief, undefined);
});

test('a control held against its base for too long cuts the base supply until it is retaken', () => {
  const g = new Game(1337, { frontier: true }), f = g.frontier!;
  const base = f.bases.find(b => b.owner === 2 && b.kind === 'outpost')!;
  const site = f.territories.find(t => t.id === base.controlIds[0])!;
  const defender = g.addPlayer('Defender', null, true); defender.faction = 2;
  Object.assign(site, { owner: 1, captureFaction: 1, captureProgress: 1, influence: -1 });
  f.step([defender], 1, 0);
  assert.equal(base.owner, 2, 'one lost control does not flip the base');
  assert.equal(f.supplyCut(base, 1), false, 'a fresh foothold leaves time to retake it');
  const later = 1 + SUPPLY_CUT_SECONDS * TICK_RATE;
  f.step([defender], later, 0);
  assert.equal(f.supplyCut(base, later), true);
  const rally = f.reinforcementOptions(defender, later).find(o => o.id === base.id)!;
  assert.equal(rally.available, false);
  assert.match(rally.reason!, /Supply cut/);
  // The base's defense of a control still under attack stages farther out, not kilometres away.
  const held = f.territories.find(t => t.id === base.controlIds[1])!;
  held.contested = true;
  const defense = { base, target: held, defending: true, squads: 2, staging: { x: held.x, y: held.y, z: held.z } };
  (f as unknown as { director: { operations(faction: number): typeof defense[] } }).director.operations = faction => faction === 2 ? [defense] : [];
  const staging = f.reinforcementOptions(defender, later).find(o => o.id === `assault-${held.id}`);
  assert.ok(staging, 'the defense still has a deployment point');
  const out = Math.hypot(staging.x - held.x, staging.z - held.z);
  assert.ok(out >= 550 && out <= 950, `defense staging ${Math.round(out)} m out (attackers stage at about 300 m)`);
  Object.assign(site, { owner: 2, captureFaction: 2, captureProgress: 1, influence: 1 });
  f.step([defender], later + 1, 0);
  assert.equal(f.supplyCut(base, later + 1), false, 'retaking the control reopens the rally');
});

test('a creature kill is a death but not a suicide; the world still punishes falls', () => {
  const g = new Game(1337, { frontier: true }), prey = g.addPlayer('Prey', null, false); prey.faction = 1;
  stand(prey, g.frontier!.territories[0]);
  const frags = prey.frags, deaths = prey.deaths;
  const killWith = (weapon: number) => (g as unknown as { kill(p: ServerPlayer, a: ServerPlayer, w: number): void }).kill(prey, prey, weapon);
  killWith(WILDLIFE_WEAPON);
  assert.deepEqual([prey.frags, prey.deaths], [frags, deaths + 1]);
  respawn(g, prey); stand(prey, g.frontier!.territories[0]);
  killWith(255);
  assert.deepEqual([prey.frags, prey.deaths], [frags - 1, deaths + 2]);
});

test('wildlife keeps away from held bases and from the staging points where soldiers deploy', () => {
  const g = new Game(1337, { frontier: true }), f = g.frontier!;
  const target = f.territories.find(t => t.owner !== 1)!, base = f.bases.find(b => b.id === target.baseId)!;
  const operation = { base, target, defending: false, squads: 2, staging: { x: target.x, y: target.y, z: target.z } };
  (f as unknown as { director: { operations(faction: number): typeof operation[] } }).director.operations = faction => faction === 1 ? [operation] : [];
  const points = (f as unknown as { assaultStagingPoints(faction: number, b: typeof base, t: Territory): { x: number; z: number }[] })
    .assaultStagingPoints(1, base, target);
  assert.ok(points.length > 0, 'the assault has staging');
  const areas = f.protectedAreas();
  for (const p of points) assert.ok(areas.some(a => a.x === p.x && a.z === p.z && a.radius >= 50), 'each staging point is protected');
  assert.equal(areas.filter(a => a.radius === 80).length, f.bases.filter(b => b.owner !== 0).length, 'every held base too');
});

test('a stalled front gets a final push: a base flip calls it off, its end decides by territory, an exact tie fights on', () => {
  const T = TICK_RATE;
  const fresh = () => { const g = new Game(1337, { frontier: true }), f = g.frontier!; f.war.startedAt = 0; return f; };
  const take = (f: ReturnType<typeof fresh>, faction: Faction, controls = 3) => {
    const base = f.bases.find(b => b.owner === 0)!;
    for (const site of f.territories.filter(t => t.baseId === base.id).slice(0, controls))
      Object.assign(site, { owner: faction, captureFaction: faction, captureProgress: 1, influence: faction === 1 ? -1 : 1 });
    return base;
  };
  // With no base flip, the clock starts after the grace period.
  const f = fresh(), armed = (STALEMATE_GRACE_SECONDS + STALEMATE_SECONDS) * T;
  f.step([], armed - 1, 0);
  assert.equal(f.war.pushEndsAt, -1, 'the opening is not cut short');
  f.step([], armed, 0);
  assert.equal(f.war.pushEndsAt, armed + FINAL_PUSH_SECONDS * T);
  assert.equal(f.warStatus(armed).finalPush, true); assert.equal(f.warStatus(armed).remaining, FINAL_PUSH_SECONDS);
  // A base changing hands calls the push off and restarts the clock.
  const flip = armed + 60 * T, base = take(f, 2);
  f.step([], flip, 0);
  assert.equal(base.owner, 2); assert.equal(f.war.pushEndsAt, -1); assert.equal(f.war.movedAt, flip);
  assert.equal(f.warStatus(flip).finalPush, undefined);
  f.step([], flip + STALEMATE_SECONDS * T - 1, 0);
  assert.equal(f.war.pushEndsAt, -1);
  f.step([], flip + STALEMATE_SECONDS * T, 0);
  const end = f.war.pushEndsAt;
  assert.equal(end, flip + (STALEMATE_SECONDS + FINAL_PUSH_SECONDS) * T);
  // Its end decides by the time-limit rule: the most bases win.
  f.step([], end - 1, 0);
  assert.equal(f.war.victor, 0);
  f.step([], end, 0);
  assert.equal(f.war.victor, 2, 'the faction holding the most bases wins the final push');

  // An early base flip starts the clock before the grace period ends.
  const early = fresh(), at = 60 * T;
  take(early, 1);
  early.step([], at, 0);
  early.step([], at + STALEMATE_SECONDS * T - 1, 0);
  assert.equal(early.war.pushEndsAt, -1);
  early.step([], at + STALEMATE_SECONDS * T, 0);
  assert.ok(early.war.pushEndsAt > 0 && at + STALEMATE_SECONDS * T < armed);

  // An exact tie at the end fights on (sudden death) until one side leads.
  const tie = fresh();
  tie.step([], armed, 0);
  tie.step([], tie.war.pushEndsAt, 0);
  assert.equal(tie.war.victor, 0, 'three even factions fight on');
  take(tie, 3, 1);
  tie.step([], tie.war.pushEndsAt + T, 0);
  assert.equal(tie.war.victor, 3, 'one more control decides it');
});
