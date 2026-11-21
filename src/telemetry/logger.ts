// Logs estruturados em JSON (pino). O trace_id do span ativo entra em cada linha para correlação.
import { trace } from '@opentelemetry/api';
import { pino, type Logger } from 'pino';

export type { Logger };

export function createLogger(level: string = 'info'): Logger {
  return pino({
    level,
    base: { service: 'ops-copilot' },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Nunca registra cabeçalhos de autenticação nem chaves de API.
    redact: { paths: ['*.authorization', '*.apiKey', '*.token'], censor: '[redacted]' },
    mixin() {
      const spanContext = trace.getActiveSpan()?.spanContext();
      return spanContext ? { trace_id: spanContext.traceId, span_id: spanContext.spanId } : {};
    },
  });
}

/** Logger silencioso para testes e evals. */
export function silentLogger(): Logger {
  return pino({ level: 'silent' });
}
