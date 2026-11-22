// Fluxo de decisão humana: aprova, recusa ou cancela. A identidade de quem decidiu vem da
// credencial do operador (ADR 0012), é registrada na trilha de auditoria e no incidente (ADR 0013).
import type { AuditLog } from '../autonomy/audit.js';
import type { AutonomyGate, Decision } from '../autonomy/gate.js';
import { requireApprover, type Operator } from '../auth/operator.js';
import type { ActionExecutor, ExecutionResult } from '../executor/executor.js';
import type { CopilotMetrics } from '../telemetry/metrics.js';
import type { ApprovalQueue, PendingApproval } from './approvals.js';
import type { IncidentRepository, Resolution } from './incidents.js';

export type ApprovalOutcome =
  | { readonly status: 'executed'; readonly execution: ExecutionResult }
  | { readonly status: 'blocked'; readonly decision: Decision }
  | { readonly status: 'rejected' }
  | { readonly status: 'not_found' | 'expired' };

export type CancelOutcome =
  | { readonly status: 'cancelled' }
  | { readonly status: 'not_found' }
  | { readonly status: 'not_cancellable'; readonly reason: string };

export class ReasonRequiredError extends Error {
  constructor() {
    super('A recusa exige um motivo.');
    this.name = 'ReasonRequiredError';
  }
}

export interface ApprovalDecision {
  readonly approve: boolean;
  readonly reason?: string | undefined;
}

export class ApprovalService {
  readonly #approvals: ApprovalQueue;
  readonly #incidents: IncidentRepository;
  readonly #gate: AutonomyGate;
  readonly #executor: ActionExecutor;
  readonly #audit: AuditLog;
  readonly #metrics: CopilotMetrics;
  readonly #now: () => Date;

  constructor(deps: {
    approvals: ApprovalQueue;
    incidents: IncidentRepository;
    gate: AutonomyGate;
    executor: ActionExecutor;
    audit: AuditLog;
    metrics: CopilotMetrics;
    now?: () => Date;
  }) {
    this.#approvals = deps.approvals;
    this.#incidents = deps.incidents;
    this.#gate = deps.gate;
    this.#executor = deps.executor;
    this.#audit = deps.audit;
    this.#metrics = deps.metrics;
    this.#now = deps.now ?? (() => new Date());
  }

  async resolve(approvalId: string, operator: Operator, decision: ApprovalDecision): Promise<ApprovalOutcome> {
    requireApprover(operator);
    const reason = decision.reason?.trim() || null;
    if (!decision.approve && !reason) throw new ReasonRequiredError();
    const lookup = await this.#approvals.take(approvalId);
    if (lookup.status !== 'found') return { status: lookup.status };
    const outcome = await this.#resolveFound(lookup.approval, operator, decision.approve, reason);
    this.#metrics.approvals.inc({ service: lookup.approval.gateInput.service, outcome: outcome.status });
    return outcome;
  }

  async cancel(incidentId: string, operator: Operator, reason: string): Promise<CancelOutcome> {
    requireApprover(operator);
    const report = await this.#incidents.get(incidentId);
    if (!report) return { status: 'not_found' };
    if (report.resolution) return { status: 'not_cancellable', reason: 'O incidente já tem decisão humana.' };
    if (report.outcome !== 'awaiting_approval' || !report.approvalId) {
      return { status: 'not_cancellable', reason: 'Só incidentes aguardando aprovação podem ser cancelados.' };
    }
    // O pedido sai da fila: depois do cancelamento ninguém consegue aprovar a ação. Se outra pessoa
    // já o retirou, a decisão dela vence.
    const taken = await this.#approvals.take(report.approvalId);
    if (taken.status === 'not_found') return { status: 'not_cancellable', reason: 'O pedido de aprovação já foi decidido.' };
    await this.#audit.append({
      incidentId,
      event: 'incident_cancelled',
      actor: actorOf(operator),
      details: { approvalId: report.approvalId, reason, via: operator.via },
    });
    await this.#incidents.save({ ...report, resolution: this.#resolution('cancelled', operator, reason, null) });
    this.#metrics.approvals.inc({ service: report.service, outcome: 'cancelled' });
    return { status: 'cancelled' };
  }

  async #resolveFound(
    approval: PendingApproval,
    operator: Operator,
    approve: boolean,
    reason: string | null,
  ): Promise<ApprovalOutcome> {
    const actor = actorOf(operator);
    const { incidentId } = approval;

    if (!approve) {
      await this.#audit.append({
        incidentId,
        event: 'approval_rejected',
        actor,
        details: { approvalId: approval.id, reason, via: operator.via },
      });
      await this.#record(incidentId, this.#resolution('rejected', operator, reason, null));
      return { status: 'rejected' };
    }

    const decision = this.#gate.authorizeApproved(approval.gateInput);
    if (decision.verdict === 'blocked' || !decision.action) {
      await this.#audit.append({
        incidentId,
        event: 'approval_rejected',
        actor: 'copilot',
        details: { approvalId: approval.id, approver: operator.email, reasons: decision.reasons },
      });
      await this.#record(incidentId, this.#resolution('blocked', operator, decision.reasons.join(' '), null));
      return { status: 'blocked', decision };
    }

    await this.#audit.append({
      incidentId,
      event: 'approval_granted',
      actor,
      details: { approvalId: approval.id, reason, via: operator.via },
    });
    const action = decision.action;
    const execution: ExecutionResult = await this.#executor
      .execute(action, { incidentId, service: approval.gateInput.service, authorizedBy: actor })
      .catch((error: unknown) => ({ status: 'failed', actionId: action.id, detail: (error as Error).message }));
    await this.#audit.append({
      incidentId,
      event: execution.status === 'failed' ? 'action_failed' : 'action_executed',
      actor,
      details: { ...execution, mode: this.#executor.mode },
    });
    await this.#record(incidentId, this.#resolution('approved', operator, reason, execution));
    return { status: 'executed', execution };
  }

  #resolution(kind: Resolution['kind'], operator: Operator, reason: string | null, execution: ExecutionResult | null): Resolution {
    return { kind, by: operator.email, reason, at: this.#now().toISOString(), execution };
  }

  async #record(incidentId: string, resolution: Resolution): Promise<void> {
    const report = await this.#incidents.get(incidentId);
    if (report) await this.#incidents.save({ ...report, resolution });
  }
}

const actorOf = (operator: Operator) => `human:${operator.email}`;
