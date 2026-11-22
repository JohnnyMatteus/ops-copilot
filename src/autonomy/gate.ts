// Gate de autonomia: código determinístico entre a proposta do LLM e o executor (ADR 0002).
// Nenhuma regra daqui depende do prompt; o LLM só propõe, quem decide é este módulo.
import { z } from 'zod';
import type { Playbook } from '../playbooks/schema.js';
import type { ActionBudget } from './budget.js';
import { findAction, INVERSE_ACTION_IDS } from './catalog.js';
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

/** Uma checagem do gate, passada ou falhada: é o que o painel mostra como ✓/✕ na etapa decide. */
export const GateCheckSchema = z.object({
  check: z.string(),
  passed: z.boolean(),
  detail: z.string(),
});
export type GateCheck = z.infer<typeof GateCheckSchema>;

export const DecisionSchema = z.object({
  verdict: VerdictSchema,
  effectiveLevel: z.enum(['read_only', 'suggest', 'execute_with_approval', 'auto_execute']).nullable(),
  /** Ação com parâmetros finais (já mesclados e validados). `null` quando bloqueada antes da validação. */
  action: ApprovedActionSchema.nullable(),
  reasons: z.array(z.string()).min(1),
  checks: z.array(GateCheckSchema).default([]),
});
export type Decision = z.infer<typeof DecisionSchema>;

export interface GateInput {
  readonly service: string;
  readonly playbook: Playbook;
  readonly hypothesisId: string;
  readonly confidence: number;
  readonly proposal: { readonly actionId: string; readonly params: Readonly<Record<string, unknown>> };
}

/**
 * Avaliação pura. `budgetRemaining` é o saldo de ações automáticas do serviço na janela atual.
 * A ordem das regras importa: identidade da ação, permissão, contexto, parâmetros, nível.
 */
export function evaluate(input: GateInput, service: ResolvedServicePolicy, budgetRemaining: number): Decision {
  const { proposal, playbook } = input;
  const checks: GateCheck[] = [];
  const record = (check: string, passed: boolean, detail: string) => checks.push({ check, passed, detail });
  const blocked = (reason: string, action: ApprovedAction | null = null, level: AutonomyLevel | null = null): Decision => ({
    verdict: 'blocked',
    effectiveLevel: level,
    action,
    reasons: [reason],
    checks,
  });

  const definition = findAction(proposal.actionId);
  if (!definition) {
    record('catalogo', false, `${proposal.actionId} não existe no catálogo`);
    return blocked(`Ação desconhecida: ${proposal.actionId}.`);
  }
  record('catalogo', true, `${definition.id} conhecida`);

  // A origem da proposta é definida aqui, por código: `evaluate` só trata propostas do diagnóstico, e
  // inversas só existem no caminho do rollback (evaluateRollback), nunca por campo vindo do LLM.
  if (INVERSE_ACTION_IDS.has(definition.id)) {
    record('origem', false, `${definition.id} é ação inversa: só o rollback a executa`);
    return blocked(`Ação ${definition.id} só pode vir de um rollback, nunca de uma proposta do diagnóstico.`);
  }

  if (!service.allowedActions.has(definition.id)) {
    record('allowlist', false, `${definition.id} fora da allowlist de ${input.service}`);
    return blocked(`Ação ${definition.id} fora da allowlist do serviço ${input.service}.`);
  }
  record('allowlist', true, `${definition.id} permitida em ${input.service}`);

  const playbookAction = playbook.actions.find((candidate) => candidate.action === definition.id);
  if (!playbookAction) {
    record('playbook', false, `${playbook.metadata.id} não prevê ${definition.id}`);
    return blocked(`Ação ${definition.id} não está prevista no playbook ${playbook.metadata.id}.`);
  }
  record('playbook', true, `prevista em ${playbook.metadata.id}@${playbook.metadata.version}`);
  if (!playbookAction.when.includes(input.hypothesisId)) {
    record('hipotese', false, `${definition.id} não se aplica a ${input.hypothesisId}`);
    return blocked(`Ação ${definition.id} não se aplica à hipótese ${input.hypothesisId} no playbook.`);
  }
  record('hipotese', true, `${input.hypothesisId} autoriza ${definition.id}`);

  // Parâmetros fixados no playbook prevalecem sobre os propostos pelo LLM.
  const parsed = definition.params.safeParse({ ...proposal.params, ...playbookAction.params });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    record('parametros', false, detail);
    return blocked(`Parâmetros inválidos para ${definition.id}: ${detail}.`);
  }
  record('parametros', true, 'dentro dos limites do catálogo');
  const action: ApprovedAction = { id: definition.id, params: parsed.data, reversible: definition.reversible };

  const reasons: string[] = [];
  const ceilings: AutonomyLevel[] = [playbook.autonomy.maxLevel, definition.maxAutonomy];
  if (service.killSwitch) {
    ceilings.push('suggest');
    reasons.push('Kill switch ligado: execução desativada.');
    record('kill_switch', false, 'ligado: no máximo sugerir');
  } else {
    record('kill_switch', true, 'desligado');
  }
  const level = mostRestrictive(service.level, ...ceilings);
  record(
    'nivel',
    level !== 'read_only',
    `mais restritivo entre serviço (${service.level}), playbook (${playbook.autonomy.maxLevel}) e ação (${definition.maxAutonomy}): ${level}`,
  );

  switch (level) {
    case 'read_only':
      return blocked(`Serviço ${input.service} em modo somente leitura.`, action, level);
    case 'suggest':
      return { verdict: 'suggest', effectiveLevel: level, action, reasons: [...reasons, 'Nível efetivo: sugerir.'], checks };
    case 'execute_with_approval':
      return {
        verdict: 'needs_approval',
        effectiveLevel: level,
        action,
        reasons: [...reasons, 'Nível efetivo: executar com aprovação humana.'],
        checks,
      };
    case 'auto_execute': {
      record('reversivel', definition.reversible, definition.reversible ? 'existe ação inversa' : 'sem ação inversa');
      if (!definition.reversible) reasons.push(`Ação ${definition.id} não é reversível.`);
      const minConfidence = playbook.autonomy.minConfidenceForAuto;
      const confident = input.confidence >= minConfidence;
      record('confianca', confident, `${input.confidence.toFixed(2)} (mínimo ${minConfidence.toFixed(2)})`);
      if (!confident) {
        reasons.push(`Confiança ${input.confidence.toFixed(2)} abaixo do mínimo ${minConfidence.toFixed(2)}.`);
      }
      const hasBudget = budgetRemaining > 0;
      record('orcamento', hasBudget, hasBudget ? `saldo ${formatBudget(budgetRemaining)}` : 'esgotado na janela');
      if (!hasBudget) reasons.push(`Orçamento de ações automáticas esgotado para ${input.service}.`);
      if (reasons.length > 0) {
        return { verdict: 'needs_approval', effectiveLevel: 'execute_with_approval', action, reasons, checks };
      }
      return { verdict: 'auto_execute', effectiveLevel: level, action, reasons: ['Dentro de todos os limites.'], checks };
    }
  }
}

const formatBudget = (remaining: number) => (Number.isFinite(remaining) ? String(remaining) : 'não se aplica (aprovação humana)');

const unavailableBudget: GateCheck = { check: 'orcamento', passed: false, detail: 'indisponível: falha fechada' };

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
      return {
        ...decision,
        reasons: [...decision.reasons, 'Orçamento indisponível: exige aprovação.'],
        checks: [...decision.checks.filter((check) => check.check !== 'orcamento'), unavailableBudget],
      };
    }
    if (decision.verdict !== 'auto_execute') return decision;
    const consumed = await this.#budget.tryConsume(input.service, windowMs, maxAutoActions).catch(() => false);
    if (!consumed) {
      return {
        ...decision,
        verdict: 'needs_approval',
        effectiveLevel: 'execute_with_approval',
        reasons: ['Orçamento esgotado.'],
        checks: [...decision.checks, { check: 'orcamento', passed: false, detail: 'consumo atômico recusado' }],
      };
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

  /** Política resolvida de um serviço, para leitura no painel. */
  servicePolicy(service: string): ResolvedServicePolicy {
    return resolveServicePolicy(this.#policy, service);
  }
}
