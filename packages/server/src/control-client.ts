import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { LeaseGrant } from './coordinator.js';
import type { PlanetId } from '@shared/universe';
export function trustedNode(req: IncomingMessage, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(req.headers.authorization ?? '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export class ControlClient {
  constructor(readonly url: string, readonly secret: string) {}
  async call<T>(method: string, body: unknown): Promise<T> {
    try { return await this.request<T>(method, body); }
    catch (error) {
      // Long procedural startup can outlive a pooled HTTP connection. These
      // bootstrap operations are idempotent for the exact same identity
      // and epoch, including a commit whose response was lost. Other writes
      // keep their own explicit receipt/recovery policies in WorldNode.
      if (error instanceof ControlError || !['namespace', 'register', 'entities/reserve', 'regions/layout'].includes(method)) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
      return this.request<T>(method, body);
    }
  }
  private async request<T>(method: string, body: unknown): Promise<T> {
    const response = await fetch(`${this.url}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.secret}` },
      body: JSON.stringify(body), signal: AbortSignal.timeout(2500) });
    const value = await response.json() as { code: string; message: string; planet?: PlanetId };
    if (!response.ok) throw new ControlError(value.code, value.message, value.planet);
    return value as T;
  }
  claim(key: string, planet: PlanetId, holder: string, node: string): Promise<LeaseGrant> { return this.call('claim', { key, planet, holder, node }); }
}
export class ControlError extends Error {
  constructor(readonly code: string, message: string, readonly planet?: PlanetId) { super(message); }
}
