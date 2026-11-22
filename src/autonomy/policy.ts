// Política de autonomia por serviço, versionada em YAML e validada na subida (ADR 0002).
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { z } from 'zod';
import { durationToMs } from '../shared/duration.js';
import { ActionIdSchema, INVERSE_ACTION_IDS } from './catalog.js';
import { AutonomyLevelSchema, type AutonomyLevel } from './levels.js';

const BudgetSchema = z.strictObject({
  window: z.string().regex(/^\d+(s|m|h)$/),
  maxAutoActions: z.number().int().min(0),
});

const ServicePolicySchema = z.strictObject({
  level: AutonomyLevelSchema,
  allowedActions: z.array(ActionIdSchema.refine((id) => !INVERSE_ACTION_IDS.has(id), 'ação inversa não entra na allowlist; o rollback usa a da ação original')),
  budget: BudgetSchema.optional(),
});

export const AutonomyPolicySchema = z.strictObject({
  apiVersion: z.literal('ops-copilot/v1'),
  kind: z.literal('AutonomyPolicy'),
  /** Desliga qualquer execução: todo serviço passa a no máximo "sugerir". */
  killSwitch: z.boolean(),
  defaults: z.strictObject({
    level: AutonomyLevelSchema,
    budget: BudgetSchema,
  }),
  services: z.record(z.string().min(1), ServicePolicySchema),
});
export type AutonomyPolicy = z.infer<typeof AutonomyPolicySchema>;

export interface ResolvedServicePolicy {
  readonly level: AutonomyLevel;
  readonly allowedActions: ReadonlySet<string>;
  readonly budget: { readonly windowMs: number; readonly maxAutoActions: number };
  readonly killSwitch: boolean;
}

/** Serviço fora da política herda o nível padrão e uma allowlist vazia: nada executa. */
export function resolveServicePolicy(policy: AutonomyPolicy, service: string): ResolvedServicePolicy {
  const own = Object.hasOwn(policy.services, service) ? policy.services[service] : undefined;
  const budget = own?.budget ?? policy.defaults.budget;
  return {
    level: own?.level ?? policy.defaults.level,
    allowedActions: new Set(own?.allowedActions ?? []),
    budget: { windowMs: durationToMs(budget.window), maxAutoActions: budget.maxAutoActions },
    killSwitch: policy.killSwitch,
  };
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyValidationError';
  }
}

export async function loadAutonomyPolicy(path: string): Promise<AutonomyPolicy> {
  const result = AutonomyPolicySchema.safeParse(parse(await readFile(path, 'utf8')));
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(raiz)'}: ${issue.message}`);
    throw new PolicyValidationError(`${path}: política de autonomia inválida\n${issues.join('\n')}`);
  }
  return result.data;
}
