// Interpreta o clique num botão do Slack e o converte numa decisão humana do ApprovalService, sob a
// identidade e o papel mapeados em SLACK_USERS (ADR 0019). Corpo e assinatura já foram verificados
// pela borda HTTP; aqui a autorização é do papel, nunca do texto da mensagem.
import { z } from 'zod';
import type { AuditLog } from '../autonomy/audit.js';
import { canApprove, type Operator } from '../auth/operator.js';
import type { ApprovalService } from '../incident/approval-service.js';
import type { ApprovalQueue } from '../incident/approvals.js';
import { APPROVE_ACTION_ID, REJECT_ACTION_ID } from './slack-client.js';
import { operatorFromSlack, requiresPanelConfirmation } from './users.js';

export const InteractionPayloadSchema = z.object({
  type: z.literal('block_actions'),
  user: z.object({ id: z.string().min(1) }),
  actions: z
    .array(z.object({ action_id: z.enum([APPROVE_ACTION_ID, REJECT_ACTION_ID]), value: z.string().uuid() }))
    .min(1),
});

export interface SlackReply {
  readonly response_type: 'ephemeral';
  readonly replace_original: false;
  readonly text: string;
}

const reply = (text: string): SlackReply => ({ response_type: 'ephemeral', replace_original: false, text });

export class SlackInteractionHandler {
  readonly #users: ReadonlyMap<string, Pick<Operator, 'email' | 'role'>>;
  readonly #approvals: ApprovalQueue;
  readonly #service: ApprovalService;
  readonly #audit: AuditLog;

  constructor(deps: {
    users: ReadonlyMap<string, Pick<Operator, 'email' | 'role'>>;
    approvals: ApprovalQueue;
    approvalService: ApprovalService;
    audit: AuditLog;
  }) {
    this.#users = deps.users;
    this.#approvals = deps.approvals;
    this.#service = deps.approvalService;
    this.#audit = deps.audit;
  }

  async handle(payload: z.infer<typeof InteractionPayloadSchema>): Promise<SlackReply> {
    const action = payload.actions[0];
    if (!action) return reply('Nada a fazer.');
    const approvalId = action.value;
    const pending = (await this.#approvals.list()).find((candidate) => candidate.id === approvalId);

    const operator = operatorFromSlack(this.#users, payload.user.id);
    if (!operator || !canApprove(operator)) {
      if (pending) {
        await this.#audit.append({
          incidentId: pending.incidentId,
          event: 'chatops_denied',
          actor: 'copilot',
          details: { approvalId, slackUser: payload.user.id, reason: operator ? 'papel leitor' : 'usuário não mapeado', via: 'slack' },
        });
      }
      return reply('Você não tem o papel de aprovador para decidir por aqui.');
    }

    const approve = action.action_id === APPROVE_ACTION_ID;
    if (approve && pending && requiresPanelConfirmation(pending.gateInput.service, pending.gateInput.proposal.actionId)) {
      return reply('Esta ação mexe com dinheiro: aprove pelo painel, digitando o nome do serviço.');
    }

    const outcome = await this.#service.resolve(approvalId, operator, {
      approve,
      reason: approve ? undefined : `Recusado pelo Slack por ${operator.email}.`,
    });
    switch (outcome.status) {
      case 'executed':
        return reply(`Aprovado por ${operator.email}: ${outcome.execution.detail}`);
      case 'rejected':
        return reply('Recusa registrada.');
      case 'blocked':
        return reply(`Aprovação recusada pela política atual: ${outcome.decision.reasons.join(' ')}`);
      case 'expired':
        return reply('O prazo deste pedido venceu; nada foi executado.');
      case 'not_found':
        return reply('Pedido não encontrado ou já decidido.');
    }
  }
}
