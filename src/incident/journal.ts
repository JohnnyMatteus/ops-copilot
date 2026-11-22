// Diário das investigações em andamento (ADR 0018). O checkpoint do LangGraph guarda o estado do
// grafo; o diário guarda o que falta para refazer o relatório (o alerta e a hora de início) e diz
// quais investigações ficaram sem relatório final depois de uma queda.
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AlertSchema } from '../domain/alert.js';

export const InFlightSchema = z.object({ incidentId: z.string(), alert: AlertSchema, startedAt: z.string() });
export type InFlight = z.infer<typeof InFlightSchema>;

export interface InvestigationJournal {
  begin(entry: InFlight): Promise<void>;
  finish(incidentId: string): Promise<void>;
  /** Investigações iniciadas antes de `olderThanMs` atrás e ainda sem relatório. */
  stale(olderThanMs: number, now: number): Promise<readonly InFlight[]>;
  /** Só um processo retoma cada investigação; a reserva expira sozinha. */
  claim(incidentId: string, ttlMs: number): Promise<boolean>;
}

export class InMemoryInvestigationJournal implements InvestigationJournal {
  readonly #entries = new Map<string, InFlight>();
  readonly #claims = new Map<string, number>();

  async begin(entry: InFlight): Promise<void> {
    this.#entries.set(entry.incidentId, entry);
  }

  async finish(incidentId: string): Promise<void> {
    this.#entries.delete(incidentId);
  }

  async stale(olderThanMs: number, now: number): Promise<readonly InFlight[]> {
    return [...this.#entries.values()].filter((entry) => now - Date.parse(entry.startedAt) >= olderThanMs);
  }

  async claim(incidentId: string, ttlMs: number): Promise<boolean> {
    const until = this.#claims.get(incidentId) ?? 0;
    if (until > Date.now()) return false;
    this.#claims.set(incidentId, Date.now() + ttlMs);
    return true;
  }
}

const RETENTION_MS = 24 * 60 * 60 * 1000;

export class RedisInvestigationJournal implements InvestigationJournal {
  readonly #redis: Redis;
  readonly #hash: string;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'ops-copilot:inflight') {
    this.#redis = redis;
    this.#hash = prefix;
    this.#prefix = prefix;
  }

  async begin(entry: InFlight): Promise<void> {
    await this.#redis.multi().hset(this.#hash, entry.incidentId, JSON.stringify(entry)).pexpire(this.#hash, RETENTION_MS).exec();
  }

  async finish(incidentId: string): Promise<void> {
    await this.#redis.hdel(this.#hash, incidentId);
  }

  async stale(olderThanMs: number, now: number): Promise<readonly InFlight[]> {
    const all = await this.#redis.hvals(this.#hash);
    return all
      .map((raw) => InFlightSchema.safeParse(JSON.parse(raw)))
      .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
      .filter((entry) => now - Date.parse(entry.startedAt) >= olderThanMs);
  }

  async claim(incidentId: string, ttlMs: number): Promise<boolean> {
    return (await this.#redis.set(`${this.#prefix}:claim:${incidentId}`, '1', 'PX', ttlMs, 'NX')) === 'OK';
  }
}
