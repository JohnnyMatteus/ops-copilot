// Borda HTTP: webhook do Alertmanager, aprovações humanas, /metrics e /healthz. Só node:http.
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Registry } from 'prom-client';
import { z } from 'zod';
import { AlertmanagerWebhookSchema, firingAlerts, InvalidAlertError, type Alert } from '../domain/alert.js';
import type { ApprovalService } from '../incident/approval-service.js';
import type { ApprovalStore } from '../incident/approvals.js';
import type { Logger } from '../telemetry/logger.js';

const MAX_BODY_BYTES = 1_000_000;

const ApprovalBodySchema = z.strictObject({
  approver: z.email(),
  decision: z.enum(['approve', 'reject']),
});

export interface ServerDeps {
  readonly investigate: (alert: Alert) => Promise<unknown>;
  readonly approvals: ApprovalStore;
  readonly approvalService: ApprovalService;
  readonly registry: Registry;
  readonly logger: Logger;
  readonly webhookToken: string;
  readonly approvalToken: string;
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

    if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { status: 'ok' });

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

    if (req.method === 'GET' && url.pathname === '/approvals') {
      requireBearer(req, deps.approvalToken);
      return json(
        res,
        200,
        deps.approvals.list().map((approval) => ({
          id: approval.id,
          incidentId: approval.incidentId,
          service: approval.gateInput.service,
          action: approval.gateInput.proposal.actionId,
          expiresAt: new Date(approval.expiresAt).toISOString(),
        })),
      );
    }

    if (req.method === 'POST' && approvalMatch?.[1]) {
      requireBearer(req, deps.approvalToken);
      const body = ApprovalBodySchema.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, 'Corpo esperado: {"approver": e-mail, "decision": "approve"|"reject"}.');
      const outcome = await deps.approvalService.resolve(
        approvalMatch[1],
        body.data.approver,
        body.data.decision === 'approve',
      );
      const status = { executed: 200, rejected: 200, blocked: 409, not_found: 404, expired: 410 }[outcome.status];
      return json(res, status, outcome);
    }

    throw new HttpError(404, 'Rota não encontrada.');
  };

  return createServer((req, res) => {
    routes(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return json(res, error.status, { error: error.message });
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
