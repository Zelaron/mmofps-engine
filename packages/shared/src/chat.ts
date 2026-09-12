import { ByteReader, ByteWriter, Msg } from './protocol.js';

export const CHAT_MAX_LENGTH = 160;
export const CHAT_HISTORY_LIMIT = 80;
export const CHAT_DISPLAY_MS = 10_000;
export interface ChatMessage {
  id: number; playerId: number; name: string; text: string; time: number;
  history?: boolean;
}
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function cleanChat(text: string): string {
  return [...text.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim()].slice(0, CHAT_MAX_LENGTH).join('');
}
function writeText(w: ByteWriter, text: string): void {
  const bytes = encoder.encode(cleanChat(text));
  w.u16(bytes.length);
  for (const byte of bytes) w.u8(byte);
}
function readText(r: ByteReader): string {
  const length = r.u16();
  if (length > CHAT_MAX_LENGTH * 4 || length > r.remaining) throw new Error('Invalid chat length');
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = r.u8();
  const text = cleanChat(decoder.decode(bytes));
  if (r.remaining !== 0) throw new Error('Unexpected chat data');
  return text;
}
export function encodeClientChat(text: string): Uint8Array {
  const w = new ByteWriter().u8(Msg.CChat); writeText(w, text); return w.finish();
}
export function decodeClientChat(r: ByteReader): string { return readText(r); }
export function encodeChat(message: ChatMessage): Uint8Array {
  const w = new ByteWriter().u8(Msg.SChat).u32(message.id).entity(message.playerId)
    .u8(message.history ? 1 : 0).f64(message.time).str(message.name);
  writeText(w, message.text); return w.finish();
}
export function decodeChat(r: ByteReader): ChatMessage {
  const id = r.u32(), playerId = r.entity(), history = r.u8() === 1, time = r.f64(), name = r.str();
  return { id, playerId, history, time, name, text: readText(r) };
}
