// Sinais de exemplo, nomeados como nos playbooks do repositório.
import type { MetricSeries, TraceSummary } from '../../src/signals/types.js';

export const series = (labels: Record<string, string>, values: number[]): MetricSeries => ({
  labels,
  points: values.map((v, i) => ({ t: 1_700_000_000 + i * 60, v })),
});

export const trace = (traceId: string, durationMs: number, slowest: string, errorSpans = 0): TraceSummary => ({
  traceId,
  rootOperation: 'GET /api/v1/reports/export',
  durationMs,
  spanCount: 6,
  errorSpans,
  slowestOperation: { name: slowest, durationMs: durationMs * 0.8 },
});

export const saasNoisyTenantMetrics = {
  p99_by_route: [series({ route: '/api/v1/reports/export' }, [0.4, 1.9, 2.6])],
  requests_by_tenant: [series({ tenant: 'estudio-lotus' }, [180]), series({ tenant: 'estudio-sol' }, [12])],
  db_pool_in_use: [series({}, [0.5, 0.6, 0.7])],
  cpu_utilization: [series({}, [0.45, 0.5, 0.52])],
};

export const saasNoisyTenantTraces = {
  slow_requests: [trace('t1', 2400, 'reports.render_csv'), trace('t2', 2900, 'reports.render_csv')],
};

export const paymentsRecoveredMetrics = {
  dlq_depth: [series({ queue: 'payments.events.dlq' }, [200, 1400, 1450])],
  consumer_error_ratio: [series({}, [0.4, 0.05, 0.01])],
  downstream_up: [series({ dependency: 'ledger-api' }, [0, 1, 1])],
};

export const paymentsRecoveredTraces = {
  failing_event_processing: [trace('p1', 300, 'ledger.post_entry')],
};

export const telemetryPoisonMetrics = {
  consumer_lag: [series({ topic: 'greenhouse.readings.v1' }, [100, 4000, 9000])],
  ingress_vs_consumed: [series({}, [1, 1.02, 1.01])],
  consumer_replicas: [series({}, [6])],
  partition_lag: [series({ partition: '3' }, [8900]), series({ partition: '1' }, [20])],
};

export const telemetryPoisonTraces = {
  slow_enrichment: [trace('k1', 150, 'schema.decode', 4)],
};

export const diagnosis = (body: {
  hypothesisId: string;
  confidence: number;
  evidence: { signal: string; observation: string }[];
  proposedAction: { actionId: string; params?: Record<string, unknown>; rationale: string } | null;
}) => JSON.stringify({ summary: `Diagnóstico: ${body.hypothesisId} sustentado pelos sinais.`, ...body });
