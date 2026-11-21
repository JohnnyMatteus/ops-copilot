// Conexão Redis compartilhada pelos adaptadores de orçamento, aprovações e incidentes.
import { Redis } from 'ioredis';
import type { Logger } from '../telemetry/logger.js';

export async function connectRedis(url: string, logger: Logger): Promise<Redis> {
  // Sem fila offline: com o Redis fora, a operação falha na hora e o chamador decide (o gate
  // falha fechado) em vez de esperar indefinidamente uma reconexão.
  const redis = new Redis(url, { enableOfflineQueue: false, maxRetriesPerRequest: 1, lazyConnect: true });
  redis.on('error', (error: Error) => logger.warn({ err: error.message }, 'redis indisponível'));
  // Na subida o Redis precisa responder: falha explícita em vez de começar sem estado.
  await redis.connect();
  return redis;
}
