import { describe, expect, it } from 'vitest';
import { JaegerTraceSource } from '../../src/signals/jaeger.js';
import { PrometheusMetricsSource } from '../../src/signals/prometheus.js';
import { SignalSourceError } from '../../src/signals/types.js';
import type { FetchLike } from '../../src/shared/fetch.js';

const at = new Date('2026-11-20T12:00:00Z');
const atSeconds = at.getTime() / 1000;

function recordingFetch(status: number, body: unknown) {
  const urls: string[] = [];
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    return new Response(JSON.stringify(body), { status });
  };
  return { fetch, urls };
}

const metricSpec = {
  name: 'dlq_depth',
  description: 'd',
  query: 'sum(payments_dlq_messages)',
  kind: 'instant' as const,
  window: '30m',
  step: '60s',
};

describe('PrometheusMetricsSource', () => {
  it('consulta instantânea usa /api/v1/query no instante da investigação', async () => {
    const { fetch, urls } = recordingFetch(200, {
      status: 'success',
      data: { resultType: 'vector', result: [{ metric: { queue: 'dlq' }, value: [atSeconds, '1500'] }] },
    });
    const series = await new PrometheusMetricsSource({ baseUrl: 'http://prom.example.com/', fetch }).query(metricSpec, at);
    expect(series).toEqual([{ labels: { queue: 'dlq' }, points: [{ t: atSeconds, v: 1500 }] }]);
    const url = new URL(urls[0] ?? '');
    expect(url.pathname).toBe('/api/v1/query');
    expect(url.searchParams.get('time')).toBe(String(atSeconds));
  });

  it('consulta de intervalo usa start/end/step derivados do playbook', async () => {
    const { fetch, urls } = recordingFetch(200, {
      status: 'success',
      data: { resultType: 'matrix', result: [{ metric: {}, values: [[atSeconds - 60, '1'], [atSeconds, '3']] }] },
    });
    const series = await new PrometheusMetricsSource({ baseUrl: 'http://prom.example.com', fetch }).query(
      { ...metricSpec, kind: 'range' },
      at,
    );
    expect(series[0]?.points.map((p) => p.v)).toEqual([1, 3]);
    const url = new URL(urls[0] ?? '');
    expect(url.pathname).toBe('/api/v1/query_range');
    expect(url.searchParams.get('start')).toBe(String(atSeconds - 1800));
    expect(url.searchParams.get('step')).toBe('60');
  });

  it('erro de PromQL vira SignalSourceError com o tipo do erro', async () => {
    const { fetch } = recordingFetch(400, { status: 'error', errorType: 'bad_data', error: 'parse error' });
    await expect(new PrometheusMetricsSource({ baseUrl: 'http://p', fetch }).query(metricSpec, at)).rejects.toThrow(
      /bad_data/,
    );
  });

  it('Prometheus fora do ar vira SignalSourceError', async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError('ECONNREFUSED');
    };
    await expect(new PrometheusMetricsSource({ baseUrl: 'http://p', fetch }).query(metricSpec, at)).rejects.toBeInstanceOf(
      SignalSourceError,
    );
  });
});

describe('JaegerTraceSource', () => {
  const traceSpec = {
    name: 'slow',
    description: 'd',
    service: 'saas-multitenant',
    operation: 'GET /api/v1/bookings',
    minDurationMs: 1000,
    lookback: '30m',
    limit: 20,
  };

  it('resume cada trace: raiz, duração, spans com erro e operação mais lenta', async () => {
    const { fetch, urls } = recordingFetch(200, {
      data: [
        {
          traceID: 't1',
          spans: [
            { spanID: 'a', operationName: 'GET /api/v1/bookings', duration: 1_800_000, references: [], tags: [] },
            {
              spanID: 'b',
              operationName: 'mysql.query',
              duration: 1_500_000,
              references: [{ refType: 'CHILD_OF', spanID: 'a' }],
              tags: [{ key: 'error', value: true }],
            },
          ],
        },
      ],
    });
    const traces = await new JaegerTraceSource({ baseUrl: 'http://jaeger.example.com', fetch }).find(traceSpec, at);
    expect(traces).toEqual([
      {
        traceId: 't1',
        rootOperation: 'GET /api/v1/bookings',
        durationMs: 1800,
        spanCount: 2,
        errorSpans: 1,
        slowestOperation: { name: 'GET /api/v1/bookings', durationMs: 1800 },
      },
    ]);
    const url = new URL(urls[0] ?? '');
    expect(url.pathname).toBe('/api/traces');
    expect(url.searchParams.get('minDuration')).toBe('1000ms');
    expect(url.searchParams.get('service')).toBe('saas-multitenant');
  });

  it('resposta sem traces devolve lista vazia', async () => {
    const { fetch } = recordingFetch(200, { data: null });
    expect(await new JaegerTraceSource({ baseUrl: 'http://j', fetch }).find(traceSpec, at)).toEqual([]);
  });

  it('HTTP de erro vira SignalSourceError', async () => {
    const { fetch } = recordingFetch(503, {});
    await expect(new JaegerTraceSource({ baseUrl: 'http://j', fetch }).find(traceSpec, at)).rejects.toThrow(/503/);
  });
});
