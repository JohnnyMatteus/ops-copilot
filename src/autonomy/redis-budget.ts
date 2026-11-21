// Adaptador Redis do orçamento: um sorted set por serviço, com o instante de cada execução como
// score. O script Lua limpa a janela, conta e registra numa única operação atômica no servidor,
// então réplicas do copiloto disputando o mesmo saldo não estouram o limite.
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { ActionBudget, Clock } from './budget.js';

const TRY_CONSUME = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1] - ARGV[2])
if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[3]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return 1`;

export class RedisActionBudget implements ActionBudget {
  readonly #redis: Redis;
  readonly #prefix: string;
  readonly #now: Clock;

  constructor(redis: Redis, options: { prefix?: string; now?: Clock } = {}) {
    this.#redis = redis;
    this.#prefix = options.prefix ?? 'ops-copilot:budget:';
    this.#now = options.now ?? Date.now;
  }

  async remaining(service: string, windowMs: number, max: number): Promise<number> {
    const used = await this.#redis.zcount(this.#key(service), `(${String(this.#now() - windowMs)}`, '+inf');
    return Math.max(0, max - used);
  }

  async tryConsume(service: string, windowMs: number, max: number): Promise<boolean> {
    const now = this.#now();
    const member = `${String(now)}:${randomUUID()}`;
    const result = await this.#redis.eval(TRY_CONSUME, 1, this.#key(service), now, windowMs, max, member);
    return result === 1;
  }

  #key(service: string): string {
    return `${this.#prefix}${service}`;
  }
}
