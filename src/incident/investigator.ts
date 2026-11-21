// Caso de uso "investigar alerta": deduplica, roda o grafo num span raiz e consolida o relatório.
import { randomUUID } from 'node:crypto';
import type { Decision } from '../autonomy/gate.js';
import type { Alert } from '../domain/alert.js';
import type { ExecutionResult } from '../executor/executor.js';
import type { InvestigationDeps } from '../graph/deps.js';
import { buildInvestigationGraph, type InvestigationGraph } from '../graph/graph.js';
import type { Outcome } from '../graph/state.js';
import type { LlmUsage } from '../llm/structured.js';
import { withSpan } from '../telemetry/tracing.js';
import type { Diagnosis } from './diagnosis.js';

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
  readonly failure: string | null;
  readonly llmUsage: LlmUsage;
}

const DEDUP_TTL_MS = 6 * 60 * 60 * 1000;

export class Investigator {
  readonly #deps: InvestigationDeps;
  readonly #graph: InvestigationGraph;
  /** Alertmanager reenvia o mesmo alerta a cada repeat_interval; a mesma ocorrência abre um só incidente. */
  readonly #seen = new Map<string, number>();

  constructor(deps: InvestigationDeps) {
    this.#deps = deps;
    this.#graph = buildInvestigationGraph(deps);
  }

  /** Devolve `null` quando o alerta é repetição de uma ocorrência já investigada. */
  async investigate(alert: Alert): Promise<IncidentReport | null> {
    if (this.#isDuplicate(alert)) return null;
    const incidentId = randomUUID();

    return withSpan(
      this.#deps.tracer,
      'ops_copilot.investigate',
      {
        'ops_copilot.incident_id': incidentId,
        'ops_copilot.service': alert.service,
        'ops_copilot.alertname': alert.alertname,
      },
      async (set) => {
        const state = await this.#graph.invoke({ incidentId, alert });
        const outcome = state.outcome ?? 'no_action';
        set({
          'ops_copilot.outcome': outcome,
          'gen_ai.usage.input_tokens': state.llmUsage.inputTokens,
          'gen_ai.usage.output_tokens': state.llmUsage.outputTokens,
        });
        if (state.llmUsage.costUsd !== null) set({ 'ops_copilot.llm.cost_usd': state.llmUsage.costUsd });
        this.#deps.metrics.incidents.inc({ service: alert.service, outcome });
        return {
          incidentId,
          service: alert.service,
          alertname: alert.alertname,
          outcome,
          playbookId: state.playbook?.metadata.id ?? null,
          diagnosis: state.diagnosis,
          decision: state.decision,
          execution: state.execution,
          approvalId: state.approvalId,
          failure: state.failure,
          llmUsage: state.llmUsage,
        };
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
