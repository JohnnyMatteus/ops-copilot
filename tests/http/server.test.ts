import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Alert } from '../../src/domain/alert.js';
import { StaticTokenAuthenticator } from '../../src/auth/operator.js';
import { createHttpServer } from '../../src/http/server.js';
import type { IncidentReport } from '../../src/incident/investigator.js';
import { RollbackService } from '../../src/incident/rollback-service.js';
import { ApprovalService } from '../../src/incident/approval-service.js';
import { FakeLlmClient } from '../../src/llm/fake.js';
import { FixtureMetricsSource, FixtureTraceSource } from '../../src/signals/fixture.js';
import { silentLogger } from '../../src/telemetry/logger.js';
import { testDeps } from '../helpers/fixtures.js';
import { playbookById, realPlaybooks, realPolicy } from '../helpers/repo.js';
import { firing, webhookPayload } from '../helpers/alertmanager.js';

const WEBHOOK_TOKEN = 'webhook-token-de-teste-123';
const PLANTAO_TOKEN = 'operador-plantao-de-teste-456';
const LIDER_TOKEN = 'operador-lider-de-teste-789';
const LEITOR_TOKEN = 'operador-leitor-de-teste-000';
const auth = (token: string) => ({ headers: { Authorization: `Bearer ${token}` } });

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start() {
  const setup = await testDeps({
    llm: new FakeLlmClient([]),
    metricsSource: new FixtureMetricsSource({}),
    traceSource: new FixtureTraceSource({}),
  });
  const investigated: Alert[] = [];
  const tasks: Promise<unknown>[] = [];
  server = createHttpServer({
    investigate: async (alert) => investigated.push(alert),
    approvals: setup.approvals,
    incidents: setup.incidents,
    audit: setup.audit,
    approvalService: new ApprovalService({ ...setup, executor: setup.deps.executor }),
    rollbackService: new RollbackService({ ...setup, executor: setup.deps.executor }),
    authenticator: new StaticTokenAuthenticator(
      new Map([
        ['plantonista@example.com', { token: PLANTAO_TOKEN, role: 'approver' as const }],
        ['lider@example.com', { token: LIDER_TOKEN, role: 'approver' as const }],
        ['leitor@example.com', { token: LEITOR_TOKEN, role: 'reader' as const }],
      ]),
    ),
    policy: await realPolicy(),
    playbooks: await realPlaybooks(),
    budget: setup.budget,
    policySource: { file: 'config/autonomy-policy.yaml', commit: 'abc1234' },
    playbooksSource: { file: 'playbooks', commit: 'abc1234' },
    config: { version: 'test', executionMode: 'dry-run', llmProvider: 'scripted', tokenLogin: true, oidc: null, jaegerUrl: null },
    registry: setup.metrics.registry,
    logger: silentLogger(),
    webhookToken: WEBHOOK_TOKEN,
    schedule: (task) => tasks.push(task()),
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${String(port)}${path}`, init);
  return { ...setup, call, investigated, tasks };
}

const post = (token: string, body: unknown): RequestInit => ({
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

describe('servidor HTTP', () => {
  it('aceita o webhook, responde 202 e agenda uma investigação por alerta disparado', async () => {
    const { call, investigated, tasks } = await start();
    const response = await call(
      '/webhooks/alertmanager',
      post(WEBHOOK_TOKEN, webhookPayload([firing({ alertname: 'SaasP99LatencyHigh', service: 'saas-multitenant' })])),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 1 });
    await Promise.all(tasks);
    expect(investigated[0]?.service).toBe('saas-multitenant');
  });

  it('recusa webhook sem token correto', async () => {
    const { call } = await start();
    const response = await call('/webhooks/alertmanager', post('token-errado-com-tamanho-igual', webhookPayload([])));
    expect(response.status).toBe(401);
  });

  it('recusa payload fora do formato e JSON inválido', async () => {
    const { call } = await start();
    expect((await call('/webhooks/alertmanager', post(WEBHOOK_TOKEN, { version: '4' }))).status).toBe(400);
    expect((await call('/webhooks/alertmanager', post(WEBHOOK_TOKEN, '{quebrado'))).status).toBe(400);
  });

  it('alerta sem rótulo service responde 422', async () => {
    const { call } = await start();
    const response = await call('/webhooks/alertmanager', post(WEBHOOK_TOKEN, webhookPayload([firing({ alertname: 'X' })])));
    expect(response.status).toBe(422);
  });

  it('token do webhook não serve para as rotas do painel', async () => {
    const { call } = await start();
    expect((await call('/approvals', auth(WEBHOOK_TOKEN))).status).toBe(401);
    expect((await call('/approvals')).status).toBe(401);
  });

  it('/config é público e /me devolve quem está autenticado', async () => {
    const { call } = await start();
    expect(await (await call('/config')).json()).toMatchObject({ executionMode: 'dry-run', tokenLogin: true, oidc: null });
    expect(await (await call('/me', auth(LIDER_TOKEN))).json()).toEqual({ email: 'lider@example.com', name: 'lider', via: 'token', role: 'approver' });
  });

  async function pendingPayments(setup: Awaited<ReturnType<typeof start>>) {
    const { approvals } = setup;
    return approvals.request('inc-1', {
      service: 'payments-events-go',
      playbook: await playbookById('payments-dlq-backlog'),
      hypothesisId: 'downstream_recovered',
      confidence: 0.9,
      proposal: { actionId: 'replay_dlq_batch', params: { maxMessages: 50 } },
    });
  }

  it('lista aprovações pendentes com ação, parâmetros e prazo', async () => {
    const setup = await start();
    const pending = await pendingPayments(setup);
    const list = await setup.call('/approvals', auth(PLANTAO_TOKEN));
    expect(await list.json()).toEqual([
      expect.objectContaining({ id: pending.id, action: 'replay_dlq_batch', params: { maxMessages: 50 }, expiresAt: expect.any(String) }),
    ]);
  });

  it('recusa grava a identidade do token e o motivo na auditoria, ignorando "approver" no corpo', async () => {
    const setup = await start();
    const pending = await pendingPayments(setup);
    const strict = await setup.call(
      `/approvals/${pending.id}`,
      post(PLANTAO_TOKEN, { decision: 'reject', reason: 'fora da janela', approver: 'outro@example.com' }),
    );
    expect(strict.status).toBe(400);

    const response = await setup.call(`/approvals/${pending.id}`, post(PLANTAO_TOKEN, { decision: 'reject', reason: 'fora da janela de mudança' }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'rejected' });
    expect((await setup.audit.records()).at(-1)).toMatchObject({
      event: 'approval_rejected',
      actor: 'human:plantonista@example.com',
      details: { reason: 'fora da janela de mudança' },
    });
  });

  it('recusa sem motivo é 400 e não consome o pedido', async () => {
    const setup = await start();
    const pending = await pendingPayments(setup);
    expect((await setup.call(`/approvals/${pending.id}`, post(PLANTAO_TOKEN, { decision: 'reject' }))).status).toBe(400);
    expect(await setup.approvals.list()).toHaveLength(1);
  });

  it('aprovação executa em dry-run assinada por quem decidiu e registra a resolução no incidente', async () => {
    const setup = await start();
    const pending = await pendingPayments(setup);
    await setup.incidents.save(incidentStub(pending.id));
    const response = await setup.call(`/approvals/${pending.id}`, post(LIDER_TOKEN, { decision: 'approve' }));
    expect(await response.json()).toMatchObject({ status: 'executed', execution: { status: 'dry_run' } });
    expect((await setup.audit.records()).map((r) => [r.event, r.actor])).toEqual([
      ['approval_granted', 'human:lider@example.com'],
      ['action_executed', 'human:lider@example.com'],
    ]);
    expect((await setup.incidents.get('inc-1'))?.resolution).toMatchObject({ kind: 'approved', by: 'lider@example.com' });
  });

  it('cancela incidente aguardando aprovação: tira da fila, audita e impede nova decisão', async () => {
    const setup = await start();
    const pending = await pendingPayments(setup);
    await setup.incidents.save(incidentStub(pending.id));
    const noReason = await setup.call('/incidents/00000000-0000-4000-8000-000000000001/cancel', post(PLANTAO_TOKEN, {}));
    expect(noReason.status).toBe(400);

    const id = '00000000-0000-4000-8000-000000000001';
    await setup.incidents.save({ ...incidentStub(pending.id), incidentId: id });
    const response = await setup.call(`/incidents/${id}/cancel`, post(PLANTAO_TOKEN, { reason: 'alerta falso positivo' }));
    expect(response.status).toBe(200);
    expect(await setup.approvals.list()).toHaveLength(0);
    expect((await setup.audit.records()).at(-1)).toMatchObject({
      event: 'incident_cancelled',
      actor: 'human:plantonista@example.com',
      details: { reason: 'alerta falso positivo' },
    });
    expect((await setup.incidents.get(id))?.resolution).toMatchObject({ kind: 'cancelled', reason: 'alerta falso positivo' });
    expect((await setup.call(`/incidents/${id}/cancel`, post(PLANTAO_TOKEN, { reason: 'de novo' }))).status).toBe(409);
    expect((await setup.call(`/approvals/${pending.id}`, post(PLANTAO_TOKEN, { decision: 'approve' }))).status).toBe(404);
  });

  it('só incidente aguardando aprovação pode ser cancelado', async () => {
    const setup = await start();
    const id = '00000000-0000-4000-8000-000000000002';
    await setup.incidents.save({ ...incidentStub('x'), incidentId: id, outcome: 'auto_executed', approvalId: null });
    expect((await setup.call(`/incidents/${id}/cancel`, post(PLANTAO_TOKEN, { reason: 'tentativa' }))).status).toBe(409);
  });

  it('aprovação inexistente responde 404 e corpo inválido 400', async () => {
    const { call } = await start();
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await call(`/approvals/${id}`, post(PLANTAO_TOKEN, { decision: 'approve' }))).status).toBe(404);
    expect((await call(`/approvals/${id}`, post(PLANTAO_TOKEN, { decision: 'talvez' }))).status).toBe(400);
  });

  it('expõe a verificação da cadeia e os registros da auditoria só para operadores', async () => {
    const { call, audit } = await start();
    await audit.append({ incidentId: 'inc-1', event: 'alert_received', actor: 'copilot', details: {} });
    expect((await call('/audit/verify')).status).toBe(401);
    expect(await (await call('/audit/verify', auth(PLANTAO_TOKEN))).json()).toMatchObject({ valid: true, records: 1, head: { seq: 0 } });
    expect(await (await call('/audit?incidentId=inc-1', auth(PLANTAO_TOKEN))).json()).toEqual([expect.objectContaining({ seq: 0 })]);
    expect(await (await call('/audit?incidentId=outro', auth(PLANTAO_TOKEN))).json()).toEqual([]);
  });

  it('incidente desconhecido responde 404', async () => {
    const { call } = await start();
    expect(await (await call('/incidents', auth(PLANTAO_TOKEN))).json()).toEqual([]);
    expect((await call('/incidents/00000000-0000-4000-8000-000000000000', auth(PLANTAO_TOKEN))).status).toBe(404);
  });

  it('expõe política com limites do catálogo, playbooks e orçamento', async () => {
    const { call } = await start();
    const policy = (await (await call('/policy', auth(PLANTAO_TOKEN))).json()) as {
      source: { commit: string };
      services: { name: string }[];
      actions: { id: string; params: { properties: Record<string, { maximum?: number }> } }[];
    };
    expect(policy.source.commit).toBe('abc1234');
    expect(policy.services.map((service) => service.name)).toContain('payments-events-go');
    expect(policy.actions.find((action) => action.id === 'replay_dlq_batch')?.params.properties['maxMessages']?.maximum).toBe(500);

    const playbooks = (await (await call('/playbooks', auth(PLANTAO_TOKEN))).json()) as { playbooks: unknown[] };
    expect(playbooks.playbooks).toHaveLength(3);

    const budget = (await (await call('/budget', auth(PLANTAO_TOKEN))).json()) as { services: { name: string; remaining: number }[] };
    expect(budget.services.find((service) => service.name === 'kafka-telemetry')?.remaining).toBe(3);
  });

  it('expõe /metrics e /healthz', async () => {
    const { call } = await start();
    expect((await call('/healthz')).status).toBe(200);
    const metrics = await call('/metrics');
    expect(await metrics.text()).toContain('ops_copilot_incidents_total');
  });

  it('leitor consulta, mas aprovar, recusar, cancelar e reverter dão 403 sem efeito', async () => {
    const { call, approvals } = await start();
    const id = '00000000-0000-4000-8000-000000000009';
    expect((await call('/incidents', auth(LEITOR_TOKEN))).status).toBe(200);
    expect(await (await call('/me', auth(LEITOR_TOKEN))).json()).toMatchObject({ role: 'reader' });
    expect((await call(`/approvals/${id}`, post(LEITOR_TOKEN, { decision: 'approve' }))).status).toBe(403);
    expect((await call(`/incidents/${id}/cancel`, post(LEITOR_TOKEN, { reason: 'teste' }))).status).toBe(403);
    expect((await call(`/incidents/${id}/rollback`, post(LEITOR_TOKEN, { reason: 'teste' }))).status).toBe(403);
    expect(await approvals.list()).toEqual([]);
  });

  it('POST /incidents/:id/rollback devolve 404 para incidente desconhecido e 400 sem motivo', async () => {
    const { call } = await start();
    const id = 'a1b2c3d4-0000-4000-8000-0000000000ff';
    expect((await call(`/incidents/${id}/rollback`, post(LIDER_TOKEN, { reason: 'teste' }))).status).toBe(404);
    expect((await call(`/incidents/${id}/rollback`, post(LIDER_TOKEN, {}))).status).toBe(400);
  });
});

function incidentStub(approvalId: string): IncidentReport {
  return {
    incidentId: 'inc-1',
    service: 'payments-events-go',
    alertname: 'PaymentsDlqBacklogHigh',
    outcome: 'awaiting_approval',
    playbookId: 'payments-dlq-backlog',
    diagnosis: null,
    decision: null,
    execution: null,
    approvalId,
    approvalExpiresAt: null,
    failure: null,
    llmUsage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    steps: [],
    timeline: [],
    signals: [],
    severity: 'critical',
    alertStartedAt: '2026-11-20T12:00:00Z',
    alertSummary: null,
    resolution: null,
    startedAt: '2026-11-20T12:00:00Z',
    finishedAt: '2026-11-20T12:00:01Z',
  };
}
