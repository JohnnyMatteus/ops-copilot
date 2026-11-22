import { describe, expect, it } from 'vitest';
import type { ApprovedAction } from '../../src/autonomy/gate.js';
import type { ActionExecutor, ExecutionResult } from '../../src/executor/executor.js';
import type { IncidentReport } from '../../src/incident/investigator.js';
import { RollbackService } from '../../src/incident/rollback-service.js';
import { FakeLlmClient } from '../../src/llm/fake.js';
import { FixtureMetricsSource, FixtureTraceSource } from '../../src/signals/fixture.js';
import { LIDER, testDeps } from '../helpers/fixtures.js';
import { realPolicy } from '../helpers/repo.js';

const UNDO = { actionId: 'restore_deployment_replicas', params: { deployment: 'saas-api', replicas: 4, expectedCurrent: 6 } };
const executed: ExecutionResult = { status: 'executed', actionId: 'scale_deployment', detail: '4 → 6', undo: UNDO };

const report = (overrides: Partial<IncidentReport> = {}): IncidentReport => ({
  incidentId: 'a1b2c3d4-0000-4000-8000-000000000001',
  service: 'saas-multitenant',
  alertname: 'SaasP99LatencyHigh',
  outcome: 'auto_executed',
  playbookId: 'saas-p99-latency',
  diagnosis: null,
  decision: null,
  execution: executed,
  approvalId: null,
  approvalExpiresAt: null,
  failure: null,
  llmUsage: { calls: 1, inputTokens: 1, outputTokens: 1, costUsd: 0 },
  steps: [],
  timeline: [],
  signals: [],
  severity: 'critical',
  alertStartedAt: '2026-11-20T11:50:00Z',
  alertSummary: null,
  resolution: null,
  startedAt: '2026-11-20T12:00:00Z',
  finishedAt: '2026-11-20T12:00:01Z',
  ...overrides,
});

async function setup(options: { policy?: Awaited<ReturnType<typeof realPolicy>>; outcome?: ExecutionResult['status'] } = {}) {
  const base = await testDeps({
    llm: new FakeLlmClient([]),
    metricsSource: new FixtureMetricsSource({}),
    traceSource: new FixtureTraceSource({}),
    ...(options.policy ? { policy: options.policy } : {}),
  });
  const seen: ApprovedAction[] = [];
  const executor: ActionExecutor = {
    mode: 'live',
    execute: async (action) => {
      seen.push(action);
      return { status: options.outcome ?? 'executed', actionId: action.id, detail: 'ok' };
    },
  };
  const service = new RollbackService({ ...base, executor, now: () => new Date('2026-11-20T13:00:00Z') });
  return { ...base, service, seen };
}

describe('rollback', () => {
  it('reverte pela inversa guardada, audita com o aprovador e só permite uma vez', async () => {
    const { service, incidents, audit, seen } = await setup();
    const original = report();
    await incidents.save(original);

    const outcome = await service.rollback(original.incidentId, LIDER, 'latência voltou ao normal');
    expect(outcome.status).toBe('rolled_back');
    expect(seen).toEqual([{ id: 'restore_deployment_replicas', params: UNDO.params, reversible: true }]);
    const records = await audit.records();
    expect(records.at(-1)).toMatchObject({ event: 'rollback_executed', actor: 'human:lider@example.com' });
    expect((await incidents.get(original.incidentId))?.rollback).toMatchObject({ by: 'lider@example.com', reason: 'latência voltou ao normal' });

    expect((await service.rollback(original.incidentId, LIDER, 'de novo')).status).toBe('already_rolled_back');
    expect(seen).toHaveLength(1);
  });

  it('kill switch bloqueia o rollback no gate, audita e libera a reserva', async () => {
    const policy = { ...(await realPolicy()), killSwitch: true };
    const { service, incidents, audit, seen } = await setup({ policy });
    await incidents.save(report());
    const outcome = await service.rollback(report().incidentId, LIDER, 'tentativa');
    expect(outcome.status).toBe('blocked');
    expect(seen).toEqual([]);
    expect((await audit.records()).at(-1)).toMatchObject({ event: 'rollback_blocked', actor: 'copilot' });
    expect(await incidents.claimRollback(report().incidentId)).toBe(true);
  });

  it('allowlist do serviço vale para o rollback: sem a ação original permitida, bloqueia', async () => {
    const base = await realPolicy();
    const policy = {
      ...base,
      services: { ...base.services, 'saas-multitenant': { level: 'auto_execute' as const, allowedActions: ['notify_oncall' as const] } },
    };
    const { service, incidents, seen } = await setup({ policy });
    await incidents.save(report());
    expect((await service.rollback(report().incidentId, LIDER, 'tentativa')).status).toBe('blocked');
    expect(seen).toEqual([]);
  });

  it('undo adulterado (inversa de outra ação ou parâmetro fora do limite) é bloqueado', async () => {
    const { service, incidents, seen } = await setup();
    const forged = [
      { ...executed, undo: { actionId: 'restore_feature_flag', params: { flag: 'x', enabled: true } } },
      { ...executed, undo: { ...UNDO, params: { ...UNDO.params, replicas: 99 } } },
    ];
    for (const [index, execution] of forged.entries()) {
      const incidentId = `a1b2c3d4-0000-4000-8000-00000000010${String(index)}`;
      await incidents.save(report({ incidentId, execution }));
      expect((await service.rollback(incidentId, LIDER, 'tentativa')).status).toBe('blocked');
    }
    expect(seen).toEqual([]);
  });

  it('sem ação executada com undo não há o que reverter', async () => {
    const { service, incidents } = await setup();
    await incidents.save(report({ execution: { status: 'dry_run', actionId: 'scale_deployment', detail: 'x' } }));
    expect((await service.rollback(report().incidentId, LIDER, 'tentativa')).status).toBe('not_reversible');
    expect((await service.rollback('a1b2c3d4-0000-4000-8000-0000000000ff', LIDER, 'tentativa')).status).toBe('not_found');
  });

  it('falha do executor é auditada e libera nova tentativa', async () => {
    const { service, incidents, audit } = await setup({ outcome: 'failed' });
    await incidents.save(report());
    expect((await service.rollback(report().incidentId, LIDER, 'tentativa')).status).toBe('failed');
    expect((await audit.records()).at(-1)?.event).toBe('rollback_failed');
    expect(await incidents.claimRollback(report().incidentId)).toBe(true);
  });
});
