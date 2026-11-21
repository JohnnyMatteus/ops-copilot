// Etapa 4: o gate determinístico decide o destino da ação proposta. Nada de LLM aqui.
import type { InvestigationDeps } from '../deps.js';
import type { InvestigationStateType, InvestigationUpdate } from '../state.js';

export function createDecideNode(deps: InvestigationDeps) {
  return async (state: InvestigationStateType): Promise<InvestigationUpdate> => {
    const { alert, playbook, diagnosis, incidentId } = state;
    if (!playbook || !diagnosis) throw new Error('decide: estado sem playbook ou diagnóstico.');
    if (!diagnosis.proposedAction) return { outcome: 'no_action' };

    const decision = deps.gate.decide({
      service: alert.service,
      playbook,
      hypothesisId: diagnosis.hypothesisId,
      confidence: diagnosis.confidence,
      proposal: { actionId: diagnosis.proposedAction.actionId, params: diagnosis.proposedAction.params },
    });
    deps.metrics.decisions.inc({
      service: alert.service,
      action: diagnosis.proposedAction.actionId,
      verdict: decision.verdict,
    });
    await deps.audit.append({
      incidentId,
      event: 'decision_made',
      actor: 'copilot',
      details: {
        action: diagnosis.proposedAction.actionId,
        verdict: decision.verdict,
        effectiveLevel: decision.effectiveLevel,
        reasons: decision.reasons,
      },
    });
    return { decision };
  };
}
