// Caso de uso "investigar alerta": deduplica, roda o grafo num span raiz e consolida o relatório.
import { randomUUID } from 'node:crypto';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Decision } from '../autonomy/gate.js';
import type { Alert } from '../domain/alert.js';
import type { ExecutionResult } from '../executor/executor.js';
import type { InvestigationDeps } from '../graph/deps.js';
import { buildInvestigationGraph, type InvestigationGraph } from '../graph/graph.js';
import type { InvestigationStateType, Outcome, StepRecord } from '../graph/state.js';
import type { Signal } from '../signals/types.js';
import type { LlmUsage } from '../llm/structured.js';
import { withSpan } from '../telemetry/tracing.js';
import type { Diagnosis } from './diagnosis.js';
import type { Resolution, RollbackRecord } from './incidents.js';
import { InMemoryInvestigationJournal, type InFlight, type InvestigationJournal } from './journal.js';

export interface IncidentReport {
  readonly incidentId: string;
  readonly service: string;
  readonly alertname: string;
  readonly outcome: Outcome;
  readonly playbookId: string | null;
  readonly diagnosis: Diagnosis | null;
  readonly decision: Decision | null;
  readonly execution: ExecutionResult | null;
  readonly approvalId: string | null;
  /** Prazo da aprovação pendente; passado o prazo sem decisão, o pedido expira. */
  readonly approvalExpiresAt: string | null;
  readonly failure: string | null;
  readonly llmUsage: LlmUsage;
  readonly steps: readonly string[];
  readonly timeline: readonly StepRecord[];
  /** Evidências coletadas, incluindo as fontes que falharam. */
  readonly signals: readonly Signal[];
  readonly severity: string;
  readonly alertStartedAt: string;
  readonly alertSummary: string | null;
  /** Decisão humana posterior (aprovação, recusa ou cancelamento); `null` enquanto ninguém decidiu. */
  readonly resolution: Resolution | null;
  /** Rollback posterior à execução; ausente em relatórios anteriores ao recurso. */
  readonly rollback?: RollbackRecord | null;
  readonly startedAt: string;
  readonly finishedAt: string;
}

const threadOf = (incidentId: string) => ({ configurable: { thread_id: incidentId } });

const DEDUP_TTL_MS = 6 * 60 * 60 * 1000;

export class Investigator {
  readonly #deps: InvestigationDeps;
  readonly #graph: InvestigationGraph;
  /** Alertmanager reenvia o mesmo alerta a cada repeat_interval; a mesma ocorrência abre um só incidente. */
  readonly #seen = new Map<string, number>();

  readonly #journal: InvestigationJournal;
  readonly #checkpointer: BaseCheckpointSaver;

  constructor(deps: InvestigationDeps) {
    this.#deps = deps;
    this.#journal = deps.journal ?? new InMemoryInvestigationJournal();
    this.#checkpointer = deps.checkpointer ?? new MemorySaver();
    this.#graph = buildInvestigationGraph({ ...deps, checkpointer: this.#checkpointer });
  }

  /** Devolve `null` quando o alerta é repetição de uma ocorrência já investigada. */
  async investigate(alert: Alert): Promise<IncidentReport | null> {
    if (this.#isDuplicate(alert)) return null;
    const incidentId = randomUUID();
    const startedAt = this.#deps.now().toISOString();
    await this.#journal.begin({ incidentId, alert, startedAt });
    return this.#run(incidentId, alert, startedAt, () => this.#graph.invoke({ incidentId, alert }, threadOf(incidentId)));
  }

  /**
   * Retoma as investigações que ficaram sem relatório (processo caiu no meio, ADR 0018). Só toca
   * as mais velhas que `staleAfterMs`, para não disputar com uma investigação viva, e cada uma é
   * reservada por um único processo.
   */
  async resumeInterrupted(staleAfterMs: number): Promise<IncidentReport[]> {
    const now = this.#deps.now().getTime();
    const resumed: IncidentReport[] = [];
    for (const entry of await this.#journal.stale(staleAfterMs, now)) {
      if (!(await this.#journal.claim(entry.incidentId, Math.max(staleAfterMs, 60_000)))) continue;
      resumed.push(await this.#resume(entry));
    }
    return resumed;
  }

  async #resume(entry: InFlight): Promise<IncidentReport> {
    const { incidentId, alert, startedAt } = entry;
    const config = threadOf(incidentId);
    const snapshot = await this.#graph.getState(config);
    const next = snapshot.next[0];
    const values = snapshot.values as Partial<InvestigationStateType>;
    const hasCheckpoint = snapshot.config.configurable?.['checkpoint_id'] !== undefined;

    if (!hasCheckpoint) {
      await this.#audit(incidentId, 'investigation_resumed', { from: 'triage', reason: 'sem checkpoint' });
      return this.#run(incidentId, alert, startedAt, () => this.#graph.invoke({ incidentId, alert }, config));
    }
    if (next === undefined) {
      await this.#audit(incidentId, 'investigation_resumed', { from: null, reason: 'grafo concluído sem relatório' });
      return this.#run(incidentId, alert, startedAt, async () => snapshot.values as InvestigationStateType);
    }
    if (next === 'act' && !(await this.#safeToRepeatAct(incidentId, values))) {
      const failure = 'Investigação interrompida na etapa de ação; a ação pode já ter ocorrido e não foi repetida. Verifique manualmente.';
      await this.#audit(incidentId, 'investigation_interrupted', { at: 'act', verdict: values.decision?.verdict ?? null });
      return this.#run(incidentId, alert, startedAt, async () => ({ ...(snapshot.values as InvestigationStateType), outcome: 'interrupted', failure }));
    }
    await this.#audit(incidentId, 'investigation_resumed', { from: next });
    return this.#run(incidentId, alert, startedAt, () => this.#graph.invoke(null, config));
  }

  /**
   * Repetir a etapa `act` só é seguro se ela não tem efeito antes do registro: veredito sem execução,
   * ou pedido de aprovação que ainda não foi aberto. Execução automática nunca é repetida: o
   * executor pode ter agido antes da queda.
   */
  async #safeToRepeatAct(incidentId: string, values: Partial<InvestigationStateType>): Promise<boolean> {
    const verdict = values.decision?.verdict;
    if (verdict === 'blocked' || verdict === 'suggest') return true;
    if (verdict !== 'needs_approval') return false;
    // O pedido pode ter entrado na fila antes da queda sem chegar à trilha: um segundo pedido
    // permitiria executar a mesma ação duas vezes.
    const records = await this.#deps.audit.records();
    if (records.some((record) => record.incidentId === incidentId && record.event === 'approval_requested')) return false;
    return !(await this.#deps.approvals.list()).some((approval) => approval.incidentId === incidentId);
  }

  async #audit(incidentId: string, event: 'investigation_resumed' | 'investigation_interrupted', details: Record<string, unknown>) {
    await this.#deps.audit.append({ incidentId, event, actor: 'copilot', details });
  }

  async #run(
    incidentId: string,
    alert: Alert,
    startedAt: string,
    execute: () => Promise<InvestigationStateType>,
  ): Promise<IncidentReport> {
    return withSpan(
      this.#deps.tracer,
      'ops_copilot.investigate',
      {
        'ops_copilot.incident_id': incidentId,
        'ops_copilot.service': alert.service,
        'ops_copilot.alertname': alert.alertname,
      },
      async (set) => {
        const state = await execute();
        const outcome = state.outcome ?? 'no_action';
        set({
          'ops_copilot.outcome': outcome,
          'gen_ai.usage.input_tokens': state.llmUsage.inputTokens,
          'gen_ai.usage.output_tokens': state.llmUsage.outputTokens,
        });
        if (state.llmUsage.costUsd !== null) set({ 'ops_copilot.llm.cost_usd': state.llmUsage.costUsd });
        this.#deps.metrics.incidents.inc({ service: alert.service, outcome });
        const report: IncidentReport = {
          incidentId,
          service: alert.service,
          alertname: alert.alertname,
          outcome,
          playbookId: state.playbook?.metadata.id ?? null,
          diagnosis: state.diagnosis,
          decision: state.decision,
          execution: state.execution,
          approvalId: state.approvalId,
          approvalExpiresAt: state.approvalExpiresAt,
          failure: state.failure,
          llmUsage: state.llmUsage,
          steps: state.steps,
          timeline: state.timeline,
          signals: state.signals,
          severity: alert.severity,
          alertStartedAt: alert.startsAt,
          alertSummary: alert.annotations['summary'] ?? null,
          resolution: null,
          startedAt,
          finishedAt: this.#deps.now().toISOString(),
        };
        await this.#deps.incidents.save(report);
        await this.#journal.finish(incidentId);
        await this.#checkpointer.deleteThread(incidentId).catch(() => undefined);
        return report;
      },
    );
  }

  #isDuplicate(alert: Alert): boolean {
    const now = this.#deps.now().getTime();
    for (const [key, seenAt] of this.#seen) {
      if (now - seenAt > DEDUP_TTL_MS) this.#seen.delete(key);
    }
    const key = `${alert.fingerprint}:${alert.startsAt}`;
    if (this.#seen.has(key)) return true;
    this.#seen.set(key, now);
    return false;
  }
}
