// Dependências injetadas no grafo. Toda borda com o mundo externo é uma porta substituível em teste.
import type { BaseCheckpointSaver } from '@langchain/langgraph';
import type { Tracer } from '@opentelemetry/api';
import type { AuditLog } from '../autonomy/audit.js';
import type { AutonomyGate } from '../autonomy/gate.js';
import type { ActionExecutor } from '../executor/executor.js';
import type { ApprovalQueue } from '../incident/approvals.js';
import type { EffectGuard } from '../incident/effects.js';
import type { InvestigationJournal } from '../incident/journal.js';
import type { IncidentRepository } from '../incident/incidents.js';
import type { LlmClient } from '../llm/client.js';
import type { RunbookRetriever } from '../rag/runbooks.js';
import type { PlaybookRegistry } from '../playbooks/registry.js';
import type { MetricsSource, TraceSource } from '../signals/types.js';
import type { CopilotMetrics } from '../telemetry/metrics.js';

export interface InvestigationDeps {
  readonly playbooks: PlaybookRegistry;
  readonly metricsSource: MetricsSource;
  readonly traceSource: TraceSource;
  readonly llm: LlmClient;
  readonly model: string;
  /** Checkpoints do grafo, por incidente; padrão em memória (não sobrevive a restart). */
  readonly checkpointer?: BaseCheckpointSaver | undefined;
  readonly journal?: InvestigationJournal | undefined;
  /** Reserva atômica de efeito por incidente; o Investigator injeta uma em memória se faltar. */
  readonly effects?: EffectGuard | undefined;
  /** Runbooks recuperados para o prompt do diagnóstico; só informam, nunca autorizam. */
  readonly runbooks?: RunbookRetriever | undefined;
  /** Teto de custo de LLM por incidente, em dólares; `undefined` desliga o teto. */
  readonly maxLlmCostUsdPerIncident?: number | undefined;
  readonly gate: AutonomyGate;
  readonly executor: ActionExecutor;
  readonly approvals: ApprovalQueue;
  readonly incidents: IncidentRepository;
  readonly audit: AuditLog;
  readonly tracer: Tracer;
  readonly metrics: CopilotMetrics;
  readonly now: () => Date;
}
