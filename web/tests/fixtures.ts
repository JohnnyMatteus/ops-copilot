import { IncidentSchema, type Incident } from '@/api/schemas';

/** Relatório como o copiloto devolve, aguardando aprovação de um replay de DLQ. */
export const awaitingReport = (): Incident =>
  IncidentSchema.parse({
    incidentId: '11111111-1111-4111-8111-111111111111',
    service: 'payments-events-go',
    alertname: 'PaymentsDlqBacklogHigh',
    outcome: 'awaiting_approval',
    playbookId: 'payments-dlq-backlog',
    diagnosis: {
      hypothesisId: 'downstream_recovered',
      confidence: 0.9,
      summary: 'O ledger-api voltou há 2 minutos; a DLQ pode ser reprocessada.',
      evidence: [{ signal: 'dlq_depth', observation: 'DLQ com 340 mensagens' }],
      proposedAction: { actionId: 'replay_dlq_batch', params: { maxMessages: 100 }, rationale: 'causa já passou' },
    },
    decision: {
      verdict: 'needs_approval',
      effectiveLevel: 'execute_with_approval',
      action: { id: 'replay_dlq_batch', params: { queue: 'payments-dlq', maxMessages: 100 }, reversible: false },
      reasons: ['Nível efetivo: executar com aprovação humana.'],
      checks: [
        { check: 'catalogo', passed: true, detail: 'replay_dlq_batch conhecida' },
        { check: 'parametros', passed: false, detail: 'maxMessages: acima do limite' },
      ],
    },
    execution: null,
    approvalId: '22222222-2222-4222-8222-222222222222',
    approvalExpiresAt: '2026-11-20T12:30:00.000Z',
    failure: null,
    llmUsage: { calls: 1, inputTokens: 100, outputTokens: 50, costUsd: 0 },
    steps: ['triage', 'collect', 'diagnose', 'decide', 'act'],
    timeline: ['triage', 'collect', 'diagnose', 'decide', 'act'].map((step, index) => ({
      step,
      startedAt: `2026-11-20T12:00:0${String(index)}.000Z`,
      durationMs: 12 * (index + 1),
    })),
    signals: [
      { kind: 'metric', name: 'dlq_depth', query: 'sum(dlq_messages)', series: [{ labels: {}, points: [{ t: 1, v: 3 }, { t: 2, v: 9 }] }] },
      { kind: 'error', name: 'traces', source: 'jaeger', message: 'connection refused' },
    ],
    severity: 'critical',
    alertStartedAt: '2026-11-20T12:00:00.000Z',
    startedAt: '2026-11-20T12:00:00.000Z',
    finishedAt: '2026-11-20T12:00:05.000Z',
  });
