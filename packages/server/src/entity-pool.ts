import { randomUUID } from 'node:crypto';
import { entityBlockRange, ENTITY_BLOCK_SIZE, MAX_ENTITY_BLOCK, type EntityAllocator } from '@shared/entity-id';
import { ControlClient, ControlError } from './control-client.js';
import type { EntityGrant, EntityReservation } from './entity-ledger.js';

export const ENTITY_BATCH_BLOCKS = 8;
export const ENTITY_REFILL_AT = 2 * ENTITY_BLOCK_SIZE;
type Reserve = (request: EntityReservation) => Promise<EntityGrant>;

/** Synchronous allocations consume durable, disjoint ranges. Only prefetch is
 * asynchronous; simulation never waits for a database/network call per entity.
 * Running out stops this worker rather than wrapping into a foreign live ID. */
export class EntityPool implements EntityAllocator {
  private ranges: { cursor: number; last: number }[] = [];
  private highestBlock = -1;
  private available = 0;
  private epoch: number | undefined;
  private pending: Promise<void> | null = null;
  private request: EntityReservation | null = null;
  private retryAt = 0;
  private failure: Error | null = null;
  private closed = false;
  constructor(private readonly initial: EntityGrant, private readonly reserve: Reserve, private readonly now = () => performance.now(), expected: EntityReservation = initial) {
    this.append(initial, expected);
  }
  static async bootstrap(control: ControlClient, identity: Pick<EntityReservation, 'node' | 'planet' | 'region'>): Promise<EntityPool> {
    const request = { ...identity, request: randomUUID(), count: ENTITY_BATCH_BLOCKS };
    const reserve: Reserve = r => control.call<EntityGrant>('entities/reserve', r);
    const grant = await reserve(request);
    // Compare the returned identity against the actual request before use.
    return new EntityPool(grant, reserve, undefined, request);
  }
  bind(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 1 || this.epoch !== undefined && this.epoch !== epoch) {
      throw new Error('Entity pool authority changed');
    }
    this.epoch = epoch;
  }
  get remaining(): number { return this.available; }
  get status() { return { remaining: this.available, refilling: !!this.pending, failed: !!this.failure }; }
  allocate(active: { has(id: number): boolean; size: number }): number {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error('Entity pool is closed');
    const range = this.ranges[0];
    if (!range) throw new Error('Reserved entity IDs exhausted; awaiting coordinator');
    const id = range.cursor;
    if (active.has(id)) throw new Error('Reserved entity ID collides with a live entity');
    this.available--;
    if (id === range.last) this.ranges.shift(); else range.cursor++;
    return id;
  }
  pump(): void {
    if (this.failure) throw this.failure;
    if (this.closed || this.epoch === undefined || this.pending || this.available > ENTITY_REFILL_AT || this.now() < this.retryAt) return;
    const request = this.request ??= { node: this.initial.node, planet: this.initial.planet, region: this.initial.region,
      epoch: this.epoch, count: ENTITY_BATCH_BLOCKS, request: randomUUID() };
    this.pending = Promise.resolve().then(() => this.reserve(request)).then(grant => {
      if (this.closed) return; // Burn a late reservation rather than reuse it.
      this.append(grant, request); this.request = null;
    }).catch(error => {
      if (error instanceof ControlError && ['fenced', 'invalid', 'full'].includes(error.code) || error instanceof InvalidGrant) {
        this.failure = error;
      } else this.retryAt = this.now() + 250;
    }).finally(() => { this.pending = null; });
  }
  async close(): Promise<void> { this.closed = true; await this.pending; }
  private validate(grant: EntityGrant, request: EntityReservation): void {
    if (!grant || grant.request !== request.request || grant.node !== request.node || grant.planet !== request.planet ||
        grant.region !== request.region || grant.epoch !== request.epoch || grant.count !== request.count ||
        !Number.isSafeInteger(grant.count) || grant.count < 1 || grant.count > 32 ||
        !Number.isSafeInteger(grant.firstBlock) || grant.firstBlock < 0 || grant.firstBlock > MAX_ENTITY_BLOCK - grant.count + 1) {
      throw new InvalidGrant('Invalid entity block grant');
    }
  }
  private append(grant: EntityGrant, request: EntityReservation): void {
    this.validate(grant, request);
    if (grant.firstBlock <= this.highestBlock) throw new InvalidGrant('Entity blocks cannot be replayed or rewound');
    const first = entityBlockRange(grant.firstBlock).first, lastBlock = grant.firstBlock + grant.count - 1;
    const last = entityBlockRange(lastBlock).last;
    this.ranges.push({ cursor: first, last });
    this.highestBlock = lastBlock; this.available += grant.count * ENTITY_BLOCK_SIZE;
  }
}
class InvalidGrant extends Error {}
