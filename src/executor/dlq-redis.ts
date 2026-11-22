// Reprocesso de DLQ em listas Redis. Convenção: produtores usam RPUSH, então a mensagem mais
// antiga fica na cabeça; LMOVE é atômico, e uma falha no meio nunca perde mensagem.
import type { Redis } from 'ioredis';
import type { DlqPort } from './ports.js';

export class RedisDlqReplayer implements DlqPort {
  readonly #redis: Pick<Redis, 'lmove'>;

  constructor(redis: Pick<Redis, 'lmove'>) {
    this.#redis = redis;
  }

  async replay(queue: string, replayTo: string, max: number): Promise<number> {
    let moved = 0;
    while (moved < max) {
      const message = await this.#redis.lmove(queue, replayTo, 'LEFT', 'RIGHT');
      if (message === null) break;
      moved += 1;
    }
    return moved;
  }
}
