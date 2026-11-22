import { MemorySaver } from '@langchain/langgraph';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { AuditLog } from '../../src/autonomy/audit.js';
import type { ActionExecutor } from '../../src/executor/executor.js';
import { RedisCheckpointSaver } from '../../src/graph/redis-checkpointer.js';
import { InMemoryInvestigationJournal } from '../../src/incident/journal.js';
import { Investigator } from '../../src/incident/investigator.js';
import { FakeLlmClient } from '../../src/llm/fake.js';
import { FixtureMetricsSource, FixtureTraceSource } from '../../src/signals/fixture.js';
import type { MetricsSource } from '../../src/signals/types.js';
import { FIXED_NOW, testDeps } from '../helpers/fixtures.js';
import { alertFor } from '../helpers/repo.js';
import { diagnosis, paymentsRecoveredMetrics, paymentsRecoveredTraces, saasNoisyTenantMetrics, saasNoisyTenantTraces } from '../helpers/signals.js';

const saasAlert = alertFor('SaasP99LatencyHigh', 'saas-multitenant');
const paymentsAlert = alertFor('PaymentsDlqBacklogHigh', 'payments-events-go');
const noisyTenant = diagnosis({
  hypothesisId: 'noisy_tenant',
  confidence: 0.9,
  evidence: [{ signal: 'requests_by_tenant', observation: 'estudio-lotus concentra 94% das requisições' }],
  proposedAction: { actionId: 'toggle_feature_flag', rationale: 'proteger os demais tenants' },
});
const recovered = diagnosis({
  hypothesisId: 'downstream_recovered',
  confidence: 0.9,
  evidence: [{ signal: 'dlq_depth', observation: 'DLQ com 1450 mensagens' }],
  proposedAction: { actionId: 'replay_dlq_batch', params: { maxMessages: 100 }, rationale: 'a causa já passou' },
});

/** Auditoria que lança uma vez no evento dado: simula a queda do processo logo depois do efeito. */
const crashingAudit = (inner: AuditLog, event: string): AuditLog => {
  let crashed = false;
  return {
    records: () => inner.records(),
    append: (entry) => {
      if (entry.event === event && !crashed) {
        crashed = true;
        return Promise.reject(new Error('processo caiu'));
      }
      return inner.append(entry);
    },
  };
};

const counting = (source: MetricsSource) => {
  const counter = { calls: 0 };
  return { counter, source: { query: (...args: Parameters<MetricsSource['query']>) => (counter.calls++, source.query(...args)) } };
};

describe('retomada com checkpoints', () => {
  it('retoma do diagnóstico sem repetir a coleta e conclui o relatório', async () => {
    const checkpointer = new MemorySaver();
    const journal = new InMemoryInvestigationJournal();
    const metrics = counting(new FixtureMetricsSource(saasNoisyTenantMetrics));
    const traces = new FixtureTraceSource(saasNoisyTenantTraces);

    // Primeira vida: o LLM cai no diagnóstico (sem resposta roteirizada), depois da coleta.
    const first = await testDeps({ llm: new FakeLlmClient([]), metricsSource: metrics.source, traceSource: traces });
    const deps1 = { ...first.deps, checkpointer, journal };
    await expect(new Investigator(deps1).investigate(saasAlert)).rejects.toThrow(/sem resposta/);
    expect(await first.incidents.list(10)).toEqual([]);
    const collected = metrics.counter.calls;

    // Segunda vida: mesmo estado compartilhado (Redis, na produção), LLM disponível.
    const second = await testDeps({ llm: new FakeLlmClient([noisyTenant]), metricsSource: metrics.source, traceSource: traces });
    const investigator = new Investigator({ ...second.deps, checkpointer, journal, now: () => new Date(FIXED_NOW.getTime() + 600_000) });
    const [report] = await investigator.resumeInterrupted(60_000);

    expect(report?.outcome).toBe('auto_executed');
    expect(metrics.counter.calls).toBe(collected);
    expect(report?.steps).toEqual(['triage', 'collect', 'diagnose', 'decide', 'act']);
    expect((await second.audit.records()).map((record) => record.event)).toContain('investigation_resumed');
    expect(await journal.stale(0, Date.now() + 1e9)).toEqual([]);
    expect(await investigator.resumeInterrupted(60_000)).toEqual([]);
  });

  it('não retoma investigação recente nem a que outro processo já reservou', async () => {
    const checkpointer = new MemorySaver();
    const journal = new InMemoryInvestigationJournal();
    const setup = await testDeps({
      llm: new FakeLlmClient([]),
      metricsSource: new FixtureMetricsSource(saasNoisyTenantMetrics),
      traceSource: new FixtureTraceSource(saasNoisyTenantTraces),
    });
    const base = { ...setup.deps, checkpointer, journal };
    await expect(new Investigator(base).investigate(saasAlert)).rejects.toThrow();
    // Ainda dentro da janela: pode estar viva em outro processo.
    expect(await new Investigator(base).resumeInterrupted(60_000)).toEqual([]);
    const later = { ...base, now: () => new Date(FIXED_NOW.getTime() + 600_000) };
    const [pending] = await journal.stale(60_000, later.now().getTime());
    expect(await journal.claim(pending?.incidentId ?? '', 60_000)).toBe(true);
    expect(await new Investigator(later).resumeInterrupted(60_000)).toEqual([]);
  });

  it('queda na etapa act de ação automática não repete o efeito: vira interrupted', async () => {
    const checkpointer = new MemorySaver();
    const journal = new InMemoryInvestigationJournal();
    let executions = 0;
    const executor: ActionExecutor = {
      mode: 'live',
      execute: async (action) => ({ status: 'executed', actionId: action.id, detail: `execução ${String(++executions)}` }),
    };
    const first = await testDeps({
      llm: new FakeLlmClient([noisyTenant]),
      metricsSource: new FixtureMetricsSource(saasNoisyTenantMetrics),
      traceSource: new FixtureTraceSource(saasNoisyTenantTraces),
      executor,
    });
    const audit = crashingAudit(first.audit, 'action_executed');
    await expect(new Investigator({ ...first.deps, audit, checkpointer, journal }).investigate(saasAlert)).rejects.toThrow(/caiu/);
    expect(executions).toBe(1);

    const later = { ...first.deps, audit, checkpointer, journal, now: () => new Date(FIXED_NOW.getTime() + 600_000) };
    const [report] = await new Investigator(later).resumeInterrupted(60_000);
    expect(report?.outcome).toBe('interrupted');
    expect(report?.failure).toMatch(/não foi repetida/);
    expect(executions).toBe(1);
    expect((await first.audit.records()).map((record) => record.event)).toContain('investigation_interrupted');
  });

  it('queda depois de abrir o pedido de aprovação não abre um segundo pedido', async () => {
    const checkpointer = new MemorySaver();
    const journal = new InMemoryInvestigationJournal();
    const first = await testDeps({
      llm: new FakeLlmClient([recovered]),
      metricsSource: new FixtureMetricsSource(paymentsRecoveredMetrics),
      traceSource: new FixtureTraceSource(paymentsRecoveredTraces),
    });
    const audit = crashingAudit(first.audit, 'approval_requested');
    await expect(new Investigator({ ...first.deps, audit, checkpointer, journal }).investigate(paymentsAlert)).rejects.toThrow(/caiu/);
    expect(await first.approvals.list()).toHaveLength(1);

    const later = { ...first.deps, audit, checkpointer, journal, now: () => new Date(FIXED_NOW.getTime() + 600_000) };
    const [report] = await new Investigator(later).resumeInterrupted(60_000);
    expect(report?.outcome).toBe('interrupted');
    expect(await first.approvals.list()).toHaveLength(1);
  });

  it('grafo concluído cujo relatório não chegou a ser salvo é finalizado sem reexecutar nada', async () => {
    const checkpointer = new MemorySaver();
    const journal = new InMemoryInvestigationJournal();
    const llm = new FakeLlmClient([noisyTenant]);
    const first = await testDeps({
      llm,
      metricsSource: new FixtureMetricsSource(saasNoisyTenantMetrics),
      traceSource: new FixtureTraceSource(saasNoisyTenantTraces),
    });
    let failSave = true;
    const incidents = {
      ...first.incidents,
      get: first.incidents.get.bind(first.incidents),
      list: first.incidents.list.bind(first.incidents),
      claimRollback: first.incidents.claimRollback.bind(first.incidents),
      releaseRollback: first.incidents.releaseRollback.bind(first.incidents),
      save: async (report: Parameters<typeof first.incidents.save>[0]) => {
        if (failSave) throw new Error('redis fora');
        await first.incidents.save(report);
      },
    };
    const deps = { ...first.deps, incidents, checkpointer, journal };
    await expect(new Investigator(deps).investigate(saasAlert)).rejects.toThrow(/redis fora/);
    failSave = false;
    const [report] = await new Investigator({ ...deps, now: () => new Date(FIXED_NOW.getTime() + 600_000) }).resumeInterrupted(60_000);
    expect(report?.outcome).toBe('auto_executed');
    expect(llm.requests).toHaveLength(1);
    expect((await first.incidents.list(5))).toHaveLength(1);
  });
});

describe('RedisCheckpointSaver', () => {
  /** Dublê mínimo de Redis: get, set e del com expiração ignorada. */
  const fakeRedis = () => {
    const data = new Map<string, string>();
    return {
      redis: {
        get: async (key: string) => data.get(key) ?? null,
        set: async (key: string, value: string) => (data.set(key, value), 'OK'),
        del: async (key: string) => Number(data.delete(key)),
      } as unknown as Redis,
      data,
    };
  };

  it('outra instância lê os checkpoints gravados pela primeira e retoma a investigação', async () => {
    const { redis, data } = fakeRedis();
    const journal = new InMemoryInvestigationJournal();
    const sources = {
      metricsSource: new FixtureMetricsSource(saasNoisyTenantMetrics),
      traceSource: new FixtureTraceSource(saasNoisyTenantTraces),
    };
    const first = await testDeps({ llm: new FakeLlmClient([]), ...sources });
    await expect(new Investigator({ ...first.deps, checkpointer: new RedisCheckpointSaver(redis), journal }).investigate(saasAlert)).rejects.toThrow();
    expect([...data.keys()].some((key) => key.startsWith('ops-copilot:checkpoint:'))).toBe(true);

    const second = await testDeps({ llm: new FakeLlmClient([noisyTenant]), ...sources });
    const investigator = new Investigator({
      ...second.deps,
      checkpointer: new RedisCheckpointSaver(redis),
      journal,
      now: () => new Date(FIXED_NOW.getTime() + 600_000),
    });
    const [report] = await investigator.resumeInterrupted(60_000);
    expect(report?.outcome).toBe('auto_executed');
    // Concluída, a thread sai do Redis.
    expect([...data.keys()].filter((key) => key.startsWith('ops-copilot:checkpoint:'))).toEqual([]);
  });
});
