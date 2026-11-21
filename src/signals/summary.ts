// Resume sinais em texto curto para o prompt. Séries e traces brutos estourariam o contexto
// e o custo; o LLM recebe estatísticas com tamanho limitado, independentemente do volume.
import type { MetricSeries, Signal, TraceSummary } from './types.js';

const MAX_SERIES = 5;
const MAX_SLOW_OPERATIONS = 3;

export function summarizeSignals(signals: readonly Signal[]): string {
  return signals.map(summarizeSignal).join('\n');
}

function summarizeSignal(signal: Signal): string {
  switch (signal.kind) {
    case 'metric':
      return summarizeMetric(signal.name, signal.series);
    case 'trace':
      return summarizeTraces(signal.name, signal.traces);
    case 'error':
      return `- ${signal.name}: INDISPONÍVEL (${signal.source}: ${signal.message})`;
  }
}

function summarizeMetric(name: string, series: readonly MetricSeries[]): string {
  if (series.length === 0) return `- ${name}: sem dados`;
  const ranked = [...series]
    .map((item) => ({ item, last: item.points.at(-1)?.v ?? Number.NaN }))
    .sort((a, b) => b.last - a.last)
    .slice(0, MAX_SERIES);
  const lines = ranked.map(({ item }) => {
    const values = item.points.map((point) => point.v);
    const labels = Object.entries(item.labels)
      .filter(([key]) => key !== '__name__')
      .map(([key, value]) => `${key}=${value}`)
      .join(',');
    const first = values[0] ?? Number.NaN;
    const last = values.at(-1) ?? Number.NaN;
    const stats =
      values.length === 1
        ? `valor=${fmt(last)}`
        : `último=${fmt(last)} mín=${fmt(Math.min(...values))} máx=${fmt(Math.max(...values))} variação=${fmt(last - first)}`;
    return `  {${labels}} ${stats}`;
  });
  const hidden = series.length - ranked.length;
  return [`- ${name}:`, ...lines, ...(hidden > 0 ? [`  (+${String(hidden)} séries omitidas)`] : [])].join('\n');
}

function summarizeTraces(name: string, traces: readonly TraceSummary[]): string {
  if (traces.length === 0) return `- ${name}: nenhum trace no período`;
  const durations = traces.map((trace) => trace.durationMs).sort((a, b) => a - b);
  const errors = traces.reduce((total, trace) => total + trace.errorSpans, 0);
  const slowOps = new Map<string, number>();
  for (const trace of traces) {
    const { name: op, durationMs } = trace.slowestOperation;
    slowOps.set(op, Math.max(slowOps.get(op) ?? 0, durationMs));
  }
  const topOps = [...slowOps.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_SLOW_OPERATIONS)
    .map(([op, ms]) => `${op} (${fmt(ms)}ms)`)
    .join(', ');
  return (
    `- ${name}: ${String(traces.length)} traces, p50=${fmt(percentile(durations, 0.5))}ms ` +
    `p95=${fmt(percentile(durations, 0.95))}ms, spans com erro=${String(errors)}, operações mais lentas: ${topOps}`
  );
}

/** Percentil por posição (nearest-rank) sobre valores já ordenados. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}
