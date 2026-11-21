// Adaptador da API HTTP de consulta do Jaeger (/api/traces), a mesma que a UI usa.
import { z } from 'zod';
import type { FetchLike } from '../shared/fetch.js';
import type { TraceSignalSpec } from '../playbooks/schema.js';
import { SignalSourceError, type TraceSource, type TraceSummary } from './types.js';

const SpanSchema = z.object({
  spanID: z.string(),
  operationName: z.string(),
  duration: z.number().nonnegative(), // microssegundos
  references: z.array(z.object({ refType: z.string(), spanID: z.string() })).default([]),
  tags: z.array(z.object({ key: z.string(), value: z.unknown() })).default([]),
});

const ResponseSchema = z.object({
  data: z.array(z.object({ traceID: z.string(), spans: z.array(SpanSchema).min(1) })).nullable(),
});

export interface JaegerOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

export class JaegerTraceSource implements TraceSource {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: JaegerOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async find(spec: TraceSignalSpec, at: Date): Promise<TraceSummary[]> {
    const params = new URLSearchParams({
      service: spec.service,
      lookback: spec.lookback,
      limit: String(spec.limit),
      end: String(at.getTime() * 1000),
    });
    if (spec.operation) params.set('operation', spec.operation);
    if (spec.minDurationMs) params.set('minDuration', `${String(spec.minDurationMs)}ms`);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/traces?${params.toString()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new SignalSourceError(`Jaeger indisponível ao consultar ${spec.name}.`);
    }
    if (!response.ok) throw new SignalSourceError(`Jaeger respondeu HTTP ${String(response.status)} em ${spec.name}.`);
    const parsed = ResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) throw new SignalSourceError(`Jaeger respondeu em formato inesperado em ${spec.name}.`);

    return (parsed.data.data ?? []).map((trace) => summarize(trace.traceID, trace.spans));
  }
}

type Span = z.infer<typeof SpanSchema>;

function summarize(traceId: string, spans: readonly Span[]): TraceSummary {
  const root = spans.find((span) => !span.references.some((ref) => ref.refType === 'CHILD_OF')) ?? spans[0];
  const slowest = spans.reduce((max, span) => (span.duration > max.duration ? span : max));
  const errorSpans = spans.filter((span) => span.tags.some((tag) => tag.key === 'error' && tag.value === true)).length;
  return {
    traceId,
    rootOperation: root?.operationName ?? 'desconhecida',
    durationMs: (root?.duration ?? 0) / 1000,
    spanCount: spans.length,
    errorSpans,
    slowestOperation: { name: slowest.operationName, durationMs: slowest.duration / 1000 },
  };
}
