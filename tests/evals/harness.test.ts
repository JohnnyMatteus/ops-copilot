import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { formatReport, loadDataset, runEvals, summarize, type CaseResult } from '../../evals/harness.js';
import { FakeLlmClient } from '../../src/llm/fake.js';
import { realPlaybooks, realPolicy, ROOT } from '../helpers/repo.js';

async function fakeRun() {
  const responses = parse(await readFile(join(ROOT, 'evals/fake-model/responses.yaml'), 'utf8')) as Record<string, string[]>;
  return runEvals({
    cases: await loadDataset(join(ROOT, 'evals/dataset/incidents.yaml')),
    playbooks: await realPlaybooks(),
    policy: await realPolicy(),
    model: 'fake-model',
    llmFor: (id) => new FakeLlmClient(responses[id] ?? []),
  });
}

describe('harness de evals', () => {
  it('o dataset cobre os três serviços e um alerta sem playbook', async () => {
    const cases = await loadDataset(join(ROOT, 'evals/dataset/incidents.yaml'));
    const services = new Set(cases.map((c) => c.alert.service));
    expect(services).toEqual(new Set(['saas-multitenant', 'payments-events-go', 'kafka-telemetry']));
    expect(cases.some((c) => c.expected.outcome === 'no_playbook')).toBe(true);
  });

  it('o dataset ampliado cobre alertas preditivos e todos os desfechos do grafo', async () => {
    const cases = await loadDataset(join(ROOT, 'evals/dataset/incidents.yaml'));
    expect(cases.length).toBeGreaterThanOrEqual(25);
    expect(cases.filter((c) => c.alert.annotations['predicted'] === 'true')).toHaveLength(3);
    const outcomes = new Set(cases.map((c) => c.expected.outcome));
    for (const outcome of ['auto_executed', 'awaiting_approval', 'blocked', 'no_action', 'no_playbook', 'diagnosis_failed', 'insufficient_signals']) {
      expect(outcomes).toContain(outcome);
    }
  });

  it('mede acerto com o modelo falso e detecta o erro plantado', async () => {
    const report = await fakeRun();
    expect(report.metrics).toMatchObject({
      cases: 28,
      actionAccuracy: 1,
      diagnosisFailures: 2,
    });
    expect(report.metrics.hypothesisAccuracy).toBeCloseTo(20 / 22);
    expect(report.metrics.outcomeAccuracy).toBeCloseTo(27 / 28);
    expect(report.metrics.retryRate).toBeCloseTo(3 / 24);
    // Os dois erros plantados do modelo falso são detectados.
    const misses = report.results.filter((r) => !r.hits.hypothesis).map((r) => r.id);
    expect(misses).toEqual(['telemetry-slow-sink', 'telemetry-model-wrong-hypothesis']);
    // Hipótese errada com confiança baixa: o gate pediu aprovação em vez de executar.
    expect(report.results.find((r) => r.id === 'telemetry-slow-sink')?.actual.outcome).toBe('awaiting_approval');
    // Injeção no alerta e saída sem schema nunca chegam a uma ação.
    for (const id of ['payments-injection-in-alert', 'saas-garbled-model']) {
      expect(report.results.find((r) => r.id === id)?.actual).toMatchObject({ outcome: 'diagnosis_failed', actionId: null });
    }
    expect(formatReport(report)).toContain('Acerto de hipótese: 90.9%');
  });

  it('métricas sem casos diagnosticáveis não dividem por zero', () => {
    const result: CaseResult = {
      id: 'x',
      expected: { hypothesisId: null, actionId: null, outcome: 'no_playbook' },
      actual: { hypothesisId: null, actionId: null, outcome: 'no_playbook' },
      hits: { hypothesis: true, action: true, outcome: true },
      usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
      failure: null,
    };
    expect(summarize([result])).toMatchObject({ hypothesisAccuracy: 1, retryRate: 0, outcomeAccuracy: 1 });
  });
});
