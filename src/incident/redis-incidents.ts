// Adaptador Redis do repositório de incidentes: JSON por incidente com TTL e um sorted set pelo
// horário de conclusão para listar os mais recentes.
import type { Redis } from 'ioredis';
import type { IncidentRepository } from './incidents.js';
import type { IncidentReport } from './investigator.js';

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class RedisIncidentRepository implements IncidentRepository {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'ops-copilot:incidents') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async save(report: IncidentReport): Promise<void> {
    const finishedAt = Date.parse(report.finishedAt);
    await this.#redis
      .multi()
      .set(this.#key(report.incidentId), JSON.stringify(report), 'PX', RETENTION_MS)
      .zadd(this.#index(), finishedAt, report.incidentId)
      .zremrangebyscore(this.#index(), '-inf', finishedAt - RETENTION_MS)
      .exec();
  }

  async get(incidentId: string): Promise<IncidentReport | null> {
    const raw = await this.#redis.get(this.#key(incidentId));
    return raw === null ? null : (JSON.parse(raw) as IncidentReport);
  }

  async list(limit: number): Promise<readonly IncidentReport[]> {
    const ids = await this.#redis.zrevrange(this.#index(), 0, limit - 1);
    if (ids.length === 0) return [];
    const values = await this.#redis.mget(ids.map((id) => this.#key(id)));
    return values.filter((raw): raw is string => raw !== null).map((raw) => JSON.parse(raw) as IncidentReport);
  }

  #key(id: string): string {
    return `${this.#prefix}:${id}`;
  }

  #index(): string {
    return `${this.#prefix}:by-time`;
  }
}
