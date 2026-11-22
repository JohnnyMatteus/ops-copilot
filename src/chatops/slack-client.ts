// Cliente mínimo da Web API do Slack (chat.postMessage): serve ao aviso do plantão (notify_oncall)
// e ao pedido de aprovação com botões. Não foi exercitado contra o Slack real, só contra dublê.
import { z } from 'zod';
import type { NotifierPort } from '../executor/ports.js';
import type { FetchLike } from '../shared/fetch.js';
import { requiresPanelConfirmation } from './users.js';

export const APPROVE_ACTION_ID = 'approval_approve';
export const REJECT_ACTION_ID = 'approval_reject';

export interface ApprovalAnnouncement {
  readonly approvalId: string;
  readonly incidentId: string;
  readonly service: string;
  readonly action: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly hypothesisId: string;
  readonly confidence: number;
  readonly expiresAt: string;
}

export interface ApprovalAnnouncer {
  announce(announcement: ApprovalAnnouncement): Promise<void>;
}

const ResponseSchema = z.object({ ok: z.boolean(), error: z.string().optional() });

export class SlackClient implements NotifierPort, ApprovalAnnouncer {
  readonly #token: string;
  readonly #baseUrl: string;
  readonly #approvalChannel: string | undefined;
  readonly #fetch: FetchLike;

  constructor(options: { token: string; baseUrl?: string; approvalChannel?: string | undefined; fetch?: FetchLike }) {
    this.#token = options.token;
    this.#baseUrl = (options.baseUrl ?? 'https://slack.com/api').replace(/\/+$/, '');
    this.#approvalChannel = options.approvalChannel;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async notify(channel: string, text: string): Promise<void> {
    await this.#post({ channel, text });
  }

  async announce(item: ApprovalAnnouncement): Promise<void> {
    if (!this.#approvalChannel) throw new Error('SLACK_APPROVAL_CHANNEL não configurado.');
    const summary = `*Aprovação pendente* em \`${item.service}\`: \`${item.action}\` ${JSON.stringify(item.params)}\nHipótese \`${item.hypothesisId}\` (confiança ${item.confidence.toFixed(2)}). Expira em ${item.expiresAt}.`;
    const panelOnly = requiresPanelConfirmation(item.service, item.action);
    const blocks: unknown[] = [{ type: 'section', text: { type: 'mrkdwn', text: summary } }];
    if (panelOnly) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: 'Ação com dinheiro: aprove pelo painel, digitando o nome do serviço.' }] });
    } else {
      blocks.push({
        type: 'actions',
        elements: [
          { type: 'button', style: 'primary', action_id: APPROVE_ACTION_ID, value: item.approvalId, text: { type: 'plain_text', text: 'Aprovar' } },
          { type: 'button', style: 'danger', action_id: REJECT_ACTION_ID, value: item.approvalId, text: { type: 'plain_text', text: 'Recusar' } },
        ],
      });
    }
    await this.#post({ channel: this.#approvalChannel, text: summary, blocks });
  }

  async #post(body: Record<string, unknown>): Promise<void> {
    const response = await this.#fetch(`${this.#baseUrl}/chat.postMessage`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const parsed = ResponseSchema.safeParse(await response.json().catch(() => null));
    if (!response.ok || !parsed.success || !parsed.data.ok) {
      throw new Error(`Slack recusou a mensagem (${parsed.success ? (parsed.data.error ?? 'sem detalhe') : `HTTP ${String(response.status)}`}).`);
    }
  }
}
