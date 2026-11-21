// Estado do grafo de investigação. Cada etapa preenche um campo; `outcome` encerra o fluxo.
import { Annotation } from '@langchain/langgraph';
import { z } from 'zod';
import type { Decision } from '../autonomy/gate.js';
import type { Alert } from '../domain/alert.js';
import type { ExecutionResult } from '../executor/executor.js';
import type { Diagnosis } from '../incident/diagnosis.js';
import { EMPTY_USAGE, type LlmUsage } from '../llm/structured.js';
import type { Playbook } from '../playbooks/schema.js';
import type { Signal } from '../signals/types.js';

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

const value = <T>(initial: () => T) => Annotation<T>({ reducer: (_current, next) => next, default: initial });

export const InvestigationState = Annotation.Root({
  incidentId: Annotation<string>,
  alert: Annotation<Alert>,
  playbook: value<Playbook | null>(() => null),
  signals: value<Signal[]>(() => []),
  diagnosis: value<Diagnosis | null>(() => null),
  decision: value<Decision | null>(() => null),
  execution: value<ExecutionResult | null>(() => null),
  approvalId: value<string | null>(() => null),
  failure: value<string | null>(() => null),
  outcome: value<Outcome | null>(() => null),
  llmUsage: value<LlmUsage>(() => EMPTY_USAGE),
});

export type InvestigationStateType = typeof InvestigationState.State;
export type InvestigationUpdate = typeof InvestigationState.Update;
