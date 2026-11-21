// Adaptador Redis da fila de aprovações: um valor JSON por pedido e um sorted set indexado pelo
// prazo. GETDEL retira o pedido atomicamente, então duas pessoas aprovando ao mesmo tempo não
// executam a ação duas vezes, mesmo com várias réplicas do copiloto.
import type { Redis } from 'ioredis';
import type { GateInput } from '../autonomy/gate.js';
import { newApproval, type ApprovalLookup, type ApprovalQueue, type ApprovalQueueOptions, type PendingApproval } from './approvals.js';

/**
 * O valor vive além do prazo para que `take` ainda distinga "expirado" (410) de "não existe"
 * (404); a limpeza definitiva fica com o TTL do Redis.
 */
const EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000;

export class RedisApprovalQueue implements ApprovalQueue {
  readonly #redis: Redis;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #prefix: string;

  constructor(redis: Redis, options: ApprovalQueueOptions & { prefix?: string }) {
    this.#redis = redis;
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
    this.#prefix = options.prefix ?? 'ops-copilot:approvals';
  }

  async request(incidentId: string, gateInput: GateInput): Promise<PendingApproval> {
    const approval = newApproval(incidentId, gateInput, this.#ttlMs, this.#now());
    await this.#redis
      .multi()
      .set(this.#key(approval.id), JSON.stringify(approval), 'PX', this.#ttlMs + EXPIRED_GRACE_MS)
      .zadd(this.#index(), approval.expiresAt, approval.id)
      .exec();
    return approval;
  }

  async take(id: string): Promise<ApprovalLookup> {
    const raw = await this.#redis.getdel(this.#key(id));
    await this.#redis.zrem(this.#index(), id);
    if (raw === null) return { status: 'not_found' };
    const approval = JSON.parse(raw) as PendingApproval;
    if (this.#now() > approval.expiresAt) return { status: 'expired' };
    return { status: 'found', approval };
  }

  async list(): Promise<readonly PendingApproval[]> {
    const now = this.#now();
    // O índice só serve à listagem; `take` de um pedido vencido ainda acha o valor pela chave.
    await this.#redis.zremrangebyscore(this.#index(), '-inf', `(${String(now)}`);
    const ids = await this.#redis.zrangebyscore(this.#index(), now, '+inf');
    if (ids.length === 0) return [];
    const values = await this.#redis.mget(ids.map((id) => this.#key(id)));
    return values.filter((raw): raw is string => raw !== null).map((raw) => JSON.parse(raw) as PendingApproval);
  }

  #key(id: string): string {
    return `${this.#prefix}:${id}`;
  }

  #index(): string {
    return `${this.#prefix}:by-expiry`;
  }
}
