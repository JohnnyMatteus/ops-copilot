import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { Alert } from '../../src/domain/alert.js';
import { createHttpServer } from '../../src/http/server.js';
import { ApprovalService } from '../../src/incident/approval-service.js';
import { FakeLlmClient } from '../../src/llm/fake.js';
import { FixtureMetricsSource, FixtureTraceSource } from '../../src/signals/fixture.js';
import { silentLogger } from '../../src/telemetry/logger.js';
import { testDeps } from '../helpers/fixtures.js';
import { playbookById } from '../helpers/repo.js';
import { firing, webhookPayload } from '../helpers/alertmanager.js';

const WEBHOOK_TOKEN = 'webhook-token-de-teste-123';
const APPROVAL_TOKEN = 'approval-token-de-teste-456';

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
    approvalService: new ApprovalService({ ...setup, executor: setup.deps.executor }),
    registry: setup.metrics.registry,
    logger: silentLogger(),
    webhookToken: WEBHOOK_TOKEN,
    approvalToken: APPROVAL_TOKEN,
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

  it('token do webhook não serve para aprovar', async () => {
    const { call } = await start();
    expect((await call('/approvals', { headers: { Authorization: `Bearer ${WEBHOOK_TOKEN}` } })).status).toBe(401);
  });

  it('lista e rejeita aprovações pendentes, com auditoria do humano', async () => {
    const { call, approvals, audit } = await start();
    const pending = approvals.request('inc-1', {
      service: 'payments-events-go',
      playbook: await playbookById('payments-dlq-backlog'),
      hypothesisId: 'downstream_recovered',
      confidence: 0.9,
      proposal: { actionId: 'replay_dlq_batch', params: { maxMessages: 50 } },
    });
    const list = await call('/approvals', { headers: { Authorization: `Bearer ${APPROVAL_TOKEN}` } });
    expect(await list.json()).toEqual([expect.objectContaining({ id: pending.id, action: 'replay_dlq_batch' })]);

    const response = await call(
      `/approvals/${pending.id}`,
      post(APPROVAL_TOKEN, { approver: 'plantonista@example.com', decision: 'reject' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'rejected' });
    expect((await audit.records()).at(-1)).toMatchObject({ event: 'approval_rejected', actor: 'human:plantonista@example.com' });
  });

  it('aprovação inexistente responde 404 e corpo inválido 400', async () => {
    const { call } = await start();
    const id = '00000000-0000-4000-8000-000000000000';
    expect((await call(`/approvals/${id}`, post(APPROVAL_TOKEN, { approver: 'a@example.com', decision: 'approve' }))).status).toBe(404);
    expect((await call(`/approvals/${id}`, post(APPROVAL_TOKEN, { approver: 'sem-email', decision: 'approve' }))).status).toBe(400);
  });

  it('expõe /metrics e /healthz', async () => {
    const { call } = await start();
    expect((await call('/healthz')).status).toBe(200);
    const metrics = await call('/metrics');
    expect(await metrics.text()).toContain('ops_copilot_incidents_total');
  });
});
