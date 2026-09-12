import { BTN, PLAYER, TICK_RATE } from '@shared/index';
import { ResourceField, RESOURCE_REACH, RESOURCE_SECONDS, type ResourceNode, type ResourceSnapshot } from '@shared/resources';
import { encodeResources } from '@shared/resource-wire';
import type { Game, ServerPlayer } from './game.js';
import type { ResourceReceipt } from './resource-ledger.js';

interface Observer {
  player: ServerPlayer; nodes: ResourceNode[]; cell: string; refreshed: number; heldUntil: number;
  channel: { node: ResourceNode; tick: number; x: number; y: number; z: number; health: number } | null;
  pending: boolean;
}
/** Holds are short leases, independent of movement bits and client clocks. */
export class Gathering {
  readonly field: ResourceField;
  private readonly observers = new Map<number, Observer>();
  private readonly depletion = new Map<string, { readyAt: number; syncedAt: number }>();
  constructor(private readonly game: Game,
    private readonly extract: (player: ServerPlayer, node: ResourceNode, expected: number) => Promise<ResourceReceipt>,
    private readonly now: () => number = () => performance.now()) { this.field = new ResourceField(game.world); }
  private watch(player: ServerPlayer): Observer {
    let observer = this.observers.get(player.id);
    if (!observer || observer.player !== player) {
      observer = { player, nodes: [], cell: '', refreshed: -Infinity, heldUntil: 0, channel: null, pending: false };
      this.observers.set(player.id, observer);
    }
    const cell = `${Math.floor(player.state.px / 128)},${Math.floor(player.state.pz / 128)}`;
    if (cell !== observer.cell || this.game.tick - observer.refreshed >= 60) {
      observer.nodes = this.field.near(player.state.px, player.state.pz);
      observer.cell = cell; observer.refreshed = this.game.tick;
    }
    return observer;
  }
  hold(player: ServerPlayer, held: boolean): void {
    const observer = this.watch(player); observer.heldUntil = held ? this.now() + 850 : 0;
    if (!held) observer.channel = null;
  }
  forget(player: ServerPlayer): void {
    if (this.observers.get(player.id)?.player === player) this.observers.delete(player.id);
  }
  viewIds(players: ServerPlayer[]): string[] {
    const current = new Set(players);
    for (const [id, o] of this.observers) if (!current.has(o.player)) this.observers.delete(id);
    const ids = new Set(players.flatMap(p => this.watch(p).nodes.map(n => n.id)));
    for (const id of this.depletion.keys()) if (!ids.has(id)) this.depletion.delete(id);
    return [...ids];
  }
  applyView(rows: { id: string; readyAt: number }[], began: number): void {
    const visible = new Set([...this.observers.values()].flatMap(o => o.nodes.map(n => n.id)));
    for (const row of rows) if (visible.has(row.id)) {
      const previous = this.depletion.get(row.id);
      // A read started before a committed extraction cannot make it grow back.
      this.depletion.set(row.id, { readyAt: Math.max(previous?.readyAt ?? 0, row.readyAt), syncedAt: Math.max(previous?.syncedAt ?? -Infinity, began) });
    }
  }
  private target(observer: Observer): ResourceNode | undefined {
    const p = observer.player, s = p.state;
    if (!s.alive || s.vehicle || s.airlift) return;
    return observer.nodes.find(n => {
      if (Math.hypot(n.x - s.px, n.y - s.py, n.z - s.pz) > RESOURCE_REACH) return false;
      const dx = n.x - s.px, dy = n.y + .7 - s.py - PLAYER.EYE_HEIGHT, dz = n.z - s.pz, distance = Math.hypot(dx, dy, dz);
      return distance < .1 || !this.game.world.trace(s.px, s.py + PLAYER.EYE_HEIGHT, s.pz, dx / distance, dy / distance, dz / distance, distance - .1).hit;
    });
  }
  snapshot(player: ServerPlayer): ResourceSnapshot {
    const observer = this.watch(player), target = this.target(observer), known = target && this.depletion.get(target.id);
    const fresh = !!known && this.now() - known.syncedAt < 5000, combat = player.regenBlockUntil > this.game.tick;
    return { enabled: fresh && !combat, target: target?.id ?? '', reason: !fresh ? 'Synchronizing deposit…' : combat ? 'Leave combat to extract.' : '',
      progress: observer.pending ? 1 : observer.channel ? Math.min(1, (this.game.tick - observer.channel.tick) / (RESOURCE_SECONDS * TICK_RATE)) : 0,
      saving: observer.pending, nodes: observer.nodes.map(n => ({ ...n, remaining: Math.max(0, ((this.depletion.get(n.id)?.readyAt ?? 0) - this.game.tick) / TICK_RATE) })) };
  }
  step(player: ServerPlayer, busy = false): void {
    const observer = this.watch(player), s = player.state, target = this.target(observer);
    const known = target && this.depletion.get(target.id), channel = observer.channel;
    // Small collision corrections on gentle ground should not restart a hold.
    // Deliberate movement cancels immediately, independently of displacement.
    const moved = channel && Math.hypot(s.px - channel.x, s.py - channel.y, s.pz - channel.z) > 1.5;
    const firing = (player.lastCmd?.buttons ?? 0) & (BTN.FIRE | BTN.ALTFIRE | BTN.USE |
      BTN.FORWARD | BTN.BACK | BTN.LEFT | BTN.RIGHT | BTN.JUMP | BTN.DODGE);
    const valid = !busy && !observer.pending && observer.heldUntil > this.now() && target && known &&
      this.now() - known.syncedAt < 5000 && known.readyAt <= this.game.tick && !firing &&
      player.regenBlockUntil <= this.game.tick && !moved && (!channel || player.health >= channel.health);
    if (!valid || channel && channel.node.id !== target?.id) observer.channel = null;
    if (valid && !observer.channel) observer.channel = { node: target, tick: this.game.tick, x: s.px, y: s.py, z: s.pz, health: player.health };
    if (valid && observer.channel && this.game.tick - observer.channel.tick >= RESOURCE_SECONDS * TICK_RATE) {
      observer.pending = true; observer.channel = null;
      void this.extract(player, target, known.readyAt).then(receipt => {
        const prior = this.depletion.get(receipt.id);
        this.depletion.set(receipt.id, { readyAt: Math.max(prior?.readyAt ?? 0, receipt.readyAt), syncedAt: this.now() });
      }).catch(() => { observer.heldUntil = 0; }).finally(() => { observer.pending = false; });
    }
    if (this.game.tick % (target ? 12 : 60) === 0) player.sink?.send(encodeResources(this.snapshot(player)));
  }
}
