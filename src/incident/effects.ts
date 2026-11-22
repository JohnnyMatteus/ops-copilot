// Última barreira contra efeito duplicado (ADR 0018): uma reserva atômica por incidente antes de
// executar uma ação ou abrir um pedido de aprovação. Nunca é devolvida: na dúvida, não repete.
import type { Redis } from 'ioredis';

export interface EffectGuard {
  /** `true` só para o primeiro que reserva o incidente. */
  reserve(incidentId: string): Promise<boolean>;
}

export class InMemoryEffectGuard implements EffectGuard {
  readonly #reserved = new Set<string>();

  async reserve(incidentId: string): Promise<boolean> {
    if (this.#reserved.has(incidentId)) return false;
    this.#reserved.add(incidentId);
    return true;
  }
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class RedisEffectGuard implements EffectGuard {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'ops-copilot:effect') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async reserve(incidentId: string): Promise<boolean> {
    return (await this.#redis.set(`${this.#prefix}:${incidentId}`, '1', 'PX', RETENTION_MS, 'NX')) === 'OK';
  }
}
