import { decodeOutposts } from '@shared/outpost-wire';
import { decodeResources } from '@shared/resource-wire';
import type { ResourceSnapshot } from '@shared/resources';
import type { OutpostSnapshot } from '@shared/outposts';
import { decodeFrontierState } from '@shared/frontier-wire';
import type { FrontierState } from '@shared/frontier';
import { decodeJourney } from '@shared/journey-wire';
import type { JourneyState } from '@shared/universe';
import {
  Msg, ByteReader,
  decodeWelcome, decodeSnapshot, decodeFire, decodeExplosion, decodeDeath,
  decodeSpawn, decodeHit, decodePickupResult, decodeJoin, decodeScores,
  decodeTeleport, decodeChat, type ChatMessage,
  encodeHello, encodePing,
  PROTOCOL_VERSION, TICK_RATE,
  type WelcomeMsg, type Snapshot, type FireEvent, type ExplosionEvent,
  type DeathEvent, type SpawnEvent, type HitEvent, type PickupResultEvent,
  type JoinEvent, type ScoreRow, type TeleportEvent,
} from '@shared/index';

// WebSocket client + server-clock estimation. The estimated server tick is
// what prediction leads ahead of and interpolation trails behind.

export interface NetHandlers {
  onResources?(state: ResourceSnapshot): void;
  onOutposts?(state: OutpostSnapshot): void;
  onFrontier?(state: FrontierState): void;
  onJourney?(state: JourneyState): void;
  onChat?(message: ChatMessage): void;
  onWelcome(msg: WelcomeMsg): void;
  onSnapshot(snap: Snapshot): void;
  onFire(ev: FireEvent): void;
  onExplosion(ev: ExplosionEvent): void;
  onDeath(ev: DeathEvent): void;
  onSpawn(ev: SpawnEvent): void;
  onHit(ev: HitEvent): void;
  onPickupResult(ev: PickupResultEvent): void;
  onTeleport(ev: TeleportEvent): void;
  onJoin(ev: JoinEvent): void;
  onLeave(id: number): void;
  onScores(rows: ScoreRow[]): void;
  onMessage(text: string): void;
  onClose(code: number, reason: string): void;
}

const MS_PER_TICK = 1000 / TICK_RATE;

export class NetClient {
  private ws: WebSocket | null = null;
  private offsetTicks = 0;
  private hasOffset = false;
  private latestServerTick = 0;
  private lastEstimatedTick = 0;
  private lastSnapshotAt = -Infinity;
  rttMs = 80;
  connected = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly handlers: NetHandlers) {}

  connect(name: string): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) return;
    this.connected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.hasOffset = false; this.latestServerTick = 0; this.lastEstimatedTick = 0;
    this.lastSnapshotAt = -Infinity; this.rttMs = 80;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return;
      ws.send(encodeHello(name));
      this.pingTimer = setInterval(() => {
        this.send(encodePing(performance.now(), this.rttMs));
      }, 1000);
    };
    ws.onmessage = (ev) => { if (this.ws === ws && ws.readyState === WebSocket.OPEN) this.onMessage(ev.data as ArrayBuffer); };
    ws.onclose = event => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.connected = false;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.handlers.onClose(event.code, event.reason);
    };
    ws.onerror = () => { if (this.ws === ws) ws.close(); };
  }

  send(bytes: Uint8Array): void {
    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  private nowTicks(): number {
    return performance.now() / MS_PER_TICK;
  }

  /** Estimated server tick right now (lags true server time by ~downlink). */
  estServerTick(): number {
    if (!this.hasOffset) return this.latestServerTick;
    // A stalled server cannot advance indefinitely in client wall time. Late
    // snapshots can correct the offset backward; hold the displayed timeline
    // until it catches up instead of visibly rewinding shells and vehicles.
    // latestServerTick only increases, so this remains within the same cap.
    const estimate = Math.min(this.nowTicks() + this.offsetTicks, this.latestServerTick + TICK_RATE * .25);
    this.lastEstimatedTick = Math.max(this.lastEstimatedTick, estimate);
    return this.lastEstimatedTick;
  }

  get snapshotAgeMs(): number { return performance.now() - this.lastSnapshotAt; }

  /** Force re-sync after tab-hidden gaps. */
  resync(): void {
    this.hasOffset = false;
    this.lastEstimatedTick = 0;
    this.rttMs = 80;
  }

  private observeTick(serverTick: number): void {
    this.latestServerTick = Math.max(this.latestServerTick, serverTick);
    const raw = serverTick - this.nowTicks();
    if (!this.hasOffset || Math.abs(raw - this.offsetTicks) > 8) {
      this.offsetTicks = raw;
      this.hasOffset = true;
    } else {
      // Bias toward the max (packets can only be late, not early).
      this.offsetTicks += 0.06 * (raw - this.offsetTicks);
    }
  }

  private onMessage(data: ArrayBuffer): void {
    const r = new ByteReader(data);
    if (r.length === 0) return;
    const type = r.u8();
    const h = this.handlers;
    switch (type) {
      case Msg.SOutposts: h.onOutposts?.(decodeOutposts(r)); break;
      case Msg.SResources: h.onResources?.(decodeResources(r)); break;
      case Msg.SJourney: h.onJourney?.(decodeJourney(data)); break;
      case Msg.SFrontier: h.onFrontier?.(decodeFrontierState(data)); break;
      case Msg.SSnapshot: {
        const snap = decodeSnapshot(r);
        this.lastSnapshotAt = performance.now();
        this.observeTick(snap.tick);
        h.onSnapshot(snap);
        break;
      }
      case Msg.SWelcome: {
        // Check before decoding the version-specific body, including an old
        // welcome that has no layout payload at all.
        const version = r.u8();
        if (version !== PROTOCOL_VERSION) {
          h.onMessage(
            `Protocol mismatch: server v${version}, client v${PROTOCOL_VERSION}. ` +
            'Refresh after updating the game.',
          );
          this.ws?.close(1002, 'Protocol version mismatch');
          break;
        }
        r.off--;
        const welcome = decodeWelcome(r);
        this.observeTick(welcome.tick);
        this.connected = true;
        h.onWelcome(welcome);
        break;
      }
      case Msg.SPong: {
        const sentAt = r.f64();
        this.observeTick(r.tick());
        const rtt = performance.now() - sentAt;
        this.rttMs = this.rttMs * 0.7 + rtt * 0.3;
        break;
      }
      case Msg.SFire: h.onFire(decodeFire(r)); break;
      case Msg.SExplosion: h.onExplosion(decodeExplosion(r)); break;
      case Msg.SDeath: h.onDeath(decodeDeath(r)); break;
      case Msg.SSpawn: h.onSpawn(decodeSpawn(r)); break;
      case Msg.SHit: h.onHit(decodeHit(r)); break;
      case Msg.SPickupResult: h.onPickupResult(decodePickupResult(r)); break;
      case Msg.STeleport: h.onTeleport(decodeTeleport(r)); break;
      case Msg.SJoin: h.onJoin(decodeJoin(r)); break;
      case Msg.SLeave: h.onLeave(r.entity()); break;
      case Msg.SScores: h.onScores(decodeScores(r)); break;
      case Msg.SMessage: h.onMessage(r.str()); break;
      case Msg.SChat: h.onChat?.(decodeChat(r)); break;
    }
  }
}
