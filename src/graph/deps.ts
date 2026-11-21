// Dependências injetadas no grafo. Toda borda com o mundo externo é uma porta substituível em teste.
import type { Tracer } from '@opentelemetry/api';
import type { AuditLog } from '../autonomy/audit.js';
import type { AutonomyGate } from '../autonomy/gate.js';
import type { ActionExecutor } from '../executor/executor.js';
import type { ApprovalStore } from '../incident/approvals.js';
import type { LlmClient } from '../llm/client.js';
import type { PlaybookRegistry } from '../playbooks/registry.js';
import type { MetricsSource, TraceSource } from '../signals/types.js';
import type { CopilotMetrics } from '../telemetry/metrics.js';

export interface InvestigationDeps {
  readonly playbooks: PlaybookRegistry;
  readonly metricsSource: MetricsSource;
  readonly traceSource: TraceSource;
  readonly llm: LlmClient;
  readonly model: string;
  readonly gate: AutonomyGate;
  readonly executor: ActionExecutor;
  readonly approvals: ApprovalStore;
  readonly audit: AuditLog;
  readonly tracer: Tracer;
  readonly metrics: CopilotMetrics;
  readonly now: () => Date;
}
