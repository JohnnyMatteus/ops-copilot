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

  it('mede acerto com o modelo falso e detecta o erro plantado', async () => {
    const report = await fakeRun();
    expect(report.metrics).toMatchObject({
      cases: 11,
      hypothesisAccuracy: 0.9,
      actionAccuracy: 1,
      retryRate: 0.1,
      diagnosisFailures: 0,
    });
    expect(report.metrics.outcomeAccuracy).toBeCloseTo(10 / 11);
    const miss = report.results.find((r) => !r.hits.hypothesis);
    expect(miss?.id).toBe('telemetry-slow-sink');
    // Hipótese errada com confiança baixa: o gate pediu aprovação em vez de executar.
    expect(miss?.actual.outcome).toBe('awaiting_approval');
    expect(formatReport(report)).toContain('Acerto de hipótese: 90.0%');
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
