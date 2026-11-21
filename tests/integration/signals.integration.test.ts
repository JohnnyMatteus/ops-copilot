import { describe, expect, it } from 'vitest';
import { JaegerTraceSource } from '../../src/signals/jaeger.js';
import { PrometheusMetricsSource } from '../../src/signals/prometheus.js';
import { JAEGER_URL, PROMETHEUS_URL } from './env.js';

describe('fontes de sinais contra o compose local', () => {
  it('lê as métricas sintéticas do Prometheus com a consulta do playbook', async () => {
    const source = new PrometheusMetricsSource({ baseUrl: PROMETHEUS_URL });
    const series = await source.query(
      {
        name: 'dlq_depth',
        description: 'd',
        query: 'sum by (queue) (payments_dlq_messages{service="payments-events-go"})',
        kind: 'range',
        window: '5m',
        step: '30s',
      },
      new Date(),
    );
    expect(series[0]?.labels).toEqual({ queue: 'payments.events.dlq' });
    expect(series[0]?.points.length).toBeGreaterThan(0);
  });

  it('PromQL inválido vira erro explícito da fonte', async () => {
    const source = new PrometheusMetricsSource({ baseUrl: PROMETHEUS_URL });
    await expect(
      source.query({ name: 'x', description: 'd', query: 'sum(', kind: 'instant', window: '5m', step: '30s' }, new Date()),
    ).rejects.toThrow(/bad_data/);
  });

  it('lê e resume traces sintéticos do Jaeger', async () => {
    const source = new JaegerTraceSource({ baseUrl: JAEGER_URL });
    const traces = await source.find(
      { name: 'p', description: 'd', service: 'payments-events-go', operation: 'process_payment_event', lookback: '15m', limit: 5 },
      new Date(),
    );
    expect(traces.length).toBeGreaterThan(0);
    expect(traces[0]?.rootOperation).toBe('process_payment_event');
    expect(traces[0]?.spanCount).toBe(4);
  });
});
