import { describe, expect, it } from 'vitest';
import { CostCappedLlmClient, LlmCostCeilingError } from '../../src/llm/cost-cap.js';
import { FakeLlmClient } from '../../src/llm/fake.js';
import { Investigator } from '../../src/incident/investigator.js';
import { FixtureMetricsSource, FixtureTraceSource } from '../../src/signals/fixture.js';
import { testDeps } from '../helpers/fixtures.js';
import { alertFor } from '../helpers/repo.js';
import { saasNoisyTenantMetrics, saasNoisyTenantTraces } from '../helpers/signals.js';

const request = { model: 'm', temperature: 0, messages: [{ role: 'user' as const, content: 'oi' }] };

describe('teto de custo por incidente', () => {
  it('soma o custo e recusa a chamada que passaria do teto já atingido', async () => {
    const client = new CostCappedLlmClient(new FakeLlmClient([{ content: '1', costUsd: 0.06 }, { content: '2', costUsd: 0.06 }, { content: '3' }]), 0.1);
    await client.chat(request);
    await client.chat(request); // 0,06 < 0,10 ainda permite; a soma chega a 0,12
    await expect(client.chat(request)).rejects.toBeInstanceOf(LlmCostCeilingError);
  });

  it('custo desconhecido falha fechado na chamada seguinte', async () => {
    const client = new CostCappedLlmClient(new FakeLlmClient([{ content: '1', costUsd: null }, { content: '2' }]), 1);
    await client.chat(request);
    await expect(client.chat(request)).rejects.toThrow(/não informou o custo/);
  });

  it('no grafo, estourar o teto no meio do retry vira diagnosis_failed auditado e conserva o uso', async () => {
    const llm = new FakeLlmClient([{ content: '{"hypothesisId":"inventada"}', costUsd: 0.2 }, { content: 'nunca chamado' }]);
    const { deps, audit } = await testDeps({
      llm,
      metricsSource: new FixtureMetricsSource(saasNoisyTenantMetrics),
      traceSource: new FixtureTraceSource(saasNoisyTenantTraces),
      maxLlmCostUsdPerIncident: 0.1,
    });
    const report = await new Investigator(deps).investigate(alertFor('SaasP99LatencyHigh', 'saas-multitenant'));
    expect(report?.outcome).toBe('diagnosis_failed');
    expect(report?.failure).toMatch(/Teto de custo/);
    expect(report?.llmUsage).toMatchObject({ calls: 1, costUsd: 0.2 });
    expect(llm.requests).toHaveLength(1);
    expect((await audit.records()).at(-1)).toMatchObject({ event: 'diagnosis_failed', details: { reason: 'cost_ceiling' } });
  });
});
