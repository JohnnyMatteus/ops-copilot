// Contrato da API do copiloto, validado na fronteira: resposta fora do formato vira erro explícito.
import { z } from 'zod';

export const VerdictSchema = z.enum(['auto_execute', 'needs_approval', 'suggest', 'blocked']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const LevelSchema = z.enum(['read_only', 'suggest', 'execute_with_approval', 'auto_execute']);
export type Level = z.infer<typeof LevelSchema>;

export const GateCheckSchema = z.object({ check: z.string(), passed: z.boolean(), detail: z.string() });
export type GateCheck = z.infer<typeof GateCheckSchema>;

const ParamsSchema = z.record(z.string(), z.unknown());

export const DecisionSchema = z.object({
  verdict: VerdictSchema,
  effectiveLevel: LevelSchema.nullable(),
  action: z.object({ id: z.string(), params: ParamsSchema, reversible: z.boolean() }).nullable(),
  reasons: z.array(z.string()),
  checks: z.array(GateCheckSchema).default([]),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const ExecutionSchema = z.object({
  status: z.enum(['dry_run', 'executed', 'failed']),
  actionId: z.string(),
  detail: z.string(),
  /** Ação inversa registrada pelo executor; presente só quando há como reverter. */
  undo: z.object({ actionId: z.string(), params: ParamsSchema }).nullable().optional(),
});

export const RollbackSchema = z.object({
  by: z.string(),
  reason: z.string(),
  at: z.string(),
  execution: ExecutionSchema,
});

export const SignalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('metric'),
    name: z.string(),
    query: z.string(),
    series: z.array(z.object({ labels: z.record(z.string(), z.string()), points: z.array(z.object({ t: z.number(), v: z.number() })) })),
  }),
  z.object({
    kind: z.literal('trace'),
    name: z.string(),
    service: z.string(),
    traces: z.array(
      z.object({
        traceId: z.string(),
        rootOperation: z.string(),
        durationMs: z.number(),
        spanCount: z.number(),
        errorSpans: z.number(),
        slowestOperation: z.object({ name: z.string(), durationMs: z.number() }),
      }),
    ),
  }),
  z.object({ kind: z.literal('error'), name: z.string(), source: z.string(), message: z.string() }),
]);
export type Signal = z.infer<typeof SignalSchema>;

export const ResolutionSchema = z.object({
  kind: z.enum(['approved', 'rejected', 'cancelled', 'blocked']),
  by: z.string(),
  reason: z.string().nullable(),
  at: z.string(),
  execution: ExecutionSchema.nullable(),
});
export type Resolution = z.infer<typeof ResolutionSchema>;

export const OutcomeSchema = z.enum([
  'no_playbook',
  'insufficient_signals',
  'diagnosis_failed',
  'no_action',
  'blocked',
  'suggested',
  'awaiting_approval',
  'auto_executed',
  'execution_failed',
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

export const IncidentSchema = z.object({
  incidentId: z.string(),
  service: z.string(),
  alertname: z.string(),
  outcome: OutcomeSchema,
  playbookId: z.string().nullable(),
  diagnosis: z
    .object({
      hypothesisId: z.string(),
      confidence: z.number(),
      summary: z.string(),
      evidence: z.array(z.object({ signal: z.string(), observation: z.string() })),
      proposedAction: z.object({ actionId: z.string(), params: ParamsSchema, rationale: z.string() }).nullable(),
    })
    .nullable(),
  decision: DecisionSchema.nullable(),
  execution: ExecutionSchema.nullable(),
  approvalId: z.string().nullable(),
  approvalExpiresAt: z.string().nullable().default(null),
  failure: z.string().nullable(),
  llmUsage: z.object({ calls: z.number(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable() }),
  steps: z.array(z.string()),
  timeline: z.array(z.object({ step: z.string(), startedAt: z.string(), durationMs: z.number() })).default([]),
  signals: z.array(SignalSchema).default([]),
  severity: z.string().default('unknown'),
  alertStartedAt: z.string().optional(),
  alertSummary: z.string().nullable().default(null),
  resolution: ResolutionSchema.nullable().default(null),
  rollback: RollbackSchema.nullable().default(null),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type Incident = z.infer<typeof IncidentSchema>;

export const ApprovalSchema = z.object({
  id: z.string(),
  incidentId: z.string(),
  service: z.string(),
  action: z.string(),
  params: ParamsSchema,
  reversible: z.boolean().nullable(),
  reasons: z.array(z.string()),
  checks: z.array(GateCheckSchema),
  hypothesisId: z.string(),
  confidence: z.number(),
  alertname: z.string().nullable(),
  requestedAt: z.string(),
  expiresAt: z.string(),
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const AuditRecordSchema = z.object({
  seq: z.number(),
  at: z.string(),
  incidentId: z.string(),
  event: z.string(),
  actor: z.string(),
  details: z.record(z.string(), z.unknown()),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditRecord = z.infer<typeof AuditRecordSchema>;

export const VerificationSchema = z.object({
  valid: z.boolean(),
  brokenAt: z.number().optional(),
  records: z.number(),
  head: z.object({ seq: z.number(), event: z.string(), hash: z.string(), prevHash: z.string() }).nullable(),
});
export type Verification = z.infer<typeof VerificationSchema>;

const SourceSchema = z.object({ file: z.string(), commit: z.string() });
const BudgetConfigSchema = z.object({ window: z.string(), maxAutoActions: z.number() });

export const PolicySchema = z.object({
  source: SourceSchema,
  killSwitch: z.boolean(),
  defaults: z.object({ level: LevelSchema, budget: BudgetConfigSchema }),
  services: z.array(
    z.object({ name: z.string(), level: LevelSchema, allowedActions: z.array(z.string()), budget: BudgetConfigSchema }),
  ),
  actions: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      reversible: z.boolean(),
      maxAutonomy: LevelSchema,
      params: z.object({ properties: z.record(z.string(), z.record(z.string(), z.unknown())).default({}) }),
    }),
  ),
});
export type Policy = z.infer<typeof PolicySchema>;

export const PlaybookSchema = z.object({
  metadata: z.object({ id: z.string(), version: z.string(), owner: z.string(), description: z.string() }),
  match: z.object({ alertname: z.string(), service: z.string() }),
  signals: z.object({
    metrics: z.array(z.object({ name: z.string(), description: z.string(), query: z.string(), kind: z.string(), window: z.string() })),
    traces: z.array(z.object({ name: z.string(), description: z.string(), service: z.string(), lookback: z.string() })),
  }),
  diagnosis: z.object({
    guidance: z.string(),
    hypotheses: z.array(z.object({ id: z.string(), description: z.string() })),
  }),
  actions: z.array(z.object({ action: z.string(), when: z.array(z.string()), params: ParamsSchema, rationale: z.string() })),
  autonomy: z.object({ maxLevel: LevelSchema, minConfidenceForAuto: z.number() }),
});
export type Playbook = z.infer<typeof PlaybookSchema>;
export const PlaybooksSchema = z.object({ source: SourceSchema, playbooks: z.array(PlaybookSchema) });

export const BudgetSchema = z.object({
  killSwitch: z.boolean(),
  services: z.array(
    z.object({
      name: z.string(),
      level: LevelSchema,
      windowMs: z.number(),
      maxAutoActions: z.number(),
      remaining: z.number().nullable(),
    }),
  ),
  llm: z.object({ incidents: z.number(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number().nullable() }),
});
export type Budget = z.infer<typeof BudgetSchema>;

export const ConfigSchema = z.object({
  version: z.string(),
  executionMode: z.string(),
  llmProvider: z.string(),
  tokenLogin: z.boolean(),
  oidc: z.object({ issuer: z.string(), clientId: z.string(), audience: z.string() }).nullable(),
  jaegerUrl: z.string().nullable(),
});
export type PublicConfig = z.infer<typeof ConfigSchema>;

export const OperatorSchema = z.object({
  email: z.string(),
  name: z.string(),
  via: z.enum(['token', 'oidc']),
  role: z.enum(['reader', 'approver']).default('reader'),
});
export type Operator = z.infer<typeof OperatorSchema>;

export const OutcomeResponseSchema = z.object({ status: z.string() }).passthrough();
