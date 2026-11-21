// Fluxo de aprovação humana: reavalia no gate, executa e audita. Quem aprova é sempre uma pessoa.
import type { AuditLog } from '../autonomy/audit.js';
import type { AutonomyGate, Decision } from '../autonomy/gate.js';
import type { ActionExecutor, ExecutionResult } from '../executor/executor.js';
import type { ApprovalQueue } from './approvals.js';

export type ApprovalOutcome =
  | { readonly status: 'executed'; readonly execution: ExecutionResult }
  | { readonly status: 'blocked'; readonly decision: Decision }
  | { readonly status: 'rejected' }
  | { readonly status: 'not_found' | 'expired' };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class ApprovalService {
  readonly #approvals: ApprovalQueue;
  readonly #gate: AutonomyGate;
  readonly #executor: ActionExecutor;
  readonly #audit: AuditLog;

  constructor(deps: { approvals: ApprovalQueue; gate: AutonomyGate; executor: ActionExecutor; audit: AuditLog }) {
    this.#approvals = deps.approvals;
    this.#gate = deps.gate;
    this.#executor = deps.executor;
    this.#audit = deps.audit;
  }

  async resolve(approvalId: string, approver: string, approve: boolean): Promise<ApprovalOutcome> {
    if (!EMAIL.test(approver)) throw new Error('Aprovador precisa ser identificado por e-mail.');
    const lookup = await this.#approvals.take(approvalId);
    if (lookup.status !== 'found') return { status: lookup.status };
    const { approval } = lookup;
    const actor = `human:${approver}`;

    if (!approve) {
      await this.#audit.append({ incidentId: approval.incidentId, event: 'approval_rejected', actor, details: { approvalId } });
      return { status: 'rejected' };
    }

    const decision = this.#gate.authorizeApproved(approval.gateInput);
    if (decision.verdict === 'blocked' || !decision.action) {
      await this.#audit.append({
        incidentId: approval.incidentId,
        event: 'approval_rejected',
        actor: 'copilot',
        details: { approvalId, approver, reasons: decision.reasons },
      });
      return { status: 'blocked', decision };
    }

    await this.#audit.append({ incidentId: approval.incidentId, event: 'approval_granted', actor, details: { approvalId } });
    const action = decision.action;
    const execution: ExecutionResult = await this.#executor
      .execute(action, { incidentId: approval.incidentId, service: approval.gateInput.service, authorizedBy: actor })
      .catch((error: unknown) => ({ status: 'failed', actionId: action.id, detail: (error as Error).message }));
    await this.#audit.append({
      incidentId: approval.incidentId,
      event: execution.status === 'failed' ? 'action_failed' : 'action_executed',
      actor,
      details: { ...execution, mode: this.#executor.mode },
    });
    return { status: 'executed', execution };
  }
}
