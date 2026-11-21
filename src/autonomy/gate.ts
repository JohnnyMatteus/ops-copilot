// Gate de autonomia: código determinístico entre a proposta do LLM e o executor (ADR 0002).
// Nenhuma regra daqui depende do prompt; o LLM só propõe, quem decide é este módulo.
import { z } from 'zod';
import type { Playbook } from '../playbooks/schema.js';
import type { ActionBudget } from './budget.js';
import { findAction } from './catalog.js';
import { mostRestrictive, type AutonomyLevel } from './levels.js';
import { resolveServicePolicy, type AutonomyPolicy, type ResolvedServicePolicy } from './policy.js';

export const VerdictSchema = z.enum(['blocked', 'suggest', 'needs_approval', 'auto_execute']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const ApprovedActionSchema = z.object({
  id: z.string(),
  params: z.record(z.string(), z.unknown()),
  reversible: z.boolean(),
});
export type ApprovedAction = z.infer<typeof ApprovedActionSchema>;

export const DecisionSchema = z.object({
  verdict: VerdictSchema,
  effectiveLevel: z.enum(['read_only', 'suggest', 'execute_with_approval', 'auto_execute']).nullable(),
  /** Ação com parâmetros finais (já mesclados e validados). `null` quando bloqueada antes da validação. */
  action: ApprovedActionSchema.nullable(),
  reasons: z.array(z.string()).min(1),
});
export type Decision = z.infer<typeof DecisionSchema>;

export interface GateInput {
  readonly service: string;
  readonly playbook: Playbook;
  readonly hypothesisId: string;
  readonly confidence: number;
  readonly proposal: { readonly actionId: string; readonly params: Readonly<Record<string, unknown>> };
}

const blocked = (reason: string, action: ApprovedAction | null = null, level: AutonomyLevel | null = null): Decision => ({
  verdict: 'blocked',
  effectiveLevel: level,
  action,
  reasons: [reason],
});

/**
 * Avaliação pura. `budgetRemaining` é o saldo de ações automáticas do serviço na janela atual.
 * A ordem das regras importa: identidade da ação, permissão, contexto, parâmetros, nível.
 */
export function evaluate(input: GateInput, service: ResolvedServicePolicy, budgetRemaining: number): Decision {
  const { proposal, playbook } = input;
  const definition = findAction(proposal.actionId);
  if (!definition) return blocked(`Ação desconhecida: ${proposal.actionId}.`);

  if (!service.allowedActions.has(definition.id)) {
    return blocked(`Ação ${definition.id} fora da allowlist do serviço ${input.service}.`);
  }
  const playbookAction = playbook.actions.find((candidate) => candidate.action === definition.id);
  if (!playbookAction) {
    return blocked(`Ação ${definition.id} não está prevista no playbook ${playbook.metadata.id}.`);
  }
  if (!playbookAction.when.includes(input.hypothesisId)) {
    return blocked(`Ação ${definition.id} não se aplica à hipótese ${input.hypothesisId} no playbook.`);
  }

  // Parâmetros fixados no playbook prevalecem sobre os propostos pelo LLM.
  const parsed = definition.params.safeParse({ ...proposal.params, ...playbookAction.params });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    return blocked(`Parâmetros inválidos para ${definition.id}: ${detail}.`);
  }
  const action: ApprovedAction = { id: definition.id, params: parsed.data, reversible: definition.reversible };

  const reasons: string[] = [];
  const ceilings: AutonomyLevel[] = [playbook.autonomy.maxLevel, definition.maxAutonomy];
  if (service.killSwitch) {
    ceilings.push('suggest');
    reasons.push('Kill switch ligado: execução desativada.');
  }
  const level = mostRestrictive(service.level, ...ceilings);

  switch (level) {
    case 'read_only':
      return blocked(`Serviço ${input.service} em modo somente leitura.`, action, level);
    case 'suggest':
      return { verdict: 'suggest', effectiveLevel: level, action, reasons: [...reasons, 'Nível efetivo: sugerir.'] };
    case 'execute_with_approval':
      return {
        verdict: 'needs_approval',
        effectiveLevel: level,
        action,
        reasons: [...reasons, 'Nível efetivo: executar com aprovação humana.'],
      };
    case 'auto_execute': {
      if (!definition.reversible) reasons.push(`Ação ${definition.id} não é reversível.`);
      if (input.confidence < playbook.autonomy.minConfidenceForAuto) {
        reasons.push(
          `Confiança ${input.confidence.toFixed(2)} abaixo do mínimo ${playbook.autonomy.minConfidenceForAuto.toFixed(2)}.`,
        );
      }
      if (budgetRemaining <= 0) reasons.push(`Orçamento de ações automáticas esgotado para ${input.service}.`);
      if (reasons.length > 0) {
        return { verdict: 'needs_approval', effectiveLevel: 'execute_with_approval', action, reasons };
      }
      return { verdict: 'auto_execute', effectiveLevel: level, action, reasons: ['Dentro de todos os limites.'] };
    }
  }
}

export class AutonomyGate {
  readonly #policy: AutonomyPolicy;
  readonly #budget: ActionBudget;

  constructor(policy: AutonomyPolicy, budget: ActionBudget) {
    this.#policy = policy;
    this.#budget = budget;
  }

  /**
   * Decide e, se a execução for automática, consome o orçamento numa operação atômica.
   * Orçamento indisponível (Redis fora) falha fechado: a ação passa a exigir aprovação humana.
   */
  async decide(input: GateInput): Promise<Decision> {
    const service = resolveServicePolicy(this.#policy, input.service);
    const { windowMs, maxAutoActions } = service.budget;
    const remaining = await this.#budget.remaining(input.service, windowMs, maxAutoActions).catch(() => null);
    const decision = evaluate(input, service, remaining ?? 0);
    if (remaining === null && decision.verdict === 'needs_approval') {
      return { ...decision, reasons: [...decision.reasons, 'Orçamento indisponível: exige aprovação.'] };
    }
    if (decision.verdict !== 'auto_execute') return decision;
    const consumed = await this.#budget.tryConsume(input.service, windowMs, maxAutoActions).catch(() => false);
    if (!consumed) {
      return { ...decision, verdict: 'needs_approval', effectiveLevel: 'execute_with_approval', reasons: ['Orçamento esgotado.'] };
    }
    return decision;
  }

  /**
   * Reavalia no momento da aprovação: a política pode ter mudado (kill switch, allowlist) desde a
   * proposta. Aprovação humana não consome o orçamento automático, mas nunca contorna um bloqueio.
   */
  authorizeApproved(input: GateInput): Decision {
    const service = resolveServicePolicy(this.#policy, input.service);
    const decision = evaluate(input, service, Number.POSITIVE_INFINITY);
    if (decision.verdict === 'needs_approval' || decision.verdict === 'auto_execute') return decision;
    return { ...decision, verdict: 'blocked', reasons: [...decision.reasons, 'Aprovação recusada pela política atual.'] };
  }
}
