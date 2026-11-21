// Adaptador da HTTP API do Prometheus (/api/v1/query e /api/v1/query_range).
import { z } from 'zod';
import { durationToMs } from '../shared/duration.js';
import type { FetchLike } from '../shared/fetch.js';
import { SignalSourceError, type MetricSeries, type MetricsSource, type RenderedMetricSpec } from './types.js';

const SampleSchema = z.tuple([z.number(), z.string()]);

const ResponseSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('success'),
    data: z.discriminatedUnion('resultType', [
      z.object({
        resultType: z.literal('vector'),
        result: z.array(z.object({ metric: z.record(z.string(), z.string()), value: SampleSchema })),
      }),
      z.object({
        resultType: z.literal('matrix'),
        result: z.array(z.object({ metric: z.record(z.string(), z.string()), values: z.array(SampleSchema) })),
      }),
      z.object({ resultType: z.literal('scalar'), result: SampleSchema }),
    ]),
  }),
  z.object({ status: z.literal('error'), errorType: z.string(), error: z.string() }),
]);

export interface PrometheusOptions {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly fetch?: FetchLike;
}

export class PrometheusMetricsSource implements MetricsSource {
  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: FetchLike;

  constructor(options: PrometheusOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = options.timeoutMs ?? 5_000;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async query(spec: RenderedMetricSpec, at: Date): Promise<MetricSeries[]> {
    const end = at.getTime() / 1000;
    const params = new URLSearchParams({ query: spec.query });
    let path = '/api/v1/query';
    if (spec.kind === 'range') {
      path = '/api/v1/query_range';
      params.set('start', String(end - durationToMs(spec.window) / 1000));
      params.set('end', String(end));
      params.set('step', String(durationToMs(spec.step) / 1000));
    } else {
      params.set('time', String(end));
    }

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}?${params.toString()}`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch {
      throw new SignalSourceError(`Prometheus indisponível ao consultar ${spec.name}.`);
    }
    const parsed = ResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) {
      throw new SignalSourceError(`Prometheus respondeu HTTP ${String(response.status)} em formato inesperado.`);
    }
    if (parsed.data.status === 'error') {
      throw new SignalSourceError(`Prometheus rejeitou ${spec.name}: ${parsed.data.errorType}.`);
    }

    const { data } = parsed.data;
    switch (data.resultType) {
      case 'vector':
        return data.result.map((item) => ({ labels: item.metric, points: [toPoint(item.value)] }));
      case 'matrix':
        return data.result.map((item) => ({ labels: item.metric, points: item.values.map(toPoint) }));
      case 'scalar':
        return [{ labels: {}, points: [toPoint(data.result)] }];
    }
  }
}

function toPoint([t, v]: [number, string]): { t: number; v: number } {
  return { t, v: Number(v) };
}
