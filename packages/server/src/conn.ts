import { decodeOutpostAction } from '@shared/outpost-wire';
import type { OutpostAction } from '@shared/outposts';
import type { WebSocket, RawData } from 'ws';
import {
  Msg, ByteReader, decodeInput, encodeWelcome, encodePong, NET,
  PROTOCOL_VERSION, decodeClientChat, encodeServerMessage,
} from '@shared/index';
import type { Game, ServerPlayer, PlayerSink } from './game.js';
import { ChatRoom, chatRoomFor } from './chat.js';
import type { DetachedHandoff } from './runtime-handoff.js';

// One live WebSocket = one PlayerConn = one ServerPlayer (after hello).

const MAX_BUFFERED = 1_500_000; // drop clients that can't keep up

export interface ConnectionLifecycle {
  entityId?: number;
  joined?(player: ServerPlayer): void;
  leaving?(player: ServerPlayer): void;
  travel?(player: ServerPlayer, planet: number): void;
  construct?(player: ServerPlayer, action: OutpostAction): void;
  harvest?(player: ServerPlayer, held: boolean): void;
  closed?(): void;
}
export class PlayerConn implements PlayerSink {
  player: ServerPlayer | null = null;
  wsAlive = true;
  lastInputWall = Date.now();
  private frozen = false;
  private closed = false;
  private detached: DetachedHandoff | null = null;

  constructor(
    private readonly ws: WebSocket,
    private readonly game: Game,
    private readonly maxPlayers: number,
    private readonly chat: ChatRoom = chatRoomFor(game),
    private readonly lifecycle: ConnectionLifecycle = {},
  ) {
    ws.binaryType = 'arraybuffer';
    ws.on('message', (data) => this.onMessage(data));
    ws.on('pong', () => { this.wsAlive = true; });
    ws.on('close', () => this.onClose());
    ws.on('error', () => this.onClose());
  }

  send(bytes: Uint8Array): void {
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      this.ws.close(1008, 'too slow');
      return;
    }
    this.ws.send(bytes);
  }

  private onMessage(data: RawData): void {
    if (this.frozen || this.closed) return;
    let bytes: Uint8Array;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (Array.isArray(data)) bytes = new Uint8Array(Buffer.concat(data));
    else bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length === 0 || bytes.length > 1024) return;

    try {
      const r = new ByteReader(bytes);
      const type = r.u8();

      if (!this.player) {
        if (type !== Msg.CHello) { this.ws.close(1002, 'hello first'); return; }
        const version = r.u8();
        if (version !== PROTOCOL_VERSION) {
          this.ws.close(1002, `protocol v${PROTOCOL_VERSION} required`);
          return;
        }
        let name = r.str().replace(/[^\x20-\x7e]/g, '').trim().slice(0, NET.MAX_NAME_LEN);
        let humans = 0; for (const p of this.game.players.values()) if (!p.isBot) humans++;
        if (humans >= this.maxPlayers) {
          this.ws.close(1013, 'server full');
          return;
        }
        this.player = this.game.addPlayer(name || 'Guest', this, false, this.lifecycle.entityId);
        this.lifecycle.joined?.(this.player);
        this.send(encodeWelcome(this.player.id, this.game.seed, this.game.tick, this.game.baseTeleporterPads));
        this.game.sendRoster(this.player);
        this.game.camps.send(this.player, true);
        this.game.frontier?.send(this.player, this.game.players.values(), this.game.tick);
        this.chat.join(this.player);
        console.log(`[join] #${this.player.id} ${this.player.name} (${this.game.players.size} players)`);
        return;
      }

      switch (type) {
        case Msg.CRespawn: {
          const id = r.str();
          if (bytes.length !== new TextEncoder().encode(id).length + 2 || !this.game.requestRespawn(this.player, id)) {
            this.send(encodeServerMessage('That reinforcement point is no longer available.'));
            this.game.frontier?.send(this.player, this.game.players.values(), this.game.tick);
          }
          break;
        }
        case Msg.CDeploy: {
          const id = r.str();
          if (bytes.length !== new TextEncoder().encode(id).length + 2) break;
          const refusal = this.game.deployNow(this.player, id);
          if (refusal) this.send(encodeServerMessage(refusal));
          this.game.frontier?.send(this.player, this.game.players.values(), this.game.tick);
          break;
        }
        case Msg.CHarvest: {
          if (bytes.length !== 2 || bytes[1] > 1) throw new Error('Invalid extraction input');
          this.lifecycle.harvest?.(this.player, bytes[1] === 1); break;
        }
        case Msg.COutpost: this.lifecycle.construct?.(this.player, decodeOutpostAction(r)); break;
        case Msg.CPlanet: if (bytes.length === 2) this.lifecycle.travel?.(this.player, r.u8()); break;
        case Msg.CFaction: {
          if (bytes.length !== 2 || !this.game.frontier) break;
          const message = this.game.frontier.enlist(this.player, r.u8(), this.game.tick);
          if (message) this.send(encodeServerMessage(message));
          this.game.frontier.send(this.player, this.game.players.values(), this.game.tick);
          break;
        }
        case Msg.CTravel: if (bytes.length === 2) this.game.requestAirlift(this.player, r.u8()); break;
        case Msg.CChat: this.chat.receive(this.player, decodeClientChat(r)); break;
        case Msg.CInput: {
          this.lastInputWall = Date.now();
          this.game.queueInput(this.player, decodeInput(r));
          break;
        }
        case Msg.CPing: {
          const sentAt = r.f64();
          const rtt = r.u16();
          this.player.ping = rtt;
          this.send(encodePong(sentAt, this.game.tick));
          break;
        }
      }
    } catch {
      this.ws.close(1002, 'bad message');
    }
  }

  disconnect(code = 4001, reason = 'Session opened elsewhere'): void { this.onClose(); this.ws.close(code, reason); }
  pauseForTransfer(): void {
    if (!this.player) return;
    this.detached = this.game.takeHandoff([this.player.id]);
    this.frozen = true;
  }
  resumeAfterTransfer(): void {
    if (!this.player || !this.frozen || !this.detached) return;
    this.game.restoreHandoff(this.detached);
    this.detached = null; this.frozen = false;
  }

  private onClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.detached = null;
    if (this.player) {
      this.lifecycle.leaving?.(this.player);
      const current = this.game.players.get(this.player.id);
      // A committed return may already have installed a different object
      // with this durable ID before the old socket's close event arrives.
      if (!current || current === this.player) this.chat.leave(this.player);
      console.log(`[leave] #${this.player.id} ${this.player.name}`);
      if (current === this.player) this.game.removePlayer(this.player.id);
      this.player = null;
    }
    this.lifecycle.closed?.();
  }
}
