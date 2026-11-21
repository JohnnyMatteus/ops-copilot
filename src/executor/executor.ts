// Executor de ações (ADR 0006). Só recebe ações que o gate já aprovou; dry-run por padrão.
import { z } from 'zod';
import type { ApprovedAction } from '../autonomy/gate.js';

export const ExecutionModeSchema = z.enum(['dry-run', 'live']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

export const ExecutionResultSchema = z.object({
  status: z.enum(['dry_run', 'executed', 'failed']),
  actionId: z.string(),
  detail: z.string(),
});
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export interface ExecutionContext {
  readonly incidentId: string;
  readonly service: string;
  /** `copilot` em execução automática; `human:<e-mail>` quando veio de uma aprovação. */
  readonly authorizedBy: string;
}

export interface ActionExecutor {
  readonly mode: ExecutionMode;
  execute(action: ApprovedAction, context: ExecutionContext): Promise<ExecutionResult>;
}

/** Descreve o que seria feito, sem efeito colateral. É o executor de toda a fundação. */
export class DryRunExecutor implements ActionExecutor {
  readonly mode = 'dry-run' as const;

  async execute(action: ApprovedAction, context: ExecutionContext): Promise<ExecutionResult> {
    return {
      status: 'dry_run',
      actionId: action.id,
      detail: `[dry-run] ${action.id} em ${context.service} com ${JSON.stringify(action.params)} (autorizado por ${context.authorizedBy}).`,
    };
  }
}

export class ExecutorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecutorConfigError';
  }
}

/**
 * O modo live exige adaptadores reais (Kubernetes, feature flags, filas) que ficam para a próxima
 * fase. Pedir live hoje é erro explícito na subida, nunca uma degradação silenciosa para dry-run.
 */
export function createExecutor(mode: ExecutionMode): ActionExecutor {
  if (mode === 'live') {
    throw new ExecutorConfigError('EXECUTION_MODE=live ainda não tem adaptadores reais; use dry-run.');
  }
  return new DryRunExecutor();
}
