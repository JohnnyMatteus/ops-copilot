import { describe, expect, it } from 'vitest';
import { percentile, summarizeSignals } from '../../src/signals/summary.js';
import type { Signal } from '../../src/signals/types.js';

describe('summarizeSignals', () => {
  it('resume séries com estatísticas e limita a quantidade', () => {
    const series = Array.from({ length: 7 }, (_, i) => ({
      labels: { tenant: `estudio-${String(i)}` },
      points: [
        { t: 0, v: i },
        { t: 60, v: i * 10 },
      ],
    }));
    const text = summarizeSignals([{ kind: 'metric', name: 'requests_by_tenant', query: 'q', series }]);
    expect(text).toContain('{tenant=estudio-6} último=60 mín=6 máx=60 variação=54');
    expect(text).toContain('(+2 séries omitidas)');
    expect(text).not.toContain('estudio-0');
  });

  it('marca sinais indisponíveis para o modelo saber o que falta', () => {
    const signals: Signal[] = [{ kind: 'error', name: 'downstream_up', source: 'prometheus', message: 'timeout' }];
    expect(summarizeSignals(signals)).toBe('- downstream_up: INDISPONÍVEL (prometheus: timeout)');
  });

  it('resume traces com percentis, erros e operações mais lentas', () => {
    const trace = (id: string, durationMs: number, slow: string) => ({
      traceId: id,
      rootOperation: 'GET /x',
      durationMs,
      spanCount: 3,
      errorSpans: 1,
      slowestOperation: { name: slow, durationMs: durationMs - 10 },
    });
    const text = summarizeSignals([
      { kind: 'trace', name: 'slow_requests', service: 's', traces: [trace('a', 1200, 'mysql.query'), trace('b', 3000, 'mysql.query')] },
    ]);
    expect(text).toBe(
      '- slow_requests: 2 traces, p50=1200ms p95=3000ms, spans com erro=2, operações mais lentas: mysql.query (2990ms)',
    );
  });

  it('percentil nearest-rank', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
    expect(Number.isNaN(percentile([], 0.5))).toBe(true);
  });
});
