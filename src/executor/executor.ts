// Executor de ações (ADR 0006). Só recebe ações que o gate já aprovou; dry-run por padrão.
import { z } from 'zod';
import type { ApprovedAction } from '../autonomy/gate.js';

export const ExecutionModeSchema = z.enum(['dry-run', 'live']);
export type ExecutionMode = z.infer<typeof ExecutionModeSchema>;

/** Ação inversa que desfaz o efeito; o rollback a reenvia ao gate, nunca a executa direto. */
export const UndoProposalSchema = z.object({
  actionId: z.string(),
  params: z.record(z.string(), z.unknown()),
});
export type UndoProposal = z.infer<typeof UndoProposalSchema>;

export const ExecutionResultSchema = z.object({
  status: z.enum(['dry_run', 'executed', 'failed']),
  actionId: z.string(),
  detail: z.string(),
  /** Presente só quando o executor mudou o estado e sabe como restaurá-lo. */
  undo: UndoProposalSchema.nullable().optional(),
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
