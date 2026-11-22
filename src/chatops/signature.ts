// Verificação das requisições do Slack (esquema v0 de assinatura) e anti-replay (ADR 0019).
// A assinatura prova que o corpo veio do Slack; o carimbo de tempo e o registro de assinaturas já
// vistas impedem que uma requisição capturada seja reenviada.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Redis } from 'ioredis';

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type SignatureResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'missing' | 'stale' | 'mismatch' };

export function verifySlackSignature(input: {
  readonly secret: string;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
  readonly rawBody: string;
  readonly nowSeconds: number;
}): SignatureResult {
  const { secret, timestamp, signature, rawBody, nowSeconds } = input;
  if (!timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: 'missing' };
  if (Math.abs(nowSeconds - Number(timestamp)) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: 'stale' };
  const expected = Buffer.from(`v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`);
  const provided = Buffer.from(signature);
  // Comparação em tempo constante; tamanhos diferentes já reprovam.
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return { ok: false, reason: 'mismatch' };
  return { ok: true };
}

/** Registra assinaturas já aceitas: a segunda ocorrência da mesma assinatura é replay. */
export interface ReplayGuard {
  /** `true` na primeira vez que vê a chave; `false` se já tinha visto dentro do prazo. */
  firstSeen(key: string, ttlMs: number): Promise<boolean>;
}

export class InMemoryReplayGuard implements ReplayGuard {
  readonly #seen = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async firstSeen(key: string, ttlMs: number): Promise<boolean> {
    const now = this.#now();
    for (const [stored, until] of this.#seen) if (until <= now) this.#seen.delete(stored);
    if (this.#seen.has(key)) return false;
    this.#seen.set(key, now + ttlMs);
    return true;
  }
}

export class RedisReplayGuard implements ReplayGuard {
  readonly #redis: Redis;
  readonly #prefix: string;

  constructor(redis: Redis, prefix = 'ops-copilot:chatops:seen') {
    this.#redis = redis;
    this.#prefix = prefix;
  }

  async firstSeen(key: string, ttlMs: number): Promise<boolean> {
    return (await this.#redis.set(`${this.#prefix}:${key}`, '1', 'PX', ttlMs, 'NX')) === 'OK';
  }
}
