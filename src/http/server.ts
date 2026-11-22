// Borda HTTP: webhook do Alertmanager, decisões humanas (aprovar, recusar, cancelar), leituras do
// painel (incidentes, auditoria, política, playbooks, orçamento), /metrics e /healthz. Só node:http.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Registry } from 'prom-client';
import { z } from 'zod';
import { AlertmanagerWebhookSchema, firingAlerts, InvalidAlertError, type Alert } from '../domain/alert.js';
import { verifyChain, type AuditLog } from '../autonomy/audit.js';
import type { ActionBudget } from '../autonomy/budget.js';
import type { AutonomyPolicy } from '../autonomy/policy.js';
import type { Operator, OperatorAuthenticator } from '../auth/operator.js';
import { ReasonRequiredError, type ApprovalService } from '../incident/approval-service.js';
import type { RollbackService } from '../incident/rollback-service.js';
import type { ApprovalQueue } from '../incident/approvals.js';
import type { IncidentRepository } from '../incident/incidents.js';
import type { PlaybookRegistry } from '../playbooks/registry.js';
import type { Logger } from '../telemetry/logger.js';
import { budgetView, playbooksView, policyView, type SourceInfo } from './read-models.js';

const MAX_BODY_BYTES = 1_000_000;

const reason = z.string().trim().min(3, 'descreva o motivo em pelo menos 3 caracteres').max(500);

// A identidade de quem decide vem da credencial; o corpo não aceita "approver".
const ApprovalBodySchema = z.discriminatedUnion('decision', [
  z.strictObject({ decision: z.literal('approve'), reason: reason.optional() }),
  z.strictObject({ decision: z.literal('reject'), reason }),
]);
const CancelBodySchema = z.strictObject({ reason });

/** O que o painel precisa saber antes de autenticar: como entrar e em que modo o copiloto roda. */
export interface PublicConfig {
  readonly version: string;
  readonly executionMode: string;
  readonly llmProvider: string;
  readonly tokenLogin: boolean;
  readonly oidc: { readonly issuer: string; readonly clientId: string; readonly audience: string } | null;
  readonly jaegerUrl: string | null;
}

export interface ServerDeps {
  readonly investigate: (alert: Alert) => Promise<unknown>;
  readonly approvals: ApprovalQueue;
  readonly incidents: IncidentRepository;
  readonly audit: AuditLog;
  readonly approvalService: ApprovalService;
  readonly rollbackService: RollbackService;
  readonly authenticator: OperatorAuthenticator;
  readonly policy: AutonomyPolicy;
  readonly playbooks: PlaybookRegistry;
  readonly budget: ActionBudget;
  readonly policySource: SourceInfo;
  readonly playbooksSource: SourceInfo;
  readonly config: PublicConfig;
  readonly registry: Registry;
  readonly logger: Logger;
  readonly webhookToken: string;
  /** Agenda a investigação fora do ciclo da requisição; o Alertmanager não espera o LLM. */
  readonly schedule?: (task: () => Promise<unknown>) => void;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createHttpServer(deps: ServerDeps): Server {
  const schedule =
    deps.schedule ??
    ((task) => {
      task().catch((error: unknown) => deps.logger.error({ err: error }, 'falha na investigação'));
    });

  const routes = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const approvalMatch = /^\/approvals\/([0-9a-f-]{36})$/.exec(url.pathname);
    const cancelMatch = /^\/incidents\/([0-9a-f-]{36})\/cancel$/.exec(url.pathname);
    const rollbackMatch = /^\/incidents\/([0-9a-f-]{36})\/rollback$/.exec(url.pathname);
    const incidentMatch = /^\/incidents\/([0-9a-f-]{36})$/.exec(url.pathname);

    if (req.method === 'GET' && url.pathname === '/healthz') {
      return json(res, 200, { status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
    }

    if (req.method === 'GET' && url.pathname === '/metrics') {
      res.writeHead(200, { 'Content-Type': deps.registry.contentType });
      res.end(await deps.registry.metrics());
      return;
    }

    if (req.method === 'POST' && url.pathname === '/webhooks/alertmanager') {
      requireBearer(req, deps.webhookToken);
      const payload = AlertmanagerWebhookSchema.safeParse(await readJson(req));
      if (!payload.success) throw new HttpError(400, 'Payload fora do formato do Alertmanager (versão 4).');
      const alerts = firingAlerts(payload.data);
      for (const alert of alerts) schedule(() => deps.investigate(alert));
      deps.logger.info({ groupKey: payload.data.groupKey, accepted: alerts.length }, 'webhook recebido');
      return json(res, 202, { accepted: alerts.length });
    }

    if (req.method === 'GET' && url.pathname === '/config') return json(res, 200, deps.config);

    // Daqui em diante toda rota exige um operador identificado.
    const operator = await requireOperator(req, deps.authenticator);

    if (req.method === 'GET' && url.pathname === '/me') return json(res, 200, operator);

    if (req.method === 'GET' && url.pathname === '/approvals') {
      const pending = await deps.approvals.list();
      return json(
        res,
        200,
        await Promise.all(
          pending.map(async (approval) => {
            const report = await deps.incidents.get(approval.incidentId);
            return {
              id: approval.id,
              incidentId: approval.incidentId,
              service: approval.gateInput.service,
              action: approval.gateInput.proposal.actionId,
              params: report?.decision?.action?.params ?? approval.gateInput.proposal.params,
              reversible: report?.decision?.action?.reversible ?? null,
              reasons: report?.decision?.reasons ?? [],
              checks: report?.decision?.checks ?? [],
              hypothesisId: approval.gateInput.hypothesisId,
              confidence: approval.gateInput.confidence,
              alertname: report?.alertname ?? null,
              requestedAt: new Date(approval.requestedAt).toISOString(),
              expiresAt: new Date(approval.expiresAt).toISOString(),
            };
          }),
        ),
      );
    }

    if (req.method === 'POST' && approvalMatch?.[1]) {
      const body = ApprovalBodySchema.safeParse(await readJson(req));
      if (!body.success) {
        throw new HttpError(400, 'Corpo esperado: {"decision": "approve", "reason"?} ou {"decision": "reject", "reason": motivo}.');
      }
      const outcome = await deps.approvalService.resolve(approvalMatch[1], operator, {
        approve: body.data.decision === 'approve',
        reason: body.data.reason,
      });
      const status = { executed: 200, rejected: 200, blocked: 409, not_found: 404, expired: 410 }[outcome.status];
      return json(res, status, outcome);
    }

    if (req.method === 'POST' && cancelMatch?.[1]) {
      const body = CancelBodySchema.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, 'Corpo esperado: {"reason": motivo}.');
      const outcome = await deps.approvalService.cancel(cancelMatch[1], operator, body.data.reason);
      const status = { cancelled: 200, not_found: 404, not_cancellable: 409 }[outcome.status];
      return json(res, status, outcome);
    }

    if (req.method === 'POST' && rollbackMatch?.[1]) {
      const body = CancelBodySchema.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, 'Corpo esperado: {"reason": motivo}.');
      const outcome = await deps.rollbackService.rollback(rollbackMatch[1], operator, body.data.reason);
      const status = { rolled_back: 200, failed: 502, dry_run: 409, blocked: 409, not_found: 404, not_reversible: 409, already_rolled_back: 409 }[outcome.status];
      const error = {
        rolled_back: null,
        dry_run: 'O copiloto está em dry-run: nada foi alterado, o rollback não foi aplicado.',
        failed: outcome.status === 'failed' ? `O rollback falhou: ${outcome.execution.detail}` : null,
        blocked: outcome.status === 'blocked' ? `Bloqueado pelo gate: ${outcome.decision.reasons.join(' ')}` : null,
        not_found: 'Incidente não encontrado.',
        not_reversible: 'reason' in outcome ? outcome.reason : null,
        already_rolled_back: 'reason' in outcome ? outcome.reason : null,
      }[outcome.status];
      return json(res, status, error ? { ...outcome, error } : outcome);
    }

    if (req.method === 'GET' && url.pathname === '/incidents') {
      return json(res, 200, await deps.incidents.list(50));
    }

    if (req.method === 'GET' && incidentMatch?.[1]) {
      const report = await deps.incidents.get(incidentMatch[1]);
      if (!report) throw new HttpError(404, 'Incidente não encontrado.');
      return json(res, 200, report);
    }

    if (req.method === 'GET' && url.pathname === '/audit') {
      const incidentId = url.searchParams.get('incidentId');
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 1000);
      const records = (await deps.audit.records()).filter((record) => !incidentId || record.incidentId === incidentId);
      return json(res, 200, records.slice(-limit));
    }

    if (req.method === 'GET' && url.pathname === '/audit/verify') {
      const records = await deps.audit.records();
      const tail = records.at(-1);
      return json(res, 200, {
        ...verifyChain(records),
        records: records.length,
        head: tail ? { seq: tail.seq, event: tail.event, hash: tail.hash, prevHash: tail.prevHash } : null,
      });
    }

    if (req.method === 'GET' && url.pathname === '/policy') return json(res, 200, policyView(deps.policy, deps.policySource));
    if (req.method === 'GET' && url.pathname === '/playbooks') return json(res, 200, playbooksView(deps.playbooks, deps.playbooksSource));

    if (req.method === 'GET' && url.pathname === '/budget') {
      return json(res, 200, await budgetView(deps.policy, deps.budget, await deps.incidents.list(50)));
    }

    throw new HttpError(404, 'Rota não encontrada.');
  };

  return createServer((req, res) => {
    routes(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
      if (error instanceof ReasonRequiredError) return json(res, 400, { error: error.message });
      if (error instanceof InvalidAlertError) return json(res, 422, { error: error.message });
      deps.logger.error({ err: error, path: req.url }, 'erro não tratado');
      return json(res, 500, { error: 'Erro interno.' });
    });
  });
}

function requireBearer(req: IncomingMessage, expected: string): void {
  const header = req.headers.authorization ?? '';
  const provided = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const wanted = Buffer.from(expected);
  // Comparação em tempo constante; o tamanho diferente já reprova sem chamar timingSafeEqual.
  if (provided.length !== wanted.length || !timingSafeEqual(provided, wanted)) {
    throw new HttpError(401, 'Credencial ausente ou inválida.');
  }
}

async function requireOperator(req: IncomingMessage, authenticator: OperatorAuthenticator): Promise<Operator> {
  const header = req.headers.authorization ?? '';
  const operator = header.startsWith('Bearer ') ? await authenticator.authenticate(header.slice(7)) : null;
  if (!operator) throw new HttpError(401, 'Credencial ausente ou inválida.');
  return operator;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Corpo maior que o permitido.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Corpo não é JSON válido.');
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
