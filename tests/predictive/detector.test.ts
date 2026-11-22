import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import type { Alert } from '../../src/domain/alert.js';
import { Investigator } from '../../src/incident/investigator.js';
import { FakeLlmClient } from '../../src/llm/fake.js';
import { PredictiveDetector, type PredictionResult } from '../../src/predictive/detector.js';
import { loadPredictiveRules, PredictiveRulesError, PredictiveRuleSchema, type PredictiveRule } from '../../src/predictive/rules.js';
import { FixtureMetricsSource, FixtureTraceSource } from '../../src/signals/fixture.js';
import type { MetricSeries, MetricsSource } from '../../src/signals/types.js';
import { testDeps } from '../helpers/fixtures.js';
import { realPlaybooks, ROOT } from '../helpers/repo.js';
import { diagnosis, saasNoisyTenantMetrics, saasNoisyTenantTraces, series } from '../helpers/signals.js';

const rule: PredictiveRule = PredictiveRuleSchema.parse({
  name: 'telemetry-consumer-lag-trend',
  alertname: 'TelemetryConsumerLagHigh',
  service: 'kafka-telemetry',
  summary: 'o lag tende a passar de 10000.',
  predict: 'sum by (service, consumergroup) (predict_linear(kafka_consumergroup_lag[15m], 1800))',
  current: 'sum by (service, consumergroup) (kafka_consumergroup_lag)',
  threshold: 10000,
  horizon: '30m',
  cooldown: '1h',
});
const labels = { service: 'kafka-telemetry', consumergroup: 'greenhouse-readings-enricher' };

/** Fonte controlável: o teste muda o previsto e o atual entre ciclos. */
function controllable(initial: { predicted: number; current: number }) {
  const state = { ...initial, failPredict: false };
  const source: MetricsSource = {
    query: async (spec): Promise<MetricSeries[]> => {
      if (spec.name === rule.name) {
        if (state.failPredict) throw new Error('prometheus fora');
        return [series(labels, [state.predicted])];
      }
      return [series(labels, [state.current])];
    },
  };
  return { state, source };
}

function harness(initial = { predicted: 14_000, current: 6_000 }, rules = [rule]) {
  const control = controllable(initial);
  let nowMs = Date.parse('2026-11-22T12:00:00Z');
  const alerts: Alert[] = [];
  const results: PredictionResult[] = [];
  const errors: unknown[] = [];
  const detector = new PredictiveDetector({
    rules,
    source: control.source,
    investigate: async (alert) => void alerts.push(alert),
    now: () => new Date(nowMs),
    onResult: (_rule, result) => results.push(result),
    onError: (_rule, error) => errors.push(error),
  });
  return { ...control, detector, alerts, results, errors, advance: (ms: number) => (nowMs += ms) };
}

describe('detector preditivo', () => {
  it('abre uma investigação do playbook quando o previsto passa do limite e o atual ainda não', async () => {
    const { detector, alerts } = harness();
    const [alert] = await detector.tick();
    expect(alerts).toHaveLength(1);
    expect(alert).toMatchObject({
      alertname: 'TelemetryConsumerLagHigh',
      service: 'kafka-telemetry',
      severity: 'warning',
      labels: { consumergroup: 'greenhouse-readings-enricher', origin: 'predictive' },
      annotations: { predicted: 'true', predicted_value: '14000.00', horizon: '30m' },
    });
    expect(alert?.annotations['summary']).toMatch(/Previsão/);
  });

  it('não abre quando o previsto não passa do limite nem quando o atual já passou (o alerta real cuida)', async () => {
    const calm = harness({ predicted: 8000, current: 3000 });
    expect(await calm.detector.tick()).toEqual([]);
    const already = harness({ predicted: 15_000, current: 10_500 });
    expect(await already.detector.tick()).toEqual([]);
    expect(already.results).toEqual(['already_breaching']);
  });

  it('não reabre enquanto a previsão persiste, nem dentro do cooldown, e reabre depois dele', async () => {
    const { detector, alerts, state, advance, results } = harness();
    await detector.tick();
    advance(60_000);
    await detector.tick();
    expect(alerts).toHaveLength(1);

    state.predicted = 5000; // a tendência se desfez
    advance(60_000);
    await detector.tick();
    state.predicted = 14_000; // e voltou, ainda dentro de 1 h
    advance(60_000);
    await detector.tick();
    expect(alerts).toHaveLength(1);
    expect(results).toContain('cooldown');

    state.predicted = 5000;
    advance(2 * 3_600_000);
    await detector.tick();
    state.predicted = 14_000;
    advance(60_000);
    await detector.tick();
    expect(alerts).toHaveLength(2);
  });

  it('falha de consulta é registrada e não derruba o ciclo das outras regras', async () => {
    const other = PredictiveRuleSchema.parse({ ...rule, name: 'outra-regra', cooldown: '1h' });
    const { detector, state, errors, results } = harness(undefined, [rule, other]);
    state.failPredict = true;
    await detector.tick();
    expect(errors).toHaveLength(1); // só a regra cuja consulta usa o nome que falha
    expect(results).toContain('error');
  });

  it('o alerta preditivo percorre o mesmo caminho do real: playbook, gate e auditoria com predicted=true', async () => {
    const control = {
      'saas-p99-trend': [series({ service: 'saas-multitenant' }, [1.4])],
      'saas-p99-trend-atual': [series({ service: 'saas-multitenant' }, [0.7])],
    };
    const llm = new FakeLlmClient([
      diagnosis({
        hypothesisId: 'noisy_tenant',
        confidence: 0.9,
        evidence: [{ signal: 'requests_by_tenant', observation: 'estudio-lotus concentra 94% das requisições' }],
        proposedAction: { actionId: 'toggle_feature_flag', rationale: 'proteger os demais tenants' },
      }),
    ]);
    const { deps, audit } = await testDeps({
      llm,
      metricsSource: new FixtureMetricsSource({ ...saasNoisyTenantMetrics, ...control }),
      traceSource: new FixtureTraceSource(saasNoisyTenantTraces),
    });
    const investigator = new Investigator(deps);
    const saasRule = PredictiveRuleSchema.parse({
      ...rule,
      name: 'saas-p99-trend',
      alertname: 'SaasP99LatencyHigh',
      service: 'saas-multitenant',
      threshold: 1,
      predict: 'max by (service) (predict_linear(p99[15m], 1800))',
      current: 'max by (service) (p99)',
    });
    const detector = new PredictiveDetector({
      rules: [saasRule],
      source: new FixtureMetricsSource({ ...saasNoisyTenantMetrics, ...control }),
      investigate: (alert) => investigator.investigate(alert),
      now: () => new Date('2026-11-22T12:00:00Z'),
    });
    await detector.tick();
    const received = (await audit.records()).find((record) => record.event === 'alert_received');
    expect(received?.details).toMatchObject({ alertname: 'SaasP99LatencyHigh', predicted: true });
    expect(llm.requests[0]?.messages[1]?.content).toContain('predicted: true');
    const [incident] = await deps.incidents.list(1);
    expect(incident).toMatchObject({ outcome: 'auto_executed', playbookId: 'saas-p99-latency' });
  });
});

describe('regras preditivas', () => {
  it('o arquivo versionado é válido e todas as regras apontam para um playbook', async () => {
    const rules = await loadPredictiveRules(join(ROOT, 'config', 'predictive-rules.yaml'), await realPlaybooks());
    expect(rules.map((item) => item.name)).toEqual(['telemetry-consumer-lag-trend', 'payments-dlq-trend', 'saas-p99-trend']);
    expect(rules.every((item) => item.predict.includes('predict_linear('))).toBe(true);
  });

  it('recusa consulta sem predict_linear, playbook inexistente e regra duplicada', async () => {
    expect(PredictiveRuleSchema.safeParse({ ...rule, predict: 'sum(kafka_consumergroup_lag)' }).success).toBe(false);
    const dir = await mkdtemp(join(tmpdir(), 'predictive-'));
    const write = async (rules: unknown[]) => {
      const path = join(dir, `r${String(Math.random())}.yaml`);
      await writeFile(path, JSON.stringify({ apiVersion: 'ops-copilot/v1', kind: 'PredictiveRules', rules }));
      return path;
    };
    const playbooks = await realPlaybooks();
    await expect(loadPredictiveRules(await write([{ ...rule, alertname: 'NaoExiste' }]), playbooks)).rejects.toThrow(PredictiveRulesError);
    await expect(loadPredictiveRules(await write([rule, rule]), playbooks)).rejects.toThrow(/duplicada/);
  });
});
