// Rollback (ADR 0015): reverte uma ação executada com a ação inversa guardada no resultado.
// A inversa passa pelo gate (mesmas barreiras), exige um aprovador humano e é auditada.
import type { AuditLog } from '../autonomy/audit.js';
import type { AutonomyGate, Decision } from '../autonomy/gate.js';
import type { Operator } from '../auth/operator.js';
import type { ActionExecutor, ExecutionResult } from '../executor/executor.js';
import type { CopilotMetrics } from '../telemetry/metrics.js';
import type { IncidentRepository } from './incidents.js';

export type RollbackOutcome =
  | { readonly status: 'rolled_back'; readonly execution: ExecutionResult }
  | { readonly status: 'failed'; readonly execution: ExecutionResult }
  | { readonly status: 'blocked'; readonly decision: Decision }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_reversible' | 'already_rolled_back'; readonly reason: string };

export class RollbackService {
  readonly #incidents: IncidentRepository;
  readonly #gate: AutonomyGate;
  readonly #executor: ActionExecutor;
  readonly #audit: AuditLog;
  readonly #metrics: CopilotMetrics;
  readonly #now: () => Date;

  constructor(deps: {
    incidents: IncidentRepository;
    gate: AutonomyGate;
    executor: ActionExecutor;
    audit: AuditLog;
    metrics: CopilotMetrics;
    now?: () => Date;
  }) {
    this.#incidents = deps.incidents;
    this.#gate = deps.gate;
    this.#executor = deps.executor;
    this.#audit = deps.audit;
    this.#metrics = deps.metrics;
    this.#now = deps.now ?? (() => new Date());
  }

  async rollback(incidentId: string, operator: Operator, reason: string): Promise<RollbackOutcome> {
    const report = await this.#incidents.get(incidentId);
    if (!report) return { status: 'not_found' };
    const execution = report.execution ?? report.resolution?.execution ?? null;
    if (execution?.status !== 'executed' || !execution.undo) {
      return { status: 'not_reversible', reason: 'Nenhuma ação executada com ação inversa registrada neste incidente.' };
    }
    if (!(await this.#incidents.claimRollback(incidentId))) {
      return { status: 'already_rolled_back', reason: 'Este incidente já teve rollback.' };
    }

    const actor = `human:${operator.email}`;
    const decision = this.#gate.authorizeRollback({
      service: report.service,
      originalActionId: execution.actionId,
      undo: execution.undo,
    });
    if (decision.verdict === 'blocked' || !decision.action) {
      await this.#incidents.releaseRollback(incidentId);
      await this.#audit.append({
        incidentId,
        event: 'rollback_blocked',
        actor: 'copilot',
        details: { requestedBy: operator.email, reasons: decision.reasons },
      });
      this.#metrics.rollbacks.inc({ service: report.service, outcome: 'blocked' });
      return { status: 'blocked', decision };
    }

    const action = decision.action;
    const result: ExecutionResult = await this.#executor
      .execute(action, { incidentId, service: report.service, authorizedBy: actor })
      .catch((error: unknown) => ({ status: 'failed', actionId: action.id, detail: (error as Error).message }));
    const failed = result.status === 'failed';
    await this.#audit.append({
      incidentId,
      event: failed ? 'rollback_failed' : 'rollback_executed',
      actor,
      details: { ...result, reason, original: execution.actionId, via: operator.via, mode: this.#executor.mode },
    });
    await this.#incidents.save({
      ...report,
      rollback: { by: operator.email, reason, at: this.#now().toISOString(), execution: result },
    });
    // Falha real do executor libera nova tentativa; o gate já autorizou a mesma inversa.
    if (failed) await this.#incidents.releaseRollback(incidentId);
    this.#metrics.rollbacks.inc({ service: report.service, outcome: failed ? 'failed' : 'executed' });
    return failed ? { status: 'failed', execution: result } : { status: 'rolled_back', execution: result };
  }
}
