import { Msg } from './protocol.js';
import type { FrontierState } from './frontier.js';
const encoder = new TextEncoder(), decoder = new TextDecoder();
/** The legacy protocol's str() is a 255-byte chat/name field. Strategic
 * messages have their own bounded UTF-8 payload and must never use str(). */
export function encodeFrontierState(state: FrontierState): Uint8Array {
  const json = encoder.encode(JSON.stringify(state));
  if (json.length > 64 * 1024) throw new Error('Strategic snapshot exceeds budget');
  const message = new Uint8Array(json.length + 1); message[0] = Msg.SFrontier; message.set(json, 1); return message;
}
export function decodeFrontierState(message: ArrayBuffer): FrontierState {
  if (message.byteLength > 64 * 1024 + 1) throw new Error('Strategic snapshot exceeds budget');
  return JSON.parse(decoder.decode(new Uint8Array(message, 1))) as FrontierState;
}
