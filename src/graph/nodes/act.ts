// Etapa 5: cumpre o veredito. Só "auto_execute" chega ao executor sem humano;
// "needs_approval" vira pedido com prazo; "suggest" e "blocked" só ficam registrados.
import type { ExecutionResult } from '../../executor/executor.js';
import type { InvestigationDeps } from '../deps.js';
import type { InvestigationStateType, InvestigationUpdate } from '../state.js';

/** Marca o `failure` de quem perdeu a reserva de efeito: outro processo já agiu neste incidente. */
export const EFFECT_ALREADY_RESERVED = 'Efeito deste incidente já reservado por outra execução; esta não repete.';

export function createActNode(deps: InvestigationDeps) {
  return async (state: InvestigationStateType): Promise<InvestigationUpdate> => {
    const { alert, playbook, diagnosis, decision, incidentId } = state;
    if (!playbook || !diagnosis?.proposedAction || !decision) throw new Error('act: estado incompleto.');

    // Última barreira: só um processo por incidente chega ao efeito (executar ou abrir o pedido).
    // Falha da reserva (Redis fora) vale como negada: na dúvida, não age.
    const reserveEffect = async (): Promise<boolean> => {
      if (!deps.effects) throw new Error('act: sem reserva de efeito.');
      return deps.effects.reserve(incidentId).catch(() => false);
    };

    switch (decision.verdict) {
      case 'blocked':
        return { outcome: 'blocked' };
      case 'suggest':
        return { outcome: 'suggested' };
      case 'needs_approval': {
        if (!(await reserveEffect())) return { outcome: 'interrupted', failure: EFFECT_ALREADY_RESERVED };
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
        return { outcome: 'awaiting_approval',
          approvalId: approval.id,
          approvalExpiresAt: new Date(approval.expiresAt).toISOString(),
        };
      }
      case 'auto_execute': {
        if (!decision.action) throw new Error('act: veredito automático sem ação.');
        if (!(await reserveEffect())) return { outcome: 'interrupted', failure: EFFECT_ALREADY_RESERVED };
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
