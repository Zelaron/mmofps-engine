import { Msg } from './protocol.js';
import type { JourneyState } from './universe.js';
export function encodeJourney(state: JourneyState): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(state)), out = new Uint8Array(bytes.length + 1);
  out[0] = Msg.SJourney; out.set(bytes, 1); return out;
}
export function decodeJourney(data: ArrayBuffer): JourneyState {
  if (data.byteLength > 4096) throw new Error('Journey message exceeds budget');
  return JSON.parse(new TextDecoder().decode(new Uint8Array(data, 1))) as JourneyState;
}
