// Projeções somente leitura que o painel consome: política, catálogo, playbooks e orçamento.
// Funções puras sobre os objetos já carregados; nenhuma decisão do gate passa por aqui.
import { z } from 'zod';
import { ACTION_CATALOG } from '../autonomy/catalog.js';
import type { ActionBudget } from '../autonomy/budget.js';
import { resolveServicePolicy, type AutonomyPolicy } from '../autonomy/policy.js';
import type { IncidentReport } from '../incident/investigator.js';
import type { PlaybookRegistry } from '../playbooks/registry.js';

export interface SourceInfo {
  readonly file: string;
  readonly commit: string;
}

export function policyView(policy: AutonomyPolicy, source: SourceInfo) {
  return {
    source,
    killSwitch: policy.killSwitch,
    defaults: policy.defaults,
    services: Object.entries(policy.services).map(([name, service]) => ({
      name,
      level: service.level,
      allowedActions: service.allowedActions,
      budget: service.budget ?? policy.defaults.budget,
    })),
    actions: Object.values(ACTION_CATALOG).map((action) => ({
      id: action.id,
      description: action.description,
      reversible: action.reversible,
      maxAutonomy: action.maxAutonomy,
      // Os limites de parâmetros (min, max, enum) vêm do próprio schema que o gate usa.
      params: z.toJSONSchema(action.params, { io: 'input' }),
    })),
  };
}

export function playbooksView(registry: PlaybookRegistry, source: SourceInfo) {
  return { source, playbooks: registry.all };
}

export async function budgetView(policy: AutonomyPolicy, budget: ActionBudget, recent: readonly IncidentReport[]) {
  const services = await Promise.all(
    Object.keys(policy.services).map(async (name) => {
      const resolved = resolveServicePolicy(policy, name);
      const { windowMs, maxAutoActions } = resolved.budget;
      const remaining = await budget.remaining(name, windowMs, maxAutoActions).catch(() => null);
      return { name, level: resolved.level, windowMs, maxAutoActions, remaining };
    }),
  );
  const llm = recent.reduce(
    (total, report) => ({
      incidents: total.incidents + 1,
      inputTokens: total.inputTokens + report.llmUsage.inputTokens,
      outputTokens: total.outputTokens + report.llmUsage.outputTokens,
      costUsd: report.llmUsage.costUsd === null ? total.costUsd : (total.costUsd ?? 0) + report.llmUsage.costUsd,
    }),
    { incidents: 0, inputTokens: 0, outputTokens: 0, costUsd: null as number | null },
  );
  return { killSwitch: policy.killSwitch, services, llm };
}
