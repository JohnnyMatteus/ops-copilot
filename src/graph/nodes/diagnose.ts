// Etapa 3: diagnóstico com LLM. A resposta passa pelo schema do playbook com um retry;
// depois disso a falha é explícita e o incidente vai para humanos (ADR 0005).
import { diagnosisSchemaFor } from '../../incident/diagnosis.js';
import { buildDiagnosisMessages } from '../../incident/prompt.js';
import { LlmHttpError } from '../../llm/client.js';
import { CostCappedLlmClient, LlmCostCeilingError } from '../../llm/cost-cap.js';
import { addUsage, EMPTY_USAGE, generateStructured, LlmOutputValidationError } from '../../llm/structured.js';
import type { InvestigationDeps } from '../deps.js';
import type { InvestigationStateType, InvestigationUpdate } from '../state.js';

export function createDiagnoseNode(deps: InvestigationDeps) {
  return async (state: InvestigationStateType): Promise<InvestigationUpdate> => {
    const { alert, playbook, signals, incidentId } = state;
    if (!playbook) throw new Error('diagnose: estado sem playbook.');
    const available = signals.filter((signal) => signal.kind !== 'error').map((signal) => signal.name);

    let spent = EMPTY_USAGE;
    const client =
      deps.maxLlmCostUsdPerIncident === undefined ? deps.llm : new CostCappedLlmClient(deps.llm, deps.maxLlmCostUsdPerIncident);
    try {
      const { value, usage } = await generateStructured({
        client,
        onResponse: (response) => {
          spent = addUsage(spent, response);
        },
        model: deps.model,
        messages: buildDiagnosisMessages(alert, playbook, signals),
        schema: diagnosisSchemaFor(playbook, available),
      });
      deps.metrics.llmCalls.inc({ model: deps.model, result: 'valid' });
      if (usage.calls > 1) deps.metrics.llmCalls.inc({ model: deps.model, result: 'invalid' }, usage.calls - 1);
      await deps.audit.append({
        incidentId,
        event: 'diagnosis_completed',
        actor: 'copilot',
        details: {
          hypothesisId: value.hypothesisId,
          confidence: value.confidence,
          proposedAction: value.proposedAction?.actionId ?? null,
          llmCalls: usage.calls,
        },
      });
      return { diagnosis: value, llmUsage: usage };
    } catch (error) {
      if (error instanceof LlmOutputValidationError) {
        deps.metrics.llmCalls.inc({ model: deps.model, result: 'invalid' }, error.usage.calls);
        await deps.audit.append({
          incidentId,
          event: 'diagnosis_failed',
          actor: 'copilot',
          details: { reason: 'invalid_output', issues: error.issues },
        });
        return { outcome: 'diagnosis_failed', failure: error.message, llmUsage: error.usage };
      }
      if (error instanceof LlmCostCeilingError) {
        deps.metrics.llmCalls.inc({ model: deps.model, result: 'cost_ceiling' });
        await deps.audit.append({
          incidentId,
          event: 'diagnosis_failed',
          actor: 'copilot',
          details: { reason: 'cost_ceiling', message: error.message },
        });
        return { outcome: 'diagnosis_failed', failure: error.message, llmUsage: spent };
      }
      if (error instanceof LlmHttpError) {
        await deps.audit.append({
          incidentId,
          event: 'diagnosis_failed',
          actor: 'copilot',
          details: { reason: 'provider_error', status: error.status },
        });
        return { outcome: 'diagnosis_failed', failure: error.message };
      }
      throw error;
    }
  };
}
