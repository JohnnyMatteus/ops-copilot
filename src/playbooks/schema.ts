// Schema dos playbooks versionados em YAML (ADR 0003). O playbook diz O QUE investigar e QUAIS ações
// fazem sentido; se a ação pode rodar sozinha é decisão da política de autonomia, não do playbook.
import { z } from 'zod';
import { ActionIdSchema, INVERSE_ACTION_IDS } from '../autonomy/catalog.js';
import { AutonomyLevelSchema } from '../autonomy/levels.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'use letras minúsculas, dígitos, "-" ou "_"');
const duration = z.string().regex(/^\d+(s|m|h)$/, 'duração no formato 30s, 15m ou 1h');

/** Placeholders aceitos nas consultas: só rótulos do alerta, nunca texto livre. */
export const TEMPLATE_PLACEHOLDER = /\{\{\s*([a-z_][a-z0-9_]*)\s*\}\}/g;

export const MetricSignalSpecSchema = z.strictObject({
  name: slug,
  description: z.string().min(1),
  query: z.string().min(1),
  kind: z.enum(['instant', 'range']).default('instant'),
  window: duration.default('30m'),
  step: duration.default('60s'),
});
export type MetricSignalSpec = z.infer<typeof MetricSignalSpecSchema>;

export const TraceSignalSpecSchema = z.strictObject({
  name: slug,
  description: z.string().min(1),
  service: z.string().min(1),
  operation: z.string().min(1).optional(),
  minDurationMs: z.number().int().positive().optional(),
  lookback: duration.default('30m'),
  limit: z.number().int().min(1).max(50).default(20),
});
export type TraceSignalSpec = z.infer<typeof TraceSignalSpecSchema>;

export const HypothesisSchema = z.strictObject({
  id: slug,
  description: z.string().min(1),
});

export const PlaybookActionSchema = z.strictObject({
  action: ActionIdSchema.refine((id) => !INVERSE_ACTION_IDS.has(id), 'ação inversa não pode constar em playbook'),
  /** Hipóteses para as quais a ação faz sentido. O gate bloqueia a ação para outras hipóteses. */
  when: z.array(slug).min(1),
  /** Parâmetros fixos do playbook; o LLM não pode sobrescrevê-los. */
  params: z.record(z.string(), z.unknown()).default({}),
  rationale: z.string().min(1),
});
export type PlaybookAction = z.infer<typeof PlaybookActionSchema>;

export const PlaybookSchema = z
  .strictObject({
    apiVersion: z.literal('ops-copilot/v1'),
    kind: z.literal('Playbook'),
    metadata: z.strictObject({
      id: slug,
      version: z.string().regex(/^\d+\.\d+\.\d+$/, 'versão semântica (1.2.0)'),
      owner: z.string().min(1),
      description: z.string().min(1),
    }),
    match: z.strictObject({
      alertname: z.string().min(1),
      service: z.string().min(1),
    }),
    signals: z.strictObject({
      metrics: z.array(MetricSignalSpecSchema).default([]),
      traces: z.array(TraceSignalSpecSchema).default([]),
    }),
    diagnosis: z.strictObject({
      guidance: z.string().min(1),
      hypotheses: z.array(HypothesisSchema).min(2),
    }),
    actions: z.array(PlaybookActionSchema).min(1),
    autonomy: z.strictObject({
      /** Teto do playbook. O nível efetivo ainda passa pela política e pelo catálogo. */
      maxLevel: AutonomyLevelSchema,
      minConfidenceForAuto: z.number().min(0).max(1),
    }),
  })
  .superRefine((playbook, ctx) => {
    const signalNames = [...playbook.signals.metrics, ...playbook.signals.traces].map((s) => s.name);
    if (signalNames.length === 0) {
      ctx.addIssue({ code: 'custom', path: ['signals'], message: 'o playbook precisa de ao menos um sinal' });
    }
    for (const name of duplicates(signalNames)) {
      ctx.addIssue({ code: 'custom', path: ['signals'], message: `sinal duplicado: ${name}` });
    }
    const hypothesisIds = playbook.diagnosis.hypotheses.map((h) => h.id);
    for (const id of duplicates(hypothesisIds)) {
      ctx.addIssue({ code: 'custom', path: ['diagnosis', 'hypotheses'], message: `hipótese duplicada: ${id}` });
    }
    for (const id of duplicates(playbook.actions.map((a) => a.action))) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: `ação duplicada: ${id}` });
    }
    playbook.actions.forEach((action, index) => {
      for (const hypothesis of action.when) {
        if (!hypothesisIds.includes(hypothesis)) {
          ctx.addIssue({
            code: 'custom',
            path: ['actions', index, 'when'],
            message: `hipótese desconhecida: ${hypothesis}`,
          });
        }
      }
    });
  });
export type Playbook = z.infer<typeof PlaybookSchema>;

function duplicates(values: readonly string[]): string[] {
  return [...new Set(values.filter((value, index) => values.indexOf(value) !== index))];
}
