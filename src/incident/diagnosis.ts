// Contrato da saída do LLM no diagnóstico. O schema é montado por playbook: hipóteses, sinais e
// ações válidas são enums fechados, então uma resposta fora do playbook falha na validação.
import { z } from 'zod';
import type { Playbook } from '../playbooks/schema.js';

export function diagnosisSchemaFor(playbook: Playbook, availableSignals: readonly string[]) {
  const hypotheses = playbook.diagnosis.hypotheses.map((h) => h.id);
  const actions = playbook.actions.map((a) => a.action);
  return z.strictObject({
    hypothesisId: z.enum(hypotheses as [string, ...string[]]),
    confidence: z.number().min(0).max(1),
    summary: z.string().min(10).max(800),
    // Só sinais efetivamente coletados podem ser citados como evidência.
    evidence: z
      .array(
        z.strictObject({
          signal: z.enum(availableSignals as [string, ...string[]]),
          observation: z.string().min(1).max(300),
        }),
      )
      .min(1)
      .max(8),
    proposedAction: z
      .strictObject({
        actionId: z.enum(actions as [string, ...string[]]),
        params: z.record(z.string(), z.unknown()).default({}),
        rationale: z.string().min(1).max(400),
      })
      .nullable(),
  });
}

export const DiagnosisSchema = z.object({
  hypothesisId: z.string(),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  evidence: z.array(z.object({ signal: z.string(), observation: z.string() })),
  proposedAction: z
    .object({ actionId: z.string(), params: z.record(z.string(), z.unknown()), rationale: z.string() })
    .nullable(),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;
