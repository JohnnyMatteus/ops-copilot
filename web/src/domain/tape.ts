// Monta os cinco segmentos da fita do gate a partir do relatório. Etapas que não rodaram
// (a investigação encerrou antes) aparecem apagadas, com o motivo.
import type { GateCheck, Incident, Verdict } from '@/api/schemas';
import { OUTCOME_LABEL } from './status';
import { percent } from './format';

export const STEPS = ['triage', 'collect', 'diagnose', 'decide', 'act'] as const;
export type StepName = (typeof STEPS)[number];

export interface TapeStep {
  readonly step: StepName;
  readonly reached: boolean;
  readonly startedAt: string | null;
  readonly durationMs: number | null;
  readonly stamp: string;
  readonly verdict: Verdict | null;
  readonly checks: readonly GateCheck[];
  readonly lines: readonly string[];
}

export const STEP_LABEL: Record<StepName, string> = {
  triage: 'triage',
  collect: 'collect',
  diagnose: 'diagnose',
  decide: 'decide',
  act: 'act',
};

const RESOLUTION_LABEL = { approved: 'aprovou', rejected: 'recusou', cancelled: 'cancelou', blocked: 'aprovou, mas o gate bloqueou' } as const;

export function buildTape(incident: Incident): TapeStep[] {
  const byStep = new Map(incident.timeline.map((entry) => [entry.step, entry]));
  const reachedSteps = new Set<string>(incident.timeline.length > 0 ? byStep.keys() : incident.steps);
  const failedSignals = incident.signals.filter((signal) => signal.kind === 'error').length;

  return STEPS.map((step) => {
    const entry = byStep.get(step);
    const reached = reachedSteps.has(step);
    let stamp = reached ? '' : 'não executada: o fluxo encerrou antes';
    let verdict: Verdict | null = null;
    let checks: readonly GateCheck[] = [];
    const lines: string[] = [];

    if (reached) {
      switch (step) {
        case 'triage':
          stamp = incident.playbookId ? `playbook ${incident.playbookId}` : 'sem playbook: o LLM não é chamado';
          break;
        case 'collect':
          stamp = `${String(incident.signals.length - failedSignals)} sinais coletados, ${String(failedSignals)} com erro`;
          break;
        case 'diagnose':
          stamp = incident.diagnosis
            ? `${incident.diagnosis.hypothesisId} · confiança ${percent(incident.diagnosis.confidence)}`
            : (incident.failure ?? 'sem diagnóstico');
          break;
        case 'decide':
          if (incident.decision) {
            verdict = incident.decision.verdict;
            checks = incident.decision.checks;
            stamp = incident.decision.reasons.join(' ');
          } else {
            stamp = 'nenhuma ação proposta: o gate não foi acionado';
          }
          break;
        case 'act':
          stamp = OUTCOME_LABEL[incident.outcome];
          if (incident.execution) lines.push(incident.execution.detail);
          if (incident.resolution) {
            const { resolution } = incident;
            lines.push(`${resolution.by} ${RESOLUTION_LABEL[resolution.kind]}${resolution.reason ? `: ${resolution.reason}` : ''}`);
            if (resolution.execution) lines.push(resolution.execution.detail);
          }
          break;
      }
    }
    return {
      step,
      reached,
      startedAt: entry?.startedAt ?? null,
      durationMs: entry?.durationMs ?? null,
      stamp,
      verdict,
      checks,
      lines,
    };
  });
}
