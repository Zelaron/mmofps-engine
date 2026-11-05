import { randomUUID } from 'node:crypto';
import { TICK_RATE } from '@shared/constants';
import { createMoveState, type InputCmd } from '@shared/movement';
import { capsuleClearance } from '@shared/physics';
import { encodeServerMessage } from '@shared/protocol';
import { FACTIONS, inCaptureRange, type Faction } from '@shared/frontier';
import { ORBITAL_CHARGE_SECONDS, planetById, type PlanetId } from '@shared/universe';
import { type CampaignBaseReport, type CampaignExchange, type CampaignPopulation, type CampaignReport,
  type CampaignTransfer, type CampaignWarAlert } from '@shared/campaign-war';
import { Bot, botCampaignRole, botRoleId } from './bots.js';
import { ControlError } from './control-client.js';
import type { Game, ServerPlayer } from './game.js';
import { checkedHandoff, prepareArrival, type DetachedHandoff, type RuntimeHandoff } from './runtime-handoff.js';
import type { CampaignCancellation } from './campaign-ledger.js';

interface Authority { id: string; epoch: number }
export interface OrbitalCampaignOptions {
  planet: PlanetId;
  call<T>(method: string, body: unknown): Promise<T>;
  authority(): Authority | null;
  ready(): boolean;
  populationLimit(): number;
  owns?(x: number, z: number): boolean;
}
interface Target { planet: PlanetId; base: CampaignBaseReport; score: number }
type Port = ReturnType<Game['world']['collectTransportPlan']>['pods'][number];
interface Expedition {
  id: string; destination: PlanetId; targetBaseId: string; faction: Faction;
  members: Bot[]; port: Port; started: number;
  charge?: { tick: number; positions: {x:number;y:number;z:number;health:number}[] };
  frozen?: DetachedHandoff;
  authority?: Authority;
  uncertain?: boolean;
  retryAt: number;
}
const INITIAL_PLAN_SECONDS = 20;
const WAVE_COOLDOWN_SECONDS = 120;
const ARRIVAL_DUTY_SECONDS = 600;
const MIN_HOME_FORCE = 12;
const counts = (): CampaignPopulation => [0, 0, 0, 0];

/** Remote defense and partially held footholds have priority over expansion.
 * Population pressure stops a successful world from attracting every wave. */
export function selectExpeditionTargets(reports: readonly CampaignReport[], source: PlanetId, faction: Faction): Target[] {
  if (!faction) return [];
  const targets: Target[] = [];
  for (const report of reports) if (report.planet !== source) for (const base of report.bases) {
    const threatened = base.attackers.some(attacker => attacker !== faction);
    if (base.owner === faction && !threatened) continue;
    const foothold = base.held[faction] > 0;
    const score = (threatened && (base.owner === faction || foothold) ? 110 : foothold ? 65 : base.owner ? 25 : 40)
      - report.botPopulation[faction] * .45;
    targets.push({ planet: report.planet, base, score });
  }
  return targets.sort((a, b) => b.score - a.score || a.planet.localeCompare(b.planet) || a.base.id.localeCompare(b.base.id));
}

/** On-foot expeditions have a distinct cross-planet arrival boundary. Local
 * regional handoffs retain their strict same-seed/current-clock checks. */
export function relocateExpedition(game: Game, incoming: RuntimeHandoff, positions: readonly {x:number;y:number;z:number}[]): RuntimeHandoff {
  const record = checkedHandoff(incoming);
  if (record.vehicles.length || record.players.some(p => !p.isBot || !p.state.alive || p.vehicleId >= 0 || p.state.vehicle) || positions.length !== record.players.length)
    throw new Error('Only a complete living infantry expedition may arrive');
  const delta = game.tick - record.tick;
  record.seed = game.seed; record.tick = game.tick; record.projectiles = []; record.history = [];
  for (let i = 0; i < record.players.length; i++) {
    const p = record.players[i], position = positions[i];
    for (const key of ['regenBlockUntil', 'respawnAtTick', 'factionChangeAt', 'fallCreditUntilTick', 'ranOverUntilTick',
      'teleportCdUntil', 'recallSince', 'trapCooldownUntil', 'transitDamageUntil', 'spawnProtectedUntil'] as const) if (p[key] >= 0) p[key] += delta;
    p.state = createMoveState(position.x, position.y, position.z);
    p.inputQueue = []; p.lastCmd = null; p.lastProcessedSeq = p.lastQueuedSeq = 0; p.hasQueuedSeq = false;
    p.lastInputAtTick = game.tick; p.vehicleId = -1; p.useHeld = false;
    p.lockTargetId = p.lockVehicleId = -1; p.lockState = p.lockTicks = 0;
    p.airlift = undefined; p.recallSince = -1; p.preferredSpawnId = ''; p.lastDeath = undefined;
    p.fullPickupContacts = []; p.fallCreditAttackerId = -1; p.fallCreditUntilTick = -1;
  }
  return record;
}

/** One bounded expedition per world. Network requests run between ticks;
 * simulation ownership changes only in step(), after durable confirmation. */
export class OrbitalCampaign {
  private reports: CampaignReport[] = [];
  private reportAt = -Infinity;
  private nextSync = 0;
  private nextPlan: number;
  private nextFaction = 1;
  private expedition: Expedition | null = null;
  private syncing: Promise<void> | null = null;
  private transferring: Promise<void> | null = null;
  private resolved: 'committed' | 'rejected' | null = null;
  private incoming: CampaignTransfer<RuntimeHandoff>[] = [];
  private arrivalAttemptAt = 0;
  private readonly acknowledged = new Set<string>();
  private readonly accepted = new Set<string>();
  private readonly imported = new Set<number>();
  private readonly retired = new Set<number>();
  private readonly seenAlerts = new Set<string>();
  private readonly outbound: CampaignWarAlert[] = [];
  private readonly arrivalDuty = new Map<number, {until:number;target:string;missionUntil:number}>();
  private lastError: string | null = null;
  private stopped = false;
  private readonly previousAlert: NonNullable<Game['frontier']>['campaignAlert'] | undefined;
  private readonly onAlert: NonNullable<Game['frontier']>['campaignAlert'];

  constructor(private readonly game: Game, private readonly bots: Bot[], private readonly options: OrbitalCampaignOptions) {
    this.nextPlan = game.tick + INITIAL_PLAN_SECONDS * TICK_RATE;
    this.previousAlert = game.frontier?.campaignAlert;
    this.onAlert = alert => {
      this.previousAlert?.(alert);
      this.outbound.push({ ...alert, id: randomUUID(), planet: options.planet });
      if (this.outbound.length > 32) this.outbound.shift();
    };
    if (game.frontier) game.frontier.campaignAlert = this.onAlert;
  }

  get status() {
    const expedition = this.expedition;
    return { phase: expedition?.frozen ? 'departing' : expedition?.charge ? 'charging' : expedition ? 'assembling' : 'ready',
      destination: expedition?.destination, members: expedition?.members.map(b => b.player.id) ?? [],
      frozen: expedition?.frozen?.record.players.length ?? 0, reports: this.reports.length,
      arrivals: this.accepted.size, error: this.lastError };
  }

  protected(bot: Bot): boolean {
    return this.expedition?.members.includes(bot) === true || (this.arrivalDuty.get(bot.player.id)?.until ?? -1) > this.game.tick;
  }

  frozen(bot: Bot): boolean { return !!this.expedition?.frozen && this.expedition.members.includes(bot); }

  retire(bot: Bot): void {
    if (this.imported.delete(bot.player.id)) this.retired.add(bot.player.id);
    this.arrivalDuty.delete(bot.player.id);
    bot.setTravelWaypoint(null);
  }

  command(bot: Bot, command: InputCmd): InputCmd {
    return this.expedition?.charge && this.expedition.members.includes(bot) ? { ...command, buttons: 0 } : command;
  }

  step(): void {
    if (this.stopped || !this.options.ready() || !this.options.authority()) return;
    if (this.resolved) this.finishDeparture();
    this.installArrival();
    const tick = this.game.tick;
    if (tick >= this.nextSync && !this.syncing) {
      this.nextSync = tick + 5 * TICK_RATE;
      void this.sync();
    }
    if (tick % 30 === 0) for (const bot of this.bots) {
      const duty = this.arrivalDuty.get(bot.player.id);
      if (!duty) continue;
      const point = duty.target && this.game.frontier?.territories.find(site=>site.id===duty.target);
      const secured = point && point.owner===bot.player.faction && !point.contested &&
        (!point.pressureFaction || point.pressureFaction===bot.player.faction) &&
        Math.hypot(point.x-bot.player.state.px,point.z-bot.player.state.pz)<point.radius+20;
      if (duty.target && (tick >= duty.missionUntil || !bot.player.state.alive || secured)) {
        bot.setTravelWaypoint(null); duty.target = '';
      }
      if (tick >= duty.until) this.arrivalDuty.delete(bot.player.id);
    }
    if (!this.expedition) {
      if (tick >= this.nextPlan && tick - this.reportAt <= 20 * TICK_RATE) this.plan();
      return;
    }
    const expedition = this.expedition;
    if (expedition.frozen) {
      if (!this.transferring && tick >= expedition.retryAt) this.submit(expedition);
      return;
    }
    if (tick - expedition.started > 6 * 60 * TICK_RATE || expedition.members.some(bot =>
      this.game.players.get(bot.player.id) !== bot.player || !bot.player.state.alive)) {
      this.cancel(); return;
    }
    const near = expedition.members.every(({ player: p }) => !p.state.vehicle && !p.airlift && !p.state.airlift && p.state.grounded &&
      Math.hypot(p.state.px-expedition.port.x,p.state.py-expedition.port.y,p.state.pz-expedition.port.z) <= 5.5);
    if (!near || this.enemyNear(expedition.port.x, expedition.port.z, expedition.faction, 80)) {
      this.clearCharge(expedition); return;
    }
    if (!expedition.charge) {
      if (expedition.members.some(bot => Math.hypot(bot.player.state.vx, bot.player.state.vz) > 1)) return;
      expedition.charge = { tick, positions: expedition.members.map(({ player: p }) => ({ x:p.state.px,y:p.state.py,z:p.state.pz,health:p.health })) };
      for (const bot of expedition.members) bot.invalidateThought();
      return;
    }
    if (expedition.members.some(({ player: p }, index) => {
      const start = expedition.charge!.positions[index];
      return p.health < start.health || Math.hypot(p.state.px-start.x,p.state.py-start.y,p.state.pz-start.z) > 1.5;
    })) { this.clearCharge(expedition); return; }
    if (tick - expedition.charge.tick < ORBITAL_CHARGE_SECONDS * TICK_RATE) return;
    expedition.authority = this.options.authority()!;
    expedition.frozen = this.game.takeHandoff(expedition.members.map(bot => bot.player.id));
    // Shots already in flight belong to the source battle, never the ship.
    for (const projectile of expedition.frozen.record.projectiles)
      this.game.projectiles.set(projectile.id, { ...projectile, fuseLeft: projectile.fuseLeft ?? Infinity });
    expedition.frozen.record.projectiles = []; expedition.frozen.record.history = [];
    this.submit(expedition);
  }

  async sync(): Promise<void> {
    if (this.syncing) return this.syncing;
    const authority = this.options.authority();
    if (this.stopped || !authority || !this.options.ready()) return;
    const alerts = this.outbound.slice(0,16), acknowledged = [...this.acknowledged].slice(0,32), retired = [...this.retired].slice(0,32);
    this.syncing = this.options.call<CampaignExchange<RuntimeHandoff>>('campaign/exchange', {
      authority, report: this.report(), alerts, acknowledged, retired,
    }).then(exchange => {
      if (this.stopped || this.options.authority()?.epoch !== authority.epoch) return;
      this.reports = exchange.reports; this.reportAt = this.game.tick;
      this.incoming = exchange.arrivals;
      for (const id of acknowledged) this.acknowledged.delete(id);
      for (const id of retired) this.retired.delete(id);
      for (const alert of alerts) { const index = this.outbound.findIndex(row => row.id === alert.id); if (index >= 0) this.outbound.splice(index,1); }
      for (const alert of exchange.alerts) if (!this.seenAlerts.has(alert.id)) {
        this.seenAlerts.add(alert.id);
        for (const p of this.game.players.values()) if (!p.isBot) p.sink?.send(encodeServerMessage(alert.message));
      }
      while (this.seenAlerts.size > 256) this.seenAlerts.delete(this.seenAlerts.values().next().value!);
      this.lastError = null;
    }).catch(error => { this.lastError = (error as Error).message; }).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private report(): CampaignReport {
    const ownership = counts(), botPopulation = counts(), frontier = this.game.frontier;
    const owns = (x:number,z:number) => this.options.owns?.(x,z) ?? true;
    const territories = frontier?.territories.filter(t => owns(t.x,t.z)) ?? [];
    for (const point of territories) ownership[point.owner]++;
    if (territories.length) for (let i=0;i<4;i++) ownership[i] /= territories.length;
    else ownership[0] = 1;
    for (const p of this.game.players.values()) if (p.isBot && owns(p.state.px,p.state.pz)) botPopulation[p.faction]++;
    const bases = (frontier?.bases ?? []).filter(base => owns(base.x,base.z)).map(base => {
      const held = counts(), attackers = new Set<Faction>();
      for (const point of territories) if (point.baseId === base.id) {
        held[point.owner]++;
        // Restoring a friendly control is progress, but is not an attack.
        if (point.pressureFaction && point.pressureFaction !== point.owner &&
            (point.contested || (point.progressRate ?? 0) !== 0)) attackers.add(point.pressureFaction);
        if (point.contested) for (const actor of this.game.players.values()) {
          const s=actor.state;
          if (actor.faction && actor.faction!==point.owner && s.alive && !s.vehicle && inCaptureRange(point,s.px,s.py,s.pz,!actor.isBot)) attackers.add(actor.faction);
        }
      }
      return { id:base.id,name:base.name,owner:base.owner,x:base.x,z:base.z,held,attackers:[...attackers] };
    });
    return { planet:this.options.planet,tick:this.game.tick,ownership,botPopulation,bases };
  }

  private enemyNear(x: number, z: number, faction: Faction, range: number): boolean {
    for (const p of this.game.players.values()) if (p.state.alive && p.faction && p.faction !== faction &&
      (p.state.px-x)**2+(p.state.pz-z)**2 < range*range) return true;
    return false;
  }

  private plan(): void {
    this.nextPlan = this.game.tick + 15 * TICK_RATE;
    const frontier = this.game.frontier;
    if (!frontier || this.bots.length < MIN_HOME_FORCE) return;
    const ports = this.game.world.collectTransportPlan().pods.filter(port => this.options.owns?.(port.x,port.z) ?? true);
    for (let turn=0;turn<3;turn++) {
      const faction = (1+(this.nextFaction-1+turn)%3) as Faction;
      const living = this.bots.filter(bot => this.game.players.get(bot.player.id) === bot.player && bot.player.faction === faction && bot.player.state.alive);
      if (living.length < MIN_HOME_FORCE) continue;
      const target = selectExpeditionTargets(this.reports,this.options.planet,faction)[0];
      if (!target) continue;
      const groups = new Map<number,Bot[]>();
      for (const bot of living) {
        const p = bot.player, role = botCampaignRole(botRoleId(p));
        if (this.protected(bot) || ['pilot','aircrew','sailor','navalcrew'].includes(role) || p.state.vehicle || p.airlift || p.state.airlift ||
          p.health < 75 || p.regenBlockUntil > this.game.tick || this.enemyNear(p.state.px,p.state.pz,faction,140)) continue;
        const order = frontier.order(p);
        if (!order) continue;
        const point = frontier.territories.find(site => site.id === order.targetId);
        if (order.phase==='defend' && point && (point.contested ||
          point.pressureFaction && point.pressureFaction!==faction || this.enemyNear(point.x,point.z,faction,250))) continue;
        if (point && point.owner !== faction && Math.hypot(point.x-p.state.px,point.z-p.state.pz) < point.radius+35) continue;
        const squad = Math.floor((botRoleId(p)-1)/18), members = groups.get(squad) ?? [];
        members.push(bot); groups.set(squad,members);
      }
      let best: {members:Bot[];port:Port;distance:number} | undefined;
      for (const group of groups.values()) for (const port of ports) {
        const members = group.filter(bot => Math.abs(bot.player.state.py-port.y)<300 &&
          Math.hypot(bot.player.state.px-port.x,bot.player.state.pz-port.z)<2600).sort((a,b) =>
            Math.hypot(a.player.state.px-port.x,a.player.state.pz-port.z)-Math.hypot(b.player.state.px-port.x,b.player.state.pz-port.z)).slice(0,6);
        if (members.length < 3 || living.length-members.length < 6 || this.enemyNear(port.x,port.z,faction,140)) continue;
        const distance = members.reduce((sum,bot) => sum+Math.hypot(bot.player.state.px-port.x,bot.player.state.pz-port.z),0)/members.length - members.length*100;
        if (!best || distance < best.distance) best = {members,port,distance};
      }
      if (!best) continue;
      const id = randomUUID();
      this.expedition = { id,destination:target.planet,targetBaseId:target.base.id,faction,members:best.members,port:best.port,started:this.game.tick,retryAt:0 };
      for (const bot of best.members) bot.setTravelWaypoint({id:`orbital-${id}`,x:best.port.x,y:best.port.y,z:best.port.z});
      this.nextFaction = faction%3+1;
      this.announce(`${FACTIONS[faction].name} is assembling an expedition to ${target.base.name} on ${planetById(target.planet)!.name}.`);
      return;
    }
  }

  private submit(expedition: Expedition): void {
    if (this.transferring || !expedition.frozen || !expedition.authority) return;
    const request = { authority:expedition.authority,id:expedition.id,destination:expedition.destination,
      targetBaseId:expedition.targetBaseId,faction:expedition.faction,payload:expedition.frozen.record };
    this.transferring = (async () => {
      try {
        await this.options.call('campaign/depart', request);
        this.resolved = 'committed';
      } catch (error) {
        this.lastError = (error as Error).message;
        if (!expedition.uncertain && error instanceof ControlError && ['invalid','full','unavailable'].includes(error.code)) {
          this.resolved = 'rejected'; return;
        }
        expedition.uncertain = true;
        try {
          const receipt = await this.options.call<CampaignTransfer<RuntimeHandoff>|null>('campaign/transfer', {authority:expedition.authority,id:expedition.id});
          if (receipt?.state === 'committed') this.resolved = 'committed';
          else {
            const outcome = await this.options.call<CampaignCancellation>('campaign/cancel', request);
            if (outcome.state === 'committed') this.resolved = 'committed';
            else if (outcome.state === 'cancelled') this.resolved = 'rejected';
          }
        } catch { /* Unknown commit status keeps every source actor frozen. */ }
      } finally { expedition.retryAt = this.game.tick+3*TICK_RATE; }
    })().finally(() => { this.transferring = null; });
  }

  private finishDeparture(): void {
    const expedition = this.expedition, result = this.resolved; this.resolved = null;
    if (!expedition?.frozen) return;
    if (result === 'committed') {
      for (const bot of expedition.members) {
        bot.setTravelWaypoint(null);
        this.imported.delete(bot.player.id); this.arrivalDuty.delete(bot.player.id);
        const index = this.bots.indexOf(bot); if (index >= 0) this.bots.splice(index,1);
      }
      this.announce(`${FACTIONS[expedition.faction].name} expedition departed for ${planetById(expedition.destination)!.name}.`);
    } else {
      const positions = expedition.frozen.record.players.map(p => ({x:p.state.px,y:p.state.py,z:p.state.pz}));
      expedition.frozen.record = relocateExpedition(this.game,expedition.frozen.record,positions);
      this.game.restoreHandoff(expedition.frozen);
      for (const bot of expedition.members) bot.setTravelWaypoint(null);
    }
    this.expedition = null; this.nextPlan = this.game.tick+WAVE_COOLDOWN_SECONDS*TICK_RATE;
  }

  private cancel(): void {
    for (const bot of this.expedition?.members ?? []) bot.setTravelWaypoint(null);
    this.expedition = null; this.nextPlan = this.game.tick+30*TICK_RATE;
  }

  private clearCharge(expedition: Expedition): void {
    if (!expedition.charge) return;
    expedition.charge = undefined;
    for (const bot of expedition.members) bot.invalidateThought();
  }

  private installArrival(): void {
    if (this.game.tick < this.arrivalAttemptAt) return;
    const ticket = this.incoming[0];
    if (!ticket) return;
    this.arrivalAttemptAt = this.game.tick+30;
    if (this.accepted.has(ticket.id)) { this.acknowledged.add(ticket.id); this.incoming.shift(); return; }
    if (ticket.destination !== this.options.planet) { this.incoming.shift(); return; }
    const base = this.game.frontier?.bases.find(base => base.id === ticket.targetBaseId);
    const ports = this.game.world.collectTransportPlan().pods.filter(port => (this.options.owns?.(port.x,port.z) ?? true) &&
      !this.enemyNear(port.x,port.z,ticket.faction,100)).sort((a,b) =>
        Math.hypot(a.x-(base?.x??0),a.z-(base?.z??0))-Math.hypot(b.x-(base?.x??0),b.z-(base?.z??0)));
    const port = ports.find(port => capsuleClearance(this.game.world,port.x,port.y+.12,port.z)>-.05);
    if (!port) return;
    const ids = new Set(ticket.payload.players.map(p => p.id));
    if ([...ids].some(id => this.game.players.has(id))) { this.lastError = 'Arrival identity is already active'; return; }
    const excess = Math.max(0,this.bots.length+ids.size-this.options.populationLimit());
    const reserves = this.bots.filter(bot => !this.protected(bot) && this.game.players.get(bot.player.id) === bot.player && !bot.player.state.vehicle &&
      (!bot.player.state.alive || (bot.player.regenBlockUntil <= this.game.tick && !this.enemyNear(bot.player.state.px,bot.player.state.pz,bot.player.faction,180))))
      .sort((a,b) => Number(b.player.faction===ticket.faction)-Number(a.player.faction===ticket.faction) || Number(a.player.state.alive)-Number(b.player.state.alive));
    if (reserves.length < excess) return;
    try {
      const positions = ticket.payload.players.map((_p,index) => {
        const angle = index*Math.PI/3, x=port.x+Math.sin(angle)*2.2,z=port.z+Math.cos(angle)*2.2;
        return capsuleClearance(this.game.world,x,port.y+.12,z)>-.05 ? {x,y:port.y+.12,z} : {x:port.x,y:port.y+.12,z:port.z};
      });
      const record = relocateExpedition(this.game,ticket.payload,positions);
      prepareArrival(this.game,record,new Map());
      const roster = this.game.reserveBotRoster(ticket.faction,record.players.length);
      record.players.forEach((p,index) => {p.botRosterIndex=roster[index];});
      for (const reserve of reserves.slice(0,excess)) { this.retire(reserve); this.game.removePlayer(reserve.player.id); this.bots.splice(this.bots.indexOf(reserve),1); }
      const players = this.game.acceptHandoff(record,new Map());
      const priority = (site: NonNullable<Game['frontier']>['territories'][number]) =>
        Number(site.contested || !!site.pressureFaction && site.pressureFaction!==ticket.faction)*100+Number(site.owner!==ticket.faction)*50;
      const target = this.game.frontier?.territories.filter(site => site.baseId===ticket.targetBaseId)
        .sort((a,b) => priority(b)-priority(a))[0];
      for (const player of players) {
        const bot = new Bot(player,this.game.seed); this.bots.push(bot);
        this.imported.add(player.id);
        if (target) bot.setTravelWaypoint({id:`arrival-${ticket.id}`,x:target.x,y:target.y,z:target.z});
        this.arrivalDuty.set(player.id,{until:this.game.tick+ARRIVAL_DUTY_SECONDS*TICK_RATE,target:target?.id??'',missionUntil:this.game.tick+360*TICK_RATE});
      }
      this.accepted.add(ticket.id); this.acknowledged.add(ticket.id); this.incoming.shift();
      while (this.accepted.size > 4096) this.accepted.delete(this.accepted.values().next().value!);
      this.announce(`${FACTIONS[ticket.faction].name} expedition arrived from ${planetById(ticket.source)!.name} to reinforce ${base?.name??'the frontier'}.`);
    } catch (error) { this.lastError=(error as Error).message; }
  }

  private announce(message: string): void {
    for (const player of this.game.players.values()) if (!player.isBot) player.sink?.send(encodeServerMessage(message));
  }

  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all([this.syncing,this.transferring]);
    if (this.resolved) this.finishDeparture();
    if (!this.expedition?.frozen) this.cancel();
    if (this.game.frontier?.campaignAlert === this.onAlert) this.game.frontier.campaignAlert = this.previousAlert ?? (() => {});
  }
}
