// Sinais coletados durante a investigação e as portas das fontes (Prometheus, Jaeger).
import { z } from 'zod';
import type { MetricSignalSpec, TraceSignalSpec } from '../playbooks/schema.js';

export const MetricSeriesSchema = z.object({
  labels: z.record(z.string(), z.string()),
  points: z.array(z.object({ t: z.number(), v: z.number() })),
});
export type MetricSeries = z.infer<typeof MetricSeriesSchema>;

export const TraceSummarySchema = z.object({
  traceId: z.string(),
  rootOperation: z.string(),
  durationMs: z.number().nonnegative(),
  spanCount: z.number().int().nonnegative(),
  errorSpans: z.number().int().nonnegative(),
  slowestOperation: z.object({ name: z.string(), durationMs: z.number().nonnegative() }),
});
export type TraceSummary = z.infer<typeof TraceSummarySchema>;

export const SignalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('metric'), name: z.string(), query: z.string(), series: z.array(MetricSeriesSchema) }),
  z.object({ kind: z.literal('trace'), name: z.string(), service: z.string(), traces: z.array(TraceSummarySchema) }),
  z.object({
    kind: z.literal('error'),
    name: z.string(),
    source: z.enum(['prometheus', 'jaeger', 'template']),
    message: z.string(),
  }),
]);
export type Signal = z.infer<typeof SignalSchema>;

/** Consulta já com os placeholders substituídos pelos rótulos do alerta. */
export type RenderedMetricSpec = MetricSignalSpec;

export interface MetricsSource {
  query(spec: RenderedMetricSpec, at: Date): Promise<MetricSeries[]>;
}

export interface TraceSource {
  find(spec: TraceSignalSpec, at: Date): Promise<TraceSummary[]>;
}

export class SignalSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalSourceError';
  }
}
