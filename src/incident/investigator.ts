// Caso de uso "investigar alerta": deduplica, roda o grafo num span raiz e consolida o relatório.
import { randomUUID } from 'node:crypto';
import { MemorySaver, type BaseCheckpointSaver } from '@langchain/langgraph';
import type { Decision } from '../autonomy/gate.js';
import type { Alert } from '../domain/alert.js';
import type { ExecutionResult } from '../executor/executor.js';
import type { InvestigationDeps } from '../graph/deps.js';
import { buildInvestigationGraph, type InvestigationGraph } from '../graph/graph.js';
import { EFFECT_ALREADY_RESERVED } from '../graph/nodes/act.js';
import { EMPTY_USAGE } from '../llm/structured.js';
import type { InvestigationStateType, Outcome, StepRecord } from '../graph/state.js';
import type { Signal } from '../signals/types.js';
import type { LlmUsage } from '../llm/structured.js';
import { withSpan } from '../telemetry/tracing.js';
import type { Diagnosis } from './diagnosis.js';
import type { Resolution, RollbackRecord } from './incidents.js';
import { InMemoryEffectGuard, type EffectGuard } from './effects.js';
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

const DEFAULT_LEASE_MS = 30_000;
const INTERRUPTED_AT_ACT =
  'Investigação interrompida na etapa de ação; a ação pode já ter ocorrido e não foi repetida. Verifique manualmente.';

/** Estado mínimo para encerrar como interrompida uma investigação sem checkpoint legível. */
const EMPTY_STATE = {
  playbook: null,
  signals: [],
  diagnosis: null,
  decision: null,
  execution: null,
  approvalId: null,
  approvalExpiresAt: null,
  llmUsage: EMPTY_USAGE,
  steps: [],
  timeline: [],
};

const threadOf = (incidentId: string) => ({ configurable: { thread_id: incidentId } });

const DEDUP_TTL_MS = 6 * 60 * 60 * 1000;

export class Investigator {
  readonly #deps: InvestigationDeps;
  readonly #graph: InvestigationGraph;
  /** Alertmanager reenvia o mesmo alerta a cada repeat_interval; a mesma ocorrência abre um só incidente. */
  readonly #seen = new Map<string, number>();

  readonly #journal: InvestigationJournal;
  readonly #checkpointer: BaseCheckpointSaver;

  readonly #effects: EffectGuard;
  readonly #leaseMs: number;
  readonly #maxResumeAttempts: number;

  constructor(deps: InvestigationDeps, options: { leaseMs?: number; maxResumeAttempts?: number } = {}) {
    this.#deps = deps;
    this.#journal = deps.journal ?? new InMemoryInvestigationJournal();
    this.#checkpointer = deps.checkpointer ?? new MemorySaver();
    this.#effects = deps.effects ?? new InMemoryEffectGuard();
    this.#leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS;
    this.#maxResumeAttempts = options.maxResumeAttempts ?? 3;
    this.#graph = buildInvestigationGraph({ ...deps, checkpointer: this.#checkpointer, effects: this.#effects });
  }

  /** Devolve `null` quando o alerta é repetição de uma ocorrência já investigada. */
  async investigate(alert: Alert): Promise<IncidentReport | null> {
    if (this.#isDuplicate(alert)) return null;
    const incidentId = randomUUID();
    const startedAt = this.#deps.now().toISOString();
    await this.#journal.begin({ incidentId, alert, startedAt });
    return this.#leased(incidentId, () =>
      this.#run(incidentId, alert, startedAt, () => this.#graph.invoke({ incidentId, alert }, threadOf(incidentId))),
    );
  }

  /**
   * Retoma as investigações sem relatório (processo caiu no meio, ADR 0018). Quem detém o lease
   * está vivo e é deixado em paz, inclusive neste mesmo processo; só o lease expirado ou liberado
   * permite a retomada. Cada entrada é isolada: uma que falha não bloqueia as demais, e depois de
   * `maxResumeAttempts` ela termina como `interrupted`, auditada.
   */
  async resumeInterrupted(onError: (incidentId: string, error: unknown) => void = () => undefined): Promise<IncidentReport[]> {
    const resumed: IncidentReport[] = [];
    for (const entry of await this.#journal.pending()) {
      const report = await this.#leased(
        entry.incidentId,
        async () => {
          try {
            // Terminou entre a leitura da lista e o lease: nada a retomar.
            if (await this.#deps.incidents.get(entry.incidentId)) {
              await this.#journal.finish(entry.incidentId);
              return null;
            }
            const attempts = await this.#journal.bumpAttempts(entry.incidentId);
            if (attempts > this.#maxResumeAttempts) return await this.#abandon(entry, `${String(this.#maxResumeAttempts)} tentativas de retomada falharam`);
            return await this.#resume(entry);
          } catch (error) {
            onError(entry.incidentId, error);
            return null;
          }
        },
        true,
      ).catch((error: unknown) => {
        onError(entry.incidentId, error);
        return null;
      });
      if (report) resumed.push(report);
    }
    return resumed;
  }

  /**
   * Executa `work` com o lease da investigação, renovado por heartbeat enquanto roda. Com
   * `onlyIfFree`, devolve `null` sem trabalhar se outro detém o lease.
   */
  async #leased<T>(incidentId: string, work: () => Promise<T>, onlyIfFree = false): Promise<T | null> {
    const owner = randomUUID();
    const acquired = await this.#journal.acquire(incidentId, owner, this.#leaseMs);
    if (!acquired && onlyIfFree) return null;
    const timer = setInterval(() => void this.#journal.renew(incidentId, owner, this.#leaseMs).catch(() => false), Math.max(Math.floor(this.#leaseMs / 3), 5));
    timer.unref();
    try {
      return await work();
    } finally {
      clearInterval(timer);
      await this.#journal.release(incidentId, owner).catch(() => undefined);
    }
  }

  async #resume(entry: InFlight): Promise<IncidentReport | null> {
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
      await this.#audit(incidentId, 'investigation_interrupted', { at: 'act', verdict: values.decision?.verdict ?? null });
      return this.#run(incidentId, alert, startedAt, async () => ({ ...(snapshot.values as InvestigationStateType), outcome: 'interrupted', failure: INTERRUPTED_AT_ACT }));
    }
    await this.#audit(incidentId, 'investigation_resumed', { from: next });
    return this.#run(incidentId, alert, startedAt, () => this.#graph.invoke(null, config));
  }

  /** Encerra uma investigação que não consegue ser retomada, sem tentar o grafo de novo. */
  async #abandon(entry: InFlight, reason: string): Promise<IncidentReport | null> {
    const { incidentId, alert, startedAt } = entry;
    await this.#audit(incidentId, 'investigation_interrupted', { reason });
    const known = await this.#graph.getState(threadOf(incidentId)).then((snapshot) => snapshot.values as Partial<InvestigationStateType>).catch(() => ({}));
    const state = {
      ...EMPTY_STATE,
      ...known,
      incidentId,
      alert,
      outcome: 'interrupted',
      failure: `Investigação interrompida: ${reason}. Verifique manualmente.`,
    } as InvestigationStateType;
    return this.#run(incidentId, alert, startedAt, async () => state);
  }

  /**
   * Repetir a etapa `act` só é seguro se ela não tem efeito antes do registro: veredito sem execução,
   * ou pedido de aprovação que ainda não foi aberto. Execução automática nunca é repetida: o
   * executor pode ter agido antes da queda. (A reserva de efeito é a barreira independente.)
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
  ): Promise<IncidentReport | null> {
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
        // Perdeu a corrida pelo efeito: o relatório de quem agiu prevalece e este não o sobrescreve.
        if (state.failure === EFFECT_ALREADY_RESERVED && (await this.#deps.incidents.get(incidentId))) return null;
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
