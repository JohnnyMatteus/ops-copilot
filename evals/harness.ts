// Harness de avaliação: roda o grafo real sobre incidentes sintéticos e mede o acerto.
// Só o LLM varia (falso no CI, real sob demanda); playbooks, política e gate são os de produção.
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { InMemoryAuditLog } from '../src/autonomy/audit.js';
import { SlidingWindowBudget } from '../src/autonomy/budget.js';
import { AutonomyGate } from '../src/autonomy/gate.js';
import type { AutonomyPolicy } from '../src/autonomy/policy.js';
import { DryRunExecutor } from '../src/executor/executor.js';
import { OutcomeSchema, type Outcome } from '../src/graph/state.js';
import { ApprovalStore } from '../src/incident/approvals.js';
import { Investigator } from '../src/incident/investigator.js';
import type { LlmClient } from '../src/llm/client.js';
import { EMPTY_USAGE, type LlmUsage } from '../src/llm/structured.js';
import type { PlaybookRegistry } from '../src/playbooks/registry.js';
import { FixtureMetricsSource, FixtureTraceSource } from '../src/signals/fixture.js';
import { TraceSummarySchema, type MetricSeries } from '../src/signals/types.js';
import { CopilotMetrics } from '../src/telemetry/metrics.js';
import { createTracing } from '../src/telemetry/tracing.js';

const SeriesFixtureSchema = z.object({
  labels: z.record(z.string(), z.string()),
  values: z.array(z.number()).min(1),
});

export const EvalCaseSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().min(1),
  alert: z.strictObject({
    alertname: z.string().min(1),
    service: z.string().min(1),
    labels: z.record(z.string(), z.string()).default({}),
  }),
  metrics: z.record(z.string(), z.array(SeriesFixtureSchema)),
  traces: z.record(z.string(), z.array(TraceSummarySchema)),
  expected: z.strictObject({
    hypothesisId: z.string().nullable(),
    actionId: z.string().nullable(),
    outcome: OutcomeSchema,
  }),
});
export type EvalCase = z.infer<typeof EvalCaseSchema>;

const DatasetSchema = z.strictObject({ version: z.literal(1), cases: z.array(EvalCaseSchema).min(1) });

export async function loadDataset(path: string): Promise<EvalCase[]> {
  const dataset = DatasetSchema.parse(parse(await readFile(path, 'utf8')));
  const ids = dataset.cases.map((c) => c.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate) throw new Error(`Caso duplicado no dataset: ${duplicate}`);
  return dataset.cases;
}

export interface CaseResult {
  readonly id: string;
  readonly expected: EvalCase['expected'];
  readonly actual: { hypothesisId: string | null; actionId: string | null; outcome: Outcome };
  readonly hits: { hypothesis: boolean; action: boolean; outcome: boolean };
  readonly usage: LlmUsage;
  readonly failure: string | null;
}

export interface EvalMetrics {
  readonly cases: number;
  readonly hypothesisAccuracy: number;
  readonly actionAccuracy: number;
  readonly outcomeAccuracy: number;
  /** Fração das investigações com LLM que precisaram do retry de schema. */
  readonly retryRate: number;
  readonly diagnosisFailures: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number | null;
}

export interface EvalReport {
  readonly model: string;
  readonly results: readonly CaseResult[];
  readonly metrics: EvalMetrics;
}

export interface EvalOptions {
  readonly cases: readonly EvalCase[];
  readonly playbooks: PlaybookRegistry;
  readonly policy: AutonomyPolicy;
  readonly model: string;
  /** Um cliente por caso: o falso tem roteiro por caso; o real pode ser o mesmo para todos. */
  readonly llmFor: (caseId: string) => LlmClient;
  readonly now?: Date;
}

const toSeries = (fixture: z.infer<typeof SeriesFixtureSchema>): MetricSeries => ({
  labels: fixture.labels,
  points: fixture.values.map((v, i) => ({ t: i * 60, v })),
});

export async function runEvals(options: EvalOptions): Promise<EvalReport> {
  const now = options.now ?? new Date('2026-11-20T12:00:00Z');
  const tracing = createTracing([]);
  const results: CaseResult[] = [];

  // Sequencial e com dependências novas por caso: nenhum caso consome orçamento de outro.
  for (const evalCase of options.cases) {
    const investigator = new Investigator({
      playbooks: options.playbooks,
      metricsSource: new FixtureMetricsSource(
        Object.fromEntries(Object.entries(evalCase.metrics).map(([name, list]) => [name, list.map(toSeries)])),
      ),
      traceSource: new FixtureTraceSource(evalCase.traces),
      llm: options.llmFor(evalCase.id),
      model: options.model,
      gate: new AutonomyGate(options.policy, new SlidingWindowBudget(() => now.getTime())),
      executor: new DryRunExecutor(),
      approvals: new ApprovalStore({ ttlMs: 60_000, now: () => now.getTime() }),
      audit: new InMemoryAuditLog(() => now),
      tracer: tracing.tracer,
      metrics: new CopilotMetrics(),
      now: () => now,
    });
    const report = await investigator.investigate({
      fingerprint: evalCase.id,
      alertname: evalCase.alert.alertname,
      service: evalCase.alert.service,
      severity: 'critical',
      startsAt: now.toISOString(),
      labels: { alertname: evalCase.alert.alertname, service: evalCase.alert.service, ...evalCase.alert.labels },
      annotations: { summary: evalCase.description },
    });
    if (!report) throw new Error(`Caso ${evalCase.id} tratado como duplicado.`);

    const actual = {
      hypothesisId: report.diagnosis?.hypothesisId ?? null,
      actionId: report.diagnosis?.proposedAction?.actionId ?? null,
      outcome: report.outcome,
    };
    results.push({
      id: evalCase.id,
      expected: evalCase.expected,
      actual,
      hits: {
        hypothesis: actual.hypothesisId === evalCase.expected.hypothesisId,
        action: actual.actionId === evalCase.expected.actionId,
        outcome: actual.outcome === evalCase.expected.outcome,
      },
      usage: report.llmUsage,
      failure: report.failure,
    });
  }
  return { model: options.model, results, metrics: summarize(results) };
}

/** `empty` é o valor quando não há casos: acerto vazio conta como 1, taxa de retry vazia como 0. */
function ratio(hits: number, total: number, empty = 1): number {
  return total === 0 ? empty : hits / total;
}

export function summarize(results: readonly CaseResult[]): EvalMetrics {
  const diagnosable = results.filter((r) => r.expected.hypothesisId !== null);
  const withLlm = results.filter((r) => r.usage.calls > 0);
  const usage = results.reduce<LlmUsage>(
    (total, r) => ({
      calls: total.calls + r.usage.calls,
      inputTokens: total.inputTokens + r.usage.inputTokens,
      outputTokens: total.outputTokens + r.usage.outputTokens,
      costUsd: total.costUsd === null || r.usage.costUsd === null ? null : total.costUsd + r.usage.costUsd,
    }),
    EMPTY_USAGE,
  );
  return {
    cases: results.length,
    hypothesisAccuracy: ratio(diagnosable.filter((r) => r.hits.hypothesis).length, diagnosable.length),
    actionAccuracy: ratio(diagnosable.filter((r) => r.hits.action).length, diagnosable.length),
    outcomeAccuracy: ratio(results.filter((r) => r.hits.outcome).length, results.length),
    retryRate: ratio(withLlm.filter((r) => r.usage.calls > 1).length, withLlm.length, 0),
    diagnosisFailures: results.filter((r) => r.actual.outcome === 'diagnosis_failed').length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: usage.costUsd,
  };
}

export function formatReport(report: EvalReport): string {
  const mark = (ok: boolean) => (ok ? 'ok ' : 'ERR');
  const lines = report.results.map(
    (r) =>
      `${mark(r.hits.hypothesis)} ${mark(r.hits.action)} ${mark(r.hits.outcome)}  ${r.id.padEnd(32)} ` +
      `esperado=${String(r.expected.hypothesisId)}/${r.expected.outcome}  obtido=${String(r.actual.hypothesisId)}/${r.actual.outcome}`,
  );
  const m = report.metrics;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  return [
    `Modelo: ${report.model}  |  casos: ${String(m.cases)}`,
    'hip ação desf caso',
    ...lines,
    '',
    `Acerto de hipótese: ${pct(m.hypothesisAccuracy)}`,
    `Acerto de ação:     ${pct(m.actionAccuracy)}`,
    `Acerto de desfecho: ${pct(m.outcomeAccuracy)}`,
    `Taxa de retry:      ${pct(m.retryRate)}  |  falhas de diagnóstico: ${String(m.diagnosisFailures)}`,
    `Tokens: ${String(m.inputTokens)} entrada, ${String(m.outputTokens)} saída  |  custo: ${m.costUsd === null ? 'desconhecido' : `US$ ${m.costUsd.toFixed(4)}`}`,
  ].join('\n');
}
