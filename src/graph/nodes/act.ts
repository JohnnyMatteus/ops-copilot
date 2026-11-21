// Etapa 5: cumpre o veredito. Só "auto_execute" chega ao executor sem humano;
// "needs_approval" vira pedido com prazo; "suggest" e "blocked" só ficam registrados.
import type { ExecutionResult } from '../../executor/executor.js';
import type { InvestigationDeps } from '../deps.js';
import type { InvestigationStateType, InvestigationUpdate } from '../state.js';

export function createActNode(deps: InvestigationDeps) {
  return async (state: InvestigationStateType): Promise<InvestigationUpdate> => {
    const { alert, playbook, diagnosis, decision, incidentId } = state;
    if (!playbook || !diagnosis?.proposedAction || !decision) throw new Error('act: estado incompleto.');

    switch (decision.verdict) {
      case 'blocked':
        return { outcome: 'blocked' };
      case 'suggest':
        return { outcome: 'suggested' };
      case 'needs_approval': {
        const approval = await deps.approvals.request(incidentId, {
          service: alert.service,
          playbook,
          hypothesisId: diagnosis.hypothesisId,
          confidence: diagnosis.confidence,
          proposal: { actionId: diagnosis.proposedAction.actionId, params: diagnosis.proposedAction.params },
        });
        await deps.audit.append({
          incidentId,
          event: 'approval_requested',
          actor: 'copilot',
          details: { approvalId: approval.id, action: decision.action?.id, expiresAt: new Date(approval.expiresAt).toISOString() },
        });
        return { outcome: 'awaiting_approval', approvalId: approval.id };
      }
      case 'auto_execute': {
        if (!decision.action) throw new Error('act: veredito automático sem ação.');
        const action = decision.action;
        const execution: ExecutionResult = await deps.executor
          .execute(action, { incidentId, service: alert.service, authorizedBy: 'copilot' })
          .catch((error: unknown) => ({ status: 'failed', actionId: action.id, detail: (error as Error).message }));
        const failed = execution.status === 'failed';
        await deps.audit.append({
          incidentId,
          event: failed ? 'action_failed' : 'action_executed',
          actor: 'copilot',
          details: { ...execution, mode: deps.executor.mode },
        });
        return { execution, outcome: failed ? 'execution_failed' : 'auto_executed' };
      }
    }
  };
}
