// Etapa 1: casa o alerta com um playbook. Sem playbook não há investigação automática nem LLM.
import type { InvestigationDeps } from '../deps.js';
import type { InvestigationStateType, InvestigationUpdate } from '../state.js';

export function createTriageNode(deps: InvestigationDeps) {
  return async (state: InvestigationStateType): Promise<InvestigationUpdate> => {
    const { alert, incidentId } = state;
    await deps.audit.append({
      incidentId,
      event: 'alert_received',
      actor: 'copilot',
      details: {
        alertname: alert.alertname,
        service: alert.service,
        fingerprint: alert.fingerprint,
        predicted: alert.annotations['predicted'] === 'true',
      },
    });

    const playbook = deps.playbooks.match(alert);
    if (!playbook) {
      await deps.audit.append({ incidentId, event: 'playbook_missing', actor: 'copilot', details: {} });
      return { outcome: 'no_playbook' };
    }
    await deps.audit.append({
      incidentId,
      event: 'playbook_matched',
      actor: 'copilot',
      details: { playbookId: playbook.metadata.id, version: playbook.metadata.version },
    });
    return { playbook };
  };
}
