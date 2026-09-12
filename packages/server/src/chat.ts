import { CHAT_HISTORY_LIMIT, cleanChat, encodeChat, encodeServerMessage, type ChatMessage } from '@shared/index';
import type { Game, ServerPlayer } from './game.js';

/** Small global room, independent of the expensive simulation/interest pass. */
export class ChatRoom {
  readonly history: ChatMessage[] = [];
  private sequence = 0;
  private readonly limits = new Map<number, { tokens: number; time: number; notice: number }>();
  constructor(private readonly game: Game, private readonly now = () => Date.now()) {}
  join(player: ServerPlayer): void {
    for (const message of this.history) player.sink?.send(encodeChat({ ...message, history: true }));
  }
  leave(player: ServerPlayer): void { this.limits.delete(player.id); }
  receive(player: ServerPlayer, raw: string): boolean {
    const text = cleanChat(raw);
    if (!text || this.game.players.get(player.id) !== player || player.isBot) return false;
    const now = this.now(), limit = this.limits.get(player.id) ?? { tokens: 3, time: now, notice: -Infinity };
    limit.tokens = Math.min(3, limit.tokens + Math.max(0, now - limit.time) / 1200); limit.time = now;
    this.limits.set(player.id, limit);
    if (limit.tokens < 1) {
      if (now - limit.notice > 2500) { player.sink?.send(encodeServerMessage('Chat: please wait a moment before sending again.')); limit.notice = now; }
      return false;
    }
    limit.tokens--;
    const message: ChatMessage = { id: ++this.sequence, playerId: player.id, name: player.name, text, time: now };
    this.history.push(message);
    if (this.history.length > CHAT_HISTORY_LIMIT) this.history.shift();
    const bytes = encodeChat(message);
    for (const recipient of this.game.players.values()) recipient.sink?.send(bytes);
    return true;
  }
}
const rooms = new WeakMap<Game, ChatRoom>();
export function chatRoomFor(game: Game): ChatRoom {
  let room = rooms.get(game);
  if (!room) { room = new ChatRoom(game); rooms.set(game, room); }
  return room;
}
