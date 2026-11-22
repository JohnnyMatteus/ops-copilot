import { emptyCheckpoint, MemorySaver } from '@langchain/langgraph';
import type { Redis } from 'ioredis';
import { describe, expect, it } from 'vitest';
import type { AuditLog } from '../../src/autonomy/audit.js';
import type { ActionExecutor } from '../../src/executor/executor.js';
import { RedisCheckpointSaver } from '../../src/graph/redis-checkpointer.js';
import { InMemoryEffectGuard } from '../../src/incident/effects.js';
import { InMemoryInvestigationJournal, type InvestigationJournal } from '../../src/incident/journal.js';
import type { LlmClient } from '../../src/llm/client.js';
import { Investigator } from '../../src/incident/investigator.js';
import { FakeLlmClient } from '../../src/llm/fake.js';
import { FixtureMetricsSource, FixtureTraceSource } from '../../src/signals/fixture.js';
import type { MetricsSource } from '../../src/signals/types.js';
import { testDeps } from '../helpers/fixtures.js';
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
    const investigator = new Investigator({ ...second.deps, checkpointer, journal });
    const [report] = await investigator.resumeInterrupted();

    expect(report?.outcome).toBe('auto_executed');
    expect(metrics.counter.calls).toBe(collected);
    expect(report?.steps).toEqual(['triage', 'collect', 'diagnose', 'decide', 'act']);
    expect((await second.audit.records()).map((record) => record.event)).toContain('investigation_resumed');
    expect(await journal.pending()).toEqual([]);
    expect(await investigator.resumeInterrupted()).toEqual([]);
  });

  it('investigação lenta e viva, com o timer de retomada disparando, executa o efeito uma única vez', async () => {
    const checkpointer = new MemorySaver();
    const journal = new InMemoryInvestigationJournal();
    const effects = new InMemoryEffectGuard();
    let executions = 0;
    const executor: ActionExecutor = {
      mode: 'live',
      execute: async (action) => ({ status: 'executed', actionId: action.id, detail: `execução ${String(++executions)}` }),
    };
    const inner = new FakeLlmClient([noisyTenant]);
    // Dura bem mais que o lease (60 ms): só o heartbeat o mantém vivo.
    const slow: LlmClient = { chat: async (request) => (await new Promise((resolve) => setTimeout(resolve, 400)), inner.chat(request)) };
    const setup = await testDeps({
      llm: slow,
      metricsSource: new FixtureMetricsSource(saasNoisyTenantMetrics),
      traceSource: new FixtureTraceSource(saasNoisyTenantTraces),
      executor,
    });
    const shared = { ...setup.deps, checkpointer, journal, effects };
    const live = new Investigator(shared, { leaseMs: 60 });
    const sameProcessTimer = live;
    const otherProcessTimer = new Investigator(shared, { leaseMs: 60 });

    const running = live.investigate(saasAlert);
    const resumed: unknown[] = [];
    for (let tick = 0; tick < 24; tick++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      resumed.push(...(await sameProcessTimer.resumeInterrupted()), ...(await otherProcessTimer.resumeInterrupted()));
    }
    const report = await running;

    expect(resumed).toEqual([]);
    expect(report?.outcome).toBe('auto_executed');
    expect(executions).toBe(1);
    expect(inner.requests).toHaveLength(1);
  });

  it('última barreira: duas retomadas concorrentes do mesmo incidente, mesmo com o lease burlado, executam uma vez', async () => {
    const checkpointer = new MemorySaver();
    const base = new InMemoryInvestigationJournal();
    // Journal que sempre concede o lease: isola a reserva de efeito como única proteção.
    const permissive: InvestigationJournal = {
      begin: (entry) => base.begin(entry),
      finish: (id) => base.finish(id),
      pending: () => base.pending(),
      acquire: async () => true,
      renew: async () => true,
      release: async () => undefined,
      bumpAttempts: (id) => base.bumpAttempts(id),
    };
    const effects = new InMemoryEffectGuard();
    let executions = 0;
    const executor: ActionExecutor = {
      mode: 'live',
      execute: async (action) => ({ status: 'executed', actionId: action.id, detail: `execução ${String(++executions)}` }),
    };
    const sources = {
      metricsSource: new FixtureMetricsSource(saasNoisyTenantMetrics),
      traceSource: new FixtureTraceSource(saasNoisyTenantTraces),
    };
    const first = await testDeps({ llm: new FakeLlmClient([]), executor, ...sources });
    const incidents = first.incidents;
    await expect(new Investigator({ ...first.deps, checkpointer, journal: permissive, effects }).investigate(saasAlert)).rejects.toThrow();

    const a = await testDeps({ llm: new FakeLlmClient([noisyTenant]), executor, ...sources });
    const b = await testDeps({ llm: new FakeLlmClient([noisyTenant]), executor, ...sources });
    await Promise.all([
      new Investigator({ ...a.deps, incidents, audit: first.audit, checkpointer, journal: permissive, effects }).resumeInterrupted(),
      new Investigator({ ...b.deps, incidents, audit: first.audit, checkpointer, journal: permissive, effects }).resumeInterrupted(),
    ]);

    expect(executions).toBe(1);
    const stored = await incidents.list(10);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.outcome).toBe('auto_executed');
  });

  it('entrada que falha não bloqueia as demais e, esgotadas as tentativas, termina interrupted auditado', async () => {
    const checkpointer = new MemorySaver();
    const journal = new InMemoryInvestigationJournal();
    const effects = new InMemoryEffectGuard();
    const inner = new FakeLlmClient([noisyTenant]);
    let healthy = false;
    // Na primeira vida tudo falha; depois só o pagamento continua falhando.
    const llm: LlmClient = {
      chat: async (request) => {
        const prompt = request.messages.map((message) => message.content).join('\n');
        if (!healthy || prompt.includes('payments-events-go')) throw new Error('provedor fora');
        return inner.chat(request);
      },
    };
    const setup = await testDeps({
      llm,
      metricsSource: new FixtureMetricsSource({ ...saasNoisyTenantMetrics, ...paymentsRecoveredMetrics }),
      traceSource: new FixtureTraceSource({ ...saasNoisyTenantTraces, ...paymentsRecoveredTraces }),
    });
    const investigator = new Investigator({ ...setup.deps, checkpointer, journal, effects });
    await expect(investigator.investigate(paymentsAlert)).rejects.toThrow();
    await expect(investigator.investigate(saasAlert)).rejects.toThrow();
    healthy = true;

    const errors: string[] = [];
    const onError = (id: string) => errors.push(id);
    const first = await investigator.resumeInterrupted(onError);
    expect(first.map((report) => report.service)).toEqual(['saas-multitenant']);
    expect(errors).toHaveLength(1);

    await investigator.resumeInterrupted(onError);
    await investigator.resumeInterrupted(onError);
    expect(errors).toHaveLength(3);
    const [abandoned] = await investigator.resumeInterrupted(onError);
    expect(abandoned).toMatchObject({ service: 'payments-events-go', outcome: 'interrupted' });
    expect(abandoned?.failure).toMatch(/Verifique manualmente/);
    expect((await setup.audit.records()).filter((record) => record.event === 'investigation_interrupted')).toHaveLength(1);
    expect(await journal.pending()).toEqual([]);
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

    const later = { ...first.deps, audit, checkpointer, journal };
    const [report] = await new Investigator(later).resumeInterrupted();
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

    const later = { ...first.deps, audit, checkpointer, journal };
    const [report] = await new Investigator(later).resumeInterrupted();
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
    const [report] = await new Investigator(deps).resumeInterrupted();
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

  it('a retomada relê o Redis: não usa o cache velho de uma instância que já tinha lido a thread', async () => {
    const { redis } = fakeRedis();
    const a = new RedisCheckpointSaver(redis);
    const b = new RedisCheckpointSaver(redis);
    const config = { configurable: { thread_id: 'inc-1', checkpoint_ns: '' } };
    const cp1 = { ...emptyCheckpoint(), id: '00000000-0000-1000-8000-000000000001' };
    const cp2 = { ...emptyCheckpoint(), id: '00000000-0000-1000-8000-000000000002' };
    const meta = { source: 'loop' as const, step: 0, parents: {} };

    const saved1 = await a.put(config, cp1, meta);
    expect((await b.getTuple(config))?.checkpoint.id).toBe(cp1.id); // b passa a ter a thread em cache
    await a.put(saved1, cp2, { ...meta, step: 1 }); // o processo "vivo" avança
    expect((await b.getTuple(config))?.checkpoint.id).toBe(cp2.id);
  });

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
    const investigator = new Investigator({ ...second.deps, checkpointer: new RedisCheckpointSaver(redis), journal });
    const [report] = await investigator.resumeInterrupted();
    expect(report?.outcome).toBe('auto_executed');
    // Concluída, a thread sai do Redis.
    expect([...data.keys()].filter((key) => key.startsWith('ops-copilot:checkpoint:'))).toEqual([]);
  });
});
