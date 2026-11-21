// Catálogo de ações que o copiloto conhece. Fonte única de: parâmetros válidos (com limites),
// reversibilidade e teto de autonomia de cada ação. Uma ação fora daqui não existe para o gate.
import { z } from 'zod';
import type { AutonomyLevel } from './levels.js';

const k8sName = z.string().regex(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/, 'nome Kubernetes inválido');

export interface ActionDefinition {
  readonly id: string;
  readonly description: string;
  /** Reversível = existe ação inversa que restaura o estado anterior sem perda de dados. */
  readonly reversible: boolean;
  /** Teto de autonomia da ação, independentemente da política do serviço. */
  readonly maxAutonomy: AutonomyLevel;
  readonly params: z.ZodType<Record<string, unknown>>;
}

export const ACTION_CATALOG = {
  notify_oncall: {
    id: 'notify_oncall',
    description: 'Envia o diagnóstico para o canal do plantão.',
    reversible: true,
    maxAutonomy: 'auto_execute',
    params: z.strictObject({ channel: z.string().regex(/^#[a-z0-9-]{1,80}$/) }),
  },
  scale_deployment: {
    id: 'scale_deployment',
    description: 'Aumenta réplicas de um deployment, com teto absoluto.',
    reversible: true,
    maxAutonomy: 'auto_execute',
    params: z
      .strictObject({
        deployment: k8sName,
        replicasDelta: z.number().int().min(1).max(2),
        maxReplicas: z.number().int().min(1).max(12),
      }),
  },
  toggle_feature_flag: {
    id: 'toggle_feature_flag',
    description: 'Desliga uma funcionalidade degradável (a ação inversa religa).',
    reversible: true,
    maxAutonomy: 'auto_execute',
    params: z.strictObject({
      flag: z.string().regex(/^[a-z0-9_.-]{1,64}$/),
      enabled: z.literal(false),
    }),
  },
  replay_dlq_batch: {
    id: 'replay_dlq_batch',
    description: 'Reprocessa um lote limitado de mensagens da DLQ.',
    // Reprocessar tem efeito colateral (cobranças, e-mails): não há como "desfazer".
    reversible: false,
    maxAutonomy: 'execute_with_approval',
    params: z.strictObject({
      queue: z.string().regex(/^[a-z0-9_.-]{1,128}$/),
      maxMessages: z.number().int().min(1).max(500),
    }),
  },
  restart_pods: {
    id: 'restart_pods',
    description: 'Reinicia os pods de um deployment (rollout restart).',
    reversible: false,
    maxAutonomy: 'execute_with_approval',
    params: z.strictObject({ deployment: k8sName }),
  },
  reset_consumer_offsets: {
    id: 'reset_consumer_offsets',
    description: 'Move offsets de um consumer group. Pode pular ou duplicar mensagens.',
    reversible: false,
    // Conhecida para ser reconhecida e bloqueada com motivo claro; nunca sai de "sugerir".
    maxAutonomy: 'suggest',
    params: z.strictObject({
      consumerGroup: z.string().min(1),
      topic: z.string().min(1),
      to: z.enum(['latest', 'earliest']),
    }),
  },
} as const satisfies Record<string, ActionDefinition>;

export type ActionId = keyof typeof ACTION_CATALOG;

export const ActionIdSchema = z.enum(Object.keys(ACTION_CATALOG) as [ActionId, ...ActionId[]]);

export function findAction(id: string): ActionDefinition | undefined {
  return Object.hasOwn(ACTION_CATALOG, id) ? ACTION_CATALOG[id as ActionId] : undefined;
}
