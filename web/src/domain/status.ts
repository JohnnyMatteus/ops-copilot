// Estado de um incidente para a tela, derivado do relatório e do relógio. O copiloto não guarda
// "expirado": passou o prazo sem decisão, o pedido expirou.
import type { Incident, Outcome, Verdict } from '@/api/schemas';

export type IncidentStatus =
  | 'awaiting'
  | 'expired'
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'reapproval_blocked'
  | 'auto_executed'
  | 'suggested'
  | 'blocked'
  | 'no_action'
  | 'failed';

export function statusOf(incident: Incident, now: number): IncidentStatus {
  const { resolution } = incident;
  if (resolution) {
    return { approved: 'approved', rejected: 'rejected', cancelled: 'cancelled', blocked: 'reapproval_blocked' }[resolution.kind] as IncidentStatus;
  }
  if (incident.outcome === 'awaiting_approval') {
    const expiresAt = incident.approvalExpiresAt ? Date.parse(incident.approvalExpiresAt) : Number.POSITIVE_INFINITY;
    return now > expiresAt ? 'expired' : 'awaiting';
  }
  const byOutcome: Record<Exclude<Outcome, 'awaiting_approval'>, IncidentStatus> = {
    auto_executed: 'auto_executed',
    suggested: 'suggested',
    blocked: 'blocked',
    no_action: 'no_action',
    no_playbook: 'failed',
    insufficient_signals: 'failed',
    diagnosis_failed: 'failed',
    execution_failed: 'failed',
    interrupted: 'failed',
  };
  return byOutcome[incident.outcome];
}

export const STATUS_LABEL: Record<IncidentStatus, string> = {
  awaiting: 'aguardando aprovação',
  expired: 'aprovação expirada',
  approved: 'aprovado (dry-run)',
  rejected: 'recusado',
  cancelled: 'cancelado',
  reapproval_blocked: 'bloqueado na reavaliação',
  auto_executed: 'executado em dry-run',
  suggested: 'só sugestão',
  blocked: 'bloqueado pelo gate',
  no_action: 'sem ação proposta',
  failed: 'investigação sem conclusão',
};

export const OUTCOME_LABEL: Record<Outcome, string> = {
  no_playbook: 'sem playbook para o alerta',
  insufficient_signals: 'sinais insuficientes',
  diagnosis_failed: 'diagnóstico inválido',
  no_action: 'sem ação proposta',
  blocked: 'bloqueado pelo gate',
  suggested: 'só sugestão',
  awaiting_approval: 'aguardando aprovação',
  auto_executed: 'executado em dry-run',
  execution_failed: 'falha na execução',
  interrupted: 'investigação interrompida',
};

/** Estados em que ainda há uma pessoa para decidir. */
export const isOpen = (status: IncidentStatus) => status === 'awaiting';

export function verdictOf(incident: Incident): Verdict | null {
  return incident.decision?.verdict ?? null;
}

export function currentStep(incident: Incident): string {
  return incident.timeline.at(-1)?.step ?? incident.steps.at(-1) ?? 'triage';
}
