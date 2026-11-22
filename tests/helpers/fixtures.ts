// Dependências do grafo com dublês: LLM falso, fontes de sinais fixas, auditoria em memória.
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import type { Operator } from '../../src/auth/operator.js';
import { InMemoryAuditLog } from '../../src/autonomy/audit.js';
import { InMemoryActionBudget, type ActionBudget } from '../../src/autonomy/budget.js';
import { AutonomyGate } from '../../src/autonomy/gate.js';
import type { AutonomyPolicy } from '../../src/autonomy/policy.js';
import { DryRunExecutor, type ActionExecutor } from '../../src/executor/executor.js';
import type { InvestigationDeps } from '../../src/graph/deps.js';
import { InMemoryApprovalQueue } from '../../src/incident/approvals.js';
import { InMemoryIncidentRepository } from '../../src/incident/incidents.js';
import type { LlmClient } from '../../src/llm/client.js';
import type { MetricsSource, TraceSource } from '../../src/signals/types.js';
import { CopilotMetrics } from '../../src/telemetry/metrics.js';
import { createTracing } from '../../src/telemetry/tracing.js';
import { realPlaybooks, realPolicy } from './repo.js';

export const FIXED_NOW = new Date('2026-11-20T12:00:00Z');
export interface TestDepsOverrides {
  readonly llm: LlmClient;
  readonly metricsSource: MetricsSource;
  readonly traceSource: TraceSource;
  readonly policy?: AutonomyPolicy;
  readonly executor?: ActionExecutor;
  readonly budget?: ActionBudget;
  readonly maxLlmCostUsdPerIncident?: number;
}

export async function testDeps(overrides: TestDepsOverrides) {
  const spans = new InMemorySpanExporter();
  const tracing = createTracing([new SimpleSpanProcessor({ exporter: spans })]);
  const audit = new InMemoryAuditLog(() => FIXED_NOW);
  const incidents = new InMemoryIncidentRepository();
  const approvals = new InMemoryApprovalQueue({ ttlMs: 30 * 60_000, now: () => FIXED_NOW.getTime() });
  const metrics = new CopilotMetrics();
  const budget = overrides.budget ?? new InMemoryActionBudget(() => FIXED_NOW.getTime());
  const gate = new AutonomyGate(overrides.policy ?? (await realPolicy()), budget);
  const deps: InvestigationDeps = {
    playbooks: await realPlaybooks(),
    metricsSource: overrides.metricsSource,
    traceSource: overrides.traceSource,
    llm: overrides.llm,
    model: 'fake-model',
    maxLlmCostUsdPerIncident: overrides.maxLlmCostUsdPerIncident,
    gate,
    executor: overrides.executor ?? new DryRunExecutor(),
    approvals,
    incidents,
    audit,
    tracer: tracing.tracer,
    metrics,
    now: () => FIXED_NOW,
  };
  return { deps, spans, audit, approvals, incidents, metrics, gate, budget };
}

export const PLANTONISTA: Operator = { email: 'plantonista@example.com', name: 'plantonista', via: 'token', role: 'approver' };
export const LIDER: Operator = { email: 'lider@example.com', name: 'lider', via: 'token', role: 'approver' };
export const LEITOR: Operator = { email: 'leitor@example.com', name: 'leitor', via: 'token', role: 'reader' };
