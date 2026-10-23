import type { Outpost, OutpostAction, OutpostSite } from '@shared/outposts';
import { encodeServerMessage } from '@shared/protocol';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { PLANETS, nearestSpaceport, ORBITAL_CHARGE_SECONDS, type PlanetId, type JourneyState } from '@shared/universe';
import { TICK_RATE } from '@shared/constants';
import { encodeJourney } from '@shared/journey-wire';
import { capturePlayer, restorePlayer, type SavedPlayer } from './persistence.js';
import type { Game, ServerPlayer } from './game.js';
import type { PlayerConn, ConnectionLifecycle } from './conn.js';
import { ControlClient, ControlError, trustedNode } from './control-client.js';
import type { AuthorityGrant, Checkpoint, LeaseGrant } from './coordinator.js';
import type { EntityPool } from './entity-pool.js';
import { SimulationClock } from './planet-clock.js';
import { NODE_TIMEOUT_MS } from './ownership-constants.js';
import { OutpostReplica, type RegionalOutposts, type OutpostCellUpdate } from './outpost-replica.js';
import { Gathering } from './gathering.js';
import type { ResourceNode } from '@shared/resources';
import { RESOURCE_YIELD } from '@shared/resources';
import { RegionGrid, type RegionLayout, type RegionBounds } from '@shared/regions';
import type { Territory } from '@shared/frontier';
import type { PlanetOwnership } from './coordinator.js';
import type { ResourceReceipt } from './resource-ledger.js';
import { OrbitalCampaign } from './orbital-campaign.js';
import type { Bot } from './bots.js';
import type { InputCmd } from '@shared/movement';

export interface WorldNodeOptions { url: string; secret: string; id: string; planet: PlanetId; region?: string; advertise?: string }
interface Lease {
  key: string; entityId: number; holder: string; epoch: number; validUntil: number; state: SavedPlayer | null;
  conn: PlayerConn | null; player: ServerPlayer | null; transferring: boolean; building?: boolean;
}
interface Launch { lease: Lease; destination: PlanetId; tick: number; x: number; y: number; z: number; health: number }
export function regionalOwnership(territories: readonly Pick<Territory, 'owner' | 'x' | 'z'>[], bounds: RegionBounds):
  { ownership: PlanetOwnership; ownershipPoints: number } {
  const ownership: PlanetOwnership = [0, 0, 0, 0];
  let ownershipPoints = 0;
  for (const point of territories) {
    if (point.x < bounds.minX || point.x >= bounds.maxX || point.z < bounds.minZ || point.z >= bounds.maxZ) continue;
    ownership[point.owner]++; ownershipPoints++;
  }
  return { ownership: ownershipPoints ? ownership.map(count => count / ownershipPoints) as PlanetOwnership : [1, 0, 0, 0], ownershipPoints };
}
export class WorldNode {
  private readonly control: ControlClient;
  private readonly leases = new Map<string, Lease>();
  private readonly launches = new Map<string, Launch>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private resourceTimer: ReturnType<typeof setInterval> | null = null;
  private resourceSync: Promise<void> | null = null;
  readonly gathering: Gathering;
  private inFlight: Promise<void> | null = null;
  private endpoint = '';
  private authorityUntil = 0;
  private authorityEpoch: number | undefined;
  private ownershipBounds: RegionBounds | null = null;
  private ready = false;
  private failure: Error | null = null;
  private readonly clock = new SimulationClock();
  private readonly outpostReplica: OutpostReplica;
  private outpostSyncGeneration = 0;
  private outpostViewUntil = 0;
  private campaign: OrbitalCampaign | null = null;
  targetTick(): number { return this.clock.target(); }
  millisecondsUntil(tick: number): number { return this.clock.millisecondsUntil(tick); }
  get status() { return { ready: this.ready && !this.failure && !this.entities?.status.failed && performance.now() < this.authorityUntil &&
      performance.now() < this.outpostViewUntil && !this.outpostsNeedSync,
    epoch: this.authorityEpoch ?? 0, targetTick: this.ready ? this.targetTick() : null, uncertaintyMs: Number.isFinite(this.clock.uncertaintyMs) ? this.clock.uncertaintyMs : null,
    entities: this.entities?.status, region: this.options.region ?? 'world', outpostRevision: this.outpostReplica.cursor?.revision,
    campaign: this.campaign?.status }; }
  private outpostsNeedSync = false;
  private readonly pending = new Set<Promise<unknown>>();
  constructor(private readonly game: Game, readonly options: WorldNodeOptions, private readonly capacity: number, private readonly entities?: EntityPool) {
    this.control = new ControlClient(options.url, options.secret);
    this.gathering = new Gathering(game, (player, node, expected) => this.extract(player, node, expected));
    this.outpostReplica = new OutpostReplica(game.world.outposts, { id: options.id, planet: options.planet, region: options.region ?? 'world' });
  }
  attachBots(bots: Bot[], targetPopulation: number): void {
    if (this.campaign) throw new Error('Campaign roster is already attached');
    this.campaign = new OrbitalCampaign(this.game,bots,{
      planet:this.options.planet,
      call:<T>(method:string,body:unknown)=>this.control.call<T>(method,body),
      authority:()=>this.authorityEpoch===undefined?null:{id:this.options.id,epoch:this.authorityEpoch},
      ready:()=>this.status.ready,
      populationLimit:()=>{
        let humans=0;for(const p of this.game.players.values())if(!p.isBot)humans++;
        return Math.max(0,targetPopulation-humans);
      },
      owns:(x,z)=>!!this.ownershipBounds && x>=this.ownershipBounds.minX && x<this.ownershipBounds.maxX &&
        z>=this.ownershipBounds.minZ && z<this.ownershipBounds.maxZ,
    });
  }
  botCommand(bot: Bot, command: InputCmd): InputCmd { return this.campaign?.command(bot,command)??command; }
  protectBot(bot: Bot): boolean { return this.campaign?.protected(bot)??false; }
  frozenBot(bot: Bot): boolean { return this.campaign?.frozen(bot)??false; }
  retireBot(bot: Bot): void { this.campaign?.retire(bot); }
  async start(port: number): Promise<void> {
    this.endpoint = this.options.advertise ?? `ws://127.0.0.1:${port}/ws`;
    const layout = await this.control.call<RegionLayout>('regions/layout', { planet: this.options.planet });
    this.ownershipBounds = new RegionGrid(layout).get(this.options.region ?? 'world');
    if (!this.ownershipBounds) throw new Error('World region is not in the configured layout');
    const waitingUntil = performance.now() + NODE_TIMEOUT_MS + 2500;
    for (;;) {
      try { await this.heartbeat(); break; }
      catch (error) {
        if (!(error instanceof ControlError) || error.code !== 'busy' || performance.now() >= waitingUntil) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    this.game.initializeClock(this.targetTick());
    this.game.camps.enabled = true;
    this.ready = true;
    this.resourceTimer = setInterval(() => {
      if (this.resourceSync || !this.status.ready) return;
      const players = [...this.leases.values()].filter(l => l.player && !l.transferring).map(l => l.player!);
      const ids = this.gathering.viewIds(players), began = performance.now();
      if (!ids.length) return;
      this.resourceSync = this.control.call<{ id: string; readyAt: number }[]>('resources/view', {
        authority: { id: this.options.id, epoch: this.authorityEpoch }, ids,
      }).then(rows => { this.gathering.applyView(rows, began); })
        .catch(error => { console.error('Resource view:', (error as Error).message); })
        .finally(() => { this.resourceSync = null; });
    }, 1000);
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.heartbeat().catch(error => {
        if (error instanceof ControlError && error.code === 'fenced') this.failure = error;
        console.error('World coordinator heartbeat:', (error as Error).message);
      }).finally(() => { this.inFlight = null; });
    }, 2000);
  }
  async claim(req: IncomingMessage): Promise<Lease> {
    if (!trustedNode(req, this.options.secret)) throw new Error('Private world endpoint');
    if (!this.status.ready) throw new Error('World authority is not ready');
    const key = req.headers['x-mmofps-identity'];
    if (typeof key !== 'string' || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Missing identity');
    this.leases.get(key)?.conn?.disconnect();
    const holder = `${this.options.id}:${randomUUID()}`;
    let grant: LeaseGrant | undefined, began = performance.now();
    for (let attempt = 0; attempt < 20; attempt++) {
      began = performance.now();
      try { grant = await this.control.claim(key, this.options.planet, holder, this.options.id); break; }
      catch (error) {
        if (!(error instanceof ControlError) || error.code !== 'busy' || attempt === 19) throw error;
        await new Promise(resolve => setTimeout(resolve, 150));
      }
      if (req.socket.destroyed) throw new Error('Connection ended before admission');
    }
    if (!grant) throw new Error('No lease granted');
    const lease: Lease = { key, holder, entityId: grant.entityId, epoch: grant.epoch, state: grant.state, validUntil: began + grant.ttl - 1000, conn: null, player: null, transferring: false };
    this.leases.set(key, lease); return lease;
  }
  bind(lease: Lease, conn: PlayerConn): void { lease.conn = conn; }
  abandon(lease: Lease): void {
    if (this.leases.get(lease.key) === lease) this.leases.delete(lease.key);
    this.track(this.control.call('vacate', { key: lease.key, epoch: lease.epoch, holder: lease.holder }));
  }
  private track(operation: Promise<unknown>): void {
    const tracked = operation.catch(error => console.error('Character coordinator:', (error as Error).message)).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }
  lifecycle(lease: Lease): ConnectionLifecycle {
    return {
      entityId: lease.entityId,
      joined: player => {
        if (!this.status.ready || performance.now() >= lease.validUntil) throw new Error('Admission lease expired');
        lease.player = player;
        if (lease.state) restorePlayer(this.game, player, lease.state);
      },
      leaving: player => {
        this.gathering.forget(player);
        if (this.leases.get(lease.key) === lease) {
          this.launches.delete(lease.key); this.leases.delete(lease.key);
        }
        this.track(this.control.call('release', this.checkpoint(lease, player)));
        lease.player = null;
      },
      travel: (player, planet) => this.launch(lease, player, planet),
      construct: (player, action) => { this.track(this.construct(lease, player, action)); },
      harvest: (player, held) => { if (this.status.ready && this.leases.get(lease.key) === lease && lease.player === player) this.gathering.hold(player, held); },
      closed: () => { if (this.leases.get(lease.key) === lease) this.abandon(lease); },
    };
  }
  private checkpoint(lease: Lease, player = lease.player!): Checkpoint {
    return { key: lease.key, holder: lease.holder, epoch: lease.epoch, state: capturePlayer(this.game, player) };
  }
  private async heartbeat(): Promise<void> {
    const began = performance.now(), active = [...this.leases.values()].filter(l => l.player && !l.transferring);
    const rows = active.map(l => this.checkpoint(l));
    let humans = 0; for (const p of this.game.players.values()) if (!p.isBot) humans++;
    const grant = await this.control.call<AuthorityGrant>('register', { id: this.options.id, planet: this.options.planet,
      region: this.options.region ?? 'world', url: this.endpoint, capacity: this.capacity, humans, tick: this.game.tick, epoch: this.authorityEpoch,
      ...(this.game.frontier && this.ownershipBounds ? regionalOwnership(this.game.frontier.territories, this.ownershipBounds) : {}) });
    if (this.authorityEpoch !== undefined && grant.epoch !== this.authorityEpoch) throw new ControlError('fenced', 'World authority changed');
    this.entities?.bind(grant.epoch);
    this.authorityEpoch = grant.epoch;
    this.authorityUntil = began + grant.ttl - 1000;
    this.clock.observe(grant.clockTick, began);
    this.outpostReplica.bind(grant.epoch);
    await this.syncOutposts();
    if (!active.length) return;
    for (let offset = 0; offset < rows.length; offset += 512) {
      const checkpointBegan = performance.now();
      const response = await this.control.call<{ accepted: string[]; ttl: number }>('checkpoint', { rows: rows.slice(offset, offset + 512) });
      const accepted = new Set(response.accepted);
      for (const lease of active.slice(offset, offset + 512)) {
        if (accepted.has(lease.key)) lease.validUntil = checkpointBegan + response.ttl - 1000;
        else lease.conn?.disconnect(1013, 'Character ownership changed');
      }
    }
  }
  private async syncOutposts(): Promise<void> {
    const epoch = this.authorityEpoch!, generation = this.outpostSyncGeneration, began = performance.now();
    const view = await this.control.call<RegionalOutposts>('outposts/region', {
      authority: { id: this.options.id, epoch }, since: this.outpostsNeedSync ? undefined : this.outpostReplica.cursor,
    });
    // A request made before an uncertain construction outcome is not the
    // recovery read for that outcome. Wait for a fresh request instead.
    if (generation !== this.outpostSyncGeneration || epoch !== this.authorityEpoch) return;
    if (!this.outpostReplica.apply(view)) return;
    this.outpostsNeedSync = false;
    this.outpostViewUntil = began + NODE_TIMEOUT_MS - 1000;
    if (view.sites && this.ready) for (const p of this.game.players.values()) this.game.camps.send(p);
  }
  private invalidateOutposts(): void { this.outpostSyncGeneration++; this.outpostsNeedSync = true; }
  /** Checked before every simulation tick, independently of network progress. */
  step(): boolean {
    if (this.failure) throw this.failure;
    if (!this.ready || this.outpostsNeedSync || performance.now() >= this.authorityUntil || performance.now() >= this.outpostViewUntil) {
      for (const lease of this.leases.values()) lease.conn?.disconnect(1013, 'World authority is reconnecting');
      return false;
    }
    this.entities?.pump();
    this.campaign?.step();
    for (const lease of this.leases.values()) if (performance.now() >= lease.validUntil) lease.conn?.disconnect(1013, 'Reconnecting to character authority');
    for (const lease of this.leases.values()) if (lease.player && !lease.transferring && this.game.players.get(lease.player.id) === lease.player)
      this.gathering.step(lease.player, !!lease.building || this.launches.has(lease.key));
    for (const launch of this.launches.values()) {
      const p = launch.lease.player;
      if (!p || !p.state.alive || p.state.vehicle || p.state.airlift || p.health < launch.health || Math.hypot(p.state.px - launch.x, p.state.py - launch.y, p.state.pz - launch.z) > 1.5) {
        this.launches.delete(launch.lease.key); this.send(launch.lease, { phase: 'cancelled', destination: launch.destination, remaining: 0, message: 'Launch cancelled. Hold position at the pod.' }); continue;
      }
      const remaining = ORBITAL_CHARGE_SECONDS - (this.game.tick - launch.tick) / TICK_RATE;
      if (remaining <= 0) {
        this.launches.delete(launch.lease.key);
        this.track(this.depart(launch.lease, p, launch.destination));
      } else if (this.game.tick % 6 === 0) this.send(launch.lease, { phase: 'charging', destination: launch.destination, remaining });
    }
    return true;
  }
  private async extract(player: ServerPlayer, node: ResourceNode, expected: number): Promise<ResourceReceipt> {
    const lease = [...this.leases.values()].find(l => l.player === player);
    if (!lease || lease.building || lease.transferring || this.launches.has(lease.key) || !this.status.ready || performance.now() >= lease.validUntil)
      throw new Error('Extraction is unavailable');
    lease.building = true;
    const row = this.checkpoint(lease, player), request = randomUUID();
    const operation = (async () => {
      try {
        let receipt: ResourceReceipt | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try { receipt = await this.control.call('resources/harvest', { row, request, id: node.id, expected }); break; }
          catch (error) {
            if (error instanceof ControlError && ['invalid', 'fenced', 'busy'].includes(error.code)) {
              if (attempt > 0 || error.code === 'fenced') lease.conn?.disconnect(1013, 'Reconnecting to saved extraction');
              throw error;
            }
            if (attempt === 2) { lease.conn?.disconnect(1013, 'Reconnecting to saved extraction'); throw error; }
          }
        }
        if (!receipt) throw new Error('Extraction did not complete');
        player.salvage = Math.max(0, player.salvage + Math.max(0, receipt.earned - player.salvageEarned) - Math.max(0, receipt.spent - player.salvageSpent));
        player.salvageEarned = Math.max(player.salvageEarned, receipt.earned); player.salvageSpent = Math.max(player.salvageSpent, receipt.spent);
        player.sink?.send(encodeServerMessage(`Xenolite extracted · +${RESOURCE_YIELD} salvage`));
        this.game.frontier?.send(player, this.game.players.values(), this.game.tick);
        return receipt;
      } catch (error) { player.sink?.send(encodeServerMessage((error as Error).message)); throw error; }
      finally { lease.building = false; }
    })();
    this.track(operation); return operation;
  }
  private async construct(lease: Lease, player: ServerPlayer, action: OutpostAction): Promise<void> {
    if (lease.building || lease.transferring || this.launches.has(lease.key)) return;
    if (!this.status.ready || performance.now() >= lease.validUntil) return;
    lease.building = true;
    let site: OutpostSite | undefined;
    let location: OutpostSite;
    try {
      if (action.action === 'build') location = site = this.game.camps.prepare(player, action.type, action.x, action.z, action.facing);
      else location = this.game.camps.prepareRemoval(player, action.id);
      const row = this.checkpoint(lease, player), id = randomUUID();
      let committed: { site: Outpost | null; spent: number; revision: number; cell: OutpostCellUpdate } | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          committed = await this.control.call('construct', { row, id, site, remove: action.action === 'remove' ? action.id : undefined }); break;
        } catch (error) {
          if (error instanceof ControlError && ['invalid', 'fenced'].includes(error.code)) {
            if (attempt > 0) { this.invalidateOutposts(); lease.conn?.disconnect(1013, 'Reconnecting to saved camp'); }
            throw error;
          }
          if (attempt === 2) {
            // The response may have been lost after a durable commit. Pause
            // this world's simulation until its collider set is reloaded.
            this.invalidateOutposts();
            lease.conn?.disconnect(1013, 'Reconnecting to saved camp');
            throw error;
          }
        }
      }
      if (!committed) return;
      player.salvage = Math.max(0, player.salvage - Math.max(0, committed.spent - player.salvageSpent));
      player.salvageSpent = committed.spent;
      this.outpostReplica.commit(committed.cell, location);
      player.sink?.send(encodeServerMessage(committed.site ? 'Camp module built. Your progress is saved.' : 'Module packed. Salvage is not recovered.'));
      for (const observer of this.game.players.values()) this.game.camps.send(observer);
      this.game.frontier?.send(player, this.game.players.values(), this.game.tick);
    } catch (error) {
      player.sink?.send(encodeServerMessage((error as Error).message));
    } finally {
      if (site) this.game.camps.reservations.delete(site);
      lease.building = false;
    }
  }
  private launch(lease: Lease, player: ServerPlayer, planet: number): void {
    const destination = PLANETS[planet]?.id;
    if (!destination || destination === this.options.planet || lease.transferring || lease.building || this.launches.has(lease.key)) return;
    const s = player.state, near = nearestSpaceport(this.game.world, { x: s.px, y: s.py, z: s.pz });
    if (!s.alive || s.vehicle || s.airlift || !near || near.distance > 5.5) {
      this.send(lease, { phase: 'cancelled', destination, remaining: 0, message: 'Reach an orbital transit pod on foot.' }); return;
    }
    this.launches.set(lease.key, { lease, destination, tick: this.game.tick, x: s.px, y: s.py, z: s.pz, health: player.health });
    this.send(lease, { phase: 'charging', destination, remaining: ORBITAL_CHARGE_SECONDS });
  }
  private async depart(lease: Lease, player: ServerPlayer, destination: PlanetId): Promise<void> {
    const row = this.checkpoint(lease, player), id = randomUUID();
    try { lease.conn?.pauseForTransfer(); }
    catch (error) {
      console.error('Travel state could not be prepared:', (error as Error).message);
      this.send(lease, { phase: 'cancelled', destination, remaining: 0, message: 'Launch interrupted. Try again from the pod.' });
      return;
    }
    lease.transferring = true;
    this.send(lease, { phase: 'departing', destination, remaining: 0 });
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.control.call('transfer', { row, destination, id });
        this.send(lease, { phase: 'committed', destination, remaining: 0 });
        return;
      } catch (error) {
        failure = error;
        if (error instanceof ControlError && ['full', 'unavailable', 'invalid', 'fenced'].includes(error.code)) break;
      }
    }
    // A missing response is not evidence that commit failed. Ask the durable
    // owner before restoring a source actor; otherwise reconnect and resolve there.
    try {
      const owner = await this.control.call<{ epoch: number; holder: string; planet: PlanetId } | null>('locate', { key: lease.key });
      if (owner?.planet === destination && owner.epoch > lease.epoch) {
        this.send(lease, { phase: 'committed', destination, remaining: 0 }); return;
      }
      if (owner?.holder === lease.holder && owner.epoch === lease.epoch && performance.now() < lease.validUntil && lease.player) {
        lease.transferring = false; lease.conn?.resumeAfterTransfer();
        this.send(lease, { phase: 'cancelled', destination, remaining: 0, message: failure instanceof ControlError ? failure.message : 'Travel interrupted. Your character remains here.' }); return;
      }
    } catch { /* Ownership cannot be proved while the coordinator is unavailable. */ }
    lease.conn?.disconnect(1013, 'Reconnecting to saved journey');
  }
  private send(lease: Lease, state: JourneyState): void { lease.conn?.send(encodeJourney(state)); }
  async close(): Promise<void> {
    this.ready = false;
    if (this.timer) clearInterval(this.timer);
    if (this.resourceTimer) clearInterval(this.resourceTimer);
    await this.campaign?.close();
    await this.resourceSync;
    await this.inFlight;
    await this.entities?.close();
    await Promise.all([...this.pending]);
    const jobs = [...this.leases.values()].filter(l => l.player).map(l => this.control.call('release', this.checkpoint(l)).catch(() => {}));
    await Promise.all(jobs);
    if (this.authorityEpoch !== undefined) await this.control.call('unregister', { id: this.options.id, epoch: this.authorityEpoch }).catch(() => {});
  }
}
