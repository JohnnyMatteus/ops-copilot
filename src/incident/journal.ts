// Diário das investigações em andamento (ADR 0018). O checkpoint do LangGraph guarda o estado do
// grafo; o diário guarda o alerta e a hora de início, quem está executando cada investigação (lease
// com dono e heartbeat) e quantas retomadas já foram tentadas.
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AlertSchema } from '../domain/alert.js';

export const InFlightSchema = z.object({ incidentId: z.string(), alert: AlertSchema, startedAt: z.string() });
export type InFlight = z.infer<typeof InFlightSchema>;

export interface InvestigationJournal {
  begin(entry: InFlight): Promise<void>;
  finish(incidentId: string): Promise<void>;
  /** Todas as investigações sem relatório final, vivas ou não; quem decide é o lease. */
  pending(): Promise<readonly InFlight[]>;
  /** Toma o lease se ninguém o detém. O dono o renova enquanto roda; se morrer, ele expira. */
  acquire(incidentId: string, owner: string, ttlMs: number): Promise<boolean>;
  /** Renova só se `owner` ainda é o dono; `false` indica lease perdido. */
  renew(incidentId: string, owner: string, ttlMs: number): Promise<boolean>;
  release(incidentId: string, owner: string): Promise<void>;
  /** Conta uma tentativa de retomada e devolve o total. */
  bumpAttempts(incidentId: string): Promise<number>;
}

export class InMemoryInvestigationJournal implements InvestigationJournal {
  readonly #entries = new Map<string, InFlight>();
  readonly #leases = new Map<string, { owner: string; until: number }>();
  readonly #attempts = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async begin(entry: InFlight): Promise<void> {
    this.#entries.set(entry.incidentId, entry);
  }

  async finish(incidentId: string): Promise<void> {
    this.#entries.delete(incidentId);
    this.#leases.delete(incidentId);
    this.#attempts.delete(incidentId);
  }

  async pending(): Promise<readonly InFlight[]> {
    return [...this.#entries.values()];
  }

  async acquire(incidentId: string, owner: string, ttlMs: number): Promise<boolean> {
    const lease = this.#leases.get(incidentId);
    if (lease && lease.until > this.#now()) return false;
    this.#leases.set(incidentId, { owner, until: this.#now() + ttlMs });
    return true;
  }

  async renew(incidentId: string, owner: string, ttlMs: number): Promise<boolean> {
    const lease = this.#leases.get(incidentId);
    if (lease?.owner !== owner || lease.until <= this.#now()) return false;
    lease.until = this.#now() + ttlMs;
    return true;
  }

  async release(incidentId: string, owner: string): Promise<void> {
    if (this.#leases.get(incidentId)?.owner === owner) this.#leases.delete(incidentId);
  }

  async bumpAttempts(incidentId: string): Promise<number> {
    const next = (this.#attempts.get(incidentId) ?? 0) + 1;
    this.#attempts.set(incidentId, next);
    return next;
  }
}

const RETENTION_MS = 24 * 60 * 60 * 1000;
const RENEW = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";
const RELEASE = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

export class RedisInvestigationJournal implements InvestigationJournal {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'ops-copilot:inflight') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async begin(entry: InFlight): Promise<void> {
    await this.#redis.multi().hset(this.#prefix, entry.incidentId, JSON.stringify(entry)).pexpire(this.#prefix, RETENTION_MS).exec();
  }

  async finish(incidentId: string): Promise<void> {
    await this.#redis
      .multi()
      .hdel(this.#prefix, incidentId)
      .hdel(`${this.#prefix}:attempts`, incidentId)
      .del(this.#lease(incidentId))
      .exec();
  }

  async pending(): Promise<readonly InFlight[]> {
    const all = await this.#redis.hvals(this.#prefix);
    return all.flatMap((raw) => {
      const parsed = InFlightSchema.safeParse(JSON.parse(raw));
      return parsed.success ? [parsed.data] : [];
    });
  }

  async acquire(incidentId: string, owner: string, ttlMs: number): Promise<boolean> {
    return (await this.#redis.set(this.#lease(incidentId), owner, 'PX', ttlMs, 'NX')) === 'OK';
  }

  async renew(incidentId: string, owner: string, ttlMs: number): Promise<boolean> {
    return (await this.#redis.eval(RENEW, 1, this.#lease(incidentId), owner, String(ttlMs))) === 1;
  }

  async release(incidentId: string, owner: string): Promise<void> {
    await this.#redis.eval(RELEASE, 1, this.#lease(incidentId), owner);
  }

  async bumpAttempts(incidentId: string): Promise<number> {
    return this.#redis.hincrby(`${this.#prefix}:attempts`, incidentId, 1);
  }

  #lease(incidentId: string): string {
    return `${this.#prefix}:lease:${incidentId}`;
  }
}
