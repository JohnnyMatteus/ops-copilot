import { createHmac } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryReplayGuard, verifySlackSignature } from '../../src/chatops/signature.js';
import { SlackClient } from '../../src/chatops/slack-client.js';
import { SlackInteractionHandler } from '../../src/chatops/slack-interactions.js';
import { parseSlackUsers } from '../../src/chatops/users.js';
import { StaticTokenAuthenticator } from '../../src/auth/operator.js';
import { createHttpServer } from '../../src/http/server.js';
import { ApprovalService } from '../../src/incident/approval-service.js';
import { RollbackService } from '../../src/incident/rollback-service.js';
import { Investigator } from '../../src/incident/investigator.js';
import { FakeLlmClient } from '../../src/llm/fake.js';
import { FixtureMetricsSource, FixtureTraceSource } from '../../src/signals/fixture.js';
import { silentLogger } from '../../src/telemetry/logger.js';
import { testDeps } from '../helpers/fixtures.js';
import { alertFor, playbookById, realPlaybooks, realPolicy } from '../helpers/repo.js';
import { diagnosis, paymentsRecoveredMetrics, paymentsRecoveredTraces } from '../helpers/signals.js';

const SECRET = 'dev-only-slack-signing-secret-0123456789';
const NOW = 1_800_000_000;
const sign = (body: string, timestamp = NOW, secret = SECRET) =>
  `v0=${createHmac('sha256', secret).update(`v0:${String(timestamp)}:${body}`).digest('hex')}`;

/** Corpo no formato real do Slack: form-urlencoded com `payload=<json>`. */
const interactionBody = (userId: string, actionId: string, value: string) =>
  new URLSearchParams({
    payload: JSON.stringify({
      type: 'block_actions',
      user: { id: userId, username: 'fulana' },
      team: { id: 'T0EXAMPLE' },
      actions: [{ action_id: actionId, block_id: 'b1', value, type: 'button' }],
    }),
  }).toString();

describe('assinatura do Slack', () => {
  it('confere com o exemplo da documentação de verificação de requisições', () => {
    // Vetor publicado na documentação do Slack ("Verifying requests from Slack").
    const body =
      'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';
    const result = verifySlackSignature({
      secret: '8f742231b10e8888abcd99yyyzzz85a5',
      timestamp: '1531420618',
      signature: 'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
      rawBody: body,
      nowSeconds: 1531420618,
    });
    expect(result).toEqual({ ok: true });
  });

  it('recusa assinatura errada, corpo adulterado, carimbo velho e cabeçalhos ausentes', () => {
    const body = 'payload=%7B%7D';
    const base = { secret: SECRET, timestamp: String(NOW), signature: sign(body), rawBody: body, nowSeconds: NOW };
    expect(verifySlackSignature(base)).toEqual({ ok: true });
    expect(verifySlackSignature({ ...base, rawBody: `${body}x` })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySlackSignature({ ...base, signature: sign(body, NOW, 'outro-segredo-qualquer-123') })).toEqual({ ok: false, reason: 'mismatch' });
    expect(verifySlackSignature({ ...base, nowSeconds: NOW + 301 })).toEqual({ ok: false, reason: 'stale' });
    expect(verifySlackSignature({ ...base, signature: undefined })).toEqual({ ok: false, reason: 'missing' });
    expect(verifySlackSignature({ ...base, timestamp: 'abc' })).toEqual({ ok: false, reason: 'missing' });
    expect(verifySlackSignature({ ...base, signature: 'v0=curta' })).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('o registro anti-replay aceita a assinatura uma vez e libera depois do prazo', async () => {
    let now = 0;
    const guard = new InMemoryReplayGuard(() => now);
    expect(await guard.firstSeen('a', 1000)).toBe(true);
    expect(await guard.firstSeen('a', 1000)).toBe(false);
    now = 1500;
    expect(await guard.firstSeen('a', 1000)).toBe(true);
  });
});

describe('mapa de usuários', () => {
  it('lê ID=e-mail[:papel] e recusa formato inválido', () => {
    const users = parseSlackUsers('U0AAA111=ana@example.com:approver, U0BBB222=bia@example.com');
    expect(users.get('U0AAA111')).toEqual({ email: 'ana@example.com', role: 'approver' });
    expect(users.get('U0BBB222')).toEqual({ email: 'bia@example.com', role: 'reader' });
    expect(() => parseSlackUsers('ana=ana@example.com')).toThrow();
    expect(() => parseSlackUsers('U0AAA111=nao-e-email')).toThrow();
  });
});

let server: Server | undefined;
afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

async function start() {
  const setup = await testDeps({ llm: new FakeLlmClient([]), metricsSource: new FixtureMetricsSource({}), traceSource: new FixtureTraceSource({}) });
  const approvalService = new ApprovalService({ ...setup, executor: setup.deps.executor });
  const handler = new SlackInteractionHandler({
    users: parseSlackUsers('U0APPROVER=ana@example.com:approver,U0READER=bia@example.com'),
    approvals: setup.approvals,
    approvalService,
    audit: setup.audit,
  });
  server = createHttpServer({
    investigate: async () => undefined,
    approvals: setup.approvals,
    incidents: setup.incidents,
    audit: setup.audit,
    approvalService,
    rollbackService: new RollbackService({ ...setup, executor: setup.deps.executor }),
    authenticator: new StaticTokenAuthenticator(new Map()),
    policy: await realPolicy(),
    playbooks: await realPlaybooks(),
    budget: setup.budget,
    policySource: { file: 'p', commit: 'x' },
    playbooksSource: { file: 'p', commit: 'x' },
    config: { version: 't', executionMode: 'dry-run', llmProvider: 'scripted', tokenLogin: true, oidc: null, jaegerUrl: null },
    registry: setup.metrics.registry,
    logger: silentLogger(),
    webhookToken: 'webhook-token-de-teste-123',
    chatops: { signingSecret: SECRET, handler, replay: new InMemoryReplayGuard(), nowSeconds: () => NOW },
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const send = (body: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${String(port)}/chatops/slack/interactions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Slack-Request-Timestamp': String(NOW),
        'X-Slack-Signature': sign(body),
        ...headers,
      },
      body,
    });
  const pendingApproval = async (actionId = 'notify_oncall', service = 'saas-multitenant', playbookId = 'saas-p99-latency') =>
    setup.approvals.request('inc-1', {
      service,
      playbook: await playbookById(playbookId),
      hypothesisId: playbookId === 'saas-p99-latency' ? 'noisy_tenant' : 'downstream_recovered',
      confidence: 1,
      proposal: { actionId, params: {} },
    });
  return { ...setup, send, pendingApproval };
}

describe('aprovação por Slack', () => {
  it('aprovador mapeado aprova pelo botão: executa e a trilha registra o e-mail mapeado e o canal slack', async () => {
    const { send, pendingApproval, audit, approvals } = await start();
    const pending = await pendingApproval();
    const response = await send(interactionBody('U0APPROVER', 'approval_approve', pending.id));
    expect(response.status).toBe(200);
    expect(((await response.json()) as { text: string }).text).toMatch(/Aprovado por ana@example.com/);
    expect(await approvals.list()).toEqual([]);
    const granted = (await audit.records()).find((record) => record.event === 'approval_granted');
    expect(granted).toMatchObject({ actor: 'human:ana@example.com', details: { via: 'slack' } });
  });

  it('recusa pelo botão registra o motivo padrão', async () => {
    const { send, pendingApproval, audit } = await start();
    const pending = await pendingApproval();
    await send(interactionBody('U0APPROVER', 'approval_reject', pending.id));
    expect((await audit.records()).find((record) => record.event === 'approval_rejected')).toMatchObject({
      actor: 'human:ana@example.com',
      details: { reason: 'Recusado pelo Slack por ana@example.com.' },
    });
  });

  it('leitor e usuário não mapeado não decidem: o pedido segue pendente e a negativa é auditada', async () => {
    const { send, pendingApproval, audit, approvals } = await start();
    const pending = await pendingApproval();
    for (const user of ['U0READER', 'U0STRANGER']) {
      const response = await send(interactionBody(user, 'approval_approve', pending.id), {});
      expect(((await response.json()) as { text: string }).text).toMatch(/papel de aprovador/);
    }
    expect(await approvals.list()).toHaveLength(1);
    expect((await audit.records()).filter((record) => record.event === 'chatops_denied')).toHaveLength(2);
  });

  it('ação com dinheiro não é aprovada por botão: exige o painel', async () => {
    const { send, pendingApproval, approvals } = await start();
    const pending = await pendingApproval('replay_dlq_batch', 'payments-events-go', 'payments-dlq-backlog');
    const response = await send(interactionBody('U0APPROVER', 'approval_approve', pending.id));
    expect(((await response.json()) as { text: string }).text).toMatch(/painel/);
    expect(await approvals.list()).toHaveLength(1);
  });

  it('assinatura inválida, carimbo velho e payload fora do formato não chegam ao handler', async () => {
    const { send, pendingApproval, approvals } = await start();
    const pending = await pendingApproval();
    const body = interactionBody('U0APPROVER', 'approval_approve', pending.id);
    expect((await send(body, { 'X-Slack-Signature': sign(body, NOW, 'segredo-errado-0123456789') })).status).toBe(401);
    expect((await send(body, { 'X-Slack-Request-Timestamp': String(NOW - 1000), 'X-Slack-Signature': sign(body, NOW - 1000) })).status).toBe(401);
    expect((await send('payload=nao-e-json')).status).toBe(400);
    expect((await send(interactionBody('U0APPROVER', 'approval_delete_everything', pending.id))).status).toBe(400);
    expect(await approvals.list()).toHaveLength(1);
  });

  it('replay: a mesma requisição assinada só vale uma vez', async () => {
    const { send, pendingApproval } = await start();
    const pending = await pendingApproval();
    const body = interactionBody('U0APPROVER', 'approval_approve', pending.id);
    expect((await send(body)).status).toBe(200);
    const again = await send(body);
    expect(again.status).toBe(401);
    expect(((await again.json()) as { error: string }).error).toMatch(/repetida/);
  });
});

describe('cliente do Slack', () => {
  const capture = () => {
    const calls: { url: string; body: { channel: string; text: string; blocks?: { type: string }[] }; auth: string }[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>)['Authorization'] ?? '' });
      return Response.json({ ok: true });
    };
    return { calls, fetch };
  };
  const announcement = (service: string, action: string) => ({
    approvalId: '22222222-2222-4222-8222-222222222222',
    incidentId: 'i',
    service,
    action,
    params: { deployment: 'saas-api' },
    hypothesisId: 'noisy_tenant',
    confidence: 0.9,
    expiresAt: '2026-11-20T12:30:00.000Z',
  });

  it('anuncia o pedido com botões e o id da aprovação; ação com dinheiro sai sem botões', async () => {
    const { calls, fetch } = capture();
    const client = new SlackClient({ token: 'xoxb-dev-only-token-0123', approvalChannel: '#aprovacoes', fetch });
    await client.announce(announcement('saas-multitenant', 'scale_deployment'));
    await client.announce(announcement('payments-events-go', 'replay_dlq_batch'));
    expect(calls[0]?.url).toBe('https://slack.com/api/chat.postMessage');
    expect(calls[0]?.auth).toBe('Bearer xoxb-dev-only-token-0123');
    expect(JSON.stringify(calls[0]?.body.blocks)).toContain('"value":"22222222-2222-4222-8222-222222222222"');
    expect(calls[0]?.body.blocks?.some((block) => block.type === 'actions')).toBe(true);
    expect(calls[1]?.body.blocks?.some((block) => block.type === 'actions')).toBe(false);
  });

  it('resposta ok:false do Slack vira erro, nunca sucesso simulado', async () => {
    const client = new SlackClient({ token: 'xoxb-dev-only-token-0123', fetch: async () => Response.json({ ok: false, error: 'channel_not_found' }) });
    await expect(client.notify('#x', 'oi')).rejects.toThrow(/channel_not_found/);
  });

  it('falha do aviso no Slack não derruba a investigação e fica na trilha', async () => {
    const llm = new FakeLlmClient([
      diagnosis({
        hypothesisId: 'downstream_recovered',
        confidence: 0.9,
        evidence: [{ signal: 'dlq_depth', observation: 'DLQ com 1450 mensagens' }],
        proposedAction: { actionId: 'replay_dlq_batch', params: { maxMessages: 100 }, rationale: 'a causa já passou' },
      }),
    ]);
    const { deps, audit } = await testDeps({
      llm,
      metricsSource: new FixtureMetricsSource(paymentsRecoveredMetrics),
      traceSource: new FixtureTraceSource(paymentsRecoveredTraces),
    });
    const announcer = { announce: async () => Promise.reject(new Error('Slack fora do ar')) };
    const report = await new Investigator({ ...deps, announcer }).investigate(alertFor('PaymentsDlqBacklogHigh', 'payments-events-go'));
    expect(report?.outcome).toBe('awaiting_approval');
    expect((await audit.records()).map((record) => record.event)).toContain('chatops_notification_failed');
  });
});
